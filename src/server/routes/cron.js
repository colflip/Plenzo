/**
 * 定时任务触发路由（平台级 Cron 入口）
 * @description Vercel 等 Serverless 平台没有常驻进程，`node-cron` 注册的进程内调度器
 *              （见 jobs/scheduler.js）永远不会被触发。Vercel 的替代方案是 **Cron Jobs**：
 *              平台按计划对某个 HTTP 路径发起调用（配置在 vercel.json 的 `crons` 字段）。
 *              本路由就是那个入口，让 Vercel 部署也能跑定时任务。
 *
 *              两个平台各走各的路，互不干扰：
 *              - Render / 常驻进程：jobs/scheduler.js 的 node-cron 每日 23:30 触发
 *              - Vercel：vercel.json 的 crons 调用本端点（schedule 用 UTC 表达）
 *
 * @module routes/cron
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const logger = require('../utils/logger.js');
const updateScheduleStatus = require('../jobs/update-schedule-status');
const { asyncHandler, AppError } = require('../middleware');
const { successResponse, errorResponse } = require('../utils/response');

// CRON_SECRET 最短长度：Vercel 官方建议至少 16 位随机字符串
const MIN_SECRET_LENGTH = 16;

/**
 * 校验调用凭据。
 *
 * Vercel 在项目里配置 `CRON_SECRET` 后，调用 cron 端点时会自动带上
 * `Authorization: Bearer <CRON_SECRET>`，据此即可确认请求来自平台调度而非公网扫描。
 *
 * 未配置 CRON_SECRET 时**一律拒绝**（fail closed）：本端点会写数据库，
 * 绝不能因为"没配密钥"就退化成任何人都能触发的公开接口。
 */
function assertCronAuthorized(req) {
    const secret = process.env.CRON_SECRET;

    if (!secret || secret.length < MIN_SECRET_LENGTH) {
        throw new AppError({
            code: 'CRON_NOT_CONFIGURED',
            statusCode: 503,
            message: `未配置 CRON_SECRET（至少 ${MIN_SECRET_LENGTH} 位），定时任务端点已禁用`,
            retryable: false
        });
    }

    const provided = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${secret}`);
    // 定长比较：普通字符串比较会在首个不同字符处提前返回，泄露前缀信息
    const matched = provided.length === expected.length
        && crypto.timingSafeEqual(provided, expected);

    if (!matched) {
        throw new AppError({
            code: 'CRON_UNAUTHORIZED',
            statusCode: 401,
            message: '无效的定时任务调用凭据',
            retryable: false
        });
    }
}

/**
 * @route GET /api/cron/update-schedule-status
 * @description 把已过期的「待确认 / 已确认」教师 pair 自动改为「已完成」。
 *              与 jobs/scheduler.js 调用的是同一个函数，逻辑与幂等性完全一致：
 *              SQL 自身按 `end_time < CURRENT_TIME` 筛候选，重复执行不会重复改。
 * @access 需要 CRON_SECRET（Authorization: Bearer）
 */
router.get('/update-schedule-status', asyncHandler(async (req, res) => {
    assertCronAuthorized(req);

    const result = await updateScheduleStatus();

    if (!result.success) {
        // 作业内部已捕获异常并返回 success:false，这里显式转成失败响应，
        // 让平台侧的调用日志能直接看出这一跑是失败的（Vercel 不会自动重试）。
        logger.error(`[cron] update-schedule-status 失败: ${result.error}`);
        return res.status(500).json(errorResponse({
            code: 'CRON_JOB_FAILED',
            message: `定时任务执行失败：${result.error}`,
            retryable: false,
            retryAfterSeconds: null
        }, { requestId: req.requestId }));
    }

    logger.log(`[cron] update-schedule-status 完成，更新 ${result.updatedCount} 个教师 pair`);
    return res.json(successResponse({
        job: 'update-schedule-status',
        updatedCount: result.updatedCount,
        runId: result.runId,
        trigger: 'http-cron'
    }, { requestId: req.requestId }));
}));

module.exports = router;
