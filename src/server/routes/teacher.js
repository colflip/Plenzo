/**
 * 教师路由
 * @description 教师端API路由配置，包括个人信息、时间安排、课程和统计
 * @module routes/teacher
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { teacherOnly, anyAuthenticated } = require('../middleware/role');
const { strictLimiter } = require('../middleware/rate-limit');
const { validate, passwordChangeValidation, teacherProfileValidation, feeUpdateValidation, feeStatusUpdateValidation, feeStatusBatchValidation, feeBatchValidation, teacherConfirmValidation, teacherStatusUpdateValidation, teacherAvailabilitySetValidation, teacherAvailabilityDeleteValidation, teacherAvailabilityReplaceValidation } = require('../middleware/validation');
const teacherController = require('../controllers/teacher-controller');

// 个人信息管理
router.get('/profile', authMiddleware, teacherOnly, teacherController.getProfile);
router.put('/profile', authMiddleware, teacherOnly, validate(teacherProfileValidation), teacherController.updateProfile);
router.put('/password', authMiddleware, teacherOnly, validate(passwordChangeValidation), teacherController.changePassword);

// 时间安排管理
router.get('/availability', authMiddleware, teacherOnly, teacherController.getAvailability);
router.post('/availability', authMiddleware, teacherOnly, validate(teacherAvailabilitySetValidation), teacherController.setAvailability);
router.delete('/availability', authMiddleware, teacherOnly, validate(teacherAvailabilityDeleteValidation), teacherController.deleteAvailability);
// R2（选项 B）：原子保存。单事务内 upsert 提及项 + DELETE 提及项，未提及保留。
router.put('/availability', authMiddleware, teacherOnly, validate(teacherAvailabilityReplaceValidation), teacherController.replaceAvailability);

// 课程安排
router.get('/schedules', authMiddleware, teacherOnly, teacherController.getSchedules);
router.post('/schedules/:id/confirm', authMiddleware, teacherOnly, validate(teacherConfirmValidation), teacherController.confirmSchedule);
router.put('/schedules/:id/status', authMiddleware, teacherOnly, validate(teacherStatusUpdateValidation), teacherController.updateScheduleStatus);
router.patch('/schedules/:id', authMiddleware, teacherOnly, validate(teacherStatusUpdateValidation), teacherController.updateScheduleStatus);
router.patch('/schedules/:id/fees', authMiddleware, teacherOnly, validate(feeUpdateValidation), teacherController.updateScheduleFees);
router.patch('/schedules/:id/fee-status', authMiddleware, teacherOnly, validate(feeStatusUpdateValidation), teacherController.updateScheduleFeeStatus);
router.post('/schedules/batch-fee-status', authMiddleware, teacherOnly, validate(feeStatusBatchValidation), teacherController.batchUpdateScheduleFeeStatus);

// 班主任管理关联学生
router.get('/student-schedules', authMiddleware, teacherOnly, teacherController.getHeadTeacherStudentSchedules);
router.get('/student-schedules/export', authMiddleware, teacherOnly, strictLimiter, teacherController.exportHeadTeacherStudentData);
router.get('/associated-students', authMiddleware, teacherOnly, teacherController.getAssociatedStudents);
router.get('/associated-students/detail', authMiddleware, teacherOnly, teacherController.getAssociatedStudentsDetail);
router.put('/associated-students/:id', authMiddleware, teacherOnly, teacherController.updateAssociatedStudent);
router.get('/all-teachers', authMiddleware, anyAuthenticated, teacherController.getAllTeachers);
router.post('/batch-fees', authMiddleware, teacherOnly, validate(feeBatchValidation), teacherController.batchUpdateScheduleFees);

// 总览数据
router.get('/overview', authMiddleware, teacherOnly, teacherController.getOverview);

// 统计数据
router.get('/statistics', authMiddleware, teacherOnly, teacherController.getStatistics);
router.get('/teaching-count', authMiddleware, teacherOnly, teacherController.getTeachingCount);
router.get('/export-advanced', authMiddleware, teacherOnly, strictLimiter, teacherController.advancedExport);
router.get('/detailed-schedules', authMiddleware, teacherOnly, teacherController.getDetailedSchedules);

module.exports = router;