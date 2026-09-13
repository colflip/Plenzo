const logger = require('../utils/logger.js');
/**
 * 管理员路由
 * @description 管理员端API路由配置，包括用户管理、排课管理、统计和数据导出
 * @module routes/admin
 */

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { requireCapability } = require('../utils/admin-permissions');
const { validate, scheduleValidation, userValidation, feeUpdateValidation, feeStatusUpdateValidation, feeStatusBatchValidation, scheduleTypeValidation, holidayValidation, holidayBatchValidation, holidaySyncValidation, feedbackCreateValidation, feedbackUpdateValidation, adminConfirmValidation, teacherPairStatusValidation, sessionAddPairValidation, adminTeacherAvailabilityValidation, adminStudentAvailabilityValidation } = require('../middleware/validation');
const adminController = require('../controllers/admin-controller');
const updateScheduleStatus = require('../jobs/update-schedule-status');
const { successResponse } = require('../utils/response');

// 用户管理路由：读全级别（字段按敏感度裁剪）；所有账号写操作仅 L1
router.get('/users/:userType', authMiddleware, adminOnly, requireCapability('users:read'), adminController.getUsers);
// 必须排在 /users/:userType/:id 之前，否则 next-id 会被当成 :id 落到详情接口
router.get('/users/:userType/next-id', authMiddleware, adminOnly, requireCapability('users:write'), adminController.getNextUserId);
router.get('/users/:userType/:id', authMiddleware, adminOnly, requireCapability('users:read'), adminController.getUserById);
router.post('/users', authMiddleware, adminOnly, requireCapability('users:write'), validate(userValidation.create), adminController.createUser);
router.put('/users/:userType/:id', authMiddleware, adminOnly, requireCapability('users:write'), validate(userValidation.update), adminController.updateUser);
router.delete('/users/:userType/:id', authMiddleware, adminOnly, requireCapability('users:write'), adminController.deleteUser);

// 排课管理路由：功能全级别可用，L3 的数据范围由服务层过滤（仅自己创建 + 无主存量）
router.get('/schedules', authMiddleware, adminOnly, requireCapability('schedules:read'), validate(scheduleValidation.query, 'query'), adminController.getSchedules);
router.get('/teacher-availability', authMiddleware, adminOnly, requireCapability('availability:read'), adminController.getTeacherAvailabilityGrid);
router.get('/teachers/conflicts', authMiddleware, adminOnly, requireCapability('conflicts:read'), adminController.getTeacherConflicts);
router.post('/teacher-availability', authMiddleware, adminOnly, requireCapability('availability:write'), validate(adminTeacherAvailabilityValidation), adminController.updateTeacherAvailability);

router.get('/student-availability', authMiddleware, adminOnly, requireCapability('availability:read'), adminController.getStudentAvailabilityGrid);
router.post('/student-availability', authMiddleware, adminOnly, requireCapability('availability:write'), validate(adminStudentAvailabilityValidation), adminController.updateStudentAvailability);
// 放在 :id 之前，避免被动态参数匹配到
router.get('/schedules/grid', authMiddleware, adminOnly, requireCapability('schedules:read'), adminController.getSchedulesGrid);
// 仅匹配数字ID，避免 'grid' 等字符串被当作ID
router.get('/schedules/:id(\\d+)', authMiddleware, adminOnly, requireCapability('schedules:read'), adminController.getScheduleById);
router.post('/schedules', authMiddleware, adminOnly, requireCapability('schedules:write'), validate(scheduleValidation.create), adminController.createSchedule);
router.put('/schedules/:id', authMiddleware, adminOnly, requireCapability('schedules:write'), validate(scheduleValidation.update), adminController.updateSchedule);
router.delete('/schedules/:id', authMiddleware, adminOnly, requireCapability('schedules:write'), adminController.deleteSchedule);
router.post('/schedules/:id/confirm', authMiddleware, adminOnly, requireCapability('schedules:write'), validate(adminConfirmValidation), adminController.confirmSchedule);

// ---- 一场一行的 pair 级端点（新建/编辑/删除三条交互的落点）----
// 删除三粒度：DELETE /sessions/:id（整场）、.../teachers/:uid、.../students/:uid（单个 pair，移空则整场删）
router.post('/sessions', authMiddleware, adminOnly, requireCapability('schedules:write'), validate(scheduleValidation.create), adminController.createSchedule);
router.get('/sessions/:id(\\d+)', authMiddleware, adminOnly, requireCapability('schedules:read'), adminController.getScheduleById);
router.patch('/sessions/:id(\\d+)', authMiddleware, adminOnly, requireCapability('schedules:write'), validate(scheduleValidation.update), adminController.updateSchedule);
router.delete('/sessions/:id(\\d+)', authMiddleware, adminOnly, requireCapability('schedules:write'), adminController.deleteSchedule);
router.patch('/sessions/:id(\\d+)/:kind(teachers|students)/:uid', authMiddleware, adminOnly, requireCapability('schedules:write'), validate(scheduleValidation.update), adminController.updateSchedule);
router.patch('/sessions/:id(\\d+)/teachers/:uid/status', authMiddleware, adminOnly, requireCapability('schedules:write'), validate(teacherPairStatusValidation), adminController.updateSchedule);
router.post('/sessions/:id(\\d+)/:kind(teachers|students)', authMiddleware, adminOnly, requireCapability('schedules:write'), validate(sessionAddPairValidation), adminController.addSchedulePair);
router.delete('/sessions/:id(\\d+)/:kind(teachers|students)/:uid', authMiddleware, adminOnly, requireCapability('schedules:write'), adminController.removeSchedulePair);

// 费用操作：路由放行到 L3，行级归属校验在服务层完成（单条拒绝 / 批量 all-or-nothing）
// 费用挂在教师 pair 上，所以带 :uid 的形式是主路径；不带 :uid 时服务层要求本场只有一位教师
router.patch('/schedules/:id/fees', authMiddleware, adminOnly, requireCapability('finance:write'), validate(feeUpdateValidation), adminController.updateScheduleFees);
router.patch('/sessions/:id(\\d+)/teachers/:uid/fees', authMiddleware, adminOnly, requireCapability('finance:write'), validate(feeUpdateValidation), adminController.updateScheduleFees);
router.patch('/schedules/:id/fee-status', authMiddleware, adminOnly, requireCapability('finance:write'), validate(feeStatusUpdateValidation), adminController.updateScheduleFeeStatus);
router.patch('/sessions/:id(\\d+)/teachers/:uid/fee-status', authMiddleware, adminOnly, requireCapability('finance:write'), validate(feeStatusUpdateValidation), adminController.updateScheduleFeeStatus);
router.post('/schedules/batch-fee-status', authMiddleware, adminOnly, requireCapability('finance:write'), validate(feeStatusBatchValidation), adminController.batchUpdateScheduleFeeStatus);

// 统计数据路由：排课衍生指标对 L3 做范围过滤；用户数统计保持全局
router.get('/statistics/overview', authMiddleware, adminOnly, requireCapability('statistics:read'), adminController.getOverviewStats);
router.get('/statistics/schedules', authMiddleware, adminOnly, requireCapability('statistics:read'), adminController.getScheduleStats);
router.get('/statistics/daily-schedules', authMiddleware, adminOnly, requireCapability('statistics:read'), adminController.getDailyScheduleStats);
router.get('/statistics/users', authMiddleware, adminOnly, requireCapability('statistics:read'), adminController.getUserStats);

// 课程类型管理路由：查询保持登录可读（教师/学生端展示依赖）；增删改仅 L1
router.get('/schedule-types', authMiddleware, adminController.getScheduleTypes);
router.post('/schedule-types', authMiddleware, adminOnly, requireCapability('settings:schedule-types:write'), validate(scheduleTypeValidation), adminController.createScheduleType);
router.put('/schedule-types/:id', authMiddleware, adminOnly, requireCapability('settings:schedule-types:write'), validate(scheduleTypeValidation), adminController.updateScheduleType);
router.delete('/schedule-types/:id', authMiddleware, adminOnly, requireCapability('settings:schedule-types:write'), adminController.deleteScheduleType);

// 节假日管理路由（/batch 和 /sync 必须在 /:id 之前注册）：查询保持登录可读；写操作仅 L1
router.get('/holidays', authMiddleware, adminController.getHolidays);
router.post('/holidays', authMiddleware, adminOnly, requireCapability('settings:holidays:write'), validate(holidayValidation), adminController.createHoliday);
router.post('/holidays/sync', authMiddleware, adminOnly, requireCapability('settings:holidays:write'), validate(holidaySyncValidation), adminController.syncHolidaysFromAPI);
router.put('/holidays/batch', authMiddleware, adminOnly, requireCapability('settings:holidays:write'), validate(holidayBatchValidation), adminController.batchUpsertHolidays);
router.put('/holidays/:id', authMiddleware, adminOnly, requireCapability('settings:holidays:write'), validate(holidayValidation), adminController.updateHoliday);
router.delete('/holidays/:id', authMiddleware, adminOnly, requireCapability('settings:holidays:write'), adminController.deleteHoliday);

// 反馈管理路由：
//  - list/create：任意已登录用户可查看与提交
//  - update/delete：仅 L1（原实现缺角色校验为现存漏洞，本次一并修复）
router.get('/feedbacks', authMiddleware, adminController.listFeedbacks);
router.post('/feedbacks', authMiddleware, validate(feedbackCreateValidation), adminController.createFeedback);
router.put('/feedbacks/:id', authMiddleware, adminOnly, requireCapability('feedback:update'), validate(feedbackUpdateValidation), adminController.updateFeedback);
router.delete('/feedbacks/:id', authMiddleware, adminOnly, requireCapability('feedback:update'), adminController.deleteFeedback);

// 手动触发排课状态更新任务（L2+）
router.post('/jobs/trigger-status-update', authMiddleware, adminOnly, requireCapability('jobs:trigger'), async (req, res, next) => {
    try {
        logger.log(`[AdminAPI] Manual trigger for status update by ${req.user?.username || 'unknown'}`);
        const result = await updateScheduleStatus();
        res.json(successResponse({
            message: 'Status update job executed',
            data: result
        }));
    } catch (err) {
        next(err);
    }
});

module.exports = router;
