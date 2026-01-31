/**
 * 中间件索引
 * @description 统一导出所有中间件模块
 * @module middleware
 */

const { authMiddleware, adminOnly: authAdminOnly, checkPermissionLevel } = require('./auth');
const {
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
} = require('./role');
const {
    validate,
    standardResponse,
    scheduleValidation,
    userValidation
} = require('./validation');
const {
    AppError,
    errorHandler,
    notFoundHandler,
    asyncHandler,
    errorResponse
} = require('./error');

module.exports = {
    // 认证
    authMiddleware,
    checkPermissionLevel,

    // 角色权限
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
    superAdminOnly,

    // 验证
    validate,
    standardResponse,
    scheduleValidation,
    userValidation,

    // 错误处理
    AppError,
    errorHandler,
    notFoundHandler,
    asyncHandler,
    errorResponse
};
