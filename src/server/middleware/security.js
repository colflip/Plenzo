/**
 * 安全Headers中间件
 * @description 使用Helmet设置HTTP安全头，防止常见Web攻击
 * @module middleware/security
 */

const helmet = require('helmet');

/**
 * 安全Headers配置
 */
const securityHeaders = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: [
                "'self'",
                "'unsafe-inline'",
                "'unsafe-eval'",
                'cdn.jsdelivr.net'
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
                'https://*.onrender.com'
            ],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            baseUri: ["'self'"],
            objectSrc: ["'none'"]
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
        const allowedOrigins = [
            'https://schedule-widget.vercel.app',
            'https://schedule-widget.onrender.com',
            'http://localhost:3000',
            'http://localhost:3001',
            'http://localhost:5173',
            'http://localhost:5174'
        ];

        if (process.env.NODE_ENV === 'development' || !origin) {
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('不允许的CORS请求'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'X-CSRF-Token'
    ],
    exposedHeaders: ['Content-Disposition'],
    maxAge: 86400
};

module.exports = {
    securityHeaders,
    additionalSecurityHeaders,
    corsOptions
};
