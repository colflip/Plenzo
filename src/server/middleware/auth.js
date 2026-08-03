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
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret === 'your-secret-key-change-this-in-production') {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('致命错误: 生产环境未设置有效的 JWT_SECRET 环境变量');
        }
        console.warn('[AUTH] 警告: 使用默认 JWT 密钥，仅限开发环境');
        return 'dev-insecure-secret';
    }
    return secret;
}

/**
 * 认证中间件
 * @description 验证 JWT 令牌并注入真实用户身份
 */
const authMiddleware = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) {
            return res.status(401).json({ message: '未提供认证令牌' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, getJwtSecret());

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
    checkPermissionLevel
};