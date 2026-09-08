/**
 * 教师端主入口文件
 * @description 教师仪表盘初始化和导航逻辑
 * @module teacher
 */

// 统一加载视觉：先加载 shared/loading-ui.js，注册 window.LoadingUI / window.showTableLoading，
// 供 components/ 下的经典脚本（如 fee-manager.js）复用同一套 spinner。
import '../shared/loading-ui.js';

import { initOverviewSection, loadOverview } from './overview.js';
import { initProfileSection, loadProfile } from './profile.js';
import { initAvailabilitySection, refreshAvailability } from './availability.js?v=20260806-toggle';
import { initSchedulesSection, refreshSchedules } from './schedules.js?v=20260806-toggle';
import { initStatisticsSection, loadTeachingCount, loadTeachingSummary } from './statistics.js';
import { initStudentSchedulesSection, refreshStudentSchedules } from './student-schedules.js?v=20260806-toggle';
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
import { refreshVisibleSection } from '../shared/view-utils.js';

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

    // 课程类型字典与首屏数据并发拉：原来是 await 在前面，把 /admin/schedule-types
    // 和 /teacher/overview 串成了一条链（实测第一个请求 2736ms 才发出，overview 要到
    // 3826ms 才落地）。字典只影响标签文案，getLabel 本身有回退，晚到不会出错。
    const typesReady = window.ScheduleTypesStore
        ? window.ScheduleTypesStore.init().catch(() => {})
        : Promise.resolve();

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
            fees: mountTeacherFees,
            'sd-fees': mountTeacherHeadFees,
        },
        sectionRefreshers: {
            overview: loadOverview,
            profile: loadProfile,
            availability: refreshAvailability,
            schedules: refreshSchedules,
            'teaching-display': loadTeachingCount,
            'student-schedules': refreshStudentSchedules,
            fees: mountTeacherFees,
            'sd-fees': mountTeacherHeadFees,
        },
        routeBase: '/teacher/dashboard',
        onSectionShown: () => ensureStudentDataGroupOpen(),
    });
    await Promise.all([typesReady, controller.init()]);
    ensureStudentDataGroupOpen();
    setupDataSyncSubscriptions();
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

// ---- 统一费用管理挂载（教师端共用 FeeManager） -------------------------
function mountTeacherFees() {
    if (!window.FeeManager) return;
    window.FeeManager.mount({
        mountSelector: '#teacherFeeManagerMount',
        role: 'teacher',
        listEndpoint: '/teacher/schedules',
        saveMode: 'single',
        feeEndpoint: (id) => `/teacher/schedules/${id}/fees`,
        feeStatusBase: '/teacher/schedules',
        canEditFeeStatus: false,
        enableBatchFeeStatus: false,
        feeStatusFilter: false,
        exportContextKey: 'teacher-fees',
        fetchWeekSchedules: (s, e) => window.apiUtils.get('/teacher/schedules', { startDate: s, endDate: e, show_plan: true }),
    });
}

function mountTeacherHeadFees() {
    if (!window.FeeManager) return;
    window.FeeManager.mount({
        mountSelector: '#teacherHeadFeeManagerMount',
        role: 'headteacher',
        listEndpoint: '/teacher/student-schedules',
        saveMode: 'batch',
        batchEndpoint: '/teacher/batch-fees',
        feeStatusBase: '/teacher/schedules',
        canEditFeeStatus: true,
        enableBatchFeeStatus: true,
        feeStatusFilter: true,
        exportContextKey: 'teacher-head-fees',
        fetchWeekSchedules: (s, e) => window.apiUtils.get('/teacher/student-schedules', { startDate: s, endDate: e, show_plan: true }),
    });
}

// ---- 学生数据管理分组（二级菜单）展开/收起 ----------------------------
function setupStudentDataSubmenu() {
    if (window.__sdSubmenuBound) return;
    window.__sdSubmenuBound = true;
    const group = document.getElementById('navStudentDataGroup');
    const header = document.getElementById('navStudentDataHeader');
    const chevron = header?.querySelector('.nav-group-chevron');
    if (!group || !header) return;

    const updateChevron = () => {
        if (chevron) chevron.textContent = group.classList.contains('collapsed') ? 'chevron_right' : 'expand_more';
    };

    header.addEventListener('click', (e) => {
        e.preventDefault();
        group.classList.toggle('collapsed');
        updateChevron();
    });
    group.querySelectorAll('.nav-subitem').forEach(item => {
        item.addEventListener('click', () => {
            group.classList.remove('collapsed');
            updateChevron();
        });
    });
    updateChevron();
}

function ensureStudentDataGroupOpen() {
    const group = document.getElementById('navStudentDataGroup');
    const header = document.getElementById('navStudentDataHeader');
    const chevron = header?.querySelector('.nav-group-chevron');
    if (!group) return;
    const hasActive = !!group.querySelector('.nav-subitem.active');
    group.classList.toggle('has-active', hasActive);
    if (hasActive) {
        group.classList.remove('collapsed');
        if (chevron) chevron.textContent = 'expand_more';
    }
}

function toggleClassMasterNav(userData) {
    const group = document.getElementById('navStudentDataGroup');
    const collapsedItems = document.querySelectorAll('.class-master-collapsed-item');
    const shouldShow = !!(userData && userData.student_ids && userData.student_ids.length > 0);
    if (group) {
        group.style.display = shouldShow ? '' : 'none';
    }
    collapsedItems.forEach(item => {
        item.style.display = shouldShow ? '' : 'none';
    });
    setupStudentDataSubmenu();
}
