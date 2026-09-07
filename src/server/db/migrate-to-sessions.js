/**
 * 存量迁移：course_arrangement（一行 = 教师×学生×类型×时段）→ course_sessions（一行 = 一场课）
 * @description 一次性脚本，可重跑（先 TRUNCATE）。用法：node src/server/db/migrate-to-sessions.js [--dry]
 *
 * 分组口径：(class_date, start_time, end_time, location) 相同即同一场。
 *   - location 直接进分组键：NULL 与真实值两种，GROUP BY 把 NULL 视为相等，无空串（已实测）。
 * 教师 pair 去重键：(teacher_id, course_id, status, adjustment_type)
 *   —— 现网有 4 组「作废+增补」是同教师两行两类型，按此键各成一个 pair，靠 uid 区分。
 * 学生 pair 去重键：student_id
 * 状态映射：新 status = <类别>.<生命周期>
 *   类别 ← adjustment_type：NULL/0 → normal，1 → temp，2 → adjusted
 *   生命周期 ← status：原字面量原样保留（含 modified_away），不改名
 * is_temp 整列丢弃（519 行全 NULL，从未被写入）。
 */

require('dotenv').config();
const db = require('./db');
const logger = require('../utils/logger.js');

const CATEGORY_BY_ADJUSTMENT = { 0: 'normal', 1: 'temp', 2: 'adjusted' };
const LIFECYCLES = new Set(['pending', 'confirmed', 'completed', 'cancelled', 'modified_away']);

/** 旧行 → 新状态码；映射不认识的值直接抛错，宁可迁移失败也不静默造脏数据 */
function toStatusCode(row) {
    const category = CATEGORY_BY_ADJUSTMENT[row.adjustment_type == null ? 0 : Number(row.adjustment_type)];
    const lifecycle = String(row.status || '').trim();
    if (!category) throw new Error(`未知 adjustment_type=${row.adjustment_type}（排课 ${row.id}）`);
    if (!LIFECYCLES.has(lifecycle)) throw new Error(`未知 status=${row.status}（排课 ${row.id}）`);
    return `${category}.${lifecycle}`;
}

// 空地点的哨兵：分组键里必须能区分「地点为 NULL」与「地点是空串」。
// 两处（折叠时与回读映射时）必须用同一个常量 —— 早先两边写法不一致，
// 导致 location IS NULL 的场次回读时对不上，审计转写静默丢了 15 行。
const NULL_LOCATION = '~NULL~';

/**
 * 分组键。日期一律用库里直接给出的 'YYYY-MM-DD' 文本：
 * pg 驱动会把 date 解析成「本地零点」的 Date，再 toISOString() 会按 UTC 偏移整体挪一天
 * （UTC+8 下变成前一天）—— 这个坑已经让第一次导入的 330 行日期全部早了一天。
 */
const sessionKeyOf = (row) => [
    String(row.class_date).slice(0, 10),
    row.start_time, row.end_time, row.location == null ? NULL_LOCATION : row.location
].join('|');

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const int = (v) => (v === null || v === undefined || v === '' ? null : parseInt(v, 10));

/** 同一 pair 落在多行时取第一个非空值；两行都非空且不相等时记为冲突交由调用方报告 */
function pick(current, incoming, conflicts, label) {
    if (incoming === null || incoming === undefined) return current;
    if (current === null || current === undefined) return incoming;
    if (String(current) !== String(incoming)) conflicts.push(`${label}: ${current} vs ${incoming}`);
    return current;
}

/**
 * 把平铺行折叠成场次。返回 { sessions, oldIdToPair, conflicts }
 * oldIdToPair: 旧 schedule_id → { sessionKey, teacherUid }，供两张审计表转写
 */
function foldRows(rows) {
    const sessions = new Map();       // sessionKey → session
    const oldIdToPair = new Map();    // old id → { sessionKey, teacherUid }
    const conflicts = [];

    for (const row of rows) {
        const key = sessionKeyOf(row);
        if (!sessions.has(key)) {
            sessions.set(key, {
                key,
                class_date: sessionKeyOf(row).split('|')[0],
                start_time: row.start_time,
                end_time: row.end_time,
                location: row.location == null ? null : row.location,
                created_by: int(row.created_by),
                created_at: row.created_at,
                updated_at: row.updated_at,
                teacherByKey: new Map(),
                studentById: new Map()
            });
        }
        const s = sessions.get(key);

        // 头部：谁先建的（最早 created_at 对应的 created_by）、最后一次改动时间
        if (row.created_at && s.created_at && new Date(row.created_at) < new Date(s.created_at)) {
            s.created_at = row.created_at;
            s.created_by = int(row.created_by);
        } else if (s.created_by == null) {
            s.created_by = int(row.created_by);
        }
        if (row.updated_at && (!s.updated_at || new Date(row.updated_at) > new Date(s.updated_at))) {
            s.updated_at = row.updated_at;
        }

        // 教师 pair
        const statusCode = toStatusCode(row);
        const tKey = `${row.teacher_id}|${row.course_id}|${statusCode}`;
        if (!s.teacherByKey.has(tKey)) {
            s.teacherByKey.set(tKey, {
                teacher_id: int(row.teacher_id),
                type_id: int(row.course_id),
                status: statusCode,
                auto_at: row.last_auto_update || null,
                teacher_rating: int(row.teacher_rating),
                teacher_comment: row.teacher_comment || null,
                transport_fee: num(row.transport_fee),
                other_fee: num(row.other_fee),
                fee_status: row.fee_status || 'draft',
                created_by: int(row.created_by)
            });
        } else {
            const t = s.teacherByKey.get(tKey);
            const where = `场次 ${key} 教师 ${row.teacher_id}`;
            t.transport_fee = pick(t.transport_fee, num(row.transport_fee), conflicts, `${where} transport_fee`);
            t.other_fee = pick(t.other_fee, num(row.other_fee), conflicts, `${where} other_fee`);
            t.fee_status = pick(t.fee_status, row.fee_status, conflicts, `${where} fee_status`);
            t.teacher_rating = pick(t.teacher_rating, int(row.teacher_rating), conflicts, `${where} teacher_rating`);
            if (!t.auto_at && row.last_auto_update) t.auto_at = row.last_auto_update;
        }
        oldIdToPair.set(Number(row.id), { sessionKey: key, teacherKey: tKey });

        // 学生 pair
        const sid = int(row.student_id);
        if (sid != null && !s.studentById.has(sid)) {
            s.studentById.set(sid, {
                student_id: sid,
                student_rating: int(row.student_rating),
                student_comment: row.student_comment || null,
                family_participants: int(row.family_participants) ?? 4,
                created_by: int(row.created_by)
            });
        }
    }

    // 定 uid：教师 t1..tn、学生 s1..sn，顺序即插入顺序（同一个 row_number 语义）
    for (const s of sessions.values()) {
        s.teachers = [];
        let i = 0;
        for (const [tKey, pair] of s.teacherByKey) {
            const uid = `t${++i}`;
            s.teacherUidByKey = s.teacherUidByKey || new Map();
            s.teacherUidByKey.set(tKey, uid);
            s.teachers.push({ uid, ...pair });
        }
        s.students = [];
        let j = 0;
        for (const pair of s.studentById.values()) {
            s.students.push({ uid: `s${++j}`, ...pair });
        }
    }

    // 把 teacherKey 换成最终 uid
    for (const [oldId, ref] of oldIdToPair) {
        const s = sessions.get(ref.sessionKey);
        oldIdToPair.set(oldId, { sessionKey: ref.sessionKey, teacherUid: s.teacherUidByKey.get(ref.teacherKey) });
    }

    return { sessions: [...sessions.values()], oldIdToPair, conflicts };
}

const INSERT_SESSIONS = `
INSERT INTO course_sessions
       (class_date, start_time, end_time, location, notes, teachers, students, created_by, created_at, updated_at)
SELECT (x->>'class_date')::date,
       (x->>'start_time')::time,
       (x->>'end_time')::time,
       x->>'location',
       NULL,                              -- notes 是新字段，历史行留空
       x->'teachers',
       x->'students',
       NULLIF(x->>'created_by','')::int,
       (x->>'created_at')::timestamptz,
       (x->>'updated_at')::timestamptz
  FROM jsonb_array_elements($1::jsonb) x`;
// updated_by 不填：旧表没这列，历史行的「最后修改人」不可知，留 NULL 比编一个值诚实。
// teacher_ids / student_ids 不出现在列清单里 —— GENERATED ALWAYS，数据库自己算。

/** 用自然键（分组键）把新 id 映射回来：分组键在新表内唯一，无需依赖 RETURNING 顺序 */
async function buildKeyToId() {
    const r = await db.query(`
        SELECT id, to_char(class_date, 'YYYY-MM-DD') AS d,
               start_time::text AS st, end_time::text AS et, location
          FROM course_sessions`);
    const map = new Map();
    for (const row of r.rows || []) {
        map.set([row.d, row.st, row.et, row.location == null ? NULL_LOCATION : row.location].join('|'), Number(row.id));
    }
    return map;
}

const INSERT_FEE_AUDIT = `
INSERT INTO session_fee_audit_logs
       (session_id, teacher_uid, operator_id, operator_role,
        old_transport_fee, new_transport_fee, old_other_fee, new_other_fee, created_at)
SELECT (x->>'session_id')::int, x->>'teacher_uid', (x->>'operator_id')::int, x->>'operator_role',
       NULLIF(x->>'old_transport_fee','')::numeric, NULLIF(x->>'new_transport_fee','')::numeric,
       NULLIF(x->>'old_other_fee','')::numeric, NULLIF(x->>'new_other_fee','')::numeric,
       (x->>'created_at')::timestamptz
  FROM jsonb_array_elements($1::jsonb) x`;

const INSERT_FEE_STATUS = `
INSERT INTO session_fee_status_logs
       (session_id, teacher_uid, old_status, new_status, operator_id, actor_type, note, created_at)
SELECT (x->>'session_id')::int, x->>'teacher_uid', x->>'old_status', x->>'new_status',
       NULLIF(x->>'operator_id','')::int, x->>'actor_type', x->>'note', (x->>'created_at')::timestamptz
  FROM jsonb_array_elements($1::jsonb) x`;

// 只读需要的列（不含全 NULL 的死列 is_temp），并分页读取：
// Neon HTTP 驱动下一次性拉回全部宽行容易 fetch terminated，分页后每次载荷都很小。
const OLD_COLUMNS = `id, teacher_id, student_id, course_id,
    class_date::text AS class_date, start_time::text AS start_time, end_time::text AS end_time, location,
    created_at, updated_at, status, adjustment_type, last_auto_update,
    student_rating, teacher_rating, student_comment, teacher_comment,
    created_by, family_participants, transport_fee, other_fee, fee_status`;

async function loadOldRows(pageSize = 200) {
    const rows = [];
    let lastId = 0;
    for (;;) {
        const r = await db.query(
            `SELECT ${OLD_COLUMNS} FROM course_arrangement WHERE id > $1 ORDER BY id LIMIT $2`,
            [lastId, pageSize]
        );
        const page = r.rows || [];
        rows.push(...page);
        if (page.length < pageSize) break;
        lastId = Number(page[page.length - 1].id);
    }
    return rows;
}

/** 迁移主流程。dry=true 只折叠并打印对数，不写库。 */
async function run({ dry = false } = {}) {
    const rows = await loadOldRows();
    console.log(`旧表读入 ${rows.length} 行`);

    const { sessions, oldIdToPair, conflicts } = foldRows(rows);
    const teacherPairs = sessions.reduce((n, s) => n + s.teachers.length, 0);
    const studentPairs = sessions.reduce((n, s) => n + s.students.length, 0);

    const hist = {};
    for (const s of sessions) for (const t of s.teachers) hist[t.status] = (hist[t.status] || 0) + 1;

    const oldSum = rows.reduce((a, r) => a + (Number(r.transport_fee) || 0) + (Number(r.other_fee) || 0), 0);
    const newSum = sessions.reduce((a, s) => a + s.teachers.reduce(
        (b, t) => b + (Number(t.transport_fee) || 0) + (Number(t.other_fee) || 0), 0), 0);

    console.log(`折叠为 ${sessions.length} 场；教师 pair ${teacherPairs} 个、学生 pair ${studentPairs} 个`);
    console.log('状态直方图：', JSON.stringify(hist, null, 0));
    console.log(`费用合计：旧 ${oldSum.toFixed(2)} / 新 ${newSum.toFixed(2)}（一趟一笔口径下应相等，因为无同教师跨行填费用的场次）`);
    if (conflicts.length) {
        console.log(`⚠ pair 内字段冲突 ${conflicts.length} 处（取首个非空值）：`);
        conflicts.slice(0, 20).forEach(c => console.log('   ', c));
    } else {
        console.log('pair 内字段无冲突');
    }
    if (dry) { console.log('\n--dry：未写入任何数据'); return { sessions, hist }; }

    await db.query('TRUNCATE course_sessions RESTART IDENTITY CASCADE');
    const payload = sessions.map(s => ({
        class_date: s.class_date,
        start_time: s.start_time,
        end_time: s.end_time,
        location: s.location,
        created_by: s.created_by,
        created_at: s.created_at,
        updated_at: s.updated_at,
        teachers: s.teachers,
        students: s.students
    }));
    await db.query(INSERT_SESSIONS, [JSON.stringify(payload)]);

    const keyToId = await buildKeyToId();
    const resolve = (oldId) => {
        const ref = oldIdToPair.get(Number(oldId));
        if (!ref) return null;
        const sid = keyToId.get(ref.sessionKey);
        return sid ? { session_id: sid, teacher_uid: ref.teacherUid } : null;
    };

    const feeAudit = await db.query(`SELECT * FROM fee_audit_logs ORDER BY id`);
    const feeAuditRows = (feeAudit.rows || []).map(r => {
        const ref = resolve(r.schedule_id);
        return ref && { ...ref, operator_id: r.operator_id, operator_role: r.operator_role,
            old_transport_fee: r.old_transport_fee, new_transport_fee: r.new_transport_fee,
            old_other_fee: r.old_other_fee, new_other_fee: r.new_other_fee, created_at: r.created_at };
    }).filter(Boolean);
    if (feeAuditRows.length) await db.query(INSERT_FEE_AUDIT, [JSON.stringify(feeAuditRows)]);

    const feeStatus = await db.query(`SELECT * FROM fee_status_logs ORDER BY id`);
    const feeStatusRows = (feeStatus.rows || []).map(r => {
        const ref = resolve(r.schedule_id);
        return ref && { ...ref, old_status: r.old_status, new_status: r.new_status,
            operator_id: r.operator_id, actor_type: r.actor_type, note: r.note, created_at: r.created_at };
    }).filter(Boolean);
    if (feeStatusRows.length) await db.query(INSERT_FEE_STATUS, [JSON.stringify(feeStatusRows)]);

    const check = await db.query(`
        SELECT count(*)::int AS sessions,
               (SELECT count(*)::int FROM v_session_pairs) AS pairs,
               (SELECT count(*)::int FROM course_sessions WHERE teacher_ids = '{}') AS empty_tids,
               (SELECT count(*)::int FROM session_fee_audit_logs) AS fee_audit,
               (SELECT count(*)::int FROM session_fee_status_logs) AS fee_status
          FROM course_sessions`);
    console.log('\n落库核对：', JSON.stringify(check.rows[0]));
    console.log(`审计转写：fee_audit_logs ${feeAudit.rows.length} → ${feeAuditRows.length}，fee_status_logs ${feeStatus.rows.length} → ${feeStatusRows.length}`);
    return { sessions, hist };
}

if (require.main === module) {
    run({ dry: process.argv.includes('--dry') })
        .then(() => process.exit(0))
        .catch(e => { logger.error('迁移失败:', e); console.error(e.message); process.exit(1); });
}

module.exports = { toStatusCode, sessionKeyOf, foldRows, run };
