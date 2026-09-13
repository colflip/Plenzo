const logger = require('../utils/logger.js');
const { errorResponse } = require('../utils/response');
const { statusToErrorCode } = require('../utils/http-status');

/**
 * 导出错误处理中间件
 * 统一处理导出功能的错误响应与日志记录，输出 { ok, data, error, meta } 信封。
 * @module middleware/export-error-handler
 */

/**
 * 导出自定义错误类
 * @param {string} message 展示给用户的文案
 * @param {number} [statusCode=500] HTTP 状态码
 * @param {string} [code='EXPORT_ERROR'] 导出子码（落在 error.details[0].exportCode）
 */
class ExportError extends Error {
    constructor(message, statusCode = 500, code = 'EXPORT_ERROR') {
        super(message);
        this.name = 'ExportError';
        this.statusCode = statusCode;
        this.code = statusToErrorCode(statusCode);
        this.exportCode = code;
        this.details = [{ exportCode: code }];
    }
}

/**
 * 处理导出错误
 * @param {Error} error - 错误对象（可为 ExportError 或普通 Error）
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
function handleExportError(error, req, res) {
    const userId = req.user && req.user.id ? req.user.id : 'unknown';
    const userType = (req.user && (req.user.userType || req.user.role)) || 'unknown';

    let statusCode;
    let machineCode;
    let details;
    let retryable;
    let message;

    if (error instanceof ExportError) {
        statusCode = error.statusCode;
        machineCode = error.code;
        details = error.details || [{ exportCode: error.exportCode || 'EXPORT_ERROR' }];
        retryable = statusCode >= 500;
        message = error.message;
    } else {
        // 普通未知错误：不依据中文文案猜状态码，统一为安全 5xx 与通用文案，避免泄露内部细节
        statusCode = 500;
        machineCode = 'INTERNAL_ERROR';
        details = [{ exportCode: 'EXPORT_ERROR' }];
        retryable = true;
        message = '服务暂时不可用，请稍后重试'; // 对外文案统一为通用，不回显内部错误
    }
    const logMessage = error.message || '导出失败'; // 日志保留原始错误便于排查

    logger.error(`[Export Error] [${userType}:${userId}] ${logMessage}`, {
        requestId: (req && req.requestId) || null,
        code: machineCode,
        error: message,
        query: req && req.query,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        timestamp: new Date().toISOString()
    });

    res.status(statusCode).json(
        errorResponse({
            code: machineCode,
            message,
            details,
            retryable,
            retryAfterSeconds: null
        }, { requestId: (req && req.requestId) || null })
    );
}

module.exports = {
    handleExportError,
    ExportError
};
