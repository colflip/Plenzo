// public/js/modules/teacher/student-schedules.js

import { STATUS_LABELS } from '../student/constants.js';
import { getScheduleTypeLabel } from './constants.js';
import { isMobileView, getScheduleWatermarkText } from '../shared/schedule-helpers.js';
import { showTableLoading, hideTableLoading } from '../shared/loading-ui.js';
import { syncToggleButton } from '../shared/view-utils.js';
import { renderTableErrorRow } from '../shared/error-ui.js';
import {
    appendScheduleWatermark,
    groupSchedulesBySlot,
    bindWeekNavigation,
    updateTeacherScheduleStatus as updateScheduleStatus
} from '../shared/schedule-view-utils.js';
import {
    clearChildren,
    createElement,
    formatTimeRange,
    getWeekDates,
    toISODate,
    startOfWeek,
    formatWeekRangeText,
    showInlineFeedback,
    normalizeDateKey
} from '../student/utils.js';

let currentWeekStart = null;
let cachedSchedules = [];
let cachedStudents = [];
let scheduleLoadSeq = 0;

// 全局：班主任学生排课「显示全部安排」开关，默认隐藏
window.teacherStudentShowPlan = false;

window.toggleTeacherStudentShowPlan = async function () {
    window.teacherStudentShowPlan = !window.teacherStudentShowPlan;
    syncShowPlanButton();
    await loadSchedules(currentWeekStart || startOfWeek(new Date()), true);
};

function syncShowPlanButton() {
    const btnText = document.getElementById('teacherStudentShowPlanBtnText');
    const toggleBtn = document.getElementById('toggleTeacherStudentShowPlanBtn');
    if (btnText) btnText.textContent = window.teacherStudentShowPlan ? '隐藏全部安排' : '显示全部安排';
    syncToggleButton(toggleBtn, window.teacherStudentShowPlan);
}

export async function initStudentSchedulesSection() {
    currentWeekStart = currentWeekStart || startOfWeek(new Date());

    syncShowPlanButton();
    bindNavigation();

    // 导出学生数据按钮的点击事件已由 action-delegate.js 通过 data-action="export-teacher-students" 统一委托处理

    // 绑定导出本周视图按钮
    const exportWeeklyBtn = document.getElementById('exportWeeklyViewBtn');
    if (exportWeeklyBtn) {
        if (!exportWeeklyBtn.__exportWeeklyBound) {
            exportWeeklyBtn.addEventListener('click', () => {
                if (typeof window.exportWeeklyScheduleView !== 'function') {
                    if (window.apiUtils) window.apiUtils.showToast('导出组件未加载', 'error');
                    return;
                }
                window.exportWeeklyScheduleView('teacher').catch(err => {
                    if (window.apiUtils) {
                        window.apiUtils.showToast('导出失败: ' + err.message, 'error');
                    }
                });
            });
            exportWeeklyBtn.__exportWeeklyBound = true;
        }
    }

    await loadSchedules(currentWeekStart);
}

function bindNavigation() {
    bindWeekNavigation({
        prevBtn: document.getElementById('ssPrevWeek'),
        nextBtn: document.getElementById('ssNextWeek'),
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

export async function refreshStudentSchedules() {
    if (currentWeekStart) {
        await loadSchedules(currentWeekStart);
    }
}

async function loadSchedules(baseDate, showLoading = true) {
    const requestId = ++scheduleLoadSeq;
    const weekStart = startOfWeek(baseDate);
    currentWeekStart = weekStart;
    const weekDates = getWeekDates(weekStart);

    const rangeLabel = document.getElementById('ssWeekRange');
    if (rangeLabel) rangeLabel.textContent = formatWeekRangeText(weekDates[0], weekDates[weekDates.length - 1]);

    // 获取表格容器
    const tableContainer = document.querySelector('#student-schedules .schedule-unified-card');

    // 1. 先渲染表头，以便加载动画能正确探测高度
    if (!isMobileView()) {
        renderTableHeader(weekDates);
    }

    // 2. 显示加载动画
    if (showLoading && tableContainer) {
        showTableLoading(tableContainer, '正在加载学生课程安排数据...', '#ssWeeklyHeader');
    }

    const feedback = document.getElementById('ssScheduleFeedback');

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        const response = await fetch(
            `/api/teacher/student-schedules?startDate=${startDate}&endDate=${endDate}${window.teacherStudentShowPlan ? '&show_plan=true' : ''}`,
            {
                credentials: 'include',
                headers: {}
            }
        );

        if (!response.ok) {
            throw new Error('获取学生课程安排失败');
        }

        const data = await response.json();
        // 兼容新格式 { students, schedules } 和旧格式（纯数组）
        if (data && data.schedules) {
            cachedStudents = data.students || [];
            cachedSchedules = Array.isArray(data.schedules) ? data.schedules : [];
        } else {
            cachedStudents = [];
            cachedSchedules = Array.isArray(data) ? data : [];
        }
        if (requestId !== scheduleLoadSeq) return;
        renderSchedulesGrid(weekDates, cachedSchedules, cachedStudents);
        showInlineFeedback(feedback, '', '');
    } catch (error) {
        if (requestId !== scheduleLoadSeq) return;

        // 统一错误态（shared/error-ui.js）：保留表格结构 + 行内重试
        const body = document.getElementById('ssWeeklyBody');
        if (body) {
            renderTableErrorRow(body, {
                colspan: 8,
                error,
                title: '课程安排加载失败',
                detail: null,
                onRetry: () => loadSchedules(currentWeekStart || new Date()),
                retryText: '重试'
            });
        }
        showInlineFeedback(feedback, '加载课程安排失败，请点击重试', 'error');
    } finally {
        // 3. 加载完成后隐藏动画
        if (requestId === scheduleLoadSeq && showLoading && tableContainer) {
            hideTableLoading(tableContainer);
        }
    }
}

function renderSchedulesGrid(weekDates, schedules, students = []) {
    if (!document.getElementById('teacher-ss-fixing-style')) {
        const style = document.createElement('style');
        style.id = 'teacher-ss-fixing-style';
        style.innerHTML = `
            /* ===== 首列（学生姓名）：与表头行 / 数据行视觉一致 =====
               取消 sticky 定位与多余阴影；表头首格用与其它日期表头相同的浅灰，
               数据首格透明（与同行排课单元格一致）。 */
            #student-schedules .weekly-schedule-table thead th:first-child,
            #student-schedules .weekly-schedule-table tbody td:first-child {
                min-width: 120px !important;
                width: 120px !important;
                text-align: center !important;
                vertical-align: middle !important;
                padding: 16px 12px !important;
                font-size: var(--fs-300) !important;
                position: static !important;
                left: auto !important;
                z-index: auto !important;
                box-shadow: none !important;
                border-right: 1px dashed #CBD5E1 !important;
            }

            /* 表头首格：与其它日期表头一致（浅灰底 + 表头底部分隔线） */
            #student-schedules .weekly-schedule-table thead th:first-child {
                background-color: #F8F9FA !important;
                border-bottom: 2px solid #E5E7EB !important;
                font-weight: 600 !important;
                color: #1F2937 !important;
            }

            /* 数据首格（学生姓名）：透明底，与同行其它单元格一致 */
            #student-schedules .weekly-schedule-table tbody td:first-child {
                background-color: transparent !important;
                font-size: var(--fs-300) !important;
                font-weight: 600 !important;
            }

            /* 行 hover：首列跟随整行（与其它列一致） */
            #student-schedules .weekly-schedule-table tbody tr:hover td:first-child {
                background-color: rgba(241, 245, 249, 0.5) !important;
            }

            /* Allow full location text & variable height */
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
                min-height: 100px;
            }
        `;
        document.head.appendChild(style);
    }

    if (isMobileView()) {
        renderMobileScheduleTable(weekDates, schedules);
    } else {
        renderDesktopScheduleTable(weekDates, schedules, students);
    }
}


function renderDesktopScheduleTable(weekDates, schedules, students = []) {
    const tbody = document.getElementById('ssWeeklyBody');
    if (!tbody) return;

    // 渲染表头并获取 thead
    renderTableHeader(weekDates);

    clearChildren(tbody);

    // 2. 渲染表体
    // 用后端返回的学生列表构建完整行（即使该学生本周无排课也显示空行）
    // 先将排课数据按学生ID分组
    const schedulesByStudent = {};
    schedules.forEach(s => {
        const studentId = s.student_id;
        if (!schedulesByStudent[studentId]) {
            schedulesByStudent[studentId] = { schedulesByDate: {} };
            weekDates.forEach(d => schedulesByStudent[studentId].schedulesByDate[toISODate(d)] = []);
        }
        const dateKey = normalizeDateKey(s.date);
        if (schedulesByStudent[studentId].schedulesByDate[dateKey]) {
            schedulesByStudent[studentId].schedulesByDate[dateKey].push(s);
        }
    });

    // 构建学生列表：优先使用后端返回的完整学生列表，兼容旧格式
    let uniqueStudents;
    if (students.length > 0) {
        // 使用后端返回的完整学生列表（包含无排课的学生）
        uniqueStudents = students.map(st => ({
            student_id: st.id,
            student_name: st.name || '未知学生',
            schedulesByDate: schedulesByStudent[st.id]
                ? schedulesByStudent[st.id].schedulesByDate
                : weekDates.reduce((acc, d) => { acc[toISODate(d)] = []; return acc; }, {})
        }));
    } else {
        // 兼容旧格式：从排课数据中提取学生
        uniqueStudents = Object.entries(schedulesByStudent).map(([id, data]) => {
            // 从排课记录中找到学生姓名
            const firstSchedule = schedules.find(s => String(s.student_id) === String(id));
            return {
                student_id: Number(id),
                student_name: firstSchedule ? (firstSchedule.student_name || '未知学生') : '未知学生',
                schedulesByDate: data.schedulesByDate
            };
        });
    }

    // 排序：有排课的学生在前（按学号升序），无排课的学生在后（按学号升序）
    uniqueStudents.sort((a, b) => {
        const aHas = !!schedulesByStudent[a.student_id];
        const bHas = !!schedulesByStudent[b.student_id];
        if (aHas !== bHas) return aHas ? -1 : 1;
        return (a.student_id || 0) - (b.student_id || 0);
    });

    if (uniqueStudents.length === 0) {
        const emptyRow = document.createElement('tr');
        emptyRow.appendChild(createElement('td', 'schedule-cell', { textContent: '-' }));
        weekDates.forEach(() => {
            const cell = createElement('td', 'schedule-cell');
            cell.appendChild(createElement('div', 'no-schedule-dash', { textContent: '-' }));
            emptyRow.appendChild(cell);
        });
        tbody.appendChild(emptyRow);
        return;
    }

    // 遍历每一个学生
    uniqueStudents.forEach(studentData => {
        const row = document.createElement('tr');

        // 第一列：学生姓名
        const nameCell = createElement('td', 'student-name-cell');
        window.SecurityUtils.safeSetHTML(nameCell, `<div>${studentData.student_name}</div>`);
        nameCell.title = "点击生成图片并复制";
        nameCell.style.cursor = 'copy';
        nameCell.addEventListener('click', (e) => {
            e.stopPropagation();
            handleTeacherStudentRowCapture(studentData.student_name, row);
        });
        row.appendChild(nameCell);

        // 遍历每一天
        weekDates.forEach(date => {
            const iso = toISODate(date);
            const cell = createElement('td', 'schedule-cell');
            const dailySchedules = studentData.schedulesByDate[iso];

            if (dailySchedules.length > 0) {
                // 先按时间排序
                dailySchedules.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

                // 按时间/地点分组
                const groups = groupSchedulesBySlot(dailySchedules);
                groups.forEach(group => {
                    // 评审记录 / 咨询记录 类型的记录沉到最后，其它按 teacher_id 升序
                    group.sort((a, b) => {
                        const getTypeName = (item) => (
                            item.schedule_type_cn || item.schedule_type_name || item.type_name ||
                            item.schedule_types || item.schedule_type || item.course_type || ''
                        ).toString();
                        const isRecord = (item) => {
                            const n = getTypeName(item);
                            if (n.includes('评审记录') || n.includes('咨询记录')) return true;
                            return /(review|consultation|advisory)[\s_-]?record/i.test(n);
                        };
                        const rA = isRecord(a) ? 1 : 0;
                        const rB = isRecord(b) ? 1 : 0;
                        if (rA !== rB) return rA - rB;
                        return (Number(a.teacher_id) || 0) - (Number(b.teacher_id) || 0);
                    });
                    cell.appendChild(buildScheduleCard(group));
                });
            } else {
                const empty = createElement('div', 'no-schedule-dash', { textContent: '-' });
                cell.appendChild(empty);
            }
            row.appendChild(cell);
        });

        tbody.appendChild(row);
    });
}

function renderTableHeader(weekDates) {
    const thead = document.getElementById('ssWeeklyHeader');
    if (!thead) return;

    clearChildren(thead);
    const headerRow = document.createElement('tr');

    const nameTh = createElement('th', 'date-header');
    window.SecurityUtils.safeSetHTML(nameTh, `<div class="date-label">学生姓名</div>`);
    headerRow.appendChild(nameTh);

    weekDates.forEach(date => {
        const iso = toISODate(date);
        const parts = iso.split('-');
        const month = parts[1];
        const day = parts[2];
        const weekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
        const weekday = weekdayNames[date.getDay()];

        const metaHtml = window.ScheduleDateLabels?.getHeaderMetaHtml(date) || '';

        const th = createElement('th', 'date-header');
        th.dataset.date = iso;
        th.innerHTML = `
            <div class="date-label">${month}月${day}日</div>
            <div class="day-label">${weekday}</div>
            ${metaHtml}
        `;
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
}

function renderMobileScheduleTable(weekDates, schedules) {
    let container = document.querySelector('#student-schedules .schedule-unified-card');
    if (!container) return;

    clearChildren(container);

    const table = createElement('table', 'mobile-schedule-table');

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.appendChild(createElement('th', '', { textContent: '日期' }));
    headerRow.appendChild(createElement('th', '', { textContent: '课程详情' }));
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const schedulesByDate = {};
    weekDates.forEach(d => schedulesByDate[toISODate(d)] = []);
    schedules.forEach(s => {
        const dateKey = normalizeDateKey(s.date);
        if (schedulesByDate[dateKey]) schedulesByDate[dateKey].push(s);
    });

    const tbody = document.createElement('tbody');
    weekDates.forEach(date => {
        const iso = toISODate(date);
        const parts = iso.split('-');
        const month = parts[1];
        const day = parts[2];

        const row = document.createElement('tr');

        const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const weekday = weekdayNames[date.getDay()];

        const metaText = window.ScheduleDateLabels?.getHeaderMetaText(date);
        const dateCell = createElement('td', 'mobile-date-cell', {
            textContent: `${month}/${day} ${weekday}${metaText ? ` ${metaText}` : ''}`
        });
        row.appendChild(dateCell);

        const detailsCell = createElement('td', 'mobile-details-cell');
        const dailySchedules = schedulesByDate[iso] || [];

        if (dailySchedules.length === 0) {
            detailsCell.appendChild(createElement('div', 'no-schedule', { textContent: '暂无排课' }));
        } else {
            const groups = groupSchedulesBySlot(dailySchedules);
            groups.forEach((group, index) => {
                group.sort((a, b) => {
                    const getTypeName = (item) => (
                        item.schedule_type_cn || item.schedule_type_name || item.type_name ||
                        item.schedule_types || item.schedule_type || item.course_type || ''
                    ).toString();
                    const isRecord = (item) => {
                        const n = getTypeName(item);
                        if (n.includes('评审记录') || n.includes('咨询记录')) return true;
                        return /(review|consultation|advisory)[\s_-]?record/i.test(n);
                    };
                    const rA = isRecord(a) ? 1 : 0;
                    const rB = isRecord(b) ? 1 : 0;
                    if (rA !== rB) return rA - rB;
                    return (Number(a.teacher_id) || 0) - (Number(b.teacher_id) || 0);
                });

                detailsCell.appendChild(buildCompactMobileScheduleCard(group));

                if (index < groups.length - 1) {
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

function buildCompactMobileScheduleCard(group) {
    if (!group || group.length === 0) return document.createElement('div');
    const first = group[0];

    // 计算时段类名 (对齐 PC 端逻辑)
    let slotId = 'morning';
    const hour = parseInt((first.start_time || '00:00').substring(0, 2), 10);
    if (hour >= 12) slotId = 'afternoon';
    if (hour >= 18) slotId = 'evening';

    const card = createElement('div', `mobile-schedule-card-v2 slot-${slotId}`);
    
    appendScheduleWatermark(card, getScheduleWatermarkText(group));
    
    // 1. 标题行：姓名 (类型, 状态)
    const headerRow = createElement('div', 'card-header-row');
    
    group.forEach((schedule, index) => {
        const typeLabel = schedule.schedule_type_cn || schedule.schedule_type || '课程';
        const st = (schedule.status || 'pending').toLowerCase();
        const teacherName = schedule.teacher_name || '老师';
        
        const nameSpan = createElement('span', 'student-name', { textContent: teacherName });
        headerRow.appendChild(nameSpan);

        const metaSpan = createElement('span', 'meta-info');
        metaSpan.textContent = ' (';
        
        const typeTag = createElement('span', 'type-tag', { textContent: typeLabel });
        metaSpan.appendChild(typeTag);

        metaSpan.appendChild(document.createTextNode(', '));
        
        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消', 'modified_away': '已调整' };
        const statusTag = createElement('span', 'status-tag', { textContent: statusMap[st] || '待处理' });
        // 如果是已取消，增加特殊色
        if (st === 'cancelled') statusTag.style.color = '#ef4444';
        else if (st === 'completed') statusTag.style.color = '#10b981';
        
        metaSpan.appendChild(statusTag);
        metaSpan.appendChild(document.createTextNode(')'));
        headerRow.appendChild(metaSpan);
        
        if (index < group.length - 1) headerRow.appendChild(document.createTextNode(', '));
    });
    card.appendChild(headerRow);

    // 2. 时间行
    const timeRange = formatTimeRange(first.start_time, first.end_time);
    const timeLine = createElement('div', 'info-line');
    window.SecurityUtils.safeSetHTML(timeLine, `<span class="material-icons-round">schedule</span><span>${timeRange}</span>`);
    card.appendChild(timeLine);

    // 3. 地点行
    const loc = first.location || '地点待定';
    const locLine = createElement('div', 'info-line');
    window.SecurityUtils.safeSetHTML(locLine, `<span class="material-icons-round">place</span><span>${loc}</span>`);
    card.appendChild(locLine);

    // 费用在「学生费用管理」（sd-fees）页统一管理，此处不再渲染费用按钮

    return card;
}

function buildScheduleCard(group) {
    if (!group || !group.length) return document.createElement('div');
    const first = group[0];

    let slot = 'morning';
    const h = parseInt((first.start_time || '00:00').substring(0, 2), 10);
    if (h >= 12) slot = 'afternoon';
    if (h >= 18) slot = 'evening';

    const colors = {
        morning: { bg: '#DBEAFE', border: '#93C5FD' },
        afternoon: { bg: '#FEF3C7', border: '#FCD34D' },
        evening: { bg: '#F3E8FF', border: '#D8B4FE' }
    };
    const theme = colors[slot];

    const card = createElement('div', `schedule-card-group slot-${slot}`);
    // 取消此处低优先级的内联颜色绑定以免干扰 html2canvas 的 CSSOM 读取，完全让权给全局 dashboard.css (白底+顶部彩线框)

    // 如果整组取消，置灰整卡
    const allCancelled = group.every(rec => (rec.status || '').toLowerCase() === 'cancelled');
    if (allCancelled) {
        card.classList.add('status-cancelled');
    }

    appendScheduleWatermark(card, getScheduleWatermarkText(group));

    const content = createElement('div', 'card-content');
    const listDiv = createElement('div', 'schedule-list');

    group.forEach(rec => {
        const row = createElement('div', 'schedule-row');
        const st = (rec.status || 'pending').toLowerCase();
        if (st === 'cancelled') {
            row.classList.add('status-cancelled');
        } else if (st === 'modified_away') {
            row.classList.add('status-modified_away');
        }

        const left = createElement('div', 'row-left marquee-wrapper');
        const typeStr = rec.schedule_type_cn || rec.schedule_type || '课程';

        const nameSpan = createElement('span', 'teacher-name', {
            textContent: rec.teacher_name || '未指定',
            style: 'flex-shrink: 0; white-space: nowrap; max-width: 60px; overflow: hidden; text-overflow: ellipsis;'
        });

        const marqueeWrapper = createElement('div', 'marquee-wrapper');
        marqueeWrapper.style.cssText = 'flex: 1; min-width: 0; max-width: none;';

        const marqueeContent = createElement('div', 'marquee-content');
        marqueeContent.style.paddingRight = '0';
        window.SecurityUtils.safeSetHTML(marqueeContent, `<span class="course-type-text">${typeStr}</span>`);
        
        

        marqueeWrapper.appendChild(marqueeContent);
        left.appendChild(nameSpan);
        left.appendChild(marqueeWrapper);
        row.appendChild(left);

        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消', 'modified_away': '已调整' };

        const statusSelect = createElement('select', `status-select ${st}`);
        statusSelect.dataset.lastStatus = st;
        Object.keys(statusMap).forEach(key => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = statusMap[key];
            if (key === st) opt.selected = true;
            statusSelect.appendChild(opt);
        });

        statusSelect.addEventListener('click', (e) => e.stopPropagation());
        statusSelect.addEventListener('change', async (e) => {
            e.stopPropagation();
            const newStatus = e.target.value;
            const oldStatus = statusSelect.dataset.lastStatus;

            statusSelect.disabled = true;
            statusSelect.blur();

            try {
                // 远程优先：先同步数据库
                await updateScheduleStatus(rec.id, newStatus);
                // 远程成功后再更新本地UI状态
                statusSelect.className = `status-select ${newStatus}`;
                statusSelect.dataset.lastStatus = newStatus;
                const feedback = document.getElementById('ssScheduleFeedback');
                if (feedback) {
                    showInlineFeedback(feedback, '状态更新成功', 'success');
                } else if (window.apiUtils && window.apiUtils.showToast) {
                    window.apiUtils.showToast('状态更新成功', 'success');
                }
            } catch (err) {
                statusSelect.value = oldStatus;
                statusSelect.className = `status-select ${oldStatus}`;
                const feedback = document.getElementById('ssScheduleFeedback');
                if (feedback) {
                    showInlineFeedback(feedback, '更新失败', 'error');
                } else if (window.apiUtils && window.apiUtils.showToast) {
                    window.apiUtils.showToast(err.message || '更新失败', 'error');
                }
            } finally {
                statusSelect.disabled = false;
            }
        });

        const rightLabel = createElement('div', '', { style: 'display: flex; align-items: center; gap: 4px; flex-shrink: 0;' });
        rightLabel.appendChild(statusSelect);
        row.appendChild(rightLabel);
        listDiv.appendChild(row);
    });
    content.appendChild(listDiv);

    // 底部信息 (时间和地点)
    const footer = createElement('div', 'schedule-footer');
    const timeRange = formatTimeRange(first.start_time, first.end_time);
    const loc = first.location || '';

    footer.innerHTML = `
        <div class="time-text">${timeRange}</div>
        ${loc ? `<div class="location-text">${loc}</div>` : `<div class="location-text" style="font-style: italic; color: #94a3b8;">地点待定</div>`}
    `;

    // 费用在「学生费用管理」（sd-fees）页统一管理，此处不再渲染费用信息（2026-09-07）
    content.appendChild(footer);
    card.appendChild(content);

    return card;
}

// 模拟管理员端 html2canvas 截取排课表行图片
function scrollWidthWithBuffer(el) {
    return Math.max(el.scrollWidth, 1200) + 50;
}

async function handleTeacherStudentRowCapture(studentName, originalTr) {
    if (!window.html2canvas) {
        if (window.apiUtils) {
            window.apiUtils.showToast('截图组件 (html2canvas) 加载失败，请检查网络或联系管理员手动部署本地库。', 'error');
        }
        return;
    }

    const toastId = window.apiUtils ? window.apiUtils.showToast('正在生成图片...', 'info', 0) : null;

    // 获取上层容器和表头
    const originalHeaderTr = document.querySelector('#ssWeeklyHeader tr');
    const originalTable = document.querySelector('#ssWeeklyBody').closest('table');

    if (!originalHeaderTr || !originalTable) {
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        return;
    }

    // 包装器
    const wrapper = document.createElement('div');
    wrapper.style.position = 'absolute';
    wrapper.style.top = '-9999px';
    wrapper.style.left = '0';
    wrapper.style.zIndex = '-1';
    wrapper.style.background = '#ffffff';
    wrapper.style.padding = '20px';
    wrapper.style.width = scrollWidthWithBuffer(originalTable) + 'px';

    const tableClone = document.createElement('table');
    tableClone.className = originalTable.className;
    tableClone.style.cssText = originalTable.style.cssText;
    tableClone.style.backgroundColor = '#ffffff';
    tableClone.style.width = '100%';
    // 恢复外扩边框线及圆角
    tableClone.style.borderTop = '1px solid #E2E8F0';
    tableClone.style.borderLeft = '1px solid #E2E8F0';
    tableClone.style.borderRight = '1px solid #E2E8F0';
    tableClone.style.borderRadius = '8px';
    tableClone.style.overflow = 'hidden';

    // 复制表头
    const thead = document.createElement('thead');
    const headerRowClone = originalHeaderTr.cloneNode(true);
    const origThs = originalHeaderTr.querySelectorAll('th');
    const cloneThs = headerRowClone.querySelectorAll('th');

    origThs.forEach((th, index) => {
        if (cloneThs[index]) {
            const computed = getComputedStyle(th);
            cloneThs[index].style.width = computed.width;
            cloneThs[index].style.minWidth = computed.minWidth;
            cloneThs[index].style.maxWidth = computed.maxWidth;
            cloneThs[index].style.position = 'static';
            cloneThs[index].style.transform = 'none';
            // 修复表头边框线丢失
            cloneThs[index].style.borderRight = '1px solid #E2E8F0';
            cloneThs[index].style.borderBottom = '1px solid #E2E8F0';
        }
    });

    thead.appendChild(headerRowClone);
    tableClone.appendChild(thead);

    // 复制内容行
    const tbody = document.createElement('tbody');
    const rowClone = originalTr.cloneNode(true);
    const origTds = originalTr.querySelectorAll('td');
    const cloneTds = rowClone.querySelectorAll('td');

    origTds.forEach((td, index) => {
        if (cloneTds[index]) {
            const computed = getComputedStyle(td);
            cloneTds[index].style.width = computed.width;
            cloneTds[index].style.minWidth = computed.minWidth;
            cloneTds[index].style.position = 'static';
            cloneTds[index].style.left = 'auto';

            if (index === 0) {
                cloneTds[index].style.backgroundColor = '#FAFAFA';
            } else {
                cloneTds[index].style.backgroundColor = '#FFFFFF';
            }

            // 修复表格内网格线丢失
            cloneTds[index].style.borderRight = '1px solid #E2E8F0';
            cloneTds[index].style.borderBottom = '1px solid #E2E8F0';
        }
    });

    // --- 重点：修复 cloneNode 导致的排版塌陷和状态错位 ---
    // 1. 修复课程卡片及底部附着层(费用区)的圆角与边界重叠
    const cloneCards = rowClone.querySelectorAll('.schedule-card, .unified-schedule-card, .schedule-card-group');
    cloneCards.forEach(card => {
        // 重筑大圆角、白底、大阴影以及彩色顶框，彻底克隆真实 dashboard.css 高优桌面样式以抗衡画布吞盖
        card.style.borderRadius = '12px';
        card.style.overflow = 'hidden';
        card.style.backgroundColor = '#FFFFFF';
        card.style.border = '1px solid #E2E8F0';
        card.style.boxShadow = '0 1px 2px rgba(0, 0, 0, 0.05)';

        if (card.classList.contains('slot-morning')) {
            card.style.borderTop = '4px solid #3B82F6';
        } else if (card.classList.contains('slot-afternoon')) {
            card.style.borderTop = '4px solid #F59E0B';
        } else if (card.classList.contains('slot-evening')) {
            card.style.borderTop = '4px solid #8B5CF6';
        }
    });
    // html2canvas 无法正确渲染 <select>（文字垂直对齐画错），克隆体里统一替换成只读 <span>。
    // 类名原样保留 —— 视觉几何完全由全局 CSS 驱动（span.status-select 的 inline-flex 居中 +
    // .schedule-card-group .status-select 的「行高=内容盒高度」），与页面上的胶囊同一套规则，
    // 不要再打内联样式补丁：line-height 等内联值会被样式表 !important 压掉，等于死代码。
    // 注意：cloneNode 不保留 <select> 的运行时 selectedIndex，需要从原始 DOM 读取。
    const origSelects = originalTr.querySelectorAll('select.status-select');
    const cloneSelects = rowClone.querySelectorAll('select.status-select');
    origSelects.forEach((origSel, idx) => {
        const cloneSel = cloneSelects[idx];
        if (!cloneSel) return;
        const opt = origSel.options[origSel.selectedIndex] || origSel.options[0];
        const text = opt ? opt.text : origSel.value || '';
        const span = document.createElement('span');
        span.className = origSel.className; // 保留 status-select + 状态颜色类
        span.textContent = text;
        cloneSel.parentNode.replaceChild(span, cloneSel);
    });

    tbody.appendChild(rowClone);
    tableClone.appendChild(tbody);
    wrapper.appendChild(tableClone);
    document.body.appendChild(wrapper);

    try {
        // 使用 Safari 兼容的 Promise 写入模式以防止 NotAllowedError 
        // 剪贴板需要同步的用户交互上下文，所以把 await canvas 包装到传入的 Promise 里
        const makeImagePromise = new Promise(async (resolve, reject) => {
            try {
                const canvas = await html2canvas(wrapper, {
                    scale: 2,
                    backgroundColor: '#ffffff',
                    logging: false,
                    useCORS: true,
                    width: wrapper.offsetWidth,
                    height: wrapper.offsetHeight,
                    onclone: (documentClone) => {
                        // 尝试消除 willReadFrequently 警告（如果有针对性绘制可加），但这主要是 html2canvas 内部控制的
                    }
                });

                canvas.toBlob((blob) => {
                    if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
                    if (!blob) {
                        reject(new Error('生成图片为空'));
                        return;
                    }
                    resolve(blob);
                }, 'image/png');
            } catch (err) {
                reject(err);
            } finally {
                if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
            }
        });

        // 立刻同步调用剪贴板 API，参数为一个未决 Promise（浏览器允许此模式保持权限）
        const item = new ClipboardItem({ 'image/png': makeImagePromise });
        await navigator.clipboard.write([item]);

        if (window.apiUtils) window.apiUtils.showSuccessToast(`已复制 ${studentName} 的课表图片`);

    } catch (err) {

        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        if (window.apiUtils) window.apiUtils.showToast('生成或复制图片失败: ' + err.message, 'error');
        if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
    }
}

/**
 * 导出班主任关联的学生数据
 * @description 本页面导出的是所选学生（默认全部关联学生）的全部排课，
 *              不是当前登录教师自己的授课记录，因此默认类型必须是 teacher_homeroom。
 */
async function exportTeacherStudents() {
    if (window.ExportDialog) {
        window.ExportDialog.open({
            type: 'teacher_homeroom',
            exportContext: 'head_teacher_students'
        });
    } else {

        if (window.apiUtils) window.apiUtils.showToast('导出组件未加载', 'error');
    }
}

// 暴露到全局，供按钮事件调用
window.exportTeacherStudents = exportTeacherStudents;

/* ==========================================================================
 * 导出当前视图：向共享模块（weekly-view-export.js）注册教师角色上下文。
 * 实际渲染、学生选择、截图、剪贴板逻辑统一由 window.exportWeeklyScheduleView 提供。
 * ========================================================================== */
if (typeof window.registerWeeklyViewExportContext === 'function') {
    window.registerWeeklyViewExportContext('teacher', {
        getWeekStart() {
            return currentWeekStart || startOfWeek(new Date());
        },
        async fetchSchedules(startDate, endDate) {
            const response = await fetch(
                `/api/teacher/student-schedules?startDate=${startDate}&endDate=${endDate}&show_plan=true`,
                { credentials: 'include' }
            );
            if (!response.ok) throw new Error('获取学生课程安排失败');
            const data = await response.json();
            if (data && data.schedules) return Array.isArray(data.schedules) ? data.schedules : [];
            return Array.isArray(data) ? data : [];
        }
    });
}


