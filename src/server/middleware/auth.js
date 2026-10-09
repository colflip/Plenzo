const logger = require('../utils/logger.js');
/**
 * 认证中间件
 * @description 提供JWT认证、权限检查等功能
 * @module middleware/auth
 */

const jwt = require('jsonwebtoken');
const { AppError } = require('./error');
const { checkAccount } = require('../utils/session-revocation');

/**
 * 获取JWT密钥
 * @returns {string} JWT密钥
 */
// 弱/默认密钥清单（单一来源；app.js 启动时复用本函数做校验）
const WEAK_SECRETS = ['your-secret-key-change-this-in-production', 'dev-insecure-secret'];

function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || WEAK_SECRETS.includes(secret)) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('致命错误: 生产环境未设置有效的 JWT_SECRET 环境变量');
        }
        logger.warn('[AUTH] 警告: 使用默认 JWT 密钥，仅限开发环境');
        return 'dev-insecure-secret';
    }
    return secret;
}

/**
 * 解析 Cookie 头（避免引入额外依赖）
 * @param {object} req - Express 请求对象
 * @returns {Object} cookie 名值映射
 */
function parseCookies(req) {
    const header = req.headers.cookie;
    const cookies = {};
    if (!header) return cookies;
    header.split(';').forEach(pair => {
        const idx = pair.indexOf('=');
        if (idx === -1) return;
        const key = pair.slice(0, idx).trim();
        const value = pair.slice(idx + 1).trim();
        if (key) cookies[key] = decodeURIComponent(value);
    });
    return cookies;
}

/**
 * 令牌纪元（token epoch）。
 *
 * JWT 载荷里存的是用户 id。用户改主键（new_id）或批量重编 ID 后，在途 token 里的旧 id
 * 会指向一个不存在的用户 —— 中间件只验签名不查库，结果不是干净的 401，而是请求通过认证
 * 后在业务层悄悄查空。引入递增纪元值：改号/重编时把 TOKEN_EPOCH +1，所有旧 token 立即失效，
 * 前端收到 401 自动跳登录页（api-client 已有该逻辑），无需逐个踢人。
 *
 * 零每请求开销：只在签名与验签时读一次环境变量。
 */
const TOKEN_EPOCH_DEFAULT = 1;

function getTokenEpoch() {
    const n = parseInt(process.env.TOKEN_EPOCH, 10);
    return Number.isInteger(n) && n > 0 ? n : TOKEN_EPOCH_DEFAULT;
}

/**
 * 唯一的令牌验签入口。
 *
 * 此前全库有三处各自实现校验（本文件的 authMiddleware、app.js 的 goodluck 路由、
 * auth-service 的密钥策略），彼此不一致：`app.js` 既不固定算法，也**不比对 TOKEN_EPOCH**，
 * 于是「用户 ID 重编后让所有旧 token 失效」这个开关在该路由上根本不生效 —— 而旧 token 里的
 * `id` 重编后可能已归属另一位教师，等于跨用户读出酬劳明细。
 *
 * 三件事必须同时做：固定算法、比对纪元、拒绝把 refresh token 当 access token 用。
 * @param {string} raw 令牌原文
 * @returns {object} 解码后的载荷；校验不过时抛 AppError（401）
 */
function verifyToken(raw) {
    if (!raw) {
        throw new AppError({ code: 'AUTH_REQUIRED', statusCode: 401, message: '未提供认证令牌' });
    }

    let decoded;
    try {
        decoded = jwt.verify(raw, getJwtSecret(), { algorithms: ['HS256'] });
    } catch (error) {
        const expired = error && error.name === 'TokenExpiredError';
        throw new AppError({
            code: expired ? 'AUTH_EXPIRED' : 'AUTH_INVALID',
            statusCode: 401,
            message: expired ? '认证令牌已过期' : '无效的认证令牌'
        });
    }

    // 纪元不匹配 = 该 token 签发于上一次「用户 ID 变更」之前，身份已不可信。
    // 带固定 code 供前端识别；message 会被 api-client 直接展示。
    if (decoded.tv !== getTokenEpoch()) {
        throw new AppError({
            code: 'SESSION_EPOCH_MISMATCH',
            statusCode: 401,
            message: '账号信息已变更，请重新登录'
        });
    }

    // refresh token 是另一张同密钥、同载荷的票；没有 /refresh 端点之前，
    // 绝不能让它直接当访问凭证用（否则 30 天的长效票绕过了所有短周期语义）。
    if (decoded.type === 'refresh') {
        throw new AppError({ code: 'AUTH_INVALID', statusCode: 401, message: '无效的认证令牌' });
    }

    return decoded;
}

/**
 * 验签 + 账号状态复核：任何「拿令牌换身份」的地方都该走这一个函数。
 *
 * 分成两层是有原因的：verifyToken 是纯函数（可在测试里钉错误契约），verifySession 多了
 * 一次账号状态读取。之前 app.js 的隐藏酬劳路由只用前者，于是被停用/删除的教师仍带着
 * 旧票读得到酬劳明细 —— 状态检查必须在唯一入口上，不能各路由自己决定查不查。
 * @param {string} raw 令牌原文
 * @returns {Promise<object>} 解码后的载荷
 */
async function verifySession(raw) {
    const decoded = verifyToken(raw);

    // 验签只说明「这张票是我签的且没过期」，不说明账号还在用。
    // 停用/删除后旧票原本会一直活到自然过期（审查报告 P1-4 的后半），这里补上状态判定。
    const session = await checkAccount(decoded.userType, decoded.id);
    if (!session.alive) {
        throw new AppError({
            code: 'SESSION_REVOKED',
            statusCode: 401,
            message: session.reason === 'gone'
                ? '账号已被删除，请重新登录'
                : '账号已被停用，请联系管理员'
        });
    }

    return decoded;
}

/**
 * 认证中间件
 * @description 验证 JWT 令牌并注入真实用户身份
 * 令牌来源优先级：httpOnly Cookie（推荐，防 XSS 窃取）> Authorization 头（兼容旧客户端）
 */
const authMiddleware = async (req, res, next) => {
    try {
        const decoded = await verifySession(getTokenFromRequest(req));

        req.user = {
            id: decoded.id,
            userType: decoded.userType,
            permissionLevel: decoded.permissionLevel
        };

        next();
    } catch (error) {
        return next(error);
    }
};

/*
 * 这里曾经有一个 checkPermissionLevel(level)：全库零调用，且在 permissionLevel 为
 * null 时 `null > level` 为 false —— 会**放行**。权限判定只保留 role.js 的
 * requirePermissionLevel（缺失按 L3 最小权限处理），避免留下一个看着能用、
 * 实际方向相反的中间件（审查报告 P2-11 / P3-7）。
 */
// adminOnly 统一从 role.js 导出，确保所有路由使用同一个实现
const { adminOnly } = require('./role');

/**
 * 从请求里取令牌原文：httpOnly Cookie 优先（同站导航自动携带，不会被 XSS 读到），
 * 兼容 Authorization: Bearer 头。此前 app.js 自己抄了一份同样逻辑，现已合并到此处。
 * @param {object} req
 * @returns {string|null}
 */
function getTokenFromRequest(req) {
    const cookies = parseCookies(req);
    if (cookies.token) return cookies.token;
    const authHeader = req.headers && req.headers.authorization;
    if (authHeader) {
        const parts = authHeader.split(' ');
        if (parts.length === 2 && /^[Bb]earer$/i.test(parts[0])) return parts[1];
    }
    return null;
}

module.exports = {
    authMiddleware,
    adminOnly,
    getJwtSecret,
    getTokenEpoch,
    verifyToken,
    verifySession,
    getTokenFromRequest
};