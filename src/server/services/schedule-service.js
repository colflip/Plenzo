/**
 * 智能排课服务 (Schedule Service)
 * @description 处理排课核心业务逻辑，包括时间冲突检测、智能匹配、排课创建与状态管理
 * @module services/scheduleService
 */

const db = require('../db/db');
const { AppError } = require('../middleware/error');
const SchemaHelper = require('../utils/schema-helper');
const logger = require('../utils/logger');
const { standardResponse } = require('../middleware/validation');
const { buildScopeClause, canTouchRecord, requiresOwnDataScope } = require('../utils/admin-permissions');

/**
 * 权限落地（Phase 1）：为 L3 操作员追加「仅自己创建 + 无主存量」范围过滤。
 * 非 L3 原样返回 sql；L3 则把 actorId 追加进 params 并拼接 WHERE 条件。
 */
function applyOwnerScope(sql, params, user, alias = 'ca') {
    const scope = buildScopeClause(user, alias);
    if (!scope) return sql;
    params.push(scope.actorId);
    return `${sql} AND ${scope.clause.replace('$ACTOR_ID', `$${params.length}`)}`;
}

// 课程状态枚举（与 teacher-controller 的 LESSON_STATUS_SET 保持一致，供 teacherUpdateScheduleStatus 使用）
const LESSON_STATUS_SET = new Set(['pending', 'confirmed', 'completed', 'cancelled']);

// 辅助函数：根据时间段返回 [start, end]
function slotToRange(slot) {
    switch (slot) {
        case 'morning': return ['08:00', '12:00'];
        case 'afternoon': return ['13:00', '17:00'];
        case 'evening': return ['18:00', '24:00'];
        default: return [null, null];
    }
}

/**
 * 动态获取日期列表达式
 * @description 兼容不同数据库 schema 版本
 */
let caDateExprCache = null;
async function getCaDateExpr() {
    if (caDateExprCache) return caDateExprCache;
    try {
        // 列存在性检测统一走 SchemaHelper（保留本地 COALESCE 多列合并逻辑，零行为变化）
        const cols = await SchemaHelper.getColumns('course_arrangement', ['arr_date', 'class_date', 'date']);
        const parts = [];
        if (cols.has('arr_date')) parts.push('arr_date');
        if (cols.has('class_date')) parts.push('class_date');
        if (cols.has('date')) parts.push('date');
        const expr = parts.length > 1 ? `COALESCE(${parts.join(', ')})` : (parts[0] || 'date');
        caDateExprCache = expr;
        return expr;
    } catch (_) {
        caDateExprCache = 'date';
        return caDateExprCache;
    }
}

class ScheduleService {
    /**
     * 获取可用教师列表
     * @param {string} date - 日期
     * @param {string} timeSlot - 时段 (morning/afternoon/evening)
     * @param {string} startTime - 自定义开始时间 (HH:mm)
     * @param {string} endTime - 自定义结束时间 (HH:mm)
     */
    async getAvailableTeachers(date, timeSlot, startTime, endTime) {
        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        if (!qStart || !qEnd) {
            throw new AppError('必须指定时段或具体起止时间', 400);
        }

        const caDateExpr = await getCaDateExpr();
        const queryFn = `
            SELECT DISTINCT t.*
            FROM teachers t
            JOIN teacher_daily_availability ta ON t.id = ta.teacher_id
            WHERE ta.date = $1
            AND ta.status = 'available'
            AND (ta.start_time, ta.end_time) OVERLAPS ($2::time, $3::time)
            AND NOT EXISTS (
                SELECT 1
                FROM course_arrangement ca
                WHERE ca.teacher_id = t.id
                AND ${caDateExpr} = $1
                AND (ca.start_time, ca.end_time) OVERLAPS ($2::time, $3::time)
                AND ca.status NOT IN ('cancelled', 'modified_away')
            )
        `;

        const result = await db.query(queryFn, [date, qStart, qEnd]);
        return result.rows;
    }

    /**
     * 获取可用学生列表
     * @param {string} date
     * @param {string} timeSlot
     * @param {string} startTime
     * @param {string} endTime
     */
    async getAvailableStudents(date, timeSlot, startTime, endTime) {
        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        if (!qStart || !qEnd) {
            throw new AppError('必须指定时段或具体起止时间', 400);
        }

        const studentCaDateExpr = await getCaDateExpr();
        const queryFn = `
            SELECT DISTINCT s.*
            FROM students s
            JOIN student_daily_availability sa ON s.id = sa.student_id
            WHERE sa.date = $1
            AND sa.status = 'available'
            AND (sa.start_time, sa.end_time) OVERLAPS ($2::time, $3::time)
            AND NOT EXISTS (
                SELECT 1
                FROM course_arrangement ca
                WHERE ca.student_id = s.id
                AND ${studentCaDateExpr} = $1
                AND (ca.start_time, ca.end_time) OVERLAPS ($2::time, $3::time)
                AND ca.status NOT IN ('cancelled', 'modified_away')
            )
        `;

        const result = await db.query(queryFn, [date, qStart, qEnd]);
        return result.rows;
    }

    /**
     * 检查冲突 (原子性检查)
     * @description 用于事务内部或单独调用
     */
    async checkConflicts(teacherId, studentId, date, timeSlot, startTime, endTime, client = null) {
        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        const caDateExpr = await getCaDateExpr();
        const executeQuery = client ? client.query.bind(client) : db.query.bind(db);

        // 1. 完全重复检查
        const dupRes = await executeQuery(
            `SELECT id, teacher_id, student_id, course_id, ${caDateExpr} as date, start_time, end_time, status, location
             FROM course_arrangement
             WHERE teacher_id = $1 AND student_id = $2 AND ${caDateExpr} = $3
               AND start_time = $4 AND end_time = $5 AND status NOT IN ('cancelled', 'modified_away')
             LIMIT 1`,
            [teacherId, studentId, date, qStart, qEnd]
        );
        if (dupRes.rows.length > 0) {
            return { hasConflicts: true, type: 'duplicate', message: '存在完全重复的排课记录', existing: dupRes.rows[0] };
        }

        // 2. 教师时间冲突
        const teacherConflict = await executeQuery(
            `SELECT id, teacher_id, student_id, course_id, ${caDateExpr} as date, start_time, end_time, status, location
             FROM course_arrangement 
             WHERE teacher_id = $1 
               AND ${caDateExpr} = $2 
               AND (start_time, end_time) OVERLAPS ($3::time, $4::time) 
               AND status NOT IN ('cancelled', 'modified_away')
             LIMIT 1`,
            [teacherId, date, qStart, qEnd]
        );
        if (teacherConflict.rows.length > 0) {
            return { hasConflicts: true, type: 'overlap_teacher', message: '教师时间段与现有排课重叠', existing: teacherConflict.rows[0] };
        }

        // 3. 学生时间冲突
        const studentConflict = await executeQuery(
            `SELECT id, teacher_id, student_id, course_id, ${caDateExpr} as date, start_time, end_time, status, location
             FROM course_arrangement 
             WHERE student_id = $1 
               AND ${caDateExpr} = $2 
               AND (start_time, end_time) OVERLAPS ($3::time, $4::time) 
               AND status NOT IN ('cancelled', 'modified_away')
             LIMIT 1`,
            [studentId, date, qStart, qEnd]
        );
        if (studentConflict.rows.length > 0) {
            return { hasConflicts: true, type: 'overlap_student', message: '学生时间段与现有排课重叠', existing: studentConflict.rows[0] };
        }

        return { hasConflicts: false };
    }

    /**
     * 创建课程安排 (支持多学生批量)
     */
    async createSchedule(data, userId) {
        const { teacherId, studentIds, date, timeSlot, startTime, endTime, scheduleTypes, location, adjustment_type, is_temp, isTemp } = data;

        // 参数归一化
        const courseId = Array.isArray(scheduleTypes) ? scheduleTypes[0] : scheduleTypes;
        if (!courseId) throw new AppError('缺少课程类型', 400);

        const createdIds = [];
        const caDateExpr = await getCaDateExpr();

        // 使用事务
        await db.runInTransaction(async (client) => {
            // 逐个学生检查冲突并插入
            for (const studentId of studentIds) {
                const conflict = await this.checkConflicts(
                    teacherId, studentId, date, timeSlot, startTime, endTime, client
                );

                if (conflict.hasConflicts) {
                    throw new AppError(conflict.message, 400, { type: conflict.type, existing: conflict.existing });
                }

                const insertQuery = `
                    INSERT INTO course_arrangement
                    (teacher_id, student_id, course_id, ${caDateExpr}, start_time, end_time, location, status, created_by, adjustment_type)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $9)
                    RETURNING id
                `;

                const res = await client.query(insertQuery, [
                    teacherId, studentId, courseId, date, startTime, endTime, location || null, userId, 
                    adjustment_type !== undefined ? adjustment_type : (isTemp || is_temp ? 1 : 0)
                ]);
                createdIds.push(res.rows[0].id);
            }
        });

        return { ids: createdIds };
    }

    /**
     * 获取所有课程类型
     */
    async getScheduleTypes() {
        const result = await db.query('SELECT * FROM schedule_types ORDER BY name');
        return result.rows;
    }

    /**
     * 确认排课状态
     */
    async confirmSchedule(scheduleId, operatorId, isOperatorAdmin) {
        // 1. 检查排课是否存在
        const checkRes = await db.query('SELECT teacher_id, status FROM course_arrangement WHERE id = $1', [scheduleId]);
        if (checkRes.rows.length === 0) {
            throw new AppError('课程不存在', 404);
        }

        const schedule = checkRes.rows[0];

        // 2. 权限检查: 只有授课教师本人或管理员可确认
        if (!isOperatorAdmin && schedule.teacher_id !== operatorId) {
            throw new AppError('无权操作此课程', 403);
        }

        // 3. 更新状态
        await db.query(
            "UPDATE course_arrangement SET status = 'confirmed' WHERE id = $1",
            [scheduleId]
        );

        return { success: true };
    }

    /**
     * 管理员：获取排课列表（逻辑下沉自 admin-controller.getSchedules）
     */
    async adminListSchedules(req) {
        try {
            let { startDate, endDate, status, type, course_id } = req.query;
            // 兼容前端传递的 course_id 或 type 参数名
            type = type || course_id;
            // 兼容：若未提供日期，则使用极大范围作为默认值（用于测试或前端未传参场景）
            if (!startDate || !endDate) {
                startDate = startDate || '1970-01-01';
                endDate = endDate || '2099-12-31';
            }

            const dateExpr = await SchemaHelper.getDateExpr('ca');
            const values = [startDate, endDate];

            // 检测 teacher/student 表是否包含 status 字段（统一经 SchemaHelper）
            const [teacherHasStatus, studentHasStatus] = await Promise.all([
                SchemaHelper.hasColumn('teachers', 'status'),
                SchemaHelper.hasColumn('students', 'status')
            ]);

            // 基础 SQL：关联教师与学生以便能够按账号状态过滤，同时关联课程类型获取中文名称
            let sql = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time,
                    ca.end_time,
                    ca.status,
                    ca.teacher_id,
                    t.name AS teacher_name,
                    ca.student_id,
                    s.name AS student_name,
                    ca.course_id,
                    COALESCE(stt.description, stt.name) AS schedule_type_cn,
                    ca.location,
                    ca.transport_fee,
                    ca.other_fee,
                    ca.adjustment_type,
                    ca.fee_status
                FROM course_arrangement ca
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN students s ON ca.student_id = s.id
                LEFT JOIN schedule_types stt ON ca.course_id = stt.id
                WHERE ${dateExpr} BETWEEN $1 AND $2
            `;

            if (teacherHasStatus) sql += ` AND t.status = 1`;
            if (studentHasStatus) sql += ` AND s.status = 1`;

            if (status) {
                values.push(status);
                sql += ` AND ca.status = $${values.length}`;
            }
            if (type) {
                values.push(type);
                sql += ` AND ca.course_id = $${values.length}`;
            }

            // 费用报销状态过滤（与排课状态 status 分开）
            const feeStatus = req.query.fee_status;
            if (feeStatus) {
                values.push(feeStatus);
                sql += ` AND ca.fee_status = $${values.length}`;
            }

            // [新增] 隐藏已调整且调整类型为0的记录 (Hide modified_away with adjustment_type 0)
            // 兼容字符串与布尔（Joi boolean 校验会把 'true' 转为布尔 true）
            if (String(req.query.show_plan) !== 'true') {
                sql += ` AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)`;
            }

            // 权限落地：L3 仅见自己创建 + 无主存量
            sql = applyOwnerScope(sql, values, req && req.user, "ca");

            sql += ` ORDER BY ${dateExpr} ASC, ca.start_time ASC`;

            const result = await db.query(sql, values);
            return { status: 200, body: result.rows || [] };
        } catch (error) {
            logger.error('获取排课列表错误:', error);
            return { status: 503, body: { message: '数据库暂时不可用，请稍后重试' } };
        }
    }

    /**
     * 管理员：获取单条排课详情（逻辑下沉自 admin-controller.getScheduleById）
     */
    async adminGetScheduleById(req) {
        try {
            const { id } = req.params;
            const numId = Number(id);
            if (!Number.isInteger(numId) || numId <= 0) {
                return { status: 400, body: { message: '无效的排课ID' } };
            }
            // 日期列表达式统一经 SchemaHelper（ca 别名，配合 FROM course_arrangement ca）
            const dateExpr = await SchemaHelper.getDateExpr('ca');

            // 防御性兜底：family_participants 是后期加入的可选列，部分存量生产库可能缺失。
            // 缺失时跳过该列，避免 GET /admin/schedules/:id 因 undefined_column 抛 500（卡片无法打开）。
            const baseCols = [
                'ca.id', 'ca.teacher_id', 'ca.student_id', 'ca.course_id',
                'ca.status', 'ca.start_time', 'ca.end_time', 'ca.location', 'ca.adjustment_type'
            ];
            if (await SchemaHelper.hasColumn('course_arrangement', 'family_participants')) {
                baseCols.push('ca.family_participants');
            }

            let detailSql = `SELECT ${baseCols.join(', ')},
                        ${dateExpr} AS date
                 FROM course_arrangement ca
                 WHERE ca.id = $1`;
            const detailParams = [numId];

            // 权限落地：L3 访问他人创建的记录视为不存在（不暴露存在性）
            const scope = buildScopeClause(req && req.user, "ca");
            if (scope) {
                detailParams.push(scope.actorId);
                detailSql += ` AND (ca.created_by = $${detailParams.length} OR ca.created_by IS NULL)`;
            }

            const result = await db.query(detailSql, detailParams);
            if (result.rows.length === 0) {
                return { status: 404, body: { message: '未找到排课记录' } };
            }
            return { status: 200, body: result.rows[0] };
        } catch (error) {
            logger.error('获取排课详情错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 管理员：获取网格视图排课（逻辑下沉自 admin-controller.getSchedulesGrid）
     */
    async adminGetSchedulesGrid(req) {
        try {
            const { start_date, end_date, status, type_id, course_id, teacher_id } = req.query;
            // 兼容前端传递的 course_id 或 type_id 参数名
            const effectiveTypeId = type_id || course_id;
            if (!start_date || !end_date) {
                return { status: 400, body: { message: '缺少开始/结束日期' } };
            }

            const dateExpr = await SchemaHelper.getDateExpr('ca');
            const teacherHasStatus = await SchemaHelper.hasColumn('teachers', 'status');
            const studentHasStatus = await SchemaHelper.hasColumn('students', 'status');

            let sql = `
                SELECT
                    ca.id,
                    s.id AS student_id,
                    s.name AS student_name,
                    t.id AS teacher_id,
                    t.name AS teacher_name,
                    ca.course_id,
                    stt.name AS schedule_type,
                    COALESCE(stt.description, stt.name) AS schedule_types,
                    COALESCE(stt.description, stt.name) AS schedule_type_cn,
                    ${dateExpr} AS date,
                    ca.start_time,
                    ca.end_time,
                    ca.location,
                    ca.status,
                    ca.transport_fee,
                    ca.other_fee,
                    ca.fee_status,
                    ca.adjustment_type
                FROM course_arrangement ca
                JOIN students s ON ca.student_id = s.id
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types stt ON ca.course_id = stt.id
                WHERE ${dateExpr}::date >= $1::date AND ${dateExpr}::date <= $2::date
            `;
            const params = [start_date, end_date];

            if (status) {
                sql += ` AND ca.status = $${params.length + 1}`;
                params.push(status);
            }
            if (effectiveTypeId) {
                sql += ` AND ca.course_id = $${params.length + 1}`;
                params.push(effectiveTypeId);
            }

            // [新增] 隐藏已调整且调整类型为0的记录 (Hide modified_away with adjustment_type 0)
            // 兼容字符串与布尔（Joi boolean 校验会把 'true' 转为布尔 true）
            if (String(req.query.show_plan) !== 'true') {
                sql += ` AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)`;
            }

            // 过滤删除状态：允许正常与暂停，但不显示删除
            if (teacherHasStatus) sql += ` AND t.status <> -1`;
            if (studentHasStatus) sql += ` AND s.status <> -1`;
            if (teacher_id) {
                sql += ` AND ca.teacher_id = $${params.length + 1}`;
                params.push(teacher_id);
            }

            // 权限落地：L3 仅见自己创建 + 无主存量
            sql = applyOwnerScope(sql, params, req && req.user, "ca");

            sql += ` ORDER BY ${dateExpr} ASC, s.id ASC, ca.start_time ASC`;

            const result = await db.query(sql, params);
            const rows = result.rows || [];

            // 数据完整性检查（基本时间有效性）
            const safeRows = rows.map(r => {
                const toMin = (t) => {
                    const m = /^([0-2]?\d):([0-5]\d)$/.exec(String(t || ''));
                    return m ? (Number(m[1]) * 60 + Number(m[2])) : NaN;
                };
                const sv = toMin(r.start_time), ev = toMin(r.end_time);
                const valid = !Number.isNaN(sv) && !Number.isNaN(ev) && ev > sv;
                return { ...r, valid };
            });

            return { status: 200, body: safeRows };
        } catch (error) {
            logger.error('获取网格排课错误:', error);
            return { status: 503, body: standardResponse(false, null, '数据库暂时不可用，请稍后重试') };
        }
    }

    /**
     * 管理员：创建排课（逻辑下沉自 admin-controller.createSchedule）
     */
    async adminCreateSchedule(req) {
        try {
            const {
                teacherId,
                date,
                timeSlot,
                startTime,
                endTime,
                studentIds,
                scheduleTypes,
                location,
                status,
                resolve_strategy,
                is_temp
            } = req.body;

            // 使用统一事务封装，支持 pool client 与 serverless 回退
            let createdScheduleId = null;
            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);

                // 验证教师与学生状态必须为1(正常)（列存在性统一经 SchemaHelper，schema 级检测与事务无关）
                const hasTeacherStatus = await SchemaHelper.hasColumn('teachers', 'status');
                const hasStudentStatus = await SchemaHelper.hasColumn('students', 'status');
                if (hasTeacherStatus) {
                    const tRes = await q('SELECT status FROM teachers WHERE id = $1', [teacherId]);
                    if (!tRes.rows.length) throw Object.assign(new Error('教师不存在'), { statusCode: 400 });
                    const tStatus = Number(tRes.rows[0].status);
                    if (tStatus !== 1) throw Object.assign(new Error('教师状态非正常，无法参与排课'), { statusCode: 400 });
                }
                const firstStudentId = Array.isArray(studentIds) ? studentIds[0] : studentIds;
                if (hasStudentStatus && firstStudentId != null) {
                    const sRes = await q('SELECT status FROM students WHERE id = $1', [firstStudentId]);
                    if (!sRes.rows.length) throw Object.assign(new Error('学生不存在'), { statusCode: 400 });
                    const sStatus = Number(sRes.rows[0].status);
                    if (sStatus !== 1) throw Object.assign(new Error('学生状态非正常，无法参与排课'), { statusCode: 400 });
                }

                // 适配新结构：每条 course_arrangement 代表一个学生的具体安排
                const firstTypeId = Array.isArray(scheduleTypes) ? scheduleTypes[0] : scheduleTypes;

                // 日期列表达式统一经 SchemaHelper（无别名，配合 INSERT 列名）
                const dateExpr = await SchemaHelper.getDateExpr(null);
                // 基础验证：时间格式与先后关系
                function toMinutes(t) {
                    const m = /^([0-2]?\d):([0-5]\d)$/.exec(String(t || ''));
                    if (!m) return NaN;
                    return Number(m[1]) * 60 + Number(m[2]);
                }
                const sMin = toMinutes(startTime);
                const eMin = toMinutes(endTime);
                if (isNaN(sMin) || isNaN(eMin)) {
                    throw Object.assign(new Error('开始/结束时间格式不正确（HH:MM）'), { statusCode: 400, payload: { errors: [{ field: 'time', message: '开始/结束时间格式不正确（HH:MM）' }] } });
                }
                if (eMin <= sMin) {
                    throw Object.assign(new Error('结束时间必须晚于开始时间'), { statusCode: 400, payload: { errors: [{ field: 'time', message: '结束时间必须晚于开始时间' }] } });
                }

                // 允许完全重复：不进行重复检测（同一教师/学生/日期/时间段也允许保留多条）

                // 冲突检测移除：允许教师同一时间段存在多条排课
                const overlapPredicate = `NOT (end_time <= $3 OR start_time >= $4)`;
                // 学生冲突（如提供）
                // 学生重叠允许：不阻断创建，满足同一时间段同一学生可存在多条记录的需求
                // 地点冲突移除：允许地点同一时间段存在多条排课

                // 按传入状态写入，默认 pending，且限制为几种合法状态
                const allowedStatuses = new Set(['pending', 'confirmed', 'cancelled', 'completed', 'modified_away']);
                const nextStatus = allowedStatuses.has(String(status || '').trim()) ? String(status).trim() : 'pending';
                // Family participants
                const familyParticipants = req.body.family_participants !== undefined ? Number(req.body.family_participants) : 4;

                const insertSql = `INSERT INTO course_arrangement (teacher_id, student_id, course_id, ${dateExpr}, start_time, end_time, status, location, created_by, family_participants, adjustment_type)
                               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                               RETURNING id`;
                const insertResult = await q(
                    insertSql,
                    [teacherId, firstStudentId, firstTypeId, date, startTime, endTime, nextStatus, location || null, req.user.id, familyParticipants, (is_temp === 1 || is_temp === '1' || is_temp === true) ? 1 : null]
                );

                // 保存结果，事务提交后再发送响应
                createdScheduleId = insertResult.rows[0].id;
            });
            // 事务成功提交后才发送响应
            return { status: 201, body: { id: createdScheduleId, skipped_students: Array.isArray(studentIds) ? Math.max(0, studentIds.length - 1) : 0 } };
        } catch (error) {
            logger.error('创建排课错误:', error);
            // 友好错误映射
            const msg = String(error?.message || '');
            if (error.code === '23503') { // foreign_key_violation
                return { status: 400, body: { message: '外键约束冲突', errors: [{ field: 'fk', message: '教师/学生/类型不存在或已被删除' }] } };
            } else if (error.code === '23514') { // check_violation
                return { status: 400, body: { message: '检查约束冲突', errors: [{ field: 'check', message: '不符合数据库检查约束' }] } };
            }
            // 结构化错误（由事务内抛出）支持携带 statusCode / payload
            if (error.statusCode && Number(error.statusCode) >= 400 && Number(error.statusCode) < 600) {
                const status = Number(error.statusCode);
                const payload = error.payload || {};
                return { status, body: Object.assign({ message: error.message }, payload) };
            }
            return { status: 500, body: { message: '服务器错误', errors: [{ field: 'db', message: '数据库错误' }] } };
        }
    }

    /**
     * 管理员：更新排课（逻辑下沉自 admin-controller.updateSchedule）
     */
    async adminUpdateSchedule(req) {
        try {
            const { id } = req.params;
            let resData = null;
            // 使用 snake_case 字段以匹配验证规则
            const {
                teacher_id,
                date,
                start_time,
                end_time,
                student_ids,
                type_ids,
                status,
                location,
                family_participants,
                is_temp
            } = req.body;

            // 将更新逻辑放入事务中，确保读取-验证-更新在同一连接上执行
            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);

                // 日期列表达式统一经 SchemaHelper（无别名，配合 FROM/INSERT 列名）
                const dateExpr = await SchemaHelper.getDateExpr(null);

                // 读取当前记录，便于缺省字段沿用现值并做冲突校验
                const currentRes = await q(`
                  SELECT id, teacher_id, student_id, course_id, ${dateExpr} AS date, start_time, end_time, location, family_participants, created_by, status, adjustment_type
                  FROM course_arrangement WHERE id = $1
                `, [id]);
                if (currentRes.rows.length === 0) {
                    throw Object.assign(new Error('排课不存在'), { statusCode: 404 });
                }
                const current = currentRes.rows[0];

                // 权限落地：L3 只能修改自己创建或无主的记录；越权视为不存在
                if (!canTouchRecord(current.created_by, req && req.user)) {
                    throw Object.assign(new Error('排课不存在'), { statusCode: 404 });
                }

                // 适配并计算生效更新值
                const nextStudentId = Array.isArray(student_ids) ? student_ids[0] : student_ids;
                const nextTypeId = Array.isArray(type_ids) ? type_ids[0] : type_ids;
                const effTeacherId = (teacher_id != null) ? teacher_id : current.teacher_id;
                const effStudentId = (nextStudentId != null) ? nextStudentId : current.student_id;
                const effTypeId = (nextTypeId != null) ? nextTypeId : current.course_id;
                const effDate = (date != null && date !== '') ? date : current.date;
                const effStart = (start_time != null && start_time !== '') ? start_time : current.start_time;
                const effEnd = (end_time != null && end_time !== '') ? end_time : current.end_time;
                const effLocation = (location !== undefined) ? (location || null) : current.location;

                // 验证教师与学生状态（列存在性统一经 SchemaHelper）
                const hasTeacherStatus = await SchemaHelper.hasColumn('teachers', 'status');
                const hasStudentStatus = await SchemaHelper.hasColumn('students', 'status');
                if (hasTeacherStatus) {
                    const tRes = await q('SELECT status FROM teachers WHERE id = $1', [effTeacherId]);
                    if (!tRes.rows.length) throw Object.assign(new Error('教师不存在'), { statusCode: 400 });
                    if (Number(tRes.rows[0].status) !== 1) throw Object.assign(new Error('教师状态非正常，无法参与排课'), { statusCode: 400 });
                }
                if (hasStudentStatus) {
                    const sRes = await q('SELECT status FROM students WHERE id = $1', [effStudentId]);
                    if (!sRes.rows.length) throw Object.assign(new Error('学生不存在'), { statusCode: 400 });
                    if (Number(sRes.rows[0].status) !== 1) throw Object.assign(new Error('学生状态非正常，无法参与排课'), { statusCode: 400 });
                }

                // 时间格式校验 (兼容 HH:MM 和 HH:MM:SS)
                function toMinutes(t) {
                    const m = /^([0-2]?\d):([0-5]\d)(?::([0-5]\d))?$/.exec(String(t || ''));
                    if (!m) return NaN;
                    return Number(m[1]) * 60 + Number(m[2]);
                }
                const sMin = toMinutes(effStart);
                const eMin = toMinutes(effEnd);
                if (isNaN(sMin) || isNaN(eMin)) throw Object.assign(new Error('开始/结束时间格式不正确（HH:MM）'), { statusCode: 400, payload: { errors: [{ field: 'time', message: '开始/结束时间格式不正确（HH:MM）' }] } });
                if (eMin <= sMin) throw Object.assign(new Error('结束时间必须晚于开始时间'), { statusCode: 400, payload: { errors: [{ field: 'time', message: '结束时间必须晚于开始时间' }] } });

                // [重要] 如果状态被设为 'modified_away'，且原状态不是 'modified_away' 且原纪录是非增补课程 (adjustment_type != 2)，执行“逻辑作废+增补”逻辑
                if (status === 'modified_away' && current.status !== 'modified_away' && Number(current.adjustment_type || 0) !== 2) {
                     // 1. 将现记录置为 modified_away （仅更新状态）
                     await q(`UPDATE course_arrangement SET status = 'modified_away', adjustment_type = 0 WHERE id = $1`, [id]);

                     // 2. 插入新的一笔作为调整后的实际课程，类型标记为 2 (临时改动)
                     const insertSql = `
                        INSERT INTO course_arrangement
                        (teacher_id, student_id, course_id, ${dateExpr}, start_time, end_time, location, family_participants, status, created_by, adjustment_type)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', $9, 2)
                        RETURNING id
                     `;
                     const creatorId = req.user ? req.user.id : current.created_by;
                     const effFamilyParticipants = (family_participants !== undefined) ?
                        (family_participants === null ? 4 : Number(family_participants)) :
                        (current.family_participants === null ? 4 : Number(current.family_participants));

                     const newRes = await q(insertSql, [
                        effTeacherId, effStudentId, effTypeId, effDate, effStart, effEnd, effLocation,
                        isNaN(effFamilyParticipants) ? 4 : effFamilyParticipants, creatorId
                     ]);

                     resData = standardResponse(true, { newId: newRes.rows[0].id }, '排课已成功调整，原记录已归档');
                     return;
                }

                // 正常更新流程
                const sets = [];
                const values = [];
                let vi = 1;
                if (teacher_id != null) { sets.push(`teacher_id = $${vi++}`); values.push(teacher_id); }
                if (date != null) { sets.push(`${dateExpr} = $${vi++}`); values.push(date); }
                if (start_time != null) { sets.push(`start_time = $${vi++}`); values.push(start_time); }
                if (end_time != null) { sets.push(`end_time = $${vi++}`); values.push(end_time); }
                if (status != null) {
                    const allowedStatuses = new Set(['pending', 'confirmed', 'cancelled', 'completed', 'modified_away']);
                    const finalStatus = allowedStatuses.has(String(status).trim()) ? String(status).trim() : current.status;
                    sets.push(`status = $${vi++}`);
                    values.push(finalStatus);
                }
                if (nextStudentId != null) { sets.push(`student_id = $${vi++}`); values.push(nextStudentId); }
                if (nextTypeId != null) { sets.push(`course_id = $${vi++}`); values.push(nextTypeId); }
                if (location !== undefined) { sets.push(`location = $${vi++}`); values.push(location || null); }
                if (family_participants !== undefined) { sets.push(`family_participants = $${vi++}`); values.push((family_participants === null) ? 4 : Number(family_participants)); }

                // 权限落地：L3 修改无主记录时自动认领归属
                if (requiresOwnDataScope(req && req.user) && (current.created_by === null || current.created_by === undefined)) {
                    sets.push(`created_by = $${vi++}`);
                    values.push(req.user.id);
                }

                // 适配 adjustment_type
                const adjType = req.body.adjustment_type !== undefined ? req.body.adjustment_type : (req.body.is_temp ? 1 : undefined);
                // adjustment_type=2 是「调整」流程写入的溯源标记（增补记录），不是用户可编辑属性。
                // 普通更新一律不得把它改掉，否则记录会丢失「调」水印与报销/统计口径
                // （历史上编辑表单默认回传 adjustment_type=0，正是这样把已调整记录降级成普通课程的）。
                const isSupplementary = Number(current.adjustment_type || 0) === 2;
                if (adjType !== undefined && !isSupplementary) {
                    sets.push(`adjustment_type = $${vi++}`);
                    values.push(adjType);
                } else if (adjType !== undefined && isSupplementary && Number(adjType) !== 2) {
                    logger.warn(`[adminUpdateSchedule] 忽略对增补记录 ${id} 的 adjustment_type 降级请求（${current.adjustment_type} → ${adjType}）`);
                }

                if (sets.length === 0) throw Object.assign(new Error('无更新字段'), { statusCode: 400 });

                const sql = `UPDATE course_arrangement SET ${sets.join(', ')} WHERE id = $${vi}`;
                values.push(id);
                await q(sql, values);

                resData = standardResponse(true, null, '排课更新成功');
            });

            if (!resData) {
                return { status: 400, body: standardResponse(false, null, '未检测到任何字段修改') };
            }
            return { status: 200, body: resData };
        } catch (error) {
            logger.error('更新排课错误:', error);

            // 友好错误映射
            let mapped = { message: '服务器错误', code: error.code || 'UNKNOWN_ERROR', errors: [] };
            if (error.statusCode === 404) {
                 return { status: 404, body: standardResponse(false, null, error.message) };
            }

            if (error.code === '23505') { // unique_violation
                mapped.message = '数据唯一性约束冲突';
                mapped.errors = [{ field: 'unique', message: '相同教师/学生/时间段的排课已存在' }];
            } else if (error.code === '23503') { // foreign_key_violation
                mapped.message = '外键约束冲突';
                mapped.errors = [{ field: 'fk', message: '教师/学生/类型不存在或已被删除' }];
            } else if (error.code === '23514') { // check_violation
                mapped.message = '检查约束冲突';
                mapped.errors = [{ field: 'check', message: '不符合数据库检查约束' }];
            } else {
                mapped.errors = [{ field: 'db', message: '数据库操作失败' }];
            }
            return { status: error.statusCode || 500, body: standardResponse(false, null, mapped.message, mapped.errors) };
        }
    }

    /**
     * 管理员：删除排课（逻辑下沉自 admin-controller.deleteSchedule）
     */
    async adminDeleteSchedule(req) {
        try {
            const { id } = req.params;

            // 先验证排课是否存在（含 L3 归属校验：越权视为不存在）
            const existing = await db.query('SELECT id, created_by FROM course_arrangement WHERE id = $1', [id]);
            if (!existing.rows || existing.rows.length === 0) {
                return { status: 404, body: { message: '未找到该排课记录' } };
            }
            if (!canTouchRecord(existing.rows[0].created_by, req && req.user)) {
                return { status: 404, body: { message: '未找到该排课记录' } };
            }

            await db.runInTransaction(async (client, usePool) => {
                const q = usePool ? db.query : client.query.bind(client);
                await q('DELETE FROM course_arrangement WHERE id = $1', [id]);
            });
            // 事务成功提交后才发送响应
            return { status: 200, body: { message: '排课删除成功' } };
        } catch (error) {
            logger.error('删除排课错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 管理员：确认排课（逻辑下沉自 admin-controller.confirmSchedule）
     */
    async adminConfirmSchedule(req) {
        try {
            const { id } = req.params;
            const { adminConfirmed } = req.body;

            // 权限落地：先校验存在性与 L3 归属（越权视为不存在）
            const targetRes = await db.query('SELECT id, created_by FROM course_arrangement WHERE id = $1', [id]);
            if (!targetRes.rows || targetRes.rows.length === 0) {
                return { status: 404, body: { message: '未找到排课记录' } };
            }
            if (!canTouchRecord(targetRes.rows[0].created_by, req && req.user)) {
                return { status: 404, body: { message: '未找到排课记录' } };
            }

            // 适配新结构：更新 course_arrangement 状态，并维护更新时间
            // 注意：数据库schema中不包含notes字段，避免引用不存在的列
            await db.query(
                `UPDATE course_arrangement
                 SET status = CASE WHEN $2 THEN 'confirmed' ELSE status END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [id, !!adminConfirmed]
            );

            return { status: 200, body: { message: '课程确认状态更新成功' } };
        } catch (error) {
            logger.error('确认课程错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 教师：获取排课列表（逻辑下沉自 teacher-controller.getSchedules）
     */
    async teacherListSchedules(req) {
        try {
            const { startDate, endDate, status } = req.query;

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            let query = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.teacher_id, ca.location,
                    t.name as teacher_name,
                    ca.transport_fee, ca.other_fee,
                    ca.fee_status,
                    ca.adjustment_type,
                    ca.adjustment_type AS is_temp,
                    st.name as student_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            if (await SchemaHelper.hasColumn('teachers', 'status')) query += ` AND t.status = 1`;
            if (await SchemaHelper.hasColumn('students', 'status')) query += ` AND st.status = 1`;

            const values = [req.user.id, startDate, endDate];

            if (status) {
                query += ` AND ca.status = $4`;
                values.push(status);
            }

            // 费用报销状态过滤
            if (req.query.fee_status) {
                query += ` AND ca.fee_status = $${values.length + 1}`;
                values.push(req.query.fee_status);
            }

            // 默认隐藏调走的原课程；"显示全部安排"时与管理员端一致展示
            // 兼容字符串与布尔（Joi boolean 校验会把 'true' 转为布尔 true）
            if (String(req.query.show_plan) !== 'true') {
                query += ` AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)`;
            }

            query += ` ORDER BY date, ca.start_time`;

            const result = await db.query(query, values);
            return { status: 200, body: result.rows };
        } catch (error) {
            logger.error('获取课程安排错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 教师：确认课程（逻辑下沉自 teacher-controller.confirmSchedule）
     */
    async teacherConfirmSchedule(req) {
        try {
            const { id } = req.params;
            const { teacherConfirmed, notes } = req.body;

            // 查询课程信息，验证是否是该教师的课程
            const schedule = await db.query(
                'SELECT id, teacher_id FROM course_arrangement WHERE id = $1',
                [id]
            );

            if (schedule.rows.length === 0) {
                return { status: 404, body: { message: '未找到相关课程' } };
            }

            if (Number(schedule.rows[0].teacher_id) !== Number(req.user.id) && req.user.userType !== 'admin') {
                return { status: 403, body: { message: '无权操作' } };
            }

            // 更新课程状态与教师评价备注
            await db.query(
                `UPDATE course_arrangement
                 SET status = CASE
                        WHEN $2::boolean THEN 'confirmed'
                        ELSE COALESCE(status, 'pending')
                    END,
                     teacher_comment = COALESCE($3, teacher_comment),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1`,
                [id, !!teacherConfirmed, notes || null]
            );

            return { status: 200, body: { message: '课程确认状态更新成功' } };
        } catch (error) {
            logger.error('确认课程错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 教师：更新课程状态（逻辑下沉自 teacher-controller.updateScheduleStatus）
     */
    async teacherUpdateScheduleStatus(req) {
        try {
            const { id } = req.params;
            const { status, notes } = req.body || {};

            if (!status) {
                return { status: 400, body: { message: '缺少课程状态' } };
            }

            // 规范化并验证状态值
            const normalizedStatus = String(status).trim().toLowerCase();
            if (!LESSON_STATUS_SET.has(normalizedStatus)) {
                return { status: 400, body: { message: '非法的课程状态值' } };
            }

            // 获取排课详细信息以进行权限检查
            const scheduleCheck = await db.query('SELECT teacher_id, student_id FROM course_arrangement WHERE id = $1', [id]);
            if (scheduleCheck.rows.length === 0) {
                return { status: 404, body: { message: '未找到相关课程' } };
            }

            const { teacher_id, student_id } = scheduleCheck.rows[0];
            let hasPermission = false;

            if (teacher_id === req.user.id) {
                hasPermission = true; // 自己是任课教师
            } else {
                // 检查是否为该学生班主任
                const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [req.user.id]);
                if (teacherResult.rows.length > 0 && teacherResult.rows[0].student_ids) {
                    const studentIdsStr = teacherResult.rows[0].student_ids;
                    const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
                    if (studentIds.includes(Number(student_id))) {
                        hasPermission = true;
                    }
                }
            }

            if (!hasPermission) {
                return { status: 403, body: { message: '无权修改该课程状态（非本人任课且不属于所负责学生）' } };
            }

            const result = await db.query(
                `UPDATE course_arrangement
                 SET status = $2,
                     teacher_comment = COALESCE($3, teacher_comment),
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $1
                 RETURNING id, status, start_time, end_time, location`,
                [id, normalizedStatus, notes || null]
            );

            return { status: 200, body: { message: '课程状态更新成功', schedule: result.rows[0] } };
        } catch (error) {
            logger.error('更新课程状态错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 教师：获取详细排课数据（逻辑下沉自 teacher-controller.getDetailedSchedules）
     */
    async teacherGetDetailedSchedules(req) {
        try {
            const { startDate, endDate } = req.query;
            const limit = Math.min(1000, Number(req.query.limit) || 0) || null;
            const offset = Number(req.query.offset) || 0;

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            let query = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.teacher_id, ca.location,
                    st.name as student_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            if (await SchemaHelper.hasColumn('teachers', 'status')) query += ` AND t.status = 1`;
            if (await SchemaHelper.hasColumn('students', 'status')) query += ` AND st.status = 1`;

            const values = [req.user.id, startDate, endDate];

            query += ` ORDER BY date, ca.start_time`;
            if (limit) {
                query += ` LIMIT $${values.length + 1} OFFSET $${values.length + 2}`;
                values.push(limit, offset);
            }

            const result = await db.query(query, values);
            return { status: 200, body: result.rows };
        } catch (error) {
            logger.error('获取详细排课数据错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 教师：获取班主任关联学生排课（逻辑下沉自 teacher-controller.getHeadTeacherStudentSchedules）
     */
    async teacherGetHeadTeacherStudentSchedules(req) {
        try {
            const { startDate, endDate } = req.query;

            // 获取教师信息和绑定的学生 ID
            const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [req.user.id]);
            if (teacherResult.rows.length === 0) {
                return { status: 404, body: { message: '未找到教师信息' } };
            }

            const studentIdsStr = teacherResult.rows[0].student_ids;
            if (!studentIdsStr) {
                return { status: 200, body: { students: [], schedules: [] } }; // 没有绑定学生
            }

            // 解析绑定学生IDs
            const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
            if (studentIds.length === 0) {
                return { status: 200, body: { students: [], schedules: [] } };
            }

            // 查询所有关联学生的基本信息（即使没有排课也要显示）
            const studentsResult = await db.query(
                `SELECT id, name FROM students WHERE id = ANY($1::int[]) ORDER BY id`,
                [studentIds]
            );
            const students = studentsResult.rows;

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            // 查询关联学生的所有课程，过滤掉已取消的
            let query = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location, ca.transport_fee, ca.other_fee,
                    ca.fee_status,
                    ca.adjustment_type,
                    ca.adjustment_type AS is_temp,
                    t.name as teacher_name, t.id as teacher_id,
                    st.name as student_name, st.id as student_id,
                    sty.name as schedule_type, sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.student_id = ANY($1::int[])
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            if (String(req.query.show_plan) !== 'true') {
                query += ` AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)`;
            }

            // 费用报销状态过滤（班主任视图同样支持）
            const headParams = [studentIds, startDate, endDate];
            if (req.query.fee_status) {
                query += ` AND ca.fee_status = $${headParams.length + 1}`;
                headParams.push(req.query.fee_status);
            }

            query += ` ORDER BY date, ca.start_time`;

            const result = await db.query(query, headParams);
            return { status: 200, body: { students, schedules: result.rows } };
        } catch (error) {
            logger.error('获取班主任学生排课错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 学生：获取排课列表（逻辑下沉自 student-controller.getSchedules）
     */
    async studentListSchedules(req) {
        try {
            const { startDate, endDate, status } = req.query;

            const dateExpr = await SchemaHelper.getDateExpr('ca');
            let query = `
                SELECT
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.adjustment_type,
                    ca.adjustment_type AS is_temp,
                    ca.teacher_id, t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn,
                    ca.course_id
                FROM course_arrangement ca
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN students s ON ca.student_id = s.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            if (await SchemaHelper.hasColumn('teachers', 'status')) query += ` AND t.status = 1`;
            if (await SchemaHelper.hasColumn('students', 'status')) query += ` AND s.status = 1`;

            const values = [req.user.id, startDate, endDate];

            if (status) {
                query += ` AND ca.status = $4`;
                values.push(status);
            }

            // 默认隐藏调走的原课程；"显示全部安排"时与管理员端一致展示
            if (req.query.show_plan !== 'true') {
                query += ` AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)`;
            }

            query += ` ORDER BY date, ca.start_time`;

            const result = await db.query(query, values);
            return { status: 200, body: result.rows };
        } catch (error) {
            logger.error('获取课程安排错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 学生：确认课程（逻辑下沉自 student-controller.confirmSchedule）
     */
    async studentConfirmSchedule(req) {
        try {
            const scheduleId = req.params.id;

            // 验证课程是否属于该学生
            const checkResult = await db.query(
                'SELECT id FROM course_arrangement WHERE id = $1 AND student_id = $2',
                [scheduleId, req.user.id]
            );

            if (checkResult.rows.length === 0) {
                return { status: 404, body: { message: '未找到该课程或无权限' } };
            }

            // 更新状态为已确认
            await db.query(
                'UPDATE course_arrangement SET status = $1 WHERE id = $2',
                ['confirmed', scheduleId]
            );

            return { status: 200, body: { message: '课程确认成功' } };
        } catch (error) {
            logger.error('确认课程错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }
    // ============ 统计相关（逻辑下沉自 admin/teacher/student controller 的 stats 方法） ============

    /** 管理员：总览统计（教师/学生数量、排课统计等） */
    async adminOverviewStats(req) {
        try {
            const caDateExpr = await SchemaHelper.getDateExpr('');
            // 权限落地：排课衍生指标对 L3 按创建者范围过滤；教师/学生数为全局实体计数保持不变
            const scope = buildScopeClause(req && req.user, "course_arrangement");
            let scopeSql = '';
            const params = [];
            if (scope) {
                params.push(scope.actorId);
                scopeSql = ` AND ${scope.clause.replace('$ACTOR_ID', '$1')}`;
            }
            const stats = await db.query(`
                SELECT
                    (SELECT COUNT(*) FROM teachers) as teacher_count,
                    (SELECT COUNT(*) FROM students) as student_count,
                    (SELECT COUNT(*) FROM course_arrangement
                       WHERE ${caDateExpr} >= DATE_TRUNC('month', CURRENT_DATE)
                         AND NOT (status = 'modified_away' AND COALESCE(adjustment_type, 0) = 0)${scopeSql}) as monthly_schedules,
                    (SELECT COUNT(*) FROM course_arrangement
                       WHERE status = 'pending'
                         AND NOT (status = 'modified_away' AND COALESCE(adjustment_type, 0) = 0)${scopeSql}) as pending_count,
                    (SELECT COUNT(*) FROM course_arrangement
                       WHERE NOT (status = 'modified_away' AND COALESCE(adjustment_type, 0) = 0)${scopeSql}) as total_schedules
            `, params);

            const rows = (stats && stats.rows) ? stats.rows : (Array.isArray(stats) ? stats : []);
            if (!rows[0]) {
                return {
                    status: 200,
                    body: {
                        teacher_count: 0,
                        student_count: 0,
                        monthly_schedules: 0,
                        pending_count: 0,
                        total_schedules: 0
                    }
                };
            }

            return { status: 200, body: rows[0] };
        } catch (error) {
            logger.error('获取总览统计错误:', error);
            return { status: 503, body: { message: '数据库暂时不可用，请稍后重试' } };
        }
    }

    /** 管理员：排课类型统计（按日期范围） */
    async adminScheduleStats(req) {
        try {
            let { startDate, endDate } = req.query;

            if (!startDate || startDate === '') {
                const now = new Date();
                const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
                startDate = firstDay.toISOString().split('T')[0];
            }

            if (!endDate || endDate === '') {
                const now = new Date();
                const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                endDate = lastDay.toISOString().split('T')[0];
            }

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            // 权限落地：L3 仅统计自己创建 + 无主存量的排课
            let statQuery = `
                SELECT
                    COALESCE(st.description, st.name) as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types st ON ca.course_id = st.id
                WHERE ${dateExpr} BETWEEN $1 AND $2
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
            `;
            const statParams = [startDate, endDate];
            statQuery = applyOwnerScope(statQuery, statParams, req && req.user, "ca");
            statQuery += `
                GROUP BY COALESCE(st.description, st.name)
                ORDER BY count DESC
            `;

            const result = await db.query(statQuery, statParams);
            return { status: 200, body: result.rows };
        } catch (error) {
            logger.error('获取排课统计错误:', error);
            return { status: 503, body: { message: '数据库暂时不可用，请稍后重试' } };
        }
    }

    /** 管理员：用户（教师/学生）汇总统计（按类型分组） */
    async adminUserStats(req) {
        try {
            let { startDate, endDate } = req.query;

            if (!startDate || startDate === '') {
                const now = new Date();
                const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
                startDate = firstDay.toISOString().split('T')[0];
            }

            if (!endDate || endDate === '') {
                const now = new Date();
                const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                endDate = lastDay.toISOString().split('T')[0];
            }

            const dateExpr2 = await SchemaHelper.getDateExpr('ca');

            // 权限落地：L3 仅统计自己创建 + 无主存量的排课（教师/学生名单本身保持全员）
            const userScope = buildScopeClause(req && req.user, "ca");
            let userScopeSql = '';
            const userParams = [startDate, endDate];
            if (userScope) {
                userParams.push(userScope.actorId);
                userScopeSql = ` AND ${userScope.clause.replace('$ACTOR_ID', `$${userParams.length}`)}`;
            }

            const teacherStats = await db.query(`
                SELECT
                    t.id as teacher_id,
                    t.name as teacher_name,
                    COALESCE(st.description, st.name, '未分类') as schedule_type,
                    COUNT(ca.id) as type_count
                FROM teachers t
                LEFT JOIN course_arrangement ca ON t.id = ca.teacher_id
                    AND ${dateExpr2} BETWEEN $1 AND $2
                    AND ca.status NOT IN ('cancelled', '0', 'modified_away')${userScopeSql}
                LEFT JOIN schedule_types st ON ca.course_id = st.id
                WHERE t.status != -1
                GROUP BY t.id, t.name, COALESCE(st.description, st.name, '未分类')
                ORDER BY t.name
            `, userParams);

            const studentStats = await db.query(`
                SELECT
                    s.id as student_id,
                    s.name as student_name,
                    COALESCE(st.description, st.name, '未分类') as schedule_type,
                    COUNT(ca.id) as type_count
                FROM students s
                LEFT JOIN course_arrangement ca ON s.id = ca.student_id
                    AND ${dateExpr2} BETWEEN $1 AND $2
                    AND ca.status NOT IN ('cancelled', '0', 'modified_away')${userScopeSql}
                LEFT JOIN schedule_types st ON ca.course_id = st.id
                WHERE s.status != -1
                GROUP BY s.id, s.name, COALESCE(st.description, st.name, '未分类')
                ORDER BY s.name
            `, userParams);

            const aggregateByPerson = (rows, idKey, nameKey) => {
                const map = new Map();
                rows.forEach(row => {
                    const id = row[idKey];
                    if (!map.has(id)) {
                        map.set(id, {
                            id,
                            name: row[nameKey],
                            total: 0,
                            types: {}
                        });
                    }
                    const person = map.get(id);
                    const typeCount = parseInt(row.type_count) || 0;
                    const scheduleType = row.schedule_type || '未分类';
                    if (typeCount > 0) {
                        person.total += typeCount;
                        person.types[scheduleType] = (person.types[scheduleType] || 0) + typeCount;
                    }
                });
                return Array.from(map.values()).sort((a, b) => b.total - a.total);
            };

            return {
                status: 200,
                body: {
                    teacherStats: aggregateByPerson(teacherStats.rows, 'teacher_id', 'teacher_name'),
                    studentStats: aggregateByPerson(studentStats.rows, 'student_id', 'student_name')
                }
            };
        } catch (error) {
            logger.error('获取用户统计错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /** 教师：统计（按类型/按日/按月，指定日期范围） */
    async teacherStatistics(req) {
        try {
            const { startDate, endDate } = req.query;

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            const [typeStatsResult, dailyStatsResult, monthlyStatsResult] = await Promise.all([
                db.query(`
                SELECT
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY COALESCE(sty.description, sty.name)
                ORDER BY count DESC
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    to_char(DATE_TRUNC('day', ${dateExpr}), 'YYYY-MM-DD') as date,
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*) as count
                FROM course_arrangement ca
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY DATE_TRUNC('day', ${dateExpr}), COALESCE(sty.description, sty.name)
                ORDER BY date, count DESC
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    DATE_TRUNC('month', ${dateExpr}) as month,
                    COUNT(*) as count
                FROM course_arrangement ca
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY DATE_TRUNC('month', ${dateExpr})
                ORDER BY month
            `, [req.user.id, startDate, endDate])
            ]);

            return {
                status: 200,
                body: {
                    typeStats: typeStatsResult.rows,
                    monthlyStats: monthlyStatsResult.rows,
                    dailyStats: dailyStatsResult.rows
                }
            };
        } catch (error) {
            logger.error('获取统计数据错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /** 教师：仪表盘总览（周/月/年计数、状态计数、今日课程） */
    async teacherOverview(req) {
        try {
            const today = new Date();

            const dayOfWeek = today.getDay() || 7;
            const activeWeekStart = new Date(today);
            activeWeekStart.setDate(today.getDate() - dayOfWeek + 1);
            const activeWeekEnd = new Date(activeWeekStart);
            activeWeekEnd.setDate(activeWeekStart.getDate() + 6);

            const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
            const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

            const firstDayOfYear = new Date(today.getFullYear(), 0, 1);
            const lastDayOfYear = new Date(today.getFullYear(), 11, 31);

            const formatDate = (d) => {
                const parts = new Intl.DateTimeFormat('en-US', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    timeZone: 'Asia/Shanghai'
                }).formatToParts(d);
                const year = parts.find(p => p.type === 'year').value;
                const month = parts.find(p => p.type === 'month').value;
                const day = parts.find(p => p.type === 'day').value;
                return `${year}-${month}-${day}`;
            };

            const todayStr = formatDate(today);
            const weekStartStr = formatDate(activeWeekStart);
            const weekEndStr = formatDate(activeWeekEnd);
            const monthStartStr = formatDate(firstDayOfMonth);
            const monthEndStr = formatDate(lastDayOfMonth);
            const yearStartStr = formatDate(firstDayOfYear);
            const yearEndStr = formatDate(lastDayOfYear);

            const dateExpr = await SchemaHelper.getDateExpr('ca');
            const teacherHasStatus = await SchemaHelper.hasColumn('teachers', 'status');
            const studentHasStatus = await SchemaHelper.hasColumn('students', 'status');

            const statsResult = await db.query(`
                SELECT
                    SUM(CASE WHEN ${dateExpr} BETWEEN $2 AND $3 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as weekly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $4 AND $5 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as monthly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $6 AND $7 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as yearly_count,
                    SUM(CASE WHEN ca.status = 'pending' THEN 1 ELSE 0 END)::int as total_pending,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END)::int as total_completed,
                    SUM(CASE WHEN ca.status = 'cancelled' THEN 1 ELSE 0 END)::int as total_cancelled
                FROM course_arrangement ca
                ${teacherHasStatus ? 'JOIN teachers t ON ca.teacher_id = t.id' : ''}
                WHERE ca.teacher_id = $1
                  ${teacherHasStatus ? 'AND t.status = 1' : ''}
            `, [
                req.user.id,
                weekStartStr, weekEndStr,
                monthStartStr, monthEndStr,
                yearStartStr, yearEndStr
            ]);

            let todayQuery = `
                SELECT
                    ca.id,
                    ca.student_id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.adjustment_type AS is_temp,
                    t.name as teacher_name,
                    s.name as student_name,
                    sty.name as schedule_type
                FROM course_arrangement ca
                JOIN students s ON ca.student_id = s.id
                LEFT JOIN schedule_types sty ON ca.course_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} = $2
            `;

            if (teacherHasStatus) todayQuery += ` AND t.status = 1`;
            if (studentHasStatus) todayQuery += ` AND s.status = 1`;

            todayQuery += ` ORDER BY ca.start_time`;

            const todaySchedules = await db.query(todayQuery, [req.user.id, todayStr]);

            return {
                status: 200,
                body: {
                    weeklyCount: parseInt(statsResult.rows[0]?.weekly_count || 0),
                    monthlyCount: parseInt(statsResult.rows[0]?.monthly_count || 0),
                    yearlyCount: parseInt(statsResult.rows[0]?.yearly_count || 0),
                    totalPending: parseInt(statsResult.rows[0]?.total_pending || 0),
                    totalCompleted: parseInt(statsResult.rows[0]?.total_completed || 0),
                    totalCancelled: parseInt(statsResult.rows[0]?.total_cancelled || 0),
                    todaySchedules: todaySchedules.rows
                }
            };
        } catch (error) {
            logger.error('获取教师总览数据错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /** 学生：统计（类型/月度/明细，指定日期范围） */
    async studentStatistics(req) {
        try {
            const { startDate, endDate } = req.query;
            if (!startDate || !endDate) {
                return { status: 400, body: { message: '请提供日期范围' } };
            }

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            const [typeStats, monthlyStats, schedules] = await Promise.all([
                db.query(`
                SELECT
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*)::int as count
                FROM course_arrangement ca
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY COALESCE(sty.description, sty.name)
                ORDER BY count DESC
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    TO_CHAR(${dateExpr}, 'YYYY-MM') as month,
                    COUNT(*)::int as count
                FROM course_arrangement ca
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                GROUP BY TO_CHAR(${dateExpr}, 'YYYY-MM')
                ORDER BY month
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.adjustment_type AS is_temp,
                    t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM course_arrangement ca
                LEFT JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', '0', 'modified_away')
                ORDER BY date DESC, ca.start_time ASC
            `, [req.user.id, startDate, endDate])
            ]);

            return {
                status: 200,
                body: {
                    typeStats: typeStats.rows,
                    monthlyStats: monthlyStats.rows,
                    schedules: schedules.rows
                }
            };
        } catch (error) {
            logger.error('获取统计数据错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /** 学生：仪表盘总览（周/月/年计数、状态计数、今日课程） */
    async studentOverview(req) {
        try {
            const today = new Date();

            const dayOfWeek = today.getDay() || 7;
            const activeWeekStart = new Date(today);
            activeWeekStart.setDate(today.getDate() - dayOfWeek + 1);
            const activeWeekEnd = new Date(activeWeekStart);
            activeWeekEnd.setDate(activeWeekStart.getDate() + 6);

            const firstDayOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
            const lastDayOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);

            const firstDayOfYear = new Date(today.getFullYear(), 0, 1);
            const lastDayOfYear = new Date(today.getFullYear(), 11, 31);

            const formatDate = (d) => {
                const parts = new Intl.DateTimeFormat('en-US', {
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    timeZone: 'Asia/Shanghai'
                }).formatToParts(d);
                const year = parts.find(p => p.type === 'year').value;
                const month = parts.find(p => p.type === 'month').value;
                const day = parts.find(p => p.type === 'day').value;
                return `${year}-${month}-${day}`;
            };

            const todayStr = formatDate(today);
            const weekStartStr = formatDate(activeWeekStart);
            const weekEndStr = formatDate(activeWeekEnd);
            const monthStartStr = formatDate(firstDayOfMonth);
            const monthEndStr = formatDate(lastDayOfMonth);
            const yearStartStr = formatDate(firstDayOfYear);
            const yearEndStr = formatDate(lastDayOfYear);

            const dateExpr = await SchemaHelper.getDateExpr('ca');

            const statsResult = await db.query(`
                SELECT
                    SUM(CASE WHEN ${dateExpr} BETWEEN $2 AND $3 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as weekly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $4 AND $5 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as monthly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $6 AND $7 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as yearly_count,
                    SUM(CASE WHEN ca.status IN ('pending', 'confirmed') THEN 1 ELSE 0 END)::int as total_pending,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END)::int as total_completed,
                    SUM(CASE WHEN ca.status = 'cancelled' THEN 1 ELSE 0 END)::int as total_cancelled
                FROM course_arrangement ca
                WHERE ca.student_id = $1
                  AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)
            `, [
                req.user.id,
                weekStartStr, weekEndStr,
                monthStartStr, monthEndStr,
                yearStartStr, yearEndStr
            ]);

            const todaySchedules = await db.query(`
                SELECT
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.adjustment_type AS is_temp,
                    t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM course_arrangement ca
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.course_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} = $2
                  AND NOT (ca.status = 'modified_away' AND COALESCE(ca.adjustment_type, 0) = 0)
                ORDER BY ca.start_time
            `, [req.user.id, todayStr]);

            return {
                status: 200,
                body: {
                    weeklyCount: parseInt(statsResult.rows[0]?.weekly_count || 0),
                    monthlyCount: parseInt(statsResult.rows[0]?.monthly_count || 0),
                    yearlyCount: parseInt(statsResult.rows[0]?.yearly_count || 0),
                    totalPending: parseInt(statsResult.rows[0]?.total_pending || 0),
                    totalCompleted: parseInt(statsResult.rows[0]?.total_completed || 0),
                    totalCancelled: parseInt(statsResult.rows[0]?.total_cancelled || 0),
                    todaySchedules: todaySchedules.rows
                }
            };
        } catch (error) {
            logger.error('获取总览数据错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }
}

module.exports = new ScheduleService();
