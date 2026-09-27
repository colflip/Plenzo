/**
 * 健康检查路由
 * @description 提供进程 / 依赖的轻量探针。为便于编排与负载均衡器直接判定，
 *              本组端点使用最小协议（不套统一响应信封），且绝不外泄数据库错误细节。
 * @module routes/health
 */

const express = require('express');
const router = express.Router();
const db = require('../db/db');

const nowIso = () => new Date().toISOString();

// 探针端点统一跳过响应信封（responseEnvelope 中间件识别此标志后放行最小协议）
function markProbe(res) {
    res.locals = res.locals || {};
    res.locals.skipResponseEnvelope = true;
}

// 仅判定数据库是否可用，不返回主机 / 错误码 / 延迟等可被利用的细节
async function isDbHealthy() {
    try {
        const result = await db.query('SELECT 1 as ok');
        return !!(result && result.rows && result.rows[0] && result.rows[0].ok === 1);
    } catch (_) {
        return false;
    }
}

/**
 * 探针语义（**额度敏感：别把查库加回默认路径**）
 *
 * 每次查库都会唤醒 Neon 计算，而一次唤醒至少要空转完一个休眠窗口（默认 5 分钟）
 * 才重新睡着；免费版额度是 100 CU-小时/项目，被一个贴着休眠窗口周期的探针钉住
 * 就再也睡不成。所以「不查库」的探针要占据默认路径：
 *   /     、/live   进程存活 —— 平台健康检查、外部监控填这两个
 *   /db   、/ready  数据库连通性 —— 会唤醒计算，仅给人工排查或低频监控
 */
router.get('/', (req, res) => {
    markProbe(res);
    res.status(200).json({
        status: 'alive',
        checks: { process: 'healthy' },
        timestamp: nowIso()
    });
});

// 会唤醒数据库计算：见文件顶部探针语义说明
router.get('/db', async (req, res) => {
    const healthy = await isDbHealthy();
    markProbe(res);
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        checks: { database: healthy ? 'healthy' : 'unhealthy' },
        timestamp: nowIso()
    });
});

router.get('/live', (req, res) => {
    // Liveness 探针不查询任何依赖，仅反映进程存活
    markProbe(res);
    res.status(200).json({
        status: 'alive',
        checks: { process: 'healthy' },
        timestamp: nowIso()
    });
});

// 会唤醒数据库计算：见文件顶部探针语义说明
router.get('/ready', async (req, res) => {
    const healthy = await isDbHealthy();
    markProbe(res);
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ready' : 'not_ready',
        checks: { database: healthy ? 'healthy' : 'unhealthy' },
        timestamp: nowIso()
    });
});

module.exports = router;
