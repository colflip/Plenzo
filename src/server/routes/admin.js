/**
 * 管理员路由
 * @description 管理员端API路由配置，包括用户管理、排课管理、统计和数据导出
 * @module routes/admin
 */

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { validate, scheduleValidation, userValidation } = require('../middleware/validation');
const adminController = require('../controllers/adminController');
const updateScheduleStatus = require('../jobs/updateScheduleStatus');

// 用户管理路由
router.get('/users/:userType', authMiddleware, adminOnly, adminController.getUsers);
router.get('/users/:userType/:id', authMiddleware, adminOnly, adminController.getUserById);
router.post('/users', authMiddleware, adminOnly, validate(userValidation.create), adminController.createUser);
router.put('/users/:userType/:id', authMiddleware, adminOnly, validate(userValidation.update), adminController.updateUser);
router.delete('/users/:userType/:id', authMiddleware, adminOnly, adminController.deleteUser);

// 排课管理路由
router.get('/schedules', authMiddleware, adminOnly, validate(scheduleValidation.query, 'query'), adminController.getSchedules);
router.get('/teacher-availability', authMiddleware, adminOnly, adminController.getTeacherAvailabilityGrid);
router.get('/teachers/conflicts', authMiddleware, adminOnly, adminController.getTeacherConflicts);
router.post('/teacher-availability', authMiddleware, adminOnly, adminController.updateTeacherAvailability);

router.get('/student-availability', authMiddleware, adminOnly, adminController.getStudentAvailabilityGrid);
router.post('/student-availability', authMiddleware, adminOnly, adminController.updateStudentAvailability);
// 放在 :id 之前，避免被动态参数匹配到
router.get('/schedules/grid', authMiddleware, adminOnly, adminController.getSchedulesGrid);
// 仅匹配数字ID，避免 'grid' 等字符串被当作ID
router.get('/schedules/:id(\\d+)', authMiddleware, adminOnly, adminController.getScheduleById);
router.post('/schedules', authMiddleware, adminOnly, validate(scheduleValidation.create), adminController.createSchedule);
router.put('/schedules/:id', authMiddleware, adminOnly, validate(scheduleValidation.update), adminController.updateSchedule);
router.delete('/schedules/:id', authMiddleware, adminOnly, adminController.deleteSchedule);
router.post('/schedules/:id/confirm', authMiddleware, adminOnly, adminController.confirmSchedule);
router.patch('/schedules/:id/fees', authMiddleware, adminOnly, adminController.updateScheduleFees);

// 统计数据路由
router.get('/statistics/overview', authMiddleware, adminOnly, adminController.getOverviewStats);
router.get('/statistics/schedules', authMiddleware, adminOnly, adminController.getScheduleStats);
router.get('/statistics/users', authMiddleware, adminOnly, adminController.getUserStats);

// 数据导出路由
router.get('/export/teachers', authMiddleware, adminOnly, adminController.exportTeacherData);
router.get('/export/students', authMiddleware, adminOnly, adminController.exportStudentData);

// 高级数据导出路由（支持多种导出类型和格式）
router.get('/export-advanced', authMiddleware, adminOnly, adminController.advancedExport);

// 课程类型管理路由
router.get('/schedule-types', authMiddleware, adminController.getScheduleTypes);
router.post('/schedule-types', authMiddleware, adminOnly, adminController.createScheduleType);
router.put('/schedule-types/:id', authMiddleware, adminOnly, adminController.updateScheduleType);
router.delete('/schedule-types/:id', authMiddleware, adminOnly, adminController.deleteScheduleType);

// 手动触发排课状态更新任务
router.post('/jobs/trigger-status-update', authMiddleware, adminOnly, async (req, res, next) => {
    try {
        console.log(`[AdminAPI] Manual trigger for status update by ${req.user?.username || 'unknown'}`);
        const result = await updateScheduleStatus();
        res.json({
            message: 'Status update job executed',
            data: result
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
