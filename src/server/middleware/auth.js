const logger = require('../utils/logger.js');
/**
 * 认证中间件
 * @description 提供JWT认证、权限检查等功能
 * @module middleware/auth
 */

const jwt = require('jsonwebtoken');

/**
 * 获取JWT密钥
 * @returns {string} JWT密钥
 */
// 弱/默认密钥清单（单一来源；app.js 启动时复用本函数做校验）
const WEAK_SECRETS = ['your-secret-key-change-this-in-production', 'dev-insecure-secret'];

function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || WEAK_SECRETS.includes(secret)) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('致命错误: 生产环境未设置有效的 JWT_SECRET 环境变量');
        }
        logger.warn('[AUTH] 警告: 使用默认 JWT 密钥，仅限开发环境');
        return 'dev-insecure-secret';
    }
    return secret;
}

/**
 * 解析 Cookie 头（避免引入额外依赖）
 * @param {object} req - Express 请求对象
 * @returns {Object} cookie 名值映射
 */
function parseCookies(req) {
    const header = req.headers.cookie;
    const cookies = {};
    if (!header) return cookies;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
    });
    return cookies;
}

/**
 * 令牌纪元（token epoch）。
 *
 * JWT 载荷里存的是用户 id。用户改主键（new_id）或批量重编 ID 后，在途 token 里的旧 id
 * 会指向一个不存在的用户 —— 中间件只验签名不查库，结果不是干净的 401，而是请求通过认证
 * 后在业务层悄悄查空。引入递增纪元值：改号/重编时把 TOKEN_EPOCH +1，所有旧 token 立即失效，
 * 前端收到 401 自动跳登录页（api-client 已有该逻辑），无需逐个踢人。
 *
 * 零每请求开销：只在签名与验签时读一次环境变量。
 */
const TOKEN_EPOCH_DEFAULT = 1;

function getTokenEpoch() {
    const n = parseInt(process.env.TOKEN_EPOCH, 10);
    return Number.isInteger(n) && n > 0 ? n : TOKEN_EPOCH_DEFAULT;
}

/**
 * 认证中间件
 * @description 验证 JWT 令牌并注入真实用户身份
 * 令牌来源优先级：httpOnly Cookie（推荐，防 XSS 窃取）> Authorization 头（兼容旧客户端）
 */
const authMiddleware = async (req, res, next) => {
    try {
        let token = null;
        const cookies = parseCookies(req);
        if (cookies.token) {
            token = cookies.token;
        } else if (req.headers.authorization) {
            const parts = req.headers.authorization.split(' ');
            if (parts.length === 2 && /^[Bb]earer$/i.test(parts[0])) {
                token = parts[1];
            }
        }

        if (!token) {
            return res.status(401).json({ message: '未提供认证令牌' });
        }

        const decoded = jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] });

        // 纪元不匹配 = 该 token 签发于上一次「用户 ID 变更」之前，身份已不可信。
        // 带固定 code 供前端识别；message 会被 api-client 直接展示。
        if (decoded.tv !== getTokenEpoch()) {
            return res.status(401).json({
                code: 'SESSION_EPOCH_MISMATCH',
                message: '账号信息已变更，请重新登录'
            });
        }

        req.user = {
            id: decoded.id,
            userType: decoded.userType,
            permissionLevel: decoded.permissionLevel
        };

        next();
    } catch (error) {
        const msg = (error && error.name === 'TokenExpiredError') ? '认证令牌已过期' : '无效的认证令牌';
        return res.status(401).json({ message: msg });
    }
};

/**
 * 权限级别检查
 * @description 检查用户权限级别是否满足要求
 * @param {number} level - 所需权限级别
 */
const checkPermissionLevel = (level) => {
    return (req, res, next) => {
        if (req.user.userType !== 'admin') {
            return res.status(403).json({ message: '需要管理员权限' });
        }
        if (req.user.permissionLevel > level) {
            return res.status(403).json({ message: '权限不足' });
        }
        next();
    };
};

// adminOnly 统一从 role.js 导出，确保所有路由使用同一个实现
const { adminOnly } = require('./role');

module.exports = {
    authMiddleware,
    adminOnly,
    checkPermissionLevel,
    getJwtSecret,
    getTokenEpoch
};