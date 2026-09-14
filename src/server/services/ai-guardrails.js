/**
 * LLM 调用护栏：全局并发信号量 + 上游错误退避重试 + 轻量指标
 * @description
 *  这是「AI 访问频繁 / 不可用」的根因治理层。原 ai-service 每个请求内部最多 12 轮、
 *  每轮一次 HTTP 调用，且对 429 直接抛出、对网络错误重试 3 次但代价高（每次重试新建
 *  连接 + 1/2/3s 退避）。在 Serverless 多实例下，每个登录用户的一次提问会向上游打 N 次
 *  请求，N 个用户 × 多实例瞬间打满上游 RPM/TPM → 全部 429。
 *
 *  本模块提供：
 *   - LLMSemaphore：进程内信号量，限制「同时对上游 LLM 的并发调用数」（默认 8/实例），
 *     从源头防止多实例 × 每实例高并发打爆上游配额。
 *   - withLLMRetry：对 429/5xx/网络抖动做指数退避重试（带 jitter），尊重上游 Retry-After；
 *     失败时在信号量内统一等待，避免重试风暴。
 *   - llmMetrics：滚动窗口指标（调用数 / 失败数 / 429 数 / 平均耗时 / 最近错误），
 *     供 /api/ai/status 暴露，便于线上判断「是谁、哪个 provider 在吃配额」。
 *
 *  设计为无外部依赖、零副作用（指标仅内存），可直接被 ai-service 复用。
 */

const logger = require('../utils/logger.js');

// ============================================================
// 1. 进程内并发信号量
// ============================================================

class LLMSemaphore {
    /**
     * @param {number} max 最大并发数（建议 4~16，取决于上游配额与实例数）
     */
    constructor(max = 8) {
        this.max = Math.max(1, parseInt(max, 10) || 8);
        this.active = 0;
        this.queue = [];
        // 拥堵指标：累计等待任务数与峰值，供告警
        this._waiting = 0;
        this._peakWaiting = 0;
    }

    /** 当前是否在排队（用于指标/日志） */
    get waiting() { return this._waiting; }

    /**
     * 获取一个槽位；若已满则在 Promise 上排队。
     * @returns {Promise<() => void>} resolve 后得到释放函数 release()
     */
    acquire() {
        if (this.active < this.max) {
            this.active += 1;
            return Promise.resolve(this._release.bind(this));
        }
        this._waiting += 1;
        if (this._waiting > this._peakWaiting) this._peakWaiting = this._waiting;
        return new Promise((resolve) => {
            this.queue.push(() => {
                this._waiting -= 1;
                this.active += 1;
                resolve(this._release.bind(this));
            });
        });
    }

    _release() {
        this.active -= 1;
        // 让出事件循环，避免递归爆栈；优先唤醒下一个等待者
        if (this.queue.length > 0) {
            const next = this.queue.shift();
            if (next) setImmediate(next);
        }
    }

    /** 诊断快照 */
    snapshot() {
        return { max: this.max, active: this.active, waiting: this._waiting, peakWaiting: this._peakWaiting };
    }
}

// 默认信号量：可通过环境变量 AI_LLM_MAX_CONCURRENCY 调（按实例数与上游 RPM 估算）。
const defaultSemaphore = new LLMSemaphore(
    parseInt(process.env.AI_LLM_MAX_CONCURRENCY, 10) || 8
);

// ============================================================
// 2. 退避重试
// ============================================================

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 计算单次退避时长（指数 + jitter，并尊重上游 Retry-After）。
 * @param {number} attempt 当前已尝试次数（第 1 次重试=1）
 * @param {number} baseMs 基础退避
 * @param {number} capMs 退避上限
 * @param {number|null} retryAfterSeconds 上游 Retry-After（秒）
 */
function backoffMs(attempt, baseMs, capMs, retryAfterSeconds) {
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        // 尊重上游建议，但不超过 cap 的 2 倍（避免异常大的 Retry-After 卡死）
        return Math.min(retryAfterSeconds * 1000, capMs * 2);
    }
    const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
    // jitter ±25%，避免多实例同时重试形成「重试惊群」
    const jitter = exp * 0.25 * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(exp + jitter));
}

/**
 * 包裹一次 LLM 调用：在信号量内执行，对可重试错误做指数退避重试。
 * @param {Function} fn 返回 Promise 的调用（如 () => freshAxios({...})）
 * @param {Object} [opts]
 * @param {Object} [opts.semaphore] 自定义信号量（默认全局）
 * @param {number} [opts.maxRetries] 最大重试次数（默认 3）
 * @param {number} [opts.baseMs] 基础退避（默认 800）
 * @param {number} [opts.capMs] 退避上限（默认 8000）
 * @param {(err:Error, status:number|undefined)=>boolean} [opts.isRetryable]
 *        判断某次失败是否值得重试（默认：429/5xx/网络错误重试，4xx 鉴权/404 不重试）
 * @param {(err:Error)=>number|null} [opts.retryAfterOf] 从错误取 Retry-After（秒）
 * @param {string} [opts.label] 日志标签
 * @returns {Promise<any>}
 */
async function withLLMRetry(fn, opts = {}) {
    const semaphore = opts.semaphore || defaultSemaphore;
    const maxRetries = opts.maxRetries != null ? opts.maxRetries : 3;
    const baseMs = opts.baseMs || 800;
    const capMs = opts.capMs || 8000;
    const label = opts.label || 'LLM';
    const isRetryable = opts.isRetryable || ((err, status) => {
        if (!status) return true; // 网络错误（无状态码）
        return status === 429 || status >= 500;
    });
    const retryAfterOf = opts.retryAfterOf || (() => null);

    // 先拿信号量，保证「同时打向上游」的并发受控；重试也在信号量内等待，
    // 避免大量失败请求在信号量外并行重试形成重试风暴。
    const release = await semaphore.acquire();
    let lastErr;
    let lastStatus;
    try {
        for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
            try {
                const result = await fn();
                llmMetrics.recordSuccess(label);
                return result;
            } catch (err) {
                lastErr = err;
                lastStatus = err && err.status != null ? err.status : (err && err.response?.status);
                llmMetrics.recordFailure(label, lastStatus, err);
                if (attempt <= maxRetries && isRetryable(err, lastStatus)) {
                    const retryAfter = retryAfterOf(err);
                    const wait = backoffMs(attempt, baseMs, capMs, retryAfter);
                    logger.warn(`[${label}] 上游错误（${lastStatus || err?.code || 'network'}），${wait}ms 后第 ${attempt} 次重试（共 ${maxRetries} 次）`);
                    await sleep(wait);
                    continue;
                }
                throw err; // 不可重试或重试耗尽
            }
        }
        throw lastErr; // 理论不可达
    } finally {
        release();
    }
}

// ============================================================
// 3. 轻量指标（滚动窗口，内存）
// ============================================================

const METRIC_WINDOW_MS = 60 * 1000; // 只看最近 1 分钟
const llmMetrics = (() => {
    let total = 0;
    let failures = 0;
    let rateLimited = 0;
    let lastError = null;
    let totalLatencyMs = 0;
    const recent = []; // { t, ok, status, ms }

    function recordSuccess(label, ms) {
        total += 1;
        totalLatencyMs += ms || 0;
        recent.push({ t: Date.now(), ok: true, ms: ms || 0 });
        _trim();
    }
    function recordFailure(label, status, err) {
        failures += 1;
        if (status === 429) rateLimited += 1;
        lastError = {
            status,
            code: err && err.code,
            message: err && err.message,
            at: new Date().toISOString()
        };
        recent.push({ t: Date.now(), ok: false, status });
        _trim();
    }
    function _trim() {
        const cutoff = Date.now() - METRIC_WINDOW_MS;
        while (recent.length && recent[0].t < cutoff) recent.shift();
    }
    function snapshot() {
        _trim();
        const windowSuccess = recent.filter(r => r.ok).length;
        const windowFailures = recent.length - windowSuccess;
        const windowRateLimited = recent.filter(r => r.status === 429).length;
        const windowLatency = recent.filter(r => r.ok && r.ms).map(r => r.ms);
        const avgLatency = windowLatency.length
            ? Math.round(windowLatency.reduce((a, b) => a + b, 0) / windowLatency.length)
            : 0;
        return {
            totalCalls: total,
            failures,
            rateLimited,
            window: {
                calls: recent.length,
                success: windowSuccess,
                failures: windowFailures,
                rateLimited: windowRateLimited,
                avgLatencyMs: avgLatency
            },
            semaphore: defaultSemaphore.snapshot(),
            lastError
        };
    }
    return { recordSuccess, recordFailure, snapshot };
})();

module.exports = {
    LLMSemaphore,
    defaultSemaphore,
    withLLMRetry,
    backoffMs,
    llmMetrics
};
