/**
 * 周视图排课卡片的共享渲染辅助。
 *
 * 收拢 student/schedules.js、teacher/schedules.js、teacher/student-schedules.js
 * 三处逐字相同的实现；依赖角色本地 elements / currentWeekStart 的逻辑
 * （bindNavigation 的取钮与翻页回调、updateWeekRangeLabel 的文案格式化）由调用方传入。
 */

import { toISODate, normalizeDateKey } from './date-format.js';
import { createElement } from './view-utils.js';

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

/** 同一时段 + 同一地点的记录聚成一组（渲染成一张合并卡片） */
export function groupSchedulesBySlot(schedules) {
    const slots = new Map();
    schedules.forEach(s => {
        const key = `${s.start_time}-${s.end_time}-${s.location || ''}`;
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
 * （course_sessions 之后状态挂在教师 pair 上，前端只需按场次 id 提交。）
 */
export async function updateTeacherScheduleStatus(id, newStatus) {
    if (!window.apiUtils) {
        throw new Error('apiUtils 未就绪');
    }
    const response = await window.apiUtils.put(`/teacher/schedules/${id}/status`, {
        status: newStatus
    });

    window.eventBus?.emit(window.EVENTS?.SCHEDULE_STATUS_CHANGED || 'schedule:statusChanged', {
        id,
        status: newStatus,
        role: 'teacher'
    });
    return response;
}
