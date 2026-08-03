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
export function updateSessionUserData(profile, allowedFields = ['name', 'nickname']) {
    if (!profile || typeof profile !== 'object') return null;
    let current = {};
    try {
        current = JSON.parse(localStorage.getItem('userData') || '{}');
    } catch (_) {
        current = {};
    }
    allowedFields.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(profile, field)) current[field] = profile[field];
    });
    localStorage.setItem('userData', JSON.stringify(current));
    return current;
}

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
 *  - routeBase?:          string                                     仪表盘基础路径，如 '/teacher/dashboard'
 *  - fallbackSection?:    string                                     基础路径默认区块，默认 'overview'
 * @returns {{ activate: (sectionId: string) => Promise<void>, init: () => Promise<void> }}
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
        routeBase = null,
        fallbackSection = 'overview',
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

    function normalizeRouteBase(value) {
        if (!value) return null;
        const normalized = value.replace(/\.html(?=\/|$)/, '').replace(/\/$/, '');
        return normalized || '/';
    }

    function getSectionFromPath() {
        if (!routeBase) return fallbackSection;
        const base = normalizeRouteBase(routeBase);
        const pathname = window.location.pathname.replace(/\.html(?=\/|$)/, '').replace(/\/$/, '');
        if (pathname === base) return fallbackSection;
        if (!pathname.startsWith(`${base}/`)) return null;
        return decodeURIComponent(pathname.slice(base.length + 1));
    }

    function updateRoute(sectionId, replace = false) {
        if (!routeBase || !window.history) return;
        const base = normalizeRouteBase(routeBase);
        const targetPath = sectionId === fallbackSection ? base : `${base}/${encodeURIComponent(sectionId)}`;
        const currentPath = window.location.pathname.replace(/\.html(?=\/|$)/, '').replace(/\/$/, '');
        if (currentPath === targetPath) return;
        const method = replace ? 'replaceState' : 'pushState';
        window.history[method]({ sectionId }, '', `${targetPath}${window.location.search}${window.location.hash}`);
    }

    function showInvalidRouteFeedback() {
        const message = '页面路径无效，已返回总览。';
        if (window.toastManager && typeof window.toastManager.warning === 'function') {
            window.toastManager.warning(message);
        } else if (typeof window.showToast === 'function') {
            window.showToast(message, 'warning');
        }
    }

    function isValidSection(sectionId) {
        if (!sectionId || !document.getElementById(sectionId)) return false;
        return Array.from(document.querySelectorAll('.nav-item')).some(item => item.dataset.section === sectionId);
    }

    async function activateRouteSection(sectionId, { replace = false, showFeedback = false } = {}) {
        const validSection = isValidSection(sectionId) ? sectionId : fallbackSection;
        if (showFeedback && validSection !== sectionId) showInvalidRouteFeedback();
        updateRoute(validSection, replace || validSection !== sectionId);
        await activate(validSection);
    }

    async function init() {
        document.querySelectorAll('.nav-item').forEach(item => {
            const sectionId = item.dataset.section;
            if (!sectionId) return;
            if (routeBase) {
                const base = normalizeRouteBase(routeBase);
                item.href = sectionId === fallbackSection ? base : `${base}/${encodeURIComponent(sectionId)}`;
            }
            item.addEventListener('click', (e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                activateRouteSection(sectionId).catch(err => {
                    if (typeof onError === 'function') onError(err, sectionId);
                });
            });
        });

        if (routeBase) {
            window.addEventListener('popstate', () => {
                const sectionId = getSectionFromPath();
                activateRouteSection(sectionId, { replace: !isValidSection(sectionId), showFeedback: !isValidSection(sectionId) }).catch(err => {
                    if (typeof onError === 'function') onError(err, sectionId);
                });
            });
        }

        const initialSection = getSectionFromPath();
        await activateRouteSection(initialSection, {
            replace: !isValidSection(initialSection),
            showFeedback: !isValidSection(initialSection),
        });
    }

    return { activate: activateRouteSection, init };
}
