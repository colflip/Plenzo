/**
 * Dashboard Kit
 * @description 三端 (admin/teacher/student) 仪表盘的公共框架
 * 包含: 侧边栏切换、图表字体、鉴权、登出、模态框关闭、用户名显示、导航控制器
 */

/**
 * 侧边栏切换
 * @param {{storageKey?: string, autoCollapseOnLoad?: boolean, autoCollapseDelay?: number}} [opts]
 *  - storageKey: localStorage 键，默认 'sidebarCollapsed'
 *  - autoCollapseOnLoad: true 时每次进入/刷新都从展开过渡到收起，忽略偏好
 *  - autoCollapseDelay: 收起前停留毫秒数，默认 500
 */
export function setupSidebarToggle(opts = {}) {
    const {
        storageKey = 'sidebarCollapsed',
        autoCollapseOnLoad = true,
        autoCollapseDelay = 500,
    } = opts;

    const sidebar = document.querySelector('.sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtns = document.querySelectorAll('.toggle-sidebar');
    const mobileMenuToggle = document.getElementById('mobileMenuToggle');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const navItems = document.querySelectorAll('.nav-item');

    if (!sidebar || !mainContent) return;

    const saveMenuState = (isCollapsed) => {
        try { localStorage.setItem(storageKey, isCollapsed); } catch (_) {}
    };

    const applyCollapsed = (isCollapsed) => {
        sidebar.classList.toggle('collapsed', isCollapsed);
        mainContent.classList.toggle('expanded', isCollapsed);
    };

    if (autoCollapseOnLoad && window.innerWidth > 768) {
        applyCollapsed(false);
        // 用 setTimeout 而非 rAF：后台/不可见标签页会冻结 rAF，导致动画卡死
        setTimeout(() => applyCollapsed(true), autoCollapseDelay);
    } else {
        const isCollapsed = localStorage.getItem(storageKey) === 'true';
        applyCollapsed(isCollapsed);
    }

    const toggleSidebar = () => {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        mainContent.classList.toggle('expanded', isCollapsed);
        saveMenuState(isCollapsed);
    };
    toggleBtns.forEach(btn => btn.addEventListener('click', toggleSidebar));

    function openMobileSidebar() {
        sidebar.classList.add('mobile-open');
        if (sidebarOverlay) sidebarOverlay.classList.add('active');
        if (mobileMenuToggle) {
            mobileMenuToggle.classList.add('active');
            const icon = mobileMenuToggle.querySelector('.material-icons-round');
            if (icon) icon.textContent = 'close';
        }
        document.body.style.overflow = 'hidden';
    }

    function closeMobileSidebar() {
        sidebar.classList.remove('mobile-open');
        if (sidebarOverlay) sidebarOverlay.classList.remove('active');
        if (mobileMenuToggle) {
            mobileMenuToggle.classList.remove('active');
            const icon = mobileMenuToggle.querySelector('.material-icons-round');
            if (icon) icon.textContent = 'menu';
        }
        document.body.style.overflow = '';
    }

    if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', (e) => {
            e.preventDefault();
            const willOpen = !sidebar.classList.contains('mobile-open');
            if (willOpen) openMobileSidebar();
            else closeMobileSidebar();
        });
    }

    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', (e) => {
            e.preventDefault();
            closeMobileSidebar();
        });
    }

    navItems.forEach(navItem => {
        navItem.addEventListener('click', () => {
            if (window.innerWidth <= 768) closeMobileSidebar();
        });
    });

    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (window.innerWidth > 768) closeMobileSidebar();
        }, 250);
    });
}

/**
 * 从 CSS 变量同步 Chart.js 全局字体配置
 */
export function applyChartFontFromCSSVars() {
    if (typeof Chart === 'undefined') return;
    const root = document.documentElement;
    const getVar = (name, fallback) => {
        const val = getComputedStyle(root).getPropertyValue(name).trim();
        return val || fallback;
    };
    const defaultFamily = 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", "Apple Color Emoji", "Segoe UI Emoji"';
    Chart.defaults.font = Chart.defaults.font || {};
    Chart.defaults.font.family = getVar('--chart-font-family', getVar('--font-family-base', defaultFamily));
    const size = parseInt(getVar('--chart-font-size', '12'), 10);
    Chart.defaults.font.size = Number.isNaN(size) ? 12 : size;
    Chart.defaults.font.weight = getVar('--chart-font-weight', '500');
}

/**
 * 校验登录态及角色，未通过则跳登录页
 * @param {string} expectedUserType - 'admin' | 'teacher' | 'student'，传 null 表示只校验 token
 */
export function ensureAuth(expectedUserType = null) {
    const token = localStorage.getItem('token');
    const userType = localStorage.getItem('userType');
    if (!token) { redirectToLogin(); return false; }
    if (expectedUserType && userType !== expectedUserType) { redirectToLogin(); return false; }
    return true;
}

export function redirectToLogin() {
    window.location.href = '/index.html';
}

/**
 * 绑定登出按钮
 * @param {{buttonId?: string, useAuthUtils?: boolean}} [opts]
 *  - buttonId: 默认 'logout'
 *  - useAuthUtils: 优先调用 window.authUtils.logout (admin 端使用)
 */
export function setupLogout(opts = {}) {
    const { buttonId = 'logout', useAuthUtils = false } = opts;
    const logoutBtn = document.getElementById(buttonId);
    if (!logoutBtn) return;
    logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (useAuthUtils && window.authUtils && window.authUtils.logout) {
            window.authUtils.logout();
            return;
        }
        localStorage.removeItem('token');
        localStorage.removeItem('userType');
        localStorage.removeItem('userData');
        redirectToLogin();
    });
}

/**
 * 为多个模态框统一绑定背景点击关闭
 * @param {string[]} modalIds - 模态框元素 id 数组
 */
export function setupModalClosures(modalIds = []) {
    modalIds.forEach(id => {
        const modal = document.getElementById(id);
        if (!modal) return;
        modal.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal-overlay') || e.target === modal) {
                modal.style.display = 'none';
            }
        });
    });
}

/**
 * 从 localStorage.userData 读取并填充顶部用户名/角色
 * @param {{elementId: string, roleLabel?: string, withRoleSuffix?: boolean, fallback?: string}} opts
 *  - elementId: 显示用户名的 DOM id
 *  - roleLabel: 角色文字 (e.g. '教师')，仅在 withRoleSuffix 时使用
 *  - withRoleSuffix: true 时显示 "姓名/角色" (admin 风格)
 *  - fallback: userData 缺失时的默认昵称
 *  返回解析出来的 userData (供调用方做额外特殊处理)
 */
export function updateUserName(opts) {
    const { elementId, roleLabel, withRoleSuffix = false, fallback = '用户' } = opts;
    const userDataStr = localStorage.getItem('userData');
    if (!userDataStr) return null;
    let userData = null;
    try { userData = JSON.parse(userDataStr); } catch (_) { return null; }

    const el = document.getElementById(elementId);
    if (el) {
        const name = userData.name || userData.username || fallback;
        if (withRoleSuffix) {
            const type = userData.userType;
            let roleName = roleLabel || '未知';
            if (type === 'admin') roleName = '管理员';
            else if (type === 'teacher') roleName = '老师';
            else if (type === 'student') roleName = '学生';
            el.textContent = `${name}/${roleName}`;
        } else {
            el.textContent = name;
        }
    }
    return userData;
}

/**
 * 仪表盘控制器：统一处理 nav 点击、section 激活、首次初始化、刷新、标题更新
 *
 * @param {object} cfg
 *  - sectionInitializers: { [sectionId]: () => Promise<void>|void }  首次激活调用
 *  - sectionRefreshers:   { [sectionId]: () => Promise<void>|void }  再次激活调用
 *  - sectionTitles?:      { [sectionId]: string }                    可选静态标题映射 (admin 风格)
 *  - titleElementId?:     string                                     默认 'pageTitle'，admin 用 '.dashboard-header h2'
 *  - titleSelector?:      string                                     直接传 selector，优先级高于 titleElementId
 *  - onSectionShown?:     (sectionId) => void                        section DOM 切换完毕后的副作用钩子
 *  - onError?:            (err, sectionId) => void
 * @returns {{ activate: (sectionId: string) => Promise<void>, init: () => void }}
 */
export function createDashboardController(cfg) {
    const {
        sectionInitializers = {},
        sectionRefreshers = {},
        sectionTitles = null,
        titleElementId = 'pageTitle',
        titleSelector = null,
        onSectionShown = null,
        onError = null,
    } = cfg;

    const initialized = new Set();

    function updatePageTitle(sectionId) {
        let titleText = null;
        if (sectionTitles && sectionTitles[sectionId]) {
            titleText = sectionTitles[sectionId];
        } else {
            const navText = document.querySelector(`[data-section="${sectionId}"] .nav-text`);
            if (navText) titleText = navText.textContent;
        }
        if (!titleText) return;
        const titleEl = titleSelector
            ? document.querySelector(titleSelector)
            : document.getElementById(titleElementId);
        if (titleEl) titleEl.textContent = titleText;
    }

    async function activate(sectionId) {
        const section = document.getElementById(sectionId);
        if (!section) return;

        document.querySelectorAll('.dashboard-section').forEach(node => {
            node.classList.toggle('active', node.id === sectionId);
        });
        document.querySelectorAll('.nav-item').forEach(node => {
            node.classList.toggle('active', node.dataset.section === sectionId);
        });

        updatePageTitle(sectionId);

        try {
            if (!initialized.has(sectionId)) {
                const initer = sectionInitializers[sectionId];
                if (typeof initer === 'function') {
                    await initer();
                    initialized.add(sectionId);
                }
            } else {
                const refresher = sectionRefreshers[sectionId];
                if (typeof refresher === 'function') {
                    await refresher();
                }
            }
            if (typeof onSectionShown === 'function') onSectionShown(sectionId);
        } catch (err) {
            if (typeof onError === 'function') onError(err, sectionId);
        }
    }

    function init() {
        document.querySelectorAll('.nav-item').forEach(item => {
            const sectionId = item.dataset.section;
            if (!sectionId) return;
            item.addEventListener('click', (e) => {
                e.preventDefault();
                activate(sectionId).catch(err => {
                    if (typeof onError === 'function') onError(err, sectionId);
                });
            });
        });
    }

    return { activate, init };
}
