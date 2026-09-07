const logger = require('../utils/logger.js');
const db = require('../db/db');
const crypto = require('crypto');
const { statusPathPredicate, CATEGORIES } = require('../services/course-session-service');

/**
 * Retry helper for transient errors.
 */
async function withRetry(fn, { retries = 3, delayMs = 500 } = {}) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try { return await fn(); } catch (err) {
            lastErr = err;
            const transient = String(err?.message || '').includes('fetch failed') || String(err?.code || '').includes('ETIMEDOUT');
            if (!transient && i === retries - 1) break;
            await new Promise(res => setTimeout(res, delayMs * (i + 1)));
        }
    }
    throw lastErr;
}

/**
 * 把过期的「待确认 / 已确认」教师 pair 自动改成「已完成」。
 *
 * 一场课一行后整个批次压成**一条语句**：候选筛选、原地重建、审计插入都在同一个 CTE 里。
 * 三个要点：
 * - 候选谓词用 `@?` 枚举字面量（`lifecyclePathPredicate`），这样才走 GIN(jsonb_path_ops)；
 *   `starts with` / `like_regex` 拿不到索引，所以不要手写。
 * - 改的是**生命周期后缀**，类别前缀原样保留 —— 临时加课到期变 `temp.completed`，
 *   而不是掉回 `normal.completed`（这是二维状态码的关键收益之一）。
 * - `FOR UPDATE` 让并发下无需 `version`；这条语句结构上也只能改 `status` / `auto_at` 两个键。
 */
const BATCH_SQL = (candidatePredicate) => `
WITH cand AS (
    SELECT id, teachers FROM course_sessions
     WHERE (class_date < CURRENT_DATE
            OR (class_date = CURRENT_DATE AND end_time < CURRENT_TIME))
       AND teachers @? '${candidatePredicate}'
     ORDER BY class_date ASC, id ASC
     LIMIT $1
     FOR UPDATE
), upd AS (
    UPDATE course_sessions cs
       SET teachers = (
             SELECT jsonb_agg(
                      CASE WHEN split_part(e->>'status', '.', 2) IN ('pending', 'confirmed')
                                AND (e->>'auto_at') IS NULL
                           THEN jsonb_set(
                                  jsonb_set(e, '{status}',
                                    to_jsonb(split_part(e->>'status', '.', 1) || '.completed')),
                                  '{auto_at}', to_jsonb(now()))
                           ELSE e END
                      ORDER BY ord)
               FROM jsonb_array_elements(cs.teachers) WITH ORDINALITY AS a(e, ord)),
           updated_at = CURRENT_TIMESTAMP
      FROM cand WHERE cs.id = cand.id
    RETURNING cs.id
)
INSERT INTO session_status_logs (session_id, teacher_uid, old_status, new_status, actor_type, note)
SELECT c.id, e->>'uid', e->>'status',
       split_part(e->>'status', '.', 1) || '.completed', 'system', $2
  FROM cand c, jsonb_array_elements(c.teachers) e
 WHERE split_part(e->>'status', '.', 2) IN ('pending', 'confirmed')
   AND (e->>'auto_at') IS NULL
RETURNING session_id, teacher_uid`;

async function updateScheduleStatus() {
    const runId = crypto.randomUUID();
    let updatedCount = 0;
    let batchNo = 0;

    try {
        // 候选：生命周期位是 pending 或 confirmed 的 pair —— 3 类别 × 2 生命周期共 6 个字面量。
        // 必须枚举字面量才走 GIN(jsonb_path_ops)，所以统一由服务层的生成器产出。
        const codes = CATEGORIES.flatMap(c => ['pending', 'confirmed'].map(l => `${c}.${l}`));
        const sql = BATCH_SQL(statusPathPredicate(codes));

        while (true) {
            batchNo++;
            // 一次往返完成「筛候选 + 改状态 + 写审计」
            const res = await withRetry(() => db.query(sql, [500, `auto_status_update_job:${runId}`]));
            const changed = (res.rows || []).length;
            if (changed === 0) break;

            updatedCount += changed;
            logger.log(`[job:updateScheduleStatus] 批次 ${batchNo}: 更新 ${changed} 个教师 pair`);
            if (changed < 500) break;
        }

        if (updatedCount > 0) {
            logger.log(`[job:updateScheduleStatus] 完成，共更新 ${updatedCount} 个教师 pair`);
        }
        return { success: true, updatedCount, runId };

    } catch (err) {
        logger.error('[job:updateScheduleStatus] 执行失败:', err.message);
        return { success: false, error: err.message, runId };
    }
}

module.exports = updateScheduleStatus;
