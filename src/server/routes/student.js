/**
 * 学生路由
 * @description 学生端API路由配置，包括个人信息、时间安排、课程和统计
 * @module routes/student
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const studentController = require('../controllers/studentController');

// 个人信息管理
router.get('/profile', authMiddleware, studentController.getProfile);
router.put('/profile', authMiddleware, studentController.updateProfile);
router.put('/password', authMiddleware, studentController.changePassword);

// 时间安排管理
router.get('/availability', authMiddleware, studentController.getAvailability);
router.post('/availability', authMiddleware, studentController.setAvailability);
router.delete('/availability', authMiddleware, studentController.deleteAvailability);

// 课程安排
router.get('/schedules', authMiddleware, studentController.getSchedules);

// 统计数据
router.get('/statistics', authMiddleware, studentController.getStatistics);

// 总览数据
router.get('/overview', authMiddleware, studentController.getOverview);

// 数据汇总
router.get('/data-summary', authMiddleware, studentController.getDataSummary);

// 导出功能
router.get('/export', authMiddleware, studentController.exportMySchedules);

// 确认课程
router.post('/confirm-schedule/:id', authMiddleware, studentController.confirmSchedule);

module.exports = router;