/**
 * 健康检查路由
 * @description 提供系统和依赖服务的健康状态检查
 * @module routes/health
 */

const express = require('express');
const router = express.Router();
const db = require('../db/db');

const startTime = new Date();

const checkDatabaseHealth = async () => {
    const start = Date.now();
    try {
        const result = await db.query('SELECT 1 as ok');
        const latency = Date.now() - start;
        
        if (result && result.rows && result.rows[0] && result.rows[0].ok === 1) {
            return {
                status: 'healthy',
                latency: `${latency}ms`
            };
        }
        return {
            status: 'unhealthy',
            latency: `${latency}ms`,
            error: '数据库查询返回异常结果'
        };
    } catch (error) {
        const latency = Date.now() - start;
        return {
            status: 'unhealthy',
            latency: `${latency}ms`,
            error: error.message,
            code: error.code
        };
    }
};

const getMemoryUsage = () => {
    const usage = process.memoryUsage();
    return {
        heapUsed: `${Math.round(usage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(usage.heapTotal / 1024 / 1024)}MB`,
        rss: `${Math.round(usage.rss / 1024 / 1024)}MB`,
        external: `${Math.round(usage.external / 1024 / 1024)}MB`
    };
};

router.get('/', async (req, res) => {
    const dbHealth = await checkDatabaseHealth();
    const isHealthy = dbHealth.status === 'healthy';
    
    const healthData = {
        status: isHealthy ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: Math.floor((Date.now() - startTime.getTime()) / 1000),
        environment: process.env.NODE_ENV || 'development',
        version: process.env.npm_package_version || '1.0.0',
        dependencies: {
            database: dbHealth
        },
        system: {
            memory: getMemoryUsage(),
            nodeVersion: process.version,
            platform: process.platform
        }
    };

    const statusCode = isHealthy ? 200 : 503;
    res.status(statusCode).json(healthData);
});

router.get('/db', async (req, res) => {
    const dbHealth = await checkDatabaseHealth();
    const isHealthy = dbHealth.status === 'healthy';
    
    const statusCode = isHealthy ? 200 : 503;
    res.status(statusCode).json({
        ok: isHealthy,
        ...dbHealth
    });
});

router.get('/live', (req, res) => {
    res.status(200).json({ status: 'alive' });
});

router.get('/ready', async (req, res) => {
    const dbHealth = await checkDatabaseHealth();
    
    if (dbHealth.status === 'healthy') {
        res.status(200).json({ status: 'ready' });
    } else {
        res.status(503).json({ 
            status: 'not_ready',
            reason: '数据库不可用'
        });
    }
});

module.exports = router;
