/**
 * UI Helper Module
 * @description 处理管理控制台的通用UI逻辑
 */

import {
    setupSidebarToggle as sharedSetupSidebarToggle
} from '../shared/dashboard-kit.js';

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
    sharedSetupSidebarToggle({ storageKey: 'sidebarCollapsed' });
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
 * 显示表格加载动画 / 隐藏表格加载动画
 *
 * 实现已下沉至 shared/loading-ui.js（三端统一：admin / teacher / student 共用同一份
 * DOM 结构与样式）。此处保留同名再导出，管理端既有 import 路径与 window 全局保持不变。
 */
export {
    showTableLoading,
    hideTableLoading,
    createLoadingContent,
    createInlineLoading,
    showBlockLoading,
    createTableLoadingRow,
    showTableLoadingRow,
    setButtonLoading
} from '../shared/loading-ui.js';
