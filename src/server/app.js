/**
 * 应用入口文件
 * @description 初始化 Express 应用，配置中间件、路由和全局错误处理
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const morgan = require('morgan');

const {
    errorHandler,
    notFoundHandler,
    loginLimiter,
    apiLimiter,
    securityHeaders,
    additionalSecurityHeaders,
    corsOptions
} = require('./middleware');

const initScheduler = require('./jobs/scheduler');
const runDatabaseMigrations = require('./db/migrations');
const { warmup: dbWarmup } = require('./db/db');

const app = express();

// 信任代理层：Vercel/Render 等平台将应用置于单层反向代理之后，
// 真实客户端 IP 位于 X-Forwarded-For / Forwarded 头中。
// 设为 1（仅信任一层代理）而非 true，避免客户端伪造转发头绕过限流。
// 这同时修复 express-rate-limit 的 ERR_ERL_FORWARDED_HEADER 校验错误，
// 并使 req.ip 返回真实客户端 IP（loginLimiter/strictLimiter/apiLimiter 依赖此值）。
app.set('trust proxy', 1);

const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

// P0 安全检查：生产环境拒绝使用默认 JWT 密钥
(function checkJwtSecret() {
    const secret = process.env.JWT_SECRET;
    const weakSecrets = ['your-secret-key-change-this-in-production', 'dev-insecure-secret', ''];
    if (isProduction && (!secret || weakSecrets.includes(secret))) {
        console.error('🚨 致命安全错误: 生产环境检测到弱或缺失的 JWT_SECRET！');
        console.error('   请在 .env 中设置一个强随机密钥（至少 32 字符）');
        console.error('   生成方法: node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
        process.exit(1);
    }
})();

app.use(securityHeaders);
app.use(additionalSecurityHeaders);

if (isProduction) {
    app.use(cors(corsOptions));
} else {
    app.use(cors());
}

if (process.env.NODE_ENV !== 'test') {
    const morganFormat = isProduction ? 'combined' : 'dev';
    app.use(morgan(morganFormat, {
        skip: (req, res) => {
            // 跳过健康检查
            if (req.path === '/api/health' && res.statusCode === 200) return true;
            // 开发环境跳过静态资源请求（css/js/svg/png/jpg/fonts/well-known）
            if (!isProduction) {
                const p = req.path;
                if (p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/assets/') ||
                    p.startsWith('/fonts/') || p.startsWith('/.well-known/') ||
                    /\.(css|js|svg|png|jpg|jpeg|gif|woff2?|ttf|eot|map)(\?|$)/i.test(p)) {
                    return true;
                }
            }
            return false;
        }
    }));
}

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use(express.static(path.join(__dirname, '../../public'), {
    maxAge: isProduction ? '1d' : '0',
    etag: true,
    setHeaders(res, filePath) {
        // 仪表盘 HTML 与其 CSS/JS 都使用 ETag 重验证，避免生产环境一天强缓存
        // 让部署后的按钮样式和 ESM 子模块继续停留在旧版本。
        if (/\.(?:html|css|js)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
        }
    }
}));

app.use('/api/auth/login', loginLimiter);

app.use('/api', apiLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/teacher', require('./routes/teacher'));
app.use('/api/student', require('./routes/student'));
app.use('/api/export', require('./routes/export'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/users', require('./routes/users'));
app.use('/api/health', require('./routes/health'));
app.use('/api/meta', require('./routes/meta'));
app.use('/api/ai', require('./routes/ai'));

const dashboardPages = {
    admin: path.join(__dirname, '../../public/admin/dashboard.html'),
    teacher: path.join(__dirname, '../../public/teacher/dashboard.html'),
    student: path.join(__dirname, '../../public/student/dashboard.html')
};

const dashboardSections = {
    admin: new Set(['overview', 'users', 'availability-mgmt', 'schedule', 'statistics', 'system-settings']),
    teacher: new Set(['overview', 'profile', 'availability', 'schedules', 'teaching-display', 'student-schedules']),
    student: new Set(['overview', 'profile', 'availability', 'schedules', 'teaching-display'])
};

// 静态资源版本化：给 HTML 中本地 /js、/css、/assets 引用注入 ?v=<shortSha>，
// 并令 HTML 本身 no-cache，确保部署后用户立即拿到新模块。
const fs = require('fs');
const { injectAssetVersion } = require('./utils/asset-version');
const { getVersionMeta } = require('./services/version-service');

let cachedVersionMeta = null;
async function getAssetVersion() {
    if (!cachedVersionMeta) {
        try {
            cachedVersionMeta = await getVersionMeta();
        } catch (_) {
            cachedVersionMeta = { shortSha: 'dev' };
        }
    }
    return cachedVersionMeta.shortSha || 'dev';
}

const versionedHtmlCache = new Map(); // filePath -> { version, html }

async function sendVersionedDashboard(res, filePath) {
    const version = await getAssetVersion();
    let entry = versionedHtmlCache.get(filePath);
    if (!entry || entry.version !== version) {
        const raw = await fs.promises.readFile(filePath, 'utf8');
        entry = { version, html: injectAssetVersion(raw, version) };
        versionedHtmlCache.set(filePath, entry);
    }
    res.set('Cache-Control', 'no-cache');
    res.send(entry.html);
}

function serveDashboardSection(role) {
    return async (req, res, next) => {
        if (!dashboardSections[role].has(req.params.section)) return next();
        try {
            await sendVersionedDashboard(res, dashboardPages[role]);
        } catch (err) {
            console.error('[dashboard] 版本化服务失败，回退 sendFile:', err && err.message);
            res.sendFile(dashboardPages[role]);
        }
    };
}

// 仪表盘菜单使用路径驱动的区块路由。服务端仅对已登记的菜单路径返回同一壳层，
// 由前端按 pathname 激活对应页面，以便刷新、深链接和浏览器前进/后退均可用。
app.get(['/admin/dashboard', '/admin/dashboard.html', '/admin/'], (req, res) => {
    sendVersionedDashboard(res, dashboardPages.admin).catch(err => {
        console.error('[dashboard] 版本化服务失败，回退 sendFile:', err && err.message);
        res.sendFile(dashboardPages.admin);
    });
});
app.get(['/admin/dashboard/:section', '/admin/dashboard.html/:section'], serveDashboardSection('admin'));

app.get(['/teacher/dashboard', '/teacher/dashboard.html', '/teacher/'], (req, res) => {
    sendVersionedDashboard(res, dashboardPages.teacher).catch(err => {
        console.error('[dashboard] 版本化服务失败，回退 sendFile:', err && err.message);
        res.sendFile(dashboardPages.teacher);
    });
});
app.get(['/teacher/dashboard/:section', '/teacher/dashboard.html/:section'], serveDashboardSection('teacher'));

app.get(['/student/dashboard', '/student/dashboard.html', '/student/'], (req, res) => {
    sendVersionedDashboard(res, dashboardPages.student).catch(err => {
        console.error('[dashboard] 版本化服务失败，回退 sendFile:', err && err.message);
        res.sendFile(dashboardPages.student);
    });
});
app.get(['/student/dashboard/:section', '/student/dashboard.html/:section'], serveDashboardSection('student'));

app.use(notFoundHandler);

app.use(errorHandler);

const PORT = process.env.PORT || 3001;

// 启动服务器逻辑：除非在 Vercel Serverless 环境，否则一律启动监听
if (process.env.VERCEL) {
    // Vercel 自动处理导出
    module.exports = app;
} else {
    app.listen(PORT, () => {
        console.log(``);
        console.log(`🚀 Plenzo 服务已启动 | ${process.env.NODE_ENV || 'development'} | 端口 ${PORT}`);

        // 预热数据库连接（减少首次请求的重试）
        dbWarmup().then(() => {
            console.log(`[DB] 连接预热成功`);
        }).catch(err => {
            console.warn('[DB] ⚠️ 连接预热失败（不影响正常使用）:', err.message);
        });

        // 运行数据库迁移（幂等，失败不阻断启动）
        runDatabaseMigrations().catch(err => {
            console.error('❌ 数据库迁移启动失败:', err.message);
        });

        try {
            initScheduler();
        } catch (err) {
            console.error('❌ 定时任务启动失败:', err.message);
        }
    });
}

module.exports = app;
