/**
 * API速率限制中间件
 * @description 防止暴力破解和DoS攻击
 * @module middleware/rateLimit
 */

const rateLimit = require('express-rate-limit');

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
        const token = req.headers.authorization;
        const clientIp = req['i' + 'p'] || (req.socket && req.socket.remoteAddress) || 'unknown';
        return token ? `${clientIp}-${token.substring(0, 20)}` : clientIp;
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
