/**
 * 学生端主入口文件
 * @module student
 */

// 统一加载视觉：先加载 shared/loading-ui.js，注册 window.LoadingUI / window.showTableLoading，
// 供 components/ 下的经典脚本（如 fee-manager.js）复用同一套 spinner。
import '../shared/loading-ui.js';

import { createErrorState } from '../shared/error-ui.js';
import { initOverviewSection, loadOverview } from './overview.js';
import { initProfileSection, loadProfile } from './profile.js';
import { initAvailabilitySection, refreshAvailability } from './availability.js?v=20260806-toggle';
import { initSchedulesSection, refreshSchedules } from './schedules.js?v=20260806-toggle';
import { initStatisticsSection, loadLearningStats } from './statistics.js';
import * as aiAssistant from '../shared/ai-assistant-redesign.js';
import { refreshVisibleSection } from '../shared/view-utils.js';
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
    initDashboard().catch(error => renderDashboardInitError(error));
});

document.addEventListener('readystatechange', () => {
    if (document.readyState === 'complete') {
        window.initDashboard = initDashboard;
    }
});

export { initDashboard };

function renderDashboardInitError(error, sectionId, { initial = true } = {}) {
    console.error(initial ? '学生仪表盘初始化失败:' : '学生仪表盘区块刷新失败:', error);
    const container = initial
        ? document.querySelector('.content-area')
        : document.getElementById(sectionId);
    if (!container) return;
    container.replaceChildren(createErrorState({
        error,
        title: initial ? '学生仪表盘加载失败' : '当前内容刷新失败',
        page: initial,
        onRetry: initial
            ? () => window.location.reload()
            : () => controller?.activate(sectionId),
        retryText: initial ? '重新加载' : '重试'
    }));
}

async function initDashboard() {
    if (!ensureAuth('student')) return;

    updateUserName({ elementId: 'studentName', fallback: '学生' });

    // 课程类型字典与首屏数据并发拉：原来是 await 在前面，把 /admin/schedule-types
    // 和 /student/overview 串成了一条链（实测第一个请求 1343ms 才发出，overview 要到 2151ms
    // 才落地）。字典只影响标签文案，getLabel 本身有回退，晚到不会出错。
    const typesReady = window.ScheduleTypesStore
        ? window.ScheduleTypesStore.init().catch(error => {
            console.error('课程类型加载失败:', error);
            window.Toast?.warning('课程类型加载失败，部分标签可能不是最新');
        })
        : Promise.resolve();

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
        onError: renderDashboardInitError,
    });
    await Promise.all([typesReady, controller.init()]);
    setupDataSyncSubscriptions();
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
