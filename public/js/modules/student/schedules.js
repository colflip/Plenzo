import { API_ENDPOINTS, STATUS_LABELS, EMPTY_STATES, SCHEDULE_TYPE_MAP, getScheduleTypeLabel } from './constants.js';
import {
    clearChildren,
    createElement,
    formatTimeRange,
    formatWeekRangeText,
    getWeekDates,
    normalizeDateKey,
    setText,
    showInlineFeedback,
    toISODate,
    handleApiError,
    startOfWeek,
    getTimeSlotId
} from './utils.js';

let currentWeekStart = null;
let cachedSchedules = [];

const elements = {
    header: () => document.getElementById('weeklyHeader'),
    body: () => document.getElementById('weeklyBody'),
    rangeLabel: () => document.getElementById('weekRange'),
    feedback: () => document.getElementById('scheduleFeedback'),
    prevWeekBtn: () => document.getElementById('prevWeek'),
    nextWeekBtn: () => document.getElementById('nextWeek')
};

export async function initSchedulesSection() {
    currentWeekStart = currentWeekStart || startOfWeek(new Date());
    bindNavigation();
    await loadSchedules(currentWeekStart);
}

function bindNavigation() {
    const prevBtn = elements.prevWeekBtn();
    const nextBtn = elements.nextWeekBtn();

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            currentWeekStart.setDate(currentWeekStart.getDate() - 7);
            loadSchedules(currentWeekStart);
        });
    }
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            currentWeekStart.setDate(currentWeekStart.getDate() + 7);
            loadSchedules(currentWeekStart);
        });
    }
}

export async function loadSchedules(baseDate) {
    const weekStart = startOfWeek(baseDate);
    currentWeekStart = weekStart;
    const weekDates = getWeekDates(weekStart);
    updateWeekRangeLabel(weekDates);

    // Inject custom styles for single-row view to fix sticky first column issue
    if (!document.getElementById('single-row-fix-style')) {
        const style = document.createElement('style');
        style.id = 'single-row-fix-style';
        style.innerHTML = `
            #schedules .weekly-schedule-table thead th:first-child,
            #schedules .weekly-schedule-table tbody td:first-child {
                width: auto !important;
                position: static !important;
                background-color: transparent !important;
                border-right: 1px solid #E5E7EB !important;
                z-index: auto !important;
                min-width: 140px; /* Essential for cell width consistency */
            }
            /* Fix hover effect on first cell */
            #schedules .weekly-schedule-table tbody tr:hover td:first-child {
                background-color: transparent !important;
            }
            /* ALLOW FULL LOCATION TEXT & VARIABLE HEIGHT */
            .schedule-footer .location-text {
                white-space: normal !important;
                overflow: visible !important;
                text-overflow: unset !important;
                height: auto !important;
                max-height: none !important;
                line-height: 1.4;
            }
            .schedule-card-group {
                height: auto !important;
                min-height: 100px; /* Maintain minimum but allow growth */
            }
        `;
        document.head.appendChild(style);
    }

    showLoadingState();

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        const response = await fetch(
            `${API_ENDPOINTS.SCHEDULES}?startDate=${startDate}&endDate=${endDate}`,
            {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
            }
        );

        if (!response.ok) {
            throw new Error('获取课程安排失败');
        }

        const schedules = await response.json();
        cachedSchedules = Array.isArray(schedules) ? schedules : [];
        renderSchedules(weekDates, cachedSchedules);
        showInlineFeedback(elements.feedback(), '', 'info');
    } catch (error) {
        console.error('加载学生课程安排失败', error);
        renderEmptyState(EMPTY_STATES.schedules);
        showInlineFeedback(elements.feedback(), '加载课程安排失败，请稍后重试', 'error');
    }
}

function renderSchedules(weekDates, schedules) {
    const grouped = groupSchedulesByDate(weekDates, schedules);

    // 检测是否为移动端
    if (isMobileView()) {
        renderMobileScheduleTable(weekDates, grouped);
    } else {
        renderHeader(weekDates);
        renderBody(weekDates, schedules);
    }
}

function groupSchedulesByDate(weekDates, schedules) {
    const grouped = new Map();
    weekDates.forEach(date => grouped.set(toISODate(date), []));

    schedules.forEach(item => {
        const keyCandidates = [
            item.date,
            item.start_date,
            item.lesson_date,
            item.schedule_date
        ];
        const key = keyCandidates
            .map(normalizeDateKey)
            .find(Boolean);
        if (!key) return;
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(item);
    });

    grouped.forEach(list => list.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || '')));
    return grouped;
}

// 检测移动端视口
function isMobileView() {
    return window.innerWidth <= 768;
}

// 移动端2列7行表格渲染
function renderMobileScheduleTable(weekDates, grouped) {
    const container = document.querySelector('#schedules .table-container');
    if (!container) return;

    clearChildren(container);

    // 创建表格（不添加标题）
    const table = createElement('table', 'mobile-schedule-table');

    // 创建表头
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const dateHeader = createElement('th', '', { textContent: '日期' });
    const detailsHeader = createElement('th', '', { textContent: '课程详情' });
    headerRow.appendChild(dateHeader);
    headerRow.appendChild(detailsHeader);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // 创建表体
    const tbody = document.createElement('tbody');
    weekDates.forEach(date => {
        const iso = toISODate(date);
        const row = document.createElement('tr');

        // 日期列
        const day = date.getDate();
        const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const weekday = weekdayNames[date.getDay()];
        const dateLabel = `${day}/${weekday}`;
        const dateCell = createElement('td', 'mobile-date-cell', { textContent: dateLabel });
        row.appendChild(dateCell);

        // 课程详情列
        const detailsCell = createElement('td', 'mobile-details-cell');
        const dailySchedules = grouped.get(iso) || [];

        if (dailySchedules.length === 0) {
            const empty = createElement('div', 'no-schedule', { textContent: '暂无排课' });
            detailsCell.appendChild(empty);
        } else {
            // 聚合课程
            const aggregatedGroups = groupSchedulesByTimeAndLocation(dailySchedules);

            aggregatedGroups.forEach((group, index) => {
                const detail = buildAggregatedScheduleCard(group, true); // true for mobile style adjustments if needed
                detailsCell.appendChild(detail);
                // 添加分隔线（除了最后一个）
                if (index < aggregatedGroups.length - 1) {
                    const divider = createElement('hr', 'schedule-divider');
                    divider.style.cssText = 'margin: 8px 0; border: none; border-top: 1px solid #e9ecef;';
                    detailsCell.appendChild(divider);
                }
            });
        }

        row.appendChild(detailsCell);
        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    container.appendChild(table);
}

// 构建移动端课程详情块
function buildMobileScheduleDetail(schedule) {
    // 课程类型
    const typeCode = schedule.schedule_type || '';
    const typeLabel = schedule.schedule_type_cn || getScheduleTypeLabel(typeCode);
    let typeClass = 'type-default';
    if (typeLabel.includes('入户')) typeClass = 'type-visit';
    else if (typeLabel.includes('试教')) typeClass = 'type-trial';
    else if (typeLabel.includes('评审')) typeClass = 'type-review';
    else if (typeLabel.includes('半次')) typeClass = 'type-half-visit';
    else if (typeLabel.includes('集体')) typeClass = 'type-group-activity';

    // 状态
    const status = (schedule.status || 'pending').toLowerCase();
    const displayStatus = getDisplayStatus(schedule);

    // 获取时间段（用于背景色）
    const slotId = getTimeSlotId(schedule.start_time);
    const slotClass = slotId ? `slot-${slotId}` : 'slot-unspecified';

    // 创建卡片容器（使用 group-picker-item 保持与PC端一致的样式）
    const detail = createElement('div', `group-picker-item ${slotClass} status-${status}`);
    // 移除内联样式，使用 group-picker-item 的 CSS
    detail.style.cssText = 'display: flex; flex-direction: column; gap: 8px; align-items: stretch;';

    // 信息容器（第一行：教师，类型，时间，地点）
    const infoContainer = createElement('div', '', {
        style: 'font-size: 15px; line-height: 1.6; font-weight: 500;' // Increased font size
    });

    // 构建信息文本：教师，类型，时间，地点
    const teacherText = schedule.teacher_name || '未分配教师';
    const timeText = formatTimeRange(schedule.start_time, schedule.end_time);
    const locationText = schedule.location || '上课地点未确定';

    // 教师名称
    const teacherSpan = createElement('span', '', {
        textContent: teacherText,
        style: 'font-weight: 500;'
    });
    infoContainer.appendChild(teacherSpan);
    infoContainer.appendChild(document.createTextNode('，'));

    // 课程类型chip
    const typeChip = createElement('span', `chip ${typeClass}`, {
        textContent: typeLabel
    });
    infoContainer.appendChild(typeChip);
    infoContainer.appendChild(document.createTextNode('，'));

    // 时间
    infoContainer.appendChild(document.createTextNode(timeText));
    infoContainer.appendChild(document.createTextNode('，'));

    // 地点
    const locationSpan = createElement('span', '', {
        textContent: locationText
    });
    if (!schedule.location) {
        locationSpan.style.color = '#9ca3af';
        locationSpan.style.fontStyle = 'italic';
    }
    infoContainer.appendChild(locationSpan);

    detail.appendChild(infoContainer);

    // 状态行（第二行：居中显示状态）
    const statusRow = createElement('div', '', {
        style: 'display: flex; justify-content: center; margin-top: 4px;'
    });

    const statusChip = createElement('span', `chip status-${status}`, {
        textContent: displayStatus,
        style: 'font-size: 14px; padding: 4px 12px; border-radius: 999px; font-weight: 500; display: inline-block;' // Increased from 12px
    });

    statusRow.appendChild(statusChip);
    detail.appendChild(statusRow);

    return detail;
}

function renderHeader(weekDates) {
    const thead = elements.header();
    if (!thead) return;
    clearChildren(thead);

    const row = document.createElement('tr');

    // Remove Teacher Name Header for Single-Row View
    // const nameHeader = createElement('th', 'name-col-header', { textContent: '老师姓名' });
    // row.appendChild(nameHeader);

    // Date Headers
    weekDates.forEach(date => {
        const iso = toISODate(date);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const weekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekday = weekdayNames[date.getDay()];

        const th = createElement('th', 'date-header');
        th.dataset.date = iso;
        th.innerHTML = `
            <div class="date-label">${month}月${day}日</div>
            <div class="day-label">${weekday}</div>
        `;
        row.appendChild(th);
    });
    thead.appendChild(row);
}

function renderBody(weekDates, schedules) {
    const tbody = elements.body();
    if (!tbody) return;
    clearChildren(tbody);

    if (!schedules || schedules.length === 0) {
        renderFullEmptyState(weekDates);
        return;
    }

    // Single Row Layout
    const row = document.createElement('tr');

    // Iterate Dates directly
    weekDates.forEach(date => {
        const iso = toISODate(date);
        const cell = createElement('td', 'schedule-cell');

        // Filter schedules for this date from the flat list
        const dailySchedules = schedules.filter(s => {
            const sDate = s.date || s.lesson_date || s.start_date || s.schedule_date;
            return normalizeDateKey(sDate) === iso;
        });

        if (dailySchedules.length > 0) {
            dailySchedules.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

            // Group by Time/Location
            const groups = groupSchedulesBySlot(dailySchedules);
            groups.forEach(group => {
                cell.appendChild(buildScheduleCard(group));
            });
        } else {
            const empty = createElement('div', 'no-schedule-dash', { textContent: '-' });
            cell.appendChild(empty);
        }
        row.appendChild(cell);
    });

    tbody.appendChild(row);
}

function renderFullEmptyState(weekDates) {
    const tbody = elements.body();
    const row = document.createElement('tr');
    row.appendChild(createElement('td', 'sticky-col', { textContent: '-' }));
    weekDates.forEach(() => {
        const cell = createElement('td', 'schedule-cell');
        cell.appendChild(createElement('div', 'no-schedule-dash', { textContent: '-' }));
        row.appendChild(cell);
    });
    tbody.appendChild(row);
}

// --------------------------------------------------------------------------
// End of Body Rendering
// --------------------------------------------------------------------------


// --------------------------------------------------------------------------
// Card Rendering Helpers
// --------------------------------------------------------------------------

/**
 * 将排课记录按时间/地点分组 (学生端聚合逻辑)
 */
// --------------------------------------------------------------------------
// End of Body Rendering
// --------------------------------------------------------------------------


// --------------------------------------------------------------------------
// Card Rendering Helpers
// --------------------------------------------------------------------------

/**
 * 将排课记录按时间/地点分组 (学生端聚合逻辑)
 */
function groupSchedulesBySlot(schedules) {
    const slots = new Map();
    schedules.forEach(s => {
        const key = `${s.start_time}-${s.end_time}-${s.location || ''}`;
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push(s);
    });
    return Array.from(slots.values());
}

/**
 * 构建排课卡片 (仿照管理员端样式 - 学生只读版)
 * @param {Array} group 相同时间/地点的排课记录组
 */
function buildScheduleCard(group) {
    if (!group || !group.length) return document.createElement('div');
    const first = group[0];

    // 1. 时间槽逻辑 (早/中/晚)
    let slot = 'morning';
    const h = parseInt((first.start_time || '00:00').substring(0, 2), 10);
    if (h >= 12) slot = 'afternoon';
    if (h >= 19) slot = 'evening';

    // Force colors to ensure visual match regardless of CSS issues
    const colors = {
        morning: { bg: '#DBEAFE', border: '#93C5FD' },
        afternoon: { bg: '#FEF3C7', border: '#FCD34D' },
        evening: { bg: '#F3E8FF', border: '#D8B4FE' }
    };
    const theme = colors[slot];

    const card = createElement('div', `schedule-card-group slot-${slot}`);
    card.style.backgroundColor = theme.bg;
    card.style.borderColor = theme.border;
    card.style.borderWidth = '1px';
    card.style.borderStyle = 'solid';

    // 内容容器
    const content = createElement('div', 'card-content');

    // 2. 排课记录列表
    const listDiv = createElement('div', 'schedule-list');

    group.forEach(rec => {
        const row = createElement('div', 'schedule-row');
        const st = (rec.status || 'pending').toLowerCase();

        // 左侧：老师姓名 + 课程类型 (Marquee)
        const left = createElement('div', 'row-left marquee-wrapper');

        let typeStr = rec.schedule_type_cn || rec.schedule_type || '课程';
        // Try to resolve CN name using Store if available
        if (window.ScheduleTypesStore && window.ScheduleTypesStore.getAll) {
            const allTypes = window.ScheduleTypesStore.getAll();
            // Match by ID (course_id) or Code string (schedule_type)
            const found = allTypes.find(t =>
                (rec.course_id && t.id == rec.course_id) ||
                (rec.schedule_type && t.name === rec.schedule_type)
            );
            if (found) typeStr = found.description || found.name;
        }

        // Match Admin HTML structure exactly
        const marqueeContent = createElement('div', 'marquee-content');
        marqueeContent.innerHTML = `
            <span class="teacher-name">${rec.teacher_name || '未分派'}</span>
            <span class="course-type-text">(${typeStr})</span>
        `;
        left.appendChild(marqueeContent);
        row.appendChild(left);

        // 右侧：状态显示 (Green tag for confirmed, Gray for completed)
        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消' };
        const statusLabel = statusMap[st] || st;

        // Use styled span to mimic the look of the admin select but readonly
        const statusTag = createElement('span', `status-select ${st}`, {
            textContent: statusLabel,
            style: 'pointer-events: none; border:none; appearance:none; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 500; display: inline-flex; align-items: center; justify-content: center; height: 24px;'
        });

        // Specific color overrides based on image analysis
        if (st === 'confirmed') {
            statusTag.style.backgroundColor = '#dcfce7'; // Light Green
            statusTag.style.color = '#166534'; // Dark Green Text
        } else if (st === 'completed') {
            statusTag.style.backgroundColor = '#f3f4f6'; // Gray
            statusTag.style.color = '#4b5563'; // Dark Gray Text
        }

        row.appendChild(statusTag);

        listDiv.appendChild(row);
    });
    content.appendChild(listDiv);

    // 3. 底部信息 (时间和地点)
    const footer = createElement('div', 'schedule-footer');
    const timeRange = formatTimeRange(first.start_time, first.end_time);
    const loc = first.location || '';

    // Match Admin Footer Style (Boxed location?)
    // Based on image, it looks like simple text similar to admin
    footer.innerHTML = `
        <div class="time-text">${timeRange}</div>
        <div class="location-text">${loc}</div>
    `;
    content.appendChild(footer);
    card.appendChild(content);

    // 4. 学生确认交互 (如果组内有待确认项目)
    const hasPending = group.some(r => (r.status || 'pending').toLowerCase() === 'pending');
    if (hasPending) {
        const confirmBtn = createElement('button', 'btn small-btn primary-btn', {
            textContent: '确认课程',
            style: 'margin: 0 10px 10px 10px; width: calc(100% - 20px); border:none; border-radius:8px; background:#10B981; color:white; padding:8px; font-weight:600; cursor:pointer;'
        });
        confirmBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const firstPending = group.find(r => (r.status || 'pending').toLowerCase() === 'pending');
            if (firstPending) handleConfirmSchedule(firstPending.id);
        });
        card.appendChild(confirmBtn);
    }

    return card;
}

async function handleConfirmSchedule(scheduleId) {
    try {
        const response = await fetch(`${API_ENDPOINTS.CONFIRM_SCHEDULE}/${scheduleId}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });

        if (!response.ok) {
            throw new Error('确认课程失败');
        }

        showInlineFeedback(elements.feedback(), '课程确认成功', 'success');
        loadSchedules(currentWeekStart);
    } catch (error) {
        handleApiError(error, '确认课程失败');
    }
}

function renderEmptyState(message) {
    const tbody = elements.body();
    if (!tbody) return;
    clearChildren(tbody);
    const row = document.createElement('tr');
    const cell = createElement('td', 'no-schedule', { textContent: message });
    cell.colSpan = 8;
    cell.style.textAlign = 'center';
    row.appendChild(cell);
    tbody.appendChild(row);
}

function updateWeekRangeLabel(weekDates) {
    const labelEl = elements.rangeLabel();
    if (!labelEl || weekDates.length === 0) return;
    setText(labelEl, formatWeekRangeText(weekDates[0], weekDates[weekDates.length - 1]));
}

export function refreshSchedules() {
    return loadSchedules(currentWeekStart);
}

function getDisplayStatus(schedule) {
    const status = (schedule.status || '').toLowerCase();
    const statusMap = {
        'pending': '待确认',
        'confirmed': '已确认',
        'completed': '已完成',
        'cancelled': '已取消'
    };
    return statusMap[status] || status;
}

function showLoadingState() {
    const tbody = elements.body();
    if (!tbody) return;
    clearChildren(tbody);
    const row = document.createElement('tr');
    const cell = createElement('td', 'loading-cell', { textContent: '加载中...' });
    cell.colSpan = 8;
    cell.style.textAlign = 'center';
    row.appendChild(cell);
    tbody.appendChild(row);
}
