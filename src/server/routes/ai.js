/**
 * AI 路由 (AI Routes) - 重构版
 * @description AI 数据查询接口
 * @module routes/ai
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { authMiddleware } = require('../middleware/auth');
const { teacherOrAdmin } = require('../middleware/role');
const aiController = require('../controllers/aiController');

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

// AI 状态检查
router.get('/status', authMiddleware, aiController.getStatus);

// 获取当前 AI 配置
router.get('/config', authMiddleware, teacherOrAdmin, aiController.getConfig);

// 获取预设 AI 模型列表
router.get('/presets', authMiddleware, teacherOrAdmin, aiController.getPresets);

// 更新 AI 配置
router.put('/config', authMiddleware, teacherOrAdmin, aiController.updateConfig);

// 检测 AI 模型状态（快速检测，只验证连接性）
router.post('/check', authMiddleware, teacherOrAdmin, aiController.checkModel);

// 测试 AI 模型连接（完整测试，发送真实请求）
router.post('/test', authMiddleware, teacherOrAdmin, aiController.testModel);

// 获取所有渠道支持的模型列表
router.get('/models', authMiddleware, teacherOrAdmin, aiController.getAvailableModels);

// 获取当前模型的能力信息
router.get('/capabilities', authMiddleware, aiController.getModelCapabilities);

// 数据查询接口
router.post('/query', authMiddleware, teacherOrAdmin, aiLimiter, aiController.query);

module.exports = router;
