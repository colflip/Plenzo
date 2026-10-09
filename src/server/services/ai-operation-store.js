/**
 * AI 操作态外置存储（DB 后端，带内存兜底）
 * @description
 *   原 ai-controller 用进程内存 Map 存「排课预览」「敏感操作确认态」。
 *   Serverless 多实例下，用户生成预览的实例 ≠ 点击确认时的实例，
 *   导致 previewId / operationId 在另一实例上不存在 → 预览过期 / 操作无效。
 *
 *   本模块把这两类短时状态持久化到数据库（带 expire_at，由读时惰性清理 + 后台定时清理）。
 *   DB 不可用时退化为内存 Map，保证本实例内仍可工作（代价：跨实例一致性丢失，但至少不报错）。
 *
 *   采用 write-through：每次保存同时写内存（作为本地缓存 / 兜底），读优先命中内存，
 *   未命中再查 DB。这样即使 DB 调用被 mock 成返回 undefined（测试常见写法），
 *   内存里也始终有一份，避免「保存成功但读取拿不到」的假象。
 */

const db = require('../db/db');
const logger = require('../utils/logger.js');

const TTL_MS = 5 * 60 * 1000; // 5 分钟过期

// 内存兜底（DB 不可用时使用；正常情况作为本地缓存）
const memPreviews = new Map();
const memOperations = new Map();

// 标记 DB 是否可用，避免每次都尝试失败的连接（一次失败即降级，直到进程重启）
let dbAvailable = true;
let lastDbError = null;

function nowIso() {
    return new Date().toISOString();
}

function expireAtIso() {
    return new Date(Date.now() + TTL_MS).toISOString();
}

function memSet(map, id, value) {
    map.set(id, { ...value, expireAt: Date.now() + TTL_MS });
}

function memGet(map, id) {
    const e = map.get(id);
    if (!e) return null;
    if (Date.now() > e.expireAt) { map.delete(id); return null; }
    return e;
}

// ============================================================
// 排课预览
// ============================================================

/**
 * 保存排课预览（write-through：内存 + DB）
 * @param {string} id
 * @param {object} data - { created_by, groups }
 */
async function savePreview(id, data) {
    memSet(memPreviews, id, data);
    if (dbAvailable) {
        try {
            await db.query(
                `INSERT INTO public.ai_schedule_previews (id, created_by, groups, created_at, expire_at)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)
                 ON CONFLICT (id) DO UPDATE SET
                   created_by = EXCLUDED.created_by,
                   groups = EXCLUDED.groups,
                   created_at = CURRENT_TIMESTAMP,
                   expire_at = EXCLUDED.expire_at`,
                [id, data.created_by ?? null, JSON.stringify(data.groups ?? {}), expireAtIso()]
            );
            return;
        } catch (err) {
            dbAvailable = false;
            lastDbError = err.message;
            logger.warn('[ai-operation-store] 保存预览到 DB 失败，降级内存:', err.message);
        }
    }
}

/**
 * 读取排课预览（未过期返回，已过期返回 null 并清理）
 * @param {string} id
 * @returns {object|null}
 */
/**
 * @param {string} id
 * @param {number|string} [ownerId] 传入时只认这一位创建者的预览。
 *   过去确认动作只按 id 取，同实例内任一管理员（含 L3）都能确认别人挂起的排课
 *   —— 预览 id 还是 `Date.now()+Math.random()` 这种可猜测的形状（审查报告 P2-16）。
 * @returns {object|null}
 */
async function getPreview(id, ownerId = null) {
    const mem = memGet(memPreviews, id);
    if (mem) {
        const memOwner = mem.created_by === undefined ? null : mem.created_by;
        if (ownerId !== null && String(memOwner) !== String(ownerId)) return null;
        return { previewId: id, created_by: memOwner, groups: mem.groups };
    }
    if (!dbAvailable) return null;
    try {
        const params = [id];
        let ownerClause = '';
        if (ownerId !== null) {
            params.push(ownerId);
            ownerClause = ` AND created_by = $${params.length}`;
        }
        const r = await db.query(
            `SELECT id, created_by, groups, expire_at
             FROM public.ai_schedule_previews
             WHERE id = $1 AND expire_at > CURRENT_TIMESTAMP${ownerClause}`,
            params
        );
        if (r.rows.length === 0) return null;
        const row = r.rows[0];
        return { previewId: row.id, created_by: row.created_by, groups: row.groups };
    } catch (err) {
        dbAvailable = false;
        lastDbError = err.message;
        logger.warn('[ai-operation-store] 读取预览失败，降级内存:', err.message);
        return null;
    }
}

/**
 * 删除排课预览
 * @param {string} id
 */
async function deletePreview(id) {
    memPreviews.delete(id);
    if (!dbAvailable) return;
    try {
        await db.query(`DELETE FROM public.ai_schedule_previews WHERE id = $1`, [id]);
    } catch (err) {
        dbAvailable = false;
        lastDbError = err.message;
        logger.warn('[ai-operation-store] 删除预览失败，降级内存:', err.message);
    }
}

// ============================================================
// 敏感操作确认态
// ============================================================

/**
 * 保存待确认操作（完整对象：type + 业务字段整体存入 payload）
 * @param {string} id
 * @param {object} data - 调用方传入的原始结构（含 type / scheduleIds / fields ...）
 */
async function saveOperation(id, data) {
    memSet(memOperations, id, data);
    if (dbAvailable) {
        try {
            await db.query(
                `INSERT INTO public.ai_pending_operations (id, type, created_by, payload, created_at, expire_at)
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)
                 ON CONFLICT (id) DO UPDATE SET
                   type = EXCLUDED.type,
                   created_by = EXCLUDED.created_by,
                   payload = EXCLUDED.payload,
                   created_at = CURRENT_TIMESTAMP,
                   expire_at = EXCLUDED.expire_at`,
                [id, data.type ?? null, data.created_by ?? null, JSON.stringify(data), expireAtIso()]
            );
            return;
        } catch (err) {
            dbAvailable = false;
            lastDbError = err.message;
            logger.warn('[ai-operation-store] 保存操作到 DB 失败，降级内存:', err.message);
        }
    }
}

/**
 * 读取待确认操作（返回完整原始对象，调用方可直接用 operation.type / scheduleIds 等）
 * @param {string} id
 * @returns {object|null}
 */
async function getOperation(id, ownerId = null) {
    const mem = memGet(memOperations, id);
    if (mem) {
        const memOwner = mem.created_by === undefined ? null : mem.created_by;
        if (ownerId !== null && String(memOwner) !== String(ownerId)) return null;
        return { id, ...mem };
    }
    if (!dbAvailable) return null;
    try {
        const params = [id];
        let ownerClause = '';
        if (ownerId !== null) {
            params.push(ownerId);
            ownerClause = ` AND created_by = $${params.length}`;
        }
        const r = await db.query(
            `SELECT id, type, created_by, payload
             FROM public.ai_pending_operations
             WHERE id = $1 AND expire_at > CURRENT_TIMESTAMP${ownerClause}`,
            params
        );
        if (r.rows.length === 0) return null;
        const row = r.rows[0];
        return { id: row.id, ...row.payload };
    } catch (err) {
        dbAvailable = false;
        lastDbError = err.message;
        logger.warn('[ai-operation-store] 读取操作失败，降级内存:', err.message);
        return null;
    }
}

/**
 * 删除待确认操作
 * @param {string} id
 */
async function deleteOperation(id) {
    memOperations.delete(id);
    if (!dbAvailable) return;
    try {
        await db.query(`DELETE FROM public.ai_pending_operations WHERE id = $1`, [id]);
    } catch (err) {
        dbAvailable = false;
        lastDbError = err.message;
        logger.warn('[ai-operation-store] 删除操作失败，降级内存:', err.message);
    }
}

// 过期行的清理节奏（额度敏感，改前先读这段）。
//
// 读路径自带 expire_at 过滤（见 getPreview / getOperation），多留几小时垃圾行不影响
// 功能正确性；但原实现每 60 秒跑一次 DELETE，而 Neon 免费版按「计算醒着的时长」计费、
// 一次唤醒至少要空转完一个休眠窗口（默认 5 分钟）才睡得着 —— 60s < 5min 意味着库
// 永远等不到休眠，单这一条就能把一个月的 100 CU-小时额度烧穿。所以默认不再自循环，
// 改由每日定时任务顺带清一次（jobs/scheduler.js 与 routes/cron.js 各挂一处，覆盖
// 常驻进程与 Serverless 两个平台，且那两次唤醒本来就会发生）。
//
// 设 AI_SWEEP_INTERVAL_MS=60000 可回到旧的每分钟自循环（仅排障用）。
const SWEEP_INTERVAL_MS = Math.max(0, parseInt(process.env.AI_SWEEP_INTERVAL_MS, 10) || 0);

// db.query 在 pg Pool 下给 rowCount，在 Neon HTTP 下可能只有 rows（见 db.js 的
// fullResults 约定）。只用于日志，两种都兜住。
const countRows = (result) => {
    if (!result) return 0;
    if (typeof result.rowCount === 'number') return result.rowCount;
    return Array.isArray(result.rows) ? result.rows.length : 0;
};

/**
 * 清理已过期的排课预览与待确认操作（幂等，可重复调用）。
 * @returns {Promise<{ok: boolean, skipped?: boolean, deleted?: number, error?: string}>}
 */
async function sweepExpired() {
    if (!dbAvailable) return { ok: false, skipped: true };
    try {
        const previews = await db.query(`DELETE FROM public.ai_schedule_previews WHERE expire_at <= CURRENT_TIMESTAMP`);
        const operations = await db.query(`DELETE FROM public.ai_pending_operations WHERE expire_at <= CURRENT_TIMESTAMP`);
        const deleted = countRows(previews) + countRows(operations);
        if (deleted > 0) logger.log(`[ai-operation-store] 清理过期条目 ${deleted} 行`);
        return { ok: true, deleted };
    } catch (err) {
        dbAvailable = false;
        lastDbError = err.message;
        logger.warn('[ai-operation-store] 清理过期条目失败:', err.message);
        return { ok: false, error: err.message };
    }
}

/**
 * 启动自循环清理（**默认关闭**，原因见上方 SWEEP_INTERVAL_MS）。保留这个入口是为了
 * 在不改 app.js 的前提下留一个排障用的回退开关。
 * @returns {NodeJS.Timeout|null} 句柄；默认 null 表示未启动自循环
 */
function startExpirySweeper() {
    if (SWEEP_INTERVAL_MS <= 0) return null;
    const timer = setInterval(() => { void sweepExpired(); }, SWEEP_INTERVAL_MS);
    timer.unref?.();
    return timer;
}

module.exports = {
    TTL_MS,
    savePreview,
    getPreview,
    deletePreview,
    saveOperation,
    getOperation,
    deleteOperation,
    sweepExpired,
    startExpirySweeper,
    // 测试用：直接读写内存兜底层
    _mem: { memPreviews, memOperations }
};
