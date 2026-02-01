import { API_ENDPOINTS, TIME_SLOT_CONFIG, EMPTY_STATES } from './constants.js';
import {
    clearChildren,
    createElement,
    formatWeekRangeText,
    getWeekDates,
    normalizeDateKey,
    showInlineFeedback,
    toISODate,
    handleApiError
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
    const prevBtn = elements.prevWeekBtn();
    const nextBtn = elements.nextWeekBtn();
    const saveBtn = elements.saveBtn();

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            currentWeekStart.setDate(currentWeekStart.getDate() - 7);
            loadAvailability(currentWeekStart);
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            currentWeekStart.setDate(currentWeekStart.getDate() + 7);
            loadAvailability(currentWeekStart);
        });
    }
    if (saveBtn) {
        saveBtn.addEventListener('click', saveAvailability);
    }
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

        const response = await fetch(
            `${API_ENDPOINTS.AVAILABILITY}?startDate=${startDate}&endDate=${endDate}`,
            {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
            }
        );

        if (!response.ok) {
            throw new Error('获取时间安排失败');
        }

        const data = await response.json();

        availabilityState = buildStateFromResponse(weekDates, data);
        originalState = cloneState(availabilityState);
        renderTable(weekDates, availabilityState);
        showInlineFeedback(elements.feedback(), '', 'info');
    } catch (error) {
        console.error('加载学生时间安排失败', error);
        availabilityState = buildStateFromResponse(weekDates, []);
        originalState = cloneState(availabilityState);
        renderTable(weekDates, availabilityState);
        showInlineFeedback(elements.feedback(), '暂时无法获取最新的时间安排，已显示默认空白表格，请稍后重试', 'error');
    }
}

function buildStateFromResponse(weekDates, rows) {
    const map = new Map();
    // Student API returns array of { date, time_slot } objects usually
    // We need to convert this to { morning: bool, afternoon: bool, evening: bool }

    // Create a map of date -> Set of slots
    const slotsByDate = new Map();
    const normalizedRows = Array.isArray(rows) ? rows : [];

    normalizedRows.forEach(row => {
        const key = normalizeDateKey(row.date);
        if (!slotsByDate.has(key)) {
            slotsByDate.set(key, new Set());
        }
        slotsByDate.get(key).add(row.time_slot);
    });

    weekDates.forEach(date => {
        const key = normalizeDateKey(date);
        const slots = slotsByDate.get(key) || new Set();
        map.set(key, {
            morning: slots.has('morning'),
            afternoon: slots.has('afternoon'),
            evening: slots.has('evening')
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

// 移动端渲染：使用4列8行布局（与教师PC端一致）
function renderMobileTable(weekDates, state) {
    const container = document.querySelector('#availability .table-container');
    if (!container) return;

    clearChildren(container);

    // 创建表格
    const table = createElement('table', 'mobile-availability-table');

    // 创建表头：空格 | 上午 | 下午 | 晚上
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
        const dateLabel = `${day}/${weekday}`;

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

        const th = createElement('th', 'date-header');
        th.dataset.date = toISODate(date);
        th.innerHTML = `
            <div class="date-label">${month}月${day}日</div>
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
    const actionButton = elements.saveBtn();
    const changedDates = getChangedDates();
    if (changedDates.length === 0) {
        showInlineFeedback(elements.feedback(), '没有需要保存的更改', 'info');
        return;
    }

    // Prepare payload for Student API
    const availabilityList = [];
    changedDates.forEach(date => {
        const slots = availabilityState.get(date);
        TIME_SLOT_CONFIG.forEach(slot => {
            // We need to send the status of ALL slots for changed dates, 
            // or at least the ones that changed.
            // The backend updates based on the list.
            // Let's send the current state of the slot.
            availabilityList.push({
                date: date,
                timeSlot: slot.id,
                isAvailable: !!slots[slot.id]
            });
        });
    });

    try {
        if (actionButton) {
            actionButton.disabled = true;
            actionButton.textContent = '保存中...';
        }

        const response = await fetch(API_ENDPOINTS.AVAILABILITY, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            },
            body: JSON.stringify({ availabilityList })
        });

        if (!response.ok) {
            throw new Error('保存时间安排失败');
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
