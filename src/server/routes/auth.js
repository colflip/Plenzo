/**
 * 认证路由
 * @description 定义认证相关的 API 端点
 * @module routes/auth
 */

const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const { validate, adminOnly, authMiddleware } = require('../middleware');
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
router.post('/register', authMiddleware, adminOnly, validate(registerSchema), authController.register);

/**
 * @route POST /api/auth/change-password
 * @description 修改密码（仅限已登录用户修改自己的密码）
 * @access Private
 */
router.post('/change-password', authMiddleware, validate(changePasswordSchema), authController.changePassword);

module.exports = router;
