/**
 * 学生端主入口文件
 * @module student
 */

import { initOverviewSection, loadOverview } from './overview.js';
import { initProfileSection, loadProfile } from './profile.js';
import { initAvailabilitySection, refreshAvailability } from './availability.js?v=20260806-toggle';
import { initSchedulesSection, refreshSchedules } from './schedules.js?v=20260806-toggle';
import { initStatisticsSection, loadLearningStats } from './statistics.js';
import * as aiAssistant from '../shared/ai-assistant-redesign.js';
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

    // 初始化 AI 助手
    aiAssistant.init({ role: 'student' });

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
            profile: loadProfile,
            availability: refreshAvailability,
            schedules: refreshSchedules,
            'teaching-display': loadLearningStats,
        },
        routeBase: '/student/dashboard',
    });
    await controller.init();
    setupDataSyncSubscriptions();
}

function refreshVisibleSection(sectionId, refresher) {
    const section = document.getElementById(sectionId);
    if (section?.classList.contains('active')) {
        Promise.resolve(refresher()).catch(() => {});
    }
}

function setupDataSyncSubscriptions() {
    if (!window.eventBus || window.__studentSyncSubscriptionsBound) return;
    window.__studentSyncSubscriptionsBound = true;

    const scheduleEvents = [
        window.EVENTS?.SCHEDULE_CREATED || 'schedule:created',
        window.EVENTS?.SCHEDULE_UPDATED || 'schedule:updated',
        window.EVENTS?.SCHEDULE_DELETED || 'schedule:deleted',
        window.EVENTS?.SCHEDULE_STATUS_CHANGED || 'schedule:statusChanged'
    ];
    scheduleEvents.forEach(eventName => {
        window.eventBus.on(eventName, () => {
            refreshVisibleSection('overview', loadOverview);
            refreshVisibleSection('schedules', refreshSchedules);
            refreshVisibleSection('teaching-display', loadLearningStats);
        });
    });

    window.eventBus.on(window.EVENTS?.SCHEDULE_TYPE_CHANGED || 'scheduleType:changed', () => {
        refreshVisibleSection('schedules', refreshSchedules);
        refreshVisibleSection('teaching-display', loadLearningStats);
    });

    window.eventBus.on(window.EVENTS?.PROFILE_UPDATED || 'profile:updated', detail => {
        if (detail?.role && detail.role !== 'student') return;
        updateUserName({ elementId: 'studentName', fallback: '学生' });
    });
}
