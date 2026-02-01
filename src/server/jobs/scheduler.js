const cron = require('node-cron');
const updateScheduleStatus = require('./updateScheduleStatus');

/**
 * Initializes all background jobs.
 */
function initScheduler() {
    console.log('[Scheduler] Initializing background jobs...');

    // Schedule status update job: Daily at 23:30 (11:30 PM)
    cron.schedule('30 23 * * *', async () => {
        console.log('[Scheduler] Triggering scheduled status update...');
        await updateScheduleStatus();
    }, {
        scheduled: true,
        timezone: "Asia/Shanghai"
    });

    // Run once immediately on startup (with slight delay to ensure DB connection)
    setTimeout(async () => {
        console.log('[Scheduler] Running startup status check...');
        await updateScheduleStatus();
    }, 5000);

    console.log('[Scheduler] Jobs scheduled: [Auto Status Update: 23:30 Daily] + [Startup Check]');
}

module.exports = initScheduler;
