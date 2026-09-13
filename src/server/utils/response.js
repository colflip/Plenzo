/**
 * 统一响应构造器（单一来源）
 * @description 后端对外 JSON 全部走统一信封 { ok, data, error, meta }，
 *              与前端 api-client.isEnvelope 的契约对齐。
 *              - successResponse: 业务成功响应，data 为真实业务数据。
 *              - errorResponse:   失败响应，error 为 { code, message, details, retryable, retryAfterSeconds }。
 *              - standardResponse: 旧形态 { success, data, message, errors } 仅保留作过渡，
 *                由 response-envelope 中间件在边缘转换为信封，新代码请勿再使用。
 * @module utils/response
 */

const { statusToErrorCode, errorCodeToStatus } = require('./http-status');

const nowIso = () => new Date().toISOString();

/**
 * 业务成功响应
 * @param {*} data 真实业务数据（可为数组/对象/null）
 * @param {{ requestId?: string|null }} [options]
 */
const successResponse = (data = null, options = {}) => ({
    ok: true,
    data,
    error: null,
    meta: {
        requestId: (options && options.requestId) != null ? options.requestId : null,
        timestamp: nowIso()
    }
});

/**
 * 失败响应
 * @param {{ code?: string, message?: string, details?: Array, retryable?: boolean, retryAfterSeconds?: number|null }} errorLike
 * @param {{ requestId?: string|null }} [options]
 */
const errorResponse = (errorLike = {}, options = {}) => {
    const e = errorLike || {};
    const retryable = typeof e.retryable === 'boolean'
        ? e.retryable
        : (errorCodeToStatus(e.code) >= 500);
    const retryAfterSeconds = (e.retryAfterSeconds === null || Number.isInteger(e.retryAfterSeconds))
        ? e.retryAfterSeconds
        : null;
    return {
        ok: false,
        data: null,
        error: {
            code: e.code || 'REQUEST_FAILED',
            message: e.message || '请求失败',
            details: Array.isArray(e.details) ? e.details : [],
            retryable,
            retryAfterSeconds
        },
        meta: {
            requestId: (options && options.requestId) != null ? options.requestId : null,
            timestamp: nowIso()
        }
    };
};

/**
 * 旧形态（过渡用，勿在新代码使用）。由 response-envelope 中间件转换为信封。
 */
const standardResponse = (success, data = null, message = '', errors = null) => ({
    success,
    data,
    message,
    errors,
    timestamp: nowIso()
});

module.exports = { successResponse, errorResponse, standardResponse };
