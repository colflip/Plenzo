/**
 * Admin Modules Entry Point
 * @description 负责加载各个子模块并暴露到全局，以便与遗留的 admin.js 兼容
 */

import * as UserManager from './user-manager.js';
import * as ScheduleManager from './schedule-manager.js';
import * as UIHelper from './ui-helper.js';
import { StatisticsManager } from './statistics.js';

// Expose modules globally
window.UserManager = UserManager;
window.ScheduleManager = ScheduleManager;
window.UIHelper = UIHelper;
window.StatisticsManager = StatisticsManager;


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

    // Initialize UI
    // loadUsers('admin'); // admin.js might already do this
});
