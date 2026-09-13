import { setText } from './utils.js';
import { createInlineLoading } from '../shared/loading-ui.js';
import { renderErrorState } from '../shared/error-ui.js';
import { showReward } from '../shared/reward-view.js';
import {
    renderGroupedTodayScheduleList,
    showTodayScheduleError,
    getTodayStr,
    shiftDateStr,
    formatDateCn
} from '../shared/today-schedule.js';

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

// 按日期查询排课（教师端列表接口，返回数组）
async function fetchSchedulesForDate(dateStr) {
    const data = await window.apiUtils.get('/teacher/schedules', {
        startDate: dateStr,
        endDate: dateStr
    });
    if (!Array.isArray(data)) {
        throw new Error('课程安排响应格式无效');
    }
    return data;
}

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
        const list = todayListEl();
        if (list) list.replaceChildren(createInlineLoading('正在加载今日排课...', { compact: true }));
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

/** 今日排课统一错误态（shared/error-ui.js 卡片 + 重试） */
function showTodayListError(error) {
    const list = todayListEl();
    if (!list) return;
    showTodayScheduleError(list, '', {
        error,
        onRetry: async () => {
            showTodayScheduleLoading(list, '正在加载今日排课...');
            try {
                renderTodaySchedules(await fetchSchedulesForDate(getViewDate()));
            } catch (err) {
                showTodayListError(err);
            }
        }
    });
}

export async function loadOverview() {
    try {
        showStatsLoadingState();

        // Use dedicated overview endpoint that provides all stats
        const overviewData = await window.apiUtils.get('/teacher/overview');
        const metricKeys = [
            'weeklyCount', 'monthlyCount', 'yearlyCount',
            'totalPending', 'totalCompleted', 'totalCancelled'
        ];
        if (!overviewData || typeof overviewData !== 'object' || Array.isArray(overviewData) ||
            !Array.isArray(overviewData.todaySchedules) ||
            metricKeys.some(key => !Number.isFinite(Number(overviewData[key])))) {
            throw new Error('总览数据响应格式无效');
        }

        clearStatsErrorState();
        updateOverviewStats(overviewData);
        updateTodayTitle();
        // 当前查看的是今天时直接用总览接口附带的数据，否则按查看日期查询
        if (getViewDate() === getTodayStr()) {
            renderTodaySchedules(overviewData.todaySchedules);
        } else {
            try {
                renderTodaySchedules(await fetchSchedulesForDate(getViewDate()));
            } catch (error) {
                showTodayListError(error);
            }
        }
    } catch (error) {
        showStatsErrorState(error);
    }
}

function showStatsLoadingState() {
    const loadingText = '...';
    setText(weeklyLessonsEl(), loadingText);
    setText(monthlyLessonsEl(), loadingText);
    setText(yearlyLessonsEl(), loadingText);
    setText(totalPendingEl(), loadingText);
    setText(totalCompletedEl(), loadingText);
    setText(totalCancelledEl(), loadingText);

    const list = todayListEl();
    if (list) {
        // 统一加载视觉：紧凑横向 spinner + 文案
        list.replaceChildren(createInlineLoading('正在加载今日排课...', { compact: true }));
    }
}

function clearStatsErrorState() {
    document.getElementById('teacherOverviewStatsError')?.remove();
    const statsGrid = document.querySelector('#overview .overview-stats-grid');
    if (statsGrid) statsGrid.hidden = false;
}

function showStatsErrorState(error) {
    const statsGrid = document.querySelector('#overview .overview-stats-grid');
    if (statsGrid) statsGrid.hidden = true;

    const section = document.getElementById('overview');
    if (section) {
        let errorContainer = document.getElementById('teacherOverviewStatsError');
        if (!errorContainer) {
            errorContainer = document.createElement('div');
            errorContainer.id = 'teacherOverviewStatsError';
            if (statsGrid) statsGrid.insertAdjacentElement('beforebegin', errorContainer);
            else section.prepend(errorContainer);
        }
        renderErrorState(errorContainer, {
            error,
            title: '授课统计加载失败',
            detail: null,
            onRetry: () => loadOverview(),
            retryText: '重试',
            compact: true
        });
    }

    showTodayListError(error);
}

// 酬劳达成弹窗逻辑见 shared/reward-view.js

function updateOverviewStats(overviewData) {
    // 卡片数据列表（HTML 已包含渐变卡片结构，仅更新数值）
    const cardDataList = [
        { id: 'weeklyLessons', label: '本周授课', value: Number(overviewData.weeklyCount), type: 'weekly' },
        { id: 'monthlyLessons', label: '本月授课', value: Number(overviewData.monthlyCount), type: 'monthly' },
        { id: 'yearlyLessons', label: '本年授课', value: Number(overviewData.yearlyCount), type: 'yearly' },
        { id: 'totalPending', label: '待我确认', value: Number(overviewData.totalPending), type: 'pending' },
        { id: 'totalCompleted', label: '已完成授课', value: Number(overviewData.totalCompleted), type: 'completed' },
        { id: 'totalCancelled', label: '已取消记录', value: Number(overviewData.totalCancelled), type: 'cancelled' }
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
}

// 「今日排课」标题：非今天日期时显示「当前排课」
function updateTodayTitle() {
    const titleEl = document.getElementById('todayScheduleTitle');
    if (titleEl) titleEl.textContent = getViewDate() === getTodayStr() ? '今日排课' : '当前排课';
}

// 「今日排课」渲染复用三端共享分组渲染（与学生端/管理端一致：按学生分组 + 评审/咨询合并）
function renderTodaySchedules(schedules) {
    const isToday = getViewDate() === getTodayStr();
    renderGroupedTodayScheduleList(todayListEl(), schedules, {
        emptyText: isToday ? '今日暂无排课安排' : '该日暂无排课安排',
        dateText: isToday ? '' : formatDateCn(getViewDate()),
        nameField: 'student_name',
        fallbackName: '未指定学生',
        secondaryNameField: 'teacher_name',
        secondaryFallback: '',
        nameFirst: true
    });
}

