/**
 * 导出错误处理中间件
 * 统一处理导出功能的错误响应和日志记录
 */

/**
 * 处理导出错误
 * @param {Error} error - 错误对象
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
function handleExportError(error, req, res) {
    const userId = req.user?.id || 'unknown';
    const userType = req.user?.userType || req.user?.role || 'unknown';
    const errorMessage = error.message || '导出失败，请稍后重试';

    // 统一错误日志格式
    console.error(`[Export Error] [${userType}:${userId}] ${errorMessage}`, {
        error: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        query: req.query,
        timestamp: new Date().toISOString()
    });

    // 确定 HTTP 状态码
    let statusCode = 500;
    if (error.statusCode) {
        // 优先使用 ExportError 中设置的状态码
        statusCode = error.statusCode;
    } else {
        // 仅在未设置 statusCode 时根据错误消息智能判断
        if (errorMessage.includes('无数据') || errorMessage.includes('未找到')) {
            statusCode = 404;
        } else if (errorMessage.includes('权限') || errorMessage.includes('无权')) {
            statusCode = 403;
        } else if (errorMessage.includes('参数') || errorMessage.includes('日期') || errorMessage.includes('缺少')) {
            statusCode = 400;
        }
    }

    // 统一错误响应格式（与 standardResponse 一致）
    res.status(statusCode).json({
        success: false,
        data: null,
        message: errorMessage,
        errors: {
            code: error.code || 'EXPORT_ERROR',
            type: error.name || 'ExportError'
        },
        timestamp: new Date().toISOString()
    });
}

/**
 * 导出自定义错误类
 */
class ExportError extends Error {
    constructor(message, statusCode = 500, code = 'EXPORT_ERROR') {
        super(message);
        this.name = 'ExportError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

module.exports = {
    handleExportError,
    ExportError
};
