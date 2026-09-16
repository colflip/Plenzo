/**
 * AI 路由 (AI Routes) - 重构版
 * @description AI 数据查询接口
 * @module routes/ai
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { authMiddleware } = require('../middleware/auth');
const { teacherOrAdmin, anyAuthenticated, adminOnly } = require('../middleware/role');
const aiController = require('../controllers/ai-controller');
const {
    validate,
    aiConfigUpdateValidation,
    aiConfigTestValidation,
    aiUserModelValidation,
    aiEndpointCreateValidation,
    aiEndpointUpdateValidation
} = require('../middleware/validation');

/**
 * AI 专用速率限制
 */
const aiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,  // 不考虑成本，放宽限流
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: {
        success: false,
        message: 'AI 请求过于频繁，请稍后再试'
    }
});

// 状态检测专用限流：避免单客户端并发轰 provider 触发上游 429
const aiCheckLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    message: {
        success: false,
        message: 'AI 状态检测请求过于频繁，请稍后再试'
    }
});

// AI 状态检查
router.get('/status', authMiddleware, aiController.getStatus);

// 获取当前 AI 配置
router.get('/config', authMiddleware, teacherOrAdmin, aiController.getConfig);

// 获取预设 AI 模型列表
router.get('/presets', authMiddleware, teacherOrAdmin, aiController.getPresets);

// 更新 AI 配置
router.put('/config', authMiddleware, teacherOrAdmin, validate(aiConfigUpdateValidation), aiController.updateConfig);

// 检测 AI 模型状态（快速检测，只验证连接性）
router.post('/check', authMiddleware, teacherOrAdmin, aiCheckLimiter, validate(aiConfigTestValidation), aiController.checkModel);

// 测试 AI 模型连接（完整测试，发送真实请求）
router.post('/test', authMiddleware, teacherOrAdmin, validate(aiConfigTestValidation), aiController.testModel);

// 获取所有渠道支持的模型列表
router.get('/models', authMiddleware, teacherOrAdmin, aiController.getAvailableModels);

// 获取当前模型的能力信息
router.get('/capabilities', authMiddleware, aiController.getModelCapabilities);

// 渠道端点管理（渠道 → 端点 → 模型）。
// 仅管理员：端点配置决定请求发往哪个地址、带哪把密钥，属于基础设施配置而非个人偏好。
// 真实密钥永不出现在响应里（服务层只回 hasOwnKey 标记）。
router.get('/endpoints', authMiddleware, adminOnly, aiController.getEndpoints);
router.post('/endpoints', authMiddleware, adminOnly, validate(aiEndpointCreateValidation), aiController.createEndpoint);
router.put('/endpoints/:id', authMiddleware, adminOnly, validate(aiEndpointUpdateValidation), aiController.updateEndpoint);
router.delete('/endpoints/:id', authMiddleware, adminOnly, aiController.deleteEndpoint);
// 会真实打一次上游，套用与 /check 相同的限流器
router.post('/endpoints/:id/test', authMiddleware, adminOnly, aiCheckLimiter, aiController.testEndpoint);

// 用户级模型偏好：所有人都能改，且只对自己生效（anyAuthenticated 覆盖 admin/teacher/student）
router.get('/selectable-models', authMiddleware, anyAuthenticated, aiController.getSelectableModels);
router.get('/my-model', authMiddleware, anyAuthenticated, aiController.getMyModel);
router.put('/my-model', authMiddleware, anyAuthenticated, validate(aiUserModelValidation), aiController.setMyModel);
// 验通候选模型（不落库）：会真实打一次上游，所以套用与 /check 同一个限流器
router.post('/my-model/check', authMiddleware, anyAuthenticated, aiCheckLimiter, validate(aiUserModelValidation), aiController.checkMyModel);
router.delete('/my-model', authMiddleware, anyAuthenticated, aiController.clearMyModel);

// 数据查询接口（支持学生、教师、管理员）。
// 可选 body.customConfig：浏览器本地新增的模型/端点（只存在用户自己的浏览器里，
// 不进数据库、不跨用户共享），由前端随每次提问带上，优先级高于用户偏好与全局配置。
// 其中的 baseUrl 来自客户端，服务端会过出站地址护栏（utils/ssrf-guard.js）后才发起请求。
router.post('/query', authMiddleware, anyAuthenticated, aiLimiter, aiController.query);

module.exports = router;
