/**
 * 验证规则索引
 * @description 统一导出所有验证规则模块
 * @module validators
 */

const authValidator = require('./auth-validator');

module.exports = {
    // 认证验证
    loginSchema: authValidator.loginSchema,
    registerSchema: authValidator.registerSchema,
    changePasswordSchema: authValidator.changePasswordSchema,
    refreshTokenSchema: authValidator.refreshTokenSchema,

    // 模块导出
    authValidator
};
