require('dotenv').config();

const connectionString = process.env.DATABASE_URL || '';
const preferServerless =
  process.env.DB_DRIVER === 'neon' || connectionString.includes('neon.tech');

// 统一数据库会话时区为UTC
const TIME_ZONE = 'UTC';

let query;
let getClient;

if (preferServerless) {
  // 通过 443 端口的 HTTPS/WebSocket 连接 Neon，绕过 5432 端口限制
  const { neon, neonConfig } = require('@neondatabase/serverless');
  // 在某些网络环境下，移除强制配置可能提升稳定性
  // neonConfig.useSecureWebSocket = true; 
  // neonConfig.fetchConnectionCache = true; // Deprecated
  const sql = neon(connectionString);

  // 使用 neon 的常规函数调用：sql.query("SELECT $1", [param])，返回对象包含 rows
  let tzInitialized = false;
  query = async (text, params = []) => {
    if (!tzInitialized) {
      try {
        // 注意：Postgres 的 SET 语句不支持参数占位符，需内联文字常量
        await sql`SET TIME ZONE 'UTC'`;
      } catch (e) {
        console.warn('设置会话时区失败(Neon)：', e?.message || e);
      }
      tzInitialized = true;
    }
    // 统一返回形态为 { rows: [...] }，以兼容 pg 的返回结构
    try {
      // 优先使用 sql.query（若可用）执行带参数的查询
      if (typeof sql.query === 'function') {
        const res = await sql.query(text, params);
        return res && res.rows ? res : { rows: res };
      }
      // 使用模板标签执行 unsafe 动态 SQL（含参数）
      const res = await sql`${sql.unsafe(text, params)}`;
      return Array.isArray(res) ? { rows: res } : (res && res.rows ? res : { rows: res });
    } catch (err) {
      throw err;
    }
  };

  // Neon/serverless 环境下暂不支持获取原生 client，提供友好提示
  getClient = async () => {
    throw new Error('getClient is not supported when using serverless DB driver');
  };
} else {
  const { Pool } = require('pg');

  const shouldUseSSL = (() => {
    if (typeof process.env.DB_SSL !== 'undefined') return process.env.DB_SSL === 'true';
    return /sslmode=require/i.test(connectionString);
  })();

  const pool = new Pool({
    connectionString,
    ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined,
    keepAlive: true,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  // 为每个连接设置时区
  pool.on('connect', async (client) => {
    try {
      await client.query(`SET TIME ZONE '${TIME_ZONE}'`);
    } catch (e) {
      console.warn('设置会话时区失败(pg)：', e?.message || e);
    }
  });

  query = (text, params) => pool.query(text, params);

  // 导出获取原生客户端的函数，供需要在单连接上执行事务的代码使用
  const getClient = async () => {
    const client = await pool.connect();
    return client;
  };
}

module.exports = { query, getClient };

/**
 * 在事务中执行给定的异步工作函数。
 * workFn 会被传入一个 client 对象（具有 query 和 release 方法）和一个布尔值 usePool 表示是否回退到 pool 模式。
 * 当底层驱动支持获取原生 client 时，使用 client 事务；否则退回到直接使用 query 的 pool 事务。
 */
module.exports.runInTransaction = async function runInTransaction(workFn) {
  let clientLocal = null;
  let usePool = false;
  try {
    try {
      clientLocal = await getClient();
      await clientLocal.query('BEGIN');
    } catch (e) {
      // getClient 可能在 serverless 驱动中不可用，退回到 pool 事务
      usePool = true;
      await query('BEGIN');
      // 创建一个兼容的 clientLocal，包装 query 方法
      clientLocal = { query: (...args) => query(...args), release: async () => { } };
    }

    // 执行用户提供的工作函数
    await workFn(clientLocal, usePool);

    // 提交事务
    if (usePool) await query('COMMIT'); else await clientLocal.query('COMMIT');
  } catch (err) {
    // 回滚事务
    try {
      if (usePool) await query('ROLLBACK'); else if (clientLocal) await clientLocal.query('ROLLBACK');
    } catch (rbErr) {
      console.error('回滚事务时发生错误:', rbErr);
    }
    throw err;
  } finally {
    try {
      if (!usePool && clientLocal && typeof clientLocal.release === 'function') await clientLocal.release();
    } catch (relErr) {
      console.warn('释放事务 client 时发生错误:', relErr);
    }
  }
};