/**
 * 空闲时段（availability）编辑视图的共享实现。
 *
 * student/availability.js 与 teacher/availability.js 曾经是两份 ~500 行的孪生模块，
 * 仅端点、payload 形状、移动端容器选择器链不同；本模块把「与角色无关」的渲染、
 * 状态与反馈逻辑收拢为一个工厂，角色差异通过 config 注入：
 *
 * - fetchWeek({ startDate, endDate })        拉取一周原始行（端点各端不同）
 * - parseAvailability(value)                 原始值 → 布尔（学生端 !!v，教师端按 1/字符串解析）
 * - resolveMobileContainer()                 移动端容器兜底链（各端选择器不同）
 * - saveChanges(ctx)                         保存流程整体（payload 形状各端不同）
 *   ctx = { changedDates, state, originalState, elements, currentWeekStart,
 *           toISODate, showTimedFeedback, updateUnsavedFeedback, reload, role }
 *
 * 渲染细节统一采用教师端 R3 之后的维护版：加载失败保留表格结构（重试后能正常
 * 重新渲染），成功后清掉残留错误横幅，桌面/移动表格互斥切换。学生端原实现在
 * 失败路径会清空整个容器导致重试后表头/表体找不到节点，属潜在缺陷，此处一并修复。
 */

import { TIME_SLOT_CONFIG, getWeekStart, isMobileView } from './schedule-helpers.js';
import { showTableLoading, hideTableLoading } from './loading-ui.js';
import {
    clearChildren,
    createElement,
    getWeekDates,
    showInlineFeedback
} from './view-utils.js';
import { formatWeekRangeText, toISODate } from './date-format.js';
import { createErrorState } from './error-ui.js';

/** 深拷贝 Map<date, {morning,afternoon,evening}>（值对象只有布尔位，浅拷贝即可） */
function cloneState(state) {
    const clone = new Map();
    state.forEach((value, key) => {
        clone.set(key, { ...value });
    });
    return clone;
}

export function createAvailabilityView(config) {
    const { role, fetchWeek, parseAvailability, resolveMobileContainer, saveChanges } = config;

    // 与旧角色模块一致的元素定位（三端 id 完全相同）
    const elements = {
        header: () => document.getElementById('weeklyHeaderAvail'),
        body: () => document.getElementById('weeklyBodyAvail'),
        rangeLabel: () => document.getElementById('weekRangeAvail'),
        feedback: () => document.getElementById('availabilityFeedback'),
        saveBtn: () => document.getElementById('saveAvailability'),
        prevWeekBtn: () => document.getElementById('prevWeekAvail'),
        nextWeekBtn: () => document.getElementById('nextWeekAvail')
    };

    let currentWeekStart = null;
    let availabilityState = new Map();
    let originalState = new Map();
    let pendingFeedbackTimeout = null;
    let availabilityLoadSeq = 0;

    function initAvailabilitySection() {
        currentWeekStart = currentWeekStart || getWeekStart(new Date());
        bindEvents();
        return loadAvailability(currentWeekStart);
    }

    function bindEvents() {
        elements.prevWeekBtn()?.addEventListener('click', () => {
            currentWeekStart.setDate(currentWeekStart.getDate() - 7);
            loadAvailability(currentWeekStart);
        });
        elements.nextWeekBtn()?.addEventListener('click', () => {
            currentWeekStart.setDate(currentWeekStart.getDate() + 7);
            loadAvailability(currentWeekStart);
        });
        elements.saveBtn()?.addEventListener('click', onSaveClick);
    }

    async function loadAvailability(baseDate, showLoading = true) {
        const requestId = ++availabilityLoadSeq;
        const weekStart = getWeekStart(baseDate);
        currentWeekStart = weekStart;
        const weekDates = getWeekDates(weekStart);

        updateRangeLabel(weekDates);

        // 获取表格容器
        const tableContainer = document.querySelector('#availability .schedule-unified-card');

        // 1. 先渲染表头，以便加载动画能正确探测高度
        if (!isMobileView()) {
            renderHeader(weekDates);
        }

        // 2. 显示加载动画
        if (showLoading && tableContainer) {
            showTableLoading(tableContainer, '正在加载时间安排数据...', '#weeklyHeaderAvail');
        }

        try {
            const startDate = toISODate(weekDates[0]);
            const endDate = toISODate(weekDates[weekDates.length - 1]);
            const rows = await fetchWeek({ startDate, endDate });
            if (requestId !== availabilityLoadSeq) return;

            availabilityState = buildStateFromResponse(weekDates, rows);
            originalState = cloneState(availabilityState);
            renderTable(weekDates, availabilityState);
            document.querySelector('#availability .availability-error-banner')?.remove();
            const saveBtn = elements.saveBtn();
            if (saveBtn) saveBtn.disabled = false;
            showInlineFeedback(elements.feedback(), '', 'info');
        } catch (error) {
            if (requestId !== availabilityLoadSeq) return;
            // 加载失败：渲染明确错误态，禁止编辑，避免空白可编辑表格误导用户（R3）。
            const container = document.querySelector('#availability .schedule-unified-card') || document.querySelector('#availability');
            if (container) {
                renderAvailabilityErrorState(container, weekDates, currentWeekStart, '空闲时段加载失败，暂时无法编辑。请点击重试。');
            }
            const saveBtn = elements.saveBtn();
            if (saveBtn) saveBtn.disabled = true;
            showInlineFeedback(elements.feedback(), '空闲时段加载失败，请点击重试', 'error');
        } finally {
            // 3. 加载完成后隐藏动画
            if (showLoading && tableContainer) {
                hideTableLoading(tableContainer);
            }
        }
    }

    function buildStateFromResponse(weekDates, rows) {
        const map = new Map();
        const normalizedRows = Array.isArray(rows) ? rows : [];
        const rowsByDate = new Map(normalizedRows.map(row => [normalizeKey(row.date), row]));

        weekDates.forEach(date => {
            const key = normalizeKey(date);
            const row = rowsByDate.get(key);
            map.set(key, {
                morning: parseAvailability(row?.morning_available),
                afternoon: parseAvailability(row?.afternoon_available),
                evening: parseAvailability(row?.evening_available)
            });
        });
        return map;
    }

    function normalizeKey(dateLike) {
        // parse 由 config 注入，日期键统一走北京时区的 ISO 形态
        return toISODate(dateLike);
    }

    function renderTable(weekDates, state) {
        // 检测移动端视口
        if (isMobileView()) {
            renderMobileTable(weekDates, state);
        } else {
            const container = document.querySelector('#availability .schedule-unified-card');
            container?.querySelector('.mobile-availability-table')?.remove();
            const desktopTable = container?.querySelector('.weekly-schedule-table');
            if (desktopTable) desktopTable.style.display = '';
            renderHeader(weekDates);
            renderBody(weekDates, state);
        }
    }

    // R3：空闲时段加载失败时保留表格结构与本周日期，避免重试时找不到渲染节点。
    function renderAvailabilityErrorState(container, weekDates, weekStart, message) {
        container.querySelector('.availability-error-banner')?.remove();
        container.querySelector('.mobile-availability-table')?.remove();
        const desktopTable = container.querySelector('.weekly-schedule-table');
        if (desktopTable) desktopTable.style.display = '';
        renderHeader(weekDates);
        const tbody = elements.body();
        if (tbody) clearChildren(tbody);

        // 统一错误态（shared/error-ui.js）：图标 + 标题 + 详情 + 重试按钮。
        // 保留 availability-error-banner 类，以兼容上方成功路径的移除逻辑。
        const card = createErrorState({
            title: '空闲时段加载失败',
            detail: message || '暂时无法编辑，请点击重试',
            onRetry: () => loadAvailability(weekStart, true),
            compact: true
        });
        card.classList.add('availability-error-banner');
        container.appendChild(card);
    }

    // 移动端渲染：使用4列8行布局（日期 | 上午 | 下午 | 晚上）
    function renderMobileTable(weekDates, state) {
        const container = resolveMobileContainer();
        if (!container) {
            return;
        }

        container.querySelector('.mobile-availability-table')?.remove();
        const desktopTable = container.querySelector('.weekly-schedule-table');
        if (desktopTable) desktopTable.style.display = 'none';

        // 创建表格
        const table = createElement('table', 'mobile-availability-table');

        // 创建表头：日期 | 上午 | 下午 | 晚上
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        // 第一列：日期列标题
        const corner = createElement('th', 'date-col-header', { textContent: '日期' });
        headerRow.appendChild(corner);

        // 第二列开始：时间段列（上午、下午、晚上）
        TIME_SLOT_CONFIG.forEach(slot => {
            const th = createElement('th', 'time-slot-header', {
                textContent: slot.label,
                dataset: { slot: slot.id }
            });
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // 创建表体：每行显示一个日期
        const tbody = document.createElement('tbody');
        weekDates.forEach(date => {
            const iso = toISODate(date);
            const row = createElement('tr');

            // 第一列：日期（格式：日/星期）
            const day = date.getDate();
            const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            const weekday = weekdayNames[date.getDay()];

            // 解析腊月/正月
            let lunarParen = '';
            try {
                const lunarStr = new Intl.DateTimeFormat('zh-u-ca-chinese', { dateStyle: 'full' }).format(date);
                const match = lunarStr.match(/(正月|腊月)(.*?)(?=星期)/);
                if (match) {
                    lunarParen = `(${match[0]})`;
                }
            } catch (e) { }

            const dateLabel = `${day}/${weekday}${lunarParen}`;

            const dateCell = createElement('td', 'date-cell', {
                textContent: dateLabel,
                dataset: { date: iso }
            });
            row.appendChild(dateCell);

            // 第二列开始：每个时间段的选择
            TIME_SLOT_CONFIG.forEach(slot => {
                const cell = createElement('td', 'availability-cell');
                const isActive = state.get(iso)?.[slot.id] ?? false;

                const iconContainer = createElement('div', `icon-slot-container ${isActive ? 'active' : ''}`);
                iconContainer.innerHTML = `
                    <span class="material-icons-round icon-slot">${slot.icon}</span>
                    <span class="icon-slot-text">${slot.label}</span>
                `;

                iconContainer.addEventListener('click', () => {
                    const newState = !iconContainer.classList.contains('active');
                    iconContainer.classList.toggle('active', newState);
                    handleAvailabilityChange(iso, slot.id, newState, cell);
                });

                cell.appendChild(iconContainer);
                row.appendChild(cell);
            });

            tbody.appendChild(row);
        });

        table.appendChild(tbody);
        container.appendChild(table);
    }

    function renderHeader(weekDates) {
        const thead = elements.header();
        if (!thead) return;
        clearChildren(thead);

        const row = document.createElement('tr');
        // Corner cell
        const corner = createElement('th', 'time-col-header', { textContent: '时间段' });
        row.appendChild(corner);

        // Date columns
        weekDates.forEach(date => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            const weekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
            const weekday = weekdayNames[date.getDay()];

            // 农历显示
            let lunarLabel = '';
            try {
                const lunarStr = new Intl.DateTimeFormat('zh-u-ca-chinese', { dateStyle: 'full' }).format(date);
                const match = lunarStr.match(/(正月|腊月)(.*?)(?=星期)/);
                if (match) {
                    lunarLabel = `<br><span style="font-size: var(--fs-300); color: #64748B;">(${match[0]})</span>`;
                }
            } catch (e) { }

            const th = createElement('th', 'date-header');
            th.dataset.date = toISODate(date);
            th.innerHTML = `
                <div class="date-label">${month}月${day}日${lunarLabel}</div>
                <div class="day-label">${weekday}</div>
            `;
            row.appendChild(th);
        });

        thead.appendChild(row);
    }

    function renderBody(weekDates, state) {
        const tbody = elements.body();
        if (!tbody) return;
        clearChildren(tbody);

        TIME_SLOT_CONFIG.forEach(slot => {
            const row = createElement('tr');

            // Time slot label cell
            const labelCell = createElement('td', 'time-slot-cell', { textContent: slot.label });
            row.appendChild(labelCell);

            // Icon containers for each date
            weekDates.forEach(date => {
                const iso = toISODate(date);
                const cell = createElement('td', 'availability-cell');
                const isActive = state.get(iso)?.[slot.id] ?? false;

                const iconContainer = createElement('div', `icon-slot-container ${isActive ? 'active' : ''}`);
                iconContainer.innerHTML = `
                    <span class="material-icons-round icon-slot">${slot.icon}</span>
                    <span class="icon-slot-text">${slot.label}</span>
                `;

                iconContainer.addEventListener('click', () => {
                    const newState = !iconContainer.classList.contains('active');
                    iconContainer.classList.toggle('active', newState);
                    handleAvailabilityChange(iso, slot.id, newState, cell);
                });

                cell.appendChild(iconContainer);
                row.appendChild(cell);
            });

            tbody.appendChild(row);
        });
    }

    function handleAvailabilityChange(dateKey, slotId, isChecked, cell) {
        const current = availabilityState.get(dateKey) || { morning: false, afternoon: false, evening: false };
        availabilityState.set(dateKey, { ...current, [slotId]: isChecked });
        cell.classList.toggle('availability-selected', isChecked);
        updateUnsavedFeedback();
    }

    function updateUnsavedFeedback() {
        const changedDates = getChangedDates();
        if (changedDates.length === 0) {
            showInlineFeedback(elements.feedback(), '', 'info');
            return;
        }
        showInlineFeedback(elements.feedback(), `共有 ${changedDates.length} 个日期的可用时间尚未保存`, 'info');
    }

    function getChangedDates() {
        const changed = [];
        availabilityState.forEach((slots, date) => {
            const originalSlots = originalState.get(date) || { morning: false, afternoon: false, evening: false };
            const hasDifference = TIME_SLOT_CONFIG.some(slot => {
                return Boolean(slots[slot.id]) !== Boolean(originalSlots[slot.id]);
            });
            if (hasDifference) {
                changed.push(date);
            }
        });
        return changed;
    }

    async function onSaveClick() {
        const changedDates = getChangedDates();
        if (changedDates.length === 0) {
            showInlineFeedback(elements.feedback(), '没有需要保存的更改', 'info');
            return;
        }

        await saveChanges({
            changedDates,
            state: availabilityState,
            originalState,
            elements,
            currentWeekStart: () => currentWeekStart,
            toISODate,
            showInlineFeedback,
            showTimedFeedback,
            updateUnsavedFeedback,
            reload: () => loadAvailability(currentWeekStart, false),
            role
        });
    }

    function updateRangeLabel(weekDates) {
        const labelEl = elements.rangeLabel();
        if (!labelEl || weekDates.length === 0) return;
        labelEl.textContent = formatWeekRangeText(weekDates[0], weekDates[weekDates.length - 1]);
    }

    function showTimedFeedback(message, status) {
        showInlineFeedback(elements.feedback(), message, status);
        if (pendingFeedbackTimeout) {
            clearTimeout(pendingFeedbackTimeout);
        }
        pendingFeedbackTimeout = window.setTimeout(() => {
            showInlineFeedback(elements.feedback(), '', 'info');
        }, 3000);
    }

    function refreshAvailability() {
        return loadAvailability(currentWeekStart);
    }

    return {
        initAvailabilitySection,
        loadAvailability,
        refreshAvailability
    };
}
