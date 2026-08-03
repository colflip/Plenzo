/**
 * 学生路由
 * @description 学生端API路由配置，包括个人信息、时间安排、课程和统计
 * @module routes/student
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { studentOnly } = require('../middleware/role');
const { strictLimiter } = require('../middleware/rate-limit');
const studentController = require('../controllers/student-controller');

// 个人信息管理
router.get('/profile', authMiddleware, studentOnly, studentController.getProfile);
router.put('/profile', authMiddleware, studentOnly, studentController.updateProfile);
router.put('/password', authMiddleware, studentOnly, studentController.changePassword);

// 时间安排管理
router.get('/availability', authMiddleware, studentOnly, studentController.getAvailability);
router.post('/availability', authMiddleware, studentOnly, studentController.setAvailability);
router.delete('/availability', authMiddleware, studentOnly, studentController.deleteAvailability);

// 课程安排
router.get('/schedules', authMiddleware, studentOnly, studentController.getSchedules);

// 统计数据
router.get('/statistics', authMiddleware, studentOnly, studentController.getStatistics);

// 总览数据
router.get('/overview', authMiddleware, studentOnly, studentController.getOverview);

// 导出功能（限流：每小时最多10次）
router.get('/export-advanced', authMiddleware, studentOnly, strictLimiter, studentController.advancedExport);

// 确认课程
router.post('/confirm-schedule/:id', authMiddleware, studentOnly, studentController.confirmSchedule);

module.exports = router;