/**
 * 排课管理控制器
 * @description 处理排课相关的 HTTP 请求，协调 Service 层完成业务
 * @module controllers/scheduleController
 */

const scheduleService = require('../services/scheduleService');
const { asyncHandler } = require('../middleware/error');

const scheduleController = {
    /**
     * @route GET /api/schedule/available/teachers
     * @description 获取可用的教师列表
     */
    getAvailableTeachers: asyncHandler(async (req, res) => {
        const { date, timeSlot, startTime, endTime } = req.query;
        const teachers = await scheduleService.getAvailableTeachers(date, timeSlot, startTime, endTime);
        res.json(teachers);
    }),

    /**
     * @route GET /api/schedule/available/students
     * @description 获取可用的学生列表
     */
    getAvailableStudents: asyncHandler(async (req, res) => {
        const { date, timeSlot, startTime, endTime } = req.query;
        const students = await scheduleService.getAvailableStudents(date, timeSlot, startTime, endTime);
        res.json(students);
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
        res.json(result);
    }),

    /**
     * @route POST /api/schedule/create
     * @description 创建课程安排 (支持批量)
     */
    createSchedule: asyncHandler(async (req, res) => {
        // req.body 已通过 Joi 验证
        const result = await scheduleService.createSchedule(req.body, req.user.id);
        res.status(201).json(result);
    }),

    /**
     * @route GET /api/schedule/types
     * @description 获取所有课程类型
     */
    getScheduleTypes: asyncHandler(async (req, res) => {
        const types = await scheduleService.getScheduleTypes();
        res.json(types);
    }),

    /**
     * @route POST /api/schedule/:id/confirm/teacher
     * @description 教师确认课程
     */
    confirmTeacher: asyncHandler(async (req, res) => {
        const { id } = req.params;
        await scheduleService.confirmSchedule(id, req.user.id, false);
        res.json({ success: true, message: '课程已确认' });
    }),

    /**
     * @route POST /api/schedule/:id/confirm/admin
     * @description 管理员确认课程
     */
    confirmAdmin: asyncHandler(async (req, res) => {
        const { id } = req.params;
        await scheduleService.confirmSchedule(id, req.user.id, true);
        res.json({ success: true, message: '课程已确认' });
    })
};

module.exports = scheduleController;
