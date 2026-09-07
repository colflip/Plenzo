/**
 * UI Layout Module
 * 处理页面的导航和区块切换逻辑
 */

const ADMIN_ROUTE_BASE = '/admin/dashboard';
const DEFAULT_SECTION = 'overview';

function normalizePath(pathname) {
    return pathname.replace(/\.html(?=\/|$)/, '').replace(/\/$/, '') || '/';
}

function isValidSection(sectionId) {
    if (!sectionId || !document.getElementById(sectionId)) return false;
    return Array.from(document.querySelectorAll('.nav-item')).some(item => item.dataset.section === sectionId);
}

// 权限落地（Phase 2）：区块是否对当前级别开放（users 仅 L2+，system-settings 仅 L1）
function sectionAllowed(sectionId) {
    if (window.permissionUtils && typeof window.permissionUtils.canSeeSection === 'function') {
        return window.permissionUtils.canSeeSection(sectionId);
    }
    return true;
}

function sectionFromLocation() {
    const pathname = normalizePath(window.location.pathname);
    if (pathname === ADMIN_ROUTE_BASE) return DEFAULT_SECTION;
    if (!pathname.startsWith(`${ADMIN_ROUTE_BASE}/`)) return null;
    return decodeURIComponent(pathname.slice(ADMIN_ROUTE_BASE.length + 1));
}

function routeForSection(sectionId) {
    return sectionId === DEFAULT_SECTION
        ? ADMIN_ROUTE_BASE
        : `${ADMIN_ROUTE_BASE}/${encodeURIComponent(sectionId)}`;
}

function showInvalidRouteFeedback() {
    showToast('页面路径无效，已返回总览。', 'warning');
}

function activateFromLocation({ replace = false, showFeedback = false } = {}) {
    const requestedSection = sectionFromLocation();
    // 权限守卫：直达 URL 指向越权区块时，提示并回落总览
    if (requestedSection && isValidSection(requestedSection) && !sectionAllowed(requestedSection)) {
        showToast('权限级别不足，已返回总览。', 'warning');
        const fallback = DEFAULT_SECTION;
        if ((replace || window.history) && window.history) {
            window.history.replaceState({ sectionId: fallback }, '', routeForSection(fallback));
        }
        showSection(fallback);
        return;
    }
    const sectionId = isValidSection(requestedSection) ? requestedSection : DEFAULT_SECTION;
    if (showFeedback && sectionId !== requestedSection) showInvalidRouteFeedback();
    if ((replace || sectionId !== requestedSection) && window.history) {
        window.history.replaceState({ sectionId }, '', routeForSection(sectionId));
    }
    showSection(sectionId);
}

// 设置导航
export function setupNavigation() {
    // 权限落地（Phase 2）：按 data-min-level 隐藏越权导航项与功能按钮
    if (window.permissionUtils && typeof window.permissionUtils.applyPermissionGating === 'function') {
        window.permissionUtils.applyPermissionGating(document);
    }
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        const section = item.dataset.section;
        if (section) item.href = routeForSection(section);
        item.addEventListener('click', (e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            // 使用 currentTarget 确保点击图标/文字也能正确读到 data-section
            const targetSection = e.currentTarget.dataset.section;
            if (!isValidSection(targetSection)) return;
            if (window.history) {
                window.history.pushState({ sectionId: targetSection }, '', routeForSection(targetSection));
            }
            // 数据加载由 showSection 统一在切换可见区后触发（非阻塞）。
            showSection(targetSection);
        });
    });

    window.addEventListener('popstate', () => activateFromLocation({ showFeedback: true }));
    activateFromLocation({ replace: true, showFeedback: true });

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

// 权限落地（Phase 3）：L3 在数据范围受限的区块标题旁显示徽章
const SCOPED_SECTIONS = new Set(['overview', 'schedule', 'finance', 'statistics', 'availability-mgmt']);

function applyScopeBadge(sectionId) {
    const headerTitle = document.querySelector('.dashboard-header h2');
    if (!headerTitle) return;
    const stale = headerTitle.parentElement.querySelector('.scope-badge');
    if (stale) stale.remove();
    if (!SCOPED_SECTIONS.has(sectionId)) return;
    if (!window.permissionUtils || typeof window.permissionUtils.getLevel !== 'function') return;
    if (window.permissionUtils.getLevel() !== 3) return;
    const badge = document.createElement('span');
    badge.className = 'scope-badge';
    badge.textContent = '范围：我创建的排课';
    badge.style.cssText = 'display:inline-block;margin-left:10px;padding:2px 10px;font-size: var(--fs-300);font-weight:400;border-radius:999px;background:#e0f2fe;color:#0369a1;vertical-align:middle;';
    headerTitle.insertAdjacentElement('afterend', badge);
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
            if (window.loadTodaySchedules) window.loadTodaySchedules();
            setHeaderTitle('管理员总览');
            break;
        case 'users': {
            setHeaderTitle('用户管理');
            // 权限落地（Phase 3）：L2 只读横幅提示
            const readonlyBanner = document.getElementById('usersReadonlyBanner');
            if (readonlyBanner) {
                const isSuper = !window.permissionUtils || window.permissionUtils.isSuperAdmin();
                readonlyBanner.style.display = isSuper ? 'none' : 'block';
            }
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
        }
        case 'schedule':
            if (window.ScheduleManager && window.ScheduleManager.loadSchedules) window.ScheduleManager.loadSchedules();
            else if (window.loadSchedules) window.loadSchedules();
            setHeaderTitle('排课管理');
            break;
        case 'finance':
            if (window.FeeManager) {
                window.FeeManager.mount({
                    mountSelector: '#feeManagerMount',
                    role: 'admin',
                    listEndpoint: '/admin/schedules',
                    saveMode: 'single',
                    feeEndpoint: (id) => `/admin/schedules/${id}/fees`,
                    feeStatusBase: '/admin/schedules',
                    canEditFeeStatus: true,
                    enableBatchFeeStatus: true,
                    feeStatusFilter: true,
                    exportContextKey: 'admin',
                    fetchWeekSchedules: (s, e) => window.apiUtils.get('/admin/schedules', { startDate: s, endDate: e, show_plan: true }),
                });
            }
            setHeaderTitle('费用管理');
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
            }
            setHeaderTitle('空闲时段管理');
            break;
        }
        case 'student-availability':
            if (window.initStudentAvailability) {
                window.initStudentAvailability();
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

    // 权限落地（Phase 3）：切换区块后刷新范围徽章
    applyScopeBadge(sectionId);
}

// 设置头部标题
export function setHeaderTitle(title) {
    // Also available in ui-helper.js, duplicated here temporarily for smooth transition
    const headerTitle = document.querySelector('.dashboard-header h2');
    if (headerTitle) headerTitle.textContent = title;
}

// --- Extracted from legacy-adapter.js ---
/**
 * 显示Toast提示（委托到统一 Toast 组件，带安全防护）
 * @param {string} message - 消息
 * @param {string} [type='info'] - 类型
 * @param {number} [duration] - 持续时间(ms)
 */
export function showToast(message, type = 'info', duration) {
    if (window.Toast && typeof window.Toast.show === 'function') {
        return window.Toast.show(message, { type, duration });
    }
    // Toast 组件尚未加载时的临时兜底
    setTimeout(() => {
        if (window.Toast) window.Toast.show(message, { type, duration });
    }, 200);
}

// Global exposure
window.showToast = showToast;
