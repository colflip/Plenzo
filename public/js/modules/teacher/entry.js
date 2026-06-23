/**
 * 教师端主入口文件
 * @description 教师仪表盘初始化和导航逻辑
 * @module teacher
 */

import { initOverviewSection, loadOverview } from './overview.js';
import { initProfileSection } from './profile.js';
import { initAvailabilitySection, refreshAvailability } from './availability.js';
import { initSchedulesSection, refreshSchedules } from './schedules.js';
import { initStatisticsSection, loadTeachingCount } from './statistics.js';
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
            availability: refreshAvailability,
            schedules: refreshSchedules,
            'teaching-display': loadTeachingCount,
            'student-schedules': refreshStudentSchedules,
        },
    });
    controller.init();
    await controller.activate('overview');
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
