/**
 * 排课管理控制器
 * @description 处理排课相关的 HTTP 请求，协调 Service 层完成业务
 * @module controllers/scheduleController
 */

const scheduleService = require('../services/schedule-service');
const { asyncHandler } = require('../middleware/error');
const { successResponse } = require('../utils/response');

const scheduleController = {
    /**
     * @route GET /api/schedule/available/teachers
     * @description 获取可用的教师列表
     */
    getAvailableTeachers: asyncHandler(async (req, res) => {
        const { date, timeSlot, startTime, endTime } = req.query;
        const teachers = await scheduleService.getAvailableTeachers(date, timeSlot, startTime, endTime);
        res.json(successResponse(teachers, { requestId: req.requestId }));
    }),

    /**
     * @route GET /api/schedule/available/students
     * @description 获取可用的学生列表
     */
    getAvailableStudents: asyncHandler(async (req, res) => {
        const { date, timeSlot, startTime, endTime } = req.query;
        const students = await scheduleService.getAvailableStudents(date, timeSlot, startTime, endTime);
        res.json(successResponse(students, { requestId: req.requestId }));
    }),

    /**
     * @route POST /api/schedule/check-conflicts
     * @description 检查排课冲突
     */
    checkScheduleConflicts: asyncHandler(async (req, res) => {
        const { teacherId, studentId, date, timeSlot, startTime, endTime } = req.body;

        // 注意：service 返回 { hasConflicts: boolean, ... }
        const result = await scheduleService.checkConflicts(
            teacherId, studentId, date, timeSlot, startTime, endTime
        );
        res.json(successResponse(result, { requestId: req.requestId }));
    }),

    /**
     * @route POST /api/schedule/create
     * @description 创建排课（与管理员端同一实现：一场课一行，教师/学生各是 pair 名册）
     */
    createSchedule: asyncHandler(async (req, res) => {
        // req.body 已通过 Joi 验证
        const result = await scheduleService.adminCreateSchedule(req);
        res.status(201).json(successResponse(result, { requestId: req.requestId }));
    }),

    /**
     * @route GET /api/schedule/types
     * @description 获取所有课程类型
     */
    getScheduleTypes: asyncHandler(async (req, res) => {
        const types = await scheduleService.getScheduleTypes();
        res.json(successResponse(types, { requestId: req.requestId }));
    }),

    /**
     * @route POST /api/schedule/:id/confirm/teacher
     * @description 教师（含班主任代确认）确认课程
     *
     * 走的是教师端确认那一份实现。以前这里另写了一条「只有本人任课或管理员可确认」的判断，
     * 于是同一个动作从两个入口进来权限不一样：班主任走 /api/teacher 能确认，走这条被 403。
     */
    confirmTeacher: asyncHandler(async (req, res) => {
        const result = await scheduleService.teacherUpdateScheduleStatus({
            ...req,
            body: { ...(req.body || {}), lifecycle: 'confirmed' }
        });
        res.json(successResponse({
            message: '课程已确认',
            status: result.schedule.status_code
        }, { requestId: req.requestId }));
    }),

    /**
     * @route POST /api/schedule/:id/confirm/admin
     * @description 管理员确认课程（与 /api/admin/schedules/:id/confirm 同一实现）
     */
    confirmAdmin: asyncHandler(async (req, res) => {
        const result = await scheduleService.adminConfirmSchedule({
            ...req,
            body: { ...(req.body || {}), adminConfirmed: true }
        });
        res.json(successResponse({
            message: '课程已确认',
            ...(result.schedule ? { status: result.schedule.status_code } : {})
        }, { requestId: req.requestId }));
    })
};

module.exports = scheduleController;
