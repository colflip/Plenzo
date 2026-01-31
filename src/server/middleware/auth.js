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
    return process.env.JWT_SECRET || 'dev-insecure-secret';
}

/** 离线开发模式标志 */
const isOfflineDev = process.env.OFFLINE_DEV === 'true';

/**
 * 认证中间件
 * @description 验证JWT令牌，在离线开发模式下模拟用户
 */
const authMiddleware = async (req, res, next) => {
    try {
        // 离线开发模式：跳过鉴权，模拟用户
        if (isOfflineDev) {
            // 根据请求路径确定模拟的用户类型
            const fullPath = req.baseUrl + req.path;
            if (fullPath && (fullPath.includes('/teacher') || req.path.includes('/teacher'))) {
                // 模拟教师用户
                req.user = { id: 40, userType: 'teacher', permissionLevel: 2 };
            } else {
                // 模拟管理员用户
                req.user = { id: 1, userType: 'admin', permissionLevel: 1 };
            }
            return next();
        }

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
 * 管理员权限检查
 * @description 仅允许管理员访问
 */
const adminOnly = (req, res, next) => {
    if (req.user.userType !== 'admin') {
        return res.status(403).json({ message: '需要管理员权限' });
    }
    next();
};

/**
 * 权限级别检查
 * @description 检查用户权限级别是否满足要求
 * @param {number} level - 所需权限级别
 */
const checkPermissionLevel = (level) => {
    return (req, res, next) => {
        if (req.user.userType === 'admin' && req.user.permissionLevel > level) {
            return res.status(403).json({ message: '权限不足' });
        }
        next();
    };
};

module.exports = {
    authMiddleware,
    adminOnly,
    checkPermissionLevel
};