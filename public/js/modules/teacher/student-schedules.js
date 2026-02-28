// public/js/modules/teacher/student-schedules.js

import { STATUS_LABELS } from '../student/constants.js';
import { getScheduleTypeLabel } from './constants.js';
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

// 全局：班主任学生排课的显示费用开关，默认进入页面即由于要求显示费用
window.teacherStudentFeeShow = true;

window.toggleTeacherStudentFeeVisibility = function () {
    window.teacherStudentFeeShow = !window.teacherStudentFeeShow;
    const btnText = document.getElementById('teacherStudentFeeBtnText');
    const toggleBtn = document.getElementById('toggleTeacherStudentFeeBtn');
    if (btnText) {
        btnText.textContent = window.teacherStudentFeeShow ? '隐藏费用' : '显示费用';
    }
    if (toggleBtn) {
        if (window.teacherStudentFeeShow) {
            toggleBtn.classList.add('fee-active');
            toggleBtn.style.backgroundColor = '#10b981';
            toggleBtn.style.color = 'white';
        } else {
            toggleBtn.classList.remove('fee-active');
            toggleBtn.style.backgroundColor = 'white';
            toggleBtn.style.color = '#10b981';
        }
    }

    // 重新渲染当前页的记录，使得费用新增按钮根据状态展示或隐藏
    const weekDates = getWeekDates(currentWeekStart || startOfWeek(new Date()));
    renderSchedulesGrid(weekDates, cachedSchedules, cachedStudents);
};

export async function initStudentSchedulesSection() {
    currentWeekStart = currentWeekStart || startOfWeek(new Date());

    // 初始化同步显示费用按钮状态
    const btnText = document.getElementById('teacherStudentFeeBtnText');
    const toggleBtn = document.getElementById('toggleTeacherStudentFeeBtn');
    if (btnText) btnText.textContent = window.teacherStudentFeeShow ? '隐藏费用' : '显示费用';
    if (toggleBtn && window.teacherStudentFeeShow) {
        toggleBtn.classList.add('fee-active');
        toggleBtn.style.backgroundColor = '#10b981';
        toggleBtn.style.color = 'white';
    }
    bindNavigation();
    bindFeeModalEvents();

    // 绑定导出学生数据按钮
    const exportBtn = document.getElementById('exportTeacherStudentsBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportTeacherStudents);
    }

    await loadSchedules(currentWeekStart);
}

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

function bindNavigation() {
    const prevBtn = document.getElementById('ssPrevWeek');
    const nextBtn = document.getElementById('ssNextWeek');

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

let activeScheduleGroup = null;

function bindFeeModalEvents() {
    const modal = document.getElementById('feeManagementModal');
    const closeBtn = document.getElementById('closeFeeModal');
    const cancelBtn = document.getElementById('cancelFeeBtn');
    const form = document.getElementById('feeManagementForm');

    if (!modal) return;

    const closeModal = () => {
        modal.style.display = 'none';
        activeScheduleGroup = null;

        const defaultTrans = document.getElementById('feeTransportInput')?.closest('.form-group');
        const defaultOther = document.getElementById('feeOtherInput')?.closest('.form-group');
        if (defaultTrans) defaultTrans.style.display = '';
        if (defaultOther) defaultOther.style.display = '';

        const container = document.getElementById('dynamicFeeInputsContainer');
        if (container) {
            container.style.display = 'none';
            container.innerHTML = '';
        }
    };

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal.querySelector('.modal-overlay')) closeModal();
    });

    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!activeScheduleGroup || activeScheduleGroup.length === 0) return;

            const submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = '保存中...';
            }

            const updates = [];

            if (activeScheduleGroup.length === 1) {
                const tFee = parseFloat(document.getElementById('feeTransportInput').value) || 0;
                const oFee = parseFloat(document.getElementById('feeOtherInput').value) || 0;
                updates.push({
                    id: activeScheduleGroup[0].id,
                    transport_fee: tFee,
                    other_fee: oFee
                });
            } else {
                const container = document.getElementById('dynamicFeeInputsContainer');
                if (container) {
                    activeScheduleGroup.forEach(schedule => {
                        const tInp = container.querySelector(`.dyn-trans-input[data-id="${schedule.id}"]`);
                        const oInp = container.querySelector(`.dyn-other-input[data-id="${schedule.id}"]`);
                        updates.push({
                            id: schedule.id,
                            transport_fee: parseFloat(tInp?.value) || 0,
                            other_fee: parseFloat(oInp?.value) || 0
                        });
                    });
                }
            }

            try {
                const response = await fetch('/api/teacher/batch-fees', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    },
                    body: JSON.stringify({ updates })
                });

                if (!response.ok) {
                    const data = await response.json();
                    throw new Error(data.message || '保存失败');
                }

                if (window.apiUtils && window.apiUtils.showToast) {
                    window.apiUtils.showToast('费用保存成功', 'success');
                } else {
                    alert('费用保存成功');
                }

                closeModal();
                await loadSchedules(currentWeekStart); // reload
            } catch (error) {
                console.error(error);
                if (window.apiUtils && window.apiUtils.showToast) {
                    window.apiUtils.showToast(error.message || '保存失败', 'error');
                } else {
                    alert('保存失败: ' + error.message);
                }
            } finally {
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = '保存';
                }
            }
        });
    }
}

export async function refreshStudentSchedules() {
    if (currentWeekStart) {
        await loadSchedules(currentWeekStart);
    }
}

function openFeeModal(group) {
    activeScheduleGroup = Array.isArray(group) ? group : [group];
    const modal = document.getElementById('feeManagementModal');
    if (!modal) return;

    const defaultTrans = document.getElementById('feeTransportInput')?.closest('.form-group');
    const defaultOther = document.getElementById('feeOtherInput')?.closest('.form-group');
    let container = document.getElementById('dynamicFeeInputsContainer');

    if (!container && defaultTrans) {
        container = document.createElement('div');
        container.id = 'dynamicFeeInputsContainer';
        defaultTrans.parentNode.insertBefore(container, defaultTrans);
    }

    if (activeScheduleGroup.length === 1) {
        if (container) container.style.display = 'none';
        if (defaultTrans) defaultTrans.style.display = '';
        if (defaultOther) defaultOther.style.display = '';

        const schedule = activeScheduleGroup[0];
        const tInput = document.getElementById('feeTransportInput');
        const oInput = document.getElementById('feeOtherInput');

        if (tInput) tInput.value = schedule.transport_fee || '';
        if (oInput) oInput.value = schedule.other_fee || '';

        const updateTotalSing = () => {
            const t = parseFloat(tInput?.value) || 0;
            const o = parseFloat(oInput?.value) || 0;
            document.getElementById('feeTotalDisplay').textContent = (t + o).toFixed(2);
        };
        if (tInput) {
            tInput.removeEventListener('input', tInput._updHandler);
            tInput._updHandler = updateTotalSing;
            tInput.addEventListener('input', updateTotalSing);
        }
        if (oInput) {
            oInput.removeEventListener('input', oInput._updHandler);
            oInput._updHandler = updateTotalSing;
            oInput.addEventListener('input', updateTotalSing);
        }
        updateTotalSing();
    } else {
        if (defaultTrans) defaultTrans.style.display = 'none';
        if (defaultOther) defaultOther.style.display = 'none';
        if (container) {
            container.style.display = 'block';
            container.innerHTML = '';

            activeScheduleGroup.forEach(schedule => {
                const row = document.createElement('div');
                row.style.cssText = 'padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px;';
                row.innerHTML = `
                    <div style="font-weight: bold; margin-bottom: 8px; color: #1e293b;">${schedule.teacher_name || '老师'} - ${schedule.schedule_type_cn || '课程'}</div>
                    <div style="display: flex; gap: 10px;">
                        <div class="form-group" style="flex: 1; margin-bottom: 0;">
                            <label style="font-size: 12px;">交通费 (元)</label>
                            <input type="number" class="dyn-trans-input" data-id="${schedule.id}" step="0.01" min="0" value="${schedule.transport_fee || ''}" placeholder="0.00" style="padding: 6px; height: 32px; font-size: 14px;">
                        </div>
                        <div class="form-group" style="flex: 1; margin-bottom: 0;">
                            <label style="font-size: 12px;">其他费用 (元)</label>
                            <input type="number" class="dyn-other-input" data-id="${schedule.id}" step="0.01" min="0" value="${schedule.other_fee || ''}" placeholder="0.00" style="padding: 6px; height: 32px; font-size: 14px;">
                        </div>
                    </div>
                `;
                container.appendChild(row);
            });

            const updateTotalMulti = () => {
                let t = 0;
                container.querySelectorAll('.dyn-trans-input').forEach(inp => t += parseFloat(inp.value) || 0);
                container.querySelectorAll('.dyn-other-input').forEach(inp => t += parseFloat(inp.value) || 0);
                document.getElementById('feeTotalDisplay').textContent = t.toFixed(2);
            };
            container.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateTotalMulti));
            updateTotalMulti();
        }
    }

    modal.style.display = 'flex';
}

async function loadSchedules(baseDate) {
    const weekStart = startOfWeek(baseDate);
    currentWeekStart = weekStart;
    const weekDates = getWeekDates(weekStart);

    const rangeLabel = document.getElementById('ssWeekRange');
    if (rangeLabel) rangeLabel.textContent = formatWeekRangeText(weekDates[0], weekDates[weekDates.length - 1]);

    const feedback = document.getElementById('ssScheduleFeedback');

    const body = document.getElementById('ssWeeklyBody');
    if (body) {
        body.innerHTML = `
            <div class="flex flex-col items-center justify-center" style="min-height: 300px; width: 100%; grid-column: 1 / -1;">
                <div class="loading-spinner mb-4" style="width: 40px; height: 40px; border-width: 3px;"></div>
                <div style="color: var(--color-gray-500); font-size: 15px; font-weight: 500;">正在加载学生课程安排...</div>
            </div>
        `;
    }

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        const response = await fetch(
            `/api/teacher/student-schedules?startDate=${startDate}&endDate=${endDate}`,
            {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
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
        renderSchedulesGrid(weekDates, cachedSchedules, cachedStudents);
        showInlineFeedback(feedback, '', '');
    } catch (error) {
        console.error('加载班主任关联学生课程安排失败', error);
        if (body) body.innerHTML = '<div style="padding:20px; text-align:center; color: #ef4444;">加载失败，请重试</div>';
        showInlineFeedback(feedback, '加载课程安排失败', 'error');
    }
}

function renderSchedulesGrid(weekDates, schedules, students = []) {
    if (!document.getElementById('teacher-ss-fixing-style')) {
        const style = document.createElement('style');
        style.id = 'teacher-ss-fixing-style';
        style.innerHTML = `
            #student-schedules .weekly-schedule-table thead th:first-child,
            #student-schedules .weekly-schedule-table tbody td:first-child {
                position: sticky !important;
                left: 0;
                background-color: #F8FAFC !important;
                border-right: 1px solid #E5E7EB !important;
                z-index: 10 !important;
                text-align: center;
                width: 112px !important;
                min-width: 112px !important;
            }
            #student-schedules .weekly-schedule-table tbody td:first-child {
                background-color: white !important;
                vertical-align: middle;
                font-size: 16px;
                font-weight: 600;
            }
            #student-schedules .weekly-schedule-table tbody tr:hover td:first-child {
                background-color: transparent !important;
            }
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

function isMobileView() {
    return window.innerWidth <= 768;
}

function renderDesktopScheduleTable(weekDates, schedules, students = []) {
    const thead = document.getElementById('ssWeeklyHeader');
    const tbody = document.getElementById('ssWeeklyBody');
    if (!thead || !tbody) return;

    clearChildren(thead);
    clearChildren(tbody);

    // 1. 渲染表头 (日期)
    const headerRow = document.createElement('tr');

    const nameTh = createElement('th', 'date-header');
    nameTh.innerHTML = `<div class="date-label">学生姓名</div>`;
    headerRow.appendChild(nameTh);
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
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);

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

    // 统一按学号 (student_id) 从小到大排列
    uniqueStudents.sort((a, b) => a.student_id - b.student_id);

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
        nameCell.innerHTML = `<div>${studentData.student_name}</div>`;
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
                    // 特殊课程(如评审)放后面
                    group.sort((a, b) => {
                        const typeA = (a.schedule_type_cn || a.schedule_type || '').toString();
                        const typeB = (b.schedule_type_cn || b.schedule_type || '').toString();
                        const isSpecA = typeA.includes('评审') || typeA.includes('咨询');
                        const isSpecB = typeB.includes('评审') || typeB.includes('咨询');
                        if (isSpecA && !isSpecB) return 1;
                        if (!isSpecA && isSpecB) return -1;
                        return (a.teacher_id || 0) - (b.teacher_id || 0);
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

function groupSchedulesBySlot(schedules) {
    const slots = new Map();
    schedules.forEach(s => {
        const key = `${s.start_time}-${s.end_time}-${s.location || ''}`;
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push(s);
    });
    return Array.from(slots.values());
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
        const row = document.createElement('tr');

        const day = date.getDate();
        const weekdayNames = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        const weekday = weekdayNames[date.getDay()];

        let lunarParen = '';
        try {
            const lunarStr = new Intl.DateTimeFormat('zh-u-ca-chinese', { dateStyle: 'full' }).format(date);
            const match = lunarStr.match(/(正月|腊月)(.*?)(?=星期)/);
            if (match) lunarParen = `(${match[0]})`;
        } catch (e) { }

        const dateCell = createElement('td', 'mobile-date-cell', { textContent: `${day}/${weekday}${lunarParen}` });
        row.appendChild(dateCell);

        const detailsCell = createElement('td', 'mobile-details-cell');
        const dailySchedules = schedulesByDate[iso] || [];

        if (dailySchedules.length === 0) {
            detailsCell.appendChild(createElement('div', 'no-schedule', { textContent: '暂无排课' }));
        } else {
            const groups = groupSchedulesBySlot(dailySchedules);
            groups.forEach((group, index) => {
                group.sort((a, b) => {
                    const typeA = (a.schedule_type_cn || a.schedule_type || '').toString();
                    const typeB = (b.schedule_type_cn || b.schedule_type || '').toString();
                    const isSpecA = typeA.includes('评审') || typeA.includes('咨询');
                    const isSpecB = typeB.includes('评审') || typeB.includes('咨询');
                    if (isSpecA && !isSpecB) return 1;
                    if (!isSpecA && isSpecB) return -1;
                    return (a.teacher_id || 0) - (b.teacher_id || 0);
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

    const card = createElement('div', `group-picker-item slot-unspecified`);
    card.style.cssText = 'padding: 12px; line-height: 1.8; word-wrap: break-word; overflow-wrap: break-word; display: block !important; min-height: auto !important;';

    // 教师与学生与课程信息
    group.forEach((schedule, index) => {
        const typeLabel = schedule.schedule_type_cn || schedule.schedule_type || '课程';
        const st = (schedule.status || 'pending').toLowerCase();
        const status = st;
        const teacherName = schedule.teacher_name || '未指定教师';

        if (st === 'cancelled') {
            card.classList.add('status-cancelled');
        }

        let typeClass = 'type-default';
        if (typeLabel.includes('入户')) typeClass = 'type-visit';
        else if (typeLabel.includes('试教')) typeClass = 'type-trial';
        else if (typeLabel.includes('评审')) typeClass = 'type-review';

        const nameSpan = createElement('span', '', { textContent: teacherName, style: 'font-weight: 600; font-size: 15px; color: #1e293b;' });
        card.appendChild(nameSpan);
        card.appendChild(document.createTextNode(' ('));

        const typeChip = createElement('span', `chip ${typeClass}`, { textContent: typeLabel });
        card.appendChild(typeChip);
        card.appendChild(document.createTextNode(', '));

        const statusSelect = createElement('select', `status-select ${status}`);
        statusSelect.dataset.lastStatus = status;

        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消' };
        Object.keys(statusMap).forEach(key => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = statusMap[key];
            if (key === status) opt.selected = true;
            statusSelect.appendChild(opt);
        });

        statusSelect.addEventListener('click', (e) => e.stopPropagation());
        statusSelect.addEventListener('change', async (e) => {
            e.stopPropagation();
            const newStatus = e.target.value;
            const oldStatus = statusSelect.dataset.lastStatus;

            statusSelect.className = `status-select ${newStatus}`;
            statusSelect.blur();

            try {
                await updateScheduleStatus(schedule.id, newStatus);
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
            }
        });

        card.appendChild(statusSelect);
        card.appendChild(document.createTextNode(')'));

        if (index < group.length - 1) card.appendChild(document.createTextNode(', '));
    });

    // 时间显示
    const timeText = formatTimeRange(first.start_time, first.end_time);
    const timeInfo = createElement('div', '', { style: 'margin-top: 4px; font-size: 14px; color: #475569; display: flex; align-items: center; gap: 4px;' });
    timeInfo.innerHTML = `<span class="material-icons-round" style="font-size: 14px;">schedule</span> <span>${timeText}</span>`;
    card.appendChild(timeInfo);

    // 地点显示
    const loc = first.location || '';
    const locInfo = createElement('div', '', { style: 'margin-top: 2px; font-size: 14px; color: #64748b; display: flex; align-items: center; gap: 4px;' });
    locInfo.innerHTML = `<span class="material-icons-round" style="font-size: 14px;">place</span> <span>${loc ? loc : '地点待定'}</span>`;
    card.appendChild(locInfo);

    // 费用显示逻辑
    let mTotalTransport = 0;
    let mTotalOther = 0;
    group.forEach(s => {
        mTotalTransport += parseFloat(s.transport_fee) || 0;
        mTotalOther += parseFloat(s.other_fee) || 0;
    });
    const mHasFee = mTotalTransport > 0 || mTotalOther > 0;

    const feeWrapper = createElement('div', '', { style: 'margin-top: 8px; display: flex; align-items: center; gap: 6px;' });
    feeWrapper.style.display = window.teacherStudentFeeShow ? 'flex' : 'none';

    if (mHasFee) {
        const feeInfo = createElement('span', '', {
            style: 'font-size: 12px; color: #d97706; background: #fef3c7; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-weight: 500;'
        });
        feeInfo.addEventListener('click', (e) => {
            e.stopPropagation();
            openFeeModal(group);
        });
        let parts = [];
        if (mTotalTransport > 0) parts.push(`交通¥${mTotalTransport}`);
        if (mTotalOther > 0) parts.push(`其他¥${mTotalOther}`);
        feeInfo.textContent = parts.join(' ');
        feeWrapper.appendChild(feeInfo);
    } else {
        const feeBtn = createElement('button', 'add-fee-btn', {
            textContent: '添加费用',
            style: 'padding: 4px 12px; font-size: 12px; border-radius: 6px; border: 1px dashed #d1d5db; background: transparent; color: #6b7280; cursor: pointer;'
        });
        feeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openFeeModal(group);
        });
        feeWrapper.appendChild(feeBtn);
    }

    card.appendChild(feeWrapper);

    return card;
}

function buildScheduleCard(group) {
    if (!group || !group.length) return document.createElement('div');
    const first = group[0];

    let slot = 'morning';
    const h = parseInt((first.start_time || '00:00').substring(0, 2), 10);
    if (h >= 12) slot = 'afternoon';
    if (h >= 19) slot = 'evening';

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

    const content = createElement('div', 'card-content');
    const listDiv = createElement('div', 'schedule-list');

    group.forEach(rec => {
        const row = createElement('div', 'schedule-row');
        const st = (rec.status || 'pending').toLowerCase();
        if (st === 'cancelled') {
            row.classList.add('status-cancelled');
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
        marqueeContent.innerHTML = `<span class="course-type-text">(${typeStr})</span>`;

        marqueeWrapper.appendChild(marqueeContent);
        left.appendChild(nameSpan);
        left.appendChild(marqueeWrapper);
        row.appendChild(left);

        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消' };

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

            statusSelect.className = `status-select ${newStatus}`;
            statusSelect.blur();

            try {
                await updateScheduleStatus(rec.id, newStatus);
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

    // 附加底部：费用相关
    let totalTransport = 0;
    let totalOther = 0;
    group.forEach(s => {
        totalTransport += parseFloat(s.transport_fee) || 0;
        totalOther += parseFloat(s.other_fee) || 0;
    });
    const hasFee = totalTransport > 0 || totalOther > 0;

    const feeContainer = createElement('div', '', { style: 'margin-top: 6px; justify-content: center; width: 100%;' });
    feeContainer.style.display = window.teacherStudentFeeShow ? 'flex' : 'none';

    if (hasFee) {
        const feeInfo = createElement('span', '', {
            style: 'background: #FEF3C7; color: #D97706; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; cursor: pointer;'
        });
        feeInfo.addEventListener('click', (e) => {
            e.stopPropagation();
            openFeeModal(group);
        });
        let parts = [];
        if (totalTransport > 0) parts.push(`交通¥${totalTransport}`);
        if (totalOther > 0) parts.push(`其他¥${totalOther}`);
        feeInfo.textContent = parts.join(' ');
        feeContainer.appendChild(feeInfo);
    } else {
        const feeBtn = createElement('button', 'add-fee-btn', {
            textContent: '添加费用',
            style: 'padding: 2px 8px; font-size: 11px; min-width: auto; height: 22px; margin: 0 auto;'
        });
        feeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openFeeModal(group);
        });
        feeContainer.appendChild(feeBtn);
    }

    if (feeContainer.hasChildNodes()) {
        const feeWrap = createElement('div', 'fee-bottom-wrap', { style: 'display: flex; justify-content: flex-end; width: 100%; border-top: 1px dashed #e2e8f0; padding-top: 6px; margin-top: 6px;' });
        feeWrap.appendChild(feeContainer);
        footer.appendChild(feeWrap);
    }
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
        if (window.apiUtils) window.apiUtils.showToast('组件未加载 (html2canvas missing)', 'error');
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

        // 强制底部费用包裹块的两个底角平滑，防止在部分引擎下溢出形成直角
        const feeWrap = card.querySelector('.fee-bottom-wrap');
        if (feeWrap) {
            feeWrap.style.borderBottomLeftRadius = '11px';
            feeWrap.style.borderBottomRightRadius = '11px';
        }
    });
    const origSelects = originalTr.querySelectorAll('select.status-select');
    const cloneSelects = rowClone.querySelectorAll('select.status-select');

    origSelects.forEach((origSel, idx) => {
        if (cloneSelects[idx]) {
            // 同步真实状态
            cloneSelects[idx].value = origSel.value;
            cloneSelects[idx].selectedIndex = origSel.selectedIndex;
            // 剥除控件自带箭头并维持高度与居中，避免向下偏移
            cloneSelects[idx].style.appearance = 'none';
            cloneSelects[idx].style.background = 'none';
            cloneSelects[idx].style.border = 'none';
            cloneSelects[idx].style.height = 'auto';
            cloneSelects[idx].style.lineHeight = '1';
            cloneSelects[idx].style.textAlign = 'center';
            cloneSelects[idx].style.padding = '2px 6px';
            cloneSelects[idx].style.margin = '0';
        }
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
        console.error('Capture failed', err);
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        if (window.apiUtils) window.apiUtils.showToast('生成或复制图片失败: ' + err.message, 'error');
        if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
    }
}

/**
 * 导出班主任关联的学生数据
 */
async function exportTeacherStudents() {
    if (window.ExportDialog) {
        window.ExportDialog.open({
            type: 'teacher_schedule'
        });
    } else {
        console.error('ExportDialog not found');
        if (window.apiUtils) window.apiUtils.showToast('导出组件未加载', 'error');
    }
}
