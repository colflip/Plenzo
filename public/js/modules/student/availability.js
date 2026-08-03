import { API_ENDPOINTS, TIME_SLOT_CONFIG, EMPTY_STATES } from './constants.js';

let availabilityLoadSeq = 0;
import { isMobileView } from '../shared/schedule-helpers.js';
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

export async function loadAvailability(baseDate, showLoading = true) {
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

    // 2. 显示加载动画（与教师端保持一致）
    if (showLoading && tableContainer && window.showTableLoading) {
        window.showTableLoading(tableContainer, '正在加载时间安排数据...', '#weeklyHeaderAvail');
    }

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        const endpoint = String(API_ENDPOINTS.AVAILABILITY).replace(/^\/api/, '');
        const data = await window.apiUtils.get(endpoint, { startDate, endDate });
        if (requestId !== availabilityLoadSeq) return;

        availabilityState = buildStateFromResponse(weekDates, data);
        originalState = cloneState(availabilityState);
        renderTable(weekDates, availabilityState);
        const saveBtn = elements.saveBtn();
        if (saveBtn) saveBtn.disabled = false;
        showInlineFeedback(elements.feedback(), '', 'info');
    } catch (error) {
        if (requestId !== availabilityLoadSeq) return;
        // 加载失败：渲染明确错误态，禁止编辑，避免空白可编辑表格误导用户（R3）。
        const container = document.querySelector('#availability .schedule-unified-card') || document.querySelector('#availability');
        if (container) {
            renderAvailabilityErrorState(container, currentWeekStart, '空闲时段加载失败，暂时无法编辑。请点击重试。');
        }
        const saveBtn = elements.saveBtn();
        if (saveBtn) saveBtn.disabled = true;
        showInlineFeedback(elements.feedback(), '空闲时段加载失败，请点击重试', 'error');
    } finally {
        // 3. 加载完成后隐藏动画
        if (showLoading && tableContainer && window.hideTableLoading) {
            window.hideTableLoading(tableContainer);
        }
    }
}

function buildStateFromResponse(weekDates, rows) {
    const map = new Map();
    // Student API returns array of { date, morning_available, afternoon_available, evening_available }

    const dataByDate = new Map();
    const normalizedRows = Array.isArray(rows) ? rows : [];

    normalizedRows.forEach(row => {
        const key = normalizeDateKey(row.date);
        dataByDate.set(key, row);
    });

    weekDates.forEach(date => {
        const key = normalizeDateKey(date);
        const rowData = dataByDate.get(key) || {};
        map.set(key, {
            morning: !!rowData.morning_available,
            afternoon: !!rowData.afternoon_available,
            evening: !!rowData.evening_available
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

// R3：空闲时段加载失败时的明确错误态（横幅 + 重试 + 禁用编辑）。
function renderAvailabilityErrorState(container, weekStart, message) {
    clearChildren(container);

    const banner = createElement('div', 'availability-error-banner');
    banner.setAttribute('role', 'alert');
    banner.style.cssText = [
        'display:flex',
        'flex-direction:column',
        'align-items:center',
        'justify-content:center',
        'gap:12px',
        'padding:32px 16px',
        'margin:16px 0',
        'border:1px dashed #f0a9a9',
        'border-radius:12px',
        'background:#fff5f5',
        'color:#b42318',
        'text-align:center'
    ].join(';');

    const icon = createElement('div', 'availability-error-icon');
    icon.textContent = '⚠️';
    icon.style.cssText = 'font-size:28px;';

    const text = createElement('div', 'availability-error-text');
    text.textContent = message;

    const retry = createElement('button', 'btn-retry-availability');
    retry.type = 'button';
    retry.id = 'availabilityRetryBtn';
    retry.textContent = '重试';
    retry.style.cssText = [
        'padding:8px 18px',
        'border:none',
        'border-radius:8px',
        'background:#b42318',
        'color:#fff',
        'font-weight:600',
        'cursor:pointer'
    ].join(';');
    retry.addEventListener('click', () => {
        loadAvailability(weekStart, true);
    });

    banner.appendChild(icon);
    banner.appendChild(text);
    banner.appendChild(retry);
    container.appendChild(banner);
}


// 移动端渲染：使用4列8行布局（与教师PC端一致）
function renderMobileTable(weekDates, state) {
    // 尝试多种选择器，优先使用.schedule-unified-card
    let container = document.querySelector('#availability .schedule-unified-card');
    if (!container) {
        container = document.querySelector('.schedule-unified-card');
    }
    if (!container) {
        container = document.querySelector('#availability .table-container');
    }
    if (!container) {
        container = document.querySelector('.table-container');
    }
    if (!container) {
        
        return;
    }

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
        const originalSlots = originalState.get(date) || { morning: false, afternoon: false, evening: false };
        
        TIME_SLOT_CONFIG.forEach(slot => {
            // Only send if the status has changed compared to originalState
            const currentVal = !!slots[slot.id];
            const originalVal = !!originalSlots[slot.id];
            
            if (currentVal !== originalVal) {
                availabilityList.push({
                    date: date,
                    timeSlot: slot.id,
                    isAvailable: currentVal
                });
            }
        });
    });

    try {
        if (actionButton) {
            actionButton.disabled = true;
            actionButton.textContent = '保存中...';
        }

        const endpoint = String(API_ENDPOINTS.AVAILABILITY).replace(/^\/api/, '');
        await window.apiUtils.post(endpoint, { availabilityList });
        // Rebuild the baseline from the server instead of trusting the edited client state.
        await loadAvailability(currentWeekStart, false);
        window.eventBus?.emit(window.EVENTS?.AVAILABILITY_UPDATED || 'availability:updated', {
            role: 'student',
            weekStart: toISODate(currentWeekStart)
        });
        showTimedFeedback('时间安排已保存', 'success');
    } catch (error) {
        let errorMsg = '保存失败，请稍后重试';
        if (error.message) {
            errorMsg = `保存失败: ${error.message}`;
        }
        showTimedFeedback(errorMsg, 'error');
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

// getWeekStart is imported from ../shared/schedule-helpers.js

export function refreshAvailability() {
    return loadAvailability(currentWeekStart);
}
