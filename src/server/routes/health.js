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

router.get('/', async (req, res) => {
    const healthy = await isDbHealthy();
    markProbe(res);
    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        checks: { database: healthy ? 'healthy' : 'unhealthy' },
        timestamp: nowIso()
    });
});

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
