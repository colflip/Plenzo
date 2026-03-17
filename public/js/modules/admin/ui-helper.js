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
            // 关键：不再阻断冒泡，但确保逻辑独立
            const willOpen = !sidebar.classList.contains('mobile-open');
            if (willOpen) {
                openMobileSidebar();
            } else {
                closeMobileSidebar();
            }
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
                // 点击菜单项后立即响应关闭，增加用户体验流畅度
                closeMobileSidebar();
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
/**
 * 显示表格加载动画（保留表头直接显示）
 * @param {HTMLElement} container - 表格的父容器（.table-container 或 .stats-unified-card）
 * @param {string} [text] - 加载显示的文本
 */
export function showTableLoading(container, text = '正在加载数据...', targetSelector = 'thead') {
    if (!container) return;

    // 针对不同模块的容器结构进行适配
    // 1. 数据统计模块的容器可能是 .stats-unified-card
    // 2. 传统列表模块的容器是 .table-container
    const isStatsUnified = container.classList.contains('stats-unified-card');
    
    // 确保容器是相对定位
    const containerStyle = window.getComputedStyle(container);
    if (containerStyle.position === 'static') {
        container.style.position = 'relative';
    }


    // 查找已有的遮罩，避免重复
    if (container.querySelector('.stats-loading-overlay')) return;

    // 计算 top 偏移量（精确避开表头或查询区）
    const containerRect = container.getBoundingClientRect();
    const table = container.querySelector('table');
    
    // 多级边界探测逻辑：确保动画精准避开各模块高度不一的标题行
    let topOffset = 0;
    
    // 优先级1：探测指定的选择器 (通常是 thead)
    const targetElement = container.querySelector(targetSelector);
    if (targetElement && targetElement.offsetHeight > 0) {
        const targetRect = targetElement.getBoundingClientRect();
        topOffset = Math.max(0, Math.floor(targetRect.bottom - containerRect.top));
    } 
    // 优先级1.5：针对没有 thead 的模块，尝试探测查询过滤区 (.query-section)
    else {
        const querySection = container.querySelector('.query-section');
        if (querySection && querySection.offsetHeight > 0) {
            const queryRect = querySection.getBoundingClientRect();
            topOffset = Math.max(0, Math.floor(queryRect.bottom - containerRect.top));
        }
    }

    // 优先级2：如果 targetSelector 没探测到，尝试探测数据体 tbody 的起始位置
    if (topOffset <= 5 && table) {
        const tbody = table.querySelector('tbody');
        if (tbody && tbody.offsetHeight > 0) {
            const tbodyRect = tbody.getBoundingClientRect();
            topOffset = Math.max(0, Math.floor(tbodyRect.top - containerRect.top));
        }
    }

    // 优先级3：模块化个性化语义探测 (根据模块 ID 进行针对性兜底)
    if (topOffset <= 5) { // 如果上面都没探测到
        const sectionId = container.closest('section')?.id;
        switch(sectionId) {
            case 'schedule': topOffset = 85; break; // 排课管理标题行较厚
            case 'teacher-availability':
            case 'availability': topOffset = 80; break; // 教师空闲时段含标题信息
            case 'student-availability': topOffset = 80; break;
            case 'users': topOffset = 55; break; // 用户管理普通表头
            case 'course-types': topOffset = 55; break;
            case 'overview': topOffset = 60; break; // 总览区域
            default: topOffset = table ? 55 : 0;
        }
    }

    // 统一增加 1px 的视觉缓冲间距，确保动画从标题行下方1px处开始显示
    // 避免遮盖标题行
    topOffset += 1;

    const overlay = document.createElement('div');
    overlay.className = 'stats-loading-overlay';
    
    // 动态调整容器最小高度：确保表头下方的“纯加载区域”高度固定为 360px
    // 这样能与数据统计模块中没有表头的 360px 容器在视觉上完美对齐
    const requiredMinHeight = topOffset + 360;
    if (container.offsetHeight < requiredMinHeight) {
        container.style.minHeight = requiredMinHeight + 'px';
        container.dataset.hadMinHeight = 'true';
    }

    // 强制使用 clip-path 进行物理裁剪，确保表头行所在的 top 区域完全透明且不响应鼠标
    // 这样即便 transition 过程中有抖动，表头也绝不会被遮挡
    overlay.style.clipPath = `inset(${topOffset}px 0 0 0)`;
    overlay.style.webkitClipPath = `inset(${topOffset}px 0 0 0)`;
    
    // 统一视觉规范：使用 CSS 变量控制偏移，遮罩层本身 inset: 0 撑满
    overlay.style.setProperty('--loading-top-offset', topOffset + 'px');
    overlay.style.borderRadius = isStatsUnified ? '16px' : '12px';
    
    // 如果是周视图表格，微调偏移
    if (table && table.classList.contains('weekly-schedule-table')) {
        overlay.style.setProperty('--loading-top-offset', (topOffset + 1) + 'px');
    }

    overlay.innerHTML = `
        <div class="stats-loading-content">
            <div class="stats-spinner-circle"></div>
            <div class="stats-spinner-text">${text}</div>
        </div>
    `;

    // 初始透明度设为 0，然后渐入
    overlay.style.opacity = '0';
    container.appendChild(overlay);
    
    // 触发重绘并渐入
    requestAnimationFrame(() => {
        overlay.style.opacity = '1';
    });
}

/**
 * 隐藏表格加载动画，采用平滑淡出
 * @param {HTMLElement} container - 表格的父容器
 */
export function hideTableLoading(container) {
    if (!container) return;
    const overlay = container.querySelector('.stats-loading-overlay');
    if (overlay) {
        overlay.style.opacity = '0';
        // 等待 CSS transition 结束后移除 DOM
        setTimeout(() => {
            if (overlay.parentNode === container) {
                overlay.remove();
                // 恢复最小高度设置
                if (container.dataset.hadMinHeight === 'true') {
                    container.style.minHeight = '';
                    delete container.dataset.hadMinHeight;
                }
            }
        }, 200);
    }
}

// 暴露到 window 对象，供非模块化脚本调用
window.showTableLoading = showTableLoading;
window.hideTableLoading = hideTableLoading;
