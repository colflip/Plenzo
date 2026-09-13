const Joi = require('joi');
const { FEE_STATUSES } = require('../utils/fee-status');

// 标准化响应格式（单一来源见 utils/response.js）
const { standardResponse } = require('../utils/response');
const { AppError } = require('./error');

// 通用验证中间件
const validate = (schema, property = 'body') => {
    return (req, res, next) => {
        const { error, value } = schema.validate(req[property], {
            abortEarly: false,
            allowUnknown: false,
            stripUnknown: true
        });

        if (error) {
            const details = error.details.map(detail => ({
                path: `${property}.${detail.path.join('.')}`,
                message: detail.message
                // 不回显 value，防止泄露密码等敏感输入
            }));

            return next(new AppError({
                code: 'VALIDATION_FAILED',
                statusCode: 422,
                message: '参数验证失败',
                details
            }));
        }

        req[property] = value;
        next();
    };
};

// 排课数据验证规则
const scheduleValidation = {
    create: Joi.object({
        // 统一使用 camelCase 字段，兼容并重命名 snake_case
        // 旧形状（单师 + 学生列表）仍然放行，服务层会归一成 pair 数组；
        // 新形状请用下方的 teachers / students。二者至少给一组（服务层校验并给出 400）。
        teacherId: Joi.number().integer().positive()
            .messages({
                'number.base': '教师ID必须是数字',
                'number.positive': '教师ID必须是正数'
            }),
        teacherIds: Joi.array().items(Joi.number().integer().positive()).min(1).optional(),
        studentIds: Joi.array().items(Joi.number().integer().positive()).min(1)
            .messages({
                'array.base': '学生ID列表必须是数组',
                'array.min': '至少需要选择一个学生'
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
        location: Joi.string().max(100).allow('', null)
            .messages({
                'string.max': '地点长度不能超过100个字符'
            }),
        scheduleTypes: Joi.array().items(Joi.number().integer().positive()).min(1)
            .messages({
                'array.base': '课程类型ID列表必须是数组',
                'array.min': '至少需要选择一个课程类型'
            }),
        status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed', 'modified_away').optional()
            .messages({
                'any.only': '状态只能是pending、confirmed、cancelled、completed或modified_away'
            }),
        notes: Joi.string().max(500).allow('', null)
            .messages({
                'string.max': '备注长度不能超过500个字符'
            }),
        // 允许前端传递冲突解决策略（merge/override），以免被stripUnknown过滤掉
        resolve_strategy: Joi.string().valid('merge', 'override').optional(),
        family_participants: Joi.number().integer().min(0).max(5).optional(),
        // ---- 一场一行的新形状：教师 / 学生各一个 pair 数组 ----
        // 服务端生成 uid、并从 actor.id 填每个 pair 的 created_by，
        // 所以这里**不放行** uid / created_by（旧的 is_temp、adjustment_type 两个键
        // 一并删除 —— 它们名字错位正是「新建时勾临时加课不生效」那个 bug 的温床）。
        teachers: Joi.array().items(Joi.object({
            teacher_id: Joi.number().integer().positive().required(),
            type_id: Joi.number().integer().positive().required(),
            // adjusted 不放行：类别位只有「作废+增补」流程能写
            category: Joi.string().valid('normal', 'temp').default('normal'),
            lifecycle: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled', 'modified_away').default('pending'),
            teacher_rating: Joi.number().integer().min(1).max(5).allow(null),
            teacher_comment: Joi.string().max(500).allow('', null),
            transport_fee: Joi.number().min(0).allow(null),
            other_fee: Joi.number().min(0).allow(null)
        })).min(1).optional(),
        students: Joi.array().items(Joi.object({
            student_id: Joi.number().integer().positive().required(),
            family_participants: Joi.number().integer().min(0).max(5).default(4),
            student_rating: Joi.number().integer().min(1).max(5).allow(null),
            student_comment: Joi.string().max(500).allow('', null)
        })).min(1).optional()
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
        location: Joi.string().max(100).allow('', null)
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
        status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed', 'modified_away')
            .messages({
                'any.only': '状态只能是pending、confirmed、cancelled、completed或modified_away'
            }),
        // pair 定位：改哪一位教师 / 学生（本场只有一位时可省略）
        teacher_uid: Joi.string().max(32).optional(),
        student_uid: Joi.string().max(32).optional(),
        // 生命周期单独一个键（与 status 同义，二者取其一）
        lifecycle: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed', 'modified_away').optional(),
        type_id: Joi.number().integer().positive().optional(),
        // 换人 / 改类别：单 pair 提交路径（批量路径走 teachers[] / students[] 里的同名键）
        student_id: Joi.number().integer().positive().optional(),
        category: Joi.string().valid('normal', 'temp').optional()
            .messages({ 'any.only': '类别只能是normal或temp' }),
        teacher_rating: Joi.number().integer().min(1).max(5).allow(null),
        teacher_comment: Joi.string().max(500).allow('', null),
        transport_fee: Joi.number().min(0).allow(null),
        other_fee: Joi.number().min(0).allow(null),
        family_participants: Joi.number().integer().min(0).max(5).optional(),
        // 乐观锁：整列写（改 pair 内容 / 增删 pair）必带；状态路径不需要
        version: Joi.number().integer().min(0).optional(),
        // ---- 编辑保存一次提交整场（前端不再逐 pair 串行发请求）----
        // 每个元素要么带 uid（服务端 patch 对应 pair），要么不带 uid（服务端 addPair 新增）
        teachers: Joi.array().items(Joi.object({
            uid: Joi.string().max(32).optional(),
            teacher_id: Joi.number().integer().positive().optional(),
            type_id: Joi.number().integer().positive().optional(),
            category: Joi.string().valid('normal', 'temp').optional(),
            lifecycle: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled', 'modified_away').optional(),
            teacher_rating: Joi.number().integer().min(1).max(5).allow(null),
            teacher_comment: Joi.string().max(500).allow('', null),
            transport_fee: Joi.number().min(0).allow(null),
            other_fee: Joi.number().min(0).allow(null)
        })).optional(),
        students: Joi.array().items(Joi.object({
            uid: Joi.string().max(32).optional(),
            student_id: Joi.number().integer().positive().optional(),
            family_participants: Joi.number().integer().min(0).max(5).optional(),
            student_rating: Joi.number().integer().min(1).max(5).allow(null),
            student_comment: Joi.string().max(500).allow('', null)
        })).optional()
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
        // 前端费用导出（报销单）以 camelCase 传递日期；放行以免被 stripUnknown 丢弃导致日期过滤失效。
        // 用 string 而非常规 date()，避免 Joi 把 'YYYY-MM-DD' 强转成 Date 对象后，pg 绑定成 timestamp 导致 BETWEEN 末日丢失。
        startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional()
            .messages({ 'string.pattern.base': '开始日期格式不正确，应为YYYY-MM-DD' }),
        endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional()
            .messages({ 'string.pattern.base': '结束日期格式不正确，应为YYYY-MM-DD' }),
        // 报销单/全部安排视图需带回“已调整原课程”(status=modified_away AND adjustment_type=0)，放行以免被剥离
        show_plan: Joi.boolean().optional(),
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
        status: Joi.string().valid('pending', 'confirmed', 'cancelled', 'completed', 'modified_away')
            .messages({
                'any.only': '状态只能是pending、confirmed、cancelled、completed或modified_away'
            }),
        type_id: Joi.number().integer().positive()
            .messages({
                'number.base': '课程类型ID必须是数字',
                'number.positive': '课程类型ID必须是正数'
            }),
        fee_status: Joi.string().valid('draft', 'teacher_submitted', 'admin_submitted', 'reimbursed', 'returned', 'reimbursement_returned')
            .optional()
            .messages({
                'any.only': '费用状态非法'
            })
    })
};

// 用户数据验证规则
const userValidation = {
    create: Joi.object({
        username: Joi.string().pattern(/^[a-zA-Z0-9_]+$/).min(3).max(30).required()
            .messages({
                'string.pattern.base': '用户名只能包含字母、数字和下划线',
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
            .messages({ 'string.max': '入户地点长度不能超过100个字符' }),
        nickname: Joi.string().max(50).allow('', null).optional()
            .messages({ 'string.max': '昵称长度不能超过50个字符' }),
        // 创建时指定 ID（仅 L1 前端可达；服务层做占用检查）
        id: Joi.number().integer().positive().optional()
            .messages({
                'number.base': 'ID必须是数字',
                'number.integer': 'ID必须为整数',
                'number.positive': 'ID必须为正数'
            }),
        // 教师创建时可指定：排课限制级别、关联学生ID列表（与 update schema 保持一致）
        restriction: Joi.number().integer().min(0).max(5)
            .messages({
                'number.base': '排课限制必须是数字',
                'number.integer': '排课限制必须为整数',
                'number.min': '排课限制不能小于0',
                'number.max': '排课限制不能大于5'
            }),
        student_ids: Joi.string().max(500).allow('', null)
            .messages({ 'string.max': '关联学生ID列表过长' })
    })
        // 兼容旧客户端：如果传入 role 则重命名为 userType
        .rename('role', 'userType', { override: true, ignoreUndefined: true }),

    update: Joi.object({
        username: Joi.string().pattern(/^[a-zA-Z0-9_]+$/).min(3).max(30)
            .messages({
                'string.pattern.base': '用户名只能包含字母、数字和下划线',
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
        profession: Joi.string().max(100).allow('', null)
            .messages({ 'string.max': '职业类型长度不能超过100个字符' }),
        contact: Joi.string().max(100).allow('', null)
            .messages({ 'string.max': '联系方式长度不能超过100个字符' }),
        work_location: Joi.string().max(100).allow('', null)
            .messages({ 'string.max': '工作地点长度不能超过100个字符' }),
        home_address: Joi.string().max(200).allow('', null)
            .messages({ 'string.max': '家庭地址长度不能超过200个字符' }),
        visit_location: Joi.string().max(100).allow('', null)
            .messages({ 'string.max': '入户地点长度不能超过100个字符' }),
        // 教师/学生的状态字段（-1 删除，0 暂停，1 正常）
        status: Joi.number().integer().valid(-1, 0, 1)
            .messages({
                'number.base': '状态必须是整数',
                'any.only': '状态只能是-1(删除)、0(暂停)、1(正常)'
            }),
        // 教师专用：关联学生ID列表（逗号分隔字符串）
        student_ids: Joi.string().max(500).allow('', null)
            .messages({ 'string.max': '关联学生ID列表过长' }),
        // 教师专用：排课限制级别
        restriction: Joi.number().integer().min(0).max(5)
            .messages({
                'number.base': '排课限制必须是数字',
                'number.integer': '排课限制必须为整数',
                'number.min': '排课限制不能小于0',
                'number.max': '排课限制不能大于5'
            }),
        // 昵称（所有角色可选）
        nickname: Joi.string().max(50).allow('', null).optional()
            .messages({ 'string.max': '昵称长度不能超过50个字符' }),
        // 修改用户ID时使用
        new_id: Joi.number().integer().positive()
            .messages({
                'number.base': '新ID必须是数字',
                'number.integer': '新ID必须为整数',
                'number.positive': '新ID必须为正数'
            }),
        // 前端传入的用户类型标识（仅用于内部逻辑，不做强制校验）
        userType: Joi.string().valid('admin', 'teacher', 'student').optional()
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

// 改密码验证规则（教师/学生端 changePassword 实际读取 currentPassword / newPassword）
const passwordChangeValidation = Joi.object({
    currentPassword: Joi.string().required()
        .messages({
            'any.required': '当前密码不能为空',
            'string.base': '当前密码格式不正确'
        }),
    newPassword: Joi.string().min(6).max(100).required()
        .messages({
            'string.min': '新密码长度不能少于6位',
            'string.max': '新密码长度不能超过100个字符',
            'any.required': '新密码不能为空'
        })
});

// 教师资料更新验证（前端全量提交：name 必填非空，其余可选可空，status 限定 -1/0/1）
// 所有控制器无条件写入的字段均在此声明，避免 validate 的 stripUnknown 剥离后写 undefined 清空列。
const teacherProfileValidation = Joi.object({
    name: Joi.string().min(1).max(50).required()
        .messages({
            'string.min': '姓名不能为空',
            'string.max': '姓名长度不能超过50个字符',
            'any.required': '姓名是必填项'
        }),
    nickname: Joi.string().max(50).allow('', null).optional()
        .messages({ 'string.max': '昵称长度不能超过50个字符' }),
    profession: Joi.string().max(100).allow('', null).optional()
        .messages({ 'string.max': '职业类型长度不能超过100个字符' }),
    contact: Joi.string().max(100).allow('', null).optional()
        .messages({ 'string.max': '联系方式长度不能超过100个字符' }),
    work_location: Joi.string().max(100).allow('', null).optional()
        .messages({ 'string.max': '工作地点长度不能超过100个字符' }),
    home_address: Joi.string().max(200).allow('', null).optional()
        .messages({ 'string.max': '家庭地址长度不能超过200个字符' }),
    status: Joi.number().integer().valid(-1, 0, 1).optional()
        .messages({
            'number.base': '状态必须是整数',
            'any.only': '状态只能是-1(删除)、0(暂停)、1(正常)'
        })
});

// 学生资料更新验证（前端全量提交，不含 status 字段）
const studentProfileValidation = Joi.object({
    name: Joi.string().min(1).max(50).required()
        .messages({
            'string.min': '姓名不能为空',
            'string.max': '姓名长度不能超过50个字符',
            'any.required': '姓名是必填项'
        }),
    nickname: Joi.string().max(50).allow('', null).optional()
        .messages({ 'string.max': '昵称长度不能超过50个字符' }),
    profession: Joi.string().max(100).allow('', null).optional()
        .messages({ 'string.max': '职业类型长度不能超过100个字符' }),
    contact: Joi.string().max(100).allow('', null).optional()
        .messages({ 'string.max': '联系方式长度不能超过100个字符' }),
    visit_location: Joi.string().max(100).allow('', null).optional()
        .messages({ 'string.max': '入户地点长度不能超过100个字符' }),
    home_address: Joi.string().max(200).allow('', null).optional()
        .messages({ 'string.max': '家庭地址长度不能超过200个字符' })
});

// 费用金额字段：容错 number / 数字字符串 / null / ''（空值=未填 NULL）；负数由控制器 parseFee + 负数检查拒。
// 控制器对 transport_fee/other_fee 用 parseFloat 处理，schema 只需确保「非空非空串则可解析为数字」即可，不过度收紧以免破坏前端数字字符串。
const feeAmount = Joi.any().custom((value, helpers) => {
    if (value === null || value === undefined || value === '') return value;
    const n = parseFloat(value);
    if (Number.isNaN(n)) return helpers.error('any.invalid');
    return value;
}).optional();

// 费用更新（admin/teacher 共用 updateScheduleFees）：仅 transport_fee / other_fee 两个金额字段
const feeUpdateValidation = Joi.object({
    transport_fee: feeAmount,
    other_fee: feeAmount,
    // 费用挂在教师 pair 上：路径未带 :uid 时用它定位（本场只有一位教师时可省略）
    teacher_uid: Joi.string().max(32).optional()
});

// 单条费用报销状态更新（admin/teacher 共用 updateScheduleFeeStatus）
const feeStatusUpdateValidation = Joi.object({
    fee_status: Joi.string().valid(...FEE_STATUSES).required()
        .messages({
            'any.only': '非法的费用报销状态',
            'any.required': '缺少目标状态'
        }),
    note: Joi.string().max(500).allow('', null).optional()
        .messages({ 'string.max': '备注长度不能超过500个字符' }),
    teacher_uid: Joi.string().max(32).optional()
});

// 批量费用报销状态更新（admin/teacher 共用 batchUpdateScheduleFeeStatus）
const feeStatusBatchValidation = Joi.object({
    fee_status: Joi.string().valid(...FEE_STATUSES).required()
        .messages({
            'any.only': '非法的费用报销状态',
            'any.required': '缺少目标状态'
        }),
    // ids 支持两种写法：裸场次 id（覆盖本场全部教师 pair），或 { session_id, teacher_uid } 精确到 pair
    ids: Joi.array().items(Joi.alternatives().try(
        Joi.number().integer(),
        Joi.object({
            session_id: Joi.number().integer().positive().required(),
            teacher_uid: Joi.string().max(32).allow(null).optional()
        })
    )).optional(),
    scope: Joi.object({
        startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
            .messages({ 'string.pattern.base': '开始日期格式应为YYYY-MM-DD' }),
        endDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
            .messages({ 'string.pattern.base': '结束日期格式应为YYYY-MM-DD' }),
        fee_status: Joi.string().valid(...FEE_STATUSES).optional()
            .messages({ 'any.only': '非法的费用报销状态' })
    }).optional(),
    note: Joi.string().max(500).allow('', null).optional()
        .messages({ 'string.max': '备注长度不能超过500个字符' }),
    skipStatus: Joi.string().valid(...FEE_STATUSES).allow(null, '').optional()
        .messages({ 'any.only': '非法的费用报销状态' })
});

// 教师批量费用更新（teacher batch-fees）：updates 数组，每项 { id, transport_fee, other_fee }
const feeBatchValidation = Joi.object({
    updates: Joi.array().items(
        Joi.object({
            // id 与 session_id 同义（历史前端传 id），二者取其一
            id: Joi.number().integer().positive()
                .messages({
                    'number.base': '排课ID必须是数字',
                    'number.positive': '排课ID必须是正数'
                }),
            session_id: Joi.number().integer().positive(),
            teacher_uid: Joi.string().max(32).optional(),
            transport_fee: feeAmount,
            other_fee: feeAmount
        }).or('id', 'session_id').messages({ 'object.missing': '缺少排课ID' })
    ).min(1).required()
        .messages({
            'array.min': '无可更新内容',
            'any.required': '缺少 updates 列表'
        })
});

// 课程类型创建/更新（admin schedule-types）：name 必填，description 可选
const scheduleTypeValidation = Joi.object({
    name: Joi.string().min(1).max(50).required()
        .messages({
            'string.min': '课程类型名称不能为空',
            'string.max': '名称长度不能超过50个字符',
            'any.required': '课程类型名称不能为空'
        }),
    description: Joi.string().max(200).allow('', null).optional()
        .messages({ 'string.max': '描述长度不能超过200个字符' })
});

// 节假日创建/更新（admin holidays）：year/type/label/start_date/end_date 全部必填
const holidayValidation = Joi.object({
    year: Joi.number().integer().min(2000).max(2100).required()
        .messages({
            'number.base': '年份必须是数字',
            'number.integer': '年份必须是整数',
            'any.required': '年份不能为空'
        }),
    type: Joi.string().max(20).required()
        .messages({ 'any.required': '类型不能为空', 'string.max': '类型长度不能超过20个字符' }),
    label: Joi.string().max(50).required()
        .messages({ 'any.required': '名称不能为空', 'string.max': '名称长度不能超过50个字符' }),
    start_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
        .messages({ 'string.pattern.base': '开始日期格式应为YYYY-MM-DD', 'any.required': '开始日期不能为空' }),
    end_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
        .messages({ 'string.pattern.base': '结束日期格式应为YYYY-MM-DD', 'any.required': '结束日期不能为空' })
});

// 节假日批量同步（admin holidays/batch）：items 数组，每项同 holiday 字段
const holidayBatchValidation = Joi.object({
    items: Joi.array().items(
        Joi.object({
            year: Joi.number().integer().min(2000).max(2100).required(),
            type: Joi.string().max(20).required(),
            label: Joi.string().max(50).required(),
            start_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
            end_date: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required()
        })
    ).min(1).required()
        .messages({ 'array.min': '同步数据不能为空', 'any.required': '缺少 items' }),
    // syncHolidaysFromAPI 的 years 可选；此处复用 batch 路由不传 years，仅校验 items
});

// 从第三方 API 同步节假日（admin holidays/sync）：years 可选数组
const holidaySyncValidation = Joi.object({
    years: Joi.array().items(Joi.number().integer().min(2000).max(2100)).optional()
}).unknown(true);

// 反馈创建（admin /feedbacks）：type 必填枚举、description 必填非空，priority/title 可选
const feedbackCreateValidation = Joi.object({
    type: Joi.string().valid('feature', 'bug', 'request', 'other').required()
        .messages({ 'any.only': '反馈类型无效', 'any.required': '缺少反馈类型' }),
    priority: Joi.string().valid('high', 'medium', 'low').optional()
        .messages({ 'any.only': '无效的优先级' }),
    title: Joi.string().max(120).allow('', null).optional()
        .messages({ 'string.max': '标题长度不能超过120个字符' }),
    description: Joi.string().min(1).required()
        .messages({ 'string.min': '请填写详细描述', 'any.required': '请填写详细描述' })
});

// 反馈更新（admin /feedbacks/:id）：type/priority/status 枚举可选，description 允许空串（保留原值），全部缺省时由控制器回退原行
const feedbackUpdateValidation = Joi.object({
    type: Joi.string().valid('feature', 'bug', 'request', 'other').optional()
        .messages({ 'any.only': '反馈类型无效' }),
    priority: Joi.string().valid('high', 'medium', 'low').optional()
        .messages({ 'any.only': '无效的优先级' }),
    title: Joi.string().max(120).allow('', null).optional()
        .messages({ 'string.max': '标题长度不能超过120个字符' }),
    description: Joi.string().allow('', null).optional()
        .messages({ 'string.base': '描述格式不正确' }),
    status: Joi.string().valid('open', 'in_progress', 'done', 'rejected').optional()
        .messages({ 'any.only': '无效的反馈状态' })
});

// 管理员确认排课（admin POST /schedules/:id/confirm）：adminConfirmed 布尔可选
// teacher_uid 指明确认哪一位教师；缺省则确认本场全部教师 pair
const adminConfirmValidation = Joi.object({
    adminConfirmed: Joi.boolean().optional(),
    teacher_uid: Joi.string().max(32).optional(),
    notes: Joi.string().allow('', null).max(500).optional()
});

// 教师确认排课（teacher POST /schedules/:id/confirm）：teacherConfirmed 布尔可选、notes 可选
const teacherConfirmValidation = Joi.object({
    teacherConfirmed: Joi.boolean().optional(),
    teacher_uid: Joi.string().max(32).optional(),
    notes: Joi.string().allow('', null).max(500).optional()
        .messages({ 'string.max': '备注长度不能超过500个字符' })
});

/**
 * 教师 / 班主任切换某位教师 pair 的生命周期位。
 *
 * 三点比旧 schema 更严：
 * - **没有 category** —— 类别是溯源属性，任何身份的状态切换都只能动生命周期位；
 *   服务端 SQL 里也确实只替换后缀（`split_part(status,'.',1) || '.' || $3`）。
 * - **不带 version** —— 按 uid 原地重建不存在丢失更新问题（闸门 B 已实测）。
 * - `notes` 是这次流转的备注，写进 session_status_logs.note，不是场次头部的 notes。
 */
const teacherPairStatusValidation = Joi.object({
    // status 与 lifecycle 同义（前端历史上传 status），二者取其一
    status: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled').optional()
        .messages({ 'any.only': '非法的课程状态值' }),
    lifecycle: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled').optional()
        .messages({ 'any.only': '非法的课程状态值' }),
    teacher_uid: Joi.string().max(32).optional(),
    notes: Joi.string().allow('', null).max(500).optional()
        .messages({ 'string.max': '备注长度不能超过500个字符' })
}).or('status', 'lifecycle').messages({ 'object.missing': '缺少课程状态' });

// 兼容名：路由与既有测试仍引用 teacherStatusUpdateValidation
const teacherStatusUpdateValidation = teacherPairStatusValidation;

/** 往场次里加一位教师 / 学生 */
const sessionAddPairValidation = Joi.object({
    teacher_id: Joi.number().integer().positive().optional(),
    type_id: Joi.number().integer().positive().optional(),
    category: Joi.string().valid('normal', 'temp').default('normal'),
    lifecycle: Joi.string().valid('pending', 'confirmed', 'completed', 'cancelled', 'modified_away').default('pending'),
    student_id: Joi.number().integer().positive().optional(),
    family_participants: Joi.number().integer().min(0).max(5).default(4),
    transport_fee: Joi.number().min(0).allow(null),
    other_fee: Joi.number().min(0).allow(null),
    teacher_rating: Joi.number().integer().min(1).max(5).allow(null),
    teacher_comment: Joi.string().max(500).allow('', null),
    student_rating: Joi.number().integer().min(1).max(5).allow(null),
    student_comment: Joi.string().max(500).allow('', null),
    version: Joi.number().integer().min(0).optional()
});

// AI 配置更新（ai PUT /config）：provider/baseUrl/model 必填；apiKey 可选（允许空串，缺省时由控制器校验 apiKey‖presetId 并抛 400）
const aiConfigUpdateValidation = Joi.object({
    provider: Joi.string().min(1).required()
        .messages({ 'any.required': '缺少 provider', 'string.min': 'provider 不能为空' }),
    protocol: Joi.string().allow('', null).optional(),
    apiKey: Joi.string().allow('', null).optional(),
    baseUrl: Joi.string().min(1).required()
        .messages({ 'any.required': '缺少 baseUrl', 'string.min': 'baseUrl 不能为空' }),
    model: Joi.string().min(1).required()
        .messages({ 'any.required': '缺少 model', 'string.min': 'model 不能为空' }),
    timeout: Joi.number().integer().min(1).optional(),
    maxTokens: Joi.number().integer().min(1).optional(),
    presetId: Joi.string().allow('', null).optional()
});

// AI 连接检测/测试（ai POST /check、/test）：provider 可选（默认 custom），baseUrl/model 必填，apiKey 可选（控制器校验 apiKey‖presetId）
const aiConfigTestValidation = Joi.object({
    provider: Joi.string().allow('', null).optional(),
    protocol: Joi.string().allow('', null).optional(),
    apiKey: Joi.string().allow('', null).optional(),
    baseUrl: Joi.string().min(1).required()
        .messages({ 'any.required': '缺少 baseUrl', 'string.min': 'baseUrl 不能为空' }),
    model: Joi.string().min(1).required()
        .messages({ 'any.required': '缺少 model', 'string.min': 'model 不能为空' }),
    timeout: Joi.number().integer().min(1).optional(),
    maxTokens: Joi.number().integer().min(1).optional(),
    presetId: Joi.string().allow('', null).optional()
});

// 空闲时段日期格式（YYYY-MM-DD）
const availabilityDate = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);

// 教师 setAvailability（teacher POST /availability）：availabilityList 数组，每项含 date + 多态 slot 字段
// （slots 对象 或 timeSlot/isAvailable 等）。用 unknown(true) 保留形态，避免 stripUnknown 误删控制器读取的字段。
const teacherAvailabilitySetValidation = Joi.object({
    availabilityList: Joi.array().items(
        Joi.object({ date: availabilityDate.required() }).unknown(true)
    ).required()
}).unknown(true);

// 教师 deleteAvailability（teacher DELETE /availability）：records/date/timeSlots 均可选，保留兼容字段
const teacherAvailabilityDeleteValidation = Joi.object({
    records: Joi.array().items(Joi.object({ date: availabilityDate.optional() }).unknown(true)).optional(),
    date: availabilityDate.optional(),
    timeSlots: Joi.array().items(Joi.any()).optional()
}).unknown(true);

// 教师 replaceAvailability（teacher PUT /availability，R2 原子保存）：updates[{date, slots{}}] / removals[{date, removeAll?, timeSlot?}] 可选数组
const teacherAvailabilityReplaceValidation = Joi.object({
    updates: Joi.array().items(
        Joi.object({
            date: availabilityDate.required(),
            slots: Joi.object({
                morning: Joi.any().optional(),
                afternoon: Joi.any().optional(),
                evening: Joi.any().optional()
            }).unknown(true).optional()
        }).unknown(true)
    ).optional(),
    removals: Joi.array().items(
        Joi.object({
            date: availabilityDate.required(),
            removeAll: Joi.boolean().optional(),
            timeSlot: Joi.any().optional(),
            slot: Joi.any().optional(),
            time_slot: Joi.any().optional()
        }).unknown(true)
    ).optional()
}).unknown(true);

// 管理员批量更新教师空闲（admin POST /teacher-availability）：updates[{teacher_id, date, morning?, afternoon?, evening?}]
const adminTeacherAvailabilityValidation = Joi.object({
    updates: Joi.array().items(
        Joi.object({
            teacher_id: Joi.number().integer().positive().required()
                .messages({ 'number.base': '教师ID必须是数字', 'any.required': '缺少教师ID' }),
            date: availabilityDate.required()
                .messages({ 'string.pattern.base': '日期格式应为YYYY-MM-DD', 'any.required': '缺少日期' }),
            morning: Joi.any().optional(),
            afternoon: Joi.any().optional(),
            evening: Joi.any().optional()
        }).unknown(true)
    ).min(1).required()
        .messages({ 'array.min': '缺少更新数据', 'any.required': '缺少 updates' })
}).unknown(true);

// 管理员批量更新学生空闲（admin POST /student-availability）：updates[{student_id, date, morning?, afternoon?, evening?}]
const adminStudentAvailabilityValidation = Joi.object({
    updates: Joi.array().items(
        Joi.object({
            student_id: Joi.number().integer().positive().required()
                .messages({ 'number.base': '学生ID必须是数字', 'any.required': '缺少学生ID' }),
            date: availabilityDate.required()
                .messages({ 'string.pattern.base': '日期格式应为YYYY-MM-DD', 'any.required': '缺少日期' }),
            morning: Joi.any().optional(),
            afternoon: Joi.any().optional(),
            evening: Joi.any().optional()
        }).unknown(true)
    ).min(1).required()
        .messages({ 'array.min': '缺少更新数据', 'any.required': '缺少 updates' })
}).unknown(true);

// 学生 setAvailability（student POST /availability）：availabilityList[{timeSlot, date, isAvailable?}]，保留兼容字段
const studentAvailabilitySetValidation = Joi.object({
    availabilityList: Joi.array().items(
        Joi.object({
            date: availabilityDate.required(),
            timeSlot: Joi.string().valid('morning', 'afternoon', 'evening').required()
                .messages({ 'any.only': '时段无效', 'any.required': '缺少时段' }),
            isAvailable: Joi.boolean().optional()
        }).unknown(true)
    ).required()
}).unknown(true);

// 学生 deleteAvailability（student DELETE /availability）：startDate/endDate/timeSlots/ranges 可选
const studentAvailabilityDeleteValidation = Joi.object({
    startDate: availabilityDate.optional(),
    endDate: availabilityDate.optional(),
    timeSlots: Joi.array().items(Joi.string().valid('morning', 'afternoon', 'evening')).optional(),
    ranges: Joi.array().items(Joi.object({ start_time: Joi.any().optional() }).unknown(true)).optional()
}).unknown(true);

module.exports = {
    validate,
    standardResponse,
    scheduleValidation,
    userValidation,
    passwordChangeValidation,
    teacherProfileValidation,
    studentProfileValidation,
    feeUpdateValidation,
    feeStatusUpdateValidation,
    feeStatusBatchValidation,
    feeBatchValidation,
    scheduleTypeValidation,
    holidayValidation,
    holidayBatchValidation,
    holidaySyncValidation,
    feedbackCreateValidation,
    feedbackUpdateValidation,
    adminConfirmValidation,
    teacherConfirmValidation,
    teacherStatusUpdateValidation,
    teacherPairStatusValidation,
    sessionAddPairValidation,
    aiConfigUpdateValidation,
    aiConfigTestValidation,
    teacherAvailabilitySetValidation,
    teacherAvailabilityDeleteValidation,
    teacherAvailabilityReplaceValidation,
    adminTeacherAvailabilityValidation,
    adminStudentAvailabilityValidation,
    studentAvailabilitySetValidation,
    studentAvailabilityDeleteValidation
};
