/**
 * Student Overview Module
 */

import { renderErrorState } from '../shared/error-ui.js';
import { API_ENDPOINTS } from './constants.js';
import { setText } from './utils.js';
import { showReward } from '../shared/reward-view.js';
import {
    renderGroupedTodayScheduleList,
    showTodayScheduleLoading,
    showTodayScheduleError,
    getTodayStr,
    shiftDateStr,
    formatDateCn
} from '../shared/today-schedule.js';

let overviewData = null;

const weeklyLessonsEl = () => document.getElementById('weeklyLessons');
const monthlyLessonsEl = () => document.getElementById('monthlyLessons');
const yearlyLessonsEl = () => document.getElementById('yearlyLessons');

const totalPendingEl = () => document.getElementById('totalPending');
const totalCompletedEl = () => document.getElementById('totalCompleted');
const totalCancelledEl = () => document.getElementById('totalCancelled');

const todayListEl = () => document.getElementById('todayScheduleList');
const refreshBtnEl = () => document.getElementById('refreshTodaySchedulesBtn');

// 当前查看的日期（'YYYY-MM-DD'），null 表示今天
let viewDate = null;

function getViewDate() {
    if (!viewDate) viewDate = getTodayStr();
    return viewDate;
}

// 按日期查询课程（学生端列表接口，返回数组）
async function fetchSchedulesForDate(dateStr) {
    if (!window.apiUtils) throw new Error('API 客户端尚未加载');
    const data = await window.apiUtils.get(
        `${API_ENDPOINTS.SCHEDULES}?startDate=${encodeURIComponent(dateStr)}&endDate=${encodeURIComponent(dateStr)}`,
        {},
        { timeoutMs: 15000, suppressErrorToast: true }
    );
    if (!Array.isArray(data)) throw new Error('课程列表响应格式无效');
    return data;
}

/**
 * Initialize overview section
 */
export async function initOverviewSection() {

    const refreshButton = refreshBtnEl();
    if (refreshButton) {
        refreshButton.addEventListener('click', () => {
            refreshButton.disabled = true;
            refreshButton.classList.add('loading');
            loadOverview().finally(() => {
                refreshButton.disabled = false;
                refreshButton.classList.remove('loading');
            });
        });
    }

    // 上一天 / 下一天 导航
    const navigate = async (delta) => {
        viewDate = shiftDateStr(getViewDate(), delta);
        updateTodayTitle();
        showTodayScheduleLoading(todayListEl(), '正在加载今日课程...');
        try {
            renderTodaySchedules(await fetchSchedulesForDate(getViewDate()));
        } catch (error) {
            showTodayListError(error);
        }
    };
    document.getElementById('prevDayBtn')?.addEventListener('click', () => navigate(-1));
    document.getElementById('nextDayBtn')?.addEventListener('click', () => navigate(1));

    await loadOverview();
}

/** 今日课程统一错误态（shared/error-ui.js 卡片 + 重试） */
function showTodayListError(error) {
    const list = todayListEl();
    if (!list) return;
    showTodayScheduleError(list, '', {
        error,
        onRetry: async () => {
            showTodayScheduleLoading(list, '正在加载今日课程...');
            try {
                renderTodaySchedules(await fetchSchedulesForDate(getViewDate()));
            } catch (err) {
                showTodayListError(err);
            }
        }
    });
}

/**
 * Load overview data
 */
export async function loadOverview() {
    try {
        showStatsLoadingState();
        if (!window.apiUtils) throw new Error('API 客户端尚未加载');

        const data = await window.apiUtils.get(API_ENDPOINTS.OVERVIEW, {}, {
            timeoutMs: 15000,
            suppressErrorToast: true
        });
        if (!isValidOverviewPayload(data)) {
            throw new Error('总览数据响应格式无效');
        }
        overviewData = data;
        clearStatsErrorState();

        updateOverviewDisplay(data);

        updateTodayTitle();

        // 当前查看的是今天时直接用总览接口附带的数据，否则按查看日期查询
        if (getViewDate() === getTodayStr()) {
            renderTodaySchedules(data.todaySchedules);
        } else {
            renderTodaySchedules(await fetchSchedulesForDate(getViewDate()));
        }
    } catch (error) {
        showStatsErrorState(error);
    }
}

function isValidOverviewPayload(data) {
    const countFields = [
        'weeklyCount',
        'monthlyCount',
        'yearlyCount',
        'totalPending',
        'totalCompleted',
        'totalCancelled'
    ];
    return data && typeof data === 'object' &&
        countFields.every(field =>
            Object.prototype.hasOwnProperty.call(data, field) &&
            data[field] !== null &&
            data[field] !== '' &&
            Number.isFinite(Number(data[field]))
        ) &&
        Array.isArray(data.todaySchedules);
}

function showStatsLoadingState() {
    const t = '...';
    setText(weeklyLessonsEl(), t);
    setText(monthlyLessonsEl(), t);
    setText(yearlyLessonsEl(), t);
    setText(totalPendingEl(), t);
    setText(totalCompletedEl(), t);
    setText(totalCancelledEl(), t);

    const list = todayListEl();
    if (list) {
        // 统一加载视觉：紧凑横向 spinner + 文案（复用共享模块）
        showTodayScheduleLoading(list, '正在加载今日课程...');
    }
}

function clearStatsErrorState() {
    document.getElementById('studentOverviewStatsError')?.remove();
    const grid = document.querySelector('#overview .overview-stats-grid');
    if (grid) grid.hidden = false;
}

function showStatsErrorState(error) {
    const grid = document.querySelector('#overview .overview-stats-grid');
    if (grid) grid.hidden = true;

    let errorContainer = document.getElementById('studentOverviewStatsError');
    if (!errorContainer && grid) {
        errorContainer = document.createElement('div');
        errorContainer.id = 'studentOverviewStatsError';
        grid.insertAdjacentElement('beforebegin', errorContainer);
    }
    if (errorContainer) {
        renderErrorState(errorContainer, {
            error,
            title: '总览数据加载失败',
            detail: null,
            onRetry: () => loadOverview(),
            retryText: '重试',
            compact: true
        });
    }

    showTodayListError(error);
}

/**
 * Update overview display
 */
// 酬劳达成弹窗逻辑见 shared/reward-view.js

function updateOverviewDisplay(data) {
    // 卡片数据列表（HTML 已包含渐变卡片结构，仅更新数值）
    const cardDataList = [
        { id: 'weeklyLessons', label: '本周课程', value: Number(data.weeklyCount), type: 'weekly' },
        { id: 'monthlyLessons', label: '本月课程', value: Number(data.monthlyCount), type: 'monthly' },
        { id: 'yearlyLessons', label: '本年课程', value: Number(data.yearlyCount), type: 'yearly' },
        { id: 'totalPending', label: '待排课确认', value: Number(data.totalPending), type: 'pending' },
        { id: 'totalCompleted', label: '已学课程', value: Number(data.totalCompleted), type: 'completed' },
        { id: 'totalCancelled', label: '课程取消', value: Number(data.totalCancelled), type: 'cancelled' }
    ];

    cardDataList.forEach((item) => {
        const el = document.getElementById(item.id);
        if (!el) return;
        el.textContent = item.value;

        // 绑定点击事件
        const card = el.closest('.stat-card');
        if (card) {
            const newCard = card.cloneNode(true);
            card.parentNode.replaceChild(newCard, card);
            newCard.addEventListener('click', () => showReward(item.label, item.value, item.type));
            newCard.style.cursor = 'pointer';
        }
    });

        // Update today's schedules
        // （改由 loadOverview 按当前查看日期渲染，见下方）
    }

// 「今日课程」标题：非今天日期时显示「当前课程」
function updateTodayTitle() {
    const titleEl = document.getElementById('todayScheduleTitle');
    if (titleEl) titleEl.textContent = getViewDate() === getTodayStr() ? '今日课程' : '当前课程';
}

/**
 * Render today's schedules list
 * 「今日课程」渲染复用三端共享模块（shared/today-schedule.js，教师端表格实现），
 * 行内展示授课教师（teacher_name）
 */
function renderTodaySchedules(schedules) {
    const isToday = getViewDate() === getTodayStr();
    // 与管理端/教师端一致的分组渲染；学生端按教师分组，姓名显示教师
    renderGroupedTodayScheduleList(todayListEl(), schedules, {
        emptyText: isToday ? '今日暂无课程安排' : '该日暂无课程安排',
        dateText: isToday ? '' : formatDateCn(getViewDate()),
        groupFields: { id: 'teacher_id', name: 'teacher_name' },
        nameField: 'teacher_name',
        fallbackName: '未分配教师',
        nameFirst: true
    });
}
