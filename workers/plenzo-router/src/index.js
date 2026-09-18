/**
 * Plenzo 统一入口 Worker
 *
 * ⛔ 当前**不可部署**：Cloudflare 已不允许个人 / 普通商业账号把子域添加为 zone
 *    （`POST /zones` 返回 `code 1116 Please ensure you are providing the root domain
 *    and not any subdomains`）。本项目域名都是 DNSHE 给的子域且不拥有其父域，
 *    因此没有可绑的 zone。需要一个能整体托管到 Cloudflare的根域名才能启用。
 *    详见 wrangler.toml 顶部说明与 docs/cloudflare-routing.md。
 *    代码本身已验证可用（本地两个模拟 origin，7/7 通过），换域名后可直接复用。
 *
 * 一个入口域名 → Render（主源）/ Vercel（备源），主源「连不上」时自动回退到备源。
 *
 * 关键设计（改代码前请先读）：
 *
 * 1. **只在「连不上」时回退，5xx 不回退。**
 *    主源只要有响应就原样透传（包括 5xx），因为请求已经到达应用、可能已产生副作用；
 *    而备用源跑的是同一份代码、连的是同一个数据库，回退过去大概率还是同样的 5xx，
 *    只会放大风险。原样透传还能保住应用自己的错误信封（含 requestId）。
 *
 * 2. **Worker 无法保留原始 Host。**
 *    Cloudflare 官方文档：`Host` 头始终与 URL 一致，且出于安全原因不能设为 zone 之外的主机。
 *    所以应用收到的 Host 会是 `xxx.onrender.com`，而浏览器发来的 Origin 是入口域名 ——
 *    两者不相等。**必须**在两个平台配置 `ALLOWED_ORIGINS=https://<入口域名>`，
 *    否则同源判定失败、所有写请求返回 403 CORS_FORBIDDEN。
 *
 * 3. 回退响应带 `X-Served-By: vercel-fallback`，用于确认当前走的是哪个源。
 *    正常路径不加这个头（避免为每个响应包一层 Response、白白多一次 body 流转）。
 */

const DEFAULT_PRIMARY = 'plenzo.onrender.com';
const DEFAULT_FALLBACK = 'plenzo.vercel.app';

// 单源超时。超时按「连不上」处理，走回退。
const TIMEOUT_MS = 10000;

// 允许故障转移的 HTTP 方法。
// 默认放开全部：主源「连不上」通常意味着请求根本没到达应用。
// 若担心超时场景下的重复写入（例如新建排课），收窄成 ['GET', 'HEAD', 'OPTIONS']。
const FAILOVER_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * 归一化 origin 主机名：容忍误填成 `https://xxx.onrender.com/` 这类带协议/路径的写法。
 * @param {string|undefined} value
 * @param {string} fallback
 * @returns {string}
 */
function normalizeHost(value, fallback) {
    const raw = String(value || '').trim() || fallback;
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
}

/**
 * 把请求转发到指定 origin。
 * 只区分「有没有拿到响应」——连不上（DNS 失败 / 连接被拒 / 超时）才返回 null。
 * @returns {Promise<Response|null>}
 */
async function tryOrigin(request, originHost) {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.hostname = originHost;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        return await fetch(new Request(url, request), { signal: controller.signal });
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export default {
    async fetch(request, env = {}) {
        const primaryHost = normalizeHost(env.PRIMARY_ORIGIN, DEFAULT_PRIMARY);
        const fallbackHost = normalizeHost(env.FALLBACK_ORIGIN, DEFAULT_FALLBACK);

        // 主源有响应就原样透传（含 5xx，见文件头说明 1）
        const primaryResponse = await tryOrigin(request.clone(), primaryHost);
        if (primaryResponse) return primaryResponse;

        if (FAILOVER_METHODS.includes(request.method)) {
            const fallbackResponse = await tryOrigin(request.clone(), fallbackHost);
            if (fallbackResponse) {
                const tagged = new Response(fallbackResponse.body, fallbackResponse);
                tagged.headers.set('X-Served-By', 'vercel-fallback');
                return tagged;
            }
        }

        return new Response('服务暂时不可用，请稍后重试', {
            status: 502,
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'X-Served-By': 'none',
                'Retry-After': '30'
            }
        });
    }
};
