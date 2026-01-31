/**
 * 角色权限中间件
 * @description 基于用户角色和权限级别控制API访问权限
 * @module middleware/role
 */

// 角色定义
const ROLES = {
    ADMIN: 'admin',
    TEACHER: 'teacher',
    STUDENT: 'student'
};

// 权限级别（管理员专用，数字越小权限越高）
const PERMISSION_LEVELS = {
    SUPER_ADMIN: 1,  // 超级管理员
    ADMIN: 2,        // 普通管理员
    OPERATOR: 3      // 操作员
};

/**
 * 角色验证中间件工厂
 * @param {...string} allowedRoles - 允许访问的角色列表
 * @returns {Function} Express中间件
 */
const requireRole = (...allowedRoles) => {
    return (req, res, next) => {
        // 确保用户已认证
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: '请先登录'
            });
        }

        const userRole = req.user.userType || req.user.role;

        // 检查用户角色是否在允许列表中
        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({
                success: false,
                message: '没有权限执行此操作'
            });
        }

        next();
    };
};

/**
 * 权限级别验证中间件
 * @param {number} maxLevel - 允许的最大权限级别（越小越高）
 * @returns {Function} Express中间件
 */
const requirePermissionLevel = (maxLevel) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: '请先登录'
            });
        }

        // 非管理员直接拒绝
        const userRole = req.user.userType || req.user.role;
        if (userRole !== ROLES.ADMIN) {
            return res.status(403).json({
                success: false,
                message: '需要管理员权限'
            });
        }

        // 检查权限级别（数字越小权限越高）
        const userLevel = req.user.permissionLevel || 3;
        if (userLevel > maxLevel) {
            return res.status(403).json({
                success: false,
                message: '权限级别不足'
            });
        }

        next();
    };
};

/**
 * 资源所有者验证中间件
 * @param {Function} getResourceOwnerId - 从请求中获取资源所有者ID的函数
 * @returns {Function} Express中间件
 */
const requireOwnerOrAdmin = (getResourceOwnerId) => {
    return async (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: '请先登录'
            });
        }

        const userRole = req.user.userType || req.user.role;

        // 管理员可以访问任何资源
        if (userRole === ROLES.ADMIN) {
            return next();
        }

        // 获取资源所有者ID
        try {
            const ownerId = await getResourceOwnerId(req);
            if (req.user.id === ownerId) {
                return next();
            }
        } catch (error) {
            // 获取所有者ID失败，继续拒绝访问
        }

        return res.status(403).json({
            success: false,
            message: '只能访问自己的资源'
        });
    };
};

// 快捷中间件
const adminOnly = requireRole(ROLES.ADMIN);
const teacherOnly = requireRole(ROLES.TEACHER);
const studentOnly = requireRole(ROLES.STUDENT);
const teacherOrAdmin = requireRole(ROLES.TEACHER, ROLES.ADMIN);
const anyAuthenticated = requireRole(ROLES.ADMIN, ROLES.TEACHER, ROLES.STUDENT);

// 按权限级别的快捷中间件
const superAdminOnly = requirePermissionLevel(PERMISSION_LEVELS.SUPER_ADMIN);

module.exports = {
    ROLES,
    PERMISSION_LEVELS,
    requireRole,
    requirePermissionLevel,
    requireOwnerOrAdmin,
    adminOnly,
    teacherOnly,
    studentOnly,
    teacherOrAdmin,
    anyAuthenticated,
    superAdminOnly
};
