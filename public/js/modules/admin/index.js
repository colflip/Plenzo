/**
 * Admin Modules Entry Point
 * @description 负责加载各个子模块并暴露到全局，以便与遗留的 admin.js 兼容
 */

import * as UserManager from './user-manager.js';
import * as ScheduleManager from './schedule-manager.js';
import * as UIHelper from './ui-helper.js';
import { StatisticsManager } from './statistics.js';
import * as Overview from './overview.js';
import * as UILayout from './ui-layout.js';
import * as ScheduleUtils from './schedule-utils.js';

// Expose modules globally
window.UserManager = UserManager;
window.ScheduleManager = ScheduleManager;
window.UIHelper = UIHelper;
window.StatisticsManager = StatisticsManager;
window.Overview = Overview;
window.UILayout = UILayout;
window.ScheduleUtils = ScheduleUtils;

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

// Provide global aliases for legacy-adapter.js to find them during transition
window.loadOverviewStats = Overview.loadOverviewStats;
window.showSection = UILayout.showSection;


// Expose functions globally for legacy inline event handlers (onclick="...")
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
    // openCellEditor is internal/not exported in manager, need to check if used in onclick
    // It is used in renderWeeklyBody -> onclick.

    // UI Helper
    adjustSelectMinWidth: UIHelper.adjustSelectMinWidth
};

Object.assign(window, globalExports);

// Initialize Listeners
document.addEventListener('DOMContentLoaded', () => {
    UserManager.setupUserEventListeners();
    ScheduleManager.setupScheduleEventListeners();
    UIHelper.setupSidebarToggle();

    // Init Statistics
    StatisticsManager.init();

    // 统一全局遮罩层点击关闭逻辑
    const overlay = document.getElementById('modalOverlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target !== overlay) return;
            // 关闭所有可能打开的 form-container 弹窗
            const containers = [
                'userFormContainer',
                'scheduleTypeFormContainer',
                'scheduleFormContainer'
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
