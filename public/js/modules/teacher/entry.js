/**
 * 教师端主入口文件
 * @description 教师仪表盘初始化和导航逻辑
 * @module teacher
 */

import { initOverviewSection, loadOverview } from './overview.js';
import { initProfileSection, loadProfile } from './profile.js';
import { initAvailabilitySection, refreshAvailability } from './availability.js';
import { initSchedulesSection, refreshSchedules } from './schedules.js';
import { initStatisticsSection, loadTeachingCount, loadTeachingSummary } from './statistics.js';
import { initStudentSchedulesSection, refreshStudentSchedules } from './student-schedules.js';
import {
    setupSidebarToggle,
    applyChartFontFromCSSVars,
    ensureAuth,
    setupLogout,
    setupModalClosures,
    updateUserName,
    createDashboardController,
} from '../shared/dashboard-kit.js';
import * as aiAssistant from '../shared/ai-assistant-redesign.js';

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
    if (!ensureAuth('teacher')) return;

    const userData = updateUserName({ elementId: 'teacherName', fallback: '教师' });
    toggleClassMasterNav(userData);

    if (window.ScheduleTypesStore) {
        await window.ScheduleTypesStore.init();
    }

    applyChartFontFromCSSVars();
    setupSidebarToggle({ storageKey: 'sidebarCollapsed' });
    setupLogout();
    setupModalClosures(['passwordChangeModal', 'studentEditModal', 'feeManagementModal']);

    // Init AI Assistant (右下角悬浮按钮，教师角色)
    aiAssistant.init({ role: 'teacher' });

    controller = createDashboardController({
        sectionInitializers: {
            overview: initOverviewSection,
            profile: initProfileSection,
            availability: initAvailabilitySection,
            schedules: initSchedulesSection,
            'teaching-display': initStatisticsSection,
            'student-schedules': initStudentSchedulesSection,
        },
        sectionRefreshers: {
            overview: loadOverview,
            profile: loadProfile,
            availability: refreshAvailability,
            schedules: refreshSchedules,
            'teaching-display': loadTeachingCount,
            'student-schedules': refreshStudentSchedules,
        },
        routeBase: '/teacher/dashboard',
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
    if (!window.eventBus || window.__teacherSyncSubscriptionsBound) return;
    window.__teacherSyncSubscriptionsBound = true;

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
            refreshVisibleSection('teaching-display', async () => {
                await Promise.allSettled([loadTeachingCount(), loadTeachingSummary()]);
            });
            refreshVisibleSection('student-schedules', refreshStudentSchedules);
        });
    });

    window.eventBus.on(window.EVENTS?.SCHEDULE_TYPE_CHANGED || 'scheduleType:changed', () => {
        refreshVisibleSection('schedules', refreshSchedules);
        refreshVisibleSection('teaching-display', async () => {
            await Promise.allSettled([loadTeachingCount(), loadTeachingSummary()]);
        });
        refreshVisibleSection('student-schedules', refreshStudentSchedules);
    });

    window.eventBus.on(window.EVENTS?.PROFILE_UPDATED || 'profile:updated', detail => {
        if (detail?.role && detail.role !== 'teacher') return;
        const userData = updateUserName({ elementId: 'teacherName', fallback: '教师' });
        toggleClassMasterNav(userData);
    });
}

function toggleClassMasterNav(userData) {
    const navStudentSchedules = document.getElementById('navStudentSchedules');
    if (!navStudentSchedules) return;
    if (userData && userData.student_ids && userData.student_ids.length > 0) {
        navStudentSchedules.style.display = 'flex';
    } else {
        navStudentSchedules.style.display = 'none';
    }
}
