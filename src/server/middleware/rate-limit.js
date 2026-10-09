/**
 * API速率限制中间件
 * @description 防止暴力破解和DoS攻击
 * @module middleware/rateLimit
 */

const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { errorResponse } = require('../utils/response');
// 一律走 middleware/auth 的唯一验签入口：固定算法 + 比对 TOKEN_EPOCH + 拒绝 refresh token。
// 自己再写一份 jwt.verify 的话，这三条里任何一条改了都会悄悄分叉（P2-13）。
const { verifyToken } = require('./auth');

/**
 * 从 Authorization 头取出**已验签**的身份，用于限流分桶；无效/缺失返回 null。
 * 只解签名、不查库，开销与一次 JWT 校验同级；authMiddleware 随后仍做完整校验。
 * 用 `userType:id` 而非令牌哈希：同一用户跨 IP 共享一个桶，而伪造的头拿不到桶。
 */
/**
 * 限流参数读环境变量（文档一直在写这几个键，但过去代码里**一处都没读**，
 * 改 .env 完全不生效 —— 运维以为把登录爆破阈值调小了，其实没有）。
 * 默认值保持与原来硬编码的数字一致，不配置 = 行为不变。
 */
function envInt(name, fallback) {
    const n = parseInt(process.env[name], 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function envMs(name, fallback) {
    const n = parseInt(process.env[name], 10);
    return Number.isInteger(n) && n > 0 ? n : fallback;
}

function verifiedTokenIdentity(req) {
    const header = req.headers && req.headers.authorization;
    if (!header) return null;
    const parts = header.split(' ');
    if (parts.length !== 2 || !/^[Bb]earer$/.test(parts[0])) return null;
    try {
        const decoded = verifyToken(parts[1]);
        if (!decoded || decoded.id === undefined) return null;
        return `id:${decoded.userType || 'u'}:${decoded.id}`;
    } catch (_) {
        return null;   // 验不过就退回 IP 桶，不给匿名者更宽的额度
    }
}

/**
 * 限流命中时的统一信封出口。express-rate-limit 在触发时会调用本 handler，
 * 传入 (req, res, next, options)（options 含 statusCode / message）。我们统一输出
 * { ok:false, error:{ code:'RATE_LIMITED', retryable:true, retryAfterSeconds } } 信封，
 * 并写回 Retry-After 头，供前端 api-client 读取。
 * @param {number} _max 预留：与 limit 配置对齐（语义同 max）
 */
const createRateLimitHandler = (_max) => {
    return (req, res, next, options = {}) => {
        const statusCode = options && Number.isInteger(options.statusCode) ? options.statusCode : 429;
        const message = (options && typeof options.message === 'string' && options.message)
            ? options.message
            : '请求过于频繁，请稍后重试';

        let retryAfterSeconds = null;
        if (req && req.rateLimit && req.rateLimit.resetTime instanceof Date) {
            retryAfterSeconds = Math.max(0, Math.ceil((req.rateLimit.resetTime.getTime() - Date.now()) / 1000));
        } else if (options && Number.isInteger(options.retryAfterSeconds)) {
            retryAfterSeconds = options.retryAfterSeconds;
        }

        if (typeof res.set === 'function') {
            res.set('Retry-After', String(retryAfterSeconds != null ? retryAfterSeconds : 0));
        }
        res.status(statusCode).json(
            errorResponse({
                code: 'RATE_LIMITED',
                message,
                details: [],
                retryable: true,
                retryAfterSeconds
            }, { requestId: req && req.requestId })
        );
    };
};

/**
 * 登录接口速率限制
 * 15分钟内最多5次尝试
 */
const loginLimiter = rateLimit({
    windowMs: envMs('LOGIN_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
    max: envInt('LOGIN_RATE_LIMIT_MAX', 5),
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: createRateLimitHandler(envInt('LOGIN_RATE_LIMIT_MAX', 5))
});

/**
 * 通用API速率限制
 * 每分钟最多100次请求
 */
const apiLimiter = rateLimit({
    windowMs: envMs('RATE_LIMIT_WINDOW_MS', 60 * 1000),
    max: envInt('RATE_LIMIT_MAX', 100),
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    handler: createRateLimitHandler(100),
    keyGenerator: (req) => {
        /**
         * 身份键必须来自**验签通过**的令牌。原实现只要存在 Authorization 头就按
         * `sha256(header)` 分桶，而该头不需要合法 —— 随便塞一个值、或每次重新登录，
         * 都会拿到一个全新的桶，`max:100/min` 对肯动手的客户端等于不存在
         * （`/api/health/db`、`/ready` 这类会真查库的无鉴权端点正在它保护之下）。
         */
        const identity = verifiedTokenIdentity(req);
        if (identity) return identity;

        const clientIp = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
        // 未登录（或令牌无效）：IP + UA 指纹，降低共享 NAT/代理下的互误伤
        const ua = req.headers['user-agent'] || 'no-ua';
        const uaHash = crypto.createHash('sha256').update(ua).digest('base64').slice(0, 16);
        return `ip:${clientIp}:${uaHash}`;
    }
});

/**
 * 严格速率限制（用于敏感操作）
 * 每小时最多10次请求
 */
const strictLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: createRateLimitHandler(10)
});

/**
 * 导出速率限制中间件
 */
module.exports = {
    loginLimiter,
    apiLimiter,
    strictLimiter,
    createRateLimitHandler,
    // 供测试：限流分桶身份是否真的要求验签
    verifiedTokenIdentity
};
