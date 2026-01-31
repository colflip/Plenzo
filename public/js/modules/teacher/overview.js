import { DEFAULT_LOCATION_PLACEHOLDER, EMPTY_STATES, getScheduleTypeLabel, getStatusLabel } from './constants.js';
import { clearChildren, createElement, formatTimeRange, setText, toISODate } from './utils.js';

const monthlyLessonsEl = () => document.getElementById('monthlyLessons');
const pendingEl = () => document.getElementById('pendingConfirmations');
const completedEl = () => document.getElementById('completedLessons');
const todayListEl = () => document.getElementById('todayScheduleList');
const refreshBtnEl = () => document.getElementById('refreshTodaySchedulesBtn');

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
    await loadOverview();
}

export async function loadOverview() {
    try {
        showStatsLoadingState();

        // Use dedicated overview endpoint that provides all stats
        const overviewData = await window.apiUtils.get('/teacher/overview');

        updateMonthlyStats(overviewData);
        renderTodaySchedules(Array.isArray(overviewData.todaySchedules) ? overviewData.todaySchedules : []);
    } catch (error) {
        console.error('加载总览数据失败', error);
        showStatsErrorState();
        renderTodaySchedules([]);
    }
}

function showStatsLoadingState() {
    setText(monthlyLessonsEl(), '加载中...');
    setText(pendingEl(), '加载中...');
    setText(completedEl(), '加载中...');
    const list = todayListEl();
    if (list) {
        clearChildren(list);
        list.appendChild(createElement('div', 'today-empty-state', { textContent: '正在加载今日排课...' }));
    }
}

function showStatsErrorState() {
    setText(monthlyLessonsEl(), '加载失败');
    setText(pendingEl(), '加载失败');
    setText(completedEl(), '加载失败');
    const list = todayListEl();
    if (list) {
        clearChildren(list);
        list.appendChild(createElement('div', 'today-empty-state', {
            textContent: '今日排课加载失败，请稍后重试'
        }));
    }
}

function updateMonthlyStats(overviewData) {
    // Extract counts directly from overview API response
    const monthlyCount = overviewData?.monthlyCount ?? 0;
    const pendingCount = overviewData?.pendingCount ?? 0;
    const completedCount = overviewData?.completedCount ?? 0;

    setText(monthlyLessonsEl(), monthlyCount);
    setText(pendingEl(), pendingCount);
    setText(completedEl(), completedCount);
}

function renderTodaySchedules(schedules) {
    const container = todayListEl();
    if (!container) return;

    clearChildren(container);

    if (!Array.isArray(schedules) || schedules.length === 0) {
        container.appendChild(createElement('div', 'today-empty-state', {
            textContent: EMPTY_STATES.todaySchedules
        }));
        return;
    }

    // 1. Grouping Logic
    const groups = {};
    schedules.forEach(schedule => {
        const key = `${schedule.start_time}-${schedule.end_time}-${schedule.location || 'unknown'}`;
        if (!groups[key]) {
            groups[key] = {
                base: schedule,
                items: []
            };
        }
        groups[key].items.push(schedule);
    });

    // 2. Sort and Render
    const groupedSchedules = Object.values(groups).sort((a, b) => {
        return (a.base.start_time || '').localeCompare(b.base.start_time || '');
    });

    const fragment = document.createDocumentFragment();
    groupedSchedules.forEach(group => fragment.appendChild(buildTodayScheduleCard(group.base, group.items)));

    container.appendChild(fragment);
}

function buildTodayScheduleCard(schedule, items = []) {
    const isMerged = items.length > 1;
    const status = (schedule.status || 'pending').toLowerCase();
    const card = createElement('div', `today-schedule-card status-${status}`);
    card.setAttribute('role', 'listitem');

    // Apply card styling directly for consistency
    card.style.cssText = `
        display: flex;
        align-items: center;
        padding: 16px;
        background: #fff;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        margin-bottom: 0;
        transition: all 0.2s ease;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    `;

    // 1. Time Column
    const timeCol = createElement('div', 'time-column');
    timeCol.style.cssText = 'flex: 0 0 120px; font-family: "Roboto Mono", monospace; font-size: 14px; font-weight: 600; color: #1e293b;';
    timeCol.textContent = formatTimeRange(schedule.start_time, schedule.end_time);
    card.appendChild(timeCol);

    // 2. Info Column (Student & Type)
    const infoCol = createElement('div', 'info-column');
    infoCol.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 4px;';

    const studentRow = createElement('div', 'student-row');
    studentRow.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;';

    // Prepare Student Name(s) logic
    let studentNameText = schedule.student_name || '未指定学生';
    if (isMerged) {
        const uniqueNames = [...new Set(items.map(i => i.student_name))];
        studentNameText = uniqueNames.join('、');
        if (uniqueNames.length > 3) {
            studentNameText = `${uniqueNames.slice(0, 3).join('、')} 等${uniqueNames.length}人`;
        }
    }

    const studentName = createElement('span', 'student-name', {
        textContent: studentNameText
    });
    // Add tooltip if merged
    if (isMerged) {
        studentName.title = items.map(i => i.student_name).join(', ');
    }

    studentName.style.cssText = 'font-weight: 600; font-size: 15px; color: #0f172a;';

    const typeBadge = createElement('span', 'type-badge', {
        textContent: getScheduleTypeLabel(schedule.schedule_type || schedule.schedule_types)
    });
    typeBadge.style.cssText = 'font-size: 12px; padding: 2px 8px; background: #f1f5f9; color: #64748b; border-radius: 4px; font-weight: 500;';

    studentRow.appendChild(studentName);
    studentRow.appendChild(typeBadge);

    if (isMerged) {
        const mergedBadge = createElement('span', 'merged-badge', { textContent: `${items.length}个合并` });
        mergedBadge.style.cssText = 'font-size: 11px; color: #0284c7; background: #e0f2fe; padding: 1px 6px; border-radius: 4px; border: 1px solid #bae6fd;';
        studentRow.appendChild(mergedBadge);
    }

    infoCol.appendChild(studentRow);

    const locationRow = createElement('div', 'location-row');
    const locationIcon = createElement('i', 'material-icons-round', { textContent: 'location_on' });
    locationIcon.style.cssText = 'font-size: 14px; color: #94a3b8; vertical-align: text-bottom; margin-right: 4px;';

    const locationText = createElement('span', 'location-text', {
        textContent: schedule.location || DEFAULT_LOCATION_PLACEHOLDER
    });
    locationText.style.cssText = 'font-size: 13px; color: #64748b;';

    locationRow.appendChild(locationIcon);
    locationRow.appendChild(locationText);
    infoCol.appendChild(locationRow);

    card.appendChild(infoCol);

    // 3. Status Column
    const statusCol = createElement('div', 'status-column');
    statusCol.style.cssText = 'flex: 0 0 auto; margin-left: 16px;';

    const statusBadge = createElement('span', `status-badge status-${status}`, {
        textContent: getStatusLabel(status)
    });
    // Status badge styling
    let statusColor = '#64748b';
    let statusBg = '#f1f5f9';

    if (status === 'pending') { statusColor = '#d97706'; statusBg = '#fffbeb'; }
    else if (status === 'confirmed') { statusColor = '#059669'; statusBg = '#ecfdf5'; }
    else if (status === 'completed') { statusColor = '#2563eb'; statusBg = '#eff6ff'; }
    else if (status === 'cancelled') { statusColor = '#dc2626'; statusBg = '#fef2f2'; }

    statusBadge.style.cssText = `
        display: inline-block;
        padding: 4px 12px;
        border-radius: 9999px;
        font-size: 12px;
        font-weight: 600;
        color: ${statusColor};
        background-color: ${statusBg};
    `;

    statusCol.appendChild(statusBadge);
    card.appendChild(statusCol);

    return card;
}

