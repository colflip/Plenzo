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
let scheduleLoadSeq = 0;

// 全局：班主任学生排课的显示费用开关，默认隐藏
window.teacherStudentFeeShow = false;
window.teacherStudentShowPlan = false;

window.toggleTeacherStudentFeeVisibility = function () {
    window.teacherStudentFeeShow = !window.teacherStudentFeeShow;
    const btnText = document.getElementById('teacherStudentFeeBtnText');
    const toggleBtn = document.getElementById('toggleTeacherStudentFeeBtn');
    if (btnText) {
        btnText.textContent = window.teacherStudentFeeShow ? '隐藏费用' : '显示费用';
    }
    if (toggleBtn) {
        toggleBtn.classList.toggle('is-on', !!window.teacherStudentFeeShow);
    }

    // 重新渲染当前页的记录，使得费用新增按钮根据状态展示或隐藏
    const weekDates = getWeekDates(currentWeekStart || startOfWeek(new Date()));
    renderSchedulesGrid(weekDates, cachedSchedules, cachedStudents);
};

window.toggleTeacherStudentShowPlan = async function () {
    window.teacherStudentShowPlan = !window.teacherStudentShowPlan;
    syncShowPlanButton();
    await loadSchedules(currentWeekStart || startOfWeek(new Date()), true);
};

function syncShowPlanButton() {
    const btnText = document.getElementById('teacherStudentShowPlanBtnText');
    const toggleBtn = document.getElementById('toggleTeacherStudentShowPlanBtn');
    if (btnText) btnText.textContent = window.teacherStudentShowPlan ? '隐藏全部安排' : '显示全部安排';
    if (toggleBtn) toggleBtn.classList.toggle('is-on', !!window.teacherStudentShowPlan);
}

function getAdjustmentType(rec) {
    const raw = rec?.adjustment_type ?? rec?.is_temp;
    const num = Number(raw);
    return Number.isFinite(num) ? num : 0;
}

function getScheduleWatermarkText(group) {
    const hasTemp = group.some(rec => getAdjustmentType(rec) === 1);
    const hasAdjusted = group.some(rec => getAdjustmentType(rec) === 2);
    const hasOriginal = group.some(rec => (rec.status || '').toLowerCase() === 'modified_away' && getAdjustmentType(rec) === 0);
    const parts = [];
    if (hasAdjusted) parts.push('调');
    if (hasTemp) parts.push('加');
    if (parts.length > 0) return parts.join('/');
    if (hasOriginal && group.every(rec => (rec.status || '').toLowerCase() === 'modified_away' && getAdjustmentType(rec) === 0)) return '原';
    return '';
}

function appendScheduleWatermark(card, watermarkText) {
    if (!watermarkText) return;
    card.classList.add('is-temp-card');
    card.style.position = 'relative';
    card.style.overflow = 'hidden';
    const watermark = createElement('span', '');
    watermark.setAttribute('aria-hidden', 'true');
    const wmFontSize = watermarkText.length > 1 ? '66px' : '99px';
    watermark.style.cssText = [
        'position: absolute', 'bottom: -10px', 'right: 5px',
        `font-size: ${wmFontSize}`,
        'font-family: "Ma Shan Zheng","Kaiti SC","STXingkai","KaiTi",cursive,serif',
        'color: rgba(0,102,204,0.1)', 'pointer-events: none',
        'z-index: 0', 'transform: rotate(-15deg)', 'line-height: 1', 'user-select: none'
    ].join(';');
    watermark.textContent = watermarkText;
    card.appendChild(watermark);
}

export async function initStudentSchedulesSection() {
    currentWeekStart = currentWeekStart || startOfWeek(new Date());

    // 初始化同步显示费用按钮状态
    const btnText = document.getElementById('teacherStudentFeeBtnText');
    const toggleBtn = document.getElementById('toggleTeacherStudentFeeBtn');
    if (btnText) btnText.textContent = window.teacherStudentFeeShow ? '隐藏费用' : '显示费用';
    if (toggleBtn) {
        // 显式绑定费用切换按钮事件（替代 HTML onclick，确保在模块加载后绑定）
        if (!toggleBtn.__feeToggleBound) {
            toggleBtn.addEventListener('click', window.toggleTeacherStudentFeeVisibility);
            toggleBtn.__feeToggleBound = true;
        }
        toggleBtn.classList.toggle('is-on', !!window.teacherStudentFeeShow);
    }
    syncShowPlanButton();
    bindNavigation();
    bindFeeModalEvents();

    // 绑定导出学生数据按钮
    const exportBtn = document.getElementById('exportTeacherStudentsBtn');
    if (exportBtn) {
        if (!exportBtn.__exportBound) {
            exportBtn.addEventListener('click', exportTeacherStudents);
            exportBtn.__exportBound = true;
        }
    }

    // 绑定导出本周视图按钮
    const exportWeeklyBtn = document.getElementById('exportWeeklyViewBtn');
    if (exportWeeklyBtn) {
        if (!exportWeeklyBtn.__exportWeeklyBound) {
            exportWeeklyBtn.addEventListener('click', () => {
                console.log('导出当前视图按钮被点击');
                exportWeeklyScheduleView().catch(err => {
                    console.error('导出当前视图失败:', err);
                    if (window.apiUtils) {
                        window.apiUtils.showToast('导出失败: ' + err.message, 'error');
                    }
                });
            });
            exportWeeklyBtn.__exportWeeklyBound = true;
            console.log('导出当前视图按钮事件已绑定');
        }
    } else {
        console.warn('未找到导出当前视图按钮 (exportWeeklyViewBtn)');
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

    if (prevBtn && !prevBtn.__scheduleNavBound) {
        prevBtn.addEventListener('click', () => {
            currentWeekStart.setDate(currentWeekStart.getDate() - 7);
            loadSchedules(currentWeekStart);
        });
        prevBtn.__scheduleNavBound = true;
    }
    if (nextBtn && !nextBtn.__scheduleNavBound) {
        nextBtn.addEventListener('click', () => {
            currentWeekStart.setDate(currentWeekStart.getDate() + 7);
            loadSchedules(currentWeekStart);
        });
        nextBtn.__scheduleNavBound = true;
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
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, ''); } else { container.innerHTML = ''; }
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
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, ''); } else { container.innerHTML = ''; }

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
    if (showLoading && tableContainer && window.showTableLoading) {
        window.showTableLoading(tableContainer, '正在加载学生课程安排数据...', '#ssWeeklyHeader');
    }

    const feedback = document.getElementById('ssScheduleFeedback');

    try {
        const startDate = toISODate(weekDates[0]);
        const endDate = toISODate(weekDates[weekDates.length - 1]);

        const response = await fetch(
            `/api/teacher/student-schedules?startDate=${startDate}&endDate=${endDate}${window.teacherStudentShowPlan ? '&show_plan=true' : ''}`,
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
        if (requestId !== scheduleLoadSeq) return;
        renderSchedulesGrid(weekDates, cachedSchedules, cachedStudents);
        showInlineFeedback(feedback, '', '');
    } catch (error) {
        if (requestId !== scheduleLoadSeq) return;

        const body = document.getElementById('ssWeeklyBody');
        if (body) if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(body, '<div style="padding:20px; text-align:center; color: #ef4444;">加载失败，请重试</div>'); } else { body.innerHTML = '<div style="padding:20px; text-align:center; color: #ef4444;">加载失败，请重试</div>'; }
        showInlineFeedback(feedback, '加载课程安排失败', 'error');
    } finally {
        // 3. 加载完成后隐藏动画
        if (requestId === scheduleLoadSeq && showLoading && tableContainer && window.hideTableLoading) {
            window.hideTableLoading(tableContainer);
        }
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
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(nameCell, `<div>${studentData.student_name}</div>`); } else { nameCell.innerHTML = `<div>${studentData.student_name}</div>`; }
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
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(nameTh, `<div class="date-label">学生姓名</div>`); } else { nameTh.innerHTML = `<div class="date-label">学生姓名</div>`; }
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
    if (window.SecurityUtils) { 
        window.SecurityUtils.safeSetHTML(timeLine, `<span class="material-icons-round">schedule</span><span>${timeRange}</span>`); 
    } else { 
        timeLine.innerHTML = `<span class="material-icons-round">schedule</span><span>${timeRange}</span>`; 
    }
    card.appendChild(timeLine);

    // 3. 地点行
    const loc = first.location || '地点待定';
    const locLine = createElement('div', 'info-line');
    if (window.SecurityUtils) { 
        window.SecurityUtils.safeSetHTML(locLine, `<span class="material-icons-round">place</span><span>${loc}</span>`); 
    } else { 
        locLine.innerHTML = `<span class="material-icons-round">place</span><span>${loc}</span>`; 
    }
    card.appendChild(locLine);

    // 4. 费用操作行
    const actionRow = createElement('div', 'action-row');
    actionRow.style.display = window.teacherStudentFeeShow ? 'flex' : 'none';
    
    let totalT = 0, totalO = 0;
    group.forEach(s => {
        totalT += parseFloat(s.transport_fee) || 0;
        totalO += parseFloat(s.other_fee) || 0;
    });
    
    const btn = createElement('button', 'btn-add-fee');
    if (totalT > 0 || totalO > 0) {
        btn.textContent = `费用: ¥${(totalT + totalO).toFixed(0)}`;
        btn.style.backgroundColor = '#6366f1'; // 有费用时用紫色区分
    } else {
        btn.textContent = '添加费用';
    }
    
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFeeModal(group);
    });
    
    actionRow.appendChild(btn);
    card.appendChild(actionRow);

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
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(marqueeContent, `<span class="course-type-text">(${typeStr})</span>`); } else { marqueeContent.innerHTML = `<span class="course-type-text">(${typeStr})</span>`; }
        
        

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

        // 强制底部费用包裹块的两个底角平滑，防止在部分引擎下溢出形成直角
        const feeWrap = card.querySelector('.fee-bottom-wrap');
        if (feeWrap) {
            feeWrap.style.borderBottomLeftRadius = '11px';
            feeWrap.style.borderBottomRightRadius = '11px';
        }
    });
    // html2canvas 无法正确渲染 <select> 内选中项的垂直对齐 —— 文本始终下移。
    // 改为用 <span> 替换，保留 .status-select 类以继承原有 pill 视觉
    // （尺寸 70x20、圆角 20px、font-size 11px、font-weight 600、颜色等）。
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
        // 强制 flex 居中以抵消 .status-select 的 line-height:15px 基线偏移
        span.style.display = 'inline-flex';
        span.style.alignItems = 'center';
        span.style.justifyContent = 'center';
        span.style.lineHeight = '1';
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
 */
async function exportTeacherStudents() {
    if (window.ExportDialog) {
        window.ExportDialog.open({
            type: 'teacher_schedule',
            exportContext: 'head_teacher_students'
        });
    } else {

        if (window.apiUtils) window.apiUtils.showToast('导出组件未加载', 'error');
    }
}

// 暴露到全局，供按钮事件调用
window.exportTeacherStudents = exportTeacherStudents;

/* ==========================================================================
 * 导出当前视图（图片 → 剪贴板）
 *
 * 严格遵循 export-manager.js 第 1 工作表的样式与数据处理逻辑：
 *   - 复用 window.ExportManager.transformExportData 生成的行数据
 *   - 字体、边框、表头、条件着色、合并单元格规则 1:1 对齐 Excel 输出
 *   - 截图复用 handleTeacherStudentRowCapture 的 html2canvas + ClipboardItem
 *     Promise 模式（Safari 兼容）
 * ========================================================================== */

const WEEKLY_VIEW_STYLE = {
    // 列宽：安排列加宽到 480，确保"已取消[试教(19:00-22:30)：陈莹莹]"等最长内容单行不换行 → 行高统一
    columnPx: {
        '日期': 96,
        '星期': 60,
        '计划安排': 480,
        '实际安排': 480,
        '费用': 120,
        '周汇总': 110
    },
    // 单元格内边距与行高（压制到接近 Excel 紧凑默认行高，对齐目标图）
    cellPaddingY: 5,
    cellPaddingX: 10,
    lineHeight: 1.35,
    minRowHeight: 32,   // 紧凑行高，贴近 Excel 第1表默认
    // 字体：改无衬线黑体，匹配目标外观（雅黑/PingFang），ASCII 仍用 Times 贴近 Excel 数字
    fontCJK: '"Microsoft YaHei", "PingFang SC", "Heiti SC", "微软雅黑", sans-serif',
    fontASCII: '"Times New Roman", serif',
    fontPt: 11,         // 内容 11pt
    headerFontPt: 11,   // 表头与内容同字号，仅加粗
    // 颜色（对齐源码的 rgb 值）
    border: '#D4D4D4',
    headerBg: '#F2F2F2',
    dateColBg: '#E2EFDA',  // 日期列浅绿
    sundayBg: '#DDEBF7',   // 周日整行浅蓝
    cancelledText: '#595959',
    modifiedAwayText: '#8C6239',
    reviewText: '#FF0000',
    defaultText: '#000000'
};

/**
 * 等待依赖项加载完成
 */
async function waitForDependencies(maxWaitMs = 5000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
        if (window.html2canvas && window.ExportManager && typeof window.ExportManager.transformExportData === 'function') {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
}

/**
 * 导出本周视图主入口
 * - 多学生：弹窗选择
 * - 单/无学生：直接进入下一步
 */
async function exportWeeklyScheduleView() {
    console.log('exportWeeklyScheduleView 函数开始执行');
    console.log('ExportManager 可用:', !!window.ExportManager);
    console.log('html2canvas 可用:', !!window.html2canvas);

    // 等待依赖项加载
    const depsReady = await waitForDependencies();

    if (!depsReady) {
        console.error('依赖项加载超时');
        if (window.apiUtils) {
            window.apiUtils.showToast('导出组件加载中，请稍后再试', 'warning');
        }
        return;
    }

    if (!window.ExportManager || typeof window.ExportManager.transformExportData !== 'function') {
        console.error('ExportManager 未加载或缺少 transformExportData 方法');
        if (window.apiUtils) window.apiUtils.showToast('导出组件 (ExportManager) 未加载', 'error');
        return;
    }
    if (!window.html2canvas) {
        console.error('html2canvas 未加载');
        if (window.apiUtils) window.apiUtils.showToast('截图组件 (html2canvas) 未加载', 'error');
        return;
    }

    // 1. 从缓存学生列表中筛选出本周排课的学生（更贴近用户预期）
    const studentsWithSchedules = collectStudentsFromCache();
    if (studentsWithSchedules.length === 0) {
        if (window.apiUtils) window.apiUtils.showToast('本周没有可导出的学生数据', 'warning');
        return;
    }

    // 2. 选学生（>1 弹窗）
    let target;
    if (studentsWithSchedules.length === 1) {
        target = studentsWithSchedules[0];
    } else {
        try {
            target = await pickStudentForWeeklyView(studentsWithSchedules);
        } catch (_cancelled) {
            return; // 用户取消
        }
    }
    if (!target) return;

    // 3. 生成并复制
    await generateAndCopyWeeklyView(target);
}

/**
 * 从缓存中收集本周有排课的学生（不依赖外部接口）
 */
function collectStudentsFromCache() {
    const seen = new Map();
    cachedSchedules.forEach(s => {
        const id = s.student_id;
        if (id == null) return;
        if (!seen.has(id)) {
            seen.set(id, { id: id, name: s.student_name || '未知学生' });
        }
    });
    // 兼容：如果缓存有完整学生列表也合并进来（含本周无排课的学生）
    cachedStudents.forEach(st => {
        if (!seen.has(st.id)) seen.set(st.id, { id: st.id, name: st.name || '未知学生' });
    });
    return Array.from(seen.values()).sort((a, b) => (a.id || 0) - (b.id || 0));
}

/**
 * 学生选择弹窗（Promise）
 * resolve(student) / reject() 取消
 */
function pickStudentForWeeklyView(students) {
    return new Promise((resolve, reject) => {
        const GREEN = '#2ECC71';
        const overlay = document.createElement('div');
        overlay.style.cssText = [
            'position: fixed', 'top: 0', 'left: 0', 'width: 100%', 'height: 100%',
            'background: rgba(15,23,42,0.45)', 'backdrop-filter: blur(4px)',
            'z-index: 100002', 'display: flex',
            'align-items: center', 'justify-content: center',
            'animation: wvFadeIn 0.18s ease'
        ].join(';');

        // 注入一次性动画样式
        if (!document.getElementById('wvDialogAnim')) {
            const st = document.createElement('style');
            st.id = 'wvDialogAnim';
            st.textContent = '@keyframes wvFadeIn{from{opacity:0}to{opacity:1}}@keyframes wvScaleIn{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}';
            document.head.appendChild(st);
        }

        const box = document.createElement('div');
        box.style.cssText = [
            'background: #ffffff', 'width: 380px', 'max-height: 78vh',
            'border-radius: 16px', 'box-shadow: 0 20px 48px -12px rgba(0,0,0,0.28)',
            'display: flex', 'flex-direction: column', 'overflow: hidden',
            'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
            'animation: wvScaleIn 0.22s cubic-bezier(0.16,1,0.3,1)'
        ].join(';');

        // 标题
        const header = document.createElement('div');
        header.style.cssText = 'padding: 18px 22px; border-bottom: 1px solid #eef2f6; font-weight: 600; font-size: 16px; color: #1e293b; display: flex; justify-content: space-between; align-items: center;';
        const title = document.createElement('span');
        title.textContent = '选择要导出的学生';
        header.appendChild(title);
        const closeBtn = document.createElement('span');
        closeBtn.className = 'material-icons-round';
        closeBtn.style.cssText = 'cursor: pointer; color: #94a3b8; font-size: 22px; line-height: 1; transition: color 0.15s;';
        closeBtn.textContent = 'close';
        closeBtn.onmouseover = () => closeBtn.style.color = '#475569';
        closeBtn.onmouseout = () => closeBtn.style.color = '#94a3b8';
        header.appendChild(closeBtn);
        box.appendChild(header);

        // 列表
        const list = document.createElement('div');
        list.style.cssText = 'flex: 1; overflow-y: auto; padding: 12px;';
        let selectedId = students[0].id;
        const rowEls = [];

        const paint = () => {
            rowEls.forEach(({ el, indicator, id }) => {
                const active = String(id) === String(selectedId);
                el.style.background = active ? 'rgba(46,204,113,0.10)' : '#ffffff';
                el.style.borderColor = active ? GREEN : '#e7ecf1';
                indicator.style.borderColor = active ? GREEN : '#cbd5e1';
                indicator.style.background = active ? GREEN : '#ffffff';
                indicator.firstChild.style.opacity = active ? '1' : '0';
            });
        };

        students.forEach(stu => {
            const row = document.createElement('div');
            row.style.cssText = [
                'display: flex', 'align-items: center', 'gap: 12px',
                'padding: 12px 14px', 'margin-bottom: 8px', 'cursor: pointer',
                'border: 1.5px solid #e7ecf1', 'border-radius: 10px',
                'transition: background 0.15s, border-color 0.15s'
            ].join(';');

            // 自定义单选指示器（小尺寸、垂直居中）
            const indicator = document.createElement('span');
            indicator.style.cssText = 'flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #cbd5e1; background: #fff; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s;';
            const dot = document.createElement('span');
            dot.style.cssText = 'width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: 0; transition: opacity 0.15s;';
            indicator.appendChild(dot);

            const nameSpan = document.createElement('span');
            nameSpan.textContent = stu.name;
            // 关键：nowrap 防止"宋泽双"被竖排成多行
            nameSpan.style.cssText = 'color: #1e293b; font-size: 14.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

            row.appendChild(indicator);
            row.appendChild(nameSpan);
            row.addEventListener('click', () => { selectedId = stu.id; paint(); });
            list.appendChild(row);
            rowEls.push({ el: row, indicator, id: stu.id });
        });
        box.appendChild(list);
        paint();

        // 按钮区
        const footer = document.createElement('div');
        footer.style.cssText = 'padding: 14px 22px; border-top: 1px solid #eef2f6; display: flex; justify-content: flex-end; gap: 12px;';
        const cancel = document.createElement('button');
        cancel.textContent = '取消';
        cancel.style.cssText = 'padding: 8px 20px; border-radius: 10px; border: 1px solid #e2e8f0; background: white; color: #475569; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.15s;';
        cancel.onmouseover = () => cancel.style.background = '#f1f5f9';
        cancel.onmouseout = () => cancel.style.background = 'white';
        const confirm = document.createElement('button');
        confirm.textContent = '确认';
        confirm.style.cssText = `padding: 8px 22px; border-radius: 10px; border: none; background: ${GREEN}; color: white; cursor: pointer; font-size: 14px; font-weight: 600; box-shadow: 0 2px 4px rgba(46,204,113,0.3); transition: background 0.15s;`;
        confirm.onmouseover = () => confirm.style.background = '#27AE60';
        confirm.onmouseout = () => confirm.style.background = GREEN;
        footer.appendChild(cancel);
        footer.appendChild(confirm);
        box.appendChild(footer);

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
        const onCancel = () => { cleanup(); reject(new Error('cancelled')); };
        const onConfirm = () => {
            const target = students.find(s => String(s.id) === String(selectedId)) || students[0];
            cleanup();
            resolve(target);
        };

        closeBtn.addEventListener('click', onCancel);
        cancel.addEventListener('click', onCancel);
        confirm.addEventListener('click', onConfirm);
        overlay.addEventListener('click', e => { if (e.target === overlay) onCancel(); });
    });
}

/**
 * 主流程：复用 ExportManager 转换数据 → 渲染 DOM → 截图 → 写剪贴板
 */
async function generateAndCopyWeeklyView(targetStudent) {
    const toastId = window.apiUtils ? window.apiUtils.showToast('正在生成本周视图...', 'info', 0) : null;

    const weekDates = getWeekDates(currentWeekStart || startOfWeek(new Date()));
    const startDateObj = weekDates[0];
    const endDateObj = weekDates[weekDates.length - 1];

    // 1. 过滤出本周 + 该学生的排课
    const adaptedRows = cachedSchedules
        .filter(s => String(s.student_id) === String(targetStudent.id))
        .map(s => ({
            id: s.id,
            date: s.date,
            start_time: s.start_time,
            end_time: s.end_time,
            status: s.status,
            student_id: s.student_id,
            student_name: s.student_name || targetStudent.name,
            teacher_id: s.teacher_id,
            teacher_name: s.teacher_name,
            transport_fee: s.transport_fee,
            other_fee: s.other_fee,
            // transformToCalendarData 读取 row.type / row.type_name 来生成授课类型前缀
            // (如"入户(19:00-22:30)：周耀华")并判定评审/咨询是否标红。
            // 缓存里类型字段名是 schedule_type_cn(中文)，必须映射到 type，否则前缀丢失、不标红。
            type: s.schedule_type_cn || s.schedule_type_name || s.type_name || s.schedule_type || '',
            schedule_type: s.schedule_type,
            schedule_type_cn: s.schedule_type_cn,
            course_id: s.course_id,
            is_temp: s.adjustment_type ?? s.is_temp,
            adjustment_type: s.adjustment_type,
            location: s.location
        }));

    // 2. 复用 ExportManager.transformExportData（参数对齐"导出数据"按钮：
    //    type=teacher_schedule + exportContext=head_teacher_students）
    //    注意：startDate/endDate 必须是 Date 对象（统计表会调用 toLocaleDateString）
    const state = {
        startDate: startDateObj,
        endDate: endDateObj,
        selectedType: 'teacher_schedule',
        exportContext: 'head_teacher_students'
    };
    const exportTypes = { TEACHER_SCHEDULE: 'teacher_schedule', STUDENT_SCHEDULE: 'student_schedule' };
    let rows;
    try {
        rows = window.ExportManager.transformExportData(
            adaptedRows,
            String(targetStudent.id),
            targetStudent.name,
            'teacher',
            state,
            exportTypes
        );
    } catch (err) {
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        if (window.apiUtils) window.apiUtils.showToast('数据转换失败: ' + err.message, 'error');
        return;
    }

    // transformExportData 对 teacher 角色返回多 Sheet 对象，
    // 第 1 张表固定为「每日排课明细」（即截图中要复刻的表）
    if (!Array.isArray(rows)) {
        rows = rows['每日排课明细'] || rows[Object.keys(rows)[0]] || [];
    }

    // 3. 生成表格 DOM
    const wrapper = buildWeeklyViewWrapper(rows, weekDates, targetStudent);
    document.body.appendChild(wrapper);

    // 4. html2canvas + 剪贴板（沿用 Safari 兼容的 Promise 模式）
    try {
        const makeImagePromise = new Promise(async (resolve, reject) => {
            try {
                const canvas = await html2canvas(wrapper, {
                    scale: 2,
                    backgroundColor: '#ffffff',
                    logging: false,
                    useCORS: true,
                    width: wrapper.offsetWidth,
                    height: wrapper.offsetHeight
                });
                canvas.toBlob(blob => {
                    if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
                    if (!blob) { reject(new Error('生成图片为空')); return; }
                    resolve(blob);
                }, 'image/png');
            } catch (err) {
                reject(err);
            } finally {
                if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
            }
        });

        const item = new ClipboardItem({ 'image/png': makeImagePromise });
        await navigator.clipboard.write([item]);

        if (window.apiUtils) window.apiUtils.showSuccessToast('已导出本周安排视图到粘贴板');
    } catch (err) {
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        if (window.apiUtils) window.apiUtils.showToast('导出失败: ' + err.message, 'error');
        if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
    }
}

/**
 * 构造离屏 wrapper + Excel 风格表格
 */
function buildWeeklyViewWrapper(rows, weekDates, targetStudent) {
    const HEADERS = ['日期', '星期', '计划安排', '实际安排', '费用', '周汇总'];
    // table-layout:fixed 必须有显式总宽，否则列宽被忽略、列坍缩、文本竖排
    const totalWidth = HEADERS.reduce((sum, h) => sum + (WEEKLY_VIEW_STYLE.columnPx[h] || 0), 0);

    const wrapper = document.createElement('div');
    wrapper.style.cssText = [
        'position: absolute', 'top: -99999px', 'left: 0',
        'z-index: -1', 'background: #ffffff', 'padding: 16px',
        `width: ${totalWidth + 32}px`,
        `font-family: ${WEEKLY_VIEW_STYLE.fontCJK}`
    ].join(';');

    const table = document.createElement('table');
    table.style.cssText = [
        'border-collapse: collapse', 'background: #ffffff',
        `font-family: ${WEEKLY_VIEW_STYLE.fontCJK}`,
        'color: #000000', 'table-layout: fixed',
        `width: ${totalWidth}px`
    ].join(';');

    // 表头
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    HEADERS.forEach(h => {
        const th = document.createElement('th');
        th.textContent = h;
        th.style.cssText = buildCellStyle({
            isHeader: true,
            widthPx: WEEKLY_VIEW_STYLE.columnPx[h]
        });
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    // 表体
    const tbody = document.createElement('tbody');

    // 若 rows 为空：渲染 7 天空骨架，避免完全空白
    let renderRows = rows;
    if (!renderRows || renderRows.length === 0) {
        const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        renderRows = weekDates.map(d => ({
            '日期': toISODate(d),
            '星期': days[d.getDay()],
            '计划安排': '',
            '实际安排': '',
            '费用': '',
            '周汇总': '',
            _isSunday: d.getDay() === 0,
            _weekNumber: getISOWeekStub(d)
        }));
    }

    // 计算 rowspan：日期 / 星期 / 费用 按日期合并；周汇总 按周次合并
    const rowspans = computeRowspans(renderRows);

    renderRows.forEach((r, i) => {
        const tr = document.createElement('tr');
        HEADERS.forEach(h => {
            // rowspan 跳过非首行
            if (['日期', '星期', '费用'].includes(h) && !rowspans.dateFirst[i]) return;
            if (h === '周汇总' && !rowspans.weekFirst[i]) return;

            const td = document.createElement('td');
            const value = r[h] != null ? String(r[h]) : '';

            // 设置 rowspan
            if (['日期', '星期', '费用'].includes(h) && rowspans.dateSpan[i] > 1) {
                td.rowSpan = rowspans.dateSpan[i];
            }
            if (h === '周汇总' && rowspans.weekSpan[i] > 1) {
                td.rowSpan = rowspans.weekSpan[i];
            }

            // 内容：处理换行
            renderMultiline(td, value);

            td.style.cssText = buildCellStyle({
                isHeader: false,
                widthPx: WEEKLY_VIEW_STYLE.columnPx[h],
                column: h,
                value: value,
                row: r
            });
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
}

/**
 * 把字符串里的 \n / <br> 拆成多行，避免 white-space: pre 引入额外的字符间距问题
 */
function renderMultiline(td, value) {
    if (value == null || value === '') return;
    const lines = String(value).split(/\n|<br\s*\/?>/i);
    lines.forEach((line, idx) => {
        if (idx > 0) td.appendChild(document.createElement('br'));
        td.appendChild(document.createTextNode(line));
    });
}

/**
 * 计算合并区间：
 *   dateFirst[i] = true 表示该行是这个日期块的第一行（要渲染日期/星期/费用 cell）
 *   dateSpan[i]  = 这个日期块的行数（仅在 first 上有效）
 *   weekFirst[i]/weekSpan[i] 同理但按 _weekNumber 分组
 */
function computeRowspans(rows) {
    const n = rows.length;
    const dateFirst = new Array(n).fill(false);
    const dateSpan = new Array(n).fill(1);
    const weekFirst = new Array(n).fill(false);
    const weekSpan = new Array(n).fill(1);

    let i = 0;
    while (i < n) {
        let j = i;
        while (j < n && rows[j]['日期'] === rows[i]['日期']) j++;
        dateFirst[i] = true;
        dateSpan[i] = j - i;
        i = j;
    }
    i = 0;
    while (i < n) {
        let j = i;
        const wk = rows[i]._weekNumber;
        while (j < n && rows[j]._weekNumber === wk) j++;
        weekFirst[i] = true;
        weekSpan[i] = j - i;
        i = j;
    }
    return { dateFirst, dateSpan, weekFirst, weekSpan };
}

/**
 * 构造单元格内联样式（严格对照 export-manager.js 第 2033–2220 行）
 */
function buildCellStyle({ isHeader, widthPx, column, value, row }) {
    const S = WEEKLY_VIEW_STYLE;
    const parts = [
        `border: 1px solid ${S.border}`,
        `padding: ${S.cellPaddingY}px ${S.cellPaddingX}px`,
        `line-height: ${S.lineHeight}`,
        `height: ${S.minRowHeight}px`,
        `vertical-align: middle`,
        `color: ${S.defaultText}`,
        `width: ${widthPx}px`,
        `min-width: ${widthPx}px`,
        `max-width: ${widthPx}px`,
        `word-break: break-word`,
        `white-space: normal`
    ];

    const strValue = String(value || '');
    const isEnglishOrNum = /^[\x00-\x7F]*$/.test(strValue);
    const fontFamily = (!isHeader && isEnglishOrNum && strValue.length > 0) ? S.fontASCII : S.fontCJK;

    if (isHeader) {
        // 表头：F2F2F2 + 12pt + 加粗 + 居中
        parts.push(`background: ${S.headerBg}`);
        parts.push(`font-family: ${S.fontCJK}`);
        parts.push(`font-size: ${S.headerFontPt}pt`);
        parts.push(`font-weight: bold`);
        parts.push(`text-align: center`);
        return parts.join(';');
    }

    parts.push(`font-family: ${fontFamily}`);
    parts.push(`font-size: ${S.fontPt}pt`);
    parts.push(`font-weight: normal`);

    // 默认垂直居中
    parts.push(`vertical-align: middle`);

    // 行级条件标记（对照源码 2001-2015 / 2075）
    const isSunday = !!(row && row._isSunday);
    const isFinanceCol = column === '费用' || column === '周汇总';
    // 整行是否含“已取消”内容（任一安排列出现“已取消”）→ 全行斜体（财务列除外）
    const isCancelledRow = !!(row && (
        (row['实际安排'] && String(row['实际安排']).includes('已取消')) ||
        (row['计划安排'] && String(row['计划安排']).includes('已取消'))
    ));
    const isModifiedDate = !!(row && row._isModifiedDate);

    // 列条件着色
    if (column === '日期') {
        parts.push(`background: ${S.dateColBg}`);
    } else if (isSunday) {
        parts.push(`background: ${S.sundayBg}`);
    }

    let italic = false;
    // 取消行：除财务列外全部斜体
    if (isCancelledRow && !isFinanceCol) italic = true;
    // 调整日期：日期/星期列斜体
    if (isModifiedDate && (column === '日期' || column === '星期')) italic = true;

    // 计划/实际安排：评审红色 / 取消灰色斜体 / 调走茶色斜体
    if (column === '计划安排' || column === '实际安排') {
        const isPlan = column === '计划安排';
        const isRed = row && (isPlan ? row._planIsRed : row._actualIsRed);
        const isCancelGrey = row && (isPlan ? row._planIsCancelledGrey : row._actualIsCancelledGrey);
        const isModifiedGrey = row && (isPlan ? row._planIsModifiedAwayGrey : row._actualIsModifiedAwayGrey);

        if (isRed) {
            parts.push(`color: ${S.reviewText}`);
        } else if (isCancelGrey) {
            parts.push(`color: ${S.cancelledText}`);
            italic = true;
        } else if (isModifiedGrey) {
            parts.push(`color: ${S.modifiedAwayText}`);
            italic = true;
        }
    }

    if (italic) parts.push(`font-style: italic`);

    // 对齐方式
    if (column === '日期' || column === '星期') {
        parts.push(`text-align: center`);
    } else if (isFinanceCol) {
        // 财务列：右对齐 + 底部对齐（严格对照 export-manager.js 第2193行 vertical:bottom），强制非斜体
        parts.push(`text-align: right`);
        parts.push(`vertical-align: bottom`);
        parts.push(`font-style: normal`);
        // 单行非空时加缩进（对应源码 alignment.indent=1）
        if (strValue && !strValue.includes('\n') && strValue !== '/') {
            parts.push(`padding-right: 16px`);
        }
    } else if (strValue === '/') {
        // 内容为 / 且非费用列：左对齐
        parts.push(`text-align: left`);
    } else if (strValue.length > 10) {
        // 长文本：左对齐
        parts.push(`text-align: left`);
    } else {
        parts.push(`text-align: center`);
    }

    return parts.join(';');
}

/**
 * 兜底：当渲染骨架时给出一个粗略的周序号（实际渲染用 ExportManager 已带的 _weekNumber）
 */
function getISOWeekStub(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// 暴露给 HTML 按钮使用
window.exportWeeklyScheduleView = exportWeeklyScheduleView;
