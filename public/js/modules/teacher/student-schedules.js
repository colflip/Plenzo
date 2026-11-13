// public/js/modules/teacher/student-schedules.js

import { getScheduleWatermarkText } from '../shared/schedule-helpers.js';
import { showTableLoading, hideTableLoading } from '../shared/loading-ui.js';
import { syncToggleButton } from '../shared/view-utils.js';
import { renderTableErrorRow } from '../shared/error-ui.js';
import {
    collectWeeklyViewRows,
    captureWeeklyViewRow,
    captureWeekMobileViewToClipboard
} from '../../components/schedule-view-capture.js';
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

// 班主任关联学生网格用的是 #ssWeekly* 这一套 id，姓名列类名也与管理员端不同
const HOMEROOM_CAPTURE = {
    headerSelector: '#ssWeeklyHeader',
    bodySelector: '#ssWeeklyBody',
    nameCellSelector: '.student-name-cell'
};
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

    // 绑定导出本周视图按钮：先弹「视图选择」窗口（默认移动端），选完再截图到剪贴板。
    // 移动端长图是临时渲染、截完即弃，页面版式本身不变。
    const exportWeeklyBtn = document.getElementById('exportWeeklyViewBtn');
    if (exportWeeklyBtn && !exportWeeklyBtn.__exportWeeklyBound) {
        exportWeeklyBtn.addEventListener('click', exportWeekView);
        exportWeeklyBtn.__exportWeeklyBound = true;
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

// 导出本周学生课表：视图 + 学生名单在一个窗口里一次选完（名单仅桌面端按学生截图时需要）
function exportWeekView() {
    const rows = collectWeeklyViewRows(HOMEROOM_CAPTURE);
    window.ScheduleExportDialog.openViewChoice({
        label: '本周学生课表',
        students: rows,
        needsStudent: (view) => view === 'desktop' && rows.length > 0,
        onChoose: async (view, row) => {
            if (view === 'mobile') {
                await exportMobileWeekView();
            } else {
                const target = row || rows[0];
                if (target) captureWeeklyViewRow(target, HOMEROOM_CAPTURE);
            }
        }
    });
}

// 点击学生姓名：直接导出「该学生 + 移动端视图」，不弹窗、不让用户再选
async function exportStudentMobileView(studentId, studentName) {
    const sid = String(studentId);
    const rows = (cachedSchedules || []).filter(s => String(s.student_id) === sid);
    const weekDates = getWeekDates(currentWeekStart || startOfWeek(new Date()));
    await captureWeekMobileViewToClipboard({
        weekDates,
        schedules: rows,
        scopeId: 'student-schedules',
        label: `${studentName} 的课表`,
        options: {
            studentName,
            personName: s => s.teacher_name || '未分配教师',
            typeLabel: s => s.schedule_type_cn || s.schedule_type || '课程',
            editableStatus: false,
            formatTimeRange,
            emptyText: '暂无排课'
        }
    });
}

// 把本周数据渲染成移动端日卡片长图（离屏渲染，页面版式不受影响）
async function exportMobileWeekView() {
    const weekDates = getWeekDates(currentWeekStart || startOfWeek(new Date()));
    await captureWeekMobileViewToClipboard({
        weekDates,
        schedules: cachedSchedules || [],
        scopeId: 'student-schedules',
        label: '本周学生课表',
        options: {
            personName: s => {
                const stu = s.student_name || '未知学生';
                return s.teacher_name ? `${stu} · ${s.teacher_name}` : stu;
            },
            typeLabel: s => s.schedule_type_cn || s.schedule_type || '课程',
            editableStatus: true,
            formatTimeRange,
            sortGroup: sortHomeroomGroup,
            onStatusChange: (schedule, newStatus) => updateScheduleStatus(schedule.id, newStatus, schedule.teacher_uid),
            onStatusChanged: (err, message) => {
                showInlineFeedback(document.getElementById('ssScheduleFeedback'), message, err ? 'error' : 'success');
            },
            emptyText: '暂无排课'
        }
    });
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
    renderTableHeader(weekDates);

    // 2. 显示加载动画
    if (showLoading && tableContainer) {
        showTableLoading(tableContainer, '正在加载学生课程安排数据...', '#ssWeeklyHeader');
    }

    const feedback = document.getElementById('ssScheduleFeedback');

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        if (!window.apiUtils) throw new Error('API 客户端尚未加载');
        const data = await window.apiUtils.get(
            `/teacher/student-schedules?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}${window.teacherStudentShowPlan ? '&show_plan=true' : ''}`,
            {},
            { timeoutMs: 20000, suppressErrorToast: true }
        );
        if (!data || typeof data !== 'object' || !Array.isArray(data.students) || !Array.isArray(data.schedules)) {
            throw new Error('学生课程安排响应格式无效');
        }

        cachedStudents = data.students;
        cachedSchedules = data.schedules;
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

    renderDesktopScheduleTable(weekDates, schedules, students);
}

/** 同槽内排序：评审记录/咨询记录沉底，其余按 teacher_id 升序（与桌面端一致） */
function sortHomeroomGroup(group) {
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
        row.dataset.studentId = studentData.student_id;

        // 第一列：学生姓名
        const nameCell = createElement('td', 'student-name-cell');
        window.SecurityUtils.safeSetHTML(nameCell, `<div>${studentData.student_name}</div>`);
        nameCell.title = "点击生成图片并复制";
        nameCell.style.cursor = 'copy';
        nameCell.addEventListener('click', (e) => {
            e.stopPropagation();
            exportStudentMobileView(studentData.student_id, studentData.student_name);
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
                await updateScheduleStatus(rec.id, newStatus, rec.teacher_uid);
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

/**
 * 导出班主任关联的学生数据
 * @description 本页面导出的是所选学生（默认全部关联学生）的全部排课，
 *              不是当前登录教师自己的授课记录，因此锁定为 teacher_homeroom。
 */
async function exportTeacherStudents() {
    if (window.ExportDialog) {
        window.ExportDialog.open({
            type: 'teacher_homeroom',
            allowedTypes: ['teacher_homeroom'],
            exportContext: 'head_teacher_students'
        });
    } else {

        if (window.apiUtils) window.apiUtils.showToast('导出组件未加载', 'error');
    }
}

// 暴露到全局，供按钮事件调用
window.exportTeacherStudents = exportTeacherStudents;

