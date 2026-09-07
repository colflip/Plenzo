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
const courseSessionService = require('./course-session-service');

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

        const queryFn = `
            SELECT DISTINCT t.*
            FROM teachers t
            JOIN teacher_daily_availability ta ON t.id = ta.teacher_id
            WHERE ta.date = $1
            AND ta.status = 'available'
            AND (ta.start_time, ta.end_time) OVERLAPS ($2::time, $3::time)
            AND NOT EXISTS (
                SELECT 1
                FROM course_sessions cs
                WHERE cs.teacher_ids @> ARRAY[t.id]
                AND cs.class_date = $1
                AND (cs.start_time, cs.end_time) OVERLAPS ($2::time, $3::time)
                AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(cs.teachers) e
                     WHERE (e->>'teacher_id')::int = t.id
                       AND split_part(e->>'status', '.', 2) NOT IN ('cancelled', 'modified_away')
                )
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

        const queryFn = `
            SELECT DISTINCT s.*
            FROM students s
            JOIN student_daily_availability sa ON s.id = sa.student_id
            WHERE sa.date = $1
            AND sa.status = 'available'
            AND (sa.start_time, sa.end_time) OVERLAPS ($2::time, $3::time)
            AND NOT EXISTS (
                SELECT 1
                FROM course_sessions cs
                WHERE cs.student_ids @> ARRAY[s.id]
                AND cs.class_date = $1
                AND (cs.start_time, cs.end_time) OVERLAPS ($2::time, $3::time)
                AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(cs.teachers) e
                     WHERE split_part(e->>'status', '.', 2) NOT IN ('cancelled', 'modified_away')
                )
            )
        `;

        const result = await db.query(queryFn, [date, qStart, qEnd]);
        return result.rows;
    }

    /**
     * 检查冲突 (原子性检查)
     * @description 用于事务内部或单独调用。
     *   两段式：先用派生列 `teacher_ids` / `student_ids` 拿 GIN 索引把候选场次压到个位数，
     *   再展开 JSONB 判断「这个人在这一场里的 pair 是否还活跃」—— 数组不带状态，
     *   jsonpath 又拿不到索引，两段各补对方的短板。
     *   返回形状与旧实现一致：{ hasConflicts, type, message, existing }，
     *   `existing` 现在是场次行（多带 session_id，少了 teacher_id/student_id 这类 pair 级字段）。
     */
    async checkConflicts(teacherId, studentId, date, timeSlot, startTime, endTime, client = null) {
        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        const executeQuery = client ? client.query.bind(client) : db.query.bind(db);
        const SESSION_COLS = `cs.id, cs.id AS session_id, cs.class_date AS date,
                              cs.start_time, cs.end_time, cs.location`;
        // 活跃 pair：生命周期位不是 cancelled / modified_away
        const ACTIVE_TEACHER = `EXISTS (SELECT 1 FROM jsonb_array_elements(cs.teachers) e
                                         WHERE (e->>'teacher_id')::int = $TID
                                           AND split_part(e->>'status', '.', 2) NOT IN ('cancelled', 'modified_away'))`;
        const ACTIVE_ANY = `EXISTS (SELECT 1 FROM jsonb_array_elements(cs.teachers) e
                                     WHERE split_part(e->>'status', '.', 2) NOT IN ('cancelled', 'modified_away'))`;

        // 三种冲突用一条 UNION ALL 查完，按优先级取第一条。
        // 原来是三条串行 SELECT，而 createSchedule 会对每个 (教师, 学生) 对各调一次本方法
        // —— 3 师 × 2 生 就是 18 条语句、远程库每条约 250ms。合成一条后降到 6 条。
        const combined = await executeQuery(
            `SELECT * FROM (
                 (SELECT 1 AS prio, 'duplicate' AS kind, ${SESSION_COLS}
                    FROM course_sessions cs
                   WHERE cs.teacher_ids @> ARRAY[$1::int] AND cs.student_ids @> ARRAY[$2::int]
                     AND cs.class_date = $3 AND cs.start_time = $4 AND cs.end_time = $5
                     AND ${ACTIVE_TEACHER.replace('$TID', '$1')}
                   LIMIT 1)
                 UNION ALL
                 (SELECT 2 AS prio, 'overlap_teacher' AS kind, ${SESSION_COLS}
                    FROM course_sessions cs
                   WHERE cs.teacher_ids @> ARRAY[$1::int]
                     AND cs.class_date = $3
                     AND (cs.start_time, cs.end_time) OVERLAPS ($4::time, $5::time)
                     AND ${ACTIVE_TEACHER.replace('$TID', '$1')}
                   LIMIT 1)
                 UNION ALL
                 (SELECT 3 AS prio, 'overlap_student' AS kind, ${SESSION_COLS}
                    FROM course_sessions cs
                   WHERE cs.student_ids @> ARRAY[$2::int]
                     AND cs.class_date = $3
                     AND (cs.start_time, cs.end_time) OVERLAPS ($4::time, $5::time)
                     AND ${ACTIVE_ANY}
                   LIMIT 1)
             ) hits ORDER BY prio LIMIT 1`,
            [teacherId, studentId, date, qStart, qEnd]
        );

        const hit = (combined.rows || [])[0];
        if (hit) {
            // 报错文案与优先级顺序与三条串行时代逐字一致
            const MESSAGES = {
                duplicate: '存在完全重复的排课记录',
                overlap_teacher: '教师时间段与现有排课重叠',
                overlap_student: '学生时间段与现有排课重叠'
            };
            const { prio, kind, ...existing } = hit;
            return { hasConflicts: true, type: kind, message: MESSAGES[kind], existing };
        }

        return { hasConflicts: false };
    }

    /**
     * 创建课程安排（一场课一次成型：多师多生都在一行里）
     *
     * 旧实现是「按学生循环、每个学生插一行」，一场 3 师 × 2 生 要插 6 行；
     * 现在一次 createSession 就够，教师与学生各是一个 pair 数组。
     * 冲突检测仍逐对做（沿用「允许重叠但给出提示」的既有口径）。
     */
    async createSchedule(data, userId) {
        const { teacherId, teacherIds, studentIds, date, timeSlot, startTime, endTime,
            scheduleTypes, location, notes, adjustment_type, is_temp, isTemp } = data;

        const typeList = Array.isArray(scheduleTypes) ? scheduleTypes : [scheduleTypes];
        const courseId = typeList[0];
        if (!courseId) throw new AppError('缺少课程类型', 400);

        const teacherList = Array.isArray(teacherIds) && teacherIds.length ? teacherIds : [teacherId];
        const studentList = Array.isArray(studentIds) ? studentIds : [studentIds];
        if (!teacherList[0]) throw new AppError('缺少教师', 400);
        if (!studentList[0]) throw new AppError('缺少学生', 400);

        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        for (const tId of teacherList) {
            for (const sId of studentList) {
                const conflict = await this.checkConflicts(tId, sId, date, timeSlot, startTime, endTime);
                if (conflict.hasConflicts) {
                    throw new AppError(conflict.message, 400, { type: conflict.type, existing: conflict.existing });
                }
            }
        }

        // 「临时加课」落在状态码的类别位上（旧路径经 is_temp / adjustment_type 两个名字来回错位，
        // 导致新建时勾选不生效 —— 那个 bug 随旧路径一并消失）。
        const category = Number(adjustment_type) === 1 || isTemp || is_temp ? 'temp' : 'normal';

        const session = await courseSessionService.createSession({
            class_date: date,
            start_time: qStart,
            end_time: qEnd,
            location: location || null,
            notes: notes || null,
            teachers: teacherList.map((tId, i) => ({
                teacher_id: tId,
                type_id: typeList[i] || courseId,
                category,
                lifecycle: 'pending'
            })),
            students: studentList.map(sId => ({ student_id: sId }))
        }, { id: userId, actorType: 'admin' });

        return { ids: [session.id], session };
    }

    /**
     * 获取所有课程类型
     */
    async getScheduleTypes() {
        const result = await db.query('SELECT * FROM schedule_types ORDER BY name');
        return result.rows;
    }

    /**
     * 确认某位教师在某一场课里的排课（教师本人或管理员）
     *
     * 三个 confirm 入口（通用 / 管理员 / 教师端）现在共用 courseSessionService.setTeacherStatus：
     * 一条相关子查询原地重建，只改这一个 pair 的生命周期位，类别位原样保留。
     * @param {number} sessionId 场次 id
     * @param {string} teacherUid 教师 pair 的 uid
     */
    async confirmSchedule(sessionId, teacherUid, operatorId, isOperatorAdmin) {
        const session = await courseSessionService.getSessionById(sessionId);
        if (!session) throw new AppError('课程不存在', 404);

        const pair = (session.teachers || []).find(t => String(t.uid) === String(teacherUid));
        if (!pair) throw new AppError('课程不存在', 404);

        // 权限检查: 只有授课教师本人或管理员可确认
        if (!isOperatorAdmin && Number(pair.teacher_id) !== Number(operatorId)) {
            throw new AppError('无权操作此课程', 403);
        }

        const r = await courseSessionService.setTeacherStatus(
            sessionId, teacherUid, 'confirmed',
            { id: operatorId, actorType: isOperatorAdmin ? 'admin' : 'teacher' }
        );
        if (!r.updated) throw new AppError('课程不存在', 404);
        return { success: true, status: r.status };
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

            const dateExpr = 'ca.class_date';
            const values = [startDate, endDate];

            // teachers.status / students.status 都是 schema.sql 里 NOT NULL + CHECK 的结构列，
            // 远程库实测也在 —— 原来每次都探测一遍 information_schema（冷启动各 250ms），
            // 现在直接写死。administrators 没有 status 列，那边的探测仍然保留。

            // 基础 SQL：关联教师与学生以便能够按账号状态过滤，同时关联课程类型获取中文名称
            let sql = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time,
                    ca.end_time,
                    ca.status,
                    ca.teacher_id,
                    ca.teacher_uid,
                    t.name AS teacher_name,
                    ca.student_id,
                    s.name AS student_name,
                    ca.type_id AS course_id,
                    COALESCE(stt.description, stt.name) AS schedule_type_cn,
                    ca.location,
                    ca.transport_fee,
                    ca.other_fee,
                    ca.status_category,
                    ca.fee_status
                FROM v_session_pairs ca
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN students s ON ca.student_id = s.id
                LEFT JOIN schedule_types stt ON ca.type_id = stt.id
                WHERE ${dateExpr} BETWEEN $1 AND $2
            `;

            sql += ` AND t.status = 1 AND s.status = 1`;

            if (status) {
                values.push(status);
                sql += ` AND ca.status = $${values.length}`;
            }
            if (type) {
                values.push(type);
                sql += ` AND ca.type_id = $${values.length}`;
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
                sql += ` AND NOT (ca.status = 'modified_away' AND ca.status_category = 'normal')`;
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
     * 管理员：获取单场课详情（编辑弹窗数据源）
     *
     * 返回**场次形状**：头部字段 + `teachers[]` / `students[]` 两个 pair 数组 + `version`。
     * 弹窗改成整场编辑，必须一次拿到全部 pair；pair 里的 id 在这里换成姓名后附上
     * （`teacher_name` / `student_name` / `type_name` / `created_by_name`），前端不再各自去查。
     */
    async adminGetScheduleById(req) {
        try {
            const { id } = req.params;
            const numId = Number(id);
            if (!Number.isInteger(numId) || numId <= 0) {
                return { status: 400, body: { message: '无效的排课ID' } };
            }

            let sql = `SELECT id, class_date, class_date AS date, start_time, end_time, location, notes,
                              teachers, students, teacher_ids, student_ids, version,
                              created_by, created_at, updated_by, updated_at
                         FROM course_sessions cs
                        WHERE cs.id = $1`;
            const params = [numId];

            // 权限落地：L3 访问他人创建的记录视为不存在（不暴露存在性）
            const scope = buildScopeClause(req && req.user, 'cs');
            if (scope) {
                params.push(scope.actorId);
                sql += ` AND (cs.created_by = $${params.length} OR cs.created_by IS NULL)`;
            }

            const result = await db.query(sql, params);
            if (result.rows.length === 0) {
                return { status: 404, body: { message: '未找到排课记录' } };
            }
            const session = await this.decorateSessionNames(result.rows[0]);
            return { status: 200, body: session };
        } catch (error) {
            logger.error('获取排课详情错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 给场次的 pair 补上姓名（教师 / 学生 / 类型 / 各 pair 的添加人）。
     * 三次批量查询换掉逐 pair 的 JOIN —— Neon 下每条 SQL 都是一次往返，批量取名更划算。
     */
    async decorateSessionNames(session) {
        const teacherIds = (session.teachers || []).map(t => t.teacher_id).filter(Boolean);
        const studentIds = (session.students || []).map(s => s.student_id).filter(Boolean);
        const typeIds = (session.teachers || []).map(t => t.type_id).filter(Boolean);
        const adminIds = [
            session.created_by, session.updated_by,
            ...(session.teachers || []).map(t => t.created_by),
            ...(session.students || []).map(s => s.created_by)
        ].filter(Boolean);

        const nameMap = async (table, ids, labelExpr) => {
            const uniq = [...new Set(ids.map(Number).filter(Number.isFinite))];
            if (uniq.length === 0) return new Map();
            const r = await db.query(`SELECT id, ${labelExpr} AS label FROM ${table} WHERE id = ANY($1::int[])`, [uniq]);
            return new Map((r.rows || []).map(x => [Number(x.id), x.label]));
        };

        const [teachers, students, types, admins] = await Promise.all([
            nameMap('teachers', teacherIds, 'name'),
            nameMap('students', studentIds, 'name'),
            nameMap('schedule_types', typeIds, 'COALESCE(description, name)'),
            nameMap('administrators', adminIds, 'COALESCE(name, username)')
        ]);

        return {
            ...session,
            created_by_name: admins.get(Number(session.created_by)) || null,
            updated_by_name: admins.get(Number(session.updated_by)) || null,
            teachers: (session.teachers || []).map(t => ({
                ...t,
                teacher_name: teachers.get(Number(t.teacher_id)) || null,
                type_name: types.get(Number(t.type_id)) || null,
                created_by_name: admins.get(Number(t.created_by)) || null,
                created_by_id: t.created_by != null ? Number(t.created_by) : null
            })),
            students: (session.students || []).map(s => ({
                ...s,
                student_name: students.get(Number(s.student_id)) || null,
                created_by_name: admins.get(Number(s.created_by)) || null,
                created_by_id: s.created_by != null ? Number(s.created_by) : null
            }))
        };
    }

    /**
     * 管理员：获取网格视图排课（周视图数据源）
     *
     * 数据源换成 v_session_pairs（一行 = 一个教师 pair × 一个学生 pair），**返回形状与旧表时代一致**
     * —— 前端的卡片渲染、水印、配色、状态下拉全部沿用原代码，只需把分组键换成 session_id。
     * 新增的键：session_id / teacher_uid / student_uid / status_category / status_code / version。
     * 去掉的键：adjustment_type（改由 status_category 表达）。
     */
    async adminGetSchedulesGrid(req) {
        try {
            const { start_date, end_date, status, type_id, course_id, teacher_id } = req.query;
            // 兼容前端传递的 course_id 或 type_id 参数名
            const effectiveTypeId = type_id || course_id;
            if (!start_date || !end_date) {
                return { status: 400, body: { message: '缺少开始/结束日期' } };
            }

            // teachers.status / students.status 都是 schema.sql 里 NOT NULL + CHECK 的结构列，
            // 远程库实测也在 —— 原来每次都探测一遍 information_schema（冷启动各 250ms），
            // 现在直接写死。administrators 没有 status 列，那边的探测仍然保留。

            let sql = `
                SELECT
                    vp.session_id,
                    vp.session_id AS id,
                    vp.teacher_uid,
                    vp.student_uid,
                    s.id AS student_id,
                    s.name AS student_name,
                    t.id AS teacher_id,
                    t.name AS teacher_name,
                    vp.type_id AS course_id,
                    stt.name AS schedule_type,
                    COALESCE(stt.description, stt.name) AS schedule_types,
                    COALESCE(stt.description, stt.name) AS schedule_type_cn,
                    vp.class_date AS date,
                    vp.start_time,
                    vp.end_time,
                    vp.location,
                    vp.notes,
                    vp.status,
                    vp.status_category,
                    vp.status_code,
                    vp.transport_fee,
                    vp.other_fee,
                    vp.fee_status,
                    vp.family_participants,
                    vp.version
                FROM v_session_pairs vp
                JOIN students s ON vp.student_id = s.id
                JOIN teachers t ON vp.teacher_id = t.id
                JOIN schedule_types stt ON vp.type_id = stt.id
                WHERE vp.class_date >= $1::date AND vp.class_date <= $2::date
            `;
            const params = [start_date, end_date];

            if (status) {
                sql += ` AND vp.status = $${params.length + 1}`;
                params.push(status);
            }
            if (effectiveTypeId) {
                sql += ` AND vp.type_id = $${params.length + 1}`;
                params.push(effectiveTypeId);
            }

            // 隐藏被调走的原课程（旧口径：status='modified_away' AND adjustment_type=0）
            // 新口径是单值判定：生命周期位 modified_away 且类别位 normal。
            // 兼容字符串与布尔（Joi boolean 校验会把 'true' 转为布尔 true）
            if (String(req.query.show_plan) !== 'true') {
                sql += ` AND NOT (vp.status = 'modified_away' AND vp.status_category = 'normal')`;
            }

            // 过滤删除状态：允许正常与暂停，但不显示删除
            sql += ` AND t.status <> -1 AND s.status <> -1`;
            if (teacher_id) {
                sql += ` AND vp.teacher_id = $${params.length + 1}`;
                params.push(teacher_id);
            }

            // 权限落地：L3 仅见自己创建 + 无主存量（视图透出场次头部的 created_by）
            sql = applyOwnerScope(sql, params, req && req.user, 'vp');

            sql += ` ORDER BY vp.class_date ASC, s.id ASC, vp.start_time ASC`;

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
     * 管理员：创建排课 —— 一场课一行，多师多生一次成型
     *
     * 旧实现收 `studentIds` / `scheduleTypes` 数组却只取 `[0]` 插一行，其余学生以
     * `skipped_students` 静默丢弃（排一场「3 师 × 2 生」要提交 6 次）。现在整场一次写入，
     * `skipped_students` 连同它的静默丢弃一起删掉。
     *
     * 请求体同时兼容新旧两种形状：
     * - 新：`teachers: [{teacher_id, type_id, category, lifecycle}]` + `students: [{student_id, family_participants}]`
     * - 旧：`teacherId` / `studentIds[]` / `scheduleTypes[]` / `status` / `is_temp`
     */
    async adminCreateSchedule(req) {
        try {
            const b = req.body || {};
            const { date, startTime, endTime, location, notes, status } = b;

            // 基础验证：时间格式与先后关系（数据库还有 chk_cs_time_order 兜底）
            const toMinutes = (v) => {
                const m = /^([0-2]?\d):([0-5]\d)/.exec(String(v || ''));
                return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
            };
            const sMin = toMinutes(startTime);
            const eMin = toMinutes(endTime);
            if (isNaN(sMin) || isNaN(eMin)) {
                return { status: 400, body: { message: '开始/结束时间格式不正确（HH:MM）', errors: [{ field: 'time', message: '开始/结束时间格式不正确（HH:MM）' }] } };
            }
            if (eMin <= sMin) {
                return { status: 400, body: { message: '结束时间必须晚于开始时间', errors: [{ field: 'time', message: '结束时间必须晚于开始时间' }] } };
            }

            // 归一成 pair 数组
            const lifecycle = ['pending', 'confirmed', 'cancelled', 'completed', 'modified_away']
                .includes(String(status || '').trim()) ? String(status).trim() : 'pending';
            const category = (b.is_temp === 1 || b.is_temp === '1' || b.is_temp === true
                || Number(b.adjustment_type) === 1) ? 'temp' : 'normal';
            const typeList = Array.isArray(b.scheduleTypes) ? b.scheduleTypes
                : (b.scheduleTypes != null ? [b.scheduleTypes] : []);

            const teachers = Array.isArray(b.teachers) && b.teachers.length
                ? b.teachers
                : (Array.isArray(b.teacherIds) && b.teacherIds.length ? b.teacherIds : [b.teacherId])
                    .filter(v => v != null)
                    .map((tid, i) => ({ teacher_id: tid, type_id: typeList[i] ?? typeList[0], category, lifecycle }));

            const famDefault = b.family_participants !== undefined ? Number(b.family_participants) : 4;
            const students = Array.isArray(b.students) && b.students.length
                ? b.students
                : (Array.isArray(b.studentIds) ? b.studentIds : [b.studentIds])
                    .filter(v => v != null)
                    .map(sid => ({ student_id: sid, family_participants: famDefault }));

            if (teachers.length === 0) return { status: 400, body: { message: '至少需要一位教师' } };
            if (students.length === 0) return { status: 400, body: { message: '至少需要一位学生' } };

            // 教师/学生账号状态必须正常（列存在性统一经 SchemaHelper）
            const statusGuard = await this.assertParticipantsActive(
                teachers.map(t => t.teacher_id), students.map(s => s.student_id)
            );
            if (statusGuard) return { status: 400, body: { message: statusGuard } };

            const session = await courseSessionService.createSession({
                class_date: date,
                start_time: startTime,
                end_time: endTime,
                location: location || null,
                notes: notes || null,
                teachers,
                students
            }, { id: req.user.id, actorType: 'admin' });

            return { status: 201, body: { id: session.id, session } };
        } catch (error) {
            logger.error('创建排课错误:', error);
            if (error && error.name === 'SessionValidationError') {
                return { status: 400, body: { message: error.message, errors: [{ field: 'pair', message: error.message }] } };
            }
            if (error.code === '23514') {
                return { status: 400, body: { message: '检查约束冲突', errors: [{ field: 'check', message: '不符合数据库检查约束（状态码 / 费用 / uid 唯一性）' }] } };
            }
            if (error.code === '23503') {
                return { status: 400, body: { message: '外键约束冲突', errors: [{ field: 'fk', message: '教师/学生/类型不存在或已被删除' }] } };
            }
            return { status: 500, body: { message: '服务器错误', errors: [{ field: 'db', message: '数据库错误' }] } };
        }
    }

    /**
     * 参与人账号状态守卫：任何一位教师/学生状态不是 1（正常）就拒绝排课。
     * 返回错误消息字符串，或 null 表示通过。
     */
    async assertParticipantsActive(teacherIds, studentIds) {
        const check = async (table, ids, label) => {
            if (!await SchemaHelper.hasColumn(table, 'status')) return null;
            const uniq = [...new Set(ids.map(Number).filter(Number.isFinite))];
            if (uniq.length === 0) return null;
            const r = await db.query(`SELECT id, status FROM ${table} WHERE id = ANY($1::int[])`, [uniq]);
            const found = new Map((r.rows || []).map(x => [Number(x.id), Number(x.status)]));
            for (const id of uniq) {
                if (!found.has(id)) return `${label}不存在`;
                if (found.get(id) !== 1) return `${label}状态非正常，无法参与排课`;
            }
            return null;
        };
        return (await check('teachers', teacherIds, '教师')) || (await check('students', studentIds, '学生'));
    }

    /**
     * 管理员：更新一场课
     *
     * 拆成三件互不相干的事，各走各的服务方法（不再是一条 UPDATE 拼所有字段）：
     * 1. 头部字段（日期/时段/地点/备注）→ `updateSessionHeader`，**天然整场生效**，
     *    旧实现那套「找到同组其他行一起改」的补偿逻辑随之作废；带 `version` 乐观锁。
     * 2. 某位教师 pair 的内容（类型/评分/评价/费用）→ `patchPair`，白名单裁剪 + `version`。
     * 3. 生命周期切换 → `setTeacherStatus`（原地重建，不带 `version`）；其中把状态改成
     *    `modified_away` 会触发**作废+增补**：`adjustTeacherPair` 在一条 UPDATE 里把原 pair
     *    标成 `*.modified_away` 并追加一个 `adjusted.pending` 的新 pair。
     *
     * 请求体里的 `teacher_uid` 指明操作哪一位教师；缺省时若本场只有一位教师就用那一位。
     */
    async adminUpdateSchedule(req) {
        try {
            const { id } = req.params;
            const b = req.body || {};
            const actor = { id: req.user && req.user.id, actorType: 'admin' };

            const session = await courseSessionService.getSessionById(id);
            if (!session) return { status: 404, body: { message: '排课不存在' } };

            // 权限落地：L3 只能改自己创建的记录（越权视为不存在，不暴露存在性）
            // 注意参数顺序是 (记录的 created_by, 操作者)，全仓其余 9 个调用点都是这个顺序；
            // 这里曾经写反成 (req.user, session)，导致 requiresOwnDataScope 把 session 当操作者、
            // 取不到 permissionLevel 而按最低档 L3 判定，再拿 Number(req.user) 去比 session.id
            // —— 结果任何级别的管理员保存排课都恒定 404。
            if (!canTouchRecord(session.created_by, req && req.user)) {
                return { status: 404, body: { message: '排课不存在' } };
            }

            let version = b.version !== undefined ? Number(b.version) : Number(session.version);
            let current = session;

            // 1) 头部字段
            const headerPatch = {};
            if (b.date !== undefined) headerPatch.class_date = b.date;
            if (b.class_date !== undefined) headerPatch.class_date = b.class_date;
            if (b.start_time !== undefined) headerPatch.start_time = b.start_time;
            if (b.end_time !== undefined) headerPatch.end_time = b.end_time;
            if (b.location !== undefined) headerPatch.location = b.location;
            if (b.notes !== undefined) headerPatch.notes = b.notes;
            if (Object.keys(headerPatch).length > 0) {
                current = await courseSessionService.updateSessionHeader(id, headerPatch, actor, version, current);
                version = Number(current.version);
            }

            const rejectedFields = [];
            if (Array.isArray(b.teachers) || Array.isArray(b.students)) {
                // ---- 整场保存：请求带 teachers[] / students[]（每个元素 uid 有则 patch、无则 add）----
                // 合并「去重难点」一页：uid 项 = updatePair（整列 patch + 生命周期）；无 uid = addPair。
                const result = await courseSessionService.updatePairsBatch(id, b, actor, version, current);
                if (result.notFound) return { status: 404, body: { message: '排课不存在' } };
                current = result.session;
                version = Number(current.version);
                rejectedFields.push(...(result.rejectedFields || []));

                // 旧字段（teacher_uid / type_id / lifecycle / family_participants）仍然兼容：
                // 批量描述未覆盖到的部分，由下方原有「单教师」逻辑兜底处理
            }

            // 定位教师 pair：URL :uid > body teacher_uid > 单教师自动检测 > teacher_id 匹配
            // （仅在没有批量 teachers 数组时才走到这里 —— 批量命中后其上已处理完所有 pair）
            const teachers = current.teachers || [];
            let teacherUid = b.teacher_uid || req.params.uid;
            if (!teacherUid && teachers.length === 1) teacherUid = teachers[0].uid;
            if (!teacherUid && b.teacher_id != null) {
                const hit = teachers.find(p => Number(p.teacher_id) === Number(b.teacher_id));
                if (hit) teacherUid = hit.uid;
            }

            if (teacherUid && !(Array.isArray(b.teachers) && b.teachers.length)) {
                // 2) pair 内容
                const pairPatch = {};
                if (b.type_id !== undefined) pairPatch.type_id = b.type_id;
                if (Array.isArray(b.type_ids) && b.type_ids.length) pairPatch.type_id = b.type_ids[0];
                if (b.teacher_rating !== undefined) pairPatch.teacher_rating = b.teacher_rating;
                if (b.teacher_comment !== undefined) pairPatch.teacher_comment = b.teacher_comment;
                if (b.transport_fee !== undefined) pairPatch.transport_fee = b.transport_fee;
                if (b.other_fee !== undefined) pairPatch.other_fee = b.other_fee;
                if (Object.keys(pairPatch).length > 0) {
                    const r = await courseSessionService.patchPair(id, 'teacher', teacherUid, pairPatch, actor, version, current);
                    if (r.notFound) return { status: 404, body: { message: '排课不存在' } };
                    current = r.session;
                    version = Number(current.version);
                    rejectedFields.push(...(r.rejectedFields || []));
                }

                // 3) 生命周期
                const lifecycle = b.lifecycle || b.status;
                if (lifecycle) {
                    const pair = (current.teachers || []).find(x => String(x.uid) === String(teacherUid));
                    const wasAdjusted = pair && pair.status.startsWith('adjusted.');
                    if (lifecycle === 'modified_away' && pair && !pair.status.endsWith('.modified_away') && !wasAdjusted) {
                        // 作废+增补：原 pair 标记调走，同一条 UPDATE 追加 adjusted.pending 新 pair
                        const r = await courseSessionService.adjustTeacherPair(
                            id, teacherUid, { type_id: b.type_id || (Array.isArray(b.type_ids) ? b.type_ids[0] : undefined) }, actor, version, current
                        );
                        if (r.notFound) return { status: 404, body: { message: '排课不存在' } };
                        current = r.session;
                        version = Number(current.version);
                    } else {
                        const r = await courseSessionService.setTeacherStatus(id, teacherUid, lifecycle, actor, b.notes, current);
                        if (!r.updated) return { status: 404, body: { message: '排课不存在' } };
                        current = r.session;
                        version = Number(current.version);
                    }
                }
            }

            // 学生 pair 的家属人数（唯一由旧表单顺带传来的学生侧字段）
            if (b.family_participants !== undefined && !(Array.isArray(b.students) && b.students.length)) {
                const studentUid = b.student_uid
                    || ((current.students || []).length === 1 ? current.students[0].uid : null);
                if (studentUid) {
                    const r = await courseSessionService.patchPair(
                        id, 'student', studentUid, { family_participants: b.family_participants }, actor, version, current
                    );
                    if (!r.notFound) {
                        current = r.session;
                        version = Number(current.version);
                        rejectedFields.push(...(r.rejectedFields || []));
                    }
                }
            }

            const body = await this.decorateSessionNames(current);
            if (rejectedFields.length) body.rejectedFields = [...new Set(rejectedFields)];
            return { status: 200, body };
        } catch (error) {
            if (error && error.name === 'VersionConflictError') {
                return { status: 409, body: { message: error.message } };
            }
            if (error && error.name === 'SessionValidationError') {
                return { status: 400, body: { message: error.message, rejectedFields: error.rejectedFields } };
            }
            logger.error('更新排课错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 管理员：删除整场课（含全部教师与学生 pair）
     * 三张审计表随 `ON DELETE CASCADE` 一并清理。
     * 只删一位教师/学生请走 `adminRemovePair`。
     */
    async adminDeleteSchedule(req) {
        try {
            const { id } = req.params;

            // 先验证排课是否存在（含 L3 归属校验：越权视为不存在）
            const existing = await db.query('SELECT id, created_by FROM course_sessions WHERE id = $1', [id]);
            if (!existing.rows || existing.rows.length === 0) {
                return { status: 404, body: { message: '未找到该排课记录' } };
            }
            if (!canTouchRecord(existing.rows[0].created_by, req && req.user)) {
                return { status: 404, body: { message: '未找到该排课记录' } };
            }

            // 不开事务：deleteSession 的主语句是单条 DELETE（本身原子），
            // 随后那条 session_change_logs 审计是「失败只告警」的旁路，包进事务也不会
            // 因它回滚删除。而每个 runInTransaction 要额外付 BEGIN + COMMIT 两次往返
            // （远程库每条约 250ms），这里省 500ms。
            await courseSessionService.deleteSession(id, { id: req.user && req.user.id, actorType: 'admin' });
            return { status: 200, body: { message: '排课删除成功' } };
        } catch (error) {
            logger.error('删除排课错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 管理员：从一场课里移除一位教师或学生（删除的第二种粒度）。
     * 移除后该数组为空的场次会被整场删除 —— 这一点在确认弹窗里要如实提示。
     */
    async adminRemovePair(req) {
        try {
            const { id, uid } = req.params;
            const kind = req.params.kind === 'students' ? 'student' : 'teacher';
            const session = await courseSessionService.getSessionById(id);
            if (!session) return { status: 404, body: { message: '未找到该排课记录' } };
            if (!canTouchRecord(session.created_by, req && req.user)) {
                return { status: 404, body: { message: '未找到该排课记录' } };
            }
            const version = req.body && req.body.version !== undefined ? Number(req.body.version) : Number(session.version);
            const arr = kind === 'teacher' ? (session.teachers || []) : (session.students || []);

            // 最后一位 → 整场删除（服务层会拒绝把数组删空，这里把语义显式化）
            if (arr.length <= 1) {
                await courseSessionService.deleteSession(id, { id: req.user && req.user.id, actorType: 'admin' });
                return { status: 200, body: { message: '这是本场最后一位，已删除整场排课', deletedSession: true } };
            }
            const r = await courseSessionService.removePair(id, kind, uid, { id: req.user.id, actorType: 'admin' }, version);
            if (r.notFound) return { status: 404, body: { message: '未找到该 pair' } };
            return { status: 200, body: await this.decorateSessionNames(r.session) };
        } catch (error) {
            if (error && error.name === 'VersionConflictError') return { status: 409, body: { message: error.message } };
            if (error && error.name === 'SessionValidationError') return { status: 400, body: { message: error.message } };
            logger.error('移除排课 pair 错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    /**
     * 管理员：往一场课里加一位教师或学生
     */
    async adminAddPair(req) {
        try {
            const { id } = req.params;
            const kind = req.params.kind === 'students' ? 'student' : 'teacher';
            const session = await courseSessionService.getSessionById(id);
            if (!session) return { status: 404, body: { message: '未找到该排课记录' } };
            if (!canTouchRecord(session.created_by, req && req.user)) {
                return { status: 404, body: { message: '未找到该排课记录' } };
            }
            const version = req.body && req.body.version !== undefined ? Number(req.body.version) : Number(session.version);
            const guard = kind === 'teacher'
                ? await this.assertParticipantsActive([req.body.teacher_id], [])
                : await this.assertParticipantsActive([], [req.body.student_id]);
            if (guard) return { status: 400, body: { message: guard } };

            const r = await courseSessionService.addPair(id, kind, req.body, { id: req.user.id, actorType: 'admin' }, version);
            if (r.notFound) return { status: 404, body: { message: '未找到该排课记录' } };
            const body = await this.decorateSessionNames(r.session);
            body.uid = r.uid;
            return { status: 201, body };
        } catch (error) {
            if (error && error.name === 'VersionConflictError') return { status: 409, body: { message: error.message } };
            if (error && error.name === 'SessionValidationError') return { status: 400, body: { message: error.message } };
            logger.error('新增排课 pair 错误:', error);
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
            const targetRes = await db.query('SELECT id, created_by FROM course_sessions WHERE id = $1', [id]);
            if (!targetRes.rows || targetRes.rows.length === 0) {
                return { status: 404, body: { message: '未找到排课记录' } };
            }
            if (!canTouchRecord(targetRes.rows[0].created_by, req && req.user)) {
                return { status: 404, body: { message: '未找到排课记录' } };
            }

            // 确认收敛到 setTeacherStatus（原地重建，只改生命周期位，类别位保留）。
            // 没指定 teacher_uid 时确认本场全部教师 pair —— 与旧的「整行置 confirmed」语义等价。
            if (adminConfirmed) {
                const actor = { id: req.user && req.user.id, actorType: 'admin' };
                const session = await courseSessionService.getSessionById(id);
                const uids = req.body.teacher_uid
                    ? [req.body.teacher_uid]
                    : (session.teachers || []).map(p => p.uid);
                for (const uid of uids) {
                    await courseSessionService.setTeacherStatus(id, uid, 'confirmed', actor, req.body.notes);
                }
            }

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

            const dateExpr = 'ca.class_date';

            let query = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.teacher_id, ca.teacher_uid, ca.location,
                    t.name as teacher_name,
                    ca.transport_fee, ca.other_fee,
                    ca.fee_status,
                    ca.status_category,
                    st.name as student_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM v_session_pairs ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.type_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            query += ` AND t.status = 1 AND st.status = 1`;

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
                query += ` AND NOT (ca.status = 'modified_away' AND ca.status_category = 'normal')`;
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
     * 教师：确认自己那个 pair 的课
     * 收敛到 `teacherUpdateScheduleStatus`（同一个原地重建语句），只是生命周期固定 confirmed。
     */
    async teacherConfirmSchedule(req) {
        const { teacherConfirmed, notes, teacher_uid } = req.body || {};
        if (!teacherConfirmed) {
            return { status: 200, body: { message: '课程确认状态更新成功' } };
        }
        return this.teacherUpdateScheduleStatus({
            ...req,
            body: { lifecycle: 'confirmed', notes, teacher_uid }
        });
    }

    /**
     * 教师 / 班主任：切换某位教师 pair 的生命周期位
     *
     * 这是非管理员唯一能写 `teachers` 列的路径，走 `setTeacherStatus` 的原地重建：
     * 语句结构上只能改 `status` 一个键、只匹配一个 uid —— **语句形态即权限**，
     * 比字段白名单更硬（白名单写错会误改字段，语句写错则是写不成）。
     * 服务层再断言这个 uid 的 `teacher_id === actor.id`（班主任则断言本场学生在其名下）。
     */
    async teacherUpdateScheduleStatus(req) {
        try {
            const { id } = req.params;
            const { status, lifecycle, notes, teacher_uid } = req.body || {};
            const wanted = lifecycle || status;

            if (!wanted) {
                return { status: 400, body: { message: '缺少课程状态' } };
            }
            const normalizedStatus = String(wanted).trim().toLowerCase();
            if (!LESSON_STATUS_SET.has(normalizedStatus)) {
                return { status: 400, body: { message: '非法的课程状态值' } };
            }

            const session = await courseSessionService.getSessionById(id);
            if (!session) {
                return { status: 404, body: { message: '未找到相关课程' } };
            }

            // 定位 pair：显式 teacher_uid 优先；否则取本人在这一场里的那个 pair
            const teachers = session.teachers || [];
            let uid = teacher_uid;
            if (!uid) {
                const own = teachers.filter(p => Number(p.teacher_id) === Number(req.user.id));
                if (own.length === 1) uid = own[0].uid;
                else if (own.length > 1) {
                    return { status: 400, body: { message: '本场课您有多条记录，请指明 teacher_uid' } };
                }
            }
            const pair = teachers.find(p => String(p.uid) === String(uid));
            if (!pair) {
                return { status: 404, body: { message: '未找到相关课程' } };
            }

            // 权限：本人任课，或该场学生在自己名下（班主任）
            let hasPermission = Number(pair.teacher_id) === Number(req.user.id);
            if (!hasPermission) {
                const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [req.user.id]);
                const raw = teacherResult.rows.length ? teacherResult.rows[0].student_ids : null;
                if (raw) {
                    const bound = String(raw).split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
                    hasPermission = (session.students || []).some(s => bound.includes(Number(s.student_id)));
                }
            }
            if (!hasPermission) {
                return { status: 403, body: { message: '无权修改该课程状态（非本人任课且不属于所负责学生）' } };
            }

            const r = await courseSessionService.setTeacherStatus(
                id, uid, normalizedStatus,
                { id: req.user.id, actorType: req.user.userType === 'admin' ? 'admin' : 'teacher' },
                notes
            );
            if (!r.updated) {
                return { status: 404, body: { message: '未找到相关课程' } };
            }
            return {
                status: 200,
                body: {
                    message: '课程状态更新成功',
                    schedule: {
                        id: Number(id),
                        session_id: Number(id),
                        teacher_uid: uid,
                        status: normalizedStatus,
                        status_code: r.status,
                        start_time: r.session.start_time,
                        end_time: r.session.end_time,
                        location: r.session.location
                    }
                }
            };
        } catch (error) {
            if (error && error.name === 'SessionValidationError') {
                return { status: 400, body: { message: error.message } };
            }
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

            const dateExpr = 'ca.class_date';

            let query = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.teacher_id, ca.location,
                    st.name as student_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM v_session_pairs ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.type_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            query += ` AND t.status = 1 AND st.status = 1`;

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

            const dateExpr = 'ca.class_date';

            // 查询关联学生的所有课程，过滤掉已取消的
            let query = `
                SELECT
                    ca.id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location, ca.transport_fee, ca.other_fee,
                    ca.fee_status,
                    ca.status_category,
                    ca.teacher_uid,
                    t.name as teacher_name, t.id as teacher_id,
                    st.name as student_name, st.id as student_id,
                    sty.name as schedule_type, sty.description as schedule_type_cn
                FROM v_session_pairs ca
                JOIN students st ON ca.student_id = st.id
                JOIN schedule_types sty ON ca.type_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.student_id = ANY($1::int[])
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            if (String(req.query.show_plan) !== 'true') {
                query += ` AND NOT (ca.status = 'modified_away' AND ca.status_category = 'normal')`;
            }

            // 费用报销状态过滤（班主任视图同样支持）
            const headParams = [studentIds, startDate, endDate];
            if (req.query.fee_status) {
                query += ` AND ca.fee_status = $${headParams.length + 1}`;
                headParams.push(req.query.fee_status);
            }

            query += ` ORDER BY date, ca.start_time`;

            // 学生名单与排课都只依赖上面解析出的 studentIds，彼此无关 —— 并发省一次往返
            const [studentsResult, result] = await Promise.all([
                db.query(`SELECT id, name FROM students WHERE id = ANY($1::int[]) ORDER BY id`, [studentIds]),
                db.query(query, headParams)
            ]);
            return { status: 200, body: { students: studentsResult.rows, schedules: result.rows } };
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

            const dateExpr = 'ca.class_date';
            let query = `
                SELECT
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.status_category,
                    ca.teacher_id, t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn,
                    ca.type_id AS course_id
                FROM v_session_pairs ca
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.type_id = sty.id
                JOIN students s ON ca.student_id = s.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
            `;

            query += ` AND t.status = 1 AND s.status = 1`;

            const values = [req.user.id, startDate, endDate];

            if (status) {
                query += ` AND ca.status = $4`;
                values.push(status);
            }

            // 默认隐藏调走的原课程；"显示全部安排"时与管理员端一致展示
            if (req.query.show_plan !== 'true') {
                query += ` AND NOT (ca.status = 'modified_away' AND ca.status_category = 'normal')`;
            }

            query += ` ORDER BY date, ca.start_time`;

            const result = await db.query(query, values);
            return { status: 200, body: result.rows };
        } catch (error) {
            logger.error('获取课程安排错误:', error);
            return { status: 500, body: { message: '服务器错误' } };
        }
    }

    // ============ 统计相关（逻辑下沉自 admin/teacher/student controller 的 stats 方法） ============

    /** 管理员：总览统计（教师/学生数量、排课统计等） */
    async adminOverviewStats(req) {
        try {
            // 权限落地：排课衍生指标对 L3 按创建者范围过滤；教师/学生数为全局实体计数保持不变
            const scope = buildScopeClause(req && req.user, 'v_session_pairs');
            let scopeSql = '';
            const params = [];
            if (scope) {
                params.push(scope.actorId);
                scopeSql = ` AND ${scope.clause.replace('$ACTOR_ID', '$1')}`;
            }
            // 8 个指标压在同一条语句的 subselect 里。多几个 subselect 不多一次往返，
            // 而前端原来是「另外拉 /admin/schedules 全量（实测 164KB / 2.6s）再在浏览器里数
            // 本周/本年/已完成/已取消」—— 4 个整数换一次全量传输，这里把它换掉。
            const ACTIVE = `NOT (status = 'modified_away' AND status_category = 'normal')`;
            const stats = await db.query(`
                SELECT
                    (SELECT COUNT(*) FROM teachers) as teacher_count,
                    (SELECT COUNT(*) FROM students) as student_count,
                    (SELECT COUNT(*) FROM v_session_pairs
                       WHERE class_date >= DATE_TRUNC('month', CURRENT_DATE)
                         AND ${ACTIVE}${scopeSql}) as monthly_schedules,
                    (SELECT COUNT(*) FROM v_session_pairs
                       WHERE status = 'pending'
                         AND ${ACTIVE}${scopeSql}) as pending_count,
                    (SELECT COUNT(*) FROM v_session_pairs
                       WHERE ${ACTIVE}${scopeSql}) as total_schedules,
                    -- 本周：周一为一周之首，与前端原来的 getDay() 折算口径一致
                    (SELECT COUNT(*) FROM v_session_pairs
                       WHERE class_date >= DATE_TRUNC('week', CURRENT_DATE)
                         AND class_date < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
                         AND ${ACTIVE}${scopeSql}) as weekly_schedules,
                    (SELECT COUNT(*) FROM v_session_pairs
                       WHERE class_date >= DATE_TRUNC('year', CURRENT_DATE)
                         AND class_date < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
                         AND ${ACTIVE}${scopeSql}) as yearly_schedules,
                    (SELECT COUNT(*) FROM v_session_pairs
                       WHERE status = 'completed' AND ${ACTIVE}${scopeSql}) as completed_schedules,
                    (SELECT COUNT(*) FROM v_session_pairs
                       WHERE status = 'cancelled' AND ${ACTIVE}${scopeSql}) as cancelled_schedules
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
                        total_schedules: 0,
                        weekly_schedules: 0,
                        yearly_schedules: 0,
                        completed_schedules: 0,
                        cancelled_schedules: 0
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

            const dateExpr = 'ca.class_date';

            // 权限落地：L3 仅统计自己创建 + 无主存量的排课
            let statQuery = `
                SELECT
                    COALESCE(st.description, st.name) as type,
                    COUNT(*) as count
                FROM v_session_pairs ca
                JOIN schedule_types st ON ca.type_id = st.id
                WHERE ${dateExpr} BETWEEN $1 AND $2
                  AND ca.status NOT IN ('cancelled', 'modified_away')
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

            const dateExpr2 = 'ca.class_date';

            // 权限落地：L3 仅统计自己创建 + 无主存量的排课（教师/学生名单本身保持全员）
            const userScope = buildScopeClause(req && req.user, "ca");
            let userScopeSql = '';
            const userParams = [startDate, endDate];
            if (userScope) {
                userParams.push(userScope.actorId);
                userScopeSql = ` AND ${userScope.clause.replace('$ACTOR_ID', `$${userParams.length}`)}`;
            }

            // 两条聚合参数相同、互不依赖，并发省一次往返（远程库每条约 250ms）
            const [teacherStats, studentStats] = await Promise.all([
                db.query(`
                SELECT
                    t.id as teacher_id,
                    t.name as teacher_name,
                    COALESCE(st.description, st.name, '未分类') as schedule_type,
                    COUNT(ca.id) as type_count
                FROM teachers t
                LEFT JOIN v_session_pairs ca ON t.id = ca.teacher_id
                    AND ${dateExpr2} BETWEEN $1 AND $2
                    AND ca.status NOT IN ('cancelled', 'modified_away')${userScopeSql}
                LEFT JOIN schedule_types st ON ca.type_id = st.id
                WHERE t.status != -1
                GROUP BY t.id, t.name, COALESCE(st.description, st.name, '未分类')
                ORDER BY t.name
            `, userParams),
                db.query(`
                SELECT
                    s.id as student_id,
                    s.name as student_name,
                    COALESCE(st.description, st.name, '未分类') as schedule_type,
                    COUNT(ca.id) as type_count
                FROM students s
                LEFT JOIN v_session_pairs ca ON s.id = ca.student_id
                    AND ${dateExpr2} BETWEEN $1 AND $2
                    AND ca.status NOT IN ('cancelled', 'modified_away')${userScopeSql}
                LEFT JOIN schedule_types st ON ca.type_id = st.id
                WHERE s.status != -1
                GROUP BY s.id, s.name, COALESCE(st.description, st.name, '未分类')
                ORDER BY s.name
            `, userParams)
            ]);

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

            const dateExpr = 'ca.class_date';

            const [typeStatsResult, dailyStatsResult, monthlyStatsResult] = await Promise.all([
                db.query(`
                SELECT
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*) as count
                FROM v_session_pairs ca
                JOIN schedule_types sty ON ca.type_id = sty.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', 'modified_away')
                GROUP BY COALESCE(sty.description, sty.name)
                ORDER BY count DESC
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    to_char(DATE_TRUNC('day', ${dateExpr}), 'YYYY-MM-DD') as date,
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*) as count
                FROM v_session_pairs ca
                JOIN schedule_types sty ON ca.type_id = sty.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', 'modified_away')
                GROUP BY DATE_TRUNC('day', ${dateExpr}), COALESCE(sty.description, sty.name)
                ORDER BY date, count DESC
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    DATE_TRUNC('month', ${dateExpr}) as month,
                    COUNT(*) as count
                FROM v_session_pairs ca
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', 'modified_away')
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

            const dateExpr = 'ca.class_date';
            // teachers.status / students.status 都是 schema.sql 里 NOT NULL + CHECK 的结构列，
            // 远程库实测也在 —— 原来每次都探测一遍 information_schema（冷启动各 250ms），
            // 现在直接写死。administrators 没有 status 列，那边的探测仍然保留。

            const statsQuery = `
                SELECT
                    SUM(CASE WHEN ${dateExpr} BETWEEN $2 AND $3 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as weekly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $4 AND $5 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as monthly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $6 AND $7 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as yearly_count,
                    SUM(CASE WHEN ca.status = 'pending' THEN 1 ELSE 0 END)::int as total_pending,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END)::int as total_completed,
                    SUM(CASE WHEN ca.status = 'cancelled' THEN 1 ELSE 0 END)::int as total_cancelled
                FROM v_session_pairs ca
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND t.status = 1
            `;
            const statsParams = [
                req.user.id,
                weekStartStr, weekEndStr,
                monthStartStr, monthEndStr,
                yearStartStr, yearEndStr
            ];

            let todayQuery = `
                SELECT
                    ca.id,
                    ca.student_id,
                    ${dateExpr} AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.status_category,
                    t.name as teacher_name,
                    s.name as student_name,
                    sty.name as schedule_type
                FROM v_session_pairs ca
                JOIN students s ON ca.student_id = s.id
                LEFT JOIN schedule_types sty ON ca.type_id = sty.id
                JOIN teachers t ON ca.teacher_id = t.id
                WHERE ca.teacher_id = $1
                  AND ${dateExpr} = $2
            `;

            todayQuery += ` AND t.status = 1 AND s.status = 1`;

            todayQuery += ` ORDER BY ca.start_time`;

            // 统计与今日课表互不依赖，并发省一次往返（远程库每条约 250ms）
            const [statsResult, todaySchedules] = await Promise.all([
                db.query(statsQuery, statsParams),
                db.query(todayQuery, [req.user.id, todayStr])
            ]);

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

            const dateExpr = 'ca.class_date';

            const [typeStats, monthlyStats, schedules] = await Promise.all([
                db.query(`
                SELECT
                    COALESCE(sty.description, sty.name) as type,
                    COUNT(*)::int as count
                FROM v_session_pairs ca
                JOIN schedule_types sty ON ca.type_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', 'modified_away')
                GROUP BY COALESCE(sty.description, sty.name)
                ORDER BY count DESC
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    TO_CHAR(${dateExpr}, 'YYYY-MM') as month,
                    COUNT(*)::int as count
                FROM v_session_pairs ca
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', 'modified_away')
                GROUP BY TO_CHAR(${dateExpr}, 'YYYY-MM')
                ORDER BY month
            `, [req.user.id, startDate, endDate]),

                db.query(`
                SELECT
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.status_category,
                    t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM v_session_pairs ca
                LEFT JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.type_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} BETWEEN $2 AND $3
                  AND ca.status NOT IN ('cancelled', 'modified_away')
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

            const dateExpr = 'ca.class_date';

            // 统计与今日课表互不依赖，并发省一次往返（远程库每条约 250ms）
            const [statsResult, todaySchedules] = await Promise.all([
                db.query(`
                SELECT
                    SUM(CASE WHEN ${dateExpr} BETWEEN $2 AND $3 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as weekly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $4 AND $5 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as monthly_count,
                    SUM(CASE WHEN ${dateExpr} BETWEEN $6 AND $7 AND ca.status IN ('pending', 'confirmed', 'completed') THEN 1 ELSE 0 END)::int as yearly_count,
                    SUM(CASE WHEN ca.status IN ('pending', 'confirmed') THEN 1 ELSE 0 END)::int as total_pending,
                    SUM(CASE WHEN ca.status = 'completed' THEN 1 ELSE 0 END)::int as total_completed,
                    SUM(CASE WHEN ca.status = 'cancelled' THEN 1 ELSE 0 END)::int as total_cancelled
                FROM v_session_pairs ca
                WHERE ca.student_id = $1
                  AND NOT (ca.status = 'modified_away' AND ca.status_category = 'normal')
            `, [
                req.user.id,
                weekStartStr, weekEndStr,
                monthStartStr, monthEndStr,
                yearStartStr, yearEndStr
            ]),
                db.query(`
                SELECT
                    ca.id,
                    (${dateExpr})::text AS date,
                    ca.start_time, ca.end_time, ca.status,
                    ca.location,
                    ca.status_category,
                    t.name as teacher_name,
                    sty.name as schedule_type,
                    sty.description as schedule_type_cn
                FROM v_session_pairs ca
                JOIN teachers t ON ca.teacher_id = t.id
                JOIN schedule_types sty ON ca.type_id = sty.id
                WHERE ca.student_id = $1
                  AND ${dateExpr} = $2
                  AND NOT (ca.status = 'modified_away' AND ca.status_category = 'normal')
                ORDER BY ca.start_time
            `, [req.user.id, todayStr])
            ]);

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
