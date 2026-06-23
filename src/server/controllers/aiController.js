/**
 * AI 控制器 (AI Controller) - 全新重构版本
 * @description 处理 AI 相关请求：数据查询、智能排课
 * @module controllers/aiController
 */

const { standardResponse } = require('../middleware/validation');
const { AppError, asyncHandler } = require('../middleware/error');
const aiService = require('../services/aiService');
const db = require('../db/db');
const scheduleService = require('../services/scheduleService');
const { getPresetModels } = require('../services/presetModels');
const aiConfigManager = require('../services/aiConfigManager');
const fs = require('fs');
const path = require('path');

/**
 * AI 功能状态检查
 * GET /api/ai/status
 */
const getStatus = (req, res) => {
    res.json(standardResponse(true, {
        enabled: aiService.isAvailable(),
        provider: aiService.getAIConfig().provider,
        role: req.user?.userType
    }, 'ok'));
};

/**
 * 状态的中英文映射（统一在后端定义）
 */
const STATUS_MAPPING = {
    'pending': '待确认',
    'confirmed': '已确认',
    'cancelled': '已取消',
    'completed': '已完成',
    'modified_away': '已改期'
};

/**
 * 课程类型映射缓存
 */
let courseTypeCache = null;

/**
 * 从数据库加载课程类型映射
 */
async function loadCourseTypeMapping() {
    if (courseTypeCache) return courseTypeCache;
    try {
        const result = await db.query('SELECT name, description FROM schedule_types ORDER BY id;');
        courseTypeCache = {};
        result.rows.forEach(row => {
            courseTypeCache[row.name] = row.description;
        });
        return courseTypeCache;
    } catch (err) {
        console.error('[AI] 加载课程类型映射失败:', err.message);
        return {};
    }
}

/**
 * 翻译课程类型（从数据库）
 */
async function translateCourseType(type) {
    const mapping = await loadCourseTypeMapping();
    return mapping[type] || type;
}

/**
 * 翻译状态
 */
function translateStatus(status) {
    return STATUS_MAPPING[status] || status;
}

/**
 * 时间计算辅助函数：给时间字符串加 N 小时
 * @param {string} timeStr - HH:MM:SS
 * @param {number} hours - 小时数
 * @returns {string} HH:MM:SS
 */
function addHours(timeStr, hours) {
    const [h, m, s] = timeStr.split(':').map(Number);
    const totalMinutes = h * 60 + m + hours * 60;
    const newH = Math.floor(totalMinutes / 60);
    const newM = totalMinutes % 60;
    return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
}

/**
 * 排课预览临时存储（内存）
 * 生产环境应使用 Redis
 */
const schedulePreviewStore = new Map();

/**
 * 敏感操作确认临时存储（内存）
 * 用于存储待确认的删除、修改操作
 * 生产环境应使用 Redis
 */
const pendingOperationStore = new Map();

/* ============================================================
 * 数据查询工具集（全新设计）
 * ============================================================ */

/**
 * 工具定义（按角色分类）
 */
const DATA_TOOLS = {
    admin: [
        {
            type: 'function',
            function: {
                name: 'query_overview',
                description: '查询系统总览数据：教师总数、学生总数、本月排课数、待确认数',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_schedules',
                description: '查询排课列表，支持按教师、学生、日期范围、状态筛选',
                parameters: {
                    type: 'object',
                    properties: {
                        teacherId: { type: 'integer', description: '教师ID' },
                        studentId: { type: 'integer', description: '学生ID' },
                        startDate: { type: 'string', description: 'YYYY-MM-DD' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD' },
                        status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled'], description: '排课状态' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_teachers',
                description: '查询教师列表，返回 id, name, profession, status。可通过姓名模糊搜索教师。',
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'integer', enum: [0, 1], description: '0=禁用 1=启用' },
                        name: { type: 'string', description: '教师姓名（模糊匹配）' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_students',
                description: '查询学生列表，返回 id, name, profession, status。可通过姓名模糊搜索学生。',
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'integer', enum: [0, 1], description: '0=禁用 1=启用' },
                        name: { type: 'string', description: '学生姓名（模糊匹配）' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_schedule_stats',
                description: '统计排课数据：按课程类型、教师、学生维度统计',
                parameters: {
                    type: 'object',
                    properties: {
                        dimension: { type: 'string', enum: ['type', 'teacher', 'student'], description: '统计维度' },
                        startDate: { type: 'string', description: 'YYYY-MM-DD' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD' }
                    },
                    required: ['dimension']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'update_schedule_teacher',
                description: '修改指定排课的教师。需要先用 query_schedules 查到排课ID，再用 query_teachers 查到新教师ID。',
                parameters: {
                    type: 'object',
                    properties: {
                        scheduleId: { type: 'integer', description: '排课ID' },
                        newTeacherId: { type: 'integer', description: '新教师ID' }
                    },
                    required: ['scheduleId', 'newTeacherId']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'find_available_slots',
                description: '查找教师和学生在指定日期范围内的可用时段。返回可排课的日期和时间段。',
                parameters: {
                    type: 'object',
                    properties: {
                        teacherId: { type: 'integer', description: '教师ID' },
                        studentId: { type: 'integer', description: '学生ID' },
                        startDate: { type: 'string', description: 'YYYY-MM-DD，开始日期' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD，结束日期' },
                        preferredDays: { type: 'array', items: { type: 'integer' }, description: '偏好星期几，1-7（1=周一）' },
                        duration: { type: 'integer', description: '课程时长（小时），默认2' }
                    },
                    required: ['teacherId', 'studentId', 'startDate', 'endDate']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_schedule_preview',
                description: '根据可用时段生成排课预览方案。返回建议的排课计划供用户确认。',
                parameters: {
                    type: 'object',
                    properties: {
                        teacherId: { type: 'integer', description: '教师ID' },
                        studentId: { type: 'integer', description: '学生ID' },
                        courseType: { type: 'string', description: '课程类型名称（name字段）：home-visit/half-home-visit/review/review-record等' },
                        slots: {
                            type: 'array',
                            description: '时段列表',
                            items: {
                                type: 'object',
                                properties: {
                                    date: { type: 'string', description: 'YYYY-MM-DD' },
                                    startTime: { type: 'string', description: 'HH:MM:SS' },
                                    endTime: { type: 'string', description: 'HH:MM:SS' }
                                }
                            }
                        }
                    },
                    required: ['teacherId', 'studentId', 'courseType', 'slots']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'confirm_schedule_creation',
                description: '确认并批量创建排课。用户确认预览方案后调用此工具。',
                parameters: {
                    type: 'object',
                    properties: {
                        previewId: { type: 'string', description: '预览方案ID' }
                    },
                    required: ['previewId']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'preview_schedule_update',
                description: '【第1步】预览排课修改：查看修改前后的对比，生成操作ID供确认。',
                parameters: {
                    type: 'object',
                    properties: {
                        scheduleIds: {
                            type: 'array',
                            items: { type: 'integer' },
                            description: '要修改的排课ID列表（可以是一个或多个）'
                        },
                        fields: {
                            type: 'object',
                            description: '要修改的字段（只需提供要修改的字段）',
                            properties: {
                                teacherId: { type: 'integer', description: '新教师ID' },
                                studentId: { type: 'integer', description: '新学生ID' },
                                classDate: { type: 'string', description: '新日期 YYYY-MM-DD' },
                                startTime: { type: 'string', description: '新开始时间 HH:MM:SS' },
                                endTime: { type: 'string', description: '新结束时间 HH:MM:SS' },
                                status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled', 'completed', 'modified_away'], description: '新状态' },
                                courseType: { type: 'string', description: '新课程类型名称（name字段）：home-visit/half-home-visit/review/review-record等' },
                                location: { type: 'string', description: '新地点（如：新课堂、老课堂等）' },
                                familyParticipants: { type: 'integer', description: '家长参与人数' },
                                transportFee: { type: 'number', description: '交通费' },
                                otherFee: { type: 'number', description: '其他费用' }
                            }
                        }
                    },
                    required: ['scheduleIds', 'fields']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'preview_schedule_deletion',
                description: '【第1步】预览排课删除：查看要删除的排课详情，生成操作ID供确认。',
                parameters: {
                    type: 'object',
                    properties: {
                        scheduleIds: {
                            type: 'array',
                            items: { type: 'integer' },
                            description: '要删除的排课ID列表（可以是一个或多个）'
                        },
                        reason: { type: 'string', description: '删除原因（可选）' }
                    },
                    required: ['scheduleIds']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'confirm_operation',
                description: '【第2步】确认执行操作：用户确认后，执行预览的修改或删除操作。',
                parameters: {
                    type: 'object',
                    properties: {
                        operationId: { type: 'string', description: '预览操作返回的操作ID' }
                    },
                    required: ['operationId']
                }
            }
        }
    ],
    teacher: [
        {
            type: 'function',
            function: {
                name: 'query_my_overview',
                description: '查询当前教师的总览数据：本周/本月/本年排课数、待处理/已完成/已取消',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_my_schedules',
                description: '查询当前教师的排课列表',
                parameters: {
                    type: 'object',
                    properties: {
                        startDate: { type: 'string', description: 'YYYY-MM-DD' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD' },
                        status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled'] }
                    }
                }
            }
        }
    ]
};

/**
 * 工具执行逻辑（全新实现）
 */
async function executeDataTool(toolName, args, req) {
    const userType = req.user.userType;


    const userId = req.user.id;

    switch (toolName) {
        case 'query_overview': {
            if (userType !== 'admin') throw new AppError('权限不足', 403);

            const [teachers, students, monthSchedules, pending] = await Promise.all([
                db.query('SELECT COUNT(*) as count FROM teachers WHERE status=1'),
                db.query('SELECT COUNT(*) as count FROM students WHERE status=1'),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)
                    AND EXTRACT(MONTH FROM class_date)=EXTRACT(MONTH FROM CURRENT_DATE)`),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE status='pending'`)
            ]);

            return {
                type: 'data_table',
                title: '系统总览',
                data: {
                    teacherCount: parseInt(teachers.rows[0].count),
                    studentCount: parseInt(students.rows[0].count),
                    monthSchedules: parseInt(monthSchedules.rows[0].count),
                    pendingSchedules: parseInt(pending.rows[0].count)
                }
            };
        }

        case 'query_schedules': {
            if (userType !== 'admin') throw new AppError('权限不足', 403);

            let query = 'SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status, ' +
                       't.name as teacher_name, s.name as student_name, st.name as course_type ' +
                       'FROM course_arrangement ca ' +
                       'JOIN teachers t ON ca.teacher_id=t.id ' +
                       'JOIN students s ON ca.student_id=s.id ' +
                       'JOIN schedule_types st ON ca.course_id=st.id WHERE 1=1';
            const params = [];
            let paramCount = 1;

            if (args.teacherId) {
                query += ` AND ca.teacher_id=$${paramCount++}`;
                params.push(args.teacherId);
            }
            if (args.studentId) {
                query += ` AND ca.student_id=$${paramCount++}`;
                params.push(args.studentId);
            }
            if (args.startDate) {
                query += ` AND ca.class_date>=$${paramCount++}`;
                params.push(args.startDate);
            }
            if (args.endDate) {
                query += ` AND ca.class_date<=$${paramCount++}`;
                params.push(args.endDate);
            }
            if (args.status) {
                query += ` AND ca.status=$${paramCount++}`;
                params.push(args.status);
            }

            query += ' ORDER BY ca.class_date DESC, ca.start_time DESC LIMIT 50';
            const result = await db.query(query, params);

            // 翻译课程类型和状态为中文
            const translatedData = await Promise.all(result.rows.map(async row => ({
                ...row,
                course_type_cn: await translateCourseType(row.course_type),
                status_cn: translateStatus(row.status)
            })));

            return {
                type: 'schedule_list',
                title: '排课列表',
                data: translatedData
            };
        }

        case 'query_teachers': {
            if (userType !== 'admin') throw new AppError('权限不足', 403);

            let query = 'SELECT id, name, profession, status FROM teachers';
            const params = [];
            const conditions = [];
            let paramCount = 1;

            if (args.status !== undefined) {
                conditions.push(`status=$${paramCount++}`);
                params.push(args.status);
            }

            if (args.name) {
                conditions.push(`name LIKE $${paramCount++}`);
                params.push(`%${args.name}%`);
            }

            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }

            query += ' ORDER BY id';
            const result = await db.query(query, params);

            return {
                type: 'data_table',
                title: '教师列表',
                data: result.rows
            };
        }

        case 'query_students': {
            if (userType !== 'admin') throw new AppError('权限不足', 403);

            let query = 'SELECT id, name, profession, status FROM students';
            const params = [];
            const conditions = [];
            let paramCount = 1;

            if (args.status !== undefined) {
                conditions.push(`status=$${paramCount++}`);
                params.push(args.status);
            }

            if (args.name) {
                conditions.push(`name LIKE $${paramCount++}`);
                params.push(`%${args.name}%`);
            }

            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }

            query += ' ORDER BY id';
            const result = await db.query(query, params);

            return {
                type: 'data_table',
                title: '学生列表',
                data: result.rows
            };
        }

        case 'query_schedule_stats': {
            if (userType !== 'admin') throw new AppError('权限不足', 403);

            const { dimension, startDate, endDate } = args;
            let query, params = [];

            if (dimension === 'type') {
                query = `SELECT st.name as category, COUNT(*) as count
                        FROM course_arrangement ca
                        JOIN schedule_types st ON ca.course_id=st.id
                        WHERE 1=1`;
            } else if (dimension === 'teacher') {
                query = `SELECT t.name as category, COUNT(*) as count
                        FROM course_arrangement ca
                        JOIN teachers t ON ca.teacher_id=t.id
                        WHERE 1=1`;
            } else {
                query = `SELECT s.name as category, COUNT(*) as count
                        FROM course_arrangement ca
                        JOIN students s ON ca.student_id=s.id
                        WHERE 1=1`;
            }

            let paramCount = 1;
            if (startDate) {
                query += ` AND ca.class_date>=$${paramCount++}`;
                params.push(startDate);
            }
            if (endDate) {
                query += ` AND ca.class_date<=$${paramCount++}`;
                params.push(endDate);
            }

            query += ' GROUP BY category ORDER BY count DESC LIMIT 20';
            const result = await db.query(query, params);

            return {
                type: 'chart_data',
                title: `按${dimension === 'type' ? '课程类型' : dimension === 'teacher' ? '教师' : '学生'}统计`,
                data: result.rows
            };
        }

        case 'query_my_overview': {
            if (userType !== 'teacher') throw new AppError('仅教师可查询', 403);

            const [week, month, year, pending, confirmed, cancelled] = await Promise.all([
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE teacher_id=$1 AND class_date>=CURRENT_DATE-7`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE teacher_id=$1 AND EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)
                    AND EXTRACT(MONTH FROM class_date)=EXTRACT(MONTH FROM CURRENT_DATE)`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE teacher_id=$1 AND EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE teacher_id=$1 AND status='pending'`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE teacher_id=$1 AND status='confirmed'`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE teacher_id=$1 AND status='cancelled'`, [userId])
            ]);

            return {
                type: 'data_table',
                title: '我的总览',
                data: {
                    weekSchedules: parseInt(week.rows[0].count),
                    monthSchedules: parseInt(month.rows[0].count),
                    yearSchedules: parseInt(year.rows[0].count),
                    pending: parseInt(pending.rows[0].count),
                    confirmed: parseInt(confirmed.rows[0].count),
                    cancelled: parseInt(cancelled.rows[0].count)
                }
            };
        }

        case 'query_my_schedules': {
            if (userType !== 'teacher') throw new AppError('仅教师可查询', 403);

            let query = `SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status,
                        s.name as student_name, st.name as course_type
                        FROM course_arrangement ca
                        JOIN students s ON ca.student_id=s.id
                        JOIN schedule_types st ON ca.course_id=st.id
                        WHERE ca.teacher_id=$1`;
            const params = [userId];
            let paramCount = 2;

            if (args.startDate) {
                query += ` AND ca.class_date>=$${paramCount++}`;
                params.push(args.startDate);
            }
            if (args.endDate) {
                query += ` AND ca.class_date<=$${paramCount++}`;
                params.push(args.endDate);
            }
            if (args.status) {
                query += ` AND ca.status=$${paramCount++}`;
                params.push(args.status);
            }

            query += ' ORDER BY ca.class_date DESC, ca.start_time DESC LIMIT 50';
            const result = await db.query(query, params);

            // 翻译课程类型和状态为中文
            const translatedData = await Promise.all(result.rows.map(async row => ({
                ...row,
                course_type_cn: await translateCourseType(row.course_type),
                status_cn: translateStatus(row.status)
            })));

            return {
                type: 'schedule_list',
                title: '我的排课',
                data: translatedData
            };
        }

        case 'update_schedule_teacher': {
            if (userType !== 'admin') throw new AppError('仅管理员可修改排课', 403);

            const { scheduleId, newTeacherId } = args;

            // 检查排课是否存在
            const scheduleCheck = await db.query(
                'SELECT id, teacher_id, student_id FROM course_arrangement WHERE id=$1',
                [scheduleId]
            );
            if (scheduleCheck.rows.length === 0) {
                throw new AppError(`排课 ID ${scheduleId} 不存在`, 404);
            }

            // 检查新教师是否存在
            const teacherCheck = await db.query(
                'SELECT id, name, status FROM teachers WHERE id=$1',
                [newTeacherId]
            );
            if (teacherCheck.rows.length === 0) {
                throw new AppError(`教师 ID ${newTeacherId} 不存在`, 404);
            }
            if (teacherCheck.rows[0].status !== 1) {
                throw new AppError(`教师 ${teacherCheck.rows[0].name} 已被禁用`, 400);
            }

            // 执行更新
            await db.query(
                'UPDATE course_arrangement SET teacher_id=$1, updated_at=CURRENT_TIMESTAMP WHERE id=$2',
                [newTeacherId, scheduleId]
            );

            const oldTeacherId = scheduleCheck.rows[0].teacher_id;
            const oldTeacher = await db.query('SELECT name FROM teachers WHERE id=$1', [oldTeacherId]);
            const newTeacherName = teacherCheck.rows[0].name;
            const oldTeacherName = oldTeacher.rows[0]?.name || '未知';

            return {
                type: 'text',
                title: '修改成功',
                data: {
                    message: `已将排课 #${scheduleId} 的教师从「${oldTeacherName}」改为「${newTeacherName}」`
                }
            };
        }

        case 'find_available_slots': {
            if (userType !== 'admin') throw new AppError('仅管理员可查找时段', 403);

            const { teacherId, studentId, startDate, endDate, preferredDays, duration = 2 } = args;

            // 验证教师和学生存在
            const [teacher, student] = await Promise.all([
                db.query('SELECT id, name FROM teachers WHERE id=$1 AND status=1', [teacherId]),
                db.query('SELECT id, name FROM students WHERE id=$1 AND status=1', [studentId])
            ]);

            if (teacher.rows.length === 0) throw new AppError(`教师 ID ${teacherId} 不存在或已禁用`, 404);
            if (student.rows.length === 0) throw new AppError(`学生 ID ${studentId} 不存在或已禁用`, 404);

            // 查询指定日期范围内的已有排课
            const existingSchedules = await db.query(
                `SELECT class_date, start_time, end_time
                 FROM course_arrangement
                 WHERE (teacher_id=$1 OR student_id=$2)
                 AND class_date BETWEEN $3 AND $4
                 AND status != 'cancelled'
                 ORDER BY class_date, start_time`,
                [teacherId, studentId, startDate, endDate]
            );

            // 生成日期范围
            const start = new Date(startDate);
            const end = new Date(endDate);
            const availableSlots = [];

            // 工作时间段定义（可配置）
            const workingHours = [
                { start: '09:00:00', end: '12:00:00' },
                { start: '14:00:00', end: '18:00:00' },
                { start: '19:00:00', end: '22:00:00' }
            ];

            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().split('T')[0];
                const dayOfWeek = d.getDay() === 0 ? 7 : d.getDay(); // 转换为 1-7

                // 如果指定了偏好星期，跳过非偏好日期
                if (preferredDays && preferredDays.length > 0 && !preferredDays.includes(dayOfWeek)) {
                    continue;
                }

                // 该日期的已有排课
                const daySchedules = existingSchedules.rows.filter(s =>
                    s.class_date.toISOString().split('T')[0] === dateStr
                );

                // 检查每个工作时间段
                for (const period of workingHours) {
                    const slotStart = period.start;
                    const slotEnd = addHours(period.start, duration);

                    // 检查时长是否超出工作时段
                    if (slotEnd > period.end) continue;

                    // 检查是否与已有排课冲突
                    const hasConflict = daySchedules.some(sch => {
                        return !(slotEnd <= sch.start_time || slotStart >= sch.end_time);
                    });

                    if (!hasConflict) {
                        availableSlots.push({
                            date: dateStr,
                            startTime: slotStart,
                            endTime: slotEnd,
                            dayOfWeek: dayOfWeek
                        });
                    }
                }
            }

            return {
                type: 'data_table',
                title: '可用时段',
                data: {
                    teacher: teacher.rows[0].name,
                    student: student.rows[0].name,
                    totalSlots: availableSlots.length,
                    slots: availableSlots.slice(0, 20)  // 最多返回20个
                }
            };
        }

        case 'create_schedule_preview': {
            if (userType !== 'admin') throw new AppError('仅管理员可创建排课', 403);

            const { teacherId, studentId, courseType, slots } = args;

            // 验证教师、学生、课程类型
            const [teacher, student] = await Promise.all([
                db.query('SELECT id, name FROM teachers WHERE id=$1 AND status=1', [teacherId]),
                db.query('SELECT id, name FROM students WHERE id=$1 AND status=1', [studentId])
            ]);

            if (teacher.rows.length === 0) throw new AppError(`教师 ID ${teacherId} 不存在或已禁用`, 404);
            if (student.rows.length === 0) throw new AppError(`学生 ID ${studentId} 不存在或已禁用`, 404);

            // 查询课程类型ID
            const courseTypeResult = await db.query(
                'SELECT id, name FROM schedule_types WHERE name=$1',
                [courseType]
            );
            if (courseTypeResult.rows.length === 0) {
                throw new AppError(`课程类型 ${courseType} 不存在`, 404);
            }

            const courseId = courseTypeResult.rows[0].id;

            // 生成预览ID
            const previewId = `preview_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

            // 构建预览数据
            const courseTypeCn = await translateCourseType(courseType);
            const previewData = {
                previewId,
                teacherId,
                studentId,
                courseId,
                teacherName: teacher.rows[0].name,
                studentName: student.rows[0].name,
                courseTypeCn,
                slots: slots.map(slot => ({
                    date: slot.date,
                    startTime: slot.startTime,
                    endTime: slot.endTime
                })),
                createdAt: new Date().toISOString()
            };

            // 存储到内存（5分钟过期）
            schedulePreviewStore.set(previewId, previewData);
            setTimeout(() => schedulePreviewStore.delete(previewId), 5 * 60 * 1000);

            return {
                type: 'schedule_preview',  // 改为 schedule_preview 类型
                title: '排课预览方案',
                data: {
                    previewId,
                    teacher: teacher.rows[0].name,
                    student: student.rows[0].name,
                    courseType: courseTypeCn,
                    totalCount: slots.length,
                    schedules: slots.map(slot => ({
                        class_date: slot.date,
                        start_time: slot.startTime,
                        end_time: slot.endTime,
                        teacher_name: teacher.rows[0].name,
                        student_name: student.rows[0].name,
                        course_type_cn: courseTypeCn,
                        status_cn: '预览'
                    }))
                }
            };
        }

        case 'confirm_schedule_creation': {
            if (userType !== 'admin') throw new AppError('仅管理员可创建排课', 403);

            const { previewId } = args;

            // 从存储中获取预览数据
            const previewData = schedulePreviewStore.get(previewId);
            if (!previewData) {
                throw new AppError('预览方案不存在或已过期，请重新生成', 404);
            }

            const { teacherId, studentId, courseId, slots } = previewData;

            // 批量插入排课
            const insertedIds = [];
            for (const slot of slots) {
                const result = await db.query(
                    `INSERT INTO course_arrangement
                    (teacher_id, student_id, course_id, class_date, start_time, end_time, status, created_at, updated_at)
                    VALUES ($1, $2, $3, $4, $5, $6, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    RETURNING id`,
                    [teacherId, studentId, courseId, slot.date, slot.startTime, slot.endTime]
                );
                insertedIds.push(result.rows[0].id);
            }

            // 删除预览数据
            schedulePreviewStore.delete(previewId);

            return {
                type: 'text',
                title: '排课创建成功',
                data: {
                    message: `成功创建 ${insertedIds.length} 条排课记录`,
                    scheduleIds: insertedIds,
                    teacher: previewData.teacherName,
                    student: previewData.studentName,
                    courseType: previewData.courseTypeCn
                }
            };
        }

        case 'preview_schedule_update': {
            if (userType !== 'admin') throw new AppError('仅管理员可修改排课', 403);

            const { scheduleIds, fields } = args;

            if (!scheduleIds || scheduleIds.length === 0) {
                throw new AppError('请提供要修改的排课ID', 400);
            }

            if (!fields || Object.keys(fields).length === 0) {
                throw new AppError('请提供要修改的字段', 400);
            }

            // 检查排课是否存在并获取详细信息
            const existingSchedules = await db.query(
                `SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status,
                        ca.location, ca.family_participants, ca.transport_fee, ca.other_fee,
                        t.name as teacher_name, t.id as teacher_id,
                        s.name as student_name, s.id as student_id,
                        st.name as course_type, st.description as course_type_cn
                 FROM course_arrangement ca
                 JOIN teachers t ON ca.teacher_id = t.id
                 JOIN students s ON ca.student_id = s.id
                 JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.id = ANY($1)`,
                [scheduleIds]
            );

            if (existingSchedules.rows.length === 0) {
                throw new AppError('未找到指定的排课', 404);
            }

            if (existingSchedules.rows.length < scheduleIds.length) {
                const foundIds = existingSchedules.rows.map(r => r.id);
                const missingIds = scheduleIds.filter(id => !foundIds.includes(id));
                throw new AppError(`排课 ID ${missingIds.join(', ')} 不存在`, 404);
            }

            // 验证新值的合法性
            let newTeacherName, newStudentName, newCourseTypeCn;

            if (fields.teacherId) {
                const teacherCheck = await db.query('SELECT id, name, status FROM teachers WHERE id=$1', [fields.teacherId]);
                if (teacherCheck.rows.length === 0) throw new AppError(`教师 ID ${fields.teacherId} 不存在`, 404);
                if (teacherCheck.rows[0].status !== 1) throw new AppError(`教师 ${teacherCheck.rows[0].name} 已被禁用`, 400);
                newTeacherName = teacherCheck.rows[0].name;
            }

            if (fields.studentId) {
                const studentCheck = await db.query('SELECT id, name, status FROM students WHERE id=$1', [fields.studentId]);
                if (studentCheck.rows.length === 0) throw new AppError(`学生 ID ${fields.studentId} 不存在`, 404);
                if (studentCheck.rows[0].status !== 1) throw new AppError(`学生 ${studentCheck.rows[0].name} 已被禁用`, 400);
                newStudentName = studentCheck.rows[0].name;
            }

            if (fields.courseType) {
                const courseTypeResult = await db.query('SELECT id, name, description FROM schedule_types WHERE name=$1', [fields.courseType]);
                if (courseTypeResult.rows.length === 0) throw new AppError(`课程类型 ${fields.courseType} 不存在`, 404);
                newCourseTypeCn = courseTypeResult.rows[0].description;
            }

            // 生成操作ID
            const operationId = `update_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

            // 构建变更对比
            const fieldNames = {
                teacherId: '教师',
                studentId: '学生',
                classDate: '日期',
                startTime: '开始时间',
                endTime: '结束时间',
                status: '状态',
                courseType: '课程类型',
                location: '地点',
                familyParticipants: '家长参与人数',
                transportFee: '交通费',
                otherFee: '其他费用'
            };

            const changes = [];
            Object.keys(fields).forEach(key => {
                const fieldLabel = fieldNames[key] || key;
                let newValue = fields[key];

                // 转换显示值
                if (key === 'teacherId') newValue = `${newTeacherName} (ID: ${fields[key]})`;
                else if (key === 'studentId') newValue = `${newStudentName} (ID: ${fields[key]})`;
                else if (key === 'courseType') newValue = `${newCourseTypeCn} (${fields[key]})`;
                else if (key === 'status') newValue = translateStatus(fields[key]);

                changes.push({ field: fieldLabel, newValue });
            });

            // 存储待确认操作
            pendingOperationStore.set(operationId, {
                type: 'update',
                scheduleIds,
                fields,
                schedules: existingSchedules.rows,
                changes,
                createdAt: Date.now()
            });

            // 5分钟后自动过期
            setTimeout(() => pendingOperationStore.delete(operationId), 5 * 60 * 1000);

            return {
                type: 'schedule_operation_preview',
                title: '修改预览',
                data: {
                    operationId,
                    operationType: 'update',
                    affectedCount: scheduleIds.length,
                    schedules: existingSchedules.rows,
                    changes,
                    message: `将修改 ${scheduleIds.length} 条排课的${changes.map(c => c.field).join('、')}`
                }
            };
        }

        case 'preview_schedule_deletion': {
            if (userType !== 'admin') throw new AppError('仅管理员可修改排课', 403);

            const { scheduleIds, fields } = args;

            if (!scheduleIds || scheduleIds.length === 0) {
                throw new AppError('请提供要修改的排课ID', 400);
            }

            if (!fields || Object.keys(fields).length === 0) {
                throw new AppError('请提供要修改的字段', 400);
            }

            // 检查排课是否存在
            const existingSchedules = await db.query(
                `SELECT id, teacher_id, student_id, course_id, class_date, start_time, end_time, status,
                        location, family_participants, transport_fee, other_fee
                 FROM course_arrangement
                 WHERE id = ANY($1)`,
                [scheduleIds]
            );

            if (existingSchedules.rows.length === 0) {
                throw new AppError('未找到指定的排课', 404);
            }

            if (existingSchedules.rows.length < scheduleIds.length) {
                const foundIds = existingSchedules.rows.map(r => r.id);
                const missingIds = scheduleIds.filter(id => !foundIds.includes(id));
                throw new AppError(`排课 ID ${missingIds.join(', ')} 不存在`, 404);
            }

            // 构建 UPDATE 语句
            const updateFields = [];
            const params = [];
            let paramCount = 1;

            // 处理课程类型字段（需要转换为 course_id）
            if (fields.courseType) {
                const courseTypeResult = await db.query(
                    'SELECT id FROM schedule_types WHERE name=$1',
                    [fields.courseType]
                );
                if (courseTypeResult.rows.length === 0) {
                    throw new AppError(`课程类型 ${fields.courseType} 不存在`, 404);
                }
                updateFields.push(`course_id=$${paramCount++}`);
                params.push(courseTypeResult.rows[0].id);
            }

            // 处理教师字段
            if (fields.teacherId) {
                const teacherCheck = await db.query(
                    'SELECT id, name, status FROM teachers WHERE id=$1',
                    [fields.teacherId]
                );
                if (teacherCheck.rows.length === 0) {
                    throw new AppError(`教师 ID ${fields.teacherId} 不存在`, 404);
                }
                if (teacherCheck.rows[0].status !== 1) {
                    throw new AppError(`教师 ${teacherCheck.rows[0].name} 已被禁用`, 400);
                }
                updateFields.push(`teacher_id=$${paramCount++}`);
                params.push(fields.teacherId);
            }

            // 处理学生字段
            if (fields.studentId) {
                const studentCheck = await db.query(
                    'SELECT id, name, status FROM students WHERE id=$1',
                    [fields.studentId]
                );
                if (studentCheck.rows.length === 0) {
                    throw new AppError(`学生 ID ${fields.studentId} 不存在`, 404);
                }
                if (studentCheck.rows[0].status !== 1) {
                    throw new AppError(`学生 ${studentCheck.rows[0].name} 已被禁用`, 400);
                }
                updateFields.push(`student_id=$${paramCount++}`);
                params.push(fields.studentId);
            }

            // 处理其他字段
            if (fields.classDate) {
                updateFields.push(`class_date=$${paramCount++}`);
                params.push(fields.classDate);
            }
            if (fields.startTime) {
                updateFields.push(`start_time=$${paramCount++}`);
                params.push(fields.startTime);
            }
            if (fields.endTime) {
                updateFields.push(`end_time=$${paramCount++}`);
                params.push(fields.endTime);
            }
            if (fields.status) {
                updateFields.push(`status=$${paramCount++}`);
                params.push(fields.status);
            }
            if (fields.location !== undefined) {
                updateFields.push(`location=$${paramCount++}`);
                params.push(fields.location);
            }
            if (fields.familyParticipants !== undefined) {
                updateFields.push(`family_participants=$${paramCount++}`);
                params.push(fields.familyParticipants);
            }
            if (fields.transportFee !== undefined) {
                updateFields.push(`transport_fee=$${paramCount++}`);
                params.push(fields.transportFee);
            }
            if (fields.otherFee !== undefined) {
                updateFields.push(`other_fee=$${paramCount++}`);
                params.push(fields.otherFee);
            }

            // 添加更新时间
            updateFields.push('updated_at=CURRENT_TIMESTAMP');

            // 执行批量更新
            params.push(scheduleIds);
            const updateQuery = `
                UPDATE course_arrangement
                SET ${updateFields.join(', ')}
                WHERE id = ANY($${paramCount})
            `;

            await db.query(updateQuery, params);

            // 构建修改摘要
            const fieldNames = {
                teacherId: '教师',
                studentId: '学生',
                classDate: '日期',
                startTime: '开始时间',
                endTime: '结束时间',
                status: '状态',
                courseType: '课程类型',
                location: '地点',
                familyParticipants: '家长参与人数',
                transportFee: '交通费',
                otherFee: '其他费用'
            };

            const changedFields = Object.keys(fields)
                .map(key => fieldNames[key] || key)
                .join('、');

            return {
                type: 'text',
                title: '修改成功',
                data: {
                    message: `已修改 ${scheduleIds.length} 条排课的${changedFields}`,
                    scheduleIds,
                    modifiedFields: Object.keys(fields)
                }
            };
        }

        case 'preview_schedule_deletion': {
            if (userType !== 'admin') throw new AppError('仅管理员可删除排课', 403);

            const { scheduleIds, reason } = args;

            if (!scheduleIds || scheduleIds.length === 0) {
                throw new AppError('请提供要删除的排课ID', 400);
            }

            // 检查排课是否存在并获取详细信息
            const existingSchedules = await db.query(
                `SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status,
                        t.name as teacher_name, s.name as student_name,
                        st.name as course_type, st.description as course_type_cn
                 FROM course_arrangement ca
                 JOIN teachers t ON ca.teacher_id = t.id
                 JOIN students s ON ca.student_id = s.id
                 JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.id = ANY($1)`,
                [scheduleIds]
            );

            if (existingSchedules.rows.length === 0) {
                throw new AppError('未找到指定的排课', 404);
            }

            if (existingSchedules.rows.length < scheduleIds.length) {
                const foundIds = existingSchedules.rows.map(r => r.id);
                const missingIds = scheduleIds.filter(id => !foundIds.includes(id));
                throw new AppError(`排课 ID ${missingIds.join(', ')} 不存在`, 404);
            }

            // 生成操作ID
            const operationId = `delete_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

            // 存储待确认操作
            pendingOperationStore.set(operationId, {
                type: 'delete',
                scheduleIds,
                reason,
                schedules: existingSchedules.rows,
                createdAt: Date.now()
            });

            // 5分钟后自动过期
            setTimeout(() => pendingOperationStore.delete(operationId), 5 * 60 * 1000);

            return {
                type: 'schedule_operation_preview',
                title: '删除预览',
                data: {
                    operationId,
                    operationType: 'delete',
                    affectedCount: scheduleIds.length,
                    schedules: existingSchedules.rows,
                    reason: reason || '未提供',
                    message: `即将删除 ${scheduleIds.length} 条排课`
                }
            };
        }

        case 'confirm_operation': {
            if (userType !== 'admin') throw new AppError('仅管理员可执行敏感操作', 403);

            const { operationId } = args;

            if (!operationId) {
                throw new AppError('请提供操作ID', 400);
            }

            // 从临时存储中获取操作信息
            const operation = pendingOperationStore.get(operationId);

            if (!operation) {
                throw new AppError('操作ID无效或已过期（5分钟有效期），请重新预览', 400);
            }

            // 根据操作类型执行相应逻辑
            if (operation.type === 'update') {
                // 执行修改操作
                const { scheduleIds, fields } = operation;

                const updateFields = [];
                const params = [];
                let paramCount = 1;

                // 处理课程类型
                if (fields.courseType) {
                    const courseTypeResult = await db.query('SELECT id FROM schedule_types WHERE name=$1', [fields.courseType]);
                    updateFields.push(`course_id=$${paramCount++}`);
                    params.push(courseTypeResult.rows[0].id);
                }

                // 处理其他字段
                if (fields.teacherId) { updateFields.push(`teacher_id=$${paramCount++}`); params.push(fields.teacherId); }
                if (fields.studentId) { updateFields.push(`student_id=$${paramCount++}`); params.push(fields.studentId); }
                if (fields.classDate) { updateFields.push(`class_date=$${paramCount++}`); params.push(fields.classDate); }
                if (fields.startTime) { updateFields.push(`start_time=$${paramCount++}`); params.push(fields.startTime); }
                if (fields.endTime) { updateFields.push(`end_time=$${paramCount++}`); params.push(fields.endTime); }
                if (fields.status) { updateFields.push(`status=$${paramCount++}`); params.push(fields.status); }
                if (fields.location !== undefined) { updateFields.push(`location=$${paramCount++}`); params.push(fields.location); }
                if (fields.familyParticipants !== undefined) { updateFields.push(`family_participants=$${paramCount++}`); params.push(fields.familyParticipants); }
                if (fields.transportFee !== undefined) { updateFields.push(`transport_fee=$${paramCount++}`); params.push(fields.transportFee); }
                if (fields.otherFee !== undefined) { updateFields.push(`other_fee=$${paramCount++}`); params.push(fields.otherFee); }

                updateFields.push('updated_at=CURRENT_TIMESTAMP');

                params.push(scheduleIds);
                const updateQuery = `UPDATE course_arrangement SET ${updateFields.join(', ')} WHERE id = ANY($${paramCount})`;

                await db.query(updateQuery, params);

                // 删除已执行的操作
                pendingOperationStore.delete(operationId);

                return {
                    type: 'text',
                    title: '修改成功',
                    data: {
                        message: `已成功修改 ${scheduleIds.length} 条排课`,
                        scheduleIds,
                        changedFields: operation.changes.map(c => c.field).join('、')
                    }
                };

            } else if (operation.type === 'delete') {
                // 执行删除操作
                const { scheduleIds, reason } = operation;

                await db.query('DELETE FROM course_arrangement WHERE id = ANY($1)', [scheduleIds]);

                // 删除已执行的操作
                pendingOperationStore.delete(operationId);

                const deletedList = operation.schedules.map(row => {
                    return `${row.class_date.toISOString().split('T')[0]} ${row.start_time} ${row.teacher_name}-${row.student_name} ${row.course_type_cn}`;
                });

                return {
                    type: 'text',
                    title: '删除成功',
                    data: {
                        message: `已成功删除 ${scheduleIds.length} 条排课`,
                        scheduleIds,
                        deletedSchedules: deletedList.slice(0, 5),
                        reason: reason || '未提供'
                    }
                };

            } else {
                throw new AppError('未知的操作类型', 400);
            }
        }

        case 'update_schedule_fields': {
            if (userType !== 'admin') throw new AppError('仅管理员可删除排课', 403);

            const { scheduleIds, reason } = args;

            if (!scheduleIds || scheduleIds.length === 0) {
                throw new AppError('请提供要删除的排课ID', 400);
            }

            // 检查排课是否存在
            const existingSchedules = await db.query(
                `SELECT ca.id, ca.class_date, ca.start_time, t.name as teacher_name, s.name as student_name, st.name as course_type
                 FROM course_arrangement ca
                 JOIN teachers t ON ca.teacher_id = t.id
                 JOIN students s ON ca.student_id = s.id
                 JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.id = ANY($1)`,
                [scheduleIds]
            );

            if (existingSchedules.rows.length === 0) {
                throw new AppError('未找到指定的排课', 404);
            }

            if (existingSchedules.rows.length < scheduleIds.length) {
                const foundIds = existingSchedules.rows.map(r => r.id);
                const missingIds = scheduleIds.filter(id => !foundIds.includes(id));
                throw new AppError(`排课 ID ${missingIds.join(', ')} 不存在`, 404);
            }

            // 执行删除
            await db.query(
                'DELETE FROM course_arrangement WHERE id = ANY($1)',
                [scheduleIds]
            );

            // 构建删除摘要
            const deletedList = existingSchedules.rows.map(row => {
                const courseTypeCn = translateCourseType(row.course_type);
                return `${row.class_date.toISOString().split('T')[0]} ${row.start_time} ${row.teacher_name}-${row.student_name} ${courseTypeCn}`;
            });

            return {
                type: 'text',
                title: '删除成功',
                data: {
                    message: `已删除 ${scheduleIds.length} 条排课`,
                    scheduleIds,
                    deletedSchedules: deletedList.slice(0, 5), // 最多显示5条
                    reason: reason || '未提供'
                }
            };
        }

        default:
            throw new AppError(`未知工具: ${toolName}`, 400);
    }
}

/**
 * AI 数据查询主入口
 * POST /api/ai/query
 * body: { question: string, history?: array }
 */
const query = asyncHandler(async (req, res) => {
    if (!aiService.isAvailable()) {
        throw new AppError('AI 功能未启用，请在服务端配置 AI_API_KEY 并设置 AI_ENABLED=true', 503);
    }

    const { question, history } = req.body;
    if (!question || !question.trim()) {
        throw new AppError('请输入问题', 400);
    }

    const userType = req.user.userType;

    console.log(`[AI Query] Question: ${question.substring(0, 200)}`);
    console.log(`[AI Query] User: ${req.user.id}, Type: ${userType}, History: ${history ? history.length : 0} messages`);

    const tools = DATA_TOOLS[userType] || DATA_TOOLS.teacher;

    // 计算本周四的日期和当前时间（东八区）
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const dayOfWeek = today.getDay(); // 0=周日, 4=周四
    const daysUntilThursday = (4 - dayOfWeek + 7) % 7;
    const thisThursday = new Date(today);
    thisThursday.setDate(today.getDate() + daysUntilThursday);
    const thursdayStr = thisThursday.toISOString().split('T')[0]; // YYYY-MM-DD

    // 格式化当前完整时间（东八区）
    const currentDateTime = today.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const currentWeekDay = weekDays[today.getDay()];

    const systemPrompt = userType === 'admin'
        ? `你是 Plenzo 课程管理系统的 AI 助手，主要功能是数据查询和智能排课。\n` +
          `你使用的模型是 ${process.env.AI_MODEL || 'AI'}。\n` +
          `\n你可以：\n` +
          `1. 回答关于系统的一般性问题\n` +
          `2. 查询教师、学生、课程等数据\n` +
          `3. 帮助用户智能排课、修改和删除课程\n` +
          `\n对于数据查询和排课操作，务必调用提供的工具。对于一般性对话，可以直接回答。\n` +
          `\n【当前时间信息】\n` +
          `- 当前时间：${currentDateTime}（${currentWeekDay}）\n` +
          `- 时区：东八区（Asia/Shanghai, UTC+8）\n` +
          `- 当前日期：${today.toISOString().split('T')[0]}\n` +
          `- 本周四是：${thursdayStr}\n` +
          `- 注意：所有日期计算都基于东八区时间\n` +
          `- 注意：每周第一天为周一（周一到周日为一周）\n` +
          `\n【连续对话】你可以参考之前的对话历史理解上下文，包括：\n` +
          `- 用户提到的"他"、"那个"、"这个"等指代词\n` +
          `- 之前查询过的教师、学生、课程等信息\n` +
          `- 用户的后续追问或补充说明\n` +
          `\n【修改排课】重要：修改操作需要用户确认，分两步：\n` +
          `1. 先调用 query_schedules 按条件查排课 → 获取排课ID\n` +
          `2. 如果要修改教师/学生，调用 query_teachers/query_students 查新人员 → 获取新ID\n` +
          `3. 调用 preview_schedule_update 生成修改预览 → 获取 operationId\n` +
          `4. 向用户展示预览，明确说明"请回复'确认'来执行修改"\n` +
          `5. 用户确认后，调用 confirm_operation 执行修改\n` +
          `   - 可修改字段：教师、学生、日期、时间、状态、课程类型、地点、家长参与人数、交通费、其他费用\n` +
          `\n【删除排课】重要：删除操作需要用户确认，分两步：\n` +
          `1. 先调用 query_schedules 查询要删除的排课 → 获取排课ID\n` +
          `2. 调用 preview_schedule_deletion 生成删除预览 → 获取 operationId\n` +
          `3. 向用户展示预览，明确说明"请回复'确认'来执行删除"\n` +
          `4. 用户确认后，调用 confirm_operation 执行删除\n` +
          `\n【智能排课】核心：从用户输入提取信息，结构化成排课方案，步骤：\n` +
          `1. 信息提取与识别：\n` +
          `   - 学生姓名（如：浩浩、宋林浩）\n` +
          `   - 教师姓名（如：周耀华、高渊、叶老师）→ 调用 query_teachers 模糊搜索获取ID\n` +
          `   - 日期时间（如：下周周一晚上、周六下午）→ 转换为具体日期和时间\n` +
          `   - 课程类型（如：入户、评审、半程入户）→ 映射到系统课程类型\n` +
          `   - 地点（如：新课堂、老课堂）\n` +
          `   - 特殊信息（如：待定、看情况、参加人员、记录人等）\n` +
          `2. 时间规则理解：\n` +
          `   - "晚上" = 19:00-21:30（默认2.5小时）\n` +
          `   - "下午" = 14:00-16:00（默认2小时，除非明确指定如"下午一点开始到14:30"）\n` +
          `   - "上午" = 09:00-11:00（默认2小时）\n` +
          `   - 如果用户明确指定时间段（如14:30-15:30），使用用户指定的时间\n` +
          `3. 状态判断规则：\n` +
          `   - 包含"待定"、"看情况"、"估计" → status: 'pending'（待确认）\n` +
          `   - 其他情况 → status: 'confirmed'（已确认）\n` +
          `4. 评审课程特殊处理：\n` +
          `   - 评审课程可能涉及多个教师参加（如：侯老师、叶老师、金烨成）\n` +
          `   - 识别"记录"角色（如：周耀华记录）→ 该教师为主要负责人，填入teacher_id\n` +
          `   - 其他参加教师信息可写入备注或location字段\n` +
          `5. 批量处理：\n` +
          `   - 用户输入可能包含多条排课信息（按行或分号分隔）\n` +
          `   - 逐条提取、结构化，合并成一个完整的排课方案\n` +
          `   - 不要尝试优化或调整用户的安排，严格按用户提供的信息排课\n` +
          `6. 调用 query_teachers 和 query_students 获取ID\n` +
          `7. 调用 create_schedule_preview 生成唯一的预览方案 → 获取 previewId\n` +
          `8. 展示预览，列出所有课程，明确说明"请回复'确认'来创建排课"\n` +
          `9. 用户确认后，调用 confirm_schedule_creation 创建排课\n` +
          `\n重要提醒：\n` +
          `- 不要生成多个方案供用户选择，用户的输入就是唯一方案\n` +
          `- 不要尝试"优化"用户的排课，严格按用户提供的信息执行\n` +
          `- 如果信息不完整（缺少教师、学生、时间），向用户询问缺失信息\n` +
          `\n如果工具调用失败，说明具体原因。`
        : `你是 Plenzo 课程管理系统的 AI 助手，主要功能是数据查询。\n` +
          `你使用的模型是 ${process.env.AI_MODEL || 'AI'}。\n` +
          `用户是教师 (id=${req.user.id})。用中文简洁回答。\n` +
          `\n你可以：\n` +
          `1. 回答关于系统的一般性问题\n` +
          `2. 查询课程、学生等相关数据\n` +
          `\n对于数据查询，务必调用提供的工具。对于一般性对话，可以直接回答。\n` +
          `\n【当前时间信息】\n` +
          `- 当前时间：${currentDateTime}（${currentWeekDay}）\n` +
          `- 时区：东八区（Asia/Shanghai, UTC+8）\n` +
          `- 当前日期：${today.toISOString().split('T')[0]}\n` +
          `- 注意：所有日期计算都基于东八区时间\n` +
          `- 注意：每周第一天为周一（周一到周日为一周）\n` +
          `\n你可以参考之前的对话历史理解上下文。务必调用工具获取数据。如果工具调用失败，说明具体原因。`;

    // 构建消息列表：系统提示 + 历史对话 + 当前问题
    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    // 添加历史对话（如果有）
    if (history && Array.isArray(history) && history.length > 0) {
        // 只保留最近10轮对话，避免上下文过长
        const recentHistory = history.slice(-10);
        messages.push(...recentHistory);
    }

    // 添加当前问题
    messages.push({ role: 'user', content: question });

    const toolsUsed = [];
    const toolResults = [];

    // 第一轮：让 LLM 决定调用哪些工具
    let llmResp = await aiService.chat(messages, { tools, toolChoice: 'auto' });
    let toolCalls = aiService.extractToolCalls(llmResp);

    console.log(`[aiController] First round: toolCalls=${toolCalls.length}, tools=${toolCalls.map(t => t.function.name).join(',')}`);

    // 循环执行工具调用（最多 6 轮，支持智能排课的多步操作）
    let rounds = 0;
    while (toolCalls.length > 0 && rounds < 12) {
        rounds++;
        console.log(`[aiController] Round ${rounds}: processing ${toolCalls.length} tool calls`);
        messages.push(llmResp.choices[0].message);

        for (const call of toolCalls) {
            const name = call.function.name;
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { /* noop */ }
            toolsUsed.push(name);

            console.log(`[aiController] Executing tool: ${name}, args=${JSON.stringify(args)}`);

            try {
                const result = await executeDataTool(name, args, req);
                toolResults.push({ tool: name, args, result });

                const resultStr = JSON.stringify(result).slice(0, 4000);
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: resultStr
                });
                console.log(`[aiController] Tool ${name} succeeded, type=${result.type}, dataSize=${JSON.stringify(result.data).length}`);
            } catch (err) {
                console.error(`[aiController] Tool ${name} failed:`, err.message);
                const errorMsg = `工具执行失败: ${err.message}`;
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: errorMsg
                });
            }
        }

        llmResp = await aiService.chat(messages, { tools, toolChoice: 'auto' });
        toolCalls = aiService.extractToolCalls(llmResp);
        console.log(`[aiController] After round ${rounds}: next toolCalls=${toolCalls.length}`);
    }

    const answer = aiService.extractText(llmResp) || '抱歉，我暂时无法回答这个问题。';

    console.log(`[aiController] Query completed: toolsUsed=${toolsUsed.join(',')}, resultCount=${toolResults.length}, answerLen=${answer.length}`);

    // 判断返回类型（基于工具结果）
    let responseType = 'text';
    let structuredData = null;

    if (toolResults.length > 0) {
        const lastResult = toolResults[toolResults.length - 1].result;
        if (lastResult.type) {
            responseType = lastResult.type;
            structuredData = lastResult.data;
        }
    }

    res.json(standardResponse(true, {
        type: responseType,
        answer,
        structuredData,
        toolsUsed
    }));
});

/**
 * 获取当前 AI 配置
 * GET /api/ai/config
 */
const getConfig = asyncHandler(async (req, res) => {
    const config = aiService.getAIConfig();
    res.json(standardResponse(true, {
        enabled: config.enabled,
        provider: config.provider,
        protocol: config.protocol,
        baseUrl: config.baseUrl,
        model: config.model,
        timeout: config.timeout,
        maxTokens: config.maxTokens,
        apiKey: config.apiKey ? '***已配置***' : null
    }));
});

/**
 * 获取预设 AI 模型列表
 * GET /api/ai/presets
 */
const getPresets = asyncHandler(async (req, res) => {
    const presets = getPresetModels(false); // 不包含真实 API Key
    res.json(standardResponse(true, { presets }));
});

/**
 * 更新 AI 配置
 * PUT /api/ai/config
 */
const updateConfig = asyncHandler(async (req, res) => {
    const { provider, protocol, apiKey, baseUrl, model, timeout, maxTokens, presetId } = req.body;

    // 如果是预设模型切换，从环境变量获取真实的 API Key
    let realApiKey = apiKey;
    if (presetId) {
        const presets = getPresetModels(true); // 包含真实 API Key
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
            realApiKey = preset.apiKey;
        }
    }

    if (!provider || !realApiKey || !baseUrl || !model) {
        throw new AppError('缺少必要的配置参数', 400);
    }

    // 使用配置管理器更新配置（立即生效，无需重启）
    aiConfigManager.updateAIConfig({
        provider,
        protocol: protocol || 'openai',
        apiKey: realApiKey,
        baseUrl,
        model,
        timeout: timeout || 30000,
        maxTokens: maxTokens || 3000
    });

    res.json(standardResponse(true, { message: '配置已更新并立即生效！' }));
});

/**
 * 检测 AI 模型状态（快速检测）
 * POST /api/ai/check
 */
const checkModel = asyncHandler(async (req, res) => {
    const { provider, protocol, apiKey, baseUrl, model, presetId } = req.body;

    // 如果是预设模型，从环境变量获取真实的 API Key
    let realApiKey = apiKey;
    if (presetId) {
        const presets = getPresetModels(true);
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
            realApiKey = preset.apiKey;
        }
    }

    if (!realApiKey || !baseUrl || !model) {
        return res.json(standardResponse(false, {
            available: false,
            error: '缺少必要的参数'
        }));
    }

    try {
        // 快速检测：只发送一个极简的请求来验证连接
        const testConfig = {
            enabled: true,
            provider: provider || 'custom',
            protocol: protocol || 'openai',
            apiKey: realApiKey,
            baseUrl,
            model,
            timeout: 8000, // 8秒超时
            maxTokens: 20  // 20 token 足够返回简短响应
        };

        // 保存原配置
        const originalConfig = { ...aiService.getAIConfig() };

        // 临时覆盖配置
        process.env.AI_ENABLED = 'true';
        process.env.AI_PROVIDER = testConfig.provider;
        process.env.AI_PROTOCOL = testConfig.protocol;
        process.env.AI_API_KEY = testConfig.apiKey;
        process.env.AI_BASE_URL = testConfig.baseUrl;
        process.env.AI_MODEL = testConfig.model;
        process.env.AI_TIMEOUT = testConfig.timeout.toString();
        process.env.AI_MAX_TOKENS = testConfig.maxTokens.toString();

        // 发送极简测试请求
        await aiService.chat([
            { role: 'user', content: 'test' }
        ]);

        // 恢复原配置
        process.env.AI_ENABLED = originalConfig.enabled.toString();
        process.env.AI_PROVIDER = originalConfig.provider;
        process.env.AI_PROTOCOL = originalConfig.protocol;
        process.env.AI_API_KEY = originalConfig.apiKey;
        process.env.AI_BASE_URL = originalConfig.baseUrl;
        process.env.AI_MODEL = originalConfig.model;
        process.env.AI_TIMEOUT = originalConfig.timeout.toString();
        process.env.AI_MAX_TOKENS = originalConfig.maxTokens.toString();

        res.json(standardResponse(true, {
            available: true
        }));
    } catch (error) {
        res.json(standardResponse(true, {
            available: false,
            error: error.message
        }));
    }
});

/**
 * 测试 AI 模型连接
 * POST /api/ai/test
 */
const testModel = asyncHandler(async (req, res) => {
    const { provider, protocol, apiKey, baseUrl, model, timeout, maxTokens, presetId } = req.body;

    // 如果是预设模型测试，从环境变量获取真实的 API Key
    let realApiKey = apiKey;
    if (presetId) {
        const presets = getPresetModels(true); // 包含真实 API Key
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
            realApiKey = preset.apiKey;
        }
    }

    if (!realApiKey || !baseUrl || !model) {
        throw new AppError('缺少必要的测试参数', 400);
    }

    // 临时创建测试配置
    const testConfig = {
        enabled: true,
        provider: provider || 'custom',
        protocol: protocol || 'openai',
        apiKey: realApiKey,
        baseUrl,
        model,
        timeout: timeout || 30000,
        maxTokens: 100  // 增加到 100 token，确保完整响应
    };

    // 保存原配置
    const originalConfig = { ...aiService.getAIConfig() };

    try {
        // 临时覆盖配置（通过环境变量）
        process.env.AI_ENABLED = 'true';
        process.env.AI_PROVIDER = testConfig.provider;
        process.env.AI_PROTOCOL = testConfig.protocol;
        process.env.AI_API_KEY = testConfig.apiKey;
        process.env.AI_BASE_URL = testConfig.baseUrl;
        process.env.AI_MODEL = testConfig.model;
        process.env.AI_TIMEOUT = testConfig.timeout.toString();
        process.env.AI_MAX_TOKENS = testConfig.maxTokens.toString();

        const startTime = Date.now();

        // 发送测试消息
        const response = await aiService.chat([
            { role: 'user', content: '请简单回复"测试成功"' }
        ]);

        const latency = Date.now() - startTime;
        const text = aiService.extractText(response);

        res.json(standardResponse(true, {
            success: true,
            latency,
            model: testConfig.model,
            response: text
        }));
    } catch (error) {
        res.json(standardResponse(false, {
            success: false,
            error: error.message
        }));
    } finally {
        // 恢复原配置
        process.env.AI_ENABLED = originalConfig.enabled.toString();
        process.env.AI_PROVIDER = originalConfig.provider;
        process.env.AI_PROTOCOL = originalConfig.protocol;
        process.env.AI_API_KEY = originalConfig.apiKey;
        process.env.AI_BASE_URL = originalConfig.baseUrl;
        process.env.AI_MODEL = originalConfig.model;
        process.env.AI_TIMEOUT = originalConfig.timeout.toString();
        process.env.AI_MAX_TOKENS = originalConfig.maxTokens.toString();
    }
});

/**
 * 获取所有渠道支持的模型列表
 * GET /api/ai/models
 */
const getAvailableModels = asyncHandler(async (req, res) => {
    const modelsFilePath = path.join(__dirname, '../data/ai-models.json');

    try {
        const modelsData = fs.readFileSync(modelsFilePath, 'utf8');
        const models = JSON.parse(modelsData);

        res.json(standardResponse(true, { models }));
    } catch (error) {
        // 如果文件不存在，返回空对象
        res.json(standardResponse(true, { models: {} }));
    }
});

/**
 * 获取当前模型的能力信息
 * GET /api/ai/capabilities
 */
const getModelCapabilities = asyncHandler(async (req, res) => {
    const config = aiService.getAIConfig();
    const modelsFilePath = path.join(__dirname, '../data/ai-models.json');

    try {
        const modelsData = fs.readFileSync(modelsFilePath, 'utf8');
        const allModels = JSON.parse(modelsData);

        // 根据当前配置查找对应的模型能力
        let capabilities = {
            vision: false,
            tools: false,
            reasoning: false
        };

        // 查找匹配的 provider
        for (const [provider, models] of Object.entries(allModels)) {
            const model = models.find(m => m.id === config.model);
            if (model) {
                capabilities = model.capabilities;
                break;
            }
        }

        res.json(standardResponse(true, { capabilities, model: config.model }));
    } catch (error) {
        // 默认返回不支持任何高级功能
        res.json(standardResponse(true, {
            capabilities: {
                vision: false,
                tools: false,
                reasoning: false
            },
            model: config.model
        }));
    }
});

module.exports = {
    getStatus,
    query,
    getConfig,
    getPresets,
    updateConfig,
    checkModel,
    testModel,
    getAvailableModels,
    getModelCapabilities
};
