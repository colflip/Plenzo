/**
 * 全局错误处理中间件
 * @description 统一处理Express应用中的所有错误
 * @module middleware/error
 */

/**
 * 标准化错误响应格式
 * @param {boolean} success - 是否成功
 * @param {string} message - 错误消息
 * @param {Array} errors - 详细错误信息
 * @returns {Object} 标准化响应对象
 */
const errorResponse = (success, message, errors = null) => ({
    success,
    message,
    errors,
    timestamp: new Date().toISOString()
});

/**
 * 自定义应用错误类
 */
class AppError extends Error {
    constructor(message, statusCode = 500, errors = null) {
        super(message);
        this.statusCode = statusCode;
        this.errors = errors;
        this.isOperational = true;
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * 数据库错误处理
 * @param {Error} err - 数据库错误
 * @returns {Object} { statusCode, message }
 */
const handleDatabaseError = (err) => {
    const errorMap = {
        '23505': { statusCode: 409, message: '数据已存在，请检查唯一性约束' },
        '23503': { statusCode: 400, message: '关联数据不存在' },
        '23502': { statusCode: 400, message: '必填字段不能为空' },
        '22P02': { statusCode: 400, message: '无效的数据格式' },
        '42P01': { statusCode: 500, message: '数据表不存在' }
    };

    return errorMap[err.code] || { statusCode: 500, message: '数据库操作失败' };
};

/**
 * JWT错误处理
 * @param {Error} err - JWT错误
 * @returns {Object} { statusCode, message }
 */
const handleJwtError = (err) => {
    if (err.name === 'TokenExpiredError') {
        return { statusCode: 401, message: '认证令牌已过期' };
    }
    if (err.name === 'JsonWebTokenError') {
        return { statusCode: 401, message: '无效的认证令牌' };
    }
    return { statusCode: 401, message: '认证失败' };
};

/**
 * 全局错误处理中间件
 */
const errorHandler = (err, req, res, next) => {
    // 默认错误状态和消息
    let statusCode = err.statusCode || 500;
    let message = err.message || '服务器内部错误';
    let errors = err.errors || null;

    // 处理已知的操作性错误
    if (err.isOperational) {
        return res.status(statusCode).json(errorResponse(false, message, errors));
    }

    // 处理数据库错误
    if (err.code && typeof err.code === 'string' && err.code.match(/^[0-9A-Z]{5}$/)) {
        const dbError = handleDatabaseError(err);
        statusCode = dbError.statusCode;
        message = dbError.message;
    }

    // 处理JWT错误
    if (err.name && (err.name.includes('Token') || err.name.includes('Jwt'))) {
        const jwtError = handleJwtError(err);
        statusCode = jwtError.statusCode;
        message = jwtError.message;
    }

    // 处理Joi验证错误
    if (err.isJoi) {
        statusCode = 400;
        message = '参数验证失败';
        errors = err.details?.map(d => ({
            field: d.path.join('.'),
            message: d.message
        }));
    }

    // 非生产环境记录详细错误
    if (process.env.NODE_ENV !== 'production') {
        console.error('[Error]', {
            message: err.message,
            stack: err.stack,
            code: err.code
        });
    }

    res.status(statusCode).json(errorResponse(false, message, errors));
};

/**
 * 404 Not Found处理中间件
 */
const notFoundHandler = (req, res, next) => {
    res.status(404).json(errorResponse(false, `路径 ${req.originalUrl} 不存在`));
};

/**
 * 异步错误包装器
 * @param {Function} fn - 异步路由处理函数
 * @returns {Function} 包装后的中间件
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
