/**
 * 全局事件委托
 * @description 替代散落在 HTML / innerHTML 模板中的 onclick= 内联事件处理器，
 *              以满足 CSP（移除 script-src 'unsafe-inline'）要求。
 *              交互元素改用 data-action（+ 可选 data-* 参数）声明意图，由本模块统一分发。
 *              采用事件委托，天然兼容后续动态注入的 DOM（无需在每次渲染后重新绑定）。
 */
(function () {
    'use strict';
    if (window.__actionDelegateBound) return;
    window.__actionDelegateBound = true;

    document.addEventListener('click', function (e) {
        const target = e.target;
        const el = target && target.closest ? target.closest('[data-action]') : null;
        if (!el) return;
        const action = el.getAttribute('data-action');

        switch (action) {
            case 'toggle-teacher-show-plan':
                if (window.toggleTeacherShowPlan) window.toggleTeacherShowPlan();
                break;
            case 'toggle-teacher-student-show-plan':
                if (window.toggleTeacherStudentShowPlan) window.toggleTeacherStudentShowPlan();
                break;
            case 'export-teacher-students':
                if (window.exportTeacherStudents) window.exportTeacherStudents();
                break;
            case 'toggle-admin-show-plan':
                if (window.toggleAdminShowPlan) window.toggleAdminShowPlan();
                break;
            case 'toggle-availability':
                if (window.toggleAvailability) {
                    window.toggleAvailability(
                        el.getAttribute('data-id'),
                        el.getAttribute('data-date'),
                        el.getAttribute('data-period')
                    );
                }
                break;
            case 'toggle-student-availability':
                if (window.toggleStudentAvailability) {
                    window.toggleStudentAvailability(
                        el.getAttribute('data-id'),
                        el.getAttribute('data-date'),
                        el.getAttribute('data-period')
                    );
                }
                break;
            case 'init-teacher-availability':
                if (window.initTeacherAvailability) window.initTeacherAvailability();
                break;
            case 'save-teacher-availability':
                if (window.saveAvailabilityChanges) window.saveAvailabilityChanges();
                break;
            case 'cancel-teacher-availability':
                if (window.cancelAvailabilityChanges) window.cancelAvailabilityChanges();
                break;
            case 'save-student-availability':
                if (window.saveStudentAvailabilityChanges) window.saveStudentAvailabilityChanges();
                break;
            case 'cancel-student-availability':
                if (window.cancelStudentAvailabilityChanges) window.cancelStudentAvailabilityChanges();
                break;
            case 'reward-close': {
                const targetId = el.getAttribute('data-target');
                const modal = targetId
                    ? document.getElementById(targetId)
                    : (el.closest('.reward-modal-overlay') || el.closest('.reward-modal'));
                if (modal) modal.classList.remove('active');
                break;
            }
            case 'user-manager-load':
                if (window.UserManager && window.UserManager.loadUsers) {
                    window.UserManager.loadUsers(el.getAttribute('data-type'), { reset: true });
                }
                break;
            case 'toast':
                if (window.apiUtils && window.apiUtils.showToast) {
                    window.apiUtils.showToast(
                        el.getAttribute('data-toast-msg') || '',
                        el.getAttribute('data-toast-type') || 'info'
                    );
                }
                break;
        }
    });
})();
