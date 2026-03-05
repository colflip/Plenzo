/**
 * UI Layout Module
 * 处理页面的导航和区块切换逻辑
 */

// 设置导航
export function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            // 使用 currentTarget 确保点击图标/文字也能正确读到 data-section
            const section = e.currentTarget.dataset.section;
            if (section) {
                // 先刷新对应数据，再进入功能区域
                try {
                    if (section === 'overview') {
                        if (window.loadOverviewStats) await window.loadOverviewStats();
                    } else if (section === 'users') {
                        // Default to teacher view per request
                        const teacherTab = document.querySelector('#userRoleTabs .tab-btn[data-type="teacher"]');
                        if (teacherTab) {
                            const tabs = document.querySelectorAll('#userRoleTabs .tab-btn');
                            tabs.forEach(t => t.classList.remove('active'));
                            teacherTab.classList.add('active');
                        }
                        if (window.UserManager && window.UserManager.loadUsers) await window.UserManager.loadUsers('teacher', { reset: true });
                        else if (window.loadUsers) await window.loadUsers('teacher', { reset: true });
                    } else if (section === 'schedule') {
                        if (window.ScheduleManager && window.ScheduleManager.loadSchedules) await window.ScheduleManager.loadSchedules();
                        else if (window.loadSchedules) await window.loadSchedules();
                    } else if (section === 'statistics') {
                        // handled by showSection -> loadStatistics
                    } else if (section === 'availability') {
                        if (window.initTeacherAvailability) window.initTeacherAvailability();
                    } else if (section === 'student-availability') {
                        if (window.initStudentAvailability) {
                            window.initStudentAvailability();
                        } else {
                            
                        }
                        if (window.initStudentScheduleFees) {
                            window.initStudentScheduleFees();
                        }
                    }
                } catch (_) { }
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
            // 默认加载教师视图
            const teacherTabForSection = document.querySelector('#userRoleTabs .tab-btn[data-type="teacher"]');
            if (teacherTabForSection) {
                const allTabs = document.querySelectorAll('#userRoleTabs .tab-btn');
                allTabs.forEach(t => t.classList.remove('active'));
                teacherTabForSection.classList.add('active');
            }
            if (window.UserManager && window.UserManager.loadUsers) window.UserManager.loadUsers('teacher');
            else if (window.loadUsers) window.loadUsers('teacher');
            setHeaderTitle('用户管理');
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
    toast.style.zIndex = '9999';
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
