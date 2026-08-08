require('dotenv').config();

const connectionString = process.env.DATABASE_URL || '';
const TIME_ZONE = 'UTC';

const isProduction = process.env.NODE_ENV === 'production';
const isVercel = process.env.VERCEL === '1';
const isRender = process.env.RENDER === 'true';
const connectionType = (process.env.DB_CONNECTION_TYPE || 'auto').toLowerCase();
const neonFallbackEnabled = process.env.DB_NEON_FALLBACK !== 'false';

const isNeonDatabase = /(?:^|\.)neon\.tech$/i.test((() => {
  try {
    return new URL(connectionString).hostname;
  } catch (_) {
    return '';
  }
})());

const poolOnlyMode = connectionType === 'pool' || connectionType === 'pg';
const httpOnlyMode = connectionType === 'http' || connectionType === 'neon';
const allowNeonFallback = !poolOnlyMode && neonFallbackEnabled && isNeonDatabase;

const isConnectionError = (err) => {
  const code = String(err?.code || '').toUpperCase();
  const message = String(err?.message || '').toLowerCase();
  const connectionCodes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
    'EPIPE', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT', '57P01', '57P02', '57P03',
    '08000', '08001', '08003', '08004', '08006', '08007', '08P01'
  ]);

  return connectionCodes.has(code) ||
    message.includes('connection terminated') ||
    message.includes('connection timeout') ||
    message.includes('connect timeout') ||
    message.includes('socket disconnected') ||
    message.includes('connection reset') ||
    message.includes('server closed the connection') ||
    message.includes('getaddrinfo') ||
    message.includes('unable to verify the first certificate') ||
    message.includes('unable to get local issuer certificate') ||
    message.includes('self-signed certificate') ||
    message.includes('fetch failed');
};

const normalizeResult = (res) => {
  if (res && res.rows) return res;
  const rows = Array.isArray(res) ? res : [];
  return { rows, rowCount: rows.length };
};

const createNeonHttpDriver = () => {
  const { neon } = require('@neondatabase/serverless');
  const fetchTimeout = parseInt(process.env.DB_FETCH_TIMEOUT, 10) || 10000;
  const maxRetries = Math.max(1, parseInt(process.env.DB_MAX_RETRIES, 10) || 5);
  const initialDelay = parseInt(process.env.DB_RETRY_DELAY, 10) || 1000;
  const cleanConnectionString = connectionString.replace(/[?&]sslmode=[^&]*/gi, '').replace(/\?$/, '');
  const sql = neon(cleanConnectionString, {
    fetchOptions: { timeout: fetchTimeout },
    connectionCache: true
  });
  let tzInitialized = false;

  const executeQuery = async (text, params = []) => {
    if (typeof sql.query === 'function') return normalizeResult(await sql.query(text, params));
    const res = await sql`${sql.unsafe(text, params)}`;
    return normalizeResult(res);
  };

  return {
    name: 'Neon HTTP',
    async query(text, params = []) {
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
          if (isConnectionError(err) && attempt < maxRetries) {
            console.warn(`[DB] Neon HTTP 查询失败 (尝试 ${attempt}/${maxRetries}): ${err.message}。正在 ${delay}ms 后重试...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay = Math.min(delay * 2, 10000);
            continue;
          }
          throw err;
        }
      }
    },
    async getClient() {
      throw new Error('Neon HTTP does not support interactive transaction clients');
    },
    close: async () => {}
  };
};

const createPgPoolDriver = () => {
  const { Pool } = require('pg');
const shouldUseSSL = typeof process.env.DB_SSL !== 'undefined'
    ? process.env.DB_SSL === 'true'
    : /sslmode=require/i.test(connectionString);

// 云 Postgres（Neon 等）强制要求 SSL。把"是否启用 SSL"与"是否校验证书"解耦：
// 只要目标是 TLS 云库就始终启用 SSL（否则服务端拒绝非加密连接；且 ssl:undefined 时
// pg 会改读 PGSSLMODE 环境变量，可能把 rejectUnauthorized 重置为 true，触发本机代理/
// 自签名 CA 的 UNABLE_TO_GET_ISSUER_CERT_LOCALLY）。显式传入 ssl 对象可屏蔽 PGSSLMODE 干扰。
// 开发环境跳过证书链校验（本机网络常有 TLS 拦截或缺失 CA）；生产环境仍强制校验。
const needsSSL = shouldUseSSL || isNeonDatabase || /sslmode=require/i.test(connectionString);
const pool = new Pool({
    connectionString,
    ssl: needsSSL ? { rejectUnauthorized: isProduction } : undefined,
    keepAlive: true,
    max: isVercel || isRender ? 1 : (parseInt(process.env.DB_POOL_MAX, 10) || 10),
    min: isVercel || isRender ? 0 : 2,
    idleTimeoutMillis: isVercel || isRender ? 5000 : 30000,
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT, 10) || 10000,
    allowExitOnIdle: isVercel || isRender
  });

  pool.on('connect', async (client) => {
    try {
      await client.query(`SET TIME ZONE '${TIME_ZONE}'`);
    } catch (e) {
      console.warn('设置会话时区失败(pg)：', e?.message || e);
    }
  });
  pool.on('error', (err) => console.error('数据库连接池错误:', err.message));

  return {
    name: 'pg Pool',
    query: (text, params) => pool.query(text, params),
    getClient: () => pool.connect(),
    close: () => pool.end()
  };
};

let activeDriver = httpOnlyMode ? createNeonHttpDriver() : createPgPoolDriver();
let fallbackPromise = null;
console.log(`[DB] 默认连接方式: ${activeDriver.name}${allowNeonFallback ? '（连接失败时回退 Neon HTTP）' : ''}`);

const switchToNeonHttp = async (err) => {
  if (activeDriver.name === 'Neon HTTP') return activeDriver;
  if (!allowNeonFallback || !isConnectionError(err)) throw err;

  if (!fallbackPromise) {
    const failedDriver = activeDriver;
    fallbackPromise = Promise.resolve().then(async () => {
      console.warn(`[DB] pg Pool 连接失败，切换到 Neon HTTP: ${err.message}`);
      const nextDriver = createNeonHttpDriver();
      activeDriver = nextDriver;
      try {
        await failedDriver.close();
      } catch (closeErr) {
        console.warn('[DB] 关闭失效 pg Pool 时发生错误:', closeErr.message);
      }
      return nextDriver;
    });
  }
  return fallbackPromise;
};

const query = async (text, params = []) => {
  const driver = activeDriver;
  try {
    return await driver.query(text, params);
  } catch (err) {
    if (driver !== activeDriver) return activeDriver.query(text, params);
    const fallbackDriver = await switchToNeonHttp(err);
    return fallbackDriver.query(text, params);
  }
};

const getClient = async () => {
  const driver = activeDriver;
  try {
    return await driver.getClient();
  } catch (err) {
    if (driver !== activeDriver) return activeDriver.getClient();
    await switchToNeonHttp(err);
    throw new Error('pg Pool 不可用且已切换到 Neon HTTP；交互式事务无法在 HTTP 驱动上安全执行');
  }
};

const runInTransaction = async function (workFn) {
  let clientLocal = null;
  try {
    clientLocal = await getClient();
    await clientLocal.query('BEGIN');
    const result = await workFn(clientLocal, false);
    await clientLocal.query('COMMIT');
    return result;
  } catch (err) {
    if (clientLocal) {
      try {
        await clientLocal.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('回滚事务时发生错误:', rollbackErr);
      }
    }
    throw err;
  } finally {
    if (clientLocal && typeof clientLocal.release === 'function') {
      try {
        clientLocal.release();
      } catch (releaseErr) {
        console.warn('释放事务 client 时发生错误:', releaseErr);
      }
    }
  }
};

const warmup = async () => {
  await query('SELECT 1');
};

module.exports = { query, getClient, runInTransaction, warmup };
module.exports.__testables = { isConnectionError, isNeonDatabase, allowNeonFallback };
