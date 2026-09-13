const logger = require('../utils/logger.js');
/**
 * 全局错误处理中间件
 * @description 统一处理 Express 应用中的所有错误，输出 { ok, data, error, meta } 信封。
 * @module middleware/error
 */

const { errorResponse } = require('../utils/response');
const { statusToErrorCode, errorCodeToStatus, codeDefaults } = require('../utils/http-status');

/**
 * 应用错误类
 * 兼容两种构造方式：
 *   - new AppError({ code, message, details, retryable, retryAfterSeconds, statusCode })
 *   - new AppError(message, statusCode, errors)  // 旧位置参数
 * code 缺失时按 statusCode 推导；statusCode 缺失时按 code 的 CODE_DEFAULTS 推导。
 */
class AppError extends Error {
    constructor(messageOrOptions, statusCode, errors) {
        let opts;
        if (messageOrOptions && typeof messageOrOptions === 'object') {
            opts = { ...messageOrOptions };
        } else {
            opts = { message: messageOrOptions, statusCode, errors };
        }

        super(opts.message || '服务器内部错误');
        this.name = 'AppError';

        this.code = opts.code || statusToErrorCode(opts.statusCode || 500);

        const def = codeDefaults(this.code);
        this.statusCode = opts.statusCode ||
            (def && def.status) ||
            errorCodeToStatus(this.code) ||
            500;

        if (typeof opts.retryable === 'boolean') {
            this.retryable = opts.retryable;
        } else if (def) {
            this.retryable = def.retryable;
        } else {
            this.retryable = this.statusCode >= 500;
        }

        this.details = opts.details || null;
        this.retryAfterSeconds = (opts.retryAfterSeconds === null || Number.isInteger(opts.retryAfterSeconds))
            ? opts.retryAfterSeconds
            : null;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * 数据库错误处理（SQLSTATE -> 状态/文案/机器码）
 */
const DB_ERROR_MAP = {
    '23505': { status: 409, code: 'CONFLICT', message: '数据已存在，请检查唯一性约束' },
    '23503': { status: 400, code: 'BAD_REQUEST', message: '关联数据不存在' },
    '23502': { status: 400, code: 'BAD_REQUEST', message: '必填字段不能为空' },
    '22P02': { status: 400, code: 'BAD_REQUEST', message: '无效的数据格式' },
    '42P01': { status: 500, code: 'INTERNAL_ERROR', message: '数据表不存在' }
};

const handleDatabaseError = (err) => {
    const mapped = DB_ERROR_MAP[err.code];
    return mapped || { status: 500, code: 'INTERNAL_ERROR', message: '数据库操作失败' };
};

/**
 * JWT 错误处理
 */
const handleJwtError = (err) => {
    if (err.name === 'TokenExpiredError') {
        return { statusCode: 401, code: 'AUTH_EXPIRED', message: '认证令牌已过期' };
    }
    if (err.name === 'JsonWebTokenError') {
        return { statusCode: 401, code: 'AUTH_INVALID', message: '无效的认证令牌' };
    }
    return { statusCode: 401, code: 'AUTH_INVALID', message: '认证失败' };
};

/**
 * 重复错误日志节流：同一 (code+message) 10s 内只记录一次完整堆栈。
 */
const ERROR_LOG_WINDOW = 10000;
const recentErrorKeys = new Map();

const shouldLogDetail = (err) => {
    const key = `${err.code || ''}|${err.message || ''}`;
    const now = Date.now();
    const last = recentErrorKeys.get(key);
    if (last && now - last < ERROR_LOG_WINDOW) return false;
    recentErrorKeys.set(key, now);
    if (recentErrorKeys.size > 200) {
        for (const [k, t] of recentErrorKeys) {
            if (now - t > ERROR_LOG_WINDOW) recentErrorKeys.delete(k);
        }
    }
    return true;
};

/**
 * 全局错误处理中间件
 */
const errorHandler = (err, req, res, next) => {
    const requestId = req && req.requestId;

    let statusCode;
    let code;
    let message;
    let details = null;
    let retryable = false;
    let retryAfterSeconds = null;

    if (err instanceof AppError || err.isOperational) {
        statusCode = err.statusCode || 500;
        code = err.code || statusToErrorCode(statusCode);
        message = err.message || '请求失败';
        details = err.details || null;
        retryable = typeof err.retryable === 'boolean' ? err.retryable : (statusCode >= 500);
        retryAfterSeconds = err.retryAfterSeconds != null ? err.retryAfterSeconds : null;
    } else if (err.code === 'DB_UNAVAILABLE' || (typeof err.code === 'string' && /^08/.test(err.code))) {
        statusCode = 503;
        code = 'DB_UNAVAILABLE';
        message = '数据库暂时不可用，请稍后重试';
        retryable = true;
    } else if (err.code && typeof err.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
        const db = handleDatabaseError(err);
        statusCode = db.status;
        code = db.code;
        message = db.message;
    } else if (err.name && (err.name.includes('Token') || err.name.includes('Jwt'))) {
        const jwtErr = handleJwtError(err);
        statusCode = jwtErr.statusCode;
        code = jwtErr.code;
        message = jwtErr.message;
    } else if (err.type === 'entity.parse.failed') {
        statusCode = 400;
        code = 'BAD_REQUEST';
        message = '请求内容不是有效的 JSON';
    } else if (err.type === 'entity.too.large') {
        statusCode = 413;
        code = 'PAYLOAD_TOO_LARGE';
        message = '请求体过大，请减少提交内容后重试';
    } else if (err.isJoi) {
        statusCode = 422;
        code = 'VALIDATION_FAILED';
        message = '参数验证失败';
        details = (err.details || []).map((d) => ({
            path: d.path.join('.'),
            message: d.message
        }));
    } else {
        statusCode = err.statusCode || 500;
        code = statusToErrorCode(statusCode);
        message = '服务器内部错误';
    }

    // 5xx 不向客户端泄露内部信息：统一为安全文案。
    if (statusCode >= 500) {
        message = (code === 'DB_UNAVAILABLE') ? message : '服务器内部错误，请稍后重试';
    }
    if (retryAfterSeconds == null && retryable) {
        retryAfterSeconds = null;
    }

    if (process.env.NODE_ENV !== 'production' && shouldLogDetail(err)) {
        logger.error('[Error]', {
            message: err.message,
            stack: err.stack,
            code: err.code
        });
    }

    res.status(statusCode).json(
        errorResponse({ code, message, details: details || [], retryable, retryAfterSeconds }, { requestId })
    );
};

/**
 * 404 Not Found 处理中间件
 */
const notFoundHandler = (req, res, next) => {
    if (req.path && req.path.startsWith('/api/')) {
        return res.status(404).json(
            errorResponse(
                { code: 'ROUTE_NOT_FOUND', message: '请求的资源不存在', details: [], retryable: false, retryAfterSeconds: null },
                { requestId: req && req.requestId }
            )
        );
    }
    const path = require('path');
    res.status(404).sendFile(path.join(__dirname, '../../../public/404.html'));
};

/**
 * 异步错误包装器
 */
const asyncHandler = (fn) => {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
};

module.exports = {
    AppError,
    errorHandler,
    notFoundHandler,
    asyncHandler,
    errorResponse
};
