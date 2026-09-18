/**
 * 安全Headers中间件
 * @description 使用Helmet设置HTTP安全头，防止常见Web攻击
 * @module middleware/security
 */

const helmet = require('helmet');
const cors = require('cors');

const isProduction = process.env.NODE_ENV === 'production';

/**
 * 安全Headers配置
 */
const securityHeaders = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                'cdn.jsdelivr.net',
                'cdnjs.cloudflare.com'
            ],
            styleSrc: [
                "'self'",
                "'unsafe-inline'",
                'fonts.googleapis.com'
            ],
            fontSrc: [
                "'self'",
                'fonts.gstatic.com',
                'data:'
            ],
            imgSrc: [
                "'self'",
                'data:',
                'blob:',
                'https:'
            ],
            connectSrc: [
                "'self'",
                'https://*.neon.tech',
                'https://*.vercel.app',
                'https://*.onrender.com',
                'https://*.railway.app'
            ],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"],
            upgradeInsecureRequests: null
        },
        reportOnly: process.env.NODE_ENV === 'development'
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: true,
    crossOriginResourcePolicy: { policy: "same-origin" },
    dnsPrefetchControl: { allow: false },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    },
    ieNoOpen: true,
    noSniff: true,
    originAgentCluster: true,
    permittedCrossDomainPolicies: { permittedPolicies: "none" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    xssFilter: true
});

/**
 * 附加安全Headers
 */
const additionalSecurityHeaders = (req, res, next) => {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Permissions-Policy',
        'geolocation=(), microphone=(), camera=(), payment=()');

    if (process.env.NODE_ENV === 'production') {
        res.setHeader('Strict-Transport-Security',
            'max-age=31536000; includeSubDomains; preload');
    }

    next();
};

/**
 * 判断请求是否与 Origin 同源（比较 host，含端口）。
 *
 * 为什么需要它：cors@2.8.5 调用 origin 回调时只传 origin 字符串
 * （`originCallback(req.headers.origin, cb)`），回调里拿不到 req，因此**无法**自行判断同源。
 * 同源判定只能放在中间件层，见 corsMiddleware。
 *
 * 只比 host 不比协议：服务端在反向代理之后无法可靠得知自己的对外协议，而 host 相同
 * 已经意味着「这是本站页面发出的请求」，放行它不会授予任何跨站能力。
 *
 * @param {import('express').Request} req
 * @param {string} origin
 * @returns {boolean}
 */
const isSameOriginRequest = (req, origin) => {
    if (!origin) return false;

    let originUrl;
    try {
        originUrl = new URL(origin);
    } catch (_) {
        return false; // 非法 Origin（如字面量 'null'）一律按跨域处理
    }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false;

    // 主判据只用 Host：Host 由浏览器按请求 URL 生成，页面 JS 无法伪造（它在 Fetch 规范的
    // 禁用头名单里）。X-Forwarded-Host **不在**该名单里 —— 任意页面都能在 fetch 时自行塞一个
    // `X-Forwarded-Host: evil.com`，若拿它当主判据，跨域请求就能伪装成同源。
    // 只在 Host 缺失（非浏览器客户端）时用 X-Forwarded-Host 兜底：这类客户端本来就能
    // 不带 Origin 直接放行（见下方 `!origin` 分支），所以该兜底不扩大攻击面。
    //
    // Vercel 官方文档明确 host = 「客户端访问的域名」（自定义域名会覆盖 *.vercel.app），
    // Render 同样透传原始 Host，因此正常部署下 Host 一定是对外域名。
    const host = String(req.headers.host || '').trim();
    const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const requestHost = host || forwardedHost;
    if (!requestHost) return false;

    const normalize = (host) => host.toLowerCase().replace(/\.$/, '');
    const stripDefaultPort = (host) => host.replace(originUrl.protocol === 'https:' ? /:443$/ : /:80$/, '');

    return stripDefaultPort(normalize(originUrl.host)) === stripDefaultPort(normalize(requestHost));
};

/**
 * CORS 拒绝错误：显式标成 403 的可操作错误。
 *
 * 不这么做的话，裸 Error 会落到 errorHandler 的兜底分支，客户端只看到 500
 * 「服务器内部错误，请稍后重试」——把「来源未列入白名单」这种一眼可判的配置问题
 * 伪装成服务端崩溃，排查成本极高。
 */
const corsForbiddenError = (origin) => {
    const err = new Error(
        `不允许的CORS请求：来源 ${origin} 未列入白名单。` +
        '同源请求不受影响；如需放行该来源，请在部署平台配置 ALLOWED_ORIGINS。'
    );
    err.code = 'CORS_FORBIDDEN';
    err.statusCode = 403;
    err.retryable = false;
    err.isOperational = true;
    return err;
};

/**
 * CORS安全配置
 */
const corsOptions = {
    origin: (origin, callback) => {
        // 解析环境变量中的额外允许域名
        const envOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
            : [];

        // 本地开发端口（Express dev / Vite 预览）：仅非生产环境放行。
        // 生产环境不保留任何 localhost 白名单 —— corsOptions.credentials 为 true，
        // 留着这些口子意味着本机任意页面或浏览器扩展都能以 localhost 源发起带凭证的
        // 跨域请求。生产环境若确实需要额外来源，用 ALLOWED_ORIGINS 显式配置。
        const localDevOrigins = isProduction ? [] : [
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:5173',
            'http://localhost:5174'
        ];

        const allowedOrigins = [
            'https://plenzo.vercel.app',
            'https://plenzo.onrender.com',
            ...localDevOrigins,
            ...envOrigins
        ];

        // 开发环境或同源请求（无 Origin，如 Postman/服务器端/同站模块脚本）
        if (process.env.NODE_ENV === 'development' || !origin) {
            return callback(null, true);
        }

        // 检查显式包含
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // 仅检查已知的 Railway 部署域名（非通配符）
        if (process.env.RAILWAY_STATIC_URL && origin === process.env.RAILWAY_STATIC_URL) {
            return callback(null, true);
        }

        // 同站放行：浏览器加载同站 ES module / 静态资源时仍会带 Origin 头，
        // 若该 Origin 的 host:port 与服务器实际监听一致（或均为 localhost/127.0.0.1 任意端口），
        // 视为同源，避免开发环境误将同站资源请求拒为 500（真实根因：
        // 之前只允许白名单域名，导致运行端口的 127.0.0.1 同源请求被 CORS 拦截成 500，
        // 进而 entry.js 等模块脚本无法加载，仪表盘不初始化）。
        // 注意：该动态 localhost 回退仅在非生产环境生效；生产环境必须收紧，
        // 仅允许上方显式 ALLOWED_ORIGINS + Railway URL，避免本机任意页面/扩展
        // 以 localhost 源发起带凭证的跨域请求。
        if (!isProduction) {
            try {
                const originUrl = new URL(origin);
                const host = process.env.HOST || 'localhost';
                const port = String(process.env.PORT || 3001);
                const sameHost = originUrl.hostname === host || originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1';
                const samePort = originUrl.port === port || originUrl.port === '';
                const isLocal = (originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1');
                if (sameHost && (samePort || isLocal)) {
                    return callback(null, true);
                }
            } catch (_) {
                // 非法 origin 字符串，落到下面的拒绝分支
            }
        }

        callback(corsForbiddenError(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With'
    ],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400
};

const corsWithWhitelist = cors(corsOptions);

/**
 * 生产环境 CORS 中间件：**先无条件放行同源，再对跨域做白名单校验**。
 *
 * 顺序不能反，也不能只依赖 corsOptions.origin：浏览器对同源的 POST/PUT/DELETE 同样会带
 * Origin 头（Fetch 规范：非 GET/HEAD 一律附加 Origin），而 origin 回调拿不到 req、
 * 判断不了同源。于是任何没有预先写进白名单的部署域名（典型场景：Render/Vercel 上绑定的
 * 自定义域名）都会在同源写请求上被拒 —— 症状极具误导性：页面能正常打开、GET 接口也正常，
 * 一提交表单就 500「服务器内部错误」（登录页正是踩中此坑）。
 *
 * 同源请求直接 next()：浏览器本来就不对它做 CORS 校验，不需要任何响应头。
 */
const corsMiddleware = (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || isSameOriginRequest(req, origin)) return next();
    return corsWithWhitelist(req, res, next);
};

module.exports = {
    securityHeaders,
    additionalSecurityHeaders,
    corsOptions,
    corsMiddleware,
    isSameOriginRequest
};
