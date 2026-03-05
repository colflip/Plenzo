require('dotenv').config();

const connectionString = process.env.DATABASE_URL || '';
const preferServerless =
  process.env.DB_DRIVER === 'neon' || connectionString.includes('neon.tech');

const TIME_ZONE = 'UTC';

const isProduction = process.env.NODE_ENV === 'production';
const isVercel = process.env.VERCEL === '1';
const isRender = process.env.RENDER === 'true';

let query;
let getClient;

if (preferServerless) {
  const { neon } = require('@neondatabase/serverless');
  
  const fetchTimeout = parseInt(process.env.DB_FETCH_TIMEOUT) || 10000;
  const maxRetries = parseInt(process.env.DB_MAX_RETRIES) || 5;
  const initialDelay = parseInt(process.env.DB_RETRY_DELAY) || 1000;

  const sql = neon(connectionString, {
    fetchOptions: { timeout: fetchTimeout },
    connectionCache: true
  });

  let tzInitialized = false;

  const executeQuery = async (text, params) => {
    if (typeof sql.query === 'function') {
      const res = await sql.query(text, params);
      return res && res.rows ? res : { rows: res };
    }
    const res = await sql`${sql.unsafe(text, params)}`;
    return Array.isArray(res) ? { rows: res } : (res && res.rows ? res : { rows: res });
  };

  query = async (text, params = []) => {
    if (!tzInitialized) {
      try {
        await sql`SET TIME ZONE 'UTC'`;
      } catch (e) {
        console.warn('设置会话时区失败(Neon)：', e?.message || e);
      }
      tzInitialized = true;
    }

    let delay = initialDelay;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await executeQuery(text, params);
      } catch (err) {
        const errMsg = String(err.message || '');
        const isRetriable = err.code === 'ECONNRESET' ||
          err.code === 'ETIMEDOUT' ||
          err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
          errMsg.includes('fetch failed') ||
          errMsg.includes('socket disconnected') ||
          errMsg.includes('connection reset') ||
          errMsg.includes('timeout');

        if (isRetriable && attempt < maxRetries) {
          console.warn(`[DB] 查询失败 (尝试 ${attempt}/${maxRetries}): ${errMsg}。正在 ${delay}ms 后重试...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay = Math.min(delay * 2, 10000);
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

  const poolConfig = {
    connectionString,
    ssl: shouldUseSSL ? { rejectUnauthorized: false } : undefined,
    keepAlive: true,
    max: isVercel || isRender ? 1 : (parseInt(process.env.DB_POOL_MAX) || 10),
    min: isVercel || isRender ? 0 : 2,
    idleTimeoutMillis: isVercel || isRender ? 5000 : 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT) || 10000,
    allowExitOnIdle: isVercel || isRender
  };

  const pool = new Pool(poolConfig);

  pool.on('connect', async (client) => {
    try {
      await client.query(`SET TIME ZONE '${TIME_ZONE}'`);
    } catch (e) {
      console.warn('设置会话时区失败(pg)：', e?.message || e);
    }
  });

  pool.on('error', (err, client) => {
    console.error('数据库连接池错误:', err.message);
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