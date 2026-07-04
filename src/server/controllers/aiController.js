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
 * 状态的中英文映射（统一使用 sharedUtils.STATUS_MAP 作为权威来源）
 */
const { STATUS_MAP: STATUS_MAPPING, getStatusLabel: translateStatus } = require('../utils/sharedUtils');

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
 * 获取日期对应的星期几（中文）
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} 周一~周日
 */
function getDayOfWeek(dateStr) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const d = new Date(dateStr + 'T00:00:00+08:00');
    return days[d.getDay()];
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

/** Map 最大条目数，防止内存泄漏 */
const MAX_STORE_SIZE = 500;

/**
 * 清理过期条目并限制 Map 大小
 */
function pruneStore(store) {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (entry && entry.expireAt && now > entry.expireAt) {
            store.delete(key);
        }
    }
    // 如果仍然超过上限，删除最早的条目
    while (store.size > MAX_STORE_SIZE) {
        const firstKey = store.keys().next().value;
        store.delete(firstKey);
    }
}

// 每 5 分钟清理一次
setInterval(() => {
    pruneStore(schedulePreviewStore);
    pruneStore(pendingOperationStore);
}, 5 * 60 * 1000).unref();

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
                description: '查询学生列表，返回 id, name, nickname, profession, status。可通过姓名或昵称模糊搜索学生。',
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'integer', enum: [0, 1], description: '0=禁用 1=启用' },
                        name: { type: 'string', description: '学生姓名（模糊匹配）' },
                        nickname: { type: 'string', description: '学生昵称（模糊匹配）' }
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
                description: '根据可用时段生成排课预览方案。支持两种模式：\n' +
                    '1. 单组模式：传 teacherId+studentId+courseType+slots\n' +
                    '2. 批量模式：传 groups 数组（多教师多课程一次性预览，表格自动排序）',
                parameters: {
                    type: 'object',
                    properties: {
                        teacherId: { type: 'integer', description: '教师ID（单组模式）' },
                        studentId: { type: 'integer', description: '学生ID（单组模式）' },
                        courseType: { type: 'string', description: '课程类型名称（单组模式）' },
                        location: { type: 'string', description: '上课地点（单组模式）' },
                        slots: {
                            type: 'array',
                            description: '时段列表（单组模式）',
                            items: {
                                type: 'object',
                                properties: {
                                    date: { type: 'string', description: 'YYYY-MM-DD' },
                                    startTime: { type: 'string', description: 'HH:MM:SS' },
                                    endTime: { type: 'string', description: 'HH:MM:SS' }
                                },
                                required: ['date', 'startTime', 'endTime']
                            }
                        },
                        groups: {
                            type: 'array',
                            description: '批量排课分组（批量模式，用于评审/咨询等多教师场景）',
                            items: {
                                type: 'object',
                                properties: {
                                    teacherId: { type: 'integer', description: '教师ID' },
                                    studentId: { type: 'integer', description: '学生ID' },
                                    courseType: { type: 'string', description: '课程类型name字段（如 visit/review/review_record 等）' },
                                    location: { type: 'string', description: '上课地点' },
                                    slots: {
                                        type: 'array',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                date: { type: 'string', description: 'YYYY-MM-DD' },
                                                startTime: { type: 'string', description: 'HH:MM:SS' },
                                                endTime: { type: 'string', description: 'HH:MM:SS' },
                                                status: { type: 'string', description: '状态：confirmed/pending' }
                                            },
                                            required: ['date', 'startTime', 'endTime']
                                        }
                                    }
                                },
                                required: ['teacherId', 'studentId', 'courseType', 'slots']
                            }
                        }
                    }
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
                                courseType: { type: 'string', description: '新课程类型名称（name字段）：visit/half_visit/review/review_record/consultation/consultation_record/trial/group_activity等' },
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
        },
        {
            type: 'function',
            function: {
                name: 'query_students',
                description: '查询学生列表，返回 id, name, nickname, profession, status。可通过姓名或昵称模糊搜索学生。',
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'integer', enum: [0, 1], description: '0=禁用 1=启用' },
                        name: { type: 'string', description: '学生姓名（模糊匹配）' },
                        nickname: { type: 'string', description: '学生昵称（模糊匹配）' }
                    }
                }
            }
        }
    ],
    student: [
        {
            type: 'function',
            function: {
                name: 'query_my_overview',
                description: '查询当前学生的总览数据：本周/本月/本年课程数、待确认/已完成/已取消',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_my_schedules',
                description: '查询当前学生的课程列表，支持按日期范围和状态筛选',
                parameters: {
                    type: 'object',
                    properties: {
                        startDate: { type: 'string', description: 'YYYY-MM-DD' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD' },
                        status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled', 'completed'] }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_my_statistics',
                description: '查询当前学生的学习统计数据：按课程类型统计、按月统计',
                parameters: {
                    type: 'object',
                    properties: {
                        startDate: { type: 'string', description: 'YYYY-MM-DD，开始日期' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD，结束日期' }
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

            let query = 'SELECT id, name, nickname, profession, status FROM students';
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

            if (args.nickname) {
                conditions.push(`nickname LIKE $${paramCount++}`);
                params.push(`%${args.nickname}%`);
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
            if (userType !== 'teacher' && userType !== 'student') throw new AppError('仅教师和学生可查询', 403);

            const idField = userType === 'teacher' ? 'teacher_id' : 'student_id';

            const [week, month, year, pending, confirmed, cancelled] = await Promise.all([
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE ${idField}=$1 AND class_date>=CURRENT_DATE-7`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE ${idField}=$1 AND EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)
                    AND EXTRACT(MONTH FROM class_date)=EXTRACT(MONTH FROM CURRENT_DATE)`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE ${idField}=$1 AND EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE ${idField}=$1 AND status='pending'`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE ${idField}=$1 AND status='confirmed'`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE ${idField}=$1 AND status='cancelled'`, [userId])
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
            if (userType !== 'teacher' && userType !== 'student') throw new AppError('仅教师和学生可查询', 403);

            const idField = userType === 'teacher' ? 'teacher_id' : 'student_id';
            const joinField = userType === 'teacher' ? 's.name as student_name' : 't.name as teacher_name';

            let query = `SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status,
                        ${joinField}, st.name as course_type
                        FROM course_arrangement ca
                        JOIN teachers t ON ca.teacher_id=t.id
                        JOIN students s ON ca.student_id=s.id
                        JOIN schedule_types st ON ca.course_id=st.id
                        WHERE ca.${idField}=$1`;
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
                title: '我的课程',
                data: translatedData
            };
        }

        case 'query_my_statistics': {
            if (userType !== 'student') throw new AppError('仅学生可查询学习统计', 403);

            // 默认查询最近3个月
            const startDate = args.startDate || new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString().split('T')[0];
            const endDate = args.endDate || new Date().toISOString().split('T')[0];

            const [typeStats, monthlyStats] = await Promise.all([
                db.query(`SELECT st.name as category, st.description as category_cn, COUNT(*) as count
                    FROM course_arrangement ca
                    JOIN schedule_types st ON ca.course_id=st.id
                    WHERE ca.student_id=$1 AND ca.class_date>=$2 AND ca.class_date<=$3
                    GROUP BY st.name, st.description ORDER BY count DESC`, [userId, startDate, endDate]),
                db.query(`SELECT TO_CHAR(ca.class_date, 'YYYY-MM') as month, COUNT(*) as count
                    FROM course_arrangement ca
                    WHERE ca.student_id=$1 AND ca.class_date>=$2 AND ca.class_date<=$3
                    GROUP BY month ORDER BY month`, [userId, startDate, endDate])
            ]);

            return {
                type: 'chart_data',
                title: '学习统计',
                data: {
                    typeStats: typeStats.rows,
                    monthlyStats: monthlyStats.rows,
                    period: { startDate, endDate }
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

            const { groups } = args;
            const isBatch = Array.isArray(groups) && groups.length > 0;

            // 统一为 groups 格式
            const normalizedGroups = isBatch ? groups : [{
                teacherId: args.teacherId,
                studentId: args.studentId,
                courseType: args.courseType,
                location: args.location,
                slots: args.slots
            }];

            // 收集所有唯一ID，批量预加载（避免 N+1 查询）
            const teacherIds = [...new Set(normalizedGroups.map(g => g.teacherId).filter(Boolean))];
            const studentIds = [...new Set(normalizedGroups.map(g => g.studentId).filter(Boolean))];
            const courseTypeNames = [...new Set(normalizedGroups.map(g => g.courseType).filter(Boolean))];

            const [teachersResult, studentsResult, courseTypesResult] = await Promise.all([
                teacherIds.length ? db.query('SELECT id, name FROM teachers WHERE id=ANY($1) AND status=1', [teacherIds]) : { rows: [] },
                studentIds.length ? db.query('SELECT id, name FROM students WHERE id=ANY($1) AND status=1', [studentIds]) : { rows: [] },
                courseTypeNames.length ? db.query('SELECT id, name, description FROM schedule_types WHERE name=ANY($1)', [courseTypeNames]) : { rows: [] }
            ]);

            const teacherMap = Object.fromEntries(teachersResult.rows.map(r => [r.id, r]));
            const studentMap = Object.fromEntries(studentsResult.rows.map(r => [r.id, r]));
            const courseTypeMap = Object.fromEntries(courseTypesResult.rows.map(r => [r.name, r]));

            // 验证并收集所有排课数据
            const allSchedules = [];
            const previewGroups = [];

            for (const group of normalizedGroups) {
                const { teacherId, studentId, courseType, location, slots } = group;
                if (!teacherId || !studentId || !courseType || !slots?.length) continue;

                const teacher = teacherMap[teacherId];
                const student = studentMap[studentId];
                if (!teacher) throw new AppError(`教师 ID ${teacherId} 不存在或已禁用`, 404);
                if (!student) throw new AppError(`学生 ID ${studentId} 不存在或已禁用`, 404);

                const courseTypeRow = courseTypeMap[courseType];
                if (!courseTypeRow) throw new AppError(`课程类型 ${courseType} 不存在`, 404);

                const courseId = courseTypeRow.id;
                const courseTypeCn = courseTypeRow.description || courseType;

                previewGroups.push({
                    teacherId, studentId, courseId,
                    teacherName: teacher.name,
                    studentName: student.name,
                    courseTypeCn, location: location || null,
                    slots: slots.map(s => ({ date: s.date, startTime: s.startTime, endTime: s.endTime, status: s.status }))
                });

                for (const slot of slots) {
                    allSchedules.push({
                        class_date: slot.date,
                        day_of_week: getDayOfWeek(slot.date),
                        start_time: slot.startTime,
                        end_time: slot.endTime,
                        teacher_id: teacher.id,
                        teacher_name: teacher.name,
                        student_name: student.name,
                        course_type_cn: courseTypeCn,
                        location: location || null,
                        status: slot.status || 'confirmed',
                        status_cn: slot.status === 'pending' ? '待确认' : '已确认'
                    });
                }
            }

            // 按日期和时间排序
            allSchedules.sort((a, b) => `${a.class_date} ${a.start_time}`.localeCompare(`${b.class_date} ${b.start_time}`));

            // 生成预览ID
            const previewId = `preview_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            schedulePreviewStore.set(previewId, { previewId, groups: previewGroups, createdAt: new Date().toISOString() });
            setTimeout(() => schedulePreviewStore.delete(previewId), 5 * 60 * 1000);

            const uniqueTeachers = [...new Set(previewGroups.map(g => g.teacherName))];
            const uniqueStudents = [...new Set(previewGroups.map(g => g.studentName))];
            const uniqueCourses = [...new Set(previewGroups.map(g => g.courseTypeCn))];

            return {
                type: 'schedule_preview',
                title: '排课预览方案',
                data: {
                    previewId,
                    teacher: uniqueTeachers.join('、'),
                    student: uniqueStudents.join('、'),
                    courseType: uniqueCourses.join('、'),
                    totalCount: allSchedules.length,
                    schedules: allSchedules
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

            // 兼容批量模式（groups）和旧单组模式
            const groups = previewData.groups || [{
                teacherId: previewData.teacherId,
                studentId: previewData.studentId,
                courseId: previewData.courseId,
                location: previewData.location,
                slots: previewData.slots
            }];

            // 批量插入排课
            const insertedIds = [];
            for (const group of groups) {
                const { teacherId, studentId, courseId, location, slots } = group;
                for (const slot of slots) {
                    const result = await db.query(
                        `INSERT INTO course_arrangement
                        (teacher_id, student_id, course_id, class_date, start_time, end_time, status, location, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        RETURNING id`,
                        [teacherId, studentId, courseId, slot.date, slot.startTime, slot.endTime, slot.status || 'confirmed', location || null]
                    );
                    insertedIds.push(result.rows[0].id);
                }
            }

            // 删除预览数据
            schedulePreviewStore.delete(previewId);

            const uniqueTeachers = [...new Set(groups.map(g => g.teacherName).filter(Boolean))];
            const uniqueStudents = [...new Set(groups.map(g => g.studentName).filter(Boolean))];

            return {
                type: 'text',
                title: '排课创建成功',
                data: {
                    message: `成功创建 ${insertedIds.length} 条排课记录`,
                    scheduleIds: insertedIds,
                    teacher: uniqueTeachers.join('、'),
                    student: uniqueStudents.join('、'),
                    courseType: groups.map(g => g.courseTypeCn).filter(Boolean).join('、')
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

        default:
            throw new AppError(`未知工具: ${toolName}`, 400);
    }
}

/**
 * 工具名称 → 用户友好的进度消息
 */
function getToolProgressMessage(toolNames) {
    const messages = {
        query_teachers: '正在查询教师信息...',
        query_students: '正在查询学生信息...',
        query_schedules: '正在查询排课记录...',
        query_schedule_stats: '正在查询排课统计...',
        create_schedule_preview: '正在生成排课预览...',
        preview_schedule_update: '正在生成修改预览...',
        preview_schedule_deletion: '正在生成删除预览...',
        confirm_schedule_creation: '正在创建排课...',
        confirm_operation: '正在执行操作...',
    };
    const unique = [...new Set(toolNames)];
    const msgs = unique.map(n => messages[n]).filter(Boolean);
    return msgs.length > 0 ? msgs[0] : '正在处理数据...';
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

    // 输入长度验证（防止滥用 token 配额）
    if (question.length > 2000) {
        throw new AppError('问题长度不能超过 2000 个字符', 400);
    }
    if (history && Array.isArray(history) && history.length > 20) {
        throw new AppError('对话历史不能超过 20 条消息', 400);
    }

    // SSE 模式设置响应头
    const useStream = req.body.stream === true;

    const userType = req.user.userType;


    const tools = DATA_TOOLS[userType] || DATA_TOOLS.teacher;

    // 计算当前时间（东八区）
    const now = new Date();
    const today = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const dayOfWeek = today.getDay(); // 0=周日, 1=周一

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

    // 计算本周和下周的具体日期范围（东八区）
    // today 已经是东八区时间的 Date 对象，dayOfWeek 已在上方计算
    const todayStr = today.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // YYYY-MM-DD
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // 本周一的偏移（dayOfWeek: 0=周日）
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() + mondayOffset);
    const mondayStr = thisMonday.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); // 本周一 YYYY-MM-DD
    const nextMonday = new Date(thisMonday);
    nextMonday.setDate(thisMonday.getDate() + 7);
    const nextSunday = new Date(nextMonday);
    nextSunday.setDate(nextMonday.getDate() + 6);

    // 生成下周每天的具体日期
    const nextWeekDays = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(nextMonday);
        d.setDate(nextMonday.getDate() + i);
        const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        nextWeekDays.push(`${['周一','周二','周三','周四','周五','周六','周日'][i]}=${dateStr}`);
    }
    const nextWeekDateMap = nextWeekDays.join(' | ');

    // 生成本周每天的具体日期
    const thisWeekDays = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(thisMonday);
        d.setDate(thisMonday.getDate() + i);
        const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        thisWeekDays.push(`${['周一','周二','周三','周四','周五','周六','周日'][i]}=${dateStr}`);
    }
    const thisWeekDateMap = thisWeekDays.join(' | ');

    // 动态加载课程类型和教师列表（用于系统提示，帮助 LLM 精确匹配）
    let courseTypeListStr = '';
    let teacherListStr = '';
    try {
        const [ctResult, tResult] = await Promise.all([
            db.query('SELECT name, description FROM schedule_types ORDER BY id'),
            db.query("SELECT name FROM teachers WHERE status=1 ORDER BY id")
        ]);
        courseTypeListStr = ctResult.rows.map(r => `${r.name}（${r.description}）`).join(' | ');
        teacherListStr = tResult.rows.map(r => r.name).join('、');
    } catch (_) { /* 静默失败，不影响主流程 */ }

    const systemPrompt = userType === 'admin'
        ? `你是 Plenzo 课程管理系统 AI 助手，中文回答。\n` +
          `\n# 当前时间\n` +
          `${currentDateTime}（${currentWeekDay}），时区东八区(UTC+8)，每周第一天是周一\n` +
          `今日：${todayStr}\n` +
          `本周日期：${thisWeekDateMap}\n` +
          `下周日期：${nextWeekDateMap}\n` +
          `\n# 排课规则\n` +
          `\n## 输入格式\n` +
          `格式A 紧凑单条："下周四，19-22，[地点]，[学生]，[教师]，[课程类型]"\n` +
          `格式B 批量列表（每行一条，括号内为补充信息）：\n` +
          `  周一晚上 [学生昵称/姓名]入户（[教师姓名/昵称1]，[地点]）\n` +
          `  周六下午 [学生昵称/姓名]评审（[教师姓名/昵称2]记录，[教师姓名/昵称3]估计参加，[教师姓名/昵称4]尽量去，下午暂定一点到三点，[地点]）\n` +
          `括号内逐项识别：教师姓名 | "记录"紧跟教师名→评审/咨询记录负责人 | 地点 | 具体时间（覆盖默认值） | 其他文字→备注\n` +
          `\n## 课程类型（数据库 name 字段，必须精确匹配）\n` +
          (courseTypeListStr ? `${courseTypeListStr}\n` : '') +
          `禁止使用近似名称（如"半程入户"不可写成"半次入户"）。\n` +
          `\n## 已有教师（精确匹配姓名，不存在则询问用户）\n` +
          (teacherListStr ? `${teacherListStr}\n` : '（暂无教师数据）\n') +
          `\n## 学生姓名解析\n` +
          `用户可能使用昵称（如"浩浩"）或姓名。排课前必须先通过 query_students 查询学生ID：\n` +
          `- 用姓名查：query_students(name:"张三")\n` +
          `- 用昵称查：query_students(nickname:"浩浩")\n` +
          `- 不确定时同时查两个字段，根据返回结果匹配\n` +
          `\n## 时间解析\n` +
          `时段默认值：晚上=19:00-21:45 | 下午=14:00-17:00 | 上午=09:00-12:00\n` +
          `时间格式："19-22"→19:00-22:00 | "15-18点"→15:00-18:00 | "一点到三点"→13:00-15:00 | 无时间→用默认值\n` +
          `状态："待定"/"看情况"/"可能"→pending | 其他→confirmed\n` +
          `\n## 评审/咨询课程（每个参与教师生成独立记录，使用相同时间和地点）\n` +
          `教师名后有"记录"字样 → 课程类型为"评审记录"或"咨询记录"，该教师已包含评审/咨询，不再重复生成。\n` +
          `其他参与教师各生成一条评审/咨询记录。\n` +
          `示例输入：[学生昵称/姓名]评审（[教师姓名/昵称2]记录，[教师姓名/昵称3]估计参加，[教师姓名/昵称4]尽量去，下午一点到三点，[地点]）\n` +
          `示例输出：①[教师姓名/昵称2]+评审记录 ②[教师姓名/昵称3]+评审 ③[教师姓名/昵称4]+评审\n` +
          `\n# 操作流程\n` +
          `\n## 查询\n` +
          `直接调用查询工具，不需要预览确认。可用工具：\n` +
          `- query_overview：总览统计\n` +
          `- query_schedules：排课列表（支持按日期、教师、学生筛选）\n` +
          `- query_teachers / query_students：教师/学生列表\n` +
          `- query_schedule_stats：排课统计\n` +
          `\n## 排课（预览→确认）\n` +
          `日期必须从上方"本周日期"/"下周日期"映射表查表得出，禁止自行推算。\n` +
          `批量排课逐条独立解析，不允许合并或跳过。\n` +
          `1. query_teachers/query_students 获取ID\n` +
          `2. 每条输入解析为独立 group，一次性提交：create_schedule_preview(groups:[...])\n` +
          `3. 展示预览 → 用户确认 → confirm_schedule_creation(previewId)\n` +
          `\n## 修改排课（预览→确认）\n` +
          `1. query_schedules 查询 → 2. preview_schedule_update(scheduleIds, fields) 展示变更 → 3. 用户确认 → confirm_operation(operationId)\n` +
          `\n## 删除排课（预览→确认）\n` +
          `1. query_schedules 查询 → 2. preview_schedule_deletion(scheduleIds) 展示预览 → 3. 用户确认 → confirm_operation(operationId)\n` +
          `\n# 回复格式\n` +
          `文本简短（1-2句）。查询结果和预览表格按日期+时间升序，评审/咨询合并显示，记录老师排最后标注"（记录）"。\n` +
          `\n# 规则\n` +
          `严格按用户输入执行，不优化不调整。信息不完整时询问，不猜测。工具失败说明原因。\n` +
          `所有写操作必须先预览再确认，禁止跳过。收到"确认"指令时直接调用 confirm 工具。\n` +
          `支持多轮上下文。"他"/"那个"→指代之前的教师/学生/课程；追问可补充信息，例："取消[学生昵称/姓名]周四的课" → "改成周五" = 修改。`
        : userType === 'student'
        ? `你是 Plenzo 课程管理系统 AI 助手，用中文简洁回答。\n` +
          `用户是学生 (id=${req.user.id})。\n` +
          `\n当前时间：${currentDateTime}（${currentWeekDay}），时区东八区(UTC+8)，每周第一天是周一。今日：${todayStr}\n` +
          `\n能力：\n` +
          `1. 回答系统一般性问题\n` +
          `2. 查询个人课程安排、学习统计等数据\n` +
          `\n可用工具：\n` +
          `- query_my_schedules：查询个人课表（支持按日期范围筛选）\n` +
          `- query_my_statistics：查询个人学习统计\n` +
          `- query_my_overview：查询个人总览\n` +
          `\n规则：数据查询务必调用工具，一般性对话可直接回答。工具失败说明原因。支持多轮上下文。`
        : `你是 Plenzo 课程管理系统 AI 助手，用中文简洁回答。\n` +
          `用户是教师 (id=${req.user.id})。\n` +
          `\n当前时间：${currentDateTime}（${currentWeekDay}），时区东八区(UTC+8)，每周第一天是周一。今日：${todayStr}\n` +
          `\n能力：\n` +
          `1. 回答系统一般性问题\n` +
          `2. 查询课程、学生等相关数据\n` +
          `\n可用工具：\n` +
          `- query_my_schedules：查询个人课表（支持按日期范围筛选）\n` +
          `- query_my_overview：查询个人总览\n` +
          `- query_students：查询学生列表（支持按姓名/昵称搜索）\n` +
          `\n规则：数据查询务必调用工具，一般性对话可直接回答。工具失败说明原因。支持多轮上下文。`;

    // 直接处理确认操作（不依赖 LLM 调用工具，避免 LLM 只返回文本不调用工具的问题）
    const confirmMatch = question.match(/确认创建排课.*previewId[:\s]+(\S+)/);
    if (confirmMatch) {
        const previewIdStr = confirmMatch[1];
        const previewIds = previewIdStr.split(',').filter(Boolean);

        const allInsertedIds = [];
        for (const pid of previewIds) {
            try {
                const result = await executeDataTool('confirm_schedule_creation', { previewId: pid.trim() }, req);
                if (result.data && result.data.scheduleIds) {
                    allInsertedIds.push(...result.data.scheduleIds);
                }
            } catch (err) {
                // skip failed preview
            }
        }

        const answerText = allInsertedIds.length > 0
            ? `成功创建 ${allInsertedIds.length} 条排课记录`
            : '排课创建失败，请重试';

        const responseData = {
            type: 'text',
            answer: answerText,
            structuredData: { message: answerText, scheduleIds: allInsertedIds },
            toolsUsed: ['confirm_schedule_creation']
        };

        if (useStream) {
            res.write(`data: ${JSON.stringify({ type: 'result', data: responseData })}\n\n`);
            return res.end();
        }
        return res.json(standardResponse(true, responseData));
    }

    const confirmOpMatch = question.match(/确认执行操作.*operationId[:\s]+(\S+)/);
    if (confirmOpMatch) {
        const operationId = confirmOpMatch[1];
        const result = await executeDataTool('confirm_operation', { operationId }, req);
        const answerText = result.data.message || '操作执行成功';

        const responseData = {
            type: result.type || 'text',
            answer: answerText,
            structuredData: result.data,
            toolsUsed: ['confirm_operation']
        };

        if (useStream) {
            res.write(`data: ${JSON.stringify({ type: 'result', data: responseData })}\n\n`);
            return res.end();
        }
        return res.json(standardResponse(true, responseData));
    }

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

    // 添加当前问题（注入日期上下文，确保 AI 不会忽略系统提示中的日期映射）
    const dateContext = `[日期参考] 今日：${todayStr}（${currentWeekDay}）| 本周：${thisWeekDateMap} | 下周：${nextWeekDateMap}\n\n`;
    messages.push({ role: 'user', content: dateContext + question });

    const toolsUsed = [];
    const toolResults = [];

    try {
    // SSE 模式设置响应头（在 try 块内，确保错误能被正确处理）
    if (useStream) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
    }

    // SSE 辅助函数
    const sendSSE = useStream ? (eventType, payload) => {
        res.write(`data: ${JSON.stringify({ type: eventType, ...payload })}\n\n`);
    } : () => {};

    // 第一轮：让 LLM 决定调用哪些工具
    sendSSE('progress', { step: 'thinking', message: '正在分析您的问题...' });
    let llmResp = await aiService.chat(messages, { tools, toolChoice: 'auto' });
    let toolCalls = aiService.extractToolCalls(llmResp);

    // 循环执行工具调用（最多 12 轮，支持智能排课的多步操作）
    let rounds = 0;
    while (toolCalls.length > 0 && rounds < 12) {
        rounds++;
        messages.push(llmResp.choices[0].message);

        // 发送工具执行进度
        const toolNames = toolCalls.map(t => t.function.name);
        sendSSE('progress', { step: 'executing', message: getToolProgressMessage(toolNames) });

        // 并行执行所有工具调用
        const toolCallResults = await Promise.all(toolCalls.map(async (call) => {
            const name = call.function.name;
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { /* noop */ }
            toolsUsed.push(name);

            try {
                const result = await executeDataTool(name, args, req);
                toolResults.push({ tool: name, args, result });
                const resultStr = JSON.stringify(result);
                const safeContent = resultStr.length > 4000
                    ? resultStr.slice(0, 3990) + '...(已截断)'
                    : resultStr;
                return { role: 'tool', tool_call_id: call.id, content: safeContent };
            } catch (err) {
                return { role: 'tool', tool_call_id: call.id, content: `工具执行失败: ${err.message}` };
            }
        }));
        messages.push(...toolCallResults);

        sendSSE('progress', { step: 'thinking', message: '正在整理结果...' });
        llmResp = await aiService.chat(messages, { tools, toolChoice: 'auto' });
        toolCalls = aiService.extractToolCalls(llmResp);
    }

    const answer = aiService.extractText(llmResp) || '抱歉，我暂时无法回答这个问题。';

    // 判断返回类型（基于工具结果）
    let responseType = 'text';
    let structuredData = null;

    if (toolResults.length > 0) {
        const lastResult = toolResults[toolResults.length - 1].result;
        if (lastResult.type) {
            responseType = lastResult.type;
            structuredData = lastResult.data;
        }

        // 合并多个 schedule_preview 结果（批量排课场景）
        const previewResults = toolResults.filter(r => r.result.type === 'schedule_preview');
        if (previewResults.length > 1) {
            responseType = 'schedule_preview';
            const allSchedules = [];
            const previewIds = [];
            let totalTeacher = '';
            let totalStudent = '';
            let totalCourseType = '';

            for (const pr of previewResults) {
                const d = pr.result.data;
                if (d.schedules) allSchedules.push(...d.schedules);
                if (d.previewId) previewIds.push(d.previewId);
                if (d.teacher) totalTeacher = d.teacher;
                if (d.student) totalStudent = d.student;
                if (d.courseType) totalCourseType = d.courseType;
            }

            structuredData = {
                previewId: previewIds.join(','),  // 多个 previewId 用逗号分隔
                teacher: totalTeacher,
                student: totalStudent,
                courseType: totalCourseType,
                totalCount: allSchedules.length,
                schedules: allSchedules
            };
        }
    }

    if (useStream) {
        sendSSE('progress', { step: 'done', message: '完成' });
        res.write(`data: ${JSON.stringify({ type: 'result', data: { type: responseType, answer, structuredData, toolsUsed } })}\n\n`);
        res.end();
    } else {
        res.json(standardResponse(true, {
            type: responseType,
            answer,
            structuredData,
            toolsUsed
        }));
    }

    } catch (err) {
        if (useStream && res.headersSent) {
            // SSE 头已发送，通过 SSE 发送错误
            try {
                res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || '查询失败，请稍后重试' })}\n\n`);
                res.end();
            } catch (_) { try { res.end(); } catch (_) {} }
        } else if (useStream) {
            // SSE 头未发送，返回 JSON 错误
            return res.status(err.statusCode || 500).json(
                standardResponse(false, null, err.message || '查询失败')
            );
        } else {
            throw err; // 非 SSE 模式交给 asyncHandler 处理
        }
    }
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
        // 快速检测：使用临时配置，避免修改全局 process.env（消除竞态条件）
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

        // 发送极简测试请求（通过 configOverride 传入临时配置）
        await aiService.chat([
            { role: 'user', content: 'test' }
        ], { configOverride: testConfig });

        res.json(standardResponse(true, {
            available: true
        }));
    } catch (error) {
        console.error('[AI] 可用性检查失败:', error.message || error);
        res.json(standardResponse(true, {
            available: false,
            error: '服务暂不可用'
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

    // 使用临时配置（通过 configOverride 传入，避免修改全局 process.env）
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

    try {
        const startTime = Date.now();

        // 发送测试消息（通过 configOverride 传入临时配置）
        const response = await aiService.chat([
            { role: 'user', content: '请简单回复"测试成功"' }
        ], { configOverride: testConfig });

        const latency = Date.now() - startTime;
        const text = aiService.extractText(response);

        res.json(standardResponse(true, {
            success: true,
            latency,
            model: testConfig.model,
            response: text
        }));
    } catch (error) {
        console.error('[AI] 模型测试失败:', error.message || error);
        res.json(standardResponse(false, {
            success: false,
            error: 'AI 服务请求失败'
        }));
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
