const crypto = require('crypto');

/**
 * 请求上下文中间件
 * @description 为每次请求分配稳定的 requestId：
 *              - 入站 X-Request-Id 若安全（仅含可打印 ASCII，无空格/控制字符）则原样沿用，
 *                便于跨服务串联日志；否则生成 UUID（36 位十六进制，匹配 /^[0-9a-f-]{36}$/）。
 *              - 始终在响应头写回 X-Request-Id，并在 req.requestId 暴露给后续中间件/错误出口，
 *                使错误信封 meta.requestId 与日志一致。
 * @module middleware/request-context
 */

// 入站 id 白名单：可打印 ASCII，不含空格/控制字符，最长 128
const SAFE_INBOUND = /^[A-Za-z0-9._:\-]{1,128}$/;

const requestContext = (req, res, next) => {
    const incoming = req && typeof req.get === 'function' ? req.get('X-Request-Id') : null;
    let requestId = null;

    if (typeof incoming === 'string' && SAFE_INBOUND.test(incoming)) {
        requestId = incoming;
    } else {
        requestId = crypto.randomUUID();
    }

    req.requestId = requestId;
    if (res && typeof res.set === 'function') {
        res.set('X-Request-Id', requestId);
    }
    next();
};

module.exports = { requestContext, SAFE_INBOUND };
