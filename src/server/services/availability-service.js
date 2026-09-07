/**
 * availability-service.js —— 空闲时段子域共享逻辑层（D1-4）
 *
 * 集中三端（teacher / student / admin）共用的「时段槽位」纯函数与归一化规则，
 * 并承载 teacher 端最复杂的空闲时段读写事务（含 R2 原子保存 replaceAvailability）。
 *
 * 设计约定：
 * - 纯函数（SLOT_COLUMNS / normalize* / collect* / map*）零副作用，可单测；
 * - 事务方法接受 `tx`（事务内查询函数）或 `db`（直连查询），不直接开事务，
 *   由控制器负责事务边界，便于 mock 校验 SQL 序列；
 * - SQL 逐字沿用原控制器实现，保证行为一致、零回归。
 */

// ============================================================
// 共享纯函数（原 teacher-controller 本地定义，现集中复用）
// ============================================================

const SLOT_COLUMNS = Object.freeze({
    morning: 'morning_available',
    afternoon: 'afternoon_available',
    evening: 'evening_available'
});

const { requiresOwnDataScope, canTouchRecord } = require('../utils/admin-permissions');

/** 时段 key 归一化：仅返回受支持的 morning/afternoon/evening，否则 null */
function normalizeSlotKey(raw) {
    if (!raw && raw !== 0) return null;
    const key = String(raw).trim().toLowerCase();
    return SLOT_COLUMNS[key] ? key : null;
}

/** 日期字符串校验：YYYY-MM-DD */
function isValidDateString(raw) {
    const str = String(raw == null ? '' : raw).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

/** 时段可用值归一化：统一为 0 / 1 / null（未知） */
function normalizeSlotValue(raw) {
    if (raw === null || typeof raw === 'undefined') return null;
    if (typeof raw === 'object' && raw !== null) {
        if (Object.prototype.hasOwnProperty.call(raw, 'available')) {
            return normalizeSlotValue(raw.available);
        }
        if (Object.prototype.hasOwnProperty.call(raw, 'status')) {
            return normalizeSlotValue(raw.status);
        }
    }
    if (typeof raw === 'number') {
        if (raw === 1) return 1;
        if (raw === 0) return 0;
        return null;
    }
    if (typeof raw === 'boolean') {
        return raw ? 1 : 0;
    }
    const text = String(raw).trim().toLowerCase();
    if (!text) return null;
    if (['available', 'true', 'yes', '1', 'enabled', 'enable', '开放'].includes(text)) return 1;
    if (['unavailable', 'false', 'no', '0', 'disabled', 'disable', 'not-set', '关闭'].includes(text)) return 0;
    return null;
}

/** 将前端 availabilityList 聚合为 Map<date, { morning, afternoon, evening }> */
function collectAvailabilityUpdates(list) {
    if (!Array.isArray(list)) {
        return new Map();
    }
    const byDate = new Map();
    for (const item of list) {
        if (!item || !item.date) {
            continue;
        }
        const date = String(item.date).trim();
        if (!date) continue;
        const ensureBucket = () => {
            if (!byDate.has(date)) {
                byDate.set(date, { morning: null, afternoon: null, evening: null });
            }
            return byDate.get(date);
        };

        if (item.slots && typeof item.slots === 'object') {
            const bucket = ensureBucket();
            for (const [rawSlot, rawValue] of Object.entries(item.slots)) {
                const slot = normalizeSlotKey(rawSlot);
                if (!slot) continue;
                const value = normalizeSlotValue(rawValue);
                if (value === null) continue;
                bucket[slot] = value;
            }
            continue;
        }

        const slot = normalizeSlotKey(item.timeSlot || item.slot || item.time_slot);
        if (!slot) continue;
        const value = normalizeSlotValue(item.isAvailable ?? item.available ?? item.status);
        if (value === null) continue;
        const bucket = ensureBucket();
        bucket[slot] = value;
    }
    return byDate;
}

/** teacher 行 → 前端可用性对象 */
function mapRowToAvailability(row) {
    return {
        id: row.id,
        date: row.date,
        morning_available: Number(row.morning_available) || 0,
        afternoon_available: Number(row.afternoon_available) || 0,
        evening_available: Number(row.evening_available) || 0,
        slots: {
            morning: Number(row.morning_available) === 1,
            afternoon: Number(row.afternoon_available) === 1,
            evening: Number(row.evening_available) === 1
        }
    };
}

/** slot → 数据库列名；非法键返回 null */
function slotToColumn(slot) {
    return SLOT_COLUMNS[slot] || null;
}

/** 任意真值 → 1，否则 0（admin 端布尔直转位） */
function toSlotBit(value) {
    return value ? 1 : 0;
}

// ============================================================
// teacher 端空闲时段读写（事务方法接受 tx）
// ============================================================

/** 读取 teacher 指定日期范围的空闲行 */
async function getTeacherAvailability(db, actorId, startDate, endDate) {
    const result = await db.query(
        `SELECT id, date, morning_available, afternoon_available, evening_available
         FROM teacher_daily_availability
         WHERE teacher_id = $1
           AND date BETWEEN $2 AND $3
         ORDER BY date`,
        [actorId, startDate, endDate]
    );
    return result.rows.map(mapRowToAvailability);
}

/**
 * 批量设置 teacher 时间安排（diff 已有行后 upsert）。
 * tx: 事务查询函数；actorId: teacher id；availabilityList: 前端数组。
 * 返回 { insertCount, updateCount, unchangedCount }
 */
async function setTeacherAvailability(tx, actorId, availabilityList) {
    const updatesByDate = collectAvailabilityUpdates(availabilityList);
    let insertCount = 0;
    let updateCount = 0;
    let unchangedCount = 0;

    // 先把要处理的日期挑出来（校验放在前面，报错行为与逐条时代一致）
    const pending = [];
    for (const [rawDate, slots] of updatesByDate.entries()) {
        if (!isValidDateString(rawDate)) {
            throw new Error(`无效的日期格式: ${rawDate}`);
        }
        const hasExplicitUpdate = ['morning', 'afternoon', 'evening'].some(slot => typeof slots[slot] === 'number');
        if (!hasExplicitUpdate) {
            unchangedCount++;
            continue;
        }
        pending.push({ date: rawDate, slots });
    }
    if (pending.length === 0) return { insertCount, updateCount, unchangedCount };

    // 往返固定 2 次（一次读现值、一次写回），不随日期数增长：
    // 原实现是每个日期「先 SELECT 再 UPDATE/INSERT」，远程库每条约 250ms，一周七天就是 3.5 秒。
    const existing = await tx(
        `SELECT date, morning_available, afternoon_available, evening_available
         FROM teacher_daily_availability
         WHERE teacher_id = $1 AND date = ANY($2::date[])`,
        [actorId, pending.map(p => p.date)]
    );
    const asKey = (d) => (d instanceof Date
        ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        : String(d).slice(0, 10));
    const current = new Map(((existing && existing.rows) || []).map(r => [asKey(r.date), r]));

    const writes = [];
    for (const { date, slots } of pending) {
        const currentRow = current.get(date) || null;
        const pick = (slot, col) => (typeof slots[slot] === 'number'
            ? slots[slot]
            : (currentRow ? Number(currentRow[col]) || 0 : 0));
        const nextValues = {
            morning: pick('morning', 'morning_available'),
            afternoon: pick('afternoon', 'afternoon_available'),
            evening: pick('evening', 'evening_available')
        };

        const hasChange = !currentRow ||
            Number(currentRow.morning_available) !== nextValues.morning ||
            Number(currentRow.afternoon_available) !== nextValues.afternoon ||
            Number(currentRow.evening_available) !== nextValues.evening;

        if (!hasChange) {
            unchangedCount++;
            continue;
        }
        writes.push({ date, ...nextValues });
        if (currentRow) updateCount++; else insertCount++;
    }

    if (writes.length > 0) {
        const params = [actorId];
        const tuples = writes.map((w) => {
            params.push(w.date, w.morning, w.afternoon, w.evening);
            const n = params.length;
            return `($1, $${n - 3}, $${n - 2}, $${n - 1}, $${n}, '00:00:00', '23:59:59', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;
        });
        await tx(
            `INSERT INTO teacher_daily_availability
                 (teacher_id, date, morning_available, afternoon_available, evening_available, start_time, end_time, created_at, updated_at)
             VALUES ${tuples.join(', ')}
             ON CONFLICT (teacher_id, date) DO UPDATE SET
                 morning_available = EXCLUDED.morning_available,
                 afternoon_available = EXCLUDED.afternoon_available,
                 evening_available = EXCLUDED.evening_available,
                 updated_at = CURRENT_TIMESTAMP`,
            params
        );
    }

    return { insertCount, updateCount, unchangedCount };
}

/**
 * 批量删除 teacher 时间安排（单槽置 0，全零则整行删除）。
 * operations: [{ date, timeSlot?, slot?, time_slot?, removeAll? }]
 * 返回 { updateCount, deleteCount }
 */
async function deleteTeacherAvailability(tx, actorId, operations) {
    let updateCount = 0;
    let deleteCount = 0;

    for (const op of operations) {
        if (!isValidDateString(op.date)) {
            throw new Error(`无效的日期格式: ${op.date}`);
        }

        if (op.removeAll) {
            const del = await tx(
                `DELETE FROM teacher_daily_availability
                 WHERE teacher_id = $1 AND date = $2`,
                [actorId, op.date]
            );
            deleteCount += del.rowCount || 0;
            continue;
        }

        const slot = normalizeSlotKey(op.timeSlot || op.slot || op.time_slot);
        if (!slot) {
            continue;
        }
        const column = SLOT_COLUMNS[slot];
        const updated = await tx(
            `UPDATE teacher_daily_availability
             SET ${column} = 0,
                 updated_at = CURRENT_TIMESTAMP
             WHERE teacher_id = $1 AND date = $2
             RETURNING morning_available, afternoon_available, evening_available`,
            [actorId, op.date]
        );

        if (updated.rowCount === 0) {
            continue;
        }

        const row = updated.rows[0];
        const allZero = ['morning_available', 'afternoon_available', 'evening_available']
            .every(key => Number(row[key]) === 0);

        if (allZero) {
            const del = await tx(
                `DELETE FROM teacher_daily_availability
                 WHERE teacher_id = $1 AND date = $2`,
                [actorId, op.date]
            );
            if (del.rowCount) {
                deleteCount += del.rowCount;
            } else {
                updateCount += 1;
            }
        } else {
            updateCount += 1;
        }
    }

    return { updateCount, deleteCount };
}

/**
 * R2（选项 B）：原子保存 teacher 空闲时段。
 * 单事务内 upsert 提及的 updates、DELETE 提及的 removals；
 * 范围内未提及的已有记录一律保留（不误删管理员代设记录）。
 * 返回 { insertCount, updateCount, deleteCount }
 */
async function replaceTeacherAvailability(tx, actorId, { updates = [], removals = [] }) {
    let insertCount = 0;
    let updateCount = 0;
    let deleteCount = 0;

    // 1) upsert 提及的 update 项
    for (const item of updates) {
        const date = item && item.date;
        const slots = item && item.slots;
        if (!date || !isValidDateString(date)) {
            throw new Error(`无效的日期格式: ${date}`);
        }
        const nextValues = {
            morning: Number(slots && slots.morning) || 0,
            afternoon: Number(slots && slots.afternoon) || 0,
            evening: Number(slots && slots.evening) || 0
        };
        const existing = await tx(
            `SELECT id, morning_available, afternoon_available, evening_available
             FROM teacher_daily_availability
             WHERE teacher_id = $1 AND date = $2
             LIMIT 1`,
            [actorId, date]
        );
        const currentRow = existing.rows[0] || null;
        const hasChange = !currentRow ||
            Number(currentRow.morning_available) !== nextValues.morning ||
            Number(currentRow.afternoon_available) !== nextValues.afternoon ||
            Number(currentRow.evening_available) !== nextValues.evening;
        if (!hasChange) continue;
        if (currentRow) {
            await tx(
                `UPDATE teacher_daily_availability
                 SET morning_available = $3,
                     afternoon_available = $4,
                     evening_available = $5,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE teacher_id = $1 AND date = $2`,
                [actorId, date, nextValues.morning, nextValues.afternoon, nextValues.evening]
            );
            updateCount++;
        } else {
            await tx(
                `INSERT INTO teacher_daily_availability
                     (teacher_id, date, morning_available, afternoon_available, evening_available, start_time, end_time, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, '00:00:00', '23:59:59', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                [actorId, date, nextValues.morning, nextValues.afternoon, nextValues.evening]
            );
            insertCount++;
        }
    }

    // 2) DELETE 提及的 removal 项（removeAll 或单个 slot 置 0）
    for (const op of removals) {
        if (!op || !op.date || !isValidDateString(op.date)) {
            throw new Error(`无效的日期格式: ${op.date}`);
        }
        if (op.removeAll) {
            const del = await tx(
                `DELETE FROM teacher_daily_availability
                 WHERE teacher_id = $1 AND date = $2`,
                [actorId, op.date]
            );
            deleteCount += del.rowCount || 0;
            continue;
        }
        const slot = normalizeSlotKey(op.timeSlot || op.slot || op.time_slot);
        if (!slot) continue;
        const column = SLOT_COLUMNS[slot];
        const updated = await tx(
            `UPDATE teacher_daily_availability
             SET ${column} = 0,
                 updated_at = CURRENT_TIMESTAMP
             WHERE teacher_id = $1 AND date = $2
             RETURNING morning_available, afternoon_available, evening_available`,
            [actorId, op.date]
        );
        if (updated.rowCount === 0) continue;
        const row = updated.rows[0];
        const allZero = ['morning_available', 'afternoon_available', 'evening_available']
            .every(key => Number(row[key]) === 0);
        if (allZero) {
            const del = await tx(
                `DELETE FROM teacher_daily_availability
                 WHERE teacher_id = $1 AND date = $2`,
                [actorId, op.date]
            );
            if (del.rowCount) deleteCount += del.rowCount;
            else updateCount += 1;
        } else {
            updateCount += 1;
        }
    }

    return { insertCount, updateCount, deleteCount };
}

// ============================================================
// student / admin 端共享辅助（供控制器复用，避免重复内联）
// ============================================================

/** student 行 → 前端可用性对象 */
function mapRowToStudentAvailability(row) {
    return {
        id: row.id,
        date: row.date,
        morning_available: row.morning_available,
        afternoon_available: row.afternoon_available,
        evening_available: row.evening_available
    };
}

/**
 * admin 端按 updates[]（每项含 teacher_id/student_id + 布尔位）UPSERT 空闲表。
 * 权限落地（Phase 1）：actorUser 用于创建者归属 —— 写入时打标 created_by；
 * L3 仅可修改自己创建或无主的记录（越权抛 404）；更新无主记录时自动认领。
 *
 * 往返次数固定为 1（L3 为 2），不随 updates 长度增长：远程库每条语句约 250ms，
 * 网格里拖选 7 天 × 20 位教师 = 140 项，逐条写要 35 秒。
 */
async function upsertAvailabilityByAdmin(tx, table, idColumn, updates, actorUser = null) {
    const actorId = actorUser ? (actorUser.id || null) : null;
    const scoped = requiresOwnDataScope(actorUser);

    const valid = (updates || []).filter((item) => item[idColumn] && item.date);
    if (valid.length === 0) return;

    // 权限落地：L3 只能修改自己创建或无主的空闲记录；越权视为不存在。
    // 一条查询把涉及的 (id, date) 全部归属取回，替代「每项一次预检」。
    if (scoped) {
        const ids = valid.map((it) => it[idColumn]);
        const dates = valid.map((it) => it.date);
        const existingRes = await tx(
            `SELECT ${idColumn} AS ref, date, created_by FROM ${table}
              WHERE (${idColumn}, date) IN (
                    SELECT * FROM unnest($1::int[], $2::date[])
              )`,
            [ids, dates]
        );
        for (const row of (existingRes && existingRes.rows) || []) {
            if (!canTouchRecord(row.created_by, actorUser)) {
                throw Object.assign(new Error('未找到该空闲时段记录'), { statusCode: 404 });
            }
        }
    }

    // 一条多值 INSERT ... ON CONFLICT DO UPDATE 写完全部项
    const params = [];
    const tuples = valid.map((item) => {
        params.push(item[idColumn], item.date, toSlotBit(item.morning),
            toSlotBit(item.afternoon), toSlotBit(item.evening));
        if (actorId !== null) params.push(actorId);
        const n = params.length;
        return actorId !== null
            ? `($${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, '00:00', '23:59', $${n})`
            : `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n}, '00:00', '23:59')`;
    });

    await tx(`
        INSERT INTO ${table} (${idColumn}, date, morning_available, afternoon_available, evening_available, start_time, end_time${actorId !== null ? ', created_by' : ''})
        VALUES ${tuples.join(', ')}
        ON CONFLICT (${idColumn}, date)
        DO UPDATE SET
            morning_available = EXCLUDED.morning_available,
            afternoon_available = EXCLUDED.afternoon_available,
            evening_available = EXCLUDED.evening_available,
            updated_at = CURRENT_TIMESTAMP${actorId !== null ? `,
            created_by = COALESCE(${table}.created_by, EXCLUDED.created_by)` : ''}
    `, params);
}

module.exports = {
    SLOT_COLUMNS,
    normalizeSlotKey,
    isValidDateString,
    normalizeSlotValue,
    collectAvailabilityUpdates,
    mapRowToAvailability,
    mapRowToStudentAvailability,
    slotToColumn,
    toSlotBit,
    getTeacherAvailability,
    setTeacherAvailability,
    deleteTeacherAvailability,
    replaceTeacherAvailability,
    upsertAvailabilityByAdmin
};
