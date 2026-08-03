/**
 * 认证控制器
 * @description 处理用户认证相关的 HTTP 请求
 * @module controllers/authController
 */

const authService = require('../services/auth-service');
const { asyncHandler } = require('../middleware');

const authController = {
    /**
     * @route POST /api/auth/login
     * @description 用户登录
     */
    login: asyncHandler(async (req, res) => {
        const { username, password, userType, rememberMe } = req.body;
        const result = await authService.login(username, password, userType, rememberMe === true || rememberMe === 'true');
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
        const { oldPassword, newPassword, userType } = req.body;
        // 从 JWT 中获取 username，防止越权修改他人密码
        const username = req.user.userType === 'admin' ? (req.body.username || req.user.username) : req.user.username;
        const targetUserType = userType || req.user.userType;

        // 验证目标用户类型合法性
        const validUserTypes = ['admin', 'teacher', 'student'];
        if (!validUserTypes.includes(targetUserType)) {
            return res.status(400).json({ message: '无效的用户类型' });
        }

        const result = await authService.changePassword(username, oldPassword, newPassword, targetUserType);
        res.json(result);
    })
};

module.exports = authController;
