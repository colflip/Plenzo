const db = require('../db/db');

/**
 * 轻量操作审计记录器。
 * 优先写入到 operation_logs 表；如不存在则静默忽略，避免影响主流程。
 *
 * operation_logs 期望结构：
 *   id SERIAL PRIMARY KEY,
 *   op VARCHAR(50),
 *   entity_type VARCHAR(50),
 *   entity_id INTEGER,
 *   actor_id INTEGER,
 *   details JSONB,
 *   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 */
async function recordAudit(req, { op, entityType, entityId, details = {} }) {
  try {
    const actorId = (req && req.user && req.user.id) ? req.user.id : null;
    const payload = [op, entityType, entityId || null, actorId, details || {}];
    await db.query(
      `INSERT INTO operation_logs (op, entity_type, entity_id, actor_id, details) 
       VALUES ($1, $2, $3, $4, $5)`,
      payload
    );
  } catch (err) {
    // 表不存在或其他错误时不影响主流程
    if (process.env.DEBUG_AUDIT === 'true') {
      console.warn('记录审计日志失败:', err && err.message ? err.message : err);
    }
  }
}

module.exports = { recordAudit };

