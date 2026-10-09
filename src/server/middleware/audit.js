const logger = require('../utils/logger.js');
const db = require('../db/db');
const SchemaHelper = require('../utils/schema-helper');

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
/**
 * @param {Function} [q] 事务的 query 函数。**给了就必须在事务连接上写**：
 *   用模块级 db.query 会走另一条连接，审计与业务写入不再同生共死；
 *   而事务内吞掉失败更糟 —— 语句报错会让事务进入 aborted，随后的 COMMIT
 *   被 Postgres 执行成回滚且**不报错**，接口于是返回「用户已删除」而库里什么都没发生
 *   （审查报告 P1-14；db.js 现已校验 COMMIT 标签，但精确的错误信息只能靠不吞错拿到）。
 */
async function recordAudit(req, { op, entityType, entityId, details = {} }, q = null) {
  const actorId = (req && req.user && req.user.id) ? req.user.id : null;
  const payload = [op, entityType, entityId || null, actorId, JSON.stringify(details || {})];
  const run = q || ((text, params) => db.query(text, params));

  try {
    // 先探表：operation_logs 没建（老库/新库未迁移）时，直接 INSERT 会让整个事务 aborted，
    // 这时「忽略审计错误」就是错的 —— 事务已经废了，只是没人报出来。
    if (!(await SchemaHelper.hasTable('operation_logs'))) return;
    await run(
      `INSERT INTO operation_logs (op, entity_type, entity_id, actor_id, details)
       VALUES ($1, $2, $3, $4, $5)`,
      payload
    );
  } catch (err) {
    if (q) throw err;   // 事务内：原样上抛，由调用方的事务统一回滚
    logger.warn('记录审计日志失败:', err && err.message ? err.message : err);
  }
}

module.exports = { recordAudit };

