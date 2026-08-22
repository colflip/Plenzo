// L5：结构化日志封装（替代散落的 console.*）
// 零依赖：生产环境输出 JSON 结构化行（含 ts/level/message/meta），开发环境输出可读文本。
// 使用 process.stdout/stderr 直接写出，避免在源码中残留 console.*，也防止与 logger 递归。
const isProduction = process.env.NODE_ENV === 'production';

function serialize(args) {
    let message = '';
    const meta = {};
    for (const a of args) {
        if (a instanceof Error) {
            meta.error = a.message;
            if (a.stack) meta.stack = a.stack;
        } else if (a && typeof a === 'object') {
            Object.assign(meta, a);
        } else {
            message += (message ? ' ' : '') + String(a);
        }
    }
    return { message, meta };
}

function emit(level, stream, args) {
    const ts = new Date().toISOString();
    if (isProduction) {
        const { message, meta } = serialize(args);
        stream.write(JSON.stringify({ ts, level, message, ...meta }) + '\n');
    } else {
        const text = args
            .map((a) => (a instanceof Error ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a)))
            .join(' ');
        stream.write(`[${ts}] ${level.toUpperCase()}: ${text}\n`);
    }
}

const logger = {
    info: (...args) => emit('info', process.stdout, args),
    log: (...args) => emit('info', process.stdout, args),
    warn: (...args) => emit('warn', process.stderr, args),
    error: (...args) => emit('error', process.stderr, args),
    debug: (...args) => {
        if (!isProduction) emit('debug', process.stdout, args);
    }
};

module.exports = logger;
