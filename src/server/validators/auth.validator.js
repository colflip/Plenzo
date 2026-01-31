/**
 * 认证验证规则
 * @description 登录、注册、密码修改等认证相关的Joi验证规则
 * @module validators/auth
 */

const Joi = require('joi');

// 登录验证
const loginSchema = Joi.object({
    username: Joi.string().min(3).max(50).required()
        .messages({
            'string.min': '用户名至少3个字符',
            'string.max': '用户名最多50个字符',
            'any.required': '用户名不能为空'
        }),
    password: Joi.string().min(6).required()
        .messages({
            'string.min': '密码至少6个字符',
            'any.required': '密码不能为空'
        }),
    userType: Joi.string().valid('admin', 'teacher', 'student').required()
        .messages({
            'any.only': '用户类型无效',
            'any.required': '用户类型不能为空'
        })
});

// 注册验证（管理员创建用户）
const registerSchema = Joi.object({
    username: Joi.string().alphanum().min(3).max(50).required()
        .messages({
            'string.alphanum': '用户名只能包含字母和数字',
            'string.min': '用户名长度至少3个字符',
            'string.max': '用户名长度不能超过50个字符',
            'any.required': '用户名是必填项'
        }),
    password: Joi.string().min(6).max(100).required()
        .messages({
            'string.min': '密码长度至少6个字符',
            'string.max': '密码长度不能超过100个字符',
            'any.required': '密码是必填项'
        }),
    name: Joi.string().min(1).max(50).required()
        .messages({
            'string.min': '姓名不能为空',
            'string.max': '姓名长度不能超过50个字符',
            'any.required': '姓名是必填项'
        }),
    userType: Joi.string().valid('admin', 'teacher', 'student').required()
        .messages({
            'any.only': '用户类型只能是 admin、teacher 或 student',
            'any.required': '用户类型是必填项'
        }),
    email: Joi.string().email().max(100).optional()
        .messages({
            'string.email': '邮箱格式不正确',
            'string.max': '邮箱长度不能超过100个字符'
        }),
    contact: Joi.string().max(100).optional()
        .messages({
            'string.max': '联系方式长度不能超过100个字符'
        }),
    status: Joi.number().integer().valid(-1, 0, 1).default(1)
        .messages({
            'number.base': '状态必须是整数',
            'any.only': '状态只能是 -1(删除)、0(暂停)、1(正常)'
        }),
    permissionLevel: Joi.number().integer().min(1).max(3)
        .when('userType', { is: 'admin', then: Joi.required() })
        .messages({
            'number.min': '权限级别不能小于1',
            'number.max': '权限级别不能大于3',
            'any.required': '管理员必须指定权限级别'
        })
})
    // 兼容 snake_case 输入
    .rename('permission_level', 'permissionLevel', { override: true, ignoreUndefined: true })
    .rename('user_type', 'userType', { override: true, ignoreUndefined: true });

// 修改密码验证
const changePasswordSchema = Joi.object({
    oldPassword: Joi.string().required()
        .messages({
            'any.required': '原密码不能为空'
        }),
    newPassword: Joi.string().min(6).max(100).required()
        .messages({
            'string.min': '新密码长度至少6个字符',
            'string.max': '新密码长度不能超过100个字符',
            'any.required': '新密码不能为空'
        })
})
    .rename('old_password', 'oldPassword', { override: true, ignoreUndefined: true })
    .rename('new_password', 'newPassword', { override: true, ignoreUndefined: true });

// 刷新Token验证
const refreshTokenSchema = Joi.object({
    refreshToken: Joi.string().required()
        .messages({
            'any.required': '刷新令牌不能为空'
        })
})
    .rename('refresh_token', 'refreshToken', { override: true, ignoreUndefined: true });

module.exports = {
    loginSchema,
    registerSchema,
    changePasswordSchema,
    refreshTokenSchema
};
