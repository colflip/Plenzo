// 环境变量必须先于任何读取 process.env 的模块加载（logger / db.js / middleware / services）
const { loadEnv } = require('./utils/env-loader.js');
const envInfo = loadEnv();
const logger = require('./utils/logger.js');
/**
 * 应用入口文件
 * @description 初始化 Express 应用，配置中间件、路由和全局错误处理
 */

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');

const {
    errorHandler,
    notFoundHandler,
    loginLimiter,
    apiLimiter,
    securityHeaders,
    additionalSecurityHeaders,
    corsMiddleware,
    getJwtSecret,
    requestContext,
    responseEnvelope
} = require('./middleware');

const initScheduler = require('./jobs/scheduler');
const runDatabaseMigrations = require('./db/migrations');
const { warmup: dbWarmup } = require('./db/db');
const db = require('./db/db');
const { successResponse } = require('./utils/response');
const { auditScheduleTypes } = require('./utils/schedule-type-audit');
const aiOperationStore = require('./services/ai-operation-store');
const { primeAuditAttributionCapability } = require('./services/course-session-service');
const { AppError } = require('./middleware/error');

const app = express();

// 信任代理层：Vercel/Render 等平台将应用置于单层反向代理之后，
// 真实客户端 IP 位于 X-Forwarded-For / Forwarded 头中。
// 设为 1（仅信任一层代理）而非 true，避免客户端伪造转发头绕过限流。
// 这同时修复 express-rate-limit 的 ERR_ERL_FORWARDED_HEADER 校验错误，
// 并使 req.ip 返回真实客户端 IP（loginLimiter/strictLimiter/apiLimiter 依赖此值）。
app.set('trust proxy', 1);
// API JSON 响应关闭 ETag：避免 dashboard 轮询命中 304 后仍重跑慢查询，且保证数据始终最新
app.set('etag', false);

const isProduction = process.env.NODE_ENV === 'production';

// P0 安全检查：生产环境拒绝使用默认/缺失 JWT 密钥。
// 直接复用 auth.js 的单一来源校验（getJwtSecret 在生产环境弱/缺失密钥时抛出）。
(function checkJwtSecret() {
    try {
        getJwtSecret();
    } catch (e) {
        logger.error('🚨 致命安全错误: 生产环境检测到弱或缺失的 JWT_SECRET！');
        logger.error('   请在 .env 中设置一个强随机密钥（至少 32 字符）');
        logger.error('   生成方法: node -e "logger.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
        process.exit(1);
    }
})();

app.use(securityHeaders);
app.use(additionalSecurityHeaders);

// gzip/brotli 压缩：首屏 46 个 JS 脚本（1448KB 未压缩）经 gzip 压缩后传输量约减 70%
app.use(compression({
    // 只压缩超过 1KB 的响应
    threshold: 1024
}));

// 生产：corsMiddleware 先放行同源、再对跨域走白名单。自定义域名（如 Render 上绑定的
// plenzo.i.cd）不在硬编码白名单里，若直接用 cors(corsOptions)，同源的登录 POST 会被
// origin 回调拒成 500「服务器内部错误」—— 见 middleware/security.js 的 corsMiddleware 注释。
// 非生产：保持全放行，方便本地任意端口 / 工具联调。
app.use(isProduction ? corsMiddleware : cors());

if (process.env.NODE_ENV !== 'test') {
    const morganFormat = isProduction ? 'combined' : 'dev';
    app.use(morgan(morganFormat, {
        skip: (req, res) => {
            // 跳过健康检查。注意路由是 /api/health/、/api/health/live、/api/health/db，
            // 原来写成 === '/api/health' 一次也匹配不上，探针照常进访问日志（P3-13）
            if (req.path.startsWith('/api/health') && res.statusCode === 200) return true;
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

// 请求上下文：为每次请求分配稳定的 requestId 并回写响应头 X-Request-Id，
// 使后续所有控制器、限流、错误出口共享同一 id（错误信封 meta.requestId 与日志一致）。
// 必须先于 body 解析：JSON 解析失败时也要带上 requestId 进入错误出口。
app.use(requestContext);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// 响应信封：在边缘强制控制器输出为 { ok, data, error, meta } 信封，与前端
// api-client.isEnvelope 契约对齐。遗漏迁移的接口在此 loud-fail（抛错→500 信封），
// 而不向前端吐出无法识别的畸形 JSON。必须先于限流与路由装载。
app.use(responseEnvelope);

/*
 * 登录页与 404 页也走版本化注入。
 * 它们原本只由 express.static 直接发出：HTML 里的 <script src="/js/…"> 拿不到 ?v=，
 * 而静态目录的 maxAge:'1d' 会让「部署后首页仍跑旧模块」；三个仪表盘都由下面的
 * sendVersionedDashboard 处理，只剩这两个例外（审查报告 P2-20）。
 */
const PUBLIC_VERSIONED_PAGES = {
    '/': path.join(__dirname, '../../public/index.html'),
    '/index.html': path.join(__dirname, '../../public/index.html'),
    '/404.html': path.join(__dirname, '../../public/404.html')
};
for (const [routePath, filePath] of Object.entries(PUBLIC_VERSIONED_PAGES)) {
    app.get(routePath, async (req, res, next) => {
        try {
            await sendVersionedDashboard(res, filePath);
        } catch (err) {
            logger.error('[static] 版本化服务失败，回退静态文件:', err && err.message);
            next();
        }
    });
}


app.use(express.static(path.join(__dirname, '../../public'), {
    maxAge: isProduction ? '1d' : '0',
    etag: true,
    setHeaders(res, filePath) {
        // 仪表盘 HTML 与其 CSS/JS 都使用 ETag 重验证，避免生产环境一天强缓存
        // 让部署后的按钮样式和 ESM 子模块继续停留在旧版本。
        //
        // 这条必须与 vercel.json 里 /js/(.*)、/css/(.*) 的 Cache-Control 保持一致：
        // Vercel 上静态文件走的是它的改写规则、不经过这里，两边一旦不一致就由
        // Vercel 的 24h 胜出 —— 那时唯一还生效的刷新手段就只剩 entry.js 里手钉的
        // ?v=…（而那串不会随部署变化）。统一为 no-cache 后，?v= 只是第二道保险。
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
// 平台级 Cron 入口：Vercel Cron Jobs 按计划 HTTP 调用它（Serverless 无常驻进程，
// node-cron 不会触发）。Render 等常驻进程仍走 jobs/scheduler.js，两条路互不干扰。
app.use('/api/cron', require('./routes/cron'));

const dashboardPages = {
    admin: path.join(__dirname, '../../public/admin/dashboard.html'),
    teacher: path.join(__dirname, '../../public/teacher/dashboard.html'),
    student: path.join(__dirname, '../../public/student/dashboard.html')
};

// dashboard 区块白名单：直接从各端 dashboard.html 的 data-section 解析生成，
// 避免手工维护与服务端路由不同步（曾导致 finance / fees / sd-fees 直达 404）。
// 解析失败或为空时回退到内置名单，保证可用。
const DASHBOARD_SECTIONS_FALLBACK = {
    admin: ['overview', 'users', 'availability-mgmt', 'schedule', 'finance', 'statistics', 'system-settings'],
    teacher: ['overview', 'profile', 'availability', 'schedules', 'teaching-display', 'fees', 'sd-fees', 'student-schedules'],
    student: ['overview', 'profile', 'availability', 'schedules', 'teaching-display']
};

function buildDashboardSections() {
    const result = {};
    for (const role of Object.keys(dashboardPages)) {
        const set = new Set();
        try {
            const html = fs.readFileSync(dashboardPages[role], 'utf8');
            const re = /data-section="([^"]+)"/g;
            let m;
            while ((m = re.exec(html))) set.add(m[1]);
        } catch (err) {
            logger.warn(`[dashboard] 解析 ${role} 导航区块失败，回退内置白名单:`, err.message);
        }
        result[role] = set.size ? set : new Set(DASHBOARD_SECTIONS_FALLBACK[role]);
    }
    return result;
}

const dashboardSections = buildDashboardSections();

// 静态资源版本化：给 HTML 中本地 /js、/css、/assets 引用注入 ?v=<shortSha>，
// 并令 HTML 本身 no-cache，确保部署后用户立即拿到新模块。
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
    // 生产环境按 (文件, 版本号) 缓存注入后的 HTML，避免重复读盘与正则注入；
    // 非生产（本地 dev / NODE_ENV 未设置）每次读盘并重注入，确保未提交的 HTML
    // 与 <script> 引用改动即时生效，避免"改代码刷新仍跑旧壳/旧模块"导致的报错。
    if (isProduction) {
        let entry = versionedHtmlCache.get(filePath);
        if (!entry || entry.version !== version) {
            const raw = await fs.promises.readFile(filePath, 'utf8');
            entry = { version, html: injectAssetVersion(raw, version) };
            versionedHtmlCache.set(filePath, entry);
        }
        res.set('Cache-Control', 'no-cache');
        res.send(entry.html);
        return;
    }
    const raw = await fs.promises.readFile(filePath, 'utf8');
    res.set('Cache-Control', 'no-cache');
    res.send(injectAssetVersion(raw, version));
}

function serveDashboardSection(role) {
    return async (req, res, next) => {
        if (!dashboardSections[role].has(req.params.section)) return next();
        try {
            await sendVersionedDashboard(res, dashboardPages[role]);
        } catch (err) {
            logger.error('[dashboard] 版本化服务失败，回退 sendFile:', err && err.message);
            res.sendFile(dashboardPages[role]);
        }
    };
}

// 仪表盘菜单使用路径驱动的区块路由。服务端仅对已登记的菜单路径返回同一壳层，
// 由前端按 pathname 激活对应页面，以便刷新、深链接和浏览器前进/后退均可用。
app.get(['/admin/dashboard', '/admin/dashboard.html', '/admin/'], (req, res) => {
    sendVersionedDashboard(res, dashboardPages.admin).catch(err => {
        logger.error('[dashboard] 版本化服务失败，回退 sendFile:', err && err.message);
        res.sendFile(dashboardPages.admin);
    });
});
app.get(['/admin/dashboard/:section', '/admin/dashboard.html/:section'], serveDashboardSection('admin'));

app.get(['/teacher/dashboard', '/teacher/dashboard.html', '/teacher/'], (req, res) => {
    sendVersionedDashboard(res, dashboardPages.teacher).catch(err => {
        logger.error('[dashboard] 版本化服务失败，回退 sendFile:', err && err.message);
        res.sendFile(dashboardPages.teacher);
    });
});
// 隐藏酬劳彩蛋：点击"数据统计"标题 5 次后跳转的 JSON 页（直接返回 JSON，无 HTML）。
// 同站直接导航会自动携带 httpOnly Cookie 中的 JWT，故不再接受 URL 中的 token，
// 避免 token 经 Referer / 访问日志泄露（P2 调试路由修复）。无有效 token 时优雅降级为空数据 JSON。
const rewardCalc = require('./services/reward-calc');
// 令牌提取与验签一律走 middleware/auth 的唯一实现：本文件原先自己抄了一份
// jwt.verify，既不固定算法，也**不比对 TOKEN_EPOCH** —— 于是「用户 ID 重编后旧 token 全废」
// 这个开关在本路由上根本不生效，而重编后旧 token 里的 id 可能已归属另一位教师。
const { verifySession, getTokenFromRequest } = require('./middleware/auth');

app.get('/teacher/dashboard/teaching-display/goodluck', async (req, res, next) => {
    const { start, end } = req.query;
    // 契约：未登录 / 非教师 / 数据失败一律明确拒绝，绝不回退空数据（防信息泄露与静默降级）
    let user;
    try {
        // 走 verifySession 而不是 verifyToken：本路由读出的是酬劳明细，被停用/删除的教师
        // 不该仅凭一张还没过期的旧票继续读（同一条状态复核只有一份实现）。
        user = await verifySession(getTokenFromRequest(req));
    } catch (err) {
        return next(err);   // 401 + 具体 code（AUTH_EXPIRED / SESSION_EPOCH_MISMATCH / SESSION_REVOKED…）
    }
    if (user.userType !== 'teacher') {
        return next(new AppError({ code: 'FORBIDDEN', statusCode: 403, message: '仅教师可访问本页面' }));
    }
    try {
        // 姓名查询与酬劳聚合互不依赖：getRewardPayload 的 SQL 只用 userId/start/end，
        // name 仅被回填进 basic_info，故并发发出、拿到后补写（省一次往返，约 250ms）
        const [name, payload] = await Promise.all([
            db.query('SELECT name FROM teachers WHERE id = $1', [user.id])
                .then(r => (r.rows && r.rows[0] && r.rows[0].name) || '未知'),
            rewardCalc.getRewardPayload({ userId: user.id, name: '未知', start, end })
        ]);
        payload.basic_info.name = name;
        return res.json(successResponse(payload));
    } catch (err) {
        logger.error('[goodluck] 计算失败，拒绝而非降级:', err && err.message);
        return next(err);
    }
});
app.get(['/teacher/dashboard/:section', '/teacher/dashboard.html/:section'], serveDashboardSection('teacher'));

app.get(['/student/dashboard', '/student/dashboard.html', '/student/'], (req, res) => {
    sendVersionedDashboard(res, dashboardPages.student).catch(err => {
        logger.error('[dashboard] 版本化服务失败，回退 sendFile:', err && err.message);
        res.sendFile(dashboardPages.student);
    });
});
app.get(['/student/dashboard/:section', '/student/dashboard.html/:section'], serveDashboardSection('student'));

app.use(notFoundHandler);

app.use(errorHandler);

const PORT = process.env.PORT || 3001;

/**
 * 数据库启动门控：先做一次带超时的连通性探测，再决定是否跑迁移。
 *
 * 之前是无条件 fire-and-forget 跑迁移：DB 不可达时，迁移里每一条 information_schema
 * 探测都会各自走完「5 次重试 + 1/2/4/8s 退避」，启动日志被几十条相同告警淹没，第一条
 * 真实错误反而被挤到看不见；同时这些请求还会和首批用户请求抢连接池。
 * 现在探测失败就明确告知并跳过（迁移全部幂等，DB 恢复后下次启动会补跑）。
 */
function printDbUnreachableGuide(status, probeError) {
    const reason = probeError
        ? db.describeError(probeError)
        : (status.lastError || '连接失败');
    const lines = [
        '',
        '🚨 数据库不可达，已跳过迁移。服务仍在本机启动，但所有数据接口会返回 503。',
        `   目标: ${status.host}${status.database ? '/' + status.database : ''} (驱动: ${status.driver})`,
        `   原因: ${reason}`,
        '   排查顺序:',
        '     1) 网络是否可达该主机（本机是否断网 / 代理是否失效 / DNS 是否被污染）',
        '     2) 若目标是生产库，本地开发应改用本地或测试库，避免误连生产',
        '     3) 本地库：在项目根目录建 .env.local 覆盖 DATABASE_URL（git 已忽略），',
        '        例如 DATABASE_URL=postgres://postgres:postgres@localhost:5432/plenzo_dev',
        `   已加载环境文件: ${envInfo.loadedFiles.length ? envInfo.loadedFiles.join(', ') : '无（使用系统环境变量）'}`,
        ''
    ];
    lines.forEach(l => l ? logger.error(l) : logger.error(''));
}

async function bootstrapDatabase() {
    const status = db.getStatus();
    if (!status.host || status.host === '(未配置 DATABASE_URL)') {
        logger.error('❌ 未配置 DATABASE_URL，已跳过迁移；请在 .env 或 .env.local 中配置数据库连接串');
        return false;
    }

    const probe = await db.ping();
    if (!probe.ok) {
        printDbUnreachableGuide(db.getStatus(), probe.error);
        // 已确认不可达，直接开路：否则前几个真实请求要各自耗完 pg 握手 +
        // Neon fetch 超时（实测 26s）才能把熔断"攒"开。
        db.forceOpenBreaker(probe.error);
        return false;
    }

    try {
        await runDatabaseMigrations();
        // 迁移之后再探测「班主任归属 id 能不能写」：v5 去掉那两个只认 administrators 的
        // 外键之前，resolveAuditActorId 对非管理员一律返回 NULL（fail closed）。
        // 放在这里而不是每次写入查一遍，是为了让请求路径不碰 schema_migrations。
        await primeAuditAttributionCapability();
        // 迁移成功后才启动清理：表存在是前提，否则清理会刷 relation does not exist。
        // 注意它默认不自循环（原因见 ai-operation-store.js 里 SWEEP_INTERVAL_MS 的说明），
        // 这里的调用只是为了保留排障时启回自循环的开关。
        aiOperationStore.startExpirySweeper();
    } catch (err) {
        logger.error('❌ 数据库迁移失败:', db.describeError(err));
    }

    // 课程类型折算归属自检：任何三层规则都无法归类的类型都会在启动日志里被点名，
    // 避免新增类型后静默失去折算归属（「大评审」曾整类漏算）。失败不影响启动。
    auditScheduleTypes().catch(err => {
        logger.warn('课程类型归属自检未完成:', db.describeError(err));
    });

    return true;
}

// 运行数据库迁移（幂等，失败不阻断启动）。
// 注意：原先仅在非 Vercel 的 listen 回调中执行，导致 Vercel Serverless 环境下
// 迁移表（holidays / feedbacks / fee_audit_logs / ai_config 等）从未被创建。
// 改为在模块加载时触发（测试环境跳过），使所有部署形态都能拿到最新表结构。
const dbBootstrapPromise = (process.env.NODE_ENV !== 'test')
    ? bootstrapDatabase().catch(err => {
        logger.error('❌ 数据库启动门控异常:', db.describeError(err));
        return false;
    })
    : Promise.resolve(false);

// 启动服务器逻辑：除非在 Vercel Serverless 环境，否则一律启动监听。
// 注意：测试环境（NODE_ENV==='test'）由各自测试创建独立 server（http.createServer(app) + listen(0)），
// 此处不自动监听，避免多测试文件重复 require('../app') 时端口冲突（EADDRINUSE）。
if (process.env.VERCEL || process.env.NODE_ENV === 'test') {
    // Vercel 自动处理导出
    module.exports = app;
} else {
    app.listen(PORT, () => {
        logger.log(``);
        logger.log(`🚀 Plenzo 服务已启动 | ${process.env.NODE_ENV || 'development'} | 端口 ${PORT}`);

        // 预热数据库连接（减少首次请求的重试）。
        // 启动门控已确认 DB 不可达时不再预热：那只会再触发一轮重试日志。
        dbBootstrapPromise.then(dbOk => {
            if (!dbOk) {
                logger.warn('[DB] 跳过连接预热：启动探测未通过（详见上方告警）');
                return null;
            }
            return dbWarmup().then(() => {
                logger.log(`[DB] 连接预热成功`);
            }).catch(err => {
                logger.warn('[DB] ⚠️ 连接预热失败（不影响正常使用）:', db.describeError(err));
            });
        }).catch(() => {});

        try {
            initScheduler();
        } catch (err) {
            logger.error('❌ 定时任务启动失败:', err.message);
        }
    });
}

module.exports = app;
