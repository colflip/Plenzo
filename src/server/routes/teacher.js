/**
 * 教师路由
 * @description 教师端API路由配置，包括个人信息、时间安排、课程和统计
 * @module routes/teacher
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { teacherOnly, anyAuthenticated } = require('../middleware/role');
const { strictLimiter } = require('../middleware/rateLimit');
const teacherController = require('../controllers/teacherController');

// 个人信息管理
router.get('/profile', authMiddleware, teacherOnly, teacherController.getProfile);
router.put('/profile', authMiddleware, teacherOnly, teacherController.updateProfile);
router.put('/password', authMiddleware, teacherOnly, teacherController.changePassword);

// 时间安排管理
router.get('/availability', authMiddleware, teacherOnly, teacherController.getAvailability);
router.post('/availability', authMiddleware, teacherOnly, teacherController.setAvailability);
router.delete('/availability', authMiddleware, teacherOnly, teacherController.deleteAvailability);

// 课程安排
router.get('/schedules', authMiddleware, teacherOnly, teacherController.getSchedules);
router.post('/schedules/:id/confirm', authMiddleware, teacherOnly, teacherController.confirmSchedule);
router.put('/schedules/:id/status', authMiddleware, teacherOnly, teacherController.updateScheduleStatus);
router.patch('/schedules/:id', authMiddleware, teacherOnly, teacherController.updateScheduleStatus);
router.patch('/schedules/:id/fees', authMiddleware, teacherOnly, teacherController.updateScheduleFees);

// 班主任管理关联学生
router.get('/student-schedules', authMiddleware, teacherOnly, teacherController.getHeadTeacherStudentSchedules);
router.get('/student-schedules/export', authMiddleware, teacherOnly, strictLimiter, teacherController.exportHeadTeacherStudentData);
router.get('/associated-students', authMiddleware, teacherOnly, teacherController.getAssociatedStudents);
router.get('/associated-students/detail', authMiddleware, teacherOnly, teacherController.getAssociatedStudentsDetail);
router.put('/associated-students/:id', authMiddleware, teacherOnly, teacherController.updateAssociatedStudent);
router.get('/all-teachers', authMiddleware, anyAuthenticated, teacherController.getAllTeachers);
router.post('/batch-fees', authMiddleware, teacherOnly, teacherController.batchUpdateScheduleFees);

// 总览数据
router.get('/overview', authMiddleware, teacherOnly, teacherController.getOverview);

// 统计数据
router.get('/statistics', authMiddleware, teacherOnly, teacherController.getStatistics);
router.get('/teaching-count', authMiddleware, teacherOnly, teacherController.getTeachingCount);
router.get('/export-advanced', authMiddleware, teacherOnly, strictLimiter, teacherController.advancedExport);
router.get('/detailed-schedules', authMiddleware, teacherOnly, teacherController.getDetailedSchedules);

module.exports = router;