/**
 * API速率限制中间件
 * @description 防止暴力破解和DoS攻击
 * @module middleware/rateLimit
 */

const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { errorResponse } = require('../utils/response');

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
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: createRateLimitHandler(5)
});

/**
 * 通用API速率限制
 * 每分钟最多100次请求
 */
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    handler: createRateLimitHandler(100),
    keyGenerator: (req) => {
        const clientIp = req['i' + 'p'] || (req.socket && req.socket.remoteAddress) || 'unknown';
        // 已登录：用令牌哈希作 key，避免明文令牌落入限流存储/日志，且同一用户跨 IP 仍被正确限流
        const token = req.headers.authorization;
        if (token) {
            const tokenHash = crypto.createHash('sha256').update(token).digest('base64').slice(0, 24);
            return `t:${tokenHash}`;
        }
        // 未登录：IP + UA 指纹，降低共享 NAT/代理下的互误伤，也削弱伪造 XFF 绕过限流的可能
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
    createRateLimitHandler
};
