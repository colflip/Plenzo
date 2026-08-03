const db = require('../db/db');
const crypto = require('crypto');
const SchemaHelper = require('../utils/schema-helper');

/**
 * Detects the correct date column name in the database.
 * 委托给 SchemaHelper（带缓存），消除重复的 information_schema 查询。
 */
async function detectDateColumn() {
    // 无别名：返回裸列名如 "arr_date"
    return await SchemaHelper.getDateExpr(null);
}

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
 * Main function to update schedule status.
 * Updates schedules to 'completed' if:
 * 1. Date is in the past
 * OR
 * 2. Date is today AND end_time has passed
 */
async function updateScheduleStatus() {
    const runId = crypto.randomUUID();
    let updatedCount = 0;
    let batchNo = 0;

    try {
        const dateCol = await detectDateColumn();

        while (true) {
            batchNo++;

            // Select candidate records:
            // - Status is pending or confirmed
            // - Not yet auto-updated (last_auto_update IS NULL)
            // - Condition: (Date < Today) OR (Date = Today AND EndTime < Now)
            const pick = await withRetry(() => db.query(
                `SELECT id, status FROM course_arrangement
         WHERE status IN ('pending','confirmed')
           AND last_auto_update IS NULL
           AND (
             ${dateCol} < CURRENT_DATE
             OR (
               ${dateCol} = CURRENT_DATE 
               AND end_time < CURRENT_TIME
             )
           )
         ORDER BY ${dateCol} ASC
         LIMIT 500`
            ));

            const rows = pick.rows || [];
            if (rows.length === 0) break;

            const ids = rows.map(r => r.id);
            const prevStatusById = new Map(rows.map(r => [r.id, String(r.status || 'pending')]));

            // Transaction: update status and insert logs
            await withRetry(async () => {
                await db.runInTransaction(async (client, usePool) => {
                    const q = usePool ? db.query : client.query.bind(client);

                    // Update query
                    await q(
                        `UPDATE course_arrangement
             SET status = 'completed', 
                 last_auto_update = CURRENT_TIMESTAMP, 
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ANY($1::int[])
               AND status IN ('pending','confirmed')
               AND last_auto_update IS NULL`,
                        [ids]
                    );

                    // Construct bulk insert for logs
                    const values = [];
                    let placeholders = [];
                    let i = 1;
                    for (const id of ids) {
                        const prev = prevStatusById.get(id) || 'pending';
                        values.push(id, prev, 'completed', runId, 'auto_status_update_job');
                        placeholders.push(`($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4})`);
                        i += 5;
                    }

                    if (values.length) {
                        await q(
                            `INSERT INTO schedule_auto_update_logs (schedule_id, previous_status, new_status, run_id, note)
               VALUES ${placeholders.join(', ')}`,
                            values
                        );
                    }
                    updatedCount += ids.length;
                });
            });

            console.log(`[job:updateScheduleStatus] 批次 ${batchNo}: 更新 ${ids.length} 条记录`);
        }

        if (updatedCount > 0) {
            console.log(`[job:updateScheduleStatus] 完成，共更新 ${updatedCount} 条记录`);
        }
        return { success: true, updatedCount, runId };

    } catch (err) {
        console.error('[job:updateScheduleStatus] 执行失败:', err.message);
        // Optional: Alerting hook could go here
        return { success: false, error: err.message, runId };
    }
}

module.exports = updateScheduleStatus;
