import { EMPTY_STATES, TIME_SLOT_CONFIG } from './constants.js';
import {
    clearChildren,
    createElement,
    formatWeekRangeText,
    getWeekDates,
    normalizeDateKey,
    showInlineFeedback,
    toISODate
} from './utils.js';

let currentWeekStart = null;
let availabilityState = new Map();
let originalState = new Map();
let pendingFeedbackTimeout = null;

const elements = {
    header: () => document.getElementById('weeklyHeaderAvail'),
    body: () => document.getElementById('weeklyBodyAvail'),
    rangeLabel: () => document.getElementById('weekRangeAvail'),
    feedback: () => document.getElementById('availabilityFeedback'),
    saveBtn: () => document.getElementById('saveAvailability'),
    prevWeekBtn: () => document.getElementById('prevWeekAvail'),
    nextWeekBtn: () => document.getElementById('nextWeekAvail')
};

export async function initAvailabilitySection() {
    currentWeekStart = currentWeekStart || getWeekStart(new Date());
    bindEvents();
    await loadAvailability(currentWeekStart);
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
    elements.saveBtn()?.addEventListener('click', saveAvailability);
}

export async function loadAvailability(baseDate) {
    const weekStart = getWeekStart(baseDate);
    currentWeekStart = weekStart;
    const weekDates = getWeekDates(weekStart);

    updateRangeLabel(weekDates);
    showLoadingState();

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);
        const response = await window.apiUtils.get('/teacher/availability', {
            startDate,
            endDate
        });

        availabilityState = buildStateFromResponse(weekDates, response);
        originalState = cloneState(availabilityState);
        renderTable(weekDates, availabilityState);
        showInlineFeedback(elements.feedback(), '', 'info');
    } catch (error) {
        console.error('加载教师时间安排失败', error);
        availabilityState = buildStateFromResponse(weekDates, []);
        originalState = cloneState(availabilityState);
        renderTable(weekDates, availabilityState);
        showInlineFeedback(elements.feedback(), '暂时无法获取最新的时间安排，已显示默认空白表格，请稍后重试', 'error');
    }
}

function buildStateFromResponse(weekDates, rows) {
    const map = new Map();
    const normalizedRows = Array.isArray(rows) ? rows : [];
    const rowsByDate = new Map(normalizedRows.map(row => [normalizeDateKey(row.date), row]));

    weekDates.forEach(date => {
        const key = normalizeDateKey(date);
        const row = rowsByDate.get(key);
        map.set(key, {
            morning: convertToBoolean(row?.morning_available),
            afternoon: convertToBoolean(row?.afternoon_available),
            evening: convertToBoolean(row?.evening_available)
        });
    });
    return map;
}

function cloneState(state) {
    const clone = new Map();
    state.forEach((value, key) => {
        clone.set(key, { ...value });
    });
    return clone;
}

function convertToBoolean(value) {
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        return ['1', 'true', 'available', 'yes'].includes(value.toLowerCase());
    }
    return false;
}

function renderTable(weekDates, state) {
    // 检测移动端视口
    if (isMobileView()) {
        renderMobileTable(weekDates, state);
    } else {
        renderHeader(weekDates);
        renderBody(weekDates, state);
    }
}

// 检测移动端视口
function isMobileView() {
    return window.innerWidth <= 768;
}

// 移动端渲染：使用4列8行布局（日期 | 上午 | 下午 | 晚上）
function renderMobileTable(weekDates, state) {
    // 尝试多种选择器，确保能找到容器
    // 教师端使用 schedule-unified-card，学生端使用 table-container
    let container = document.querySelector('#availability .schedule-unified-card');
    if (!container) {
        container = document.querySelector('#availability .weekly-schedule-table')?.parentElement;
    }
    if (!container) {
        container = document.querySelector('.table-container');
    }
    if (!container) {
        console.warn('[Mobile Availability] 容器未找到');
        return;
    }

    clearChildren(container);

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
                lunarLabel = `<br><span style="font-size: 11px; color: #64748B;">(${match[0]})</span>`;
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

async function saveAvailability() {
    const changedDates = getChangedDates();
    if (changedDates.length === 0) {
        showInlineFeedback(elements.feedback(), '没有需要保存的更改', 'info');
        return;
    }

    const payload = buildPersistencePayload(changedDates);
    if (!payload.updates.length && !payload.removals.length) {
        showInlineFeedback(elements.feedback(), '请勾选至少一个时间段后再保存', 'info');
        return;
    }

    try {
        await submitAvailabilityPayload(payload);
    } catch (_) {
        // 已在 submitAvailabilityPayload 中处理反馈
    }
}

function buildPersistencePayload(changedDates) {
    const updates = [];
    const removals = [];

    changedDates.forEach(date => {
        const slots = availabilityState.get(date) || {};
        const originalSlots = originalState.get(date) || { morning: false, afternoon: false, evening: false };
        const allOff = TIME_SLOT_CONFIG.every(slot => !slots[slot.id]);
        const originalHadAny = TIME_SLOT_CONFIG.some(slot => originalSlots[slot.id]);

        if (allOff && originalHadAny) {
            removals.push({ date, removeAll: true });
            return;
        }

        if (!allOff) {
            const payloadSlots = {};
            TIME_SLOT_CONFIG.forEach(slot => {
                payloadSlots[slot.id] = slots[slot.id] ? 1 : 0;
            });
            updates.push({
                date,
                slots: payloadSlots
            });
        }
    });

    return { updates, removals };
}

function showLoadingState() {
    const tbody = elements.body();
    if (!tbody) return;
    clearChildren(tbody);

    // Add a loading row that spans all columns
    const row = createElement('tr');
    const labelCell = createElement('td', 'time-slot-cell', { textContent: '-' });
    row.appendChild(labelCell);

    const loadingCell = createElement('td', 'no-schedule', { textContent: '加载中...' });
    loadingCell.colSpan = 7;
    loadingCell.style.textAlign = 'center';
    row.appendChild(loadingCell);
    tbody.appendChild(row);
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

function getWeekStart(dateLike) {
    const date = dateLike instanceof Date ? new Date(dateLike) : new Date(dateLike);
    if (Number.isNaN(date.getTime())) return new Date();
    const day = date.getDay() || 7;
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (day - 1));
    return date;
}

export function refreshAvailability() {
    return loadAvailability(currentWeekStart);
}

async function submitAvailabilityPayload(payload) {
    const actionButton = elements.saveBtn();
    const updates = payload?.updates || [];
    const removals = payload?.removals || [];

    try {
        if (actionButton) {
            actionButton.disabled = true;
            actionButton.textContent = '保存中...';
        }

        if (!updates.length && !removals.length) {
            showInlineFeedback(elements.feedback(), '没有需要保存的更改', 'info');
            return;
        }

        if (updates.length > 0) {
            await window.apiUtils.post('/teacher/availability', { availabilityList: updates });
        }
        if (removals.length > 0) {
            await window.apiUtils.delete('/teacher/availability', { body: { records: removals } });
        }

        originalState = cloneState(availabilityState);
        showTimedFeedback('时间安排已保存', 'success');
    } catch (error) {
        console.error('保存时间安排失败', error);
        showInlineFeedback(elements.feedback(), '保存失败，请稍后重试', 'error');
        throw error;
    } finally {
        if (actionButton) {
            actionButton.disabled = false;
            actionButton.textContent = '保存时间安排';
        }
        updateUnsavedFeedback();
    }
}



