/**
 * loading-ui.js —— 全站统一的数据加载过渡交互（单一实现，三端复用）
 *
 * 视觉基准取自管理端「排课管理」页的表格加载遮罩：
 * 半透明毛玻璃遮罩 + 扫光 + 32px 环形 spinner + 说明文字。
 * 样式定义集中在 public/css/core/global.css
 * （.stats-loading-overlay / .stats-loading-content / .stats-spinner-circle / .stats-spinner-text）。
 *
 * 历史问题：该实现原先只存在于 modules/admin/ui-helper.js，教师端与学生端并未加载该模块，
 * 于是这两端所有 `if (window.showTableLoading)` 守卫全部静默失效——表格取数期间没有任何
 * 过渡动画，只剩零散的「加载中...」纯文字。现将实现下沉到 shared/，
 * admin/ui-helper.js 改为再导出，三端共用同一份代码与同一套样式。
 */

const DEFAULT_TEXT = '正在加载数据...';

/** setButtonLoading 的原始按钮内容备份（按钮 → DocumentFragment） */
const buttonRestoreMap = new WeakMap();

/**
 * 构建统一的「spinner + 文案」内容块（所有加载形态共用同一份 DOM 结构）
 * @param {string} [text] - 提示文案
 * @returns {HTMLElement}
 */
export function createLoadingContent(text = DEFAULT_TEXT) {
    const content = document.createElement('div');
    content.className = 'stats-loading-content';

    const circle = document.createElement('div');
    circle.className = 'stats-spinner-circle';
    content.appendChild(circle);

    const label = document.createElement('div');
    label.className = 'stats-spinner-text';
    label.textContent = text;
    content.appendChild(label);

    return content;
}

/**
 * 显示表格加载遮罩（保留表头可见，遮罩只覆盖数据区）
 * @param {HTMLElement} container - 表格的父容器（.table-container / .stats-unified-card 等）
 * @param {string} [text] - 加载显示的文本
 * @param {string|null} [targetSelector] - 需要避开的顶部区域选择器，默认 thead
 * @param {{ minVisibleMs?: number }} [options] - minVisibleMs：遮罩最短展示时长（ms）。
 *   接口瞬间返回时遮罩会一闪而过，用户感知不到"正在加载"；传该值可保证动画至少可见一段时间。
 * @returns {HTMLElement|undefined} overlay 元素
 */
export function showTableLoading(container, text = DEFAULT_TEXT, targetSelector = 'thead', options = {}) {
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
    const targetElement = targetSelector ? container.querySelector(targetSelector) : null;
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
        switch (sectionId) {
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

    // 统一增加 1px 的视觉缓冲间距，确保动画从标题行下方 1px 处开始显示，避免遮盖标题行
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

    overlay.appendChild(createLoadingContent(text));

    const minVisibleMs = Number(options && options.minVisibleMs) || 0;
    if (minVisibleMs > 0) {
        overlay.dataset.minVisibleMs = String(minVisibleMs);
        overlay.dataset.shownAt = String(Date.now());
    }

    // 初始透明度设为 0，然后渐入
    overlay.style.opacity = '0';
    container.appendChild(overlay);

    // 触发重绘并渐入
    requestAnimationFrame(() => {
        overlay.style.opacity = '1';
    });
    return overlay;
}

/**
 * 隐藏表格加载遮罩，采用平滑淡出
 * 若 show 时指定了 minVisibleMs，则不足该时长会延后淡出（避免加载态一闪而过）
 * @param {HTMLElement} container - 表格的父容器
 */
export function hideTableLoading(container) {
    if (!container) return;
    const overlay = container.querySelector('.stats-loading-overlay');
    if (!overlay) return;

    const fadeOut = () => {
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
    };

    const minVisibleMs = Number(overlay.dataset.minVisibleMs) || 0;
    const shownAt = Number(overlay.dataset.shownAt) || 0;
    const elapsed = shownAt ? Date.now() - shownAt : minVisibleMs;
    if (minVisibleMs > 0 && elapsed < minVisibleMs) {
        setTimeout(fadeOut, minVisibleMs - elapsed);
        return;
    }
    fadeOut();
}

/**
 * 构建行内加载块（不使用遮罩的场景：列表占位、卡片内占位）
 * @param {string} [text] - 提示文案
 * @param {{ compact?: boolean }} [options] - compact 为横向紧凑版（列表占位用）
 * @returns {HTMLElement}
 */
export function createInlineLoading(text = DEFAULT_TEXT, { compact = false } = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = compact ? 'inline-loading inline-loading--compact' : 'inline-loading';
    wrapper.appendChild(createLoadingContent(text));
    return wrapper;
}

/**
 * 用统一加载块替换容器内容（容器内原有内容会被清空）
 * @param {HTMLElement} container
 * @param {string} [text]
 * @param {{ compact?: boolean }} [options]
 */
export function showBlockLoading(container, text = DEFAULT_TEXT, options = {}) {
    if (!container) return;
    container.replaceChildren(createInlineLoading(text, options));
}

/**
 * 构建表格内的加载占位行（与遮罩同一套 spinner，视觉完全一致）
 * @param {Object} [options]
 * @param {number} [options.colspan=7] - 加载单元格跨列数
 * @param {string} [options.text] - 提示文案
 * @param {string|null} [options.leadingCellText] - 首列占位文本（周视图首列为时段名时使用）
 * @param {string} [options.leadingCellClass] - 首列 class
 * @returns {HTMLTableRowElement}
 */
export function createTableLoadingRow({
    colspan = 7,
    text = DEFAULT_TEXT,
    leadingCellText = null,
    leadingCellClass = 'time-slot-cell'
} = {}) {
    const row = document.createElement('tr');
    row.className = 'table-loading-row';

    if (leadingCellText !== null) {
        const leading = document.createElement('td');
        leading.className = leadingCellClass;
        leading.textContent = leadingCellText;
        row.appendChild(leading);
    }

    const cell = document.createElement('td');
    cell.className = 'table-loading-cell';
    cell.colSpan = colspan;
    cell.appendChild(createLoadingContent(text));
    row.appendChild(cell);

    return row;
}

/**
 * 用统一加载占位行替换 tbody 内容
 * @param {HTMLElement} tbody - 目标 tbody
 * @param {Object} [options] - 同 createTableLoadingRow
 */
export function showTableLoadingRow(tbody, options = {}) {
    if (!tbody) return;
    tbody.replaceChildren(createTableLoadingRow(options));
}

/**
 * 按钮加载态：注入统一的小号 spinner，并在结束后恢复原内容
 * @param {HTMLElement} button - 目标按钮
 * @param {boolean} isLoading - true 进入加载态，false 恢复
 * @param {string} [text] - 加载态文案
 */
export function setButtonLoading(button, isLoading, text = '加载中...') {
    if (!button) return;

    if (isLoading) {
        // 已处于加载态时不重复备份，避免恢复出 spinner 本身
        if (!buttonRestoreMap.has(button)) {
            const backup = document.createDocumentFragment();
            backup.append(...button.childNodes);
            buttonRestoreMap.set(button, backup);
        }

        const spinner = document.createElement('span');
        spinner.className = 'btn-spinner';
        const label = document.createElement('span');
        label.className = 'btn-loading-text';
        label.textContent = text;

        button.replaceChildren(spinner, label);
        button.classList.add('is-loading');
        button.disabled = true;
        return;
    }

    const backup = buttonRestoreMap.get(button);
    if (backup) {
        button.replaceChildren(backup);
        buttonRestoreMap.delete(button);
    }
    button.classList.remove('is-loading');
    button.disabled = false;
}

// 暴露到 window，供非模块化脚本（components/*.js、legacy-adapter.js）复用同一实现
window.LoadingUI = {
    createLoadingContent,
    showTableLoading,
    hideTableLoading,
    createInlineLoading,
    showBlockLoading,
    createTableLoadingRow,
    showTableLoadingRow,
    setButtonLoading
};
window.showTableLoading = showTableLoading;
window.hideTableLoading = hideTableLoading;
