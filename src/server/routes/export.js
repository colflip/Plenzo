/**
 * 统一导出路由
 * @description 四端共用的导出 API
 * @module routes/export
 */

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/rate-limit');
const { validate, exportScheduleValidation } = require('../middleware/validation');
const exportController = require('../controllers/export-controller');

// 统一排课数据导出（四端共用）
// body 必须过校验：exportType 决定走哪条查询分支，过去它直接取自请求体且无人校验。
router.post('/schedule', authMiddleware, strictLimiter, validate(exportScheduleValidation), exportController.exportSchedule);

// 信息类导出（仅管理员）
router.post('/info', authMiddleware, adminOnly, strictLimiter, exportController.exportInfo);

module.exports = router;
