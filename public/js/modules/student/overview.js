/**
 * Student Overview Module
 */

import { API_ENDPOINTS, STATUS_LABELS } from './constants.js';
import { formatDateDisplay, showToast, handleApiError, setText, clearChildren, createElement, formatTimeRange } from './utils.js';

let overviewData = null;

const monthlyLessonsEl = () => document.getElementById('monthlyLessons');
const pendingEl = () => document.getElementById('pendingConfirmations');
const completedEl = () => document.getElementById('completedLessons');
const todayListEl = () => document.getElementById('todayScheduleList');
const refreshBtnEl = () => document.getElementById('refreshTodaySchedulesBtn');

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

    await loadOverview();
}

/**
 * Load overview data
 */
export async function loadOverview() {
    try {
        showStatsLoadingState();

        const response = await fetch(API_ENDPOINTS.OVERVIEW, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });

        if (!response.ok) {
            throw new Error('获取总览数据失败');
        }

        const data = await response.json();
        overviewData = data;

        updateOverviewDisplay(data);
    } catch (error) {
        console.error('加载总览数据失败', error);
        showStatsErrorState();
        renderTodaySchedules([]);
        // handleApiError(error, '加载总览数据失败'); // Optional: show toast
    }
}

function showStatsLoadingState() {
    setText(monthlyLessonsEl(), '加载中...');
    setText(pendingEl(), '加载中...');
    setText(completedEl(), '加载中...');
    const list = todayListEl();
    if (list) {
        clearChildren(list);
        list.appendChild(createElement('div', 'today-empty-state', { textContent: '正在加载今日课程...' }));
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
            textContent: '今日课程加载失败，请稍后重试'
        }));
    }
}

/**
 * Update overview display
 */
function updateOverviewDisplay(data) {
    // Update stats cards
    const monthlyCount = data.monthlyCount || 0;
    const pendingCount = data.upcomingCount || 0; // Map upcomingCount to pendingConfirmations
    const completedCount = data.completedCount || 0;

    setText(monthlyLessonsEl(), monthlyCount);
    setText(pendingEl(), pendingCount);
    setText(completedEl(), completedCount);

    // Update today's schedules
    renderTodaySchedules(data.todaySchedules || []);
}

/**
 * Render today's schedules list with grouping
 */
function renderTodaySchedules(schedules) {
    const container = todayListEl();
    if (!container) return;

    clearChildren(container);

    if (!Array.isArray(schedules) || schedules.length === 0) {
        container.appendChild(createElement('div', 'today-empty-state', {
            textContent: '今日无课程安排'
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

/**
 * Build today schedule card
 */
function buildTodayScheduleCard(schedule, items = []) {
    const isMerged = items.length > 1;
    const status = (schedule.status || 'pending').toLowerCase();

    // Status localization map
    const statusMap = {
        'pending': '待确认',
        'confirmed': '已确认',
        'completed': '已完成',
        'cancelled': '已取消'
    };
    const displayStatus = statusMap[status] || status;

    // Get time slot for background color
    const slotId = getTimeSlotId(schedule.start_time);
    const slotClass = slotId ? `slot-${slotId}` : 'slot-unspecified';

    // Use group-picker-item for consistent styling
    const card = createElement('div', `group-picker-item ${slotClass} status-${status}`);
    card.setAttribute('role', 'listitem');

    // Override default layout for this specific view if needed, but group-picker-item defaults are good.
    // We want a flex row layout similar to PC schedule cards.
    card.style.cssText = 'display: flex; align-items: center; gap: 8px; padding: 12px;';

    // 1. Time
    const timeSpan = createElement('span', 'time-text', {
        textContent: formatTimeRange(schedule.start_time, schedule.end_time),
        style: 'font-weight: 600; min-width: 85px;'
    });
    card.appendChild(timeSpan);

    // 2. Info Container (Teacher, Type, Location)
    const infoContainer = createElement('div', '', {
        style: 'flex: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 4px;'
    });

    // Teacher
    let teacherNameText = schedule.teacher_name || '未分配教师';
    if (isMerged) {
        const tNames = [...new Set(items.map(i => i.teacher_name))];
        teacherNameText = tNames.join('、');
    }

    const teacherSpan = createElement('span', '', {
        textContent: teacherNameText,
        style: 'font-weight: 500;'
    });
    if (isMerged) teacherSpan.title = items.map(i => i.teacher_name).join(', ');

    infoContainer.appendChild(teacherSpan);
    infoContainer.appendChild(document.createTextNode('，'));

    // Type
    const typeCode = schedule.schedule_type || '';
    const typeLabel = schedule.schedule_type_cn || SCHEDULE_TYPE_MAP[typeCode] || typeCode || '课程';
    let typeClass = 'type-default';
    if (typeLabel.includes('入户')) typeClass = 'type-visit';
    else if (typeLabel.includes('试教')) typeClass = 'type-trial';
    else if (typeLabel.includes('评审')) typeClass = 'type-review';
    else if (typeLabel.includes('半次')) typeClass = 'type-half-visit';
    else if (typeLabel.includes('集体')) typeClass = 'type-group-activity';

    const typeChip = createElement('span', `chip ${typeClass}`, {
        textContent: typeLabel
    });
    infoContainer.appendChild(typeChip);
    infoContainer.appendChild(document.createTextNode('，'));

    // Merged Badge
    if (isMerged) {
        const mergedBadge = createElement('span', 'chip', { textContent: `${items.length}个合并` });
        mergedBadge.style.cssText = 'font-size:11px;background:#e0f2fe;color:#0284c7;padding:1px 6px;margin-right:4px;';
        infoContainer.appendChild(mergedBadge);
    }

    // Location
    const locationText = schedule.location || '上课地点未确定';
    const locationSpan = createElement('span', '', {
        textContent: locationText
    });
    if (!schedule.location) {
        locationSpan.style.color = '#9ca3af';
        locationSpan.style.fontStyle = 'italic';
    }
    infoContainer.appendChild(locationSpan);

    card.appendChild(infoContainer);

    // 3. Status Chip
    const statusChip = createElement('span', `chip status-${status}`, {
        textContent: displayStatus,
        style: 'margin-left: auto;'
    });
    card.appendChild(statusChip);

    return card;
}

// Helper to get time slot ID (duplicated from utils to avoid import issues if not modularized)
function getTimeSlotId(timeStr) {
    if (!timeStr) return null;
    const hour = parseInt(timeStr.split(':')[0], 10);
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}
