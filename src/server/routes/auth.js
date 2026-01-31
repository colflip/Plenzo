/**
 * 认证路由
 * @description 定义认证相关的 API 端点
 * @module routes/auth
 */

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { validate, adminOnly } = require('../middleware');
const { loginSchema, registerSchema, changePasswordSchema } = require('../validators');

/**
 * @route POST /api/auth/login
 * @description 用户登录
 * @access Public
 */
router.post('/login', validate(loginSchema), authController.login);

/**
 * @route POST /api/auth/register
 * @description 用户注册 (仅管理员可用)
 * @access Private (Admin)
 */
router.post('/register', validate(registerSchema), adminOnly, authController.register);

/**
 * @route POST /api/auth/change-password
 * @description 修改密码
 * @access Public
 */
router.post('/change-password', validate(changePasswordSchema), authController.changePassword);

module.exports = router;
