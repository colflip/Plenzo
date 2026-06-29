/**
 * 统一导出路由
 * @description 四端共用的导出 API
 * @module routes/export
 */

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/rateLimit');
const exportController = require('../controllers/exportController');

// 统一排课数据导出（四端共用）
router.post('/schedule', authMiddleware, strictLimiter, exportController.exportSchedule);

// 信息类导出（仅管理员）
router.post('/info', authMiddleware, adminOnly, strictLimiter, exportController.exportInfo);

module.exports = router;
