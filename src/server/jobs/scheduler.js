const cron = require('node-cron');
const updateScheduleStatus = require('./updateScheduleStatus');

/**
 * Initializes all background jobs.
 */
function initScheduler() {
    console.log('[Scheduler] Initializing background jobs...');

    // Schedule status update job: Daily at 22:30
    cron.schedule('30 22 * * *', async () => {
        console.log('[Scheduler] Triggering scheduled status update...');
        await updateScheduleStatus();
    }, {
        scheduled: true,
        timezone: "Asia/Shanghai" // Adjust timezone as needed, defaulting to China Standard Time based on user context
    });

    console.log('[Scheduler] Jobs scheduled: [Auto Status Update: 22:30 Daily]');
}

module.exports = initScheduler;
