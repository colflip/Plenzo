/**
 * HTTP 状态 <-> 机器错误码 双向映射（单一来源）
 * @description 前端 api-client 的 isEnvelope 要求 error.code 为稳定 machine code，
 *              且 error.retryable 由状态决定。此处集中维护映射，供 error.js /
 *              response-envelope / export-error-handler / rate-limit 复用。
 * @module utils/http-status
 */

// HTTP 状态码 -> 机器错误码
const STATUS_TO_CODE = {
    400: 'BAD_REQUEST',
    401: 'AUTH_INVALID',
    403: 'FORBIDDEN',
    404: 'RESOURCE_NOT_FOUND',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    422: 'VALIDATION_FAILED',
    429: 'RATE_LIMITED',
    500: 'INTERNAL_ERROR',
    502: 'SERVICE_UNAVAILABLE',
    503: 'SERVICE_UNAVAILABLE',
    504: 'SERVICE_UNAVAILABLE'
};

// 机器错误码 -> HTTP 状态码
const CODE_TO_STATUS = {
    AUTH_REQUIRED: 401,
    AUTH_INVALID: 401,
    AUTH_EXPIRED: 401,
    SESSION_EPOCH_MISMATCH: 401,
    FORBIDDEN: 403,
    RESOURCE_NOT_FOUND: 404,
    ROUTE_NOT_FOUND: 404,
    CONFLICT: 409,
    BAD_REQUEST: 400,
    PAYLOAD_TOO_LARGE: 413,
    VALIDATION_FAILED: 422,
    RATE_LIMITED: 429,
    INTERNAL_ERROR: 500,
    SERVICE_UNAVAILABLE: 503,
    REQUEST_FAILED: 400,
    DB_UNAVAILABLE: 503
};

// 机器错误码 -> 默认状态码与是否可重试（避免各中间件重复推导）
const CODE_DEFAULTS = {
    AUTH_REQUIRED: { status: 401, retryable: false },
    AUTH_INVALID: { status: 401, retryable: false },
    AUTH_EXPIRED: { status: 401, retryable: false },
    SESSION_EPOCH_MISMATCH: { status: 401, retryable: false },
    FORBIDDEN: { status: 403, retryable: false },
    RESOURCE_NOT_FOUND: { status: 404, retryable: false },
    ROUTE_NOT_FOUND: { status: 404, retryable: false },
    CONFLICT: { status: 409, retryable: false },
    BAD_REQUEST: { status: 400, retryable: false },
    PAYLOAD_TOO_LARGE: { status: 413, retryable: false },
    VALIDATION_FAILED: { status: 422, retryable: false },
    RATE_LIMITED: { status: 429, retryable: true },
    INTERNAL_ERROR: { status: 500, retryable: false },
    SERVICE_UNAVAILABLE: { status: 503, retryable: true },
    REQUEST_FAILED: { status: 400, retryable: false },
    DB_UNAVAILABLE: { status: 503, retryable: true }
};

const statusToErrorCode = (status) => STATUS_TO_CODE[status] || 'INTERNAL_ERROR';
const errorCodeToStatus = (code) => CODE_TO_STATUS[code] || 500;
const codeDefaults = (code) => CODE_DEFAULTS[code] || null;

module.exports = {
    STATUS_TO_CODE,
    CODE_TO_STATUS,
    CODE_DEFAULTS,
    statusToErrorCode,
    errorCodeToStatus,
    codeDefaults
};
