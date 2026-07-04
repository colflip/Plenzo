const cron = require('node-cron');
const updateScheduleStatus = require('./updateScheduleStatus');

/**
 * Initializes all background jobs.
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

    console.log('[Scheduler] 已启动 | 定时任务: 状态更新 (每日 23:30) + 启动检查');
}

module.exports = initScheduler;
