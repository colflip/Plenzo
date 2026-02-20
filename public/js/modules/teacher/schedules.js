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
        renderBody(weekDates, schedules); // 修复此处，应传递原始 schedules 数组给矩阵渲染函数
    }
}

// 检测移动端视口
function isMobileView() {
    return window.innerWidth <= 768;
}

// 移动端2列7行表格渲染
function renderMobileScheduleTable(weekDates, grouped) {
    // 尝试多种选择器，确保能找到容器
    // 教师端使用 schedule-unified-card，学生端使用 table-container
    let container = document.querySelector('#schedules .schedule-unified-card');
    if (!container) {
        container = document.querySelector('#schedules .weekly-schedule-table')?.parentElement;
    }
    if (!container) {
        container = document.querySelector('.table-container');
    }
    if (!container) {
        console.warn('[Mobile Schedule] 容器未找到');
        return;
    }

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
            // 按时间和地点分组（合并相同时间地点的课程）
            const aggregatedGroups = groupSchedulesBySlot(dailySchedules);

            aggregatedGroups.forEach((group, index) => {
                // 对组内课程进行排序（特殊课程类型排最后，其他按学生ID排序）
                group.sort(sortStudentsByIdAndType);

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
 * 构建移动端紧凑格式排课卡片（教师端）
 * 格式：学生1（类型chip，状态chip），学生2（类型chip，状态chip），时间，地点（灰色）
 * @param {Array} scheduleGroup 排课记录组（可以是单个或多个）
 * @returns {HTMLElement} 紧凑格式的排课卡片DOM元素
 */
function buildCompactMobileScheduleCard(scheduleGroup) {
    if (!scheduleGroup || scheduleGroup.length === 0) {
        return document.createElement('div');
    }

    const first = scheduleGroup[0];
    const slotId = getTimeSlotFromStartTime(first.start_time);
    const slotClass = slotId ? `slot-${slotId}` : 'slot-unspecified';

    // 创建卡片容器，保持时间槽颜色
    const card = createElement('div', `group-picker-item ${slotClass}`);
    // 使用默认的 display: block 以确保文本像句子一样自动换行，而不是像flex items那样整个换行
    // 注意：CSS中可能定义了 display: flex !important 或 min-height !important，所以这里需要强制覆盖
    card.style.cssText = 'padding: 12px; line-height: 1.8; word-wrap: break-word; overflow-wrap: break-word; display: block !important; min-height: auto !important;';

    // 为每个学生创建信息块：姓名（类型chip，状态chip）
    scheduleGroup.forEach((schedule, index) => {
        const studentName = schedule.student_name || '未分配学生';
        const typeLabel = getScheduleTypeLabel(schedule.schedule_type || schedule.course_type);
        const status = (schedule.status || 'pending').toLowerCase();
        const statusLabel = getStatusLabel(status);

        // 确定课程类型的CSS类
        let typeClass = 'type-default';
        if (typeLabel.includes('入户')) typeClass = 'type-visit';
        else if (typeLabel.includes('试教')) typeClass = 'type-trial';
        else if (typeLabel.includes('评审')) typeClass = 'type-review';
        else if (typeLabel.includes('半次')) typeClass = 'type-half-visit';
        else if (typeLabel.includes('集体')) typeClass = 'type-group-activity';

        // 学生名称
        const nameSpan = createElement('span', '', {
            textContent: studentName,
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

        // 如果不是最后一个，添加逗号
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
    const locationText = first.location || DEFAULT_LOCATION_PLACEHOLDER;
    const locationSpan = createElement('span', '', {
        textContent: locationText,
        style: 'color: #9CA3AF; font-size: 14px;'
    });
    card.appendChild(locationSpan);

    return card;
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

    // Remove Student Name Header for Single-Row View
    // const nameHeader = createElement('th', 'name-col-header', { textContent: '学生姓名' });
    // row.appendChild(nameHeader);

    // Date Headers
    weekDates.forEach(date => {
        const iso = toISODate(date);
        const year = date.getFullYear();
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

    // No Sticky Col
    // row.appendChild(createElement('td', 'sticky-col', { textContent: '-' }));

    weekDates.forEach(() => {
        const cell = createElement('td', 'schedule-cell');
        cell.appendChild(createElement('div', 'no-schedule-dash', { textContent: '-' }));
        row.appendChild(cell);
    });
    tbody.appendChild(row);
}

/**
 * 将排课记录按时间/地点分组 (仿管理员端逻辑)
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
 * 构建排课卡片 (仿照管理员端样式)
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

    // 2. 排课记录列表 (支持多条合并)
    const listDiv = createElement('div', 'schedule-list');

    group.forEach(rec => {
        const row = createElement('div', 'schedule-row');
        row.title = '点击修改详情';
        row.style.cursor = 'pointer';

        // 点击行打开编辑弹窗 (原有逻辑)
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            showStatusActionSheet(rec, card);
        });

        // 左侧：学生姓名 + 课程类型
        const left = createElement('div', 'row-left');
        const typeStr = rec.schedule_type_cn || rec.schedule_type || '课程';

        const nameSpan = createElement('span', 'teacher-name', {
            textContent: rec.student_name || '未指定'
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

        // 右侧：状态快速切换 (教师端可见)
        const st = (rec.status || 'pending').toLowerCase();
        const statusSelect = createElement('select', `status-select ${st}`);
        statusSelect.dataset.lastStatus = st;

        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消' };

        Object.keys(statusMap).forEach(key => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = statusMap[key];
            if (key === st) opt.selected = true;
            statusSelect.appendChild(opt);
        });

        // 阻止点击下拉框触发行的编辑弹窗
        statusSelect.addEventListener('click', (e) => e.stopPropagation());

        statusSelect.addEventListener('change', async (e) => {
            e.stopPropagation();
            const newStatus = e.target.value;
            const oldStatus = statusSelect.dataset.lastStatus;

            // 乐观更新
            statusSelect.className = `status-select ${newStatus}`;
            statusSelect.blur();

            try {
                // 调用现有的状态更新方法
                await updateScheduleStatus(rec.id, newStatus);
                statusSelect.dataset.lastStatus = newStatus;
                showInlineFeedback(elements.feedback(), '状态更新成功', 'success');
            } catch (err) {
                // 回滚
                statusSelect.value = oldStatus;
                statusSelect.className = `status-select ${oldStatus}`;
                showInlineFeedback(elements.feedback(), '更新失败', 'error');
            }
        });

        row.appendChild(statusSelect);
        listDiv.appendChild(row);
    });
    content.appendChild(listDiv);

    // 3. 底部信息 (时间和地点)
    const footer = createElement('div', 'schedule-footer');

    // Time Logic: Show range of the group (usually same, but take first)
    // Admin uses: 19:00 - 22:00
    const timeRange = `${first.start_time ? first.start_time.substring(0, 5) : ''} - ${first.end_time ? first.end_time.substring(0, 5) : ''}`;
    const loc = first.location || '';

    footer.innerHTML = `
        <div class="time-text">${timeRange}</div>
        <div class="location-text">${loc}</div>
    `;
    content.appendChild(footer);

    card.appendChild(content);
    return card;
}

/**
 * 更新课程状态 (使用 window.apiUtils 保持一致)
 */
async function updateScheduleStatus(id, newStatus) {
    if (!window.apiUtils) {
        throw new Error('apiUtils 未就绪');
    }
    const response = await window.apiUtils.put(`/teacher/schedules/${id}/status`, {
        status: newStatus
    });

    if (response && response.error) {
        throw new Error(response.message || '更新失败');
    }
    return response;
}

function showStatusActionSheet(schedule, card) {
    const status = (schedule.status || 'pending').toLowerCase();
    showActionSheet(
        '修改课程状态',
        SCHEDULE_STATUS_OPTIONS.map(opt => ({
            label: opt.label,
            value: opt.value,
            selected: opt.value === status
        })),
        async (newStatus) => {
            if (newStatus !== status) {
                await handleStatusChange(schedule.id, newStatus, card, null, null);
            }
        }
    );
}

// --------------------------------------------------------------------------
// End of Build Schedule Card
// --------------------------------------------------------------------------


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
    cell.style.textAlign = 'center';
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
// 排序排课记录：特殊类型排最后，其他按学生ID排序
function sortStudentsByIdAndType(a, b) {
    // 1. 特殊类型排最后 (评审, 咨询)
    // 教师端数据可能用 course_type 或 schedule_type
    const typeA = String(a.schedule_type || a.course_type || '');
    const typeB = String(b.schedule_type || b.course_type || '');

    const specialTypes = ['review', 'advisory', 'review-online', 'advisory-online'];
    const aIsSpecial = specialTypes.includes(typeA);
    const bIsSpecial = specialTypes.includes(typeB);

    if (aIsSpecial && !bIsSpecial) return 1;
    if (!aIsSpecial && bIsSpecial) return -1;

    // 2. 按学生ID排序
    return (a.student_id || 0) - (b.student_id || 0);
}

export function refreshSchedules() {
    return loadSchedules(currentWeekStart);
}
