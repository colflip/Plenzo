const Joi = require('joi');

// 标准化响应格式
const standardResponse = (success, data = null, message = '', errors = null) => {
    return {
        success,
        data,
        message,
        errors,
        timestamp: new Date().toISOString()
    };
};

// 通用验证中间件
const validate = (schema, property = 'body') => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req[property], {
            abortEarly: false,
            allowUnknown: false,
            stripUnknown: true
        });

        if (error) {
            const errors = error.details.map(detail => ({
                field: detail.path.join('.'),
                message: detail.message,
                value: detail.context.value
            }));

            return res.status(400).json(
                standardResponse(false, null, '数据验证失败', errors)
            );
        }

        req[property] = value;
        next();
    };
};

// 排课数据验证规则
const scheduleValidation = {
    create: Joi.object({
        // 统一使用 camelCase 字段，兼容并重命名 snake_case
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
        date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
            .messages({
                'string.pattern.base': '日期格式不正确，应为YYYY-MM-DD',
                'any.required': '日期是必填项'
            }),
        timeSlot: Joi.string().valid('morning', 'afternoon', 'evening').default('morning')
            .messages({
                'any.only': '时段只能是morning、afternoon或evening'
            }),
        startTime: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).required()
            .messages({
                'string.pattern.base': '开始时间格式不正确，应为HH:MM',
                'any.required': '开始时间是必填项'
            }),
        endTime: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/).required()
            .messages({
                'string.pattern.base': '结束时间格式不正确，应为HH:MM',
                'any.required': '结束时间是必填项'
            }),
        location: Joi.string().min(1).max(100).allow('', null)
            .messages({
                'string.min': '地点不能为空',
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
                'any.only': '状态只能是pending、confirmed、cancelled或completed'
            }),
        notes: Joi.string().max(500).allow('', null)
            .messages({
                'string.max': '备注长度不能超过500个字符'
            }),
        // 允许前端传递冲突解决策略（merge/override），以免被stripUnknown过滤掉
        resolve_strategy: Joi.string().valid('merge', 'override').optional()
    })
    // 支持 snake_case 输入并重命名为 camelCase
    .rename('teacher_id', 'teacherId', { override: true, ignoreUndefined: true })
    .rename('student_ids', 'studentIds', { override: true, ignoreUndefined: true })
    .rename('start_time', 'startTime', { override: true, ignoreUndefined: true })
    .rename('end_time', 'endTime', { override: true, ignoreUndefined: true })
    .rename('type_ids', 'scheduleTypes', { override: true, ignoreUndefined: true })
    .rename('time_slot', 'timeSlot', { override: true, ignoreUndefined: true }),

    update: Joi.object({
        teacher_id: Joi.number().integer().positive()
            .messages({
                'number.base': '教师ID必须是数字',
                'number.positive': '教师ID必须是正数'
            }),
        student_ids: Joi.array().items(Joi.number().integer().positive()).min(1)
            .messages({
                'array.base': '学生ID列表必须是数组',
                'array.min': '至少需要选择一个学生'
            }),
        // 与创建接口保持一致：允许更新过去日期记录，仅校验格式
        date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/)
            .messages({
                'string.pattern.base': '日期格式不正确，应为YYYY-MM-DD'
            }),
        start_time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
            .messages({
                'string.pattern.base': '开始时间格式不正确，应为HH:MM'
            }),
        end_time: Joi.string().pattern(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
            .messages({
                'string.pattern.base': '结束时间格式不正确，应为HH:MM'
            }),
        location: Joi.string().min(1).max(100)
            .messages({
                'string.min': '地点不能为空',
                'string.max': '地点长度不能超过100个字符'
            }),
        type_ids: Joi.array().items(Joi.number().integer().positive()).min(1)
            .messages({
                'array.base': '课程类型ID列表必须是数组',
                'array.min': '至少需要选择一个课程类型'
            }),
        notes: Joi.string().max(500).allow('', null)
            .messages({
                'string.max': '备注长度不能超过500个字符'
            }),
        status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed')
            .messages({
                'any.only': '状态只能是pending、confirmed、cancelled或completed'
            })
    }),

    query: Joi.object({
        page: Joi.number().integer().min(1).default(1)
            .messages({
                'number.base': '页码必须是数字',
                'number.min': '页码必须大于0'
            }),
        limit: Joi.number().integer().min(1).max(100).default(20)
            .messages({
                'number.base': '每页数量必须是数字',
                'number.min': '每页数量必须大于0',
                'number.max': '每页数量不能超过100'
            }),
        start_date: Joi.date().iso()
            .messages({
                'date.base': '开始日期格式不正确'
            }),
        end_date: Joi.date().iso().min(Joi.ref('start_date'))
            .messages({
                'date.base': '结束日期格式不正确',
                'date.min': '结束日期不能早于开始日期'
            }),
        teacher_id: Joi.number().integer().positive()
            .messages({
                'number.base': '教师ID必须是数字',
                'number.positive': '教师ID必须是正数'
            }),
        student_id: Joi.number().integer().positive()
            .messages({
                'number.base': '学生ID必须是数字',
                'number.positive': '学生ID必须是正数'
            }),
        status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed')
            .messages({
                'any.only': '状态只能是pending、confirmed、cancelled或completed'
            }),
        type_id: Joi.number().integer().positive()
            .messages({
                'number.base': '课程类型ID必须是数字',
                'number.positive': '课程类型ID必须是正数'
            })
    })
};

// 用户数据验证规则
const userValidation = {
    create: Joi.object({
        username: Joi.string().alphanum().min(3).max(30).required()
            .messages({
                'string.alphanum': '用户名只能包含字母和数字',
                'string.min': '用户名长度至少3个字符',
                'string.max': '用户名长度不能超过30个字符',
                'any.required': '用户名是必填项'
            }),
        password: Joi.string().min(6).max(100).required()
            .messages({
                'string.min': '密码长度至少6个字符',
                'string.max': '密码长度不能超过100个字符',
                'any.required': '密码是必填项'
            }),
        name: Joi.string().min(1).max(50).required()
            .messages({
                'string.min': '姓名不能为空',
                'string.max': '姓名长度不能超过50个字符',
                'any.required': '姓名是必填项'
            }),
        // 与后端控制器对齐，使用 userType 而不是 role
        userType: Joi.string().valid('admin', 'teacher', 'student').required()
            .messages({
                'any.only': '用户类型只能是admin、teacher或student',
                'any.required': '用户类型是必填项'
            }),
        // 管理员必填邮箱，其他类型可选
        email: Joi.string().email().max(100)
            .when('userType', { is: 'admin', then: Joi.required() })
            .messages({
                'string.email': '邮箱格式不正确',
                'string.max': '邮箱长度不能超过100个字符',
                'any.required': '邮箱是必填项'
            }),
        // 新增：教师/学生的状态字段（-1 删除，0 暂停，1 正常）
        status: Joi.number().integer().valid(-1, 0, 1)
            .messages({
                'number.base': '状态必须是整数',
                'any.only': '状态只能是-1(删除)、0(暂停)、1(正常)'
            }),
        // 管理员必填且范围为1-3
        permission_level: Joi.number().integer().min(1).max(3)
            .when('userType', { is: 'admin', then: Joi.required() })
            .messages({
                'number.base': '权限级别必须是数字',
                'number.integer': '权限级别必须为整数',
                'number.min': '权限级别不能小于1',
                'number.max': '权限级别不能大于3',
                'any.required': '权限级别是必填项'
            }),
        // 教师/学生可选扩展字段（与控制器允许的字段保持一致）
        profession: Joi.string().max(100)
            .messages({ 'string.max': '职业类型长度不能超过100个字符' }),
        contact: Joi.string().max(100)
            .messages({ 'string.max': '联系方式长度不能超过100个字符' }),
        work_location: Joi.string().max(100)
            .messages({ 'string.max': '工作地点长度不能超过100个字符' }),
        home_address: Joi.string().max(200)
            .messages({ 'string.max': '家庭地址长度不能超过200个字符' }),
        visit_location: Joi.string().max(100)
            .messages({ 'string.max': '入户地点长度不能超过100个字符' })
    })
    // 兼容旧客户端：如果传入 role 则重命名为 userType
    .rename('role', 'userType', { override: true, ignoreUndefined: true }),

    update: Joi.object({
        username: Joi.string().alphanum().min(3).max(30)
            .messages({
                'string.alphanum': '用户名只能包含字母和数字',
                'string.min': '用户名长度至少3个字符',
                'string.max': '用户名长度不能超过30个字符'
            }),
        name: Joi.string().min(1).max(50)
            .messages({
                'string.min': '姓名不能为空',
                'string.max': '姓名长度不能超过50个字符'
            }),
        email: Joi.string().email().max(100)
            .messages({
                'string.email': '邮箱格式不正确',
                'string.max': '邮箱长度不能超过100个字符'
            }),
        password: Joi.string().min(6).max(100)
            .messages({
                'string.min': '密码长度至少6个字符',
                'string.max': '密码长度不能超过100个字符'
            }),
        // 与控制器允许的可更新字段保持一致
        permission_level: Joi.number().integer().min(1).max(3)
            .messages({
                'number.base': '权限级别必须是数字',
                'number.integer': '权限级别必须为整数',
                'number.min': '权限级别不能小于1',
                'number.max': '权限级别不能大于3'
            }),
        profession: Joi.string().max(100)
            .messages({ 'string.max': '职业类型长度不能超过100个字符' }),
        contact: Joi.string().max(100)
            .messages({ 'string.max': '联系方式长度不能超过100个字符' }),
        work_location: Joi.string().max(100)
            .messages({ 'string.max': '工作地点长度不能超过100个字符' }),
        home_address: Joi.string().max(200)
            .messages({ 'string.max': '家庭地址长度不能超过200个字符' }),
        visit_location: Joi.string().max(100)
            .messages({ 'string.max': '入户地点长度不能超过100个字符' })
        ,
        // 新增：教师/学生的状态字段（-1 删除，0 暂停，1 正常）
        status: Joi.number().integer().valid(-1, 0, 1)
            .messages({
                'number.base': '状态必须是整数',
                'any.only': '状态只能是-1(删除)、0(暂停)、1(正常)'
            })
    }),

    login: Joi.object({
        username: Joi.string().required()
            .messages({
                'any.required': '用户名是必填项'
            }),
        password: Joi.string().required()
            .messages({
                'any.required': '密码是必填项'
            })
    })
};

// 错误处理中间件
const errorHandler = (err, req, res, next) => {
    console.error('Error:', err);

    // 数据库错误
    if (err.code) {
        switch (err.code) {
            case '23505': // 唯一约束违反
                return res.status(409).json(
                    standardResponse(false, null, '数据已存在，请检查唯一性约束')
                );
            case '23503': // 外键约束违反
                return res.status(400).json(
                    standardResponse(false, null, '关联数据不存在')
                );
            case '23502': // 非空约束违反
                return res.status(400).json(
                    standardResponse(false, null, '必填字段不能为空')
                );
            default:
                return res.status(500).json(
                    standardResponse(false, null, '数据库操作失败')
                );
        }
    }

    // 默认服务器错误
    res.status(500).json(
        standardResponse(false, null, '服务器内部错误')
    );
};

module.exports = {
    validate,
    standardResponse,
    scheduleValidation,
    userValidation,
    errorHandler
};
