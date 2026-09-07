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
const { validate, passwordChangeValidation, studentProfileValidation, studentAvailabilitySetValidation, studentAvailabilityDeleteValidation } = require('../middleware/validation');
const studentController = require('../controllers/student-controller');

// 个人信息管理
router.get('/profile', authMiddleware, studentOnly, studentController.getProfile);
router.put('/profile', authMiddleware, studentOnly, validate(studentProfileValidation), studentController.updateProfile);
router.put('/password', authMiddleware, studentOnly, validate(passwordChangeValidation), studentController.changePassword);

// 时间安排管理
router.get('/availability', authMiddleware, studentOnly, studentController.getAvailability);
router.post('/availability', authMiddleware, studentOnly, validate(studentAvailabilitySetValidation), studentController.setAvailability);
router.delete('/availability', authMiddleware, studentOnly, validate(studentAvailabilityDeleteValidation), studentController.deleteAvailability);

// 课程安排
router.get('/schedules', authMiddleware, studentOnly, studentController.getSchedules);

// 统计数据
router.get('/statistics', authMiddleware, studentOnly, studentController.getStatistics);

// 总览数据
router.get('/overview', authMiddleware, studentOnly, studentController.getOverview);

// 导出功能（限流：每小时最多10次）
router.get('/export-advanced', authMiddleware, studentOnly, strictLimiter, studentController.advancedExport);

// 排课端点全部只读：状态是教师维度的，学生把整行改成 confirmed 与「学生只能看课程信息」
// 直接冲突，原 POST /confirm-schedule/:id 已整条删除（前端按钮早已注释掉、函数无调用者）。

module.exports = router;