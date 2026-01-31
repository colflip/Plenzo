const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const statisticsController = require('../controllers/statisticsController');

// 管理员统计
router.get('/admin/overview', authMiddleware, adminOnly, statisticsController.getAdminOverview);
router.get('/admin/schedules', authMiddleware, adminOnly, statisticsController.getAdminScheduleStats);
router.get('/admin/users', authMiddleware, adminOnly, statisticsController.getAdminUserStats);

// 教师统计
router.get('/teacher/:id', authMiddleware, statisticsController.getTeacherStats);

// 学生统计
router.get('/student/:id', authMiddleware, statisticsController.getStudentStats);

module.exports = router;