/**
 * 安全Headers中间件
 * @description 使用Helmet设置HTTP安全头，防止常见Web攻击
 * @module middleware/security
 */

const helmet = require('helmet');

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

        callback(new Error('不允许的CORS请求'));
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

module.exports = {
    securityHeaders,
    additionalSecurityHeaders,
    corsOptions
};
