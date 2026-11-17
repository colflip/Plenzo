/**
 * 周课表「移动端视图」共享渲染：双列表格（第一列日期 / 第二列入户安排计划）。
 *
 * 三端（学生 / 教师 / 班主任）与管理端双击导出共用这一份渲染。
 * 结构是一张两列表格：左列「M月D日 周X」，右列当天所有安排。
 * 每节课与导出文件同口径：全类型合并成「类型（老师A，老师B，老师C（记录））」，
 * 普通老师按 teacher_id 升序在前、记录类老师沉底标「（记录）」；
 * 颜色随导出文件（红 = 评审/咨询族，蓝 = 集体活动，其余黑）；
 * 底部独立一行「时间 + 地点」（时间黑色加粗）。移动端只显示待确认/已取消状态。
 * 类型折叠与颜色判定直接调 ScheduleCalendarCore.RichText / TypeConversion。
 *
 * 复用既有能力，不重复造轮子：
 *   - groupSchedulesByDate / groupSchedulesBySlot：按日、按时段+地点+类型分组
 *   - getTimeSlotId / formatTimeRange / getScheduleWatermarkText：时段、时间、水印
 *   - appendScheduleWatermark：临时/调整课手写体水印
 *   - .slot-*：dashboard.css 已有的统一视觉 token
 *
 * 调用方负责传入容器与每个角色的差异项（人名来源、状态是否可编辑）。
 */

import { createElement } from './view-utils.js';
import { toISODate } from './date-format.js';
import {
    getTimeSlotId,
    getScheduleWatermarkText
} from './schedule-helpers.js';
import {
    appendScheduleWatermark,
    buildMergedCategoryLabel,
    groupSchedulesByDate,
    groupSchedulesBySlot
} from './schedule-view-utils.js';

const WEEKDAY_FULL = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// 移动端只暴露这两种「需要留意」的状态；已确认 / 已完成 / 已调整不显示
const VISIBLE_STATUS = {
    pending: { text: '待确认', cls: 'msv-status-pending' },
    cancelled: { text: '已取消', cls: 'msv-status-cancelled' }
};

/** 该排课是否需要显示状态标记；返回 {text, cls} 或 null */
function visibleStatusOf(schedule) {
    const st = String(schedule.status || '').toLowerCase();
    return VISIBLE_STATUS[st] || null;
}

// 全部课程类型都走「类型（老师A，老师B，老师C（记录））」合并展示（与导出文件分段一致）。
// 合并标签的构建、老师排序、颜色判定统一收在 schedule-view-utils.js 的
// buildMergedCategoryLabel（PC 页内周视图卡片与这里共用一份实现）。

/**
 * 全类型合并：把同组多位老师合并成「入户（张三，李四，王五（记录））」，
 * 与导出文件的段格式一致。普通老师在前按 teacher_id 升序，记录类老师排最后且名字后标「（记录）」。
 * 颜色随导出文件：红 = 评审族 + 咨询族，蓝 = 集体活动，其余黑。
 */
function buildMergedCategoryLabelForMobile(group, options) {
    // 移动端只显示「待确认/已取消」两种需要留意的状态
    return buildMergedCategoryLabel(group, {
        personName: options.personName,
        buildStatus: visibleStatusOf,
        className: 'msv-merged-category',
        personClassName: 'msc-person',
        statusClassName: 'msv-status'
    });
}

/**
 * 构建单节课程信息（一张组内多人为同槽，并列显示）。
 * @param {Array} group 同一时间/地点/类型的排课记录组
 * @param {object} options 角色差异项
 * @returns {HTMLElement}
 */
function buildCourseLine(group, options) {
    if (!group || group.length === 0) return document.createElement('div');
    const first = group[0];
    const slotId = getTimeSlotId(first.start_time);
    const slotClass = slotId ? `slot-${slotId}` : 'slot-unspecified';

    const isAllCancelled = group.every(s => (s.status || '').toLowerCase() === 'cancelled');

    const line = createElement('div', `msv-course ${slotClass}${isAllCancelled ? ' status-cancelled' : ''}`);
    appendScheduleWatermark(line, getScheduleWatermarkText(group));

    // 多位老师同槽时按 teacher_id 升序显示。「姓名 + 类型 chip」是一组最小的
    // 不可拆单位（整组不换行），多组按可用宽度顺序流式填满每行，放不下才整组换行。
    const list = createElement('div', 'msv-teacher-list');

    // 与导出文件一致：所有类型都合并成「入户（张三，李四，王五（记录））」，
    // 单人也写成「入户（张三）」，保持整个族格式统一
    list.appendChild(buildMergedCategoryLabelForMobile(group, options));
    line.appendChild(list);

    // 底部一行「时间 + 地点」，与 PC 卡片的 schedule-footer 对齐；时间黑色加粗。
    const footer = createElement('div', 'msv-footer');
    const timeText = options.formatTimeRange(first.start_time, first.end_time);
    footer.appendChild(createElement('span', 'msc-time', { textContent: timeText }));
    footer.appendChild(createElement('span', 'msc-location', {
        textContent: first.location || '地点待定'
    }));
    line.appendChild(footer);

    return line;
}

/**
 * 渲染移动端视图到容器：两列表格，第一列日期，第二列课程信息。
 * @param {HTMLElement} container 角色对应的 .schedule-unified-card（或离屏截图宿主）
 * @param {Date[]} weekDates 7 个日期
 * @param {Array} schedules 本周排课记录（扁平）
 * @param {object} options 角色差异项 + scopeId（供截图定位 CSS 作用域）
 */
export function renderMobileScheduleView(container, weekDates, schedules, options) {
    if (!container) return;

    // 收起桌面那张表：保留 DOM（导出桌面视图时还要用），只隐藏。
    const desktopTable = container.querySelector('.weekly-schedule-table');
    if (desktopTable) desktopTable.style.display = 'none';

    container.querySelectorAll('.mobile-schedule-table').forEach(el => el.remove());
    container.querySelector('.mobile-weekly-view')?.remove();

    const scopeId = options.scopeId || 'schedules';
    const root = createElement('div', 'mobile-weekly-view');
    root.id = options.rootId || 'mobileWeeklyView';
    root.dataset.captureScope = scopeId;
    container.appendChild(root);

    const table = createElement('table', 'mobile-weekly-table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    // 第一列：日期 + 本周范围（MM.DD-MM.DD，独立一行避免窄列挤压）；第二列：可带学生姓名
    const range = weekDates && weekDates.length > 1
        ? `${shortDate(weekDates[0])}-${shortDate(weekDates[weekDates.length - 1])}`
        : '';
    const dateTh = createElement('th', 'msv-col-date');
    dateTh.appendChild(createElement('span', 'msv-head-date', { textContent: '日期' }));
    if (range) dateTh.appendChild(createElement('span', 'msv-head-range', { textContent: `（${range}）` }));
    headRow.appendChild(dateTh);
    const studentName = options.studentName ? String(options.studentName).trim() : '';
    headRow.appendChild(createElement('th', 'msv-col-course', {
        textContent: studentName ? `${studentName}入户安排计划` : '入户安排计划'
    }));
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const grouped = groupSchedulesByDate(weekDates, schedules);

    weekDates.forEach(date => {
        const iso = toISODate(date);
        const weekday = WEEKDAY_FULL[date.getDay()];
        const metaText = window.ScheduleDateLabels?.getHeaderMetaText(date);

        const tr = document.createElement('tr');

        // 第一列：日期 + 星期（+ 节假日角标）
        const dateTd = createElement('td', 'msv-date-cell');
        dateTd.appendChild(createElement('span', 'msv-date', { textContent: monthDayLabel(date) }));
        dateTd.appendChild(createElement('span', 'msv-weekday', {
            textContent: weekday + (metaText ? ` · ${metaText}` : '')
        }));
        tr.appendChild(dateTd);

        // 第二列：当天课程（每节一行）
        const courseTd = createElement('td', 'msv-course-cell');
        const daily = grouped.get(iso) || [];
        if (daily.length === 0) {
            courseTd.appendChild(createElement('div', 'no-schedule', { textContent: options.emptyText || '暂无排课' }));
        } else {
            const slots = groupSchedulesBySlot(daily);
            slots.forEach(group => {
                // 老师顺序统一在 buildCourseLine 内按 teacher_id 排（各端 sortGroup 不适用导出视图）
                courseTd.appendChild(buildCourseLine(group, options));
            });
        }
        tr.appendChild(courseTd);

        tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    root.appendChild(table);
}

/** 移除移动端视图并恢复桌面表（切回桌面端时调用） */
export function clearMobileScheduleView(container) {
    if (!container) return;
    container.querySelector('.mobile-weekly-view')?.remove();
    const desktopTable = container.querySelector('.weekly-schedule-table');
    if (desktopTable) desktopTable.style.display = '';
}

function monthDayLabel(date) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 表头周范围用：MM.DD（补零，与日期单元格的月日同源） */
function shortDate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${mm}.${dd}`;
}
