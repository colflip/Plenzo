/**
 * 学生端主入口文件
 * @module student
 */

import { initOverviewSection, loadOverview } from './overview.js';
import { initProfileSection } from './profile.js';
import { initAvailabilitySection, refreshAvailability } from './availability.js';
import { initSchedulesSection, refreshSchedules } from './schedules.js';
import { initStatisticsSection, loadLearningStats } from './statistics.js';
import {
    setupSidebarToggle,
    applyChartFontFromCSSVars,
    ensureAuth,
    setupLogout,
    setupModalClosures,
    updateUserName,
    createDashboardController,
} from '../shared/dashboard-kit.js';

let controller = null;

window.initDashboard = initDashboard;

document.addEventListener('DOMContentLoaded', () => {
    initDashboard().catch(() => {});
});

document.addEventListener('readystatechange', () => {
    if (document.readyState === 'complete') {
        window.initDashboard = initDashboard;
    }
});

export { initDashboard };

async function initDashboard() {
    if (!ensureAuth('student')) return;

    updateUserName({ elementId: 'studentName', fallback: '学生' });

    if (window.ScheduleTypesStore) {
        await window.ScheduleTypesStore.init();
    }

    applyChartFontFromCSSVars();
    setupSidebarToggle({ storageKey: 'sidebarCollapsed' });
    setupLogout();
    setupModalClosures(['passwordChangeModal']);

    controller = createDashboardController({
        sectionInitializers: {
            overview: initOverviewSection,
            profile: initProfileSection,
            availability: initAvailabilitySection,
            schedules: initSchedulesSection,
            'teaching-display': initStatisticsSection,
        },
        sectionRefreshers: {
            overview: loadOverview,
            availability: refreshAvailability,
            schedules: refreshSchedules,
            'teaching-display': loadLearningStats,
        },
    });
    controller.init();
    await controller.activate('overview');
}
