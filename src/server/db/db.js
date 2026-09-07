const logger = require('../utils/logger.js');
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

// 连接池上限。放在模块作用域是因为 warmup() 要按它决定预热几条连接。
const POOL_MAX = isVercel || isRender ? 1 : (parseInt(process.env.DB_POOL_MAX, 10) || 10);

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
    // node-postgres 连接池取不到连接时抛的原文就是这句，字面上既不含
    // 'connection timeout' 也不含 'connect timeout'，漏掉它会导致「握手超时」
    // 被当成业务错误抛给调用方（接口 500、前端 loading 不消失），而不是回退 Neon HTTP。
    message.includes('timeout exceeded when trying to connect') ||
    message.includes('socket disconnected') ||
    message.includes('connection reset') ||
    message.includes('server closed the connection') ||
    message.includes('getaddrinfo') ||
    message.includes('unable to verify the first certificate') ||
    message.includes('unable to get local issuer certificate') ||
    message.includes('self-signed certificate') ||
    message.includes('fetch failed');
};

// Neon HTTP 在 fullResults:false 时只返回行数组，rowCount 只能按 rows.length 推断，
// 导致 UPDATE / DELETE（无 RETURNING）永远报 0 行——调用方用 `rowCount === 0` 判断
// "记录不存在"时会误判（如 student setAvailability 会反复走 INSERT 触发唯一键冲突）。
// 因此 Neon 驱动统一开启 fullResults，本函数只兜底处理裸数组返回。
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
    connectionCache: true,
    fullResults: true
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
          logger.warn('设置会话时区失败(Neon)：', e?.message || e);
        }
        tzInitialized = true;
      }

      let delay = initialDelay;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await executeQuery(text, params);
        } catch (err) {
          if (isConnectionError(err) && attempt < maxRetries) {
            logger.warn(`[DB] Neon HTTP 查询失败 (尝试 ${attempt}/${maxRetries}): ${err.message}。正在 ${delay}ms 后重试...`);
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

// 保留 pg Pool 的 query 方法引用：pool.connect() 可能因连接超时失败，
// 但 pool.query()（自动借还连接）仍可用。事务降级时直接用此方法，避免绕道 Neon HTTP。
let pgPoolQuery = null;

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
    max: POOL_MAX,
    // 注意：node-postgres 的 Pool **没有 min 选项**（那是 generic-pool 的），连接全部懒建。
    // 预热靠下面的 warmup() 显式并发建连接，不要指望 min。
    //
    // 实测（Neon ap-southeast-1）：建一条新连接约 2000ms，复用已有连接约 250ms —— 差 8 倍。
    // 一次页面加载会并发打十几个接口，池里只有 1 条热连接时，其余请求各自去建新连接，
    // 于是每个接口都要多等约 2 秒。所以持久进程下**不要**让空闲连接被回收：
    // 30s 的 idleTimeout 意味着页面停顿半分钟后再操作又是一次全量冷启动。
    idleTimeoutMillis: isVercel || isRender ? 5000 : 0,   // 0 = 永不因空闲关闭
    // 10 条并发握手实测要 2.1-2.9s，3000ms 会让其中几条直接超时失败。
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT, 10) || 15000,
    allowExitOnIdle: isVercel || isRender
  });

  pool.on('connect', async (client) => {
    try {
      await client.query(`SET TIME ZONE '${TIME_ZONE}'`);
    } catch (e) {
      logger.warn('设置会话时区失败(pg)：', e?.message || e);
    }
  });
  pool.on('error', (err) => logger.error('数据库连接池错误:', err.message));

  const poolQuery = (text, params) => pool.query(text, params);
  pgPoolQuery = poolQuery; // 保存引用供事务降级使用

  return {
    name: 'pg Pool',
    query: poolQuery,
    getClient: () => pool.connect(),
    close: () => pool.end()
  };
};

let activeDriver = httpOnlyMode ? createNeonHttpDriver() : createPgPoolDriver();
let fallbackPromise = null;
logger.log(`[DB] 默认连接方式: ${activeDriver.name}${allowNeonFallback ? '（连接失败时回退 Neon HTTP）' : ''}`);

// 可观测性：若生产环境直接使用 Neon HTTP 驱动（DB_CONNECTION_TYPE=http/neon），
// 交互式事务（runInTransaction）将不可用，所有事务型写接口会失败。显式告警以便运维排查。
if (activeDriver.name === 'Neon HTTP' && isProduction) {
    logger.warn('[DB] ⚠️ 生产环境使用 Neon HTTP 驱动：交互式事务（runInTransaction）不可用。' +
        '若业务依赖事务写操作，请设置 DB_CONNECTION_TYPE=pool 改用 pg Pool 连接（Neon 连接池器）。');
}

const switchToNeonHttp = async (err) => {
  if (activeDriver.name === 'Neon HTTP') return activeDriver;
  if (!allowNeonFallback || !isConnectionError(err)) throw err;

  if (!fallbackPromise) {
    const failedDriver = activeDriver;
    fallbackPromise = Promise.resolve().then(async () => {
      logger.warn(`[DB] pg Pool 连接失败，切换到 Neon HTTP: ${err.message}`);
      const nextDriver = createNeonHttpDriver();
      activeDriver = nextDriver;
      try {
        await failedDriver.close();
      } catch (closeErr) {
        logger.warn('[DB] 关闭失效 pg Pool 时发生错误:', closeErr.message);
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
        logger.error('回滚事务时发生错误:', rollbackErr);
      }
    }
    // pool.connect() 失败但 pool.query() 仍可用：降级为顺序执行（无 BEGIN/COMMIT）。
    // 适用于单记录 UPDATE + 可选 INSERT 审计等不需要严格原子性的场景。
    // 直接用 pgPoolQuery 绕过 activeDriver（已切到 Neon HTTP），避免 Neon HTTP 重试延迟。
    if (err.message && err.message.includes('pg Pool 不可用')) {
      const fallbackQuery = pgPoolQuery || ((text, params) => query(text, params));
      logger.warn('[DB] 事务降级：pool.connect() 不可用，以 pool.query() 顺序执行（无事务保护）');
      return await workFn({ query: fallbackQuery }, true);
    }
    throw err;
  } finally {
    if (clientLocal && typeof clientLocal.release === 'function') {
      try {
        clientLocal.release();
      } catch (releaseErr) {
        logger.warn('释放事务 client 时发生错误:', releaseErr);
      }
    }
  }
};

/**
 * 启动预热：**并发**占住若干条连接，让首个页面加载不必现场握手。
 *
 * 只发一条 SELECT 1 只能热一条连接；而一次页面加载会并发打十几个接口，
 * 其余请求仍要各自建新连接（实测每条约 2000ms，复用则约 250ms）。
 * 实测 10 条并发：冷池 2881ms，预热后 728ms。
 * Serverless 下 max=1，预热 1 条即可，不浪费冷启动时间。
 */
const warmup = async () => {
  const n = Math.min(POOL_MAX, parseInt(process.env.DB_WARMUP, 10) || 5);
  await Promise.all(Array.from({ length: n }, () => query('SELECT 1')));
};

module.exports = { query, getClient, runInTransaction, warmup };
module.exports.__testables = { isConnectionError, isNeonDatabase, allowNeonFallback };
