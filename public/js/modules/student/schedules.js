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

/**
 * 统一的教师排序函数
 * 规则:
 * 1. 特殊课程类型(评审、咨询)的教师排在最后
 * 2. 其他教师按ID由小到大排序
 */
function sortTeachersByIdAndType(scheduleA, scheduleB) {
    const getTypeName = (item) => (
        item.schedule_type_name ||
        item.type_name ||
        item.schedule_type_cn ||
        item.schedule_types ||
        item.schedule_type || ''
    ).toString();

    const isSpecial = (name) => name.includes('评审') || name.includes('咨询');

    const typeA = getTypeName(scheduleA);
    const typeB = getTypeName(scheduleB);
    const specialA = isSpecial(typeA);
    const specialB = isSpecial(typeB);

    // 特殊课程类型排在最后
    if (specialA && !specialB) return 1;
    if (!specialA && specialB) return -1;

    // 其他按教师ID由小到大排序
    return (scheduleA.teacher_id || 0) - (scheduleB.teacher_id || 0);
}

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
    // 尝试多种选择器，优先使用.schedule-unified-card
    let container = document.querySelector('#schedules .schedule-unified-card');
    if (!container) {
        container = document.querySelector('.schedule-unified-card');
    }
    if (!container) {
        container = document.querySelector('#schedules .table-container');
    }
    if (!container) {
        container = document.querySelector('.table-container');
    }
    if (!container) {
        console.warn('[Mobile Schedule] Container not found');
        return;
    }

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
        const dateCell = createElement('td', 'mobile-date-cell', { textContent: dateLabel });
        row.appendChild(dateCell);

        // 课程详情列
        const detailsCell = createElement('td', 'mobile-details-cell');
        const dailySchedules = grouped.get(iso) || [];

        if (dailySchedules.length === 0) {
            const empty = createElement('div', 'no-schedule', { textContent: '暂无排课' });
            detailsCell.appendChild(empty);
        } else {
            // 按时间和地点分组（合并相同时间地点的课程）
            const aggregatedGroups = groupSchedulesBySlot(dailySchedules);

            aggregatedGroups.forEach((group, index) => {
                // 对组内课程进行排序（特殊课程类型排最后，其他按教师ID排序）
                group.sort(sortTeachersByIdAndType);

                // 统一使用紧凑格式卡片（不再区分单个或多个）
                const card = buildCompactMobileScheduleCard(group);
                detailsCell.appendChild(card);

                // 添加分隔线（除了最后一个组）
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


/**
 * 构建移动端紧凑格式排课卡片（学生端）
 * 格式：教师1（类型chip，状态chip），教师2（类型chip，状态chip），时间，地点（灰色）
 * @param {Array} scheduleGroup 排课记录组（可以是单个或多个）
 * @returns {HTMLElement} 紧凑格式的排课卡片DOM元素
 */
function buildCompactMobileScheduleCard(scheduleGroup) {
    if (!scheduleGroup || scheduleGroup.length === 0) {
        return document.createElement('div');
    }

    const first = scheduleGroup[0];
    const slotId = getTimeSlotId(first.start_time);
    const slotClass = slotId ? `slot-${slotId}` : 'slot-unspecified';

    // 创建卡片容器，保持时间槽颜色
    const card = createElement('div', `group-picker-item ${slotClass}`);
    // 使用默认的 display: block 以确保文本像句子一样自动换行，而不是像flex items那样整个换行
    // 注意：CSS中可能定义了 display: flex !important 或 min-height !important，所以这里需要强制覆盖
    card.style.cssText = 'padding: 12px; line-height: 1.8; word-wrap: break-word; overflow-wrap: break-word; display: block !important; min-height: auto !important;';

    // 为每位教师创建信息块：姓名（类型chip，状态chip）
    scheduleGroup.forEach((schedule, index) => {
        const teacherName = schedule.teacher_name || '未分配教师';
        const typeCode = schedule.schedule_type || '';
        const typeLabel = schedule.schedule_type_cn || getScheduleTypeLabel(typeCode);
        const status = (schedule.status || 'pending').toLowerCase();
        const statusLabel = getDisplayStatus(schedule);

        // 确定课程类型的CSS类
        let typeClass = 'type-default';
        if (typeLabel.includes('入户')) typeClass = 'type-visit';
        else if (typeLabel.includes('试教')) typeClass = 'type-trial';
        else if (typeLabel.includes('评审')) typeClass = 'type-review';
        else if (typeLabel.includes('半次')) typeClass = 'type-half-visit';
        else if (typeLabel.includes('集体')) typeClass = 'type-group-activity';

        // 教师名称
        const nameSpan = createElement('span', '', {
            textContent: teacherName,
            style: 'font-weight: 500; font-size: 15px;'
        });
        card.appendChild(nameSpan);

        // 左括号
        card.appendChild(document.createTextNode('（'));

        // 课程类型chip
        const typeChip = createElement('span', `chip ${typeClass}`, {
            textContent: typeLabel
        });
        card.appendChild(typeChip);

        // 逗号
        card.appendChild(document.createTextNode('，'));

        // 状态chip
        const statusChip = createElement('span', `chip status-${status}`, {
            textContent: statusLabel
        });
        card.appendChild(statusChip);

        // 右括号
        card.appendChild(document.createTextNode('）'));

        // 如果不是最后一个，添加逗号和空格
        if (index < scheduleGroup.length - 1) {
            card.appendChild(document.createTextNode('，'));
        }
    });

    // 添加逗号分隔符
    card.appendChild(document.createTextNode('，'));

    // 时间
    const timeText = formatTimeRange(first.start_time, first.end_time);
    const timeSpan = createElement('span', '', {
        textContent: timeText,
        style: 'font-size: 15px; font-weight: 500;'
    });
    card.appendChild(timeSpan);

    // 添加逗号
    card.appendChild(document.createTextNode('，'));

    // 地点（灰色字体）
    const loc = first.location || '';
    const locSpan = createElement('span', '', {
        innerHTML: loc ? loc : '<span style="font-style: italic; color: #94a3b8;">地点待定</span>',
        style: 'color: #9CA3AF; font-size: 14px;'
    });
    card.appendChild(locSpan);

    return card;
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
        th.dataset.date = iso;
        th.innerHTML = `
            <div class="date-label">${month}月${day}日${lunarLabel}</div>
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
                // 使用统一的排序函数
                group.sort(sortTeachersByIdAndType);
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

    // 使用统一的排序函数:特殊课程类型(评审/咨询)排在最后,其他按教师ID排序
    group.sort(sortTeachersByIdAndType);

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

        const nameSpan = createElement('span', 'teacher-name', {
            textContent: rec.teacher_name || '未指定'
        });
        nameSpan.style.cssText = 'flex-shrink: 0; white-space: nowrap;';

        const marqueeWrapper = createElement('div', 'marquee-wrapper');
        marqueeWrapper.style.cssText = 'flex: 1; min-width: 0; max-width: none;';

        const marqueeContent = createElement('div', 'marquee-content');
        marqueeContent.style.paddingRight = '0';
        marqueeContent.innerHTML = `<span class="course-type-text">(${typeStr})</span>`;

        marqueeWrapper.appendChild(marqueeContent);
        left.appendChild(nameSpan);
        left.appendChild(marqueeWrapper);
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

        // Checkmark for completed status
        if (st === 'completed') {
            const checkmark = createElement('div', 'completed-checkmark-icon');
            // Ensure relative positioning context if needed, but row usually has it or we might need to adjust CSS
            // The row is `schedule-row`. Let's check CSS for `schedule-row`.
            // If `schedule-row` is relatively positioned, absolute child works.
            // If not, we might need to make it relative.
            row.style.position = 'relative';
            row.appendChild(checkmark);
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
    const locationHtml = loc ?
        `<div class="location-text">${loc}</div>` :
        `<div class="location-text" style="font-style: italic; color: #94a3b8;">地点待定</div>`;

    footer.innerHTML = `
        <div class="time-text">${timeRange}</div>
        ${locationHtml}
    `;
    content.appendChild(footer);
    card.appendChild(content);

    // 4. 学生确认交互 (如果组内有待确认项目)
    // 4. 学生确认交互 (移除所有状态的确认按钮 Task 29)
    // const hasPending = group.some(r => (r.status || 'pending').toLowerCase() === 'pending');
    // if (hasPending) { ... }

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

    // Create 5 skeleton rows
    for (let i = 0; i < 5; i++) {
        const row = document.createElement('tr');
        row.className = 'schedule-loading-row';

        /* 
        // Single row layout (Student View) might just be 8 columns or 1 + 7 
        // Student view typically has just days? Let's check renderBody logic.
        // renderBody uses: row -> 7 cells (or maybe 1 + 7 if sticky col is used for empty state)
        // renderEmptyState uses colSpan=8. 
        // Let's assume 8 columns to match Admin-like structure or just fill the width.
        */

        for (let j = 0; j < 8; j++) {
            const cell = document.createElement('td');
            const skeleton = document.createElement('div');
            skeleton.className = 'skeleton-loader';
            skeleton.style.margin = '4px';
            cell.appendChild(skeleton);
            row.appendChild(cell);
        }
        tbody.appendChild(row);
    }
}
