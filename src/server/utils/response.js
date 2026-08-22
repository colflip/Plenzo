/**
 * 统一响应构造器（单一来源）
 * @description 消除 validation.js 与 error.js 中重复构造的响应对象。
 *              - standardResponse: 业务成功/失败响应（含 data 字段），供控制器使用
 *              - errorResponse: 错误信息响应，供 error.js 全局错误处理使用
 * @module utils/response
 */

const standardResponse = (success, data = null, message = '', errors = null) => ({
    success,
    data,
    message,
    errors,
    timestamp: new Date().toISOString()
});

const errorResponse = (success, message, errors = null) => ({
    success,
    message,
    errors,
    timestamp: new Date().toISOString()
});

module.exports = { standardResponse, errorResponse };
