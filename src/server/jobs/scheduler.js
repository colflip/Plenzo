const logger = require('../utils/logger.js');
const cron = require('node-cron');
const updateScheduleStatus = require('./update-schedule-status');

/**
 * Initializes all background jobs.
 *
 * 仅常驻进程（Render / 本地）会走到这里 —— Vercel Serverless 没有常驻进程，
 * 定时器随实例销毁，所以 app.js 在 Vercel 分支不调用本函数；那条路由改由
 * **Vercel Cron Jobs** 在每日 12:00（北京时间）HTTP 调用
 * `src/server/routes/cron.js`，触发的是同一个 updateScheduleStatus。
 *
 * 两个触发点的时间刻意错开（Vercel 12:00 / 本进程 23:30），互为补充：
 * 作业幂等，12:00 那一跑提前收尾前一天及更早的场次，23:30 再收当天剩余的。
 */
function initScheduler() {
    // Schedule status update job: Daily at 23:30 (11:30 PM)
    cron.schedule('30 23 * * *', async () => {
        await updateScheduleStatus();
    }, {
        scheduled: true,
        timezone: "Asia/Shanghai"
    });

    // Run once immediately on startup (with slight delay to ensure DB connection)
    setTimeout(async () => {
        await updateScheduleStatus();
    }, 5000);

    logger.log('[Scheduler] 已启动 | 定时任务: 状态更新 (每日 23:30) + 启动检查');
}

module.exports = initScheduler;
