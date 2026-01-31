import { DEFAULT_LOCATION_PLACEHOLDER, EMPTY_STATES, SCHEDULE_STATUS_OPTIONS, getScheduleTypeLabel, getStatusLabel } from './constants.js';
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
    showActionSheet
} from './utils.js';



// 导入时间槽工具函数
import { getTimeSlotFromStartTime } from './utils/time-slots.js';

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
    elements.prevWeekBtn()?.addEventListener('click', () => {
        currentWeekStart.setDate(currentWeekStart.getDate() - 7);
        loadSchedules(currentWeekStart);
    });
    elements.nextWeekBtn()?.addEventListener('click', () => {
        currentWeekStart.setDate(currentWeekStart.getDate() + 7);
        loadSchedules(currentWeekStart);
    });
}

export async function loadSchedules(baseDate) {
    const weekStart = startOfWeek(baseDate);
    currentWeekStart = weekStart;
    const weekDates = getWeekDates(weekStart);
    updateWeekRangeLabel(weekDates);
    showLoadingState();

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        const schedules = await window.apiUtils.get('/teacher/schedules', {
            startDate,
            endDate
        });

        cachedSchedules = Array.isArray(schedules) ? schedules : [];
        renderSchedules(weekDates, cachedSchedules);
        showInlineFeedback(elements.feedback(), '', 'info');
    } catch (error) {
        console.error('加载教师课程安排失败', error);
        renderEmptyState(EMPTY_STATES.schedules);
        showInlineFeedback(elements.feedback(), '加载课程安排失败，请稍后重试', 'error');
    }
}

function renderSchedules(weekDates, schedules) {
    const grouped = groupSchedulesByDate(weekDates, schedules);

    // 检测移动端视口
    if (isMobileView()) {
        renderMobileScheduleTable(weekDates, grouped);
    } else {
        renderHeader(weekDates);
        renderBody(weekDates, grouped);
    }
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

    // 创建表格
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
            dailySchedules.forEach((schedule, index) => {
                const detail = buildMobileScheduleDetail(schedule);
                detailsCell.appendChild(detail);
                // 添加分隔线（除了最后一个）
                if (index < dailySchedules.length - 1) {
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

// 构建移动端课程详情块（教师端：包含状态修改功能）
function buildMobileScheduleDetail(schedule) {
    // 课程类型
    const typeLabel = getScheduleTypeLabel(schedule.schedule_type || schedule.course_type);

    // 确定课程类型的CSS类（用于chip颜色）
    let typeClass = 'type-default';
    if (typeLabel.includes('入户')) typeClass = 'type-visit';
    else if (typeLabel.includes('试教')) typeClass = 'type-trial';
    else if (typeLabel.includes('评审')) typeClass = 'type-review';
    else if (typeLabel.includes('半次')) typeClass = 'type-half-visit';
    else if (typeLabel.includes('集体')) typeClass = 'type-group-activity';

    // 状态
    const status = (schedule.status || 'pending').toLowerCase();
    const displayStatus = getStatusLabel(status);

    // 获取时间段（用于背景色）
    const slotId = getTimeSlotFromStartTime(schedule.start_time);
    const slotClass = slotId ? `slot-${slotId}` : 'slot-unspecified';

    // 创建卡片容器（使用 group-picker-item 保持与学生端一致的样式）
    const detail = createElement('div', `group-picker-item ${slotClass} status-${status}`);
    detail.style.cssText = 'display: flex; flex-direction: column; gap: 8px; align-items: stretch;';

    // 信息容器（第一行：学生，类型，时间，地点）
    const infoContainer = createElement('div', '', {
        style: 'font-size: 13px; line-height: 1.6;'
    });

    // 构建信息文本：学生，类型，时间，地点
    const studentText = schedule.student_name || '未分配学生';
    const timeText = formatTimeRange(schedule.start_time, schedule.end_time);
    const locationText = schedule.location || DEFAULT_LOCATION_PLACEHOLDER;

    // 学生名称
    const studentSpan = createElement('span', '', {
        textContent: studentText,
        style: 'font-weight: 500;'
    });
    infoContainer.appendChild(studentSpan);
    infoContainer.appendChild(document.createTextNode('，'));

    // 课程类型chip（应用颜色类）
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

    // 状态行（第二行：可交互的状态选择器，样式化为chip）
    const statusRow = createElement('div', '', {
        style: 'display: flex; justify-content: center; margin-top: 4px;'
    });

    // 1. 视觉层：完全复刻学生端的样式 (span)
    // 添加点击反馈样式
    const visualChip = createElement('span', `chip status-${status}`, {
        textContent: displayStatus,
        style: 'font-size: 12px; padding: 4px 16px; border-radius: 999px; font-weight: 500; display: inline-block; cursor: pointer; transition: opacity 0.2s;'
    });

    // 添加点击效果
    visualChip.onmousedown = () => visualChip.style.opacity = '0.7';
    visualChip.onmouseup = () => visualChip.style.opacity = '1';
    visualChip.onmouseleave = () => visualChip.style.opacity = '1';
    visualChip.ontouchstart = () => visualChip.style.opacity = '0.7';
    visualChip.ontouchend = () => visualChip.style.opacity = '1';

    visualChip.addEventListener('click', () => {
        showActionSheet(
            '修改课程状态',
            SCHEDULE_STATUS_OPTIONS.map(opt => ({
                label: opt.label,
                value: opt.value,
                selected: opt.value === status
            })),
            async (newStatus) => {
                if (newStatus !== status) {
                    // 乐观更新视觉层
                    const newLabel = getStatusLabel(newStatus);
                    visualChip.textContent = newLabel;
                    visualChip.className = `chip status-${newStatus}`;

                    // 调用原有逻辑处理状态变更
                    // 注意：handleStatusChange 可能需要 statusSelect 参数，这里传 null，需要确认 handleStatusChange 内部是否处理了 null
                    await handleStatusChange(schedule.id, newStatus, detail, null, null);
                }
            }
        );
    });

    statusRow.appendChild(visualChip);
    detail.appendChild(statusRow);

    return detail;
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

function renderHeader(weekDates) {
    const thead = elements.header();
    if (!thead) return;
    clearChildren(thead);

    const row = document.createElement('tr');
    weekDates.forEach(date => {
        const iso = toISODate(date);
        const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
        const weekday = weekdayNames[date.getDay() === 0 ? 6 : date.getDay() - 1];
        const label = `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')}\n${weekday}`;
        const th = createElement('th', '', { textContent: label });
        th.dataset.date = iso;
        row.appendChild(th);
    });
    thead.appendChild(row);
}

function renderBody(weekDates, grouped) {
    const tbody = elements.body();
    if (!tbody) return;
    clearChildren(tbody);

    const row = document.createElement('tr');
    weekDates.forEach(date => {
        const iso = toISODate(date);
        const cell = createElement('td', 'schedule-cell');

        // 添加日期标签（格式：日/星期）
        const day = date.getDate();
        const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const weekday = weekdayNames[date.getDay()];
        const dateLabel = `${day}/${weekday}`;
        cell.setAttribute('data-date-label', dateLabel);

        const dailySchedules = grouped.get(iso) || [];
        if (dailySchedules.length === 0) {
            const empty = createElement('div', 'no-schedule', { textContent: '暂无排课' });
            cell.appendChild(empty);
        } else {
            dailySchedules.forEach(schedule => {
                cell.appendChild(buildScheduleCard(schedule));
            });
        }
        row.appendChild(cell);
    });
    tbody.appendChild(row);
}

function buildScheduleCard(schedule) {
    const status = (schedule.status || 'pending').toLowerCase();

    // Determine time slot from start_time
    const timeSlot = getTimeSlotFromStartTime(schedule.start_time);
    const timeSlotClass = timeSlot ? `slot-${timeSlot}` : 'slot-unspecified';

    // Container: Flex column layout
    const card = createElement('div', `group-picker-item ${timeSlotClass} status-${status}`);
    card.dataset.scheduleId = schedule.id;
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '8px';
    card.style.padding = '8px 10px';

    // 1. Info Row (Student, Type, Time, Location)
    const infoRow = document.createElement('div');
    infoRow.style.fontSize = '13px';
    infoRow.style.lineHeight = '1.6'; // Increased line height for chips
    infoRow.style.color = '#333';
    // Removed flex styles to allow natural text flow
    // infoRow.style.display = 'flex';
    // infoRow.style.flexWrap = 'wrap';
    // infoRow.style.alignItems = 'center';

    // Resolve Chinese type name using shared utility
    let typeLabel = getScheduleTypeLabel(schedule.course_id || schedule.schedule_type_id || schedule.type_id);

    // If result is just a number (ID not found in store) or empty, try falling back to other fields
    if (!typeLabel || /^\d+$/.test(typeLabel) || typeLabel === '未分类') {
        typeLabel = getScheduleTypeLabel(schedule.schedule_type_cn || schedule.schedule_type || '课程');
    }

    // Determine CSS class for background color
    let typeClass = 'type-default';
    if (typeLabel.includes('入户')) typeClass = 'type-visit';
    else if (typeLabel.includes('试教')) typeClass = 'type-trial';
    else if (typeLabel.includes('评审')) typeClass = 'type-review';
    else if (typeLabel.includes('半次')) typeClass = 'type-half-visit';
    else if (typeLabel.includes('集体')) typeClass = 'type-group-activity';

    // Apply type class to card for background
    card.classList.add(typeClass);

    // Build Info Row Elements
    const studentName = schedule.student_name || '未指定';
    const timeRange = formatTimeRange(schedule.start_time, schedule.end_time);
    const location = schedule.location ? schedule.location : '';

    // Student Name
    const nameNode = document.createElement('span');
    nameNode.textContent = studentName + '，';
    infoRow.appendChild(nameNode);

    // Type Chip
    const typeChip = document.createElement('span');
    typeChip.className = `chip ${typeClass}`;
    typeChip.textContent = typeLabel;
    // Override/Ensure chip styles for inline flow
    typeChip.style.display = 'inline-flex';
    typeChip.style.alignItems = 'center';
    typeChip.style.justifyContent = 'center';
    typeChip.style.padding = '2px 8px';
    typeChip.style.borderRadius = '999px';
    typeChip.style.fontSize = '11px';
    typeChip.style.lineHeight = '1.2';
    typeChip.style.margin = '0 2px'; // Small margin for spacing
    typeChip.style.verticalAlign = 'middle';
    infoRow.appendChild(typeChip);

    // Separator after Type
    infoRow.appendChild(document.createTextNode('，'));

    // Time
    const timeNode = document.createElement('span');
    timeNode.textContent = timeRange;
    infoRow.appendChild(timeNode);

    // Location
    if (location) {
        infoRow.appendChild(document.createTextNode('，' + location));
    }

    card.appendChild(infoRow);

    // 2. Status Row (Centered) - Clickable status chip with dropdown
    const statusRow = document.createElement('div');
    statusRow.style.display = 'flex';
    statusRow.style.justifyContent = 'center';
    statusRow.style.width = '100%';
    statusRow.style.marginTop = '4px';
    statusRow.style.position = 'relative';

    // Status chip (clickable)
    const statusChip = document.createElement('span');
    statusChip.className = `chip status-${status}`;
    statusChip.textContent = getStatusLabel(status);
    statusChip.style.cssText = `
        cursor: pointer;
        font-size: 12px;
        padding: 4px 16px;
        border-radius: 999px;
        font-weight: 500;
        min-width: 80px;
        text-align: center;
        user-select: none;
        transition: opacity 0.2s;
    `;
    statusChip.dataset.scheduleId = schedule.id;
    statusChip.dataset.currentStatus = status;

    // Dropdown menu (hidden by default)
    const dropdown = document.createElement('div');
    dropdown.className = 'status-dropdown';
    dropdown.style.cssText = `
        display: none;
        position: absolute;
        top: 100%;
        left: 50%;
        transform: translateX(-50%);
        margin-top: 4px;
        background: white;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        z-index: 1000;
        min-width: 120px;
        overflow: hidden;
    `;

    SCHEDULE_STATUS_OPTIONS.forEach(opt => {
        const option = document.createElement('div');
        option.className = 'status-option';
        option.textContent = opt.label;
        option.dataset.value = opt.value;
        option.style.cssText = `
            padding: 8px 16px;
            cursor: pointer;
            font-size: 13px;
            transition: background-color 0.2s;
            ${opt.value === status ? 'background-color: #f3f4f6; font-weight: 600;' : ''}
        `;

        option.addEventListener('mouseenter', () => {
            if (opt.value !== status) {
                option.style.backgroundColor = '#f9fafb';
            }
        });

        option.addEventListener('mouseleave', () => {
            if (opt.value !== status) {
                option.style.backgroundColor = 'white';
            }
        });

        option.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (opt.value !== status) {
                dropdown.style.display = 'none';
                await handleStatusUpdate(schedule.id, opt.value, card, statusChip, dropdown);
            } else {
                dropdown.style.display = 'none';
            }
        });

        dropdown.appendChild(option);
    });

    // Toggle dropdown on chip click
    statusChip.addEventListener('click', (e) => {
        e.stopPropagation();
        const isVisible = dropdown.style.display === 'block';

        // Close all other dropdowns
        document.querySelectorAll('.status-dropdown').forEach(d => {
            if (d !== dropdown) d.style.display = 'none';
        });

        dropdown.style.display = isVisible ? 'none' : 'block';
    });

    statusRow.appendChild(statusChip);
    statusRow.appendChild(dropdown);
    card.appendChild(statusRow);

    return card;
}

async function handleStatusUpdate(scheduleId, newStatus, card, select) {
    if (!scheduleId) return;

    const normalizedStatus = String(newStatus ?? '').trim().toLowerCase();

    // Disable interaction
    if (select) select.disabled = true;

    try {
        const requestId = Number(scheduleId);
        const endpointId = Number.isNaN(requestId) ? scheduleId : requestId;

        await window.apiUtils.patch(`/teacher/schedules/${endpointId}`, {
            status: normalizedStatus
        });

        // Update UI classes immediately
        // Update card status class
        card.classList.remove('status-pending', 'status-confirmed', 'status-completed', 'status-cancelled');
        card.classList.add(`status-${normalizedStatus}`);

        // Update select/chip status class
        if (select) {
            select.classList.remove('status-pending', 'status-confirmed', 'status-completed', 'status-cancelled');
            select.classList.add(`status-${normalizedStatus}`);
            select.disabled = false;
        }

        showInlineFeedback(elements.feedback(), '课程状态已更新', 'success');

        // Reload to ensure full sync
        loadSchedules(currentWeekStart);

    } catch (error) {
        console.error('更新状态失败:', error);
        showInlineFeedback(elements.feedback(), '更新状态失败，请重试', 'error');
        if (select) select.disabled = false;
    }
}


function applyStatusUpdate(card, status) {
    card.classList.remove('status-pending', 'status-confirmed', 'status-completed', 'status-cancelled');
    if (status) {
        card.classList.add(`status-${status}`);
    }
    const badge = card.querySelector('.course-status-badge');
    if (badge) {
        if (status) {
            badge.className = `course-status-badge status-${status}`;
            badge.textContent = getStatusLabel(status);
        }
    }
}

function renderEmptyState(message) {
    renderHeader([]);
    const tbody = elements.body();
    if (!tbody) return;
    clearChildren(tbody);
    const row = document.createElement('tr');
    const cell = createElement('td', 'no-schedule', { textContent: message });
    cell.colSpan = 7;
    row.appendChild(cell);
    tbody.appendChild(row);
}

function showLoadingState() {
    const tbody = elements.body();
    if (!tbody) return;
    clearChildren(tbody);
    const row = document.createElement('tr');
    const cell = createElement('td', 'no-schedule', { textContent: '加载中...' });
    cell.colSpan = 7;
    row.appendChild(cell);
    tbody.appendChild(row);
}

function updateWeekRangeLabel(weekDates) {
    const labelEl = elements.rangeLabel();
    if (!labelEl || weekDates.length === 0) return;
    setText(labelEl, formatWeekRangeText(weekDates[0], weekDates[weekDates.length - 1]));
}

function startOfWeek(date) {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
}


// 处理状态修改 (for mobile view)
// 处理状态修改 (for mobile view)
async function handleStatusChange(scheduleId, newStatus, cardElement, statusSelect, _unused) {
    const originalStatus = statusSelect ? statusSelect.value : null;

    try {
        // 禁用选择器防止重复操作
        if (statusSelect) {
            statusSelect.disabled = true;
            statusSelect.style.opacity = '0.6';
        }

        // 调用API更新状态
        const response = await window.apiUtils.put(`/teacher/schedules/${scheduleId}/status`, {
            status: newStatus
        });

        if (!response || response.error) {
            throw new Error(response?.message || '状态更新失败');
        }

        // 更新UI - 更新select的class以反映新状态
        if (statusSelect) {
            statusSelect.className = `status-select-mobile chip status-${newStatus}`;
        }

        // 更新卡片状态类
        cardElement.className = cardElement.className.replace(/status-\w+/, `status-${newStatus}`);

        // 显示成功提示
        showInlineFeedback(elements.feedback(), '课程状态已更新', 'success');

        // 3秒后清除提示
        setTimeout(() => {
            showInlineFeedback(elements.feedback(), '', 'info');
        }, 3000);

    } catch (error) {
        console.error('更新课程状态失败:', error);

        // 恢复原状态
        if (statusSelect && originalStatus) {
            statusSelect.value = originalStatus;
        }

        // 显示错误提示
        showInlineFeedback(elements.feedback(), '状态更新失败，请稍后重试', 'error');

        setTimeout(() => {
            showInlineFeedback(elements.feedback(), '', 'info');
        }, 3000);
    } finally {
        // 重新启用选择器
        if (statusSelect) {
            statusSelect.disabled = false;
            statusSelect.style.opacity = '1';
        }
    }
}

// Add global click listener to close dropdowns when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.status-dropdown') && !e.target.closest('.chip')) {
        document.querySelectorAll('.status-dropdown').forEach(dropdown => {
            dropdown.style.display = 'none';
        });
    }
});

export function refreshSchedules() {
    return loadSchedules(currentWeekStart);
}
