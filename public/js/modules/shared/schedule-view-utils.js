/**
 * 周视图排课卡片的共享渲染辅助。
 *
 * 收拢 student/schedules.js、teacher/schedules.js、teacher/student-schedules.js
 * 三处逐字相同的实现；依赖角色本地 elements / currentWeekStart 的逻辑
 * （bindNavigation 的取钮与翻页回调、updateWeekRangeLabel 的文案格式化）由调用方传入。
 */

import { toISODate, normalizeDateKey } from './date-format.js';
import { createElement } from './view-utils.js';
import { getCardTypeKey } from './schedule-helpers.js';

function richText() {
    return (typeof window !== 'undefined' && window.ScheduleCalendarCore)
        ? window.ScheduleCalendarCore.RichText
        : null;
}

/** 是否「记录」类（评审记录 / 咨询记录），复用 RichText 的判定；无全局组件时按文案兜底 */
export function isRecordTypeOf(schedule) {
    const rt = richText();
    if (rt && typeof rt.isRecordType === 'function') return !!rt.isRecordType(schedule);
    return /记录/.test(String(schedule.schedule_type_cn || schedule.schedule_type || ''));
}

/**
 * 组内老师排序（PC 卡片与移动端视图统一口径）：
 * 记录类老师沉底，其余按 teacher_id 升序；同优先级内也按 teacher_id 升序。
 * @param {Array} group 同一课程（同时间/地点/类型）的排课记录组
 */
export function sortMergedGroup(group) {
    group.sort((a, b) => {
        const aRecord = isRecordTypeOf(a) ? 1 : 0;
        const bRecord = isRecordTypeOf(b) ? 1 : 0;
        if (aRecord !== bRecord) return aRecord - bRecord;
        return (Number(a.teacher_id) || 0) - (Number(b.teacher_id) || 0);
    });
    return group;
}

/**
 * 构建「类型（老师A，老师B，老师C（记录））」合并标签 —— PC 页内周视图卡片与
 * 移动端导出视图共用的一份实现，与导出文件的段格式同口径。
 *
 * 颜色随导出文件（TypeConversion.getColorKind：红 = 评审/咨询族，蓝 = 集体活动，
 * 其余黑）。每位老师名字后可挂自己的状态：buildStatus(rec) 返回 {text, cls} 或
 * null 时渲染文字 span（移动端轻量状态）；需要交互控件（管理端/教师端的状态
 * 下拉）时用 buildStatusNode(rec)，直接返回要插入的元素，返回 null 则不插。
 *
 * @param {Array} group 同一课程（同时间/地点/类型）的排课记录组
 * @param {object} options { personName(rec), buildStatus(rec), buildStatusNode(rec),
 *                           className, personClassName, statusClassName }
 * @returns {HTMLElement}
 */
export function buildMergedCategoryLabel(group, options) {
    const opts = {
        personName: (rec) => rec.teacher_name || rec.teacher_uid || '未指定',
        buildStatus: null,
        buildStatusNode: null,
        className: 'merged-category',
        personClassName: 'merged-person',
        statusClassName: 'merged-status',
        ...options
    };
    const ordered = sortMergedGroup(group.slice());
    const rt = richText();
    const category = (rt && typeof rt.getFoldedDisplayType === 'function')
        ? (rt.getFoldedDisplayType(ordered[0]) || getCardTypeKey(ordered[0]))
        : getCardTypeKey(ordered[0]);

    const tc = (typeof window !== 'undefined' && window.TypeConversion) || null;
    const colorKind = tc && typeof tc.getColorKind === 'function'
        ? tc.getColorKind(category)
        : 'black';
    const colorClass = colorKind === 'red'
        ? ' color-red'
        : colorKind === 'blue' ? ' color-blue' : '';

    // 用 block 容器 + 每个名字是 inline-block（不可拆单元），浏览器与 html2canvas
    // 都按可用宽度贪心填满每一行，放不下才整组换行（与移动端视图同款实现）。
    const wrap = createElement('div', `${opts.className}${colorClass}`);
    wrap.appendChild(document.createTextNode(`${category}（`));
    ordered.forEach((rec, index) => {
        wrap.appendChild(createElement('span', opts.personClassName, {
            textContent: opts.personName(rec) + (isRecordTypeOf(rec) ? '（记录）' : '')
        }));
        if (opts.buildStatusNode) {
            const statusNode = opts.buildStatusNode(rec);
            if (statusNode) wrap.appendChild(statusNode);
        } else if (opts.buildStatus) {
            const status = opts.buildStatus(rec);
            if (status) {
                wrap.appendChild(createElement('span', `${opts.statusClassName} ${status.cls || ''}`, {
                    textContent: `（${status.text}）`
                }));
            }
        }
        if (index < ordered.length - 1) wrap.appendChild(document.createTextNode('，'));
    });
    wrap.appendChild(document.createTextNode('）'));
    return wrap;
}

/**
 * 「导出本周视图」按钮：绑定 + 窄屏显隐。三个角色页以前各抄一份 bind/sync，
 * 已经抄出行为差异（admin 只在网格重画时绑 → 网格加载失败就静默没有反应；
 * admin 也没有窄屏收起）。这里是一份实现，差异靠参数说明。
 *
 * 网格每次重画都会再走到这里，用标记保证只绑一次；窄屏走移动端卡表，
 * 桌面那张要么被隐藏、要么留着上一周的残留内容，截它没有意义。
 */
export function setupWeekViewExportButton({ buttonId, onClick, hideOnMobile = false }) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    if (!btn.__weekViewExportBound) {
        btn.addEventListener('click', onClick);
        btn.__weekViewExportBound = true;
    }
    // 移动端视图现在作为默认、且移动端也能导出，故不再按窄屏隐藏按钮。
}

/** 临时课 / 调整课卡片右下角的手写体水印 */
export function appendScheduleWatermark(card, watermarkText) {
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

/** 按本周日期建立分组骨架，再把记录归位（记录的日期键可能是多种形态） */
export function groupSchedulesByDate(weekDates, schedules) {
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

/** 同一时段 + 同一地点 + 同一课程类型的记录聚成一组（渲染成一张合并卡片） */
export function groupSchedulesBySlot(schedules) {
    const slots = new Map();
    schedules.forEach(s => {
        // 类型也进键：同时间同地点但类型不同（评审 vs 入户）是两节不同的课，
        // 不能并成一张卡 —— 把评审改成入户后，两类老师还挂在同一个场次下。
        const key = `${s.start_time}-${s.end_time}-${s.location || ''}|${getCardTypeKey(s)}`;
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push(s);
    });
    return Array.from(slots.values());
}

/**
 * 绑定上一周 / 下一周翻页按钮（幂等：__scheduleNavBound 防重复绑定）。
 * 翻页动作（改 currentWeekStart + 重新拉数据）由调用方以回调注入。
 */
export function bindWeekNavigation({ prevBtn, nextBtn, onPrev, onNext }) {
    if (prevBtn && !prevBtn.__scheduleNavBound) {
        prevBtn.addEventListener('click', onPrev);
        prevBtn.__scheduleNavBound = true;
    }
    if (nextBtn && !nextBtn.__scheduleNavBound) {
        nextBtn.addEventListener('click', onNext);
        nextBtn.__scheduleNavBound = true;
    }
}

/**
 * 教师维度更新课程状态：教师端两个排课视图共用同一条端点与事件。
 *
 * 状态挂在教师 pair 上，定位一行需要 (session_id, teacher_uid) 两个键 —— 班主任视图里
 * 一场课的老师不是自己，只给场次 id 服务层找不到 pair，会误报「排课不存在」。
 * 所以有 uid 就走 pair 级端点；两个列表接口都已透出 teacher_uid。
 * 无 uid 时退回旧的按场次端点（服务层再按本人在场中的 pair 兜底）。
 */
export async function updateTeacherScheduleStatus(id, newStatus, teacherUid) {
    if (!window.apiUtils) {
        throw new Error('apiUtils 未就绪');
    }
    const response = teacherUid
        ? await window.apiUtils.patch(
            `/teacher/sessions/${id}/teachers/${encodeURIComponent(teacherUid)}/status`,
            { lifecycle: newStatus }
        )
        : await window.apiUtils.put(`/teacher/schedules/${id}/status`, {
            status: newStatus
        });

    window.eventBus?.emit(window.EVENTS?.SCHEDULE_STATUS_CHANGED || 'schedule:statusChanged', {
        id,
        teacher_uid: teacherUid || null,
        status: newStatus,
        role: 'teacher'
    });
    return response;
}
