const dns = require('dns').promises;
const { isIP } = require('net');

/**
 * 出站地址护栏（SSRF）
 * @description
 *  用户可以在浏览器里自行添加「模型 / 端点」，切换后由服务端按该地址发起请求。
 *  地址由客户端提供，因此必须挡掉指向内网/本机/云元数据的地址，否则
 *  `/api/ai/query` 就成了一个「任何登录用户都能打内网」的代理。
 *
 *  两层检查：
 *   1. 字面量检查（同步）：协议、URL 里的凭证、主机名黑名单、IP 字面量是否属于保留段。
 *   2. DNS 解析（异步）：域名解析出的每个 A/AAAA 记录都要过一遍同样的地址判定，
 *      挡住「用域名指向 127.0.0.1」这种绕过。
 *
 *  未覆盖：解析与实际连接之间存在 TOCTOU 窗口，理论上可被 DNS rebinding 利用。
 *  要彻底消除需要把解析结果固定下来再连接（自定义 lookup/agent），代价与收益不成比例，
 *  这里不做——本护栏的定位是「挡住绝大多数误配置与顺手试探」，不是对抗定向攻击。
 */

// 云厂商元数据服务的固定域名，以及明显不该出现在上游地址里的后缀
const BLOCKED_HOSTS = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
    'metadata.goog',
]);

const BLOCKED_HOST_SUFFIXES = [
    '.localhost',
    '.local',
    '.internal',
    '.home.arpa',
    '.in-addr.arpa',
    '.ip6.arpa',
];

// 保留 / 私有 IPv4 段：[网络地址, 前缀长度]
const BLOCKED_IPV4 = [
    ['0.0.0.0', 8],        // 本网络
    ['10.0.0.0', 8],       // 私有
    ['100.64.0.0', 10],    // CGNAT
    ['127.0.0.0', 8],      // 环回
    ['169.254.0.0', 16],   // 链路本地（含云元数据 169.254.169.254）
    ['172.16.0.0', 12],    // 私有
    ['192.0.0.0', 24],     // IETF 协议分配
    ['192.0.2.0', 24],     // TEST-NET-1
    ['192.168.0.0', 16],   // 私有
    ['198.18.0.0', 15],    // 基准测试
    ['198.51.100.0', 24],  // TEST-NET-2
    ['203.0.113.0', 24],   // TEST-NET-3
    ['224.0.0.0', 4],      // 组播
    ['240.0.0.0', 4],      // 保留（含 255.255.255.255）
];

function ipv4ToInt(ip) {
    return ip.split('.').reduce((acc, part) => (acc * 256) + Number(part), 0);
}

function inIpv4Range(ip, network, prefix) {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(network) & mask) >>> 0);
}

/** 是否为不允许作为出站目标的 IP 字面量（v4/v6 通用入口） */
function isBlockedAddress(address) {
    const version = isIP(address);
    if (version === 4) {
        return BLOCKED_IPV4.some(([network, prefix]) => inIpv4Range(address, network, prefix));
    }
    if (version === 6) return isBlockedIpv6(address);
    return true; // 不是合法 IP：一律按「不安全」处理，调用方不必再判
}

function isBlockedIpv6(address) {
    const lower = address.toLowerCase();

    // IPv4 映射 / 兼容写法（::ffff:127.0.0.1）以及 NAT64（64:ff9b::/96）：
    // 尾部 32 位就是真实的 v4 地址，取出来按 v4 规则判。
    const tail = lower.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (tail) return isBlockedAddress(tail[1]);

    const groups = expandIpv6(lower);
    if (!groups) return true;

    const first = groups[0];
    if ((first & 0xffc0) === 0xfe80) return true;        // fe80::/10 链路本地
    if ((first & 0xfe00) === 0xfc00) return true;        // fc00::/7 唯一本地
    if ((first & 0xff00) === 0xff00) return true;        // ff00::/8 组播
    if (groups.every(g => g === 0)) return true;         // :: 未指定

    // ::1 环回
    if (groups.slice(0, 7).every(g => g === 0) && groups[7] === 1) return true;

    return false;
}

/**
 * 把 IPv6 字符串展开成 8 组 16 位整数；形态不认识时返回 null。
 * 内嵌 v4 的写法（::ffff:1.2.3.4）在 isBlockedIpv6 里已提前处理，不会走到这里。
 */
function expandIpv6(address) {
    const parts = address.split('::');
    if (parts.length > 2) return null;

    const parse = (segment) =>
        (segment ? segment.split(':').filter(Boolean) : []).map(g => parseInt(g, 16));

    const left = parse(parts[0]);
    const right = parts.length === 2 ? parse(parts[1]) : [];
    if ([...left, ...right].some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;

    if (parts.length === 1) return left.length === 8 ? left : null;

    const fill = 8 - left.length - right.length;
    if (fill < 0) return null;
    return [...left, ...Array(fill).fill(0), ...right];
}

function hostnameBlocked(hostname) {
    const host = hostname.toLowerCase().replace(/\.$/, ''); // 去掉 FQDN 末尾的点
    if (BLOCKED_HOSTS.has(host)) return true;
    return BLOCKED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

/**
 * 同步校验：协议 / 凭证 / 主机名 / IP 字面量。不发 DNS。
 * @param {string} baseUrl
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
function inspectBaseUrl(baseUrl) {
    if (typeof baseUrl !== 'string' || !baseUrl.trim()) {
        return { ok: false, reason: '地址不能为空' };
    }

    let url;
    try {
        url = new URL(baseUrl.trim());
    } catch (_) {
        return { ok: false, reason: '地址格式不合法' };
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return { ok: false, reason: '只支持 http/https 地址' };
    }
    // URL 里的 user:pass@ 会被 axios 当作 Basic 凭证带上，等于让客户端决定认证头
    if (url.username || url.password) {
        return { ok: false, reason: '地址不能包含用户名或密码' };
    }
    if (hostnameBlocked(url.hostname)) {
        return { ok: false, reason: '该主机名不允许作为出站地址' };
    }
    // WHATWG URL 把 IPv6 字面量保留成带方括号的形态（[::1]），isIP 认不出来
    if (isIP(hostAddress(url)) && isBlockedAddress(hostAddress(url))) {
        return { ok: false, reason: '该地址属于内网/保留网段，不允许访问' };
    }

    return { ok: true, url };
}

/** URL.hostname 去掉 IPv6 的方括号，得到可直接喂给 net.isIP 的形态 */
function hostAddress(url) {
    return url.hostname.replace(/^\[|\]$/g, '');
}

/**
 * 完整校验：在同步检查之后，把域名解析出的每个地址也过一遍。
 * @param {string} baseUrl
 * @returns {Promise<URL>} 校验通过时返回解析好的 URL
 * @throws {Error} 带 status=400，供控制器直接转成 4xx
 */
async function assertSafeBaseUrl(baseUrl) {
    const inspected = inspectBaseUrl(baseUrl);
    if (!inspected.ok) {
        throw Object.assign(new Error(`baseUrl 不安全：${inspected.reason}`), { status: 400 });
    }

    const { url } = inspected;
    if (isIP(hostAddress(url))) return url; // 字面量已在同步阶段判过，无需解析

    let records;
    try {
        records = await dns.lookup(url.hostname, { all: true, verbatim: true });
    } catch (_) {
        throw Object.assign(new Error(`baseUrl 不安全：域名 ${url.hostname} 无法解析`), { status: 400 });
    }
    if (!records.length) {
        throw Object.assign(new Error(`baseUrl 不安全：域名 ${url.hostname} 没有解析结果`), { status: 400 });
    }

    for (const record of records) {
        if (isBlockedAddress(record.address)) {
            throw Object.assign(
                new Error(`baseUrl 不安全：域名 ${url.hostname} 解析到内网/保留地址`),
                { status: 400 }
            );
        }
    }

    return url;
}

module.exports = { inspectBaseUrl, assertSafeBaseUrl, isBlockedAddress };
