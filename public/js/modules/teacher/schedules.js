import { SCHEDULE_STATUS_OPTIONS, getScheduleTypeLabel } from './constants.js';
import { getScheduleWatermarkText } from '../shared/schedule-helpers.js';
import { showTableLoading, hideTableLoading } from '../shared/loading-ui.js';
import { renderTableErrorRow } from '../shared/error-ui.js';
import {
    appendScheduleWatermark,
    groupSchedulesBySlot,
    bindWeekNavigation,
    setupWeekViewExportButton,
    updateTeacherScheduleStatus as updateScheduleStatus
} from '../shared/schedule-view-utils.js';
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
    showActionSheet,
    startOfWeek
} from './utils.js';
const { escapeHtml, safeSetHTML } = window.SecurityUtils;



// 导入时间槽工具函数
import { getTimeSlotFromStartTime } from './time-slots.js';
import { captureWeekTableToClipboard, captureWeekMobileViewToClipboard } from '../../components/schedule-view-capture.js';

let currentWeekStart = null;
let cachedSchedules = [];
let scheduleLoadSeq = 0;

window.teacherShowPlan = false;

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
    syncShowPlanButton();
    bindWeekViewExportButton();
    await loadSchedules(currentWeekStart);
}

function bindWeekViewExportButton() {
    setupWeekViewExportButton({
        buttonId: 'exportTeacherWeekViewBtn',
        onClick: exportWeekView
    });
}

// 导出本周视图：先弹「视图选择」窗口（默认移动端），选完再截图到剪贴板。
// 移动端长图是临时渲染、截完即弃，页面版式本身不变。
function exportWeekView() {
    window.ScheduleExportDialog.openViewChoice({
        label: '本周课表',
        onChoose: async (view) => {
            if (view === 'mobile') {
                await exportMobileWeekView();
            } else {
                captureWeekTableToClipboard({ label: '本周课表' });
            }
        }
    });
}

// 把本周数据渲染成移动端日卡片长图（离屏渲染，页面版式不受影响）
async function exportMobileWeekView() {
    const weekDates = getWeekDates(currentWeekStart || startOfWeek(new Date()));
    await captureWeekMobileViewToClipboard({
        weekDates,
        schedules: cachedSchedules || [],
        scopeId: 'schedules',
        label: '本周课表',
        options: {
            personName: s => s.student_name || '未分配学生',
            typeLabel: s => getScheduleTypeLabel(s.schedule_type || s.course_type),
            editableStatus: true,
            formatTimeRange,
            sortGroup: sortStudentsByIdAndType,
            onStatusChange: (schedule, newStatus) => updateScheduleStatus(schedule.id, newStatus, schedule.teacher_uid),
            onStatusChanged: (err, message) => {
                const fb = document.getElementById('scheduleFeedback');
                if (fb) showInlineFeedback(fb, message, err ? 'error' : 'success');
            },
            emptyText: '暂无排课'
        }
    });
}

window.toggleTeacherShowPlan = async function () {
    window.teacherShowPlan = !window.teacherShowPlan;
    syncShowPlanButton();
    await loadSchedules(currentWeekStart || startOfWeek(new Date()), true);
};

function syncShowPlanButton() {
    const btn = document.getElementById('toggleTeacherShowPlanBtn');
    const text = document.getElementById('teacherShowPlanBtnText');
    if (text) text.textContent = window.teacherShowPlan ? '隐藏全部安排' : '显示全部安排';
    if (btn) {
        const isActive = !!window.teacherShowPlan;
        const color = isActive ? '#ef4444' : '#2ECC71';
        btn.classList.toggle('schedule-toggle-active', isActive);
        btn.setAttribute('aria-pressed', String(isActive));
        btn.style.backgroundColor = color;
        btn.style.borderColor = color;
        btn.style.color = '#fff';
    }
}

function bindNavigation() {
    bindWeekNavigation({
        prevBtn: elements.prevWeekBtn(),
        nextBtn: elements.nextWeekBtn(),
        onPrev: () => {
            currentWeekStart.setDate(currentWeekStart.getDate() - 7);
            loadSchedules(currentWeekStart);
        },
        onNext: () => {
            currentWeekStart.setDate(currentWeekStart.getDate() + 7);
            loadSchedules(currentWeekStart);
        }
    });
}

export async function loadSchedules(baseDate, showLoading = true) {
    const requestId = ++scheduleLoadSeq;
    const weekStart = startOfWeek(baseDate);
    currentWeekStart = weekStart;
    const weekDates = getWeekDates(weekStart);
    updateWeekRangeLabel(weekDates);

    // Inject custom styles for single-row view to fix sticky first column issue
    if (!document.getElementById('single-row-fix-style')) {
        const style = document.createElement('style');
        style.id = 'single-row-fix-style';
        style.innerHTML = `
            /* 单行视图：首格不再 sticky。
               表头首格与其它日期表头同为浅灰 #F8F9FA（修复首格白底不一致）；
               表体首格保持透明，与同行其它单元格一致。 */
            #schedules .weekly-schedule-table thead th:first-child {
                width: auto !important;
                position: static !important;
                background-color: #F8F9FA !important;
                border-right: 1px solid #E5E7EB !important;
                z-index: auto !important;
                min-width: 140px; /* Essential for cell width consistency */
            }
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

    // 获取表格容器
    const tableContainer = document.querySelector('#schedules .schedule-unified-card');

    // 1. 先渲染表头，以便加载动画能正确探测高度
    renderHeader(weekDates);
    }

    // 2. 显示加载动画
    if (showLoading && tableContainer) {
        showTableLoading(tableContainer, '正在加载课程安排数据...', '#weeklyHeader');
    }

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        const schedules = await window.apiUtils.get('/teacher/schedules', {
            startDate,
            endDate,
            ...(window.teacherShowPlan ? { show_plan: 'true' } : {})
        });

        if (!Array.isArray(schedules)) {
            throw new Error('课程安排响应格式无效');
        }
        cachedSchedules = schedules;
        if (requestId !== scheduleLoadSeq) return;
        renderSchedules(weekDates, cachedSchedules);
        showInlineFeedback(elements.feedback(), '', 'info');
    } catch (error) {
        if (requestId !== scheduleLoadSeq) return;
        renderScheduleErrorState(weekDates, currentWeekStart, error);
        showInlineFeedback(elements.feedback(), '加载课程安排失败，请点击重试', 'error');
    } finally {
        // 3. 加载完成后隐藏动画
        if (requestId === scheduleLoadSeq && showLoading && tableContainer) {
            hideTableLoading(tableContainer);
        }
    }
}

function renderSchedules(weekDates, schedules) {
    renderHeader(weekDates);
    renderBody(weekDates, schedules); // 修复此处，应传递原始 schedules 数组给矩阵渲染函数
}

function renderHeader(weekDates) {
    const thead = elements.header();
    if (!thead) return;
    clearChildren(thead);

    const row = document.createElement('tr');

    // Remove Student Name Header for Single-Row View

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
        
        const dateLabel = createElement('div', 'date-label');
        dateLabel.textContent = `${month}月${day}日`;
        
        const dayLabel = createElement('div', 'day-label', { textContent: weekday });
        th.appendChild(dateLabel);
        th.appendChild(dayLabel);
        const metaEl = window.ScheduleDateLabels?.createHeaderMetaElement(date);
        if (metaEl) th.appendChild(metaEl);
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

    weekDates.forEach(() => {
        const cell = createElement('td', 'schedule-cell');
        cell.appendChild(createElement('div', 'no-schedule-dash', { textContent: '-' }));
        row.appendChild(cell);
    });
    tbody.appendChild(row);
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

    // 检测是否整组取消
    const isAllCancelled = group.every(rec => (rec.status || '').toLowerCase() === 'cancelled');

    const card = createElement('div', `schedule-card-group slot-${slot}${isAllCancelled ? ' status-cancelled' : ''}`);

    appendScheduleWatermark(card, getScheduleWatermarkText(group));
    card.style.backgroundColor = theme.bg;
    card.style.borderColor = theme.border;
    card.style.borderWidth = '1px';
    card.style.borderStyle = 'solid';

    // 内容容器
    const content = createElement('div', 'card-content');

    // 排序逻辑改进：
    // 1. 优先展示“正常/已确认/已完成”的课程，将“已调整(modified_away)”或“已取消”的排在后面
    group.sort((a, b) => {
        const getStatus = (item) => (item.status || 'pending').toLowerCase();
        const statusA = getStatus(a);
        const statusB = getStatus(b);
        
        const isInactive = (s) => s === 'modified_away' || s === 'cancelled';
        const inactiveA = isInactive(statusA);
        const inactiveB = isInactive(statusB);

        if (inactiveA && !inactiveB) return 1;
        if (!inactiveA && inactiveB) return -1;
        return 0;
    });

    // 2. 排课记录列表 (支持多条合并)
    const listDiv = createElement('div', 'schedule-list');

    group.forEach(rec => {
        const st = (rec.status || 'pending').toLowerCase();
        const row = createElement('div', 'schedule-row');
        if (st === 'cancelled') row.classList.add('status-cancelled');
        else if (st === 'modified_away') row.classList.add('status-modified_away');
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
        const typeSpan = createElement('span', 'course-type-text', {
            textContent: typeStr
        });
        marqueeContent.appendChild(typeSpan);

        marqueeWrapper.appendChild(marqueeContent);
        left.appendChild(nameSpan);
        left.appendChild(marqueeWrapper);
        row.appendChild(left);

        // 右侧：状态快速切换 (教师端可见)
        const statusSelect = createElement('select', `status-select ${st}`);
        statusSelect.dataset.lastStatus = st;

        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消', 'modified_away': '已调整' };

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

            statusSelect.disabled = true;
            statusSelect.blur();

            try {
                // 远程优先：先同步数据库，成功后再更新本地UI
                await updateScheduleStatus(rec.id, newStatus, rec.teacher_uid);
                statusSelect.className = `status-select ${newStatus}`;
                statusSelect.dataset.lastStatus = newStatus;
                showInlineFeedback(elements.feedback(), '状态更新成功', 'success');
            } catch (err) {
                statusSelect.value = oldStatus;
                statusSelect.className = `status-select ${oldStatus}`;
                showInlineFeedback(elements.feedback(), '更新失败', 'error');
            } finally {
                statusSelect.disabled = false;
            }
        });

        row.appendChild(statusSelect);
        listDiv.appendChild(row);
    });
    content.appendChild(listDiv);

    // 3. 底部信息
    const footer = createElement('div', 'schedule-footer');

    const timeRange = `${first.start_time ? first.start_time.substring(0, 5) : ''} - ${first.end_time ? first.end_time.substring(0, 5) : ''}`;
    const loc = first.location || '';

    const timeDiv = createElement('div', 'time-text', { textContent: timeRange });
    const locDiv = createElement('div', 'location-text', {
        textContent: loc,
        style: 'flex:1;'
    });
    footer.appendChild(timeDiv);
    footer.appendChild(locDiv);

    // 费用在「费用管理」（fees）页统一管理，此处不再渲染费用按钮（2026-09-07）

    footer.style.display = 'flex';
    footer.style.alignItems = 'center';

    content.appendChild(footer);

    card.appendChild(content);
    return card;
}

/**
 * 更新课程状态 (使用 window.apiUtils 保持一致)
 */
// updateScheduleStatus 由 shared/schedule-view-utils.js 提供（别名导入）

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
                await handleStatusChange(schedule.id, newStatus, card, null, schedule.teacher_uid);
            }
        }
    );
}

// --------------------------------------------------------------------------
// End of Build Schedule Card
// --------------------------------------------------------------------------


function renderScheduleErrorState(weekDates, weekStart, error) {
    // 错误态一律用桌面表展示（含行内重试）
    renderHeader(weekDates);

    const tbody = elements.body();
    if (!tbody) return;
    // 统一错误态（shared/error-ui.js）替代内联样式的错误行
    renderTableErrorRow(tbody, {
        colspan: 7,
        error,
        title: '课程安排加载失败',
        detail: null,
        onRetry: () => loadSchedules(weekStart, true),
        retryText: '重试'
    });
}

function updateWeekRangeLabel(weekDates) {
    const labelEl = elements.rangeLabel();
    if (!labelEl || weekDates.length === 0) return;
    setText(labelEl, formatWeekRangeText(weekDates[0], weekDates[weekDates.length - 1]));
}

// startOfWeek is imported from ../shared/schedule-helpers.js


// 处理状态修改 (for mobile view)
async function handleStatusChange(scheduleId, newStatus, cardElement, statusSelect, teacherUid) {
    const originalStatus = statusSelect ? statusSelect.value : null;

    try {
        // 禁用选择器防止重复操作
        if (statusSelect) {
            statusSelect.disabled = true;
            statusSelect.style.opacity = '0.6';
        }

        // 调用API更新状态（与桌面端共用 pair 级端点，需带上 teacher_uid）
        await updateScheduleStatus(scheduleId, newStatus, teacherUid);

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

