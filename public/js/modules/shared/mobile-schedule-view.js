/**
 * 周课表「移动端视图」共享渲染：双列表格（第一列日期 / 第二列入户安排计划）。
 *
 * 三端（学生 / 教师 / 班主任）与管理端双击导出共用这一份渲染。
 * 结构是一张两列表格：左列「M月D日 周X」，右列当天所有安排。
 * 每节课内部与 PC 卡片对齐：多位老师同槽时「姓名 + 类型 chip」顺序依次排在同一行、
 * 不强制换行；底部独立一行「时间 + 地点」（时间黑色加粗）。移动端不显示课程状态。
 * 类型 chip 直接复用 dashboard.css 的 .chip.type-* 组件，颜色/字体/高度完全继承前端。
 *
 * 复用既有能力，不重复造轮子：
 *   - groupSchedulesByDate / groupSchedulesBySlot：按日、按时段+地点+类型分组
 *   - getTimeSlotId / formatTimeRange / getScheduleWatermarkText：时段、时间、水印
 *   - appendScheduleWatermark：临时/调整课手写体水印
 *   - .chip / .slot-*：dashboard.css 已有的统一视觉 token
 *
 * 调用方负责传入容器与每个角色的差异项（人名来源、类型文案、状态是否可编辑）。
 */

import { createElement } from './view-utils.js';
import { toISODate } from './date-format.js';
import {
    getTimeSlotId,
    getScheduleWatermarkText
} from './schedule-helpers.js';
import {
    appendScheduleWatermark,
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

// 需要「类型（老师A，老师B，老师C（记录））」合并展示的族。
// 折叠类型名直接复用 ScheduleCalendarCore.RichText（导出文件同一套口径）。
const MERGED_CATEGORIES = ['评审', '咨询'];

function richText() {
    return (typeof window !== 'undefined' && window.ScheduleCalendarCore)
        ? window.ScheduleCalendarCore.RichText
        : null;
}

/** 该排课的折叠类型名（评审记录→评审 / 咨询记录→咨询），无全局组件时按文案兜底 */
function foldedTypeOf(schedule) {
    const rt = richText();
    if (rt && typeof rt.getFoldedDisplayType === 'function') {
        const folded = rt.getFoldedDisplayType(schedule);
        if (folded) return folded;
    }
    const raw = String(schedule.schedule_type_cn || schedule.schedule_type || '').trim();
    return raw.replace(/[（(]线上[）)]/g, '').replace(/记录$/, '').trim();
}

/** 是否「记录」类（评审记录 / 咨询记录），复用 RichText 的判定 */
function isRecordOf(schedule) {
    const rt = richText();
    if (rt && typeof rt.isRecordType === 'function') return !!rt.isRecordType(schedule);
    return /记录/.test(String(schedule.schedule_type_cn || schedule.schedule_type || ''));
}

/**
 * 评审 / 咨询族：把同组多位老师合并成「评审（张三，李四，王五（记录））」，
 * 与导出文件的段格式一致。普通老师在前按 teacher_id 升序，记录类老师排最后且名字后标「（记录）」。
 */
function buildMergedCategoryLabel(group, options, category) {
    const meta = group.map(s => ({ s, isRecord: isRecordOf(s) }));
    // 记录类沉底；族内一律按 teacher_id 升序
    meta.sort((a, b) => {
        if (a.isRecord !== b.isRecord) return a.isRecord ? 1 : -1;
        return (Number(a.s.teacher_id) || 0) - (Number(b.s.teacher_id) || 0);
    });

    // 用 block 容器 + 每个名字是 inline-block（不可拆单元），这样浏览器与 html2canvas
    // 都会按可用宽度贪心填满每一行、放不下才换行，不会留下大片右侧空白。
    const wrap = createElement('div', 'msv-merged-category');
    wrap.appendChild(document.createTextNode(`${category}（`));
    meta.forEach(({ s, isRecord }, index) => {
        const status = visibleStatusOf(s);
        wrap.appendChild(createElement('span', 'msc-person', {
            textContent: options.personName(s) + (isRecord ? '（记录）' : '')
        }));
        if (status) {
            wrap.appendChild(createElement('span', `msv-status ${status.cls}`, { textContent: `（${status.text}）` }));
        }
        if (index < meta.length - 1) wrap.appendChild(document.createTextNode('，'));
    });
    wrap.appendChild(document.createTextNode('）'));
    return wrap;
}

/** 类型文案 → 前端 .chip.type-* 类（直接复用 dashboard.css 的现成组件，不自定义样式） */
function typeClassFromLabel(label) {
    if (!label) return 'type-default';
    if (label.includes('半次')) return 'type-half-visit';
    if (label.includes('评审记录') || label.includes('大评审记录')) return 'type-review-record';
    if (label.includes('咨询记录')) return 'type-advisory';
    if (label.includes('评审')) return 'type-review';
    if (label.includes('试教') || label.includes('试讲')) return 'type-trial';
    if (label.includes('入户')) return 'type-visit';
    if (label.includes('集体')) return 'type-group-activity';
    if (label.includes('咨询')) return 'type-advisory';
    return 'type-default';
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

    // 评审 / 咨询族与导出文件一致：无论人数都合并成「评审（张三，李四，王五（记录））」，
    // 单人也写成「评审（张三）」，保持整个族格式统一
    const category = foldedTypeOf(first);
    if (MERGED_CATEGORIES.includes(category)) {
        list.appendChild(buildMergedCategoryLabel(group, options, category));
        line.appendChild(list);
    } else {
        const ordered = group.slice().sort((a, b) =>
            (Number(a.teacher_id) || 0) - (Number(b.teacher_id) || 0)
        );
        ordered.forEach((schedule, index) => {
            const name = options.personName(schedule);
            const typeLabel = options.typeLabel(schedule);
            const status = visibleStatusOf(schedule);
            const part = createElement('span', 'msv-teacher-part');
            part.appendChild(createElement('span', 'msc-person', { textContent: name }));
            part.appendChild(createElement('span', `chip ${typeClassFromLabel(typeLabel)}`, { textContent: typeLabel }));
            if (status) {
                part.appendChild(createElement('span', `msv-status ${status.cls}`, { textContent: status.text }));
            }
            list.appendChild(part);
            if (index < ordered.length - 1) list.appendChild(document.createTextNode('，'));
        });
        line.appendChild(list);
    }

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
