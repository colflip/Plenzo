/**
 * 管理端总览「今日排课」逻辑
 * @description 渲染复用三端共享模块（shared/today-schedule.js，教师端表格实现）
 */

import { normalizeScheduleRows } from './schedule-utils.js';
import {
    renderGroupedTodayScheduleList,
    showTodayScheduleLoading,
    showTodayScheduleError,
    getTodayStr,
    shiftDateStr,
    formatDateCn
} from '../shared/today-schedule.js';

// 当前查看的日期（'YYYY-MM-DD'），null 表示今天
let viewDate = null;

function getViewDate() {
    if (!viewDate) viewDate = getTodayStr();
    return viewDate;
}

// 加载当前查看日期的排课
export async function loadTodaySchedules() {
    const container = document.getElementById('todayScheduleList');
    if (!container) return;

    const dateStr = getViewDate();

    // 非今天日期时标题切换为「当前排课」
    const titleEl = document.getElementById('todayScheduleTitle');
    if (titleEl) titleEl.textContent = dateStr === getTodayStr() ? '今日排课' : '当前排课';

    // 统一加载视觉：紧凑横向 spinner + 文案
    showTodayScheduleLoading(container, '正在加载今日排课...');

    try {
        // 直接调用 API 获取该日期所有排课（不分老师/学生）
        const schedules = await window.apiUtils.get('/admin/schedules/grid', {
            start_date: dateStr,
            end_date: dateStr
        });

        const normalized = normalizeScheduleRows(Array.isArray(schedules) ? schedules : []);
        // 查看非今天日期时，行内时段前显示日期
        const dateText = getViewDate() === getTodayStr() ? '' : formatDateCn(getViewDate());
        renderGroupedTodayScheduleList(container, normalized, {
            dateText,
            emptyText: dateStr === getTodayStr() ? '今日暂无排课安排' : '该日暂无排课安排',
            nameField: 'student_name',
            fallbackName: '未指定学生',
            secondaryNameField: 'teacher_name',
            secondaryFallback: '未分配教师',
            nameFirst: true
        });
    } catch (error) {
        showTodayScheduleError(container, '', {
            error,
            onRetry: () => loadTodaySchedules()
        });
    }
}

function setupTodaySchedulesRefresh() {
    const refreshBtn = document.getElementById('refreshTodaySchedulesBtn');
    if (!refreshBtn || refreshBtn.dataset.todaySchedulesBound === 'true') return;

    refreshBtn.dataset.todaySchedulesBound = 'true';
    refreshBtn.addEventListener('click', () => {
        refreshBtn.disabled = true;
        refreshBtn.classList.add('loading');
        loadTodaySchedules().finally(() => {
            refreshBtn.disabled = false;
            refreshBtn.classList.remove('loading');
        });
    });

    // 上一天 / 下一天 导航
    const navigate = (delta) => {
        viewDate = shiftDateStr(getViewDate(), delta);
        loadTodaySchedules();
    };
    document.getElementById('prevDayBtn')?.addEventListener('click', () => navigate(-1));
    document.getElementById('nextDayBtn')?.addEventListener('click', () => navigate(1));
}

// 供 legacy-adapter.js / ui-layout.js / schedule-utils.js 调用
window.loadTodaySchedules = loadTodaySchedules;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupTodaySchedulesRefresh, { once: true });
} else {
    setupTodaySchedulesRefresh();
}
