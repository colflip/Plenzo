/**
 * 认证控制器
 * @description 处理用户认证相关的 HTTP 请求
 * @module controllers/authController
 */

const authService = require('../services/auth-service');
const userService = require('../services/user-service');
const { asyncHandler } = require('../middleware');
const { successResponse } = require('../utils/response');
const { AppError } = require('../middleware/error');

const authController = {
    /**
     * @route POST /api/auth/login
     * @description 用户登录
     */
    login: asyncHandler(async (req, res) => {
        const { username, password, userType, rememberMe } = req.body;
        const rem = rememberMe === true || rememberMe === 'true';
        const result = await authService.login(username, password, userType, rem);

        // P1-5 修复：将 JWT 写入 httpOnly Cookie，避免 XSS 经 localStorage 窃取。
        // 仍返回 token 以兼容非浏览器/旧客户端，但前端不再写入 localStorage。
        const isProd = process.env.NODE_ENV === 'production';
        const maxAge = rem ? 30 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
        res.cookie('token', result.token, {
            httpOnly: true,
            secure: isProd,
            sameSite: 'lax',
            path: '/',
            maxAge
        });

        res.json(successResponse(result));
    }),

    /**
     * @route POST /api/auth/logout
     * @description 登出：清除 httpOnly Cookie
     */
    logout: asyncHandler(async (req, res) => {
        const isProd = process.env.NODE_ENV === 'production';
        res.clearCookie('token', { path: '/', secure: isProd, sameSite: 'lax' });
        res.json(successResponse({ message: '已登出' }));
    }),

    /**
     * @route POST /api/auth/register
     * @description 用户注册 (仅限管理员，且仅 L1 —— 由 UserService.createUser 内部断言)
     *
     * 以前这里走 AuthService.register 那份独立实现：它只解构
     * `{username, password, name, userType, additionalInfo}`，而**没有任何调用方传过
     * additionalInfo** —— 于是校验器允许的 email / permission_level / contact / nickname /
     * status 全部在 INSERT 前被丢掉。生产库 `administrators.email` 与 `permission_level`
     * 都是 NOT NULL 且无默认值（2026-10-09 实测），所以「注册一个管理员」这条路径
     * 从来就没成功过，只会撞 23502。现在统一到 user-service.createUser 那一条已有路径：
     * L1 门禁、不能创建比自己更高的档位、按角色白名单落列、用户名/ID 冲突 409、写审计。
     */
    register: asyncHandler(async (req, res) => {
        // registerSchema 把入站 permission_level 归一成了 camelCase，服务层按列名取值
        const { permissionLevel, ...rest } = req.body || {};
        const payload = { ...rest };
        if (permissionLevel !== undefined) payload.permission_level = permissionLevel;

        const data = await userService.createUser(payload, req);
        res.status(201).json(successResponse(data, { requestId: req.requestId }));
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
            return next(new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '无效的用户类型' }));
        }

        const result = await authService.changePassword(username, oldPassword, newPassword, targetUserType);
        res.json(successResponse(result));
    })
};

module.exports = authController;
