/**
 * 认证控制器
 * @description 处理用户认证相关的 HTTP 请求
 * @module controllers/authController
 */

const authService = require('../services/authService');
const { asyncHandler } = require('../middleware');

const authController = {
    /**
     * @route POST /api/auth/login
     * @description 用户登录
     */
    login: asyncHandler(async (req, res) => {
        const { username, password, userType } = req.body;
        const result = await authService.login(username, password, userType);
        res.json(result);
    }),

    /**
     * @route POST /api/auth/register
     * @description 用户注册 (仅限管理员)
     */
    register: asyncHandler(async (req, res) => {
        // req.body 由 Joi 验证器清洗和验证
        const result = await authService.register(req.body);
        res.status(201).json(result);
    }),

    /**
     * @route POST /api/auth/change-password
     * @description 修改密码
     */
    changePassword: asyncHandler(async (req, res) => {
        const { username, oldPassword, newPassword, userType } = req.body;
        const result = await authService.changePassword(username, oldPassword, newPassword, userType);
        res.json(result);
    })
};

module.exports = authController;
