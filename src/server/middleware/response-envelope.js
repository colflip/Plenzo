const { statusToErrorCode, errorCodeToStatus } = require('../utils/http-status');

/**
 * 响应信封中间件
 * @description 在边缘强制统一响应为 { ok, data, error, meta } 信封，与前端
 *              api-client.isEnvelope 契约对齐。
 *
 *              设计：控制器必须显式产出信封（successResponse / errorResponse /
 *              或已规范化的 envelope 对象）。任何非信封输出都会在此抛错 —— 这是
 *              有意的「护栏」：让遗漏迁移的接口在开发期即 loud-fail（500 错误信封），
 *              而不是静默返回前端 api-client 无法识别、从而判定 INVALID_RESPONSE
 *              崩溃整页的畸形 JSON。契约测试 response-contract.test.js 据此断言抛错行为。
 * @module middleware/response-envelope
 */

const isEnvelope = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    if (typeof obj.ok !== 'boolean') return false;
    if (!Object.prototype.hasOwnProperty.call(obj, 'data')) return false;
    if (!Object.prototype.hasOwnProperty.call(obj, 'error')) return false;
    if (!obj.meta || typeof obj.meta !== 'object') return false;
    if (typeof obj.meta.timestamp !== 'string') return false;
    if (obj.meta.requestId !== null && typeof obj.meta.requestId !== 'string') return false;
    if (obj.ok === true) {
        return obj.error === null;
    }
    const err = obj.error;
    return err && typeof err === 'object' &&
        typeof err.code === 'string' && err.code.length > 0 &&
        typeof err.message === 'string' &&
        Array.isArray(err.details) &&
        typeof err.retryable === 'boolean' &&
        (err.retryAfterSeconds === null || Number.isInteger(err.retryAfterSeconds));
};

const normalizeEnvelope = (env, req) => {
    const requestId = (env.meta && env.meta.requestId) != null
        ? env.meta.requestId
        : (req && req.requestId != null ? req.requestId : null);
    const timestamp = (env.meta && typeof env.meta.timestamp === 'string')
        ? env.meta.timestamp
        : new Date().toISOString();
    const meta = { requestId, timestamp };

    if (env.ok === true) {
        return { ok: true, data: env.data, error: null, meta };
    }

    const err = (env.error && typeof env.error === 'object') ? env.error : {};
    return {
        ok: false,
        data: null,
        error: {
            code: err.code || 'REQUEST_FAILED',
            message: err.message || '请求失败',
            details: Array.isArray(err.details) ? err.details : [],
            retryable: typeof err.retryable === 'boolean' ? err.retryable : false,
            retryAfterSeconds: (err.retryAfterSeconds === null || Number.isInteger(err.retryAfterSeconds))
                ? err.retryAfterSeconds
                : null
        },
        meta
    };
};

const RESPONSE_ENVELOPE_ERROR = '普通 JSON API 必须返回统一响应 envelope';

const responseEnvelope = (req, res, next) => {
    const originalJson = res.json.bind(res);

    res.json = (payload) => {
        // 白名单路由（如 Liveness 探针）显式声明跳过信封，返回其自有最小协议。
        if (res.locals && res.locals.skipResponseEnvelope) {
            return originalJson(payload);
        }
        if (!isEnvelope(payload)) {
            // 护栏：非信封输出一律拒绝。让遗漏迁移的接口在开发期 loud-fail，
            // 而不是向前端吐出 api-client 无法识别的畸形 JSON。
            throw new Error(RESPONSE_ENVELOPE_ERROR);
        }

        const env = normalizeEnvelope(payload, req);

        if (env.ok === false) {
            const want = errorCodeToStatus(env.error.code) || 500;
            const cur = res.statusCode;
            if (!cur || (cur >= 200 && cur < 400)) {
                res.status(want);
            }
        }
        return originalJson(env);
    };

    next();
};

module.exports = { responseEnvelope, isEnvelope, normalizeEnvelope, RESPONSE_ENVELOPE_ERROR };
