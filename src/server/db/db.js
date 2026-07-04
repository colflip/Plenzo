require('dotenv').config();

const connectionString = process.env.DATABASE_URL || '';
const TIME_ZONE = 'UTC';

const isProduction = process.env.NODE_ENV === 'production';
const isVercel = process.env.VERCEL === '1';
const isRender = process.env.RENDER === 'true';

// 本地开发环境：绕过 Neon HTTP 驱动的 TLS 证书验证问题
// 错误: UNABLE_TO_GET_ISSUER_CERT_LOCALLY
if (!isProduction && !process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  // 抑制 Node.js 对 NODE_TLS_REJECT_UNAUTHORIZED=0 的安全警告
  const originalEmit = process.emit.bind(process);
  process.emit = function (event, ...args) {
    if (event === 'warning' && args[0]?.name === 'Warning' &&
        args[0]?.code?.startsWith('NODE_TLS_REJECT_UNAUTHORIZED')) {
      return false;
    }
    return originalEmit(event, ...args);
  };
}

/**
 * 数据库连接方式选择
 * DB_CONNECTION_TYPE 环境变量控制：
 *   - 'http' / 'neon'  → 强制使用 Neon HTTP 驱动（本地开发推荐，无 TLS 问题）
 *   - 'pool' / 'pg'    → 强制使用标准 pg 连接池
 *   - 'auto' / 未设置   → 自动判断：
 *       - 本地开发环境（NODE_ENV=development）默认使用 HTTP
 *       - 生产环境使用原逻辑（检查 DB_DRIVER 或连接字符串）
 */
const connectionType = (process.env.DB_CONNECTION_TYPE || 'auto').toLowerCase();

let preferServerless;
if (connectionType === 'http' || connectionType === 'neon') {
  preferServerless = true;
} else if (connectionType === 'pool' || connectionType === 'pg') {
  preferServerless = false;
} else {
  // auto 模式：本地开发默认用 HTTP，生产用原逻辑
  preferServerless = isProduction
    ? (process.env.DB_DRIVER === 'neon' || connectionString.includes('neon.tech'))
    : true; // 本地开发默认使用 Neon HTTP 驱动
}

console.log(`[DB] 连接方式: ${preferServerless ? 'Neon HTTP' : 'pg Pool'}`);

let query;
let getClient;

if (preferServerless) {
  const { neon } = require('@neondatabase/serverless');

  const fetchTimeout = parseInt(process.env.DB_FETCH_TIMEOUT) || 10000;
  const maxRetries = Math.max(1, parseInt(process.env.DB_MAX_RETRIES) || 5);
  const initialDelay = parseInt(process.env.DB_RETRY_DELAY) || 1000;

  // Neon HTTP 驱动使用 HTTPS 请求，移除 sslmode 参数避免 TLS 冲突
  const cleanConnectionString = connectionString.replace(/[?&]sslmode=[^&]*/gi, '').replace(/\?$/, '');

  const sql = neon(cleanConnectionString, {
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
    ssl: shouldUseSSL ? { rejectUnauthorized: process.env.NODE_ENV === 'production' } : undefined,
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

/**
 * 预热数据库连接（服务器启动时调用）
 * 执行一个简单查询以建立连接，减少首次请求的重试
 */
const warmup = async () => {
  await query('SELECT 1');
};

module.exports = { query, getClient, runInTransaction, warmup };