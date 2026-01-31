/**
 * 排课路由配置
 * @description 定义排课模块的 API 路由，集成权限控制与参数验证
 * @module routes/schedule
 */

const express = require('express');
const router = express.Router();
const scheduleController = require('../controllers/scheduleController');
const { authMiddleware, adminOnly } = require('../middleware');
const { validate, scheduleValidation } = require('../middleware');

// ==========================================
// 查询可用资源
// ==========================================

/**
 * @route GET /api/schedule/available/teachers
 * @description 获取可用教师
 * @access Admin
 */
router.get('/available/teachers', authMiddleware, adminOnly, scheduleController.getAvailableTeachers);

/**
 * @route GET /api/schedule/available/students
 * @description 获取可用学生
 * @access Admin
 */
router.get('/available/students', authMiddleware, adminOnly, scheduleController.getAvailableStudents);

/**
 * @route GET /api/schedule/types
 * @description 获取所有课程类型
 * @access Authenticated
 */
router.get('/types', authMiddleware, scheduleController.getScheduleTypes);

// ==========================================
// 排课操作
// ==========================================

/**
 * @route POST /api/schedule/check-conflicts
 * @description 检查冲突
 * @access Admin
 */
router.post('/check-conflicts', authMiddleware, adminOnly, scheduleController.checkScheduleConflicts);

/**
 * @route POST /api/schedule/create
 * @description 创建排课
 * @access Admin
 */
router.post(
    '/create',
    authMiddleware,
    adminOnly,
    validate(scheduleValidation.create),
    scheduleController.createSchedule
);

// ==========================================
// 状态管理
// ==========================================

/**
 * @route POST /api/schedule/:id/confirm/teacher
 * @description 教师确认排课
 * @access Teacher
 */
router.post('/:id/confirm/teacher', authMiddleware, scheduleController.confirmTeacher);

/**
 * @route POST /api/schedule/:id/confirm/admin
 * @description 管理员确认排课
 * @access Admin
 */
router.post('/:id/confirm/admin', authMiddleware, adminOnly, scheduleController.confirmAdmin);

module.exports = router;
