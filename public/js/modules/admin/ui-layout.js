/**
 * UI Layout Module
 * 处理页面的导航和区块切换逻辑
 */

// 设置导航
export function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', (e) => {
            e.preventDefault();
            // 使用 currentTarget 确保点击图标/文字也能正确读到 data-section
            const section = e.currentTarget.dataset.section;
            if (section) {
                // 数据加载由 showSection 统一在切换可见区后触发（非阻塞）。
                // 关键：此处不要 await 任何数据请求，否则区块还是 display:none 时
                // 就会卡在网络请求上，导致“点击没反应/要等很久才跳转”，且会重复加载。
                showSection(section);
            }
        });
    });

    const logoutBtn = document.getElementById('logout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (window.authUtils && window.authUtils.logout) {
                window.authUtils.logout();
            } else if (window.logout) {
                window.logout();
            }
        });
    }

    setupSettingsTabs();
    setupAvailabilityTabs();
}

// 空闲时段管理：二级 tab 切换（学生 / 教师）
function activateAvailabilityView(viewId) {
    const section = document.getElementById('availability-mgmt');
    if (!section) return;

    section.querySelectorAll('.statistics-tabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.availabilityView === viewId);
    });
    section.querySelectorAll('.availability-view').forEach(view => {
        view.classList.toggle('active', view.id === viewId);
    });
    section.querySelectorAll('.availability-date-nav').forEach(nav => {
        nav.classList.toggle('active', nav.dataset.dateFor === viewId);
    });
}

export function setupAvailabilityTabs() {
    const section = document.getElementById('availability-mgmt');
    if (!section) return;

    const tabs = section.querySelectorAll('.statistics-tabs .tab-btn');
    tabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const viewId = btn.dataset.availabilityView;
            if (!viewId) return;
            activateAvailabilityView(viewId);

            if (viewId === 'student-availability-view') {
                if (window.initStudentAvailability) window.initStudentAvailability();
                if (window.initStudentScheduleFees) window.initStudentScheduleFees();
            } else if (viewId === 'teacher-availability-view') {
                if (window.initTeacherAvailability) window.initTeacherAvailability();
            }
        });
    });
}

// 系统设置：二级 tab 切换（课程类型 / 节假日管理）
function activateSettingsView(viewId) {
    const section = document.getElementById('system-settings');
    if (!section) return;

    section.querySelectorAll('.statistics-tabs .tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.settingsView === viewId);
    });
    section.querySelectorAll('.settings-view').forEach(view => {
        view.classList.toggle('active', view.id === viewId);
    });
    section.querySelectorAll('.settings-view-actions').forEach(group => {
        group.classList.toggle('active', group.dataset.actionsFor === viewId);
    });
}

export function setupSettingsTabs() {
    const section = document.getElementById('system-settings');
    if (!section) return;

    const tabs = section.querySelectorAll('.statistics-tabs .tab-btn');
    tabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const viewId = btn.dataset.settingsView;
            if (!viewId) return;
            activateSettingsView(viewId);

            if (viewId === 'schedule-types-view') {
                if (window.loadScheduleTypes) window.loadScheduleTypes();
            } else if (viewId === 'holiday-config-view') {
                if (window.loadHolidays) window.loadHolidays();
            } else if (viewId === 'feedback-view') {
                if (window.loadFeedbacks) window.loadFeedbacks();
            }
        });
    });
}

// 显示指定部分
export function showSection(sectionId) {
    const sections = document.querySelectorAll('.dashboard-section');
    sections.forEach(section => {
        section.classList.remove('active');
    });

    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.classList.remove('active');
    });

    const targetSection = document.getElementById(sectionId);
    if (targetSection) targetSection.classList.add('active');
    const targetNav = document.querySelector(`[data-section="${sectionId}"]`);
    if (targetNav) targetNav.classList.add('active');

    // 加载部分特定数据
    switch (sectionId) {
        case 'overview':
            if (window.loadOverviewStats) window.loadOverviewStats();
            setHeaderTitle('管理员总览');
            break;
        case 'users':
            setHeaderTitle('用户管理');
            // 立即激活 Tab 样式（教师 Tab 默认激活）
            const teacherTabForSection = document.querySelector('#userRoleTabs .tab-btn[data-type="teacher"]');
            if (teacherTabForSection) {
                const allTabs = document.querySelectorAll('#userRoleTabs .tab-btn');
                allTabs.forEach(t => t.classList.remove('active'));
                teacherTabForSection.classList.add('active');
            }
            // 首次加载使用 reset: true 确保完整加载
            if (window.UserManager && window.UserManager.loadUsers) window.UserManager.loadUsers('teacher', { reset: true });
            else if (window.loadUsers) window.loadUsers('teacher', { reset: true });
            break;
        case 'schedule':
            if (window.ScheduleManager && window.ScheduleManager.loadSchedules) window.ScheduleManager.loadSchedules();
            else if (window.loadSchedules) window.loadSchedules();
            setHeaderTitle('排课管理');
            break;
        case 'statistics':
            // 延迟初始化统计模块（仅在首次访问时执行）
            if (window.ensureStatisticsInitialized) window.ensureStatisticsInitialized();
            if (window.loadStatistics) window.loadStatistics();
            setHeaderTitle('数据统计');
            break;
        case 'schedule-types':
            if (window.loadScheduleTypes) window.loadScheduleTypes();
            setHeaderTitle('课程类型管理');
            break;
        case 'system-settings':
            setHeaderTitle('系统设置');
            // 默认激活课程类型子视图并加载其数据
            activateSettingsView('schedule-types-view');
            if (window.loadScheduleTypes) window.loadScheduleTypes();
            break;
        case 'availability-mgmt': {
            const section = document.getElementById('availability-mgmt');
            const activeBtn = section?.querySelector('.statistics-tabs .tab-btn.active');
            const activeView = activeBtn?.dataset.availabilityView || 'student-availability-view';
            activateAvailabilityView(activeView);
            if (activeView === 'teacher-availability-view') {
                if (window.initTeacherAvailability) window.initTeacherAvailability();
            } else {
                if (window.initStudentAvailability) window.initStudentAvailability();
                if (window.initStudentScheduleFees) window.initStudentScheduleFees();
            }
            setHeaderTitle('空闲时段管理');
            break;
        }
        case 'student-availability':
            if (window.initStudentAvailability) {
                window.initStudentAvailability();
            }
            if (window.initStudentScheduleFees) {
                window.initStudentScheduleFees();
            }
            setHeaderTitle('学生空闲时段');
            break;
        case 'availability':
            if (window.initTeacherAvailability) {
                window.initTeacherAvailability();
            }
            setHeaderTitle('教师空闲时段');
            break;
    }
}

// 设置头部标题
export function setHeaderTitle(title) {
    // Also available in ui-helper.js, duplicated here temporarily for smooth transition
    const headerTitle = document.querySelector('.dashboard-header h2');
    if (headerTitle) headerTitle.textContent = title;
}

// --- Extracted from legacy-adapter.js ---
export function showToast(message, type = 'info') {
    // 创建toast元素
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    // 添加样式
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.right = '20px';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '4px';
    toast.style.color = '#fff';
    toast.style.zIndex = '100002';
    toast.style.opacity = '0.9';
    toast.style.transition = 'opacity 0.3s';

    // 根据类型设置背景色
    switch (type) {
        case 'success':
            toast.style.backgroundColor = '#4CAF50';
            break;
        case 'error':
            toast.style.backgroundColor = '#F44336';
            break;
        case 'warning':
            toast.style.backgroundColor = '#FF9800';
            break;
        default:
            toast.style.backgroundColor = '#2196F3';
    }

    // 添加到页面
    document.body.appendChild(toast);

    // 3秒后自动消失
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => {
            if (document.body.contains(toast)) {
                document.body.removeChild(toast);
            }
        }, 300);
    }, 3000);

    return toast;
}

// Global exposure
window.showToast = showToast;
