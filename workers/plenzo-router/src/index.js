/**
 * Plenzo 统一入口 Worker
 *
 * 一个入口域名 `plenzo.cc.cd` → Render（主源）/ Vercel（备源），
 * 主源「连不上」时自动回退到备源。
 *
 * 绑定的域名是 Cloudflare 里一个 **active 的 full zone**（`plenzo.cc.cd`，NS 为
 * `elly/vicente.ns.cloudflare.com`）。历史上「子域不能建 zone（API 1116）」的阻塞对
 * 这个域名不成立：`cc.cd` 已登记进公共后缀表（PSL），所以 `plenzo.cc.cd` 本身就是注册域；
 * 而 `l.cd` 没登记，`plenzo.l.cd` 只是 `l.cd` 的子域，才会被 1116 拒。
 * 部署与绑定的实际步骤见 docs/cloudflare-routing.md（那份手记在**本机**：仓库的
 * .gitignore 排除了整个 docs/，干净检出里看不到它 —— 别把这里当成仓库内文件链接）。
 *
 * 关键设计（改代码前请先读）：
 *
 * 1. **只在「连不上」时回退，应用自己的 5xx 不回退。**
 *    主源只要有响应就原样透传（包括 5xx），因为请求已经到达应用、可能已产生副作用；
 *    而备用源跑的是同一份代码、连的是同一个数据库，回退过去大概率还是同样的 5xx，
 *    只会放大风险。原样透传还能保住应用自己的错误信封（含 requestId）。
 *    唯一的例外是 `NOT_DELIVERED_STATUS` 那一档：它们由 Cloudflare 边缘在握手阶段
 *    合成，请求根本没发出去，重放是安全的（见下方定义处的说明）。
 *
 * 2. **Worker 无法保留原始 Host。**
 *    Cloudflare 官方文档：`Host` 头始终与 URL 一致，且出于安全原因不能设为 zone 之外的主机。
 *    所以应用收到的 Host 会是 `xxx.onrender.com`，而浏览器发来的 Origin 是入口域名 ——
 *    两者不相等。**必须**在两个平台配置 `ALLOWED_ORIGINS=https://plenzo.cc.cd`，
 *    否则同源判定失败、所有写请求返回 403 CORS_FORBIDDEN。
 *
 * 3. 回退响应带 `X-Served-By: vercel-fallback`，用于确认当前走的是哪个源。
 *    正常路径不加这个头（避免为每个响应包一层 Response、白白多一次 body 流转）。
 */

const DEFAULT_PRIMARY = 'plenzo.onrender.com';
const DEFAULT_FALLBACK = 'plenzo.vercel.app';

/**
 * 单源超时。默认 10s，可用 `ROUTER_TIMEOUT_MS` 覆盖（也便于测试注入极小值）。
 *
 * 超时**不再一律按「连不上」处理**：Render 冷启动 + Neon 唤醒 + 大跨度导出
 * （实测 10000/20000 条仅工作簿生成就 21s/29s）都会让请求「已经送达并正在执行」时
 * 触发超时。把这种超时也重放到备源 = 同一份 body 对同一个库执行两次（新建排课变两场、
 * 批量改费用改两遍），而全站没有幂等键。因此：
 *   - 安全方法（GET/HEAD/OPTIONS）超时 → 仍可回退，重试无害；
 *   - 写方法超时 → 直接 504，明确告知「可能已执行」，不重放。
 * 这与 NOT_DELIVERED_STATUS 刻意排除 520/524/527 是同一条判断标准。
 */
const DEFAULT_TIMEOUT_MS = 10000;
function resolveTimeoutMs(env) {
    const n = parseInt(env && env.ROUTER_TIMEOUT_MS, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// 允许故障转移的 HTTP 方法。
// 默认放开全部：主源「连不上」通常意味着请求根本没到达应用。
// 注意：这条只对「连接层失败」成立；超时是否重放另见 SAFE_RETRY_METHODS。
const FAILOVER_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];

// 超时后可安全重放的方法（无副作用，重复执行无害）
const SAFE_RETRY_METHODS = ['GET', 'HEAD', 'OPTIONS'];

/**
 * 「请求一定没到达应用」的状态码 —— Cloudflare 边缘自己合成的那一档。
 *
 * 为什么必须有这个判断：Workers 的 `fetch()` 在源站 **DNS 解析失败**时不抛异常，而是
 * 直接返回一个合成的 530。只看 `catch` 会把它当成「主源有响应」原样透传，回退分支
 * 永远走不到（实测：主源填成不存在的 host 时，入口拿到 530 而不是 Vercel 的 200）。
 *
 * 刻意不含 520 / 524 / 527：这三种请求可能已经交付给应用，重放会重复写入
 * （522/523/521/525/526/530 都发生在 TCP 或 TLS 握手阶段，还没发请求）。
 */
const NOT_DELIVERED_STATUS = new Set([521, 522, 523, 525, 526, 530]);

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
 * 返回 null 表示「没送达」：连不上（DNS 失败 / 连接被拒）或边缘合成的未送达 5xx → 可回退。
 * 返回 Response 表示要么正常响应，要么「已送达但超时」的写请求（504，不能重放）。
 * @returns {Promise<Response|null>}
 */
async function tryOrigin(request, originHost, timeoutMs) {
    const url = new URL(request.url);
    url.protocol = 'https:';
    url.hostname = originHost;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(new Request(url, request), { signal: controller.signal });
        if (!NOT_DELIVERED_STATUS.has(response.status)) return response;
        response.body?.cancel();
        return null;
    } catch (err) {
        // 超时 ≠ 连不上：请求可能已经在应用侧执行完毕或正在执行。
        const timedOut = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
        if (timedOut && !SAFE_RETRY_METHODS.includes(request.method)) {
            return new Response(
                JSON.stringify({
                    ok: false,
                    data: null,
                    error: {
                        code: 'UPSTREAM_TIMEOUT',
                        message: '上游处理超时，请求可能已经被执行；为避免重复写入未自动重试，请到页面确认结果。',
                        details: [],
                        retryable: true,
                        retryAfterSeconds: null
                    }
                }),
                {
                    status: 504,
                    headers: {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store',
                        'X-Served-By': 'origin-timeout'
                    }
                }
            );
        }
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export default {
    async fetch(request, env = {}) {
        const primaryHost = normalizeHost(env.PRIMARY_ORIGIN, DEFAULT_PRIMARY);
        const fallbackHost = normalizeHost(env.FALLBACK_ORIGIN, DEFAULT_FALLBACK);
        const timeoutMs = resolveTimeoutMs(env);

        // 主源有响应就原样透传（含 5xx，见文件头说明 1）
        const primaryResponse = await tryOrigin(request.clone(), primaryHost, timeoutMs);
        if (primaryResponse) return primaryResponse;

        if (FAILOVER_METHODS.includes(request.method)) {
            const fallbackResponse = await tryOrigin(request.clone(), fallbackHost, timeoutMs);
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
