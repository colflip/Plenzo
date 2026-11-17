import { API_ENDPOINTS } from './constants.js';
import { getScheduleWatermarkText } from '../shared/schedule-helpers.js';
import { renderTableErrorRow } from '../shared/error-ui.js';
import { showTableLoading, hideTableLoading } from '../shared/loading-ui.js';
import { captureWeekTableToClipboard, captureWeekMobileViewToClipboard } from '../../components/schedule-view-capture.js';
import {
    appendScheduleWatermark,
    buildCardTeacherArea,
    groupSchedulesBySlot,
    bindWeekNavigation,
    setupWeekViewExportButton
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
    handleApiError,
    startOfWeek
} from './utils.js';
const { escapeHtml, safeSetHTML } = window.SecurityUtils;

let currentWeekStart = null;
let cachedSchedules = [];
let scheduleLoadSeq = 0;

window.studentShowPlan = false;

// 老师排序统一走 schedule-view-utils.js 的 buildMergedCategoryLabel
// （记录类沉底 + teacher_id 升序），本地不再保留一份副本。

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
    bindShowPlanButton();
    syncShowPlanButton();
    bindWeekViewExportButton();
    await loadSchedules(currentWeekStart);
}

function bindWeekViewExportButton() {
    setupWeekViewExportButton({
        buttonId: 'exportStudentWeekViewBtn',
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
            personName: s => s.teacher_name || '未分配教师',
            editableStatus: false,
            formatTimeRange,
            emptyText: '暂无排课'
        }
    });
}

window.toggleStudentShowPlan = async function () {
    window.studentShowPlan = !window.studentShowPlan;
    syncShowPlanButton();
    await loadSchedules(currentWeekStart || startOfWeek(new Date()), true);
};

function syncShowPlanButton() {
    const btn = document.getElementById('toggleStudentShowPlanBtn');
    const text = document.getElementById('studentShowPlanBtnText');
    if (text) text.textContent = window.studentShowPlan ? '隐藏全部安排' : '显示全部安排';
    if (btn) {
        const isActive = !!window.studentShowPlan;
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

function bindShowPlanButton() {
    const btn = document.getElementById('toggleStudentShowPlanBtn');
    if (btn && !btn.__showPlanBound) {
        btn.addEventListener('click', () => {
            window.toggleStudentShowPlan();
        });
        btn.__showPlanBound = true;
    }
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

    // 1. 先渲染表头，消除导航时"头身不一致"的中间状态
    renderHeader(weekDates);

    // 2. 显示加载动画（与教师端保持一致）
    if (showLoading && tableContainer) {
        showTableLoading(tableContainer, '正在加载课程安排数据...', '#weeklyHeader');
    }

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        const endpoint = String(API_ENDPOINTS.SCHEDULES).replace(/^\/api/, '');
        const schedules = await window.apiUtils.get(endpoint, {
            startDate,
            endDate,
            ...(window.studentShowPlan ? { show_plan: 'true' } : {})
        });
        if (!Array.isArray(schedules)) {
            throw new Error('课程列表响应格式无效');
        }
        cachedSchedules = schedules;
        if (requestId !== scheduleLoadSeq) return;
        renderSchedules(weekDates, cachedSchedules);
        showInlineFeedback(elements.feedback(), '', 'info');
    } catch (error) {
        if (requestId !== scheduleLoadSeq) return;

        renderTableErrorRow(elements.body(), {
            colspan: 7,
            error,
            title: '课程安排加载失败',
            onRetry: () => loadSchedules(currentWeekStart, true)
        });
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
    renderBody(weekDates, schedules);
}

function renderHeader(weekDates) {
    const thead = elements.header();
    if (!thead) return;
    clearChildren(thead);

    const row = document.createElement('tr');

    // Remove Teacher Name Header for Single-Row View

    // Date Headers
    weekDates.forEach(date => {
        const iso = toISODate(date);
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
                // 老师排序在 buildMergedCategoryLabel 内统一处理（记录类沉底 + teacher_id 升序）
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
    // 学生端单行布局不需要左侧教师姓名列 (sticky-col)，直接渲染 7 天
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

    appendScheduleWatermark(card, getScheduleWatermarkText(group));

    // 内容容器
    const content = createElement('div', 'card-content');

    // 2. 人员区：单人一行「姓名 授课类型 状态」；多人时评审/咨询族、集体活动
    //    内联（类型名在前），其它类型每行一位老师。学生端只读：状态是纯标签。
    const listDiv = createElement('div', 'schedule-list');

    const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消', 'modified_away': '已调整' };

    const teacherArea = buildCardTeacherArea(group, {
        personName: (rec) => rec.teacher_name || '未指定',
        buildStatusNode: (rec) => {
            const st = (rec.status || 'pending').toLowerCase();
            if (!statusMap[st]) return null;
            return createElement('span', `status-select ${st}`, {
                textContent: statusMap[st],
                style: 'pointer-events: none; border:none; appearance:none; padding: 4px 12px; border-radius: 999px; font-size: var(--fs-300); font-weight: 500; display: inline-flex; align-items: center; justify-content: center; height: 24px;'
            });
        }
    });
    listDiv.appendChild(teacherArea);
    content.appendChild(listDiv);

    // 3. 底部信息 (时间和地点)
    const footer = createElement('div', 'schedule-footer');
    const timeRange = formatTimeRange(first.start_time, first.end_time);
    const loc = first.location || '';

    const timeDiv = createElement('div', 'time-text', { textContent: timeRange });
    footer.appendChild(timeDiv);

    if (loc) {
        const locDiv = createElement('div', 'location-text', { textContent: loc });
        footer.appendChild(locDiv);
    } else {
        const locDiv = createElement('div', 'location-text', {
            textContent: '地点待定',
            style: 'font-style: italic; color: #94a3b8;'
        });
        footer.appendChild(locDiv);
    }
    content.appendChild(footer);
    card.appendChild(content);

    return card;
}

function renderEmptyState(message) {
    const tbody = elements.body();
    if (!tbody) return;
    clearChildren(tbody);
    const row = document.createElement('tr');
    const cell = createElement('td', 'no-schedule', { textContent: message });
    cell.colSpan = 7; // 学生端为 7 列
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


