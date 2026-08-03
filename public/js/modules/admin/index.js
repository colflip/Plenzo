/**
 * Admin Modules Entry Point
 * @description 负责加载各个子模块并暴露到全局，以便与遗留的 admin.js 兼容
 */

import * as UserManager from './user-manager.js';
import * as ScheduleManager from './schedule-manager.js';
import * as UIHelper from './ui-helper.js';
import * as Overview from './overview.js';
import * as UILayout from './ui-layout.js';
import * as ScheduleUtils from './schedule-utils.js';
import * as HolidayManager from './holiday-manager.js';
import * as FeedbackManager from './feedback-manager.js';
import * as aiAssistant from '../shared/ai-assistant-redesign.js';

// Expose modules globally
window.UserManager = UserManager;
window.ScheduleManager = ScheduleManager;
window.UIHelper = UIHelper;
window.Overview = Overview;
window.UILayout = UILayout;
window.ScheduleUtils = ScheduleUtils;
window.HolidayManager = HolidayManager;
window.FeedbackManager = FeedbackManager;

// Aliases for legacy-adapter.js
window.normalizeScheduleRows = ScheduleUtils.normalizeScheduleRows;
window.sanitizeTimeString = ScheduleUtils.sanitizeTimeString;
window.hhmmToMinutes = ScheduleUtils.hhmmToMinutes;
window.minutesToHHMM = ScheduleUtils.minutesToHHMM;
window.computeSlotByStartMin = ScheduleUtils.computeSlotByStartMin;
window.clusterByOverlap = ScheduleUtils.clusterByOverlap;
window.buildMergedRowText = ScheduleUtils.buildMergedRowText;
window.updateScheduleStatus = ScheduleUtils.updateScheduleStatus;
window.renderWeeklyLoading = ScheduleUtils.renderWeeklyLoading;
window.renderWeeklyError = ScheduleUtils.renderWeeklyError;

// Provide global aliases for legacy-adapter.js
window.loadOverviewStats = Overview.loadOverviewStats;
window.showSection = UILayout.showSection;


// Expose functions globally for legacy inline event handlers
const globalExports = {
    // User Manager
    loadUsers: UserManager.loadUsers,
    showAddUserModal: UserManager.showAddUserModal,
    showEditUserModal: UserManager.showEditUserModal,
    closeUserFormModal: UserManager.closeUserFormModal,
    deleteUser: UserManager.deleteUser,

    // Schedule Manager
    loadSchedules: ScheduleManager.loadSchedules,
    updateScheduleStatus: ScheduleManager.updateScheduleStatus,

    // UI Helper
    adjustSelectMinWidth: UIHelper.adjustSelectMinWidth,

    // Holiday Manager
    openHolidayForm: HolidayManager.openHolidayForm,
    closeHolidayForm: HolidayManager.closeHolidayForm,
    loadHolidays: HolidayManager.loadHolidays,

    // Feedback Manager
    openFeedbackForm: FeedbackManager.openFeedbackForm,
    closeFeedbackForm: FeedbackManager.closeFeedbackForm,
    loadFeedbacks: FeedbackManager.loadFeedbacks,
};

Object.assign(window, globalExports);

function refreshAdminSection(sectionId, refresher) {
    const section = document.getElementById(sectionId);
    if (section?.classList.contains('active')) {
        Promise.resolve(refresher()).catch(() => {});
    }
}

function setupDataSyncSubscriptions() {
    if (!window.eventBus || window.__adminSyncSubscriptionsBound) return;
    window.__adminSyncSubscriptionsBound = true;

    const scheduleEvents = [
        window.EVENTS?.SCHEDULE_CREATED || 'schedule:created',
        window.EVENTS?.SCHEDULE_UPDATED || 'schedule:updated',
        window.EVENTS?.SCHEDULE_DELETED || 'schedule:deleted',
        window.EVENTS?.SCHEDULE_STATUS_CHANGED || 'schedule:statusChanged'
    ];
    scheduleEvents.forEach(eventName => {
        window.eventBus.on(eventName, () => {
            refreshAdminSection('overview', Overview.loadOverviewStats);
            refreshAdminSection('schedule', () => ScheduleManager.loadSchedules(true, false));
            refreshAdminSection('statistics', () => window.loadStatistics?.());
        });
    });

    window.eventBus.on(window.EVENTS?.USER_CHANGED || 'user:changed', detail => {
        if (detail?.action === 'invalidate') return;
        refreshAdminSection('overview', Overview.loadOverviewStats);
        const activeType = window.__usersState?.type || detail?.type;
        if (activeType && detail?.type === activeType) {
            refreshAdminSection('users', () => UserManager.loadUsers(activeType, { reset: true }));
        }
    });

    window.eventBus.on(window.EVENTS?.SCHEDULE_TYPE_CHANGED || 'scheduleType:changed', () => {
        refreshAdminSection('schedule', () => ScheduleManager.loadSchedules(false, false));
        refreshAdminSection('statistics', () => window.loadStatistics?.());
    });
}

// Initialize Listeners
document.addEventListener('DOMContentLoaded', () => {
    UserManager.setupUserEventListeners();
    ScheduleManager.setupScheduleEventListeners();
    UIHelper.setupSidebarToggle();
    HolidayManager.setupHolidayEventListeners();
    FeedbackManager.setupFeedbackEventListeners();

    // Init AI Assistant (右下角悬浮按钮)
    aiAssistant.init({ role: 'admin' });
    setupDataSyncSubscriptions();

    // Init AI Models Manager
    if (typeof initAIModelsManager === 'function') {
        initAIModelsManager();
    }

    // 统一全局遮罩层点击关闭逻辑
    const overlay = document.getElementById('modalOverlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target !== overlay) return;
            const containers = [
                'userFormContainer',
                'scheduleTypeFormContainer',
                'scheduleFormContainer',
                'holidayFormContainer',
                'feedbackFormContainer',
                'aiModelFormContainer'
            ];
            containers.forEach(id => {
                const el = document.getElementById(id);
                if (el && el.style.display !== 'none') {
                    el.style.display = 'none';
                }
            });
            overlay.style.display = 'none';
        });
    }
});
