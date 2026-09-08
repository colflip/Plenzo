/**
 * 跨端共享的视图小工具（纯 DOM / 纯函数，不持有模块级状态）
 *
 * 收拢三端各自复制的一份同名实现：
 * - createElement / clearChildren / showInlineFeedback / getWeekDates
 *   原 student/utils.js 与 teacher/utils.js 各一份（createElement 以 teacher 版为准，
 *   支持 dataset / classList props；student 版遇到 dataset prop 会退化成字符串属性）
 * - syncToggleButton   原 admin/schedule-manager.js 与 teacher/student-schedules.js 各一份
 * - isValidSection     原 admin/ui-layout.js 与 shared/dashboard-kit.js 各一份
 * - refreshVisibleSection  原 admin/index.js（refreshAdminSection）与 student、teacher
 *   entry.js（refreshVisibleSection）三份同体异名实现，统一取后一个名字。
 *
 * 约定：这里只放「不依赖角色本地状态」的实现；依赖各端 elements/常量的渲染逻辑
 * 仍留在各自模块，避免为了去重引入行为漂移。
 */

import { getWeekStart } from './schedule-helpers.js';

/**
 * 创建元素并按 props 赋值（teacher 版实现）。
 * - dataset / classList 作为特殊键处理，其余键 Object.assign 到元素上
 * - innerHTML 一律经 SecurityUtils.safeSetHTML 清洗
 */
export function createElement(tag, className, props = {}) {
    const el = document.createElement(tag);
    if (className) el.className = className;

    const { dataset, classList: extraClasses, ...rest } = props || {};

    if (rest && Object.keys(rest).length > 0) {
        Object.assign(el, rest);
    }

    if (dataset && typeof dataset === 'object') {
        Object.entries(dataset).forEach(([key, value]) => {
            if (value === undefined || value === null) return;
            el.dataset[key] = String(value);
        });
    }

    if (extraClasses) {
        const values = Array.isArray(extraClasses)
            ? extraClasses
            : String(extraClasses).split(/\s+/);
        el.classList.add(...values.filter(Boolean));
    }

    return el;
}

/** 清空元素子节点（null 安全） */
export function clearChildren(element) {
    if (element) {
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }
}

/** 行内反馈条：写文案并切换 success / error / info 状态类 */
export function showInlineFeedback(el, message, status) {
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('success', 'error', 'info');
    if (status) {
        el.classList.add(status);
    }
}

/** 以 baseDate 所在周为起点返回 7 个 Date（周一..周日，由 schedule-helpers.getWeekStart 决定） */
export function getWeekDates(baseDateLike) {
    const start = getWeekStart(baseDateLike) || new Date();
    return Array.from({ length: 7 }, (_, idx) => {
        const date = new Date(start);
        date.setDate(start.getDate() + idx);
        return date;
    });
}

/** 开关按钮的统一激活态视觉（红=开 / 绿=关），与 CSS 类 schedule-toggle-active 配套 */
export function syncToggleButton(button, isActive) {
    if (!button) return;
    const active = !!isActive;
    const color = active ? '#ef4444' : '#2ECC71';
    button.classList.toggle('schedule-toggle-active', active);
    button.setAttribute('aria-pressed', String(active));
    button.style.backgroundColor = color;
    button.style.borderColor = color;
    button.style.color = '#fff';
}

/** 区块是否是侧栏里登记过的导航目标 */
export function isValidSection(sectionId) {
    if (!sectionId || !document.getElementById(sectionId)) return false;
    return Array.from(document.querySelectorAll('.nav-item')).some(item => item.dataset.section === sectionId);
}

/** 仅当目标区块正被用户看着时才刷新，后台区块等切回去时自然重载 */
export function refreshVisibleSection(sectionId, refresher) {
    const section = document.getElementById(sectionId);
    if (section?.classList.contains('active')) {
        Promise.resolve(refresher()).catch(() => {});
    }
}
