/**
 * UI Helper Module
 * @description 处理管理控制台的通用UI逻辑
 */

/**
 * 调整下拉框最小宽度以适应内容
 */
export function adjustSelectMinWidth(selectEl) {
    if (!selectEl || !selectEl.options || selectEl.options.length === 0) return;
    const style = getComputedStyle(selectEl);
    const probe = document.createElement('span');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.style.whiteSpace = 'nowrap';
    probe.style.fontSize = style.fontSize;
    probe.style.fontFamily = style.fontFamily;
    document.body.appendChild(probe);
    let max = 0;
    Array.from(selectEl.options).forEach(opt => {
        probe.textContent = opt.text;
        const w = probe.offsetWidth + 20; // 预留箭头与内边距空间
        if (w > max) max = w;
    });
    probe.remove();
    if (max > 0) {
        const clamped = Math.max(80, Math.min(180, Math.ceil(max)));
        selectEl.style.width = 'auto';
        selectEl.style.minWidth = clamped + 'px';
        selectEl.style.maxWidth = '180px';
        // 高度与滚动处理
        selectEl.style.height = 'auto';
        selectEl.style.minHeight = '30px';
        selectEl.style.maxHeight = '200px';
        selectEl.style.overflow = 'auto';
    }
}

/**
 * 设置侧边栏切换逻辑
 */
export function setupSidebarToggle() {
    const sidebar = document.querySelector('.sidebar');
    const mainContent = document.querySelector('.main-content');
    const toggleBtns = document.querySelectorAll('.toggle-sidebar');
    const mobileMenuToggle = document.getElementById('mobileMenuToggle');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const navItems = document.querySelectorAll('.nav-item');

    if (!sidebar || !mainContent) return;

    // Desktop Toggle Logic
    const saveMenuState = (isCollapsed) => {
        try { localStorage.setItem('sidebarCollapsed', isCollapsed); } catch (_) { }
    };

    const loadMenuState = () => {
        const isCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';
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

/**
 * 设置头部标题
 */
export function setHeaderTitle(title) {
    const headerTitle = document.querySelector('.dashboard-header h2');
    if (headerTitle) headerTitle.textContent = title;
}

/**
 * 显示指定部分
 * @param {string} sectionId - 部分ID
 * @param {Function} [afterSwitchCallback] - 切换后的回调（用于加载数据）
 */
export function showSection(sectionId, afterSwitchCallback) {
    const sections = document.querySelectorAll('.dashboard-section');
    sections.forEach(section => {
        section.classList.remove('active');
    });

    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.classList.remove('active');
    });

    const sectionEl = document.getElementById(sectionId);
    if (sectionEl) sectionEl.classList.add('active');

    const navItem = document.querySelector(`[data-section="${sectionId}"]`);
    if (navItem) navItem.classList.add('active');

    if (afterSwitchCallback) {
        afterSwitchCallback(sectionId);
    }
}
