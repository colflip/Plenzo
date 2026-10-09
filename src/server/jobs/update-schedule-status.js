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

/**
 * 候选谓词是以文本内插进 SQL 的，这是**有意**的，不是漏参数化（审查报告 P3-3）：
 * `@?` 只有在右操作数是常量 jsonpath 时才走 GIN(jsonb_path_ops) 索引，改成 `$n::jsonpath`
 * 会让整批候选扫描退化成全表。所以守的是「插进来的值必须只能是枚举生成的那个形状」。
 *
 * 校验方式是**往返比对**而不是形状正则：从字符串里摘出引号内的状态码，用唯一实现
 * `statusPathPredicate` 重新生成一遍，要求逐字符相等。好处是不依赖空格写法这种
 * 容易被顺手改掉的细节，且未知状态码会由 statusPathPredicate 自己抛（枚举唯一源）。
 */
const QUOTED_CODE = /"([a-z_]+\.[a-z_]+)"/g;
function assertSafePathPredicate(predicate) {
    const p = String(predicate || '');
    const codes = [...p.matchAll(QUOTED_CODE)].map(m => m[1]);
    if (!codes.length || statusPathPredicate(codes) !== p) {
        throw new Error(`自动完成作业的候选谓词不是枚举生成的 jsonpath，拒绝拼进 SQL: ${p.slice(0, 80)}`);
    }
    return p;
}

const BATCH_SQL = (rawPredicate) => {
    const candidatePredicate = assertSafePathPredicate(rawPredicate);
    return `
WITH cand AS (
    SELECT id, teachers FROM course_sessions
     WHERE (class_date < CURRENT_DATE
            OR (class_date = CURRENT_DATE AND end_time < CURRENT_TIME))
       AND teachers @? '${candidatePredicate}'
       -- ^ 粗筛：必须枚举状态字面量，否则走不到 GIN(jsonb_path_ops) 索引
       -- 细筛：@? 只看 status，看不到审计插入处追加的 auto_at IS NULL 条件。
       -- 于是「已被自动完成、又被人工改回 pending/confirmed」的 pair（改回时
       -- setTeacherStatus 保留 auto_at）会**永远**命中候选、**永远**产出 0 行审计；
       -- 而候选按 class_date ASC 排序，这条毒记录每轮都排最前 → 循环 break、
       -- 其后所有场次永不处理，作业却返回 success:true（审查报告 P1-15）。
       -- 加上这条 EXISTS 后，进入候选的场次必然至少产出 1 行，
       -- changed 与 LIMIT 才第一次变成可比较的同一个量。
       AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(teachers) c
              WHERE split_part(c->>'status', '.', 2) IN ('pending', 'confirmed')
                AND (c->>'auto_at') IS NULL
       )
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
};

// 单轮最多翻多少批：500 × 200 = 10 万个 pair，远超正常积压；
// 纯粹是「候选条件以后被改坏时不至于死循环」的保险丝。
const MAX_BATCHES = 200;

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
            // changed 现在恒 ≥ 本批场次数（候选已被 EXISTS 保证必有可改的 pair），
            // 因此 changed < 500 只可能是「没取满一页 = 候选已耗尽」，判断成立。
            if (changed < 500) break;

            // 兜底：万一以后候选条件又被改动，不要让病态情形把作业变成死循环。
            if (batchNo >= MAX_BATCHES) {
                logger.warn(`[job:updateScheduleStatus] 达到单轮上限 ${MAX_BATCHES} 批，剩余场次留到下轮`);
                break;
            }
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
// 供单测钉住候选谓词的白名单校验（P3-3）：不导出就只能靠跑整条作业间接验证
module.exports.BATCH_SQL = BATCH_SQL;
module.exports.assertSafePathPredicate = assertSafePathPredicate;
