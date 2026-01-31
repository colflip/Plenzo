import { initOverviewSection, loadOverview } from './overview.js';
import { initProfileSection } from './profile.js';
import { initAvailabilitySection, refreshAvailability } from './availability.js';
import { initSchedulesSection, refreshSchedules } from './schedules.js';
import { initStatisticsSection, loadLearningStats } from './statistics.js';

const sectionInitializers = {
    overview: initOverviewSection,
    profile: initProfileSection,
    availability: initAvailabilitySection,
    schedules: initSchedulesSection,
    'teaching-display': initStatisticsSection
};

const sectionRefreshers = {
    overview: loadOverview,
    availability: refreshAvailability,
    schedules: refreshSchedules,
    'teaching-display': loadLearningStats
};

const initializedSections = new Set();

// Ensure initDashboard is exposed to global scope
window.initDashboard = initDashboard;

document.addEventListener('DOMContentLoaded', () => {
    initDashboard().catch(error => {
        console.error('初始化学生仪表盘失败:', error);
    });
});

document.addEventListener('readystatechange', () => {
    if (document.readyState === 'complete') {
        window.initDashboard = initDashboard;
    }
});

export { initDashboard };

async function initDashboard() {
    if (!ensureAuth()) return;
    updateStudentName();

    // Initialize Stores
    if (window.ScheduleTypesStore) {
        await window.ScheduleTypesStore.init();
    }

    applyChartFontFromCSSVars();
    setupSidebarToggle();
    setupLogout();
    setupNavigation();
    await activateSection('overview');
}

function updateStudentName() {
    const userDataStr = localStorage.getItem('userData');
    if (userDataStr) {
        try {
            const userData = JSON.parse(userDataStr);
            const studentNameElement = document.getElementById('studentName');
            if (studentNameElement) {
                const name = userData.name || userData.username || '学生';
                studentNameElement.textContent = name;
            }
        } catch (error) {
            console.error('解析用户数据失败:', error);
        }
    }
}

function ensureAuth() {
    const token = localStorage.getItem('token');
    const userType = localStorage.getItem('userType');
    if (!token || userType !== 'student') {
        redirectToLogin();
        return false;
    }
    return true;
}

function redirectToLogin() {
    window.location.href = '/index.html';
}

function applyChartFontFromCSSVars() {
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

function setupSidebarToggle() {
    const sidebar = document.querySelector('.sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtns = document.querySelectorAll('.toggle-sidebar');
    const mobileMenuToggle = document.getElementById('mobileMenuToggle');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const navItems = document.querySelectorAll('.nav-item');

    if (!sidebar || !mainContent) return;

    // Desktop Toggle Logic
    const saveMenuState = (isCollapsed) => {
        try { localStorage.setItem('studentSidebarCollapsed', isCollapsed); } catch (_) { }
    };

    const loadMenuState = () => {
        const isCollapsed = localStorage.getItem('studentSidebarCollapsed') === 'true';
        if (isCollapsed) {
            sidebar.classList.add('collapsed');
            mainContent.classList.add('expanded');
        } else {
            sidebar.classList.remove('collapsed');
            mainContent.classList.remove('expanded');
        }
    };

    const toggleSidebar = () => {
        const isCollapsed = sidebar.classList.toggle('collapsed');
        mainContent.classList.toggle('expanded', isCollapsed);
        saveMenuState(isCollapsed);
    };

    toggleBtns.forEach(btn => btn.addEventListener('click', toggleSidebar));
    loadMenuState();

    // Mobile Menu Logic
    function openMobileSidebar() {
        sidebar.classList.add('mobile-open');
        if (sidebarOverlay) sidebarOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function closeMobileSidebar() {
        sidebar.classList.remove('mobile-open');
        if (sidebarOverlay) sidebarOverlay.classList.remove('active');
        document.body.style.overflow = '';
    }

    if (mobileMenuToggle) {
        mobileMenuToggle.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openMobileSidebar();
        });
    }

    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', (e) => {
            e.preventDefault();
            closeMobileSidebar();
        });
    }

    // Auto-close on nav item click (mobile only)
    navItems.forEach(navItem => {
        navItem.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                setTimeout(closeMobileSidebar, 200);
            }
        });
    });

    // Auto-close on resize to desktop
    let resizeTimer;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            if (window.innerWidth > 768) {
                closeMobileSidebar();
            }
        }, 250);
    });
}

function setupLogout() {
    const logoutBtn = document.getElementById('logout');
    if (!logoutBtn) return;
    logoutBtn.addEventListener('click', (event) => {
        event.preventDefault();
        localStorage.removeItem('token');
        localStorage.removeItem('userType');
        localStorage.removeItem('userData');
        redirectToLogin();
    });
}

function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');

    navItems.forEach((item) => {
        const sectionId = item.dataset.section;

        item.addEventListener('click', (event) => {
            event.preventDefault();

            if (!sectionId) return;

            activateSection(sectionId).catch(error => {
                console.error(`切换到模块 ${sectionId} 时出错:`, error);
            });
        });
    });
}

async function activateSection(sectionId) {
    const section = document.getElementById(sectionId);
    if (!section) return;

    document.querySelectorAll('.dashboard-section').forEach(node => {
        node.classList.toggle('active', node.id === sectionId);
    });

    document.querySelectorAll('.nav-item').forEach(node => {
        node.classList.toggle('active', node.dataset.section === sectionId);
    });

    updatePageTitle(sectionId);

    if (!initializedSections.has(sectionId)) {
        const initializer = sectionInitializers[sectionId];
        if (typeof initializer === 'function') {
            await initializer();
            initializedSections.add(sectionId);
        }
    } else {
        const refresher = sectionRefreshers[sectionId];
        if (typeof refresher === 'function') {
            await refresher();
        }
    }
}

function updatePageTitle(sectionId) {
    const titleEl = document.getElementById('pageTitle');
    const navText = document.querySelector(`[data-section="${sectionId}"] .nav-text`);
    if (titleEl && navText) {
        titleEl.textContent = navText.textContent;
    }
}
