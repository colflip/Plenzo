require('dotenv').config();

const connectionString = process.env.DATABASE_URL || '';
const preferServerless =
  process.env.DB_DRIVER === 'neon' || connectionString.includes('neon.tech');

// 统一数据库会话时区为UTC
const TIME_ZONE = 'UTC';

let query;
let getClient;

if (preferServerless) {
  // 通过 443 端口的 HTTPS/WebSocket 连接 Neon
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(connectionString, {
    fetchOptions: { timeout: 10000 } // 10秒超时
  });

  let tzInitialized = false;

  // 内部执行器，直接调用 neon
  const executeQuery = async (text, params) => {
    // 优先使用 sql.query（若可用）
    if (typeof sql.query === 'function') {
      const res = await sql.query(text, params);
      return res && res.rows ? res : { rows: res };
    }
    // 使用模板标签执行
    const res = await sql`${sql.unsafe(text, params)}`;
    return Array.isArray(res) ? { rows: res } : (res && res.rows ? res : { rows: res });
  };

  // 导出 query 函数，包含初始化和重试逻辑
  query = async (text, params = []) => {
    if (!tzInitialized) {
      try {
        await sql`SET TIME ZONE 'UTC'`;
      } catch (e) {
        console.warn('设置会话时区失败(Neon)：', e?.message || e);
      }
      tzInitialized = true;
    }

    const MAX_RETRIES = 5;
    let delay = 1000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await executeQuery(text, params);
      } catch (err) {
        const errMsg = String(err.message || '');
        const isRetriable = err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          errMsg.includes('fetch failed') ||
          errMsg.includes('socket disconnected') ||
          errMsg.includes('connection reset');

        if (isRetriable && attempt < MAX_RETRIES) {
          console.warn(`[DB] 查询失败 (尝试 ${attempt}/${MAX_RETRIES}): ${errMsg}。正在 ${delay}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
  };

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

  pool.on('connect', async (client) => {
    try {
      await client.query(`SET TIME ZONE '${TIME_ZONE}'`);
    } catch (e) {
      console.warn('设置会话时区失败(pg)：', e?.message || e);
    }
  });

  query = (text, params) => pool.query(text, params);

  getClient = async () => {
    return await pool.connect();
  };
}

const runInTransaction = async function (workFn) {
  let clientLocal = null;
  let usePool = false;
  try {
    try {
      clientLocal = await getClient();
      await clientLocal.query('BEGIN');
    } catch (e) {
      usePool = true;
      await query('BEGIN');
      clientLocal = { query: (...args) => query(...args), release: async () => { } };
    }

    await workFn(clientLocal, usePool);

    if (usePool) await query('COMMIT'); else await clientLocal.query('COMMIT');
  } catch (err) {
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

module.exports = { query, getClient, runInTransaction };