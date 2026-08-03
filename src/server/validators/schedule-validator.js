/**
 * 排课验证规则
 * @description 排课创建、更新、查询的Joi验证规则
 * @module validators/schedule
 */

const Joi = require('joi');

// 日期格式正则
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// 时间格式正则 (HH:MM)
const TIME_PATTERN = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;

// 创建排课验证
const createSchema = Joi.object({
    teacherId: Joi.number().integer().positive().required()
        .messages({
            'number.base': '教师ID必须是数字',
            'number.positive': '教师ID必须是正数',
            'any.required': '教师ID是必填项'
        }),
    studentIds: Joi.array().items(Joi.number().integer().positive()).min(1).required()
        .messages({
            'array.base': '学生ID列表必须是数组',
            'array.min': '至少需要选择一个学生',
            'any.required': '学生ID列表是必填项'
        }),
    date: Joi.string().pattern(DATE_PATTERN).required()
        .messages({
            'string.pattern.base': '日期格式不正确，应为 YYYY-MM-DD',
            'any.required': '日期是必填项'
        }),
    startTime: Joi.string().pattern(TIME_PATTERN).required()
        .messages({
            'string.pattern.base': '开始时间格式不正确，应为 HH:MM',
            'any.required': '开始时间是必填项'
        }),
    endTime: Joi.string().pattern(TIME_PATTERN).required()
        .messages({
            'string.pattern.base': '结束时间格式不正确，应为 HH:MM',
            'any.required': '结束时间是必填项'
        }),
    timeSlot: Joi.string().valid('morning', 'afternoon', 'evening').default('morning')
        .messages({
            'any.only': '时段只能是 morning、afternoon 或 evening'
        }),
    location: Joi.string().max(100).allow('', null)
        .messages({
            'string.max': '地点长度不能超过100个字符'
        }),
    scheduleTypes: Joi.array().items(Joi.number().integer().positive()).min(1).required()
        .messages({
            'array.base': '课程类型ID列表必须是数组',
            'array.min': '至少需要选择一个课程类型',
            'any.required': '课程类型ID列表是必填项'
        }),
    status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed').optional()
        .messages({
            'any.only': '状态只能是 pending、confirmed、cancelled 或 completed'
        }),
    notes: Joi.string().max(500).allow('', null)
        .messages({
            'string.max': '备注长度不能超过500个字符'
        }),
    resolveStrategy: Joi.string().valid('merge', 'override').optional()
})
    // 兼容 snake_case 输入
    .rename('teacher_id', 'teacherId', { override: true, ignoreUndefined: true })
    .rename('student_ids', 'studentIds', { override: true, ignoreUndefined: true })
    .rename('start_time', 'startTime', { override: true, ignoreUndefined: true })
    .rename('end_time', 'endTime', { override: true, ignoreUndefined: true })
    .rename('time_slot', 'timeSlot', { override: true, ignoreUndefined: true })
    .rename('type_ids', 'scheduleTypes', { override: true, ignoreUndefined: true })
    .rename('schedule_types', 'scheduleTypes', { override: true, ignoreUndefined: true })
    .rename('resolve_strategy', 'resolveStrategy', { override: true, ignoreUndefined: true });

// 更新排课验证
const updateSchema = Joi.object({
    teacherId: Joi.number().integer().positive(),
    studentIds: Joi.array().items(Joi.number().integer().positive()).min(1),
    date: Joi.string().pattern(DATE_PATTERN),
    startTime: Joi.string().pattern(TIME_PATTERN),
    endTime: Joi.string().pattern(TIME_PATTERN),
    timeSlot: Joi.string().valid('morning', 'afternoon', 'evening'),
    location: Joi.string().max(100).allow('', null),
    scheduleTypes: Joi.array().items(Joi.number().integer().positive()).min(1),
    status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed'),
    notes: Joi.string().max(500).allow('', null)
})
    .rename('teacher_id', 'teacherId', { override: true, ignoreUndefined: true })
    .rename('student_ids', 'studentIds', { override: true, ignoreUndefined: true })
    .rename('start_time', 'startTime', { override: true, ignoreUndefined: true })
    .rename('end_time', 'endTime', { override: true, ignoreUndefined: true })
    .rename('time_slot', 'timeSlot', { override: true, ignoreUndefined: true })
    .rename('type_ids', 'scheduleTypes', { override: true, ignoreUndefined: true })
    .rename('schedule_types', 'scheduleTypes', { override: true, ignoreUndefined: true });

// 查询排课验证
const querySchema = Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    startDate: Joi.date().iso(),
    endDate: Joi.date().iso().min(Joi.ref('startDate')),
    teacherId: Joi.number().integer().positive(),
    studentId: Joi.number().integer().positive(),
    typeId: Joi.number().integer().positive(),
    status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed'),
    sortBy: Joi.string().valid('date', 'created_at').default('date'),
    sortOrder: Joi.string().valid('asc', 'desc').default('asc')
})
    .rename('start_date', 'startDate', { override: true, ignoreUndefined: true })
    .rename('end_date', 'endDate', { override: true, ignoreUndefined: true })
    .rename('teacher_id', 'teacherId', { override: true, ignoreUndefined: true })
    .rename('student_id', 'studentId', { override: true, ignoreUndefined: true })
    .rename('type_id', 'typeId', { override: true, ignoreUndefined: true })
    .rename('sort_by', 'sortBy', { override: true, ignoreUndefined: true })
    .rename('sort_order', 'sortOrder', { override: true, ignoreUndefined: true });

// 批量状态更新验证
const batchStatusSchema = Joi.object({
    ids: Joi.array().items(Joi.number().integer().positive()).min(1).required()
        .messages({
            'array.min': '至少需要选择一个排课',
            'any.required': 'ID列表是必填项'
        }),
    status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed').required()
        .messages({
            'any.only': '状态只能是 pending、confirmed、cancelled 或 completed',
            'any.required': '状态是必填项'
        })
});

module.exports = {
    createSchema,
    updateSchema,
    querySchema,
    batchStatusSchema
};
