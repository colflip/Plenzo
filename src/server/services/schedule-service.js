/**
 * 智能排课服务 (Schedule Service)
 * @description 处理排课核心业务逻辑，包括时间冲突检测、智能匹配、排课创建与状态管理
 * @module services/scheduleService
 *
 * 返回契约（D1）：只返回领域数据；业务错误抛 AppError，由 controller 统一封装 HTTP 响应。
 * 未识别的异常原样向上抛，交给全局 errorHandler 归类（数据库不可用 → 503）。
 */

const db = require('../db/db');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/error');
const SchemaHelper = require('../utils/schema-helper');
const { buildScopeClause, canTouchRecord, requiresOwnDataScope, applyOwnerScope } = require('../utils/admin-permissions');
const courseSessionService = require('./course-session-service');
// 「在职 pair」的 SQL 谓词唯一出口（两种口径不等价，见 course-session-service 里的注释）
const { sqlActivePair, sqlActivePairJsonb, sqlActiveTeacherPairJsonb, sqlNotMovedAway, sqlStudentSwapped } = courseSessionService;
// 班主任（head-teacher）与学生绑定关系的唯一解析入口，避免各处再抄一份 CSV 解析
const headTeacherService = require('./head-teacher-service');
// 类型归一的唯一实现（与浏览页统计、Excel 导出共用同一份规则）
const TypeConversion = require('../domain/type-conversion');

// 课程状态枚举（与 teacher-controller 的 LESSON_STATUS_SET 保持一致，供 teacherUpdateScheduleStatus 使用）
const LESSON_STATUS_SET = new Set(['pending', 'confirmed', 'completed', 'cancelled']);

// 时区坑与时间格式差异收在 shared-utils 一份实现里（本地日历日 / HH:MM 补齐秒）
const { toDateKey, normTime, beijingMonthWindow, beijingWeekWindow, beijingCalendarParts, toBeijingDateKey } = require('../utils/shared-utils');
// 上午/下午/晚上三档的列名映射与归一：可用性真值只存在这三列里（见 availabilitySlotPredicate）
const { SLOT_COLUMNS, normalizeSlotKey } = require('./availability-service');

/**
 * 「动了某一位参与者」的请求键。needsTx 判定和 pair 定位校验共用这两份清单 ——
 * 以前是各写一遍字面量，漏一个键（teacher_id / category）就会让「头部 + pair」两条
 * UPDATE 在非事务下跑，中途 409 留下半截课。
 */
const TEACHER_PAIR_KEYS = ['teacher_uid', 'uid', 'teacher_id', 'category', 'type_id', 'type_ids',
    'lifecycle', 'status', 'teacher_rating', 'teacher_comment'];
const STUDENT_PAIR_KEYS = ['student_uid', 'student_id', 'family_participants'];
const PAIR_KEYS = [...TEACHER_PAIR_KEYS, ...STUDENT_PAIR_KEYS];

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
 * 没给日期时按「全部」处理，与管理员列表路径同口径。
 *
 * 不能把 undefined 直接绑进 `class_date BETWEEN $2 AND $3`：
 * BETWEEN NULL AND NULL 恒为假，于是「前端少传一个 query 参数」会表现得像
 * 「这位教师/学生一节课都没有」，HTTP 还是 200（审查报告 P2-6）。
 * 校验层把 startDate/endDate 声明成了 optional，所以这条路是真能走到的。
 */
const FULL_DATE_RANGE = Object.freeze({ start: '1970-01-01', end: '2099-12-31' });
/** 管理员排课列表的单次返回上限（pair 行），见 adminListSchedules 里的资源闸门说明 */
const MAX_LIST_ROWS = 5000;
function dateWindowOrAll(query) {
    const q = query || {};
    return {
        startDate: q.startDate || FULL_DATE_RANGE.start,
        endDate: q.endDate || FULL_DATE_RANGE.end
    };
}

const SLOT_KEYS = ['morning', 'afternoon', 'evening'];
const minutesOf = (t) => {
    const [h, m] = String(t).split(':');
    return Number(h) * 60 + Number(m || 0);
};

/**
 * 可用性档位谓词（审查报告 P1-16）。
 *
 * availability 行的 start_time/end_time **恒为全天**（availability-service.js:218/352/461
 * 写入 '00:00:00','23:59:59'），教师/学生真正「哪一档开放」只记在
 * morning/afternoon/evening_available 三列上。过去「可用教师/学生」查询只看
 * `status = 'available'` + 一个永远成立的全天 OVERLAPS，于是把「上午已关闭」的教师
 * 照样列为上午可用，管理员据此把人排进他不出现在的时间。
 *
 * 给了 timeSlot 就查那一档；只给起止时间时，按窗口与各档的交集要求相应档位为 1。
 * @param {string} timeSlot
 * @param {string} qStart
 * @param {string} qEnd
 * @param {string} alias 可用性表别名
 * @returns {string} 可直接拼进 WHERE 的片段（可能为空串）
 */
function availabilitySlotPredicate(timeSlot, qStart, qEnd, alias) {
    const normalized = normalizeSlotKey(timeSlot);
    if (normalized) return `AND ${alias}.${SLOT_COLUMNS[normalized]} = 1`;

    const start = minutesOf(qStart);
    const end = minutesOf(qEnd);
    const cols = SLOT_KEYS
        .filter((key) => {
            const [slotStart, slotEnd] = slotToRange(key);
            return start < minutesOf(slotEnd) && end > minutesOf(slotStart);
        })
        .map((key) => `${alias}.${SLOT_COLUMNS[key]} = 1`);

    return cols.length ? `AND ${cols.join(' AND ')}` : '';
}

// 统计口径的类型归一：DB 里「评审」与「大评审」（及线上/英文变体）是不同 schedule_types 行，
// 分组后各占一行。前端图例按标签合并（public/js/modules/admin/stats-plugins.js），
// 这里先把标签折到「评审」，否则同一个图例项会分裂成两条。
function normalizeReviewLabel(rawType) {
    const raw = String(rawType == null ? '' : rawType).trim();
    if (!raw) return rawType;
    return TypeConversion.isReviewType(raw) ? TypeConversion.CONVERTED_LABELS.review : rawType;
}

// 明细行透出的 schedule_type 是 DB slug，前端用 getScheduleTypeLabel(slug) 查中文表；
// 表以规范 slug 为键（'review' 而非 'major-review'），故先归一，避免查不到落到兜底文案。
function normalizeScheduleTypeKey(rawType) {
    return TypeConversion.normalizeTypeKey(rawType) || rawType;
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
            ${availabilitySlotPredicate(timeSlot, qStart, qEnd, 'ta')}
            AND NOT EXISTS (
                SELECT 1
                FROM course_sessions cs
                WHERE cs.teacher_ids @> ARRAY[t.id]
                AND cs.class_date = $1
                AND (cs.start_time, cs.end_time) OVERLAPS ($2::time, $3::time)
                AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(cs.teachers) e
                     WHERE ${sqlActiveTeacherPairJsonb('t.id', 'e')}
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
            ${availabilitySlotPredicate(timeSlot, qStart, qEnd, 'sa')}
            AND NOT EXISTS (
                SELECT 1
                FROM course_sessions cs
                WHERE cs.student_ids @> ARRAY[s.id]
                AND cs.class_date = $1
                AND (cs.start_time, cs.end_time) OVERLAPS ($2::time, $3::time)
                AND EXISTS (
                    SELECT 1 FROM jsonb_array_elements(cs.teachers) e
                     WHERE ${sqlActivePairJsonb('e')}
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
    async checkConflicts(teacherId, studentId, date, timeSlot, startTime, endTime, client = null, excludeSessionId = null) {
        const [slotStart, slotEnd] = timeSlot ? slotToRange(timeSlot) : [null, null];
        const qStart = startTime || slotStart;
        const qEnd = endTime || slotEnd;

        /**
         * 时间与 getAvailableTeachers 用同一条守卫：缺时间时 `(a,b) OVERLAPS (NULL::time, NULL::time)`
         * 结果是 NULL，UNION 的每个分支都返回空集，于是接口回 `{hasConflicts:false}` ——
         * 前端显示「无冲突」，而实际上什么都没查（审查报告 P2-5）。
         * 「没有冲突」和「无法判断」必须区分开，后者只能是 400。
         */
        if (!qStart || !qEnd) {
            throw new AppError('必须指定时段或具体起止时间', 400);
        }

        const executeQuery = client ? client.query.bind(client) : db.query.bind(db);
        const SESSION_COLS = `cs.id, cs.id AS session_id, cs.class_date AS date,
                              cs.start_time, cs.end_time, cs.location`;
        // 活跃 pair：口径见 course-session-service.sqlActivePairJsonb（与 isActive 同一条规则）
        const ACTIVE_TEACHER = `EXISTS (SELECT 1 FROM jsonb_array_elements(cs.teachers) e
                                         WHERE ${sqlActiveTeacherPairJsonb('$TID', 'e')})`;
        const ACTIVE_ANY = `EXISTS (SELECT 1 FROM jsonb_array_elements(cs.teachers) e
                                     WHERE ${sqlActivePairJsonb('e')})`;
        // 「调整课程」要能把自己排除掉：整场搬时段时，本场既是被检查的对象、又是待让位的一方，
        // 不排除就会拿旧时段（或搬完后新时段上的增补 pair）报出自己撞自己。
        const NOT_SELF = ` AND ($6::int IS NULL OR cs.id <> $6)`;

        // 三种冲突用一条 UNION ALL 查完，按优先级取第一条。
        // 原来是三条串行 SELECT，而 createSchedule 会对每个 (教师, 学生) 对各调一次本方法
        // —— 3 师 × 2 生 就是 18 条语句、远程库每条约 250ms。合成一条后降到 6 条。
        const combined = await executeQuery(
            `SELECT * FROM (
                 (SELECT 1 AS prio, 'duplicate' AS kind, ${SESSION_COLS}
                    FROM course_sessions cs
                   WHERE cs.teacher_ids @> ARRAY[$1::int] AND cs.student_ids @> ARRAY[$2::int]
                     AND cs.class_date = $3 AND cs.start_time = $4 AND cs.end_time = $5
                     AND ${ACTIVE_TEACHER.replace('$TID', '$1')}${NOT_SELF}
                   LIMIT 1)
                 UNION ALL
                 (SELECT 2 AS prio, 'overlap_teacher' AS kind, ${SESSION_COLS}
                    FROM course_sessions cs
                   WHERE cs.teacher_ids @> ARRAY[$1::int]
                     AND cs.class_date = $3
                     AND (cs.start_time, cs.end_time) OVERLAPS ($4::time, $5::time)
                     AND ${ACTIVE_TEACHER.replace('$TID', '$1')}${NOT_SELF}
                   LIMIT 1)
                 UNION ALL
                 (SELECT 3 AS prio, 'overlap_student' AS kind, ${SESSION_COLS}
                    FROM course_sessions cs
                   WHERE cs.student_ids @> ARRAY[$2::int]
                     AND cs.class_date = $3
                     AND (cs.start_time, cs.end_time) OVERLAPS ($4::time, $5::time)
                     AND ${ACTIVE_ANY}${NOT_SELF}
                   LIMIT 1)
             ) hits ORDER BY prio LIMIT 1`,
            [teacherId, studentId, date, qStart, qEnd, excludeSessionId != null ? Number(excludeSessionId) : null]
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
     * 批量冲突检测：一次查询覆盖「多个时段 × 多位教师 × 多位学生」。
     *
     * checkConflicts 是逐 (教师, 学生) 对各发一条语句的 —— 9 个时段 × 4 位老师就是 36 条、
     * 远程库约 9 秒，没法放进排课预览。这里用派生列 `teacher_ids && / student_ids &&`
     * 一条语句把候选场次捞回来（GIN 索引），时段重叠与「pair 是否还活跃」在 JS 里判。
     *
     * @param {Object} opts
     * @param {Array<{date:string,startTime:string,endTime:string,teacherIds?:number[],studentIds?:number[]}>} opts.slots
     *        待排的时段。给了 per-slot 的 teacherIds/studentIds 就只查这些人 ——
     *        一批多行时不带这个就会出现「A 行的老师撞上 B 行的时段」那种误报。
     * @param {number[]} opts.teacherIds - 整批的教师 id（时段没自带名单时用）
     * @param {number[]} opts.studentIds - 整批的学生 id
     * @param {number[]} [opts.excludeSessionIds] - 不计入冲突的场次（调整时排除自己）
     * @returns {Promise<Array>} [{ date, startTime, endTime, kind, who, sessionId,
     *                               sessionStartTime, sessionEndTime, sessionLocation }]
     */
    async findConflictsBatch({ slots = [], teacherIds = [], studentIds = [], excludeSessionIds = [] } = {}) {
        const toIds = (arr) => [...new Set((arr || []).map(Number).filter(Number.isFinite))];
        // 进来的日期与时间先归一再比：调用方给的是模型或 REST 表单的原始值（'2026-10-11'、
        // '2026-10-11T00:00:00+08:00'、'13:00' 都可能出现），而下面的匹配是**严格相等**。
        // 不归一就会查得到候选场次却一行都对不上 —— 冲突提示静默变成「没有冲突」。
        const prepared = slots
            .filter(s => s && s.date && s.startTime && s.endTime)
            .map(s => ({
                ...s,
                date: toDateKey(s.date),
                startTime: normTime(s.startTime),
                endTime: normTime(s.endTime),
                _teachers: s.teacherIds != null ? toIds(s.teacherIds) : toIds(teacherIds),
                _students: s.studentIds != null ? toIds(s.studentIds) : toIds(studentIds)
            }));
        const uniqTeachers = [...new Set(prepared.flatMap(s => s._teachers))];
        const uniqStudents = [...new Set(prepared.flatMap(s => s._students))];
        const dates = [...new Set(prepared.map(s => s.date))];
        if (!prepared.length || (!uniqTeachers.length && !uniqStudents.length) || !dates.length) return [];

        const rows = await db.query(
            `SELECT cs.id, cs.class_date, cs.start_time, cs.end_time, cs.location,
                    cs.teachers, cs.students
               FROM course_sessions cs
              WHERE cs.class_date = ANY($1::date[])
                AND ($4::int[] IS NULL OR NOT (cs.id = ANY($4::int[])))
                AND (cs.teacher_ids && $2::int[] OR cs.student_ids && $3::int[])`,
            [dates, uniqTeachers, uniqStudents,
                excludeSessionIds.length ? excludeSessionIds.map(Number) : null]
        );

        // 两侧时间先经 normTime 归一到 HH:MM:SS 再比（REST 给 HH:MM、库里是 HH:MM:SS）
        const overlap = (aS, aE, bS, bE) =>
            normTime(aS) < normTime(bE) && normTime(bS) < normTime(aE);
        const conflicts = [];
        for (const row of rows.rows || []) {
            const classDate = toDateKey(row.class_date);
            const pairs = (row.teachers || []).filter(p => courseSessionService.isActive(p.status));
            const presentStudentIds = new Set((row.students || []).map(s => Number(s.student_id)));

            for (const slot of prepared) {
                if (slot.date !== classDate) continue;
                if (!overlap(slot.startTime, slot.endTime, row.start_time, row.end_time)) continue;

                for (const tid of pairs.map(p => Number(p.teacher_id))) {
                    if (!slot._teachers.includes(tid)) continue;
                    conflicts.push({
                        date: slot.date, startTime: slot.startTime, endTime: slot.endTime,
                        kind: 'teacher', who: tid, sessionId: Number(row.id),
                        sessionStartTime: row.start_time, sessionEndTime: row.end_time,
                        sessionLocation: row.location
                    });
                }
                // 学生撞课只看「这场有活跃教师」—— 已整场作废的课不该再挡人，与 checkConflicts 同口径
                if (pairs.length) {
                    for (const sid of [...presentStudentIds]) {
                        if (!slot._students.includes(sid)) continue;
                        conflicts.push({
                            date: slot.date, startTime: slot.startTime, endTime: slot.endTime,
                            kind: 'student', who: sid, sessionId: Number(row.id),
                            sessionStartTime: row.start_time, sessionEndTime: row.end_time,
                            sessionLocation: row.location
                        });
                    }
                }
            }
        }
        return conflicts;
    }

    /**
     * 一条冲突的人话文案 —— 唯一实现。
     * 预览行（内存里已有师生名）与 describeConflicts（要回库查名）都走这里，不许再各拼一遍。
     * @param {Object} c findConflictsBatch 的一条结果
     * @param {(kind:string,id:number)=>string} nameOf 人名解析
     */
    formatConflictLine(c, nameOf) {
        const hm = (v) => String(v || '').slice(0, 5);
        const label = c.kind === 'teacher' ? '教师' : '学生';
        return `${label}${nameOf(c.kind, c.who)} 已占 ${c.date} ${hm(c.sessionStartTime)}-${hm(c.sessionEndTime)}`
            + `（排课 ${c.sessionId}${c.sessionLocation ? '，' + c.sessionLocation : ''}）`;
    }

    /**
     * 把 findConflictsBatch 的结果翻成人能读的一句话。
     * 名字只在真的有冲突时才查（两条批量 SELECT），正常路径不额外花往返。
     * @param {Array} conflicts
     * @returns {Promise<string[]>} 例如「教师周耀华 已占 2026-10-11 14:00-16:00（排课 501，新课堂）」
     */
    async describeConflicts(conflicts = []) {
        if (!conflicts.length) return [];
        const teacherIds = [...new Set(conflicts.filter(c => c.kind === 'teacher').map(c => c.who))];
        const studentIds = [...new Set(conflicts.filter(c => c.kind === 'student').map(c => c.who))];
        const [ts, ss] = await Promise.all([
            teacherIds.length
                ? db.query('SELECT id, name FROM teachers WHERE id = ANY($1::int[])', [teacherIds])
                : { rows: [] },
            studentIds.length
                ? db.query('SELECT id, name FROM students WHERE id = ANY($1::int[])', [studentIds])
                : { rows: [] }
        ]);
        const names = {
            teacher: Object.fromEntries((ts.rows || []).map(r => [Number(r.id), r.name])),
            student: Object.fromEntries((ss.rows || []).map(r => [Number(r.id), r.name]))
        };
        return conflicts.map(c => this.formatConflictLine(c,
            (kind, id) => names[kind][id] || `ID ${id}`));
    }

    /**
     * 冲突判定的唯一出口：**只算、不拦**。
     *
     * 同一位教师/学生在同一时段出现在两节课里，业务上是允许的（现网实测有 10 对教师、7 对学生
     * 这样重叠的活跃 pair），所以写入不挡，只把人能读懂的冲突句子交回调用侧展示：
     * AI 预览行上的 ⚠、管理员表单顶部的红横幅。
     * describeConflicts 只在真冲突时才发人名查询，干净路径不多花一次往返。
     *
     * @param {Object} opts
     * @param {Array} opts.slots - 见 findConflictsBatch（可带 per-slot 名单）
     * @param {number[]} [opts.teacherIds]
     * @param {number[]} [opts.studentIds]
     * @param {number[]} [opts.excludeSessionIds] - 改期/加人时排除被编辑的那一场
     * @param {string[]} [opts.extraLines] - 调用方另有的冲突说明（如一批预览里两行互撞），并进来同一份文案
     * @returns {Promise<string[]>} 冲突说明；空数组 = 没有冲突
     */
    async conflictLines({
        slots, teacherIds = [], studentIds = [], excludeSessionIds = [], extraLines = []
    } = {}) {
        const conflicts = await this.findConflictsBatch({ slots, teacherIds, studentIds, excludeSessionIds });
        return [
            ...(Array.isArray(extraLines) ? extraLines : []),
            ...(conflicts.length ? await this.describeConflicts(conflicts) : [])
        ];
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
    /**
     * 管理员：获取排课列表（逻辑下沉自 admin-controller.getSchedules）
     */
    async adminListSchedules(req) {
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
                ca.student_uid,
                t.name AS teacher_name,
                ca.student_id,
                s.name AS student_name,
                ca.type_id AS course_id,
                COALESCE(stt.description, stt.name) AS schedule_type_cn,
                ca.location,
                ca.transport_fee,
                ca.other_fee,
                ca.fee_scope,
                ca.status_category,
                ca.fee_status,
                -- 本行学生 pair 是否真的改属过（跨学生调整）：报销视图计划列置空判定用，
                -- 口径唯一源在 course-session-service.sqlStudentSwapped
                ${sqlStudentSwapped('ca')} AS student_swapped
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

        // 计划视图开关：默认隐藏「被调走的原课」（作废后已有增补 pair 顶上）。
        // 口径唯一源 sqlNotMovedAway；旧的 adjustment_type=0 判据早已不存在，别再按它写条件。
        if (String(req.query.show_plan) !== 'true') {
            sql += ` AND ${sqlNotMovedAway('ca')}`;
        }

        // 权限落地：L3 仅见自己创建 + 无主存量
        sql = applyOwnerScope(sql, values, req && req.user, "ca");

        sql += ` ORDER BY ${dateExpr} ASC, ca.start_time ASC`;

        // 资源闸门（审查报告 P3-2）：不传日期时窗口是 1970→2099，展开后是**pair 行**而非场次，
        // 没有上限就等于给一个 query 参数失去控制的无界查询。2026-10-09 生产实测 385 场 /
        // 611 个 pair，5000 有约 8 倍余量；真到上限说明调用方漏了日期，该报错而不是拉全表。
        values.push(MAX_LIST_ROWS);
        sql += ` LIMIT $${values.length}`;

        const result = await db.query(sql, values);
        const rows = result.rows || [];
        if (rows.length >= MAX_LIST_ROWS) {
            logger.warn(`[排课列表] 命中 ${MAX_LIST_ROWS} 行上限，结果被截断：请带 startDate/endDate 收窄查询窗口`);
        }
        return rows;
    }

    /**
     * 管理员：获取单场课详情（编辑弹窗数据源）
     *
     * 返回**场次形状**：头部字段 + `teachers[]` / `students[]` 两个 pair 数组 + `version`。
     * 弹窗改成整场编辑，必须一次拿到全部 pair；pair 里的 id 在这里换成姓名后附上
     * （`teacher_name` / `student_name` / `type_name` / `created_by_name`），前端不再各自去查。
     */
    async adminGetScheduleById(req) {
        const { id } = req.params;
        const numId = Number(id);
        if (!Number.isInteger(numId) || numId <= 0) {
            throw new AppError('无效的排课ID', 400);
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
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到排课记录' });
        }
        return this.decorateSessionNames(result.rows[0]);
    }

    /**
     * 给场次的 pair 补上姓名（教师 / 学生 / 类型 / 各 pair 的添加人）。
     * 三次批量查询换掉逐 pair 的 JOIN —— Neon 下每条 SQL 都是一次往返，批量取名更划算。
     * @param {Function} [q] 查询函数：事务里调用时必须传事务那条连接的 q，
     *   默认的 db.query 会再向池要一条连接（serverless POOL_MAX=2 → 与外层事务互等）。
     */
    async decorateSessionNames(session, q = db.query.bind(db)) {
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
            const r = await q(`SELECT id, ${labelExpr} AS label FROM ${table} WHERE id = ANY($1::int[])`, [uniq]);
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
        const { start_date, end_date, status, type_id, course_id, teacher_id } = req.query;
        // 兼容前端传递的 course_id 或 type_id 参数名
        const effectiveTypeId = type_id || course_id;
        if (!start_date || !end_date) {
            throw new AppError('缺少开始/结束日期', 400);
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
                -- 跨学生改属标志：与 adminListSchedules / 服务端导出同一口径（唯一源
                -- course-session-service.sqlStudentSwapped），否则同一周的 PNG 与 Excel 计划列分叉
                ${sqlStudentSwapped('vp')} AS student_swapped,
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
            sql += ` AND ${sqlNotMovedAway('vp')}`;
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

        // 数据完整性检查（基本时间有效性）。
        // 两处宽容/严格都是有原因的：秒这一段可选，因为 pg 把 TIME 列返回成 '14:00:00'，
        // 只认 'HH:MM' 的正则对**每一行**都不匹配 → valid 恒 false（审查报告 P3-1）；
        // 小时限定 00–23，因为 '25:00' 这种串本来就是不合法数据，不该被判成有效。
        // 前端 schedule-utils 目前只透传这个标志，但一个恒假/恒真的标志迟早有人拿来置灰行。
        return rows.map(r => {
            const toMin = (t) => {
                const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(t || '').trim());
                return m ? (Number(m[1]) * 60 + Number(m[2])) : NaN;
            };
            const sv = toMin(r.start_time), ev = toMin(r.end_time);
            const valid = !Number.isNaN(sv) && !Number.isNaN(ev) && ev > sv;
            return { ...r, valid };
        });
    }

    /**
     * 管理员：创建排课 —— 一场课一行，多师多生一次成型
     *
     * 旧实现收 `studentIds` / `scheduleTypes` 数组却只取 `[0]` 插一行，其余学生以
     * `skipped_students` 静默丢弃（排一场「3 师 × 2 生」要提交 6 次）。现在整场一次写入，
     * `skipped_students` 连同它的静默丢弃、以及「单师 + 学生ID列表」的旧形状一起删掉。
     *
     * 请求体形状（唯一的形状）：
     * `teachers: [{teacher_id, type_id, category, lifecycle}]` + `students: [{student_id, family_participants}]`
     * 只有一位教师或一位学生也是这两个数组里的一项，没有另一种写法。
     */
    async adminCreateSchedule(req) {
        const b = req.body || {};
        const { date, startTime, endTime, location, notes } = b;

        // 基础验证：时间格式与先后关系（数据库还有 chk_cs_time_order 兜底）
        const toMinutes = (v) => {
            const m = /^([0-2]?\d):([0-5]\d)/.exec(String(v || ''));
            return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
        };
        const sMin = toMinutes(startTime);
        const eMin = toMinutes(endTime);
        if (isNaN(sMin) || isNaN(eMin)) {
            const message = '开始/结束时间格式不正确（HH:MM）';
            throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message, details: [{ field: 'time', message }] });
        }
        if (eMin <= sMin) {
            const message = '结束时间必须晚于开始时间';
            throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message, details: [{ field: 'time', message }] });
        }

        // 教师与学生就是两个 pair 名册（Joi 已要求必填、每位教师自带 type_id），
        // 不再从 teacherId / teacherIds / studentIds / scheduleTypes 归一 —— 那套旧形状已删除。
        const teachers = b.teachers;
        const students = b.students;

        if (!Array.isArray(teachers) || teachers.length === 0) throw new AppError('至少需要一位教师', 400);
        if (!Array.isArray(students) || students.length === 0) throw new AppError('至少需要一位学生', 400);

        // 教师/学生账号状态必须正常（列存在性统一经 SchemaHelper）
        const statusGuard = await this.assertParticipantsActive(
            teachers.map(t => t.teacher_id), students.map(s => s.student_id)
        );
        if (statusGuard) throw new AppError(statusGuard, 400);

        // 时段重叠不拦写入（业务上允许一位教师在重叠的两节课里），提示由前端负责：
        // 表单顶部的红横幅（updateConflictWarningBanner）+ 下拉项标红（updateTeacherStatusHints），
        // 这里只保证单条 INSERT 原子。
        let session;
        try {
            session = await courseSessionService.createSession({
                class_date: date,
                start_time: startTime,
                end_time: endTime,
                location: location || null,
                notes: notes || null,
                teachers,
                students
            }, { id: req.user.id, actorType: 'admin' });
        } catch (error) {
            this.translateWriteError(error);
        }

        return { id: session.id, session };
    }

    /**
     * 写库阶段错误 → HTTP 语义的**唯一**一份映射（新建与编辑共用，之前两边各写一套、
     * 编辑那套漏了数据库约束码，约束冲突直接变 500）。
     * 认不出的原样上抛，交给全局 errorHandler 归类（连接失败 → 503）。
     */
    translateWriteError(error) {
        if (error instanceof AppError) throw error;
        if (error && error.name === 'VersionConflictError') {
            throw new AppError({ code: 'CONFLICT', statusCode: 409, message: error.message });
        }
        if (error && error.name === 'SessionValidationError') {
            // rejectedFields 是字段名字符串数组，而响应信封要求 details 为对象数组 —— 在这里归一，
            // 别让两条写路径各给一种形状（原来是新建给对象、编辑给字符串数组或 null）
            const rejected = Array.isArray(error.rejectedFields) && error.rejectedFields.length
                ? error.rejectedFields.map(f => (typeof f === 'string'
                    ? { field: f, message: `字段「${f}」不能由这条接口写入` } : f))
                : [{ field: 'pair', message: error.message }];
            throw new AppError({
                code: 'BAD_REQUEST', statusCode: 400, message: error.message,
                details: rejected
            });
        }
        if (error && error.code === '23514') {
            throw new AppError({
                code: 'BAD_REQUEST', statusCode: 400, message: '检查约束冲突',
                details: [{ field: 'check', message: '不符合数据库检查约束（状态码 / 费用 / uid 唯一性）' }]
            });
        }
        if (error && error.code === '23503') {
            throw new AppError({
                code: 'BAD_REQUEST', statusCode: 400, message: '外键约束冲突',
                details: [{ field: 'fk', message: '教师/学生/类型不存在或已被删除' }]
            });
        }
        throw error;
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
     * 请求体里的 `teacher_uid` 指明操作哪一位教师。本场只有一位教师时可以不指名；
     * 多位教师而不指名 → 直接 400 要求指明，绝不默认落在名册的第一位上。
     * 整场增删参与者走 `teachers[]` / `students[]` 名册（一次请求应用完整 diff）。
     */
    async adminUpdateSchedule(req) {
        const { id } = req.params;
        const b = req.body || {};
        const actor = { id: req.user && req.user.id, actorType: 'admin' };

        const session = await courseSessionService.getSessionById(id);
        if (!session) throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '排课不存在' });

        // 权限落地：L3 只能改自己创建的记录（越权视为不存在，不暴露存在性）
        // 注意参数顺序是 (记录的 created_by, 操作者)，全仓其余 9 个调用点都是这个顺序；
        // 这里曾经写反成 (req.user, session)，导致 requiresOwnDataScope 把 session 当操作者、
        // 取不到 permissionLevel 而按最低档 L3 判定，再拿 Number(req.user) 去比 session.id
        // —— 结果任何级别的管理员保存排课都恒定 404。
        if (!canTouchRecord(session.created_by, req && req.user)) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '排课不存在' });
        }

        const notFound = () => new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '排课不存在' });

        // 钱不在这条接口上：混在排课保存里会被静默丢掉，所以动手前一次性拦掉。
        let version = b.version !== undefined ? Number(b.version) : Number(session.version);
        let current = session;

        try {
            // 拦在开事务之前：这是纯校验，抛错没必要先付 BEGIN/COMMIT 两次往返；
            // 放在 try 里是为了让它抛的 SessionValidationError 走同一份 400 映射（原来在 try 外 → 500）。
            courseSessionService.assertNoFeeFields(b);

            // 1) 头部字段（纯推导，放在外面是为了先数清这次到底要写几条语句）
            const headerPatch = {};
            if (b.date !== undefined) headerPatch.class_date = b.date;
            if (b.class_date !== undefined) headerPatch.class_date = b.class_date;
            if (b.start_time !== undefined) headerPatch.start_time = b.start_time;
            if (b.end_time !== undefined) headerPatch.end_time = b.end_time;
            if (b.location !== undefined) headerPatch.location = b.location;
            if (b.notes !== undefined) headerPatch.notes = b.notes;

            // 只动头部（时间/地点/备注）→ 一条 UPDATE 本身就原子，不必开事务：
            // 省 BEGIN + COMMIT 两次往返（远程库每条约 250ms）。判不准就按多条处理，宁可多包一层。
            const rosterTouched = Array.isArray(b.teachers) || Array.isArray(b.students);
            const pairTouched = PAIR_KEYS.some(k => b[k] !== undefined)
                || req.params.kind !== undefined || req.params.uid !== undefined;
            const needsTx = rosterTouched || pairTouched || Object.keys(headerPatch).length > 1;
            // 事务**不传** allowDegraded：降级那条路是「pool.query 顺序执行、没有事务保护」，
            // 等于把 13f4234 修掉的那类半截课（头部搬走了、pair 没跟着改）重新放回来。
            // 宁可让调用方拿到 503（db.js 翻成「数据库暂时不可用，无法安全执行事务」，
            // 前端提示稍后重试），也不要静默半写。
            // 运维前提：生产必须跑 pg Pool —— DB_CONNECTION_TYPE=pool，或留 auto 但确认
            // pool.connect() 真能用；驱动一旦落到 Neon HTTP，交互式事务不可用，这条接口会恒定 503。
            const runWrites = (work) => (needsTx
                ? db.runInTransaction(async (client, usePool) =>
                    work(usePool ? db.query.bind(db) : client.query.bind(client)))
                : work(db.query.bind(db)));

            return await runWrites(async (q) => {
                // 头部、名册、单 pair 状态是几条彼此独立的 UPDATE：放进同一个事务，中途出错整批回滚，
                // 不会留下「时间已经改了、教师还没换」这种半截课。
                // 时段重叠不拦写入（业务上允许一位教师/学生出现在重叠的两节课里），
                // 提示在表单侧做（下拉标红 + 顶部横幅），这里不再发冲突查询。

                if (Object.keys(headerPatch).length > 0) {
                    current = await courseSessionService.updateSessionHeader(id, headerPatch, actor, version, current, q);
                    version = Number(current.version);
                }

                const rejectedFields = [];
                if (Array.isArray(b.teachers) || Array.isArray(b.students)) {
                    // ---- 整场保存：请求带 teachers[] / students[]（每个元素 uid 有则 patch、无则 add）----
                    // 合并「去重难点」一页：uid 项 = updatePair（整列 patch + 生命周期）；无 uid = addPair。
                    const result = await courseSessionService.updatePairsBatch(id, b, actor, version, current, q);
                    if (result.notFound) throw notFound();
                    current = result.session;
                    version = Number(current.version);
                    rejectedFields.push(...(result.rejectedFields || []));

                    // 旧字段（teacher_uid / type_id / lifecycle / family_participants）仍然兼容：
                    // 批量描述未覆盖到的部分，由下方原有「单教师」逻辑兜底处理
                }

                // 定位教师 pair：URL :uid > body teacher_uid > 单教师自动检测 > teacher_id 匹配
                // （仅在没有批量 teachers 数组时才走到这里 —— 批量命中后其上已处理完所有 pair）
                // URL 上是 /students/:uid 时不走这条分支：拿学生 uid 找教师 pair 必然落空。
                const kindFromUrl = req.params.kind;
                const teachers = current.teachers || [];
                // 占位符 uid（旧前端未透传 teacher_uid 时会把字面量 "undefined"/"null" 拼进 URL）
                // 视作「未指定」，交给下面的单教师自动检测兜底 —— 否则拿这个假 uid 去 findPair
                // 必然落空，会把「没带 uid」误判成「排课不存在」。
                const sanitizeUid = (v) => {
                    const s = v == null ? '' : String(v).trim();
                    return (s === '' || s === 'undefined' || s === 'null') ? null : s;
                };
                let teacherUid = sanitizeUid(b.teacher_uid) || (kindFromUrl === 'student' ? null : sanitizeUid(req.params.uid));
                if (kindFromUrl !== 'student') {
                    // 本场只有一位教师时不必指名（那是「一位教师」的正常形状，不是猜人）；
                    // 多位教师时绝不按 teacher_id 猜第一个匹配的 pair —— 猜错就是改错人。
                    if (!teacherUid && teachers.length === 1) teacherUid = teachers[0].uid;
                    // 内容键与 TEACHER_PAIR_KEYS 同源（这里只不含 teacher_uid/uid 这类定位键：
                    // 指名了哪一位就不算「没指明」，加进去会误触下面的 400）
                    const wantsPairChange = b.teacher_id !== undefined || b.type_id !== undefined
                        || (Array.isArray(b.type_ids) && b.type_ids.length) || b.category !== undefined
                        || b.teacher_rating !== undefined || b.teacher_comment !== undefined
                        || b.lifecycle !== undefined || b.status !== undefined;
                    if (!teacherUid && wantsPairChange && teachers.length > 1) {
                        throw new AppError({
                            code: 'BAD_REQUEST', statusCode: 400,
                            message: `本场课有 ${teachers.length} 位教师，请用 teacher_uid 指明要改哪一位`,
                            details: [{ field: 'teacher_uid', message: '缺少 teacher_uid' }]
                        });
                    }
                }

                if (teacherUid && !(Array.isArray(b.teachers) && b.teachers.length)) {
                    // 2) pair 内容
                    const pairPatch = {};
                    if (b.teacher_id !== undefined) pairPatch.teacher_id = b.teacher_id;
                    if (b.category !== undefined) pairPatch.category = b.category;
                    if (b.type_id !== undefined) pairPatch.type_id = b.type_id;
                    if (Array.isArray(b.type_ids) && b.type_ids.length) pairPatch.type_id = b.type_ids[0];
                    if (b.teacher_rating !== undefined) pairPatch.teacher_rating = b.teacher_rating;
                    if (b.teacher_comment !== undefined) pairPatch.teacher_comment = b.teacher_comment;
                    // 费用键不进 patch：改钱只有费用接口那一条路（见文件开头 updateSchedule 的拦校验）
                    if (Object.keys(pairPatch).length > 0) {
                        const r = await courseSessionService.patchPair(id, 'teacher', teacherUid, pairPatch, actor, version, current, q);
                        if (r.notFound) throw notFound();
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
                                id, teacherUid, { type_id: b.type_id || (Array.isArray(b.type_ids) ? b.type_ids[0] : undefined) },
                                actor, version, current, { tx: q }
                            );
                            if (r.notFound) throw notFound();
                            current = r.session;
                            version = Number(current.version);
                        } else {
                            const r = await courseSessionService.setTeacherStatus(id, teacherUid, lifecycle, actor, b.notes, current, q);
                            if (!r.updated) throw notFound();
                            current = r.session;
                            version = Number(current.version);
                        }
                    }
                }

                // 学生 pair 的内容：URL /students/:uid 或 body student_uid 指明哪一位。
                // 换学生（student_id）2026-09-08 补上 —— 此前与换老师同病：请求带了也进不了白名单。
                if (!(Array.isArray(b.students) && b.students.length)) {
                    const wantsStudentChange = b.student_id !== undefined || b.family_participants !== undefined;
                    const studentCount = (current.students || []).length;
                    const resolvedStudentUid = b.student_uid
                        || (kindFromUrl === 'student' ? req.params.uid : null)
                        || (studentCount === 1 ? current.students[0].uid : null);
                    if (!resolvedStudentUid && wantsStudentChange && studentCount > 1) {
                        throw new AppError({
                            code: 'BAD_REQUEST', statusCode: 400,
                            message: `本场课有 ${studentCount} 位学生，请用 student_uid 指明要改哪一位`,
                            details: [{ field: 'student_uid', message: '缺少 student_uid' }]
                        });
                    }
                    const studentUid = resolvedStudentUid;
                    const studentPatch = {};
                    if (b.student_id !== undefined) studentPatch.student_id = b.student_id;
                    if (b.family_participants !== undefined) studentPatch.family_participants = b.family_participants;
                    if (studentUid && Object.keys(studentPatch).length > 0) {
                        const r = await courseSessionService.patchPair(
                            id, 'student', studentUid, studentPatch, actor, version, current, q
                        );
                        if (!r.notFound) {
                            current = r.session;
                            version = Number(current.version);
                            rejectedFields.push(...(r.rejectedFields || []));
                        }
                    }
                }

                const body = await this.decorateSessionNames(current, q);
                if (rejectedFields.length) body.rejectedFields = [...new Set(rejectedFields)];
                return body;
            });
        } catch (error) {
            // 乐观锁 / pair 校验 / 数据库约束都走同一份映射（与新建共用，见 translateWriteError）
            this.translateWriteError(error);
        }
    }

    /**
     * 管理员：删除整场课（含全部教师与学生 pair）
     * 三张审计表随 `ON DELETE CASCADE` 一并清理。
     * 只删一位教师/学生请走 `adminRemovePair`。
     */
    async adminDeleteSchedule(req) {
        const { id } = req.params;

        // 先验证排课是否存在（含 L3 归属校验：越权视为不存在）
        const existing = await db.query('SELECT id, created_by FROM course_sessions WHERE id = $1', [id]);
        if (!existing.rows || existing.rows.length === 0) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该排课记录' });
        }
        if (!canTouchRecord(existing.rows[0].created_by, req && req.user)) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该排课记录' });
        }

        // 不开事务：deleteSession 的主语句是单条 DELETE（本身原子），
        // 随后那条 session_change_logs 审计是「失败只告警」的旁路，包进事务也不会
        // 因它回滚删除。而每个 runInTransaction 要额外付 BEGIN + COMMIT 两次往返
        // （远程库每条约 250ms），这里省 500ms。
        await courseSessionService.deleteSession(id, { id: req.user && req.user.id, actorType: 'admin' });
        return { message: '排课删除成功' };
    }

    /**
     * 管理员：从一场课里移除一位教师或学生（删除的第二种粒度）。
     * 移除后该数组为空的场次会被整场删除 —— 这一点在确认弹窗里要如实提示。
     */
    async adminRemovePair(req) {
        const { id, uid } = req.params;
        const kind = req.params.kind === 'students' ? 'student' : 'teacher';
        const session = await courseSessionService.getSessionById(id);
        if (!session) throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该排课记录' });
        if (!canTouchRecord(session.created_by, req && req.user)) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该排课记录' });
        }
        const version = req.body && req.body.version !== undefined ? Number(req.body.version) : Number(session.version);
        const arr = kind === 'teacher' ? (session.teachers || []) : (session.students || []);

        // 最后一位 → 整场删除（服务层会拒绝把数组删空，这里把语义显式化）
        if (arr.length <= 1) {
            await courseSessionService.deleteSession(id, { id: req.user && req.user.id, actorType: 'admin' });
            return { message: '这是本场最后一位，已删除整场排课', deletedSession: true };
        }
        try {
            const r = await courseSessionService.removePair(id, kind, uid, { id: req.user.id, actorType: 'admin' }, version);
            if (r.notFound) throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该 pair' });
            return this.decorateSessionNames(r.session);
        } catch (error) {
            if (error instanceof AppError) throw error;
            if (error && error.name === 'VersionConflictError') {
                throw new AppError({ code: 'CONFLICT', statusCode: 409, message: error.message });
            }
            if (error && error.name === 'SessionValidationError') {
                throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: error.message });
            }
            throw error;
        }
    }

    /**
     * 管理员：往一场课里加一位教师或学生
     */
    async adminAddPair(req) {
        const { id } = req.params;
        const kind = req.params.kind === 'students' ? 'student' : 'teacher';
        const session = await courseSessionService.getSessionById(id);
        if (!session) throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该排课记录' });
        if (!canTouchRecord(session.created_by, req && req.user)) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该排课记录' });
        }
        const version = req.body && req.body.version !== undefined ? Number(req.body.version) : Number(session.version);
        const guard = kind === 'teacher'
            ? await this.assertParticipantsActive([req.body.teacher_id], [])
            : await this.assertParticipantsActive([], [req.body.student_id]);
        if (guard) throw new AppError(guard, 400);

        // 加参与者不拦时段重叠（业务允许）：这位新教师/新学生在同一时段有别的课，
        // 只在表单里提示，写库照过。单条 UPDATE 本身原子，不需要再包事务。
        try {
            const r = await courseSessionService.addPair(id, kind, req.body, { id: req.user.id, actorType: 'admin' }, version, null, session);
            if (r.notFound) throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到该排课记录' });
            const body = await this.decorateSessionNames(r.session);
            body.uid = r.uid;
            return body;
        } catch (error) {
            if (error instanceof AppError) throw error;
            if (error && error.name === 'VersionConflictError') {
                throw new AppError({ code: 'CONFLICT', statusCode: 409, message: error.message });
            }
            if (error && error.name === 'SessionValidationError') {
                throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: error.message });
            }
            throw error;
        }
    }

    /**
     * 管理员：确认排课（逻辑下沉自 admin-controller.confirmSchedule）
     */
    async adminConfirmSchedule(req) {
        const { id } = req.params;
        const { adminConfirmed } = req.body;

        // 权限落地：先校验存在性与 L3 归属（越权视为不存在）
        const targetRes = await db.query('SELECT id, created_by FROM course_sessions WHERE id = $1', [id]);
        if (!targetRes.rows || targetRes.rows.length === 0) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到排课记录' });
        }
        if (!canTouchRecord(targetRes.rows[0].created_by, req && req.user)) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到排课记录' });
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

        return { message: '课程确认状态更新成功' };
    }

    /**
     * 教师：获取排课列表（逻辑下沉自 teacher-controller.getSchedules）
     */
    async teacherListSchedules(req) {
        const { status } = req.query;
        const { startDate, endDate } = dateWindowOrAll(req.query);

        const dateExpr = 'ca.class_date';

        let query = `
            SELECT
                ca.id,
                ${dateExpr} AS date,
                ca.start_time, ca.end_time, ca.status,
                ca.teacher_id, ca.teacher_uid, ca.location,
                ca.student_uid, ca.fee_scope,
                t.name as teacher_name,
                ca.transport_fee, ca.other_fee,
                ca.fee_status,
                ca.status_category,
                -- 学生 pair 改属标志：口径唯一源在 course-session-service.sqlStudentSwapped
                ${sqlStudentSwapped('ca')} AS student_swapped,
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
            query += ` AND ${sqlNotMovedAway('ca')}`;
        }

        query += ` ORDER BY date, ca.start_time`;

        const result = await db.query(query, values);
        return result.rows;
    }

    /**
     * 教师：确认自己那个 pair 的课
     * 收敛到 `teacherUpdateScheduleStatus`（同一个原地重建语句），只是生命周期固定 confirmed。
     */
    async teacherConfirmSchedule(req) {
        const { teacherConfirmed, notes, teacher_uid } = req.body || {};
        if (!teacherConfirmed) {
            return { message: '课程确认状态更新成功' };
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
        const { id } = req.params;
        const { status, lifecycle, notes } = req.body || {};
        // uid 三处可拿：URL :uid > body.teacher_uid（兼容旧调用） > 自动定位
        const teacherUidFromBody = (req.body && req.body.teacher_uid) || null;
        const teacherUidFromUrl = req.params.uid || null;
        const wanted = lifecycle || status;

        if (!wanted) {
            throw new AppError('缺少课程状态', 400);
        }
        const normalizedStatus = String(wanted).trim().toLowerCase();
        if (!LESSON_STATUS_SET.has(normalizedStatus)) {
            throw new AppError('非法的课程状态值', 400);
        }

        const session = await courseSessionService.getSessionById(id);
        if (!session) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到相关课程' });
        }

        // 定位 pair：显式 uid（URL / body）优先；否则取本人在这一场里的那个 pair
        const teachers = session.teachers || [];
        let uid = teacherUidFromUrl || teacherUidFromBody;
        if (!uid) {
            const own = teachers.filter(p => Number(p.teacher_id) === Number(req.user.id));
            if (own.length === 1) uid = own[0].uid;
            else if (own.length > 1) {
                throw new AppError('本场课您有多条记录，请指明 teacher_uid', 400);
            }
        }

        // 权限前置检查：当前用户是不是「本人任课」或「该场学生在班主任名下」。
        // 必须在定位 pair 前先做 —— 班主任（head teacher）不是场中教师 pair 成员，
        // 但有合法改课权限；不允许在前一步先抛「未找到相关课程」挡住合法路径。
        // 班主任改的是**某一位教师**的记录，所以必须指名：本场只有一位教师时可以不传
        // （那就是那一位），多位教师而不传就报 400 —— 绝不默认落在名册第一位上。
        let hasPermission = false;
        if (uid) {
            const explicitPair = teachers.find(p => String(p.uid) === String(uid));
            if (explicitPair && Number(explicitPair.teacher_id) === Number(req.user.id)) {
                hasPermission = true;
            }
        }
        if (!hasPermission) {
            const { found, studentIds: bound } = await headTeacherService.getBoundStudentIds(req.user.id);
            const isHeadTeacher = found && (session.students || []).some(s => bound.includes(Number(s.student_id)));
            if (isHeadTeacher) {
                hasPermission = true;
                if (!uid) {
                    // cancelled / modified_away 是已归档 pair，改它们没有意义，只数在职的
                    const active = (teachers || []).filter(p => courseSessionService.isActive(p.status));
                    if (active.length === 1) uid = active[0].uid;
                    else if (active.length > 1) {
                        throw new AppError({
                            code: 'BAD_REQUEST',
                            statusCode: 400,
                            message: `本场课有 ${active.length} 位教师，请指明 teacher_uid（本场教师 uid：${active.map(p => p.uid).join('、')}）`
                        });
                    }
                }
            }
        }

        const pair = teachers.find(p => String(p.uid) === String(uid));
        if (!pair) {
            // 到这里还找不到 pair，说明：既不是本人任课，也不是班主任带的学生，或者
            // 显式给的 uid 不在 session 里 —— 一律视为越权（不暴露存在性，与全仓统一）
            throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '无权修改该课程状态（非本人任课且不属于所负责学生）' });
        }
        if (!hasPermission) {
            throw new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '无权修改该课程状态（非本人任课且不属于所负责学生）' });
        }

        let r;
        try {
            r = await courseSessionService.setTeacherStatus(
                id, uid, normalizedStatus,
                { id: req.user.id, actorType: req.user.userType === 'admin' ? 'admin' : 'teacher' },
                notes
            );
        } catch (error) {
            if (error && error.name === 'SessionValidationError') {
                throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: error.message });
            }
            throw error;
        }
        if (!r.updated) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到相关课程' });
        }
        return {
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
        };
    }

    /**
     * 教师：获取详细排课数据（逻辑下沉自 teacher-controller.getDetailedSchedules）
     */
    async teacherGetDetailedSchedules(req) {
        const { startDate, endDate } = dateWindowOrAll(req.query);
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
        return result.rows;
    }

    /**
     * 教师：获取班主任关联学生排课（逻辑下沉自 teacher-controller.getHeadTeacherStudentSchedules）
     */
    async teacherGetHeadTeacherStudentSchedules(req) {
        const { startDate, endDate } = dateWindowOrAll(req.query);

        // 获取教师信息和绑定的学生 ID
        const teacherResult = await db.query('SELECT student_ids FROM teachers WHERE id = $1', [req.user.id]);
        if (teacherResult.rows.length === 0) {
            throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '未找到教师信息' });
        }

        const studentIdsStr = teacherResult.rows[0].student_ids;
        if (!studentIdsStr) {
            return { students: [], schedules: [] }; // 没有绑定学生
        }

        // 解析绑定学生IDs
        const studentIds = studentIdsStr.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n));
        if (studentIds.length === 0) {
            return { students: [], schedules: [] };
        }

        const dateExpr = 'ca.class_date';

        // 查询关联学生的所有课程，过滤掉已取消的
        let query = `
            SELECT
                ca.id,
                ${dateExpr} AS date,
                ca.start_time, ca.end_time, ca.status,
                ca.location, ca.transport_fee, ca.other_fee,
                ca.fee_scope,
                ca.fee_status,
                ca.status_category,
                ca.teacher_uid,
                ca.student_uid,
                -- 学生 pair 改属标志：口径唯一源在 course-session-service.sqlStudentSwapped
                ${sqlStudentSwapped('ca')} AS student_swapped,
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
            query += ` AND ${sqlNotMovedAway('ca')}`;
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
        return { students: studentsResult.rows, schedules: result.rows };
    }

    /**
     * 学生：获取排课列表（逻辑下沉自 student-controller.getSchedules）
     */
    async studentListSchedules(req) {
        const { status } = req.query;
        const { startDate, endDate } = dateWindowOrAll(req.query);

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
            query += ` AND ${sqlNotMovedAway('ca')}`;
        }

        query += ` ORDER BY date, ca.start_time`;

        const result = await db.query(query, values);
        return result.rows;
    }

    // ============ 统计相关（逻辑下沉自 admin/teacher/student controller 的 stats 方法） ============

    /** 管理员：总览统计（教师/学生数量、排课统计等） */
    async adminOverviewStats(req) {
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
        //
        // 课程统计口径（业务裁定）：已取消 / 已调整（modified_away）= 这场课已经没了，
        // 月/周/年/总计都不计它，所以用 sqlActivePair 而不是 sqlNotMovedAway ——
        // 后者只藏「被调走的原课」，会把 cancelled 一并数进总数里。
        // 已取消另有独立指标位可见；费用不受这条口径约束（课取消了路可能已经跑过，
        // 仍要报销），口径分界的用例见 __tests__/services/export/status-scope-split.test.js。
        const COUNTABLE = sqlActivePair(null);
        const stats = await db.query(`
                SELECT
                    (SELECT COUNT(*) FROM teachers) as teacher_count,
                    (SELECT COUNT(*) FROM students) as student_count,
                    (SELECT COUNT(DISTINCT session_id) FROM v_session_pairs
                       WHERE class_date >= DATE_TRUNC('month', CURRENT_DATE)
                         AND ${COUNTABLE}${scopeSql}) as monthly_schedules,
                    (SELECT COUNT(DISTINCT session_id) FROM v_session_pairs
                       WHERE status = 'pending'
                         AND ${COUNTABLE}${scopeSql}) as pending_count,
                    (SELECT COUNT(DISTINCT session_id) FROM v_session_pairs
                       WHERE ${COUNTABLE}${scopeSql}) as total_schedules,
                    -- 本周：周一为一周之首，与前端原来的 getDay() 折算口径一致
                    (SELECT COUNT(DISTINCT session_id) FROM v_session_pairs
                       WHERE class_date >= DATE_TRUNC('week', CURRENT_DATE)
                         AND class_date < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '7 days'
                         AND ${COUNTABLE}${scopeSql}) as weekly_schedules,
                    (SELECT COUNT(DISTINCT session_id) FROM v_session_pairs
                       WHERE class_date >= DATE_TRUNC('year', CURRENT_DATE)
                         AND class_date < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'
                         AND ${COUNTABLE}${scopeSql}) as yearly_schedules,
                    (SELECT COUNT(DISTINCT session_id) FROM v_session_pairs
                       WHERE status = 'completed' AND ${COUNTABLE}${scopeSql}) as completed_schedules,
                    -- 已取消是「不计入总数、但要看得见」的那一档，不能再叠 COUNTABLE
                    (SELECT COUNT(DISTINCT session_id) FROM v_session_pairs
                       WHERE status = 'cancelled'${scopeSql}) as cancelled_schedules
            `, params);

        const rows = (stats && stats.rows) ? stats.rows : (Array.isArray(stats) ? stats : []);
        if (!rows[0]) {
            return {
                teacher_count: 0,
                student_count: 0,
                monthly_schedules: 0,
                pending_count: 0,
                total_schedules: 0,
                weekly_schedules: 0,
                yearly_schedules: 0,
                completed_schedules: 0,
                cancelled_schedules: 0
            };
        }

        return rows[0];
    }

    /** 管理员：排课类型统计（按日期范围） */
    async adminScheduleStats(req) {
        let { startDate, endDate } = req.query;

        // 默认「本月」按北京日历取（shared-utils 唯一实现）。原写法用 UTC 的
        // getFullYear/getMonth 构造再 toISOString 取日期，北京时间每月 1 号前 8 小时
        // 会整月落到上个月（审查报告 P1-17 实测：北京 11-01 00:30 → 窗口 = 10-01…10-31）。
        if (!startDate || startDate === '' || !endDate || endDate === '') {
            const window = beijingMonthWindow(new Date());
            if (!startDate || startDate === '') startDate = window.startDate;
            if (!endDate || endDate === '') endDate = window.endDate;
        }

        const dateExpr = 'ca.class_date';

        // 权限落地：L3 仅统计自己创建 + 无主存量的排课。
        // 口径：总览的课程类型分布按「课程」计数（DISTINCT session_id）——
        // 同一场课关联多名教师时叉积展开多行，不去重会把同一门课按人头重复计入。
        let statQuery = `
                SELECT
                    COALESCE(st.description, st.name) as type,
                    COUNT(DISTINCT ca.session_id) as count
                FROM v_session_pairs ca
                JOIN schedule_types st ON ca.type_id = st.id
                WHERE ${dateExpr} BETWEEN $1 AND $2
                  AND ${sqlActivePair('ca')}
            `;
        const statParams = [startDate, endDate];
        statQuery = applyOwnerScope(statQuery, statParams, req && req.user, "ca");
        statQuery += `
                GROUP BY COALESCE(st.description, st.name)
                ORDER BY count DESC
            `;

        const result = await db.query(statQuery, statParams);
        return result.rows;
    }

    /** 管理员：每日 × 类型 课程数（session 去重口径，供教师/学生视图的每日汇总图）。
     *  与 adminScheduleStats 同源同条件；特意不走 /schedules/grid —— 那边为排课管理
     *  做了师生 INNER JOIN 与删除过滤，会把"已删除师生参与"的课程整场丢掉，
     *  统计图例因此缺类型。 */
    async adminDailyScheduleStats(req) {
        let { startDate, endDate } = req.query;

        if (!startDate || startDate === '') {
            const now = new Date();
            startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        }
        if (!endDate || endDate === '') {
            const now = new Date();
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
        }

        const dateExpr = 'ca.class_date';
        let sql = `
                SELECT ${dateExpr}::date::text AS date,
                       COALESCE(st.description, st.name) AS type,
                       COUNT(DISTINCT ca.session_id) AS count
                FROM v_session_pairs ca
                JOIN schedule_types st ON ca.type_id = st.id
                WHERE ${dateExpr} BETWEEN $1 AND $2
                  AND ${sqlActivePair('ca')}
            `;
        const params = [startDate, endDate];
        sql = applyOwnerScope(sql, params, req && req.user, 'ca');
        sql += `
                GROUP BY 1, 2
                ORDER BY 1, count DESC
            `;

        const result = await db.query(sql, params);
        return result.rows;
    }

    /** 管理员：用户（教师/学生）汇总统计（按类型分组） */
    async adminUserStats(req) {
        let { startDate, endDate } = req.query;

        // 默认「本月」按北京日历取（shared-utils 唯一实现）。原写法用 UTC 的
        // getFullYear/getMonth 构造再 toISOString 取日期，北京时间每月 1 号前 8 小时
        // 会整月落到上个月（审查报告 P1-17 实测：北京 11-01 00:30 → 窗口 = 10-01…10-31）。
        if (!startDate || startDate === '' || !endDate || endDate === '') {
            const window = beijingMonthWindow(new Date());
            if (!startDate || startDate === '') startDate = window.startDate;
            if (!endDate || endDate === '') endDate = window.endDate;
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
        // COUNT(ca.id) 数的是 pair 行 = 人次（口径同 teacherStatistics，按人不按课）
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
                    AND ${sqlActivePair('ca')}${userScopeSql}
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
                    AND ${sqlActivePair('ca')}${userScopeSql}
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
            teacherStats: aggregateByPerson(teacherStats.rows, 'teacher_id', 'teacher_name'),
            studentStats: aggregateByPerson(studentStats.rows, 'student_id', 'student_name')
        };
    }

    /**
     * 教师：统计（按类型/按日/按月，指定日期范围）
     *
     * 计数单位是「人」不是「课」：v_session_pairs 一行 = 一个（教师 pair × 学生 pair），
     * 固定 teacher_id 后同一场课有几个学生就出几行，所以这里的 COUNT(*) = 这位老师的服务人次。
     * （裁定口径：课程级统计 adminOverviewStats / adminScheduleStats 按 session 去重，
     *  具体到某个人上课的语境按人数。2026-10-09 读生产库：385 场课全部单学生，
     *  今天两种单位同值；一旦启用多学生场次就会分叉，别顺手"修"成 DISTINCT session_id。）
     */
    async teacherStatistics(req) {
        const { startDate, endDate } = req.query;
        // 与学生统计同一条契约：缺日期是调用方漏参，必须 400。
        // 放任它进 `BETWEEN NULL AND NULL` 会得到「一张空图 + HTTP 200」，
        // 看上去像这段时间真的没课（审查报告 P2-6 里我一开始用「默认全量」修，方向错了：
        // 统计窗口的默认值属产品口径，而「缺参数就该报错」是已经写进测试的既有契约）。
        if (!startDate || !endDate) {
            throw new AppError('请提供日期范围', 400);
        }

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
                  AND ${sqlActivePair('ca')}
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
                  AND ${sqlActivePair('ca')}
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
                  AND ${sqlActivePair('ca')}
                GROUP BY DATE_TRUNC('month', ${dateExpr})
                ORDER BY month
            `, [req.user.id, startDate, endDate])
        ]);

        return {
            typeStats: typeStatsResult.rows.map(row => ({
                type: normalizeReviewLabel(row.type),
                count: row.count
            })),
            monthlyStats: monthlyStatsResult.rows,
            dailyStats: dailyStatsResult.rows.map(row => Object.assign({}, row, { type: normalizeReviewLabel(row.type) }))
        };
    }

    /** 教师：仪表盘总览（周/月/年计数、状态计数、今日课程） */
    async teacherOverview(req) {
        /**
         * 周/月/年窗口一律走北京日历（shared-utils 的唯一实现）。
         *
         * 原写法是「UTC 组件做加减法 + Asia/Shanghai 做渲染」——同一个日期被当成
         * 两天用：北京时间 00:00–08:00 之间 getDay()/getDate() 还是昨天，于是
         * 周窗口整体 +1 天（本周一被排除、下周一被算进来），仪表盘「本周」计数
         * 每天早上都错一次（审查报告 P1-17 实测复现）。
         */
        const now = new Date();
        const weekWindow = beijingWeekWindow(now);
        const monthWindow = beijingMonthWindow(now);
        const { year: beijingYear } = beijingCalendarParts(now);

        const todayStr = toBeijingDateKey(now);
        const weekStartStr = weekWindow.startDate;
        const weekEndStr = weekWindow.endDate;
        const monthStartStr = monthWindow.startDate;
        const monthEndStr = monthWindow.endDate;
        const yearStartStr = `${beijingYear}-01-01`;
        const yearEndStr = `${beijingYear}-12-31`;

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
            weeklyCount: parseInt(statsResult.rows[0]?.weekly_count || 0),
            monthlyCount: parseInt(statsResult.rows[0]?.monthly_count || 0),
            yearlyCount: parseInt(statsResult.rows[0]?.yearly_count || 0),
            totalPending: parseInt(statsResult.rows[0]?.total_pending || 0),
            totalCompleted: parseInt(statsResult.rows[0]?.total_completed || 0),
            totalCancelled: parseInt(statsResult.rows[0]?.total_cancelled || 0),
            todaySchedules: todaySchedules.rows
        };
    }

    /**
     * 学生：统计（类型/月度/明细，指定日期范围）
     *
     * 与 teacherStatistics 同一套「按人」单位：固定 student_id 后一场课有几位老师就出几行，
     * COUNT(*) 数的是这个人的上课人次，不是场次数。
     */
    async studentStatistics(req) {
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            throw new AppError('请提供日期范围', 400);
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
                  AND ${sqlActivePair('ca')}
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
                  AND ${sqlActivePair('ca')}
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
                  AND ${sqlActivePair('ca')}
                ORDER BY date DESC, ca.start_time ASC
            `, [req.user.id, startDate, endDate])
        ]);

        return {
            typeStats: typeStats.rows.map(row => ({
                type: normalizeReviewLabel(row.type),
                count: row.count
            })),
            monthlyStats: monthlyStats.rows,
            schedules: schedules.rows.map(row => Object.assign({}, row, {
                schedule_type: normalizeScheduleTypeKey(row.schedule_type)
            }))
        };
    }

    /** 学生：仪表盘总览（周/月/年计数、状态计数、今日课程） */
    async studentOverview(req) {
        /**
         * 周/月/年窗口一律走北京日历（shared-utils 的唯一实现）。
         *
         * 原写法是「UTC 组件做加减法 + Asia/Shanghai 做渲染」——同一个日期被当成
         * 两天用：北京时间 00:00–08:00 之间 getDay()/getDate() 还是昨天，于是
         * 周窗口整体 +1 天（本周一被排除、下周一被算进来），仪表盘「本周」计数
         * 每天早上都错一次（审查报告 P1-17 实测复现）。
         */
        const now = new Date();
        const weekWindow = beijingWeekWindow(now);
        const monthWindow = beijingMonthWindow(now);
        const { year: beijingYear } = beijingCalendarParts(now);

        const todayStr = toBeijingDateKey(now);
        const weekStartStr = weekWindow.startDate;
        const weekEndStr = weekWindow.endDate;
        const monthStartStr = monthWindow.startDate;
        const monthEndStr = monthWindow.endDate;
        const yearStartStr = `${beijingYear}-01-01`;
        const yearEndStr = `${beijingYear}-12-31`;

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
                  AND ${sqlNotMovedAway('ca')}
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
                  AND ${sqlNotMovedAway('ca')}
                ORDER BY ca.start_time
            `, [req.user.id, todayStr])
        ]);

        return {
            weeklyCount: parseInt(statsResult.rows[0]?.weekly_count || 0),
            monthlyCount: parseInt(statsResult.rows[0]?.monthly_count || 0),
            yearlyCount: parseInt(statsResult.rows[0]?.yearly_count || 0),
            totalPending: parseInt(statsResult.rows[0]?.total_pending || 0),
            totalCompleted: parseInt(statsResult.rows[0]?.total_completed || 0),
            totalCancelled: parseInt(statsResult.rows[0]?.total_cancelled || 0),
            todaySchedules: todaySchedules.rows
        };
    }
}

module.exports = new ScheduleService();
