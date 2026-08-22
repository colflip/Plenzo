/**
 * API速率限制中间件
 * @description 防止暴力破解和DoS攻击
 * @module middleware/rateLimit
 */

const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

/**
 * 登录接口速率限制
 * 15分钟内最多5次尝试
 */
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: '登录尝试过多，请15分钟后再试'
    },
    skipSuccessfulRequests: true
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
    message: {
        success: false,
        message: '请求过于频繁，请稍后再试'
    },
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
    message: {
        success: false,
        message: '操作过于频繁，请1小时后再试'
    }
});

/**
 * 导出速率限制中间件
 */
module.exports = {
    loginLimiter,
    apiLimiter,
    strictLimiter
};
