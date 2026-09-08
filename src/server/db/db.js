const logger = require('../utils/logger.js');
const { loadEnv } = require('../utils/env-loader.js');
loadEnv();

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

/**
 * 把错误展开成可读的因果链。
 *
 * undici（Node 内置 fetch）失败时只抛一句 `TypeError: fetch failed`，真实原因
 * （DNS 解析失败 EAI_AGAIN / ENOTFOUND、连接超时 UND_ERR_CONNECT_TIMEOUT、TLS
 * 证书问题…）全塞在 err.cause 里。只打印 message 就会看到满屏一模一样的
 * "fetch failed"，无法判断是断网、DNS 被污染还是代理问题。
 */
const describeError = (err) => {
    if (!err) return '未知错误';
    const parts = [];
    const push = (s) => {
        const text = String(s || '').trim();
        if (text && !parts.includes(text)) parts.push(text);
    };

    // 逐层下钻真实原因：
    //   - undici（Node 内置 fetch）把 DNS/超时/TLS 原因放在 err.cause
    //   - @neondatabase/serverless 把底层失败放在 err.sourceError
    // 两者都可能是多层嵌套，故循环展开而不是只看一层。
    let node = err;
    let depth = 0;
    while (node && depth < 5) {
        push(node.code ? `${node.code} ${node.message || ''}` : node.message);
        const next = node.cause || node.sourceError;
        if (!next || next === node) break;
        node = next;
        depth += 1;
    }
    return parts.join(' ← ') || '未知错误';
};

/**
 * 高频同构告警节流：同一 key 在窗口内只打印一次，窗口结束时补一条「已抑制 N 条」。
 * DB 挂掉时一次页面加载会并发十几个查询、每个再重试若干次，不节流就是几十上百行
 * 完全相同、且没有任何信息增量的日志。
 */
const LOG_THROTTLE_WINDOW = parseInt(process.env.DB_LOG_THROTTLE_WINDOW, 10) || 10000;
const logThrottleState = new Map();

const throttleLog = (key, level, message) => {
    const now = Date.now();
    const entry = logThrottleState.get(key);
    if (entry && now - entry.firstAt <= LOG_THROTTLE_WINDOW) {
        entry.suppressed += 1;
        return;
    }
    if (entry && entry.suppressed > 0) {
        logger[level](`${message}（上一条同类告警起已抑制 ${entry.suppressed} 条）`);
    } else {
        logger[level](message);
    }
    logThrottleState.set(key, { firstAt: now, suppressed: 0 });
};

/**
 * 连接熔断：连续出现连接类错误后，短时间内直接快速失败，不再逐个请求走完
 * 「5 次重试 + 1/2/4/8s 退避」。
 *
 * 未加熔断前的行为：DB 不可达时每个请求要耗 15s 才报错，且 8 条并发查询会打出
 * 40 条重试日志；连接池里的请求还会互相排队，把本机 dev 卡成无响应。
 * 熔断后：3 次失败即开路，冷却期内请求立即拿到 503 + 明确原因，日志只剩几条。
 */
const BREAKER_THRESHOLD = Math.max(1, parseInt(process.env.DB_BREAKER_THRESHOLD, 10) || 3);
const BREAKER_COOLDOWN = parseInt(process.env.DB_BREAKER_COOLDOWN, 10) || 15000;
// 失败计数只在同一段故障期内累加；偶发单次抖动不该把历史次数攒起来。
const BREAKER_WINDOW = parseInt(process.env.DB_BREAKER_WINDOW, 10) || 60000;
// 半开：开路超过这个时长后放行一条探测请求。DB 可能在熔断后几秒内就恢复
// （Neon 计算节点冷启动、网络抖动），等满整个冷却期才重试会把可恢复的故障拖成 15s 不可用。
const BREAKER_HALF_OPEN_MS = Math.min(
    BREAKER_COOLDOWN,
    parseInt(process.env.DB_BREAKER_HALF_OPEN, 10) || 5000
);

const breaker = { failures: 0, firstFailureAt: 0, openedAt: 0, openUntil: 0, nextProbeAt: 0, lastError: null };

const isBreakerOpen = () => Date.now() < breaker.openUntil;

/**
 * 本次请求是否应该快速失败。
 *
 * 与 isBreakerOpen() 的区别：后者是纯查询（给状态展示/重试判断用），本函数会
 * 「消耗」一次半开探测名额，因此只能在请求入口调用一次。
 */
const shouldFastFail = () => {
    if (!isBreakerOpen()) return false;
    const now = Date.now();
    if (now - breaker.openedAt >= BREAKER_HALF_OPEN_MS && now >= breaker.nextProbeAt) {
        // 放行这一条探测；BREAKER_HALF_OPEN_MS 内只放一条，不会重新引发请求风暴
        breaker.nextProbeAt = now + BREAKER_HALF_OPEN_MS;
        return false;
    }
    return true;
};

const dbUnavailableError = () => {
    const remaining = Math.max(1, Math.ceil((breaker.openUntil - Date.now()) / 1000));
    const err = new Error(
        `数据库暂时不可用（已熔断，${remaining}s 后自动重试）：${describeError(breaker.lastError)}`
    );
    err.code = 'DB_UNAVAILABLE';
    return err;
};

const noteConnectionFailure = (err) => {
    const now = Date.now();
    // 注意：不要用 `!breaker.firstFailureAt` 判断"新一轮故障"——0 是合法时间戳，
    // 会被当成未设置而每轮清零计数，导致熔断永远开不了（假时钟下必现）。
    if (now - breaker.firstFailureAt > BREAKER_WINDOW) {
        breaker.firstFailureAt = now;
        breaker.failures = 0;
    }
  breaker.failures += 1;
  // 熔断期间 query() 抛出的 DB_UNAVAILABLE 也是「连接类错误」，会再次走到这里；
  // 若覆盖 lastError，错误信息就会层层套娃（"已熔断…：已熔断…：真实原因"）。
  if (err && err.code !== 'DB_UNAVAILABLE') breaker.lastError = err;

    if (breaker.failures >= BREAKER_THRESHOLD && !isBreakerOpen()) {
        breaker.openedAt = now;
        breaker.nextProbeAt = now + BREAKER_HALF_OPEN_MS;
        breaker.openUntil = now + BREAKER_COOLDOWN;
        throttleLog(
            'db-breaker',
            'error',
            `🚨 [DB] 连续 ${breaker.failures} 次连接失败，熔断 ${Math.round(BREAKER_COOLDOWN / 1000)}s，` +
            `期间请求将快速失败（503）而不是逐个重试。原因: ${describeError(err)}`
        );
    }
};

/**
 * 启动探测失败时主动开路。
 *
 * 启动门控已经确认 DB 不可达，这是比"跑了几次查询"更强的信号。不主动开路的话，
 * 熔断要等前 2~3 个真实请求各自耗完 pg 握手超时 + Neon fetch 超时才会打开，
 * 实测首个请求要等 26s 才拿到 503。
 */
const forceOpenBreaker = (err) => {
    const now = Date.now();
    if (err && err.code !== 'DB_UNAVAILABLE') breaker.lastError = err;
    breaker.firstFailureAt = now;
    breaker.failures = Math.max(breaker.failures, BREAKER_THRESHOLD);
    breaker.openedAt = now;
    breaker.nextProbeAt = now + BREAKER_HALF_OPEN_MS;
    breaker.openUntil = now + BREAKER_COOLDOWN;
    throttleLog(
        'db-breaker',
        'error',
        `🚨 [DB] 启动探测未通过，熔断 ${Math.round(BREAKER_COOLDOWN / 1000)}s：` +
        `${describeError(breaker.lastError)}（每 ${Math.round(BREAKER_HALF_OPEN_MS / 1000)}s 放一条探测，恢复即自动关闭）`
    );
};

const noteConnectionSuccess = () => {
    if (breaker.failures === 0 && !isBreakerOpen()) return;
    const wasOpen = isBreakerOpen();
    breaker.failures = 0;
    breaker.firstFailureAt = 0;
    breaker.openedAt = 0;
    breaker.openUntil = 0;
    breaker.nextProbeAt = 0;
    breaker.lastError = null;
    if (wasOpen) logger.log('[DB] ✅ 连接已恢复，熔断关闭');
};

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
  const executeQuery = async (text, params = []) => {
    if (typeof sql.query === 'function') return normalizeResult(await sql.query(text, params));
    const res = await sql`${sql.unsafe(text, params)}`;
    return normalizeResult(res);
  };

  // 时区初始化做成单例 Promise：并发的十几个查询会同时看到 tzInitialized=false，
  // 于是各打一条「设置会话时区失败」，仅启动瞬间就刷 8 条相同告警。
  let tzPromise = null;
  const ensureTimeZone = () => {
    if (!tzPromise) {
      tzPromise = sql`SET TIME ZONE 'UTC'`.catch((e) => {
        // 这是链路不通时最先观测到的 Neon 错误，也最接近根因（带 cause 链），
        // 必须记入 breaker，否则启动诊断日志只会剩下 pg 握手那句表层信息。
        if (isConnectionError(e)) noteConnectionFailure(e);
        throttleLog('neon-tz', 'warn', `设置会话时区失败(Neon)：${describeError(e)}`);
      });
    }
    return tzPromise;
  };

  return {
    name: 'Neon HTTP',
    async query(text, params = []) {
      await ensureTimeZone();

      let delay = initialDelay;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const res = await executeQuery(text, params);
          noteConnectionSuccess();
          return res;
        } catch (err) {
          if (!isConnectionError(err)) throw err;
          noteConnectionFailure(err);
          // 熔断一旦打开就不再继续退避重试：否则 N 条并发查询各退避 15s，
          // 既拖垮请求又刷屏，而结果注定还是失败。
          if (isBreakerOpen()) throw dbUnavailableError();
          if (attempt < maxRetries) {
            throttleLog(
              'neon-retry',
              'warn',
              `[DB] Neon HTTP 查询失败: ${describeError(err)}。${delay}ms 后重试（${attempt}/${maxRetries}）`
            );
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
      throttleLog('pg-tz', 'warn', `设置会话时区失败(pg)：${describeError(e)}`);
    }
  });
  // 池级 error 在 DB 断连时会按连接数逐条触发，不节流同样会刷屏
  pool.on('error', (err) => throttleLog('pg-pool', 'error', `数据库连接池错误: ${describeError(err)}`));

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
      logger.warn(`[DB] pg Pool 连接失败，切换到 Neon HTTP: ${describeError(err)}`);
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
  // 熔断期内快速失败：不占连接池、不重试、不打日志，直接把 503 交回调用方
  if (shouldFastFail()) throw dbUnavailableError();

  const driver = activeDriver;
  try {
    const res = await driver.query(text, params);
    noteConnectionSuccess();
    return res;
  } catch (err) {
    if (driver !== activeDriver) return activeDriver.query(text, params);
    if (isConnectionError(err)) noteConnectionFailure(err);
    const fallbackDriver = await switchToNeonHttp(err);
    return fallbackDriver.query(text, params);
  }
};

const getClient = async () => {
  if (shouldFastFail()) throw dbUnavailableError();
  const driver = activeDriver;
  try {
    return await driver.getClient();
  } catch (err) {
    if (driver !== activeDriver) return activeDriver.getClient();
    if (isConnectionError(err)) noteConnectionFailure(err);
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
 * 启动预热：占住若干条连接，让首个页面加载不必现场握手。
 *
 * 只热一条连接不够：一次页面加载会并发打十几个接口，其余请求仍要各自建新连接
 * （实测每条约 2000ms，复用则约 250ms）。实测 10 条并发：冷池 2881ms，预热后 728ms。
 * Serverless 下 max=1，预热 1 条即可，不浪费冷启动时间。
 *
 * 分两段：先单条探测，通过后再并发补满。DB 不可达时并发 n 条会各自走完
 * 「5 次重试 + 15s 退避」，启动瞬间就刷出几十条重复告警（实测 8×5=40 行）。
 */
const warmup = async () => {
  const n = Math.min(POOL_MAX, parseInt(process.env.DB_WARMUP, 10) || 5);

  // 先单条探测：DB 不可达时并发 n 条会各自走完「5 次重试 + 15s 退避」，
  // 启动瞬间就刷出几十条重复告警（实测 8 条并发 × 5 次重试 = 40 行）。
  await query('SELECT 1');
  if (n <= 1) return;

  // 探测通过说明链路正常，再并发占满剩余连接；个别失败不影响整体预热。
  await Promise.allSettled(Array.from({ length: n - 1 }, () => query('SELECT 1')));
};

// 探测超时后，最多再等多久等真实原因落地（见 ping 内注释）
const PING_ROOT_CAUSE_GRACE_MS = parseInt(process.env.DB_PING_GRACE, 10) || 6000;

/**
 * 单次连通性探测（用于启动门控）。
 *
 * 返回 { ok, error }：失败时不重试、不等待完整退避，error 是**观测到的第一个**真实错误，
 * 供启动日志直接打印（之前启动日志显示的是 pg 握手超时这种表层信息，看不出根因）。
 */
const ping = async (timeoutMs = parseInt(process.env.DB_PING_TIMEOUT, 10) || 10000) => {
  if (isBreakerOpen()) return { ok: false, error: breaker.lastError };

  let timer = null;
  let seenError = null;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`ping 超时 ${timeoutMs}ms`)), timeoutMs);
    });
    await Promise.race([query('SELECT 1').catch(e => { seenError = e; throw e; }), timeout]);
    return { ok: true, error: null };
  } catch (err) {
    // 探测超时常常只差一点点：pg 握手失败是表层信息（"Connection terminated
    // unexpectedly"），真正的根因要等回退到 Neon HTTP 后才写进 breaker。
    // 但 pg 的连接超时可能比探测超时还长，所以在宽限期内轮询等真实原因落地，
    // 而不是死等固定时长——否则启动日志只剩「ping 超时」这种零信息量的文案。
    const deadline = Date.now() + PING_ROOT_CAUSE_GRACE_MS;
    while (!breaker.lastError && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
    }
    return { ok: false, error: breaker.lastError || seenError || err };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * 连接目标与当前链路状态（供启动诊断日志 / 健康检查使用）
 */
const getStatus = () => {
  let host = '(未配置 DATABASE_URL)';
  let database = '';
  try {
    const u = new URL(connectionString);
    host = u.hostname;
    database = u.pathname.replace(/^\//, '');
  } catch (_) { /* ignore */ }

  return {
    driver: activeDriver.name,
    host,
    database,
    isNeon: isNeonDatabase,
    breakerOpen: isBreakerOpen(),
    retryInMs: isBreakerOpen() ? breaker.openUntil - Date.now() : 0,
    lastError: breaker.lastError ? describeError(breaker.lastError) : null
  };
};

module.exports = {
    query, getClient, runInTransaction, warmup, ping, getStatus, describeError, forceOpenBreaker
};
module.exports.__testables = {
    isConnectionError, isNeonDatabase, allowNeonFallback, describeError,
    noteConnectionFailure, noteConnectionSuccess, shouldFastFail
};
