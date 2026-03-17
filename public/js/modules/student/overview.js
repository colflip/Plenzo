/**
 * Student Overview Module
 */

import { API_ENDPOINTS, STATUS_LABELS } from './constants.js';
import { formatDateDisplay, showToast, handleApiError, setText, clearChildren, createElement, formatTimeRange } from './utils.js';

let overviewData = null;

const weeklyLessonsEl = () => document.getElementById('weeklyLessons');
const monthlyLessonsEl = () => document.getElementById('monthlyLessons');
const yearlyLessonsEl = () => document.getElementById('yearlyLessons');

const totalPendingEl = () => document.getElementById('totalPending');
const totalCompletedEl = () => document.getElementById('totalCompleted');
const totalCancelledEl = () => document.getElementById('totalCancelled');

const todayListEl = () => document.getElementById('todayScheduleList');
const refreshBtnEl = () => document.getElementById('refreshTodaySchedulesBtn');

/**
 * 统一的教师排序函数
 * 规则:
 * 1. 特殊课程类型(评审、咨询)的教师排在最后
 * 2. 其他教师按ID由小到大排序
 */
function sortTeachersByIdAndType(scheduleA, scheduleB) {
    const getTypeName = (item) => (
        item.schedule_type_name ||
        item.type_name ||
        item.schedule_type_cn ||
        item.schedule_types ||
        item.schedule_type || ''
    ).toString();

    const isSpecial = (name) => name.includes('评审') || name.includes('咨询');

    const typeA = getTypeName(scheduleA);
    const typeB = getTypeName(scheduleB);
    const specialA = isSpecial(typeA);
    const specialB = isSpecial(typeB);

    // 特殊课程类型排在最后
    if (specialA && !specialB) return 1;
    if (!specialA && specialB) return -1;

    // 其他按教师ID由小到大排序
    return (scheduleA.teacher_id || 0) - (scheduleB.teacher_id || 0);
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

        showStatsErrorState();
        renderTodaySchedules([]);
    }
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
        clearChildren(list);
        list.appendChild(createElement('div', 'today-empty-state', { textContent: '正在加载今日课程...' }));
    }
}

function showStatsErrorState() {
    const t = 'Err';
    setText(weeklyLessonsEl(), t);
    setText(monthlyLessonsEl(), t);
    setText(yearlyLessonsEl(), t);
    setText(totalPendingEl(), t);
    setText(totalCompletedEl(), t);
    setText(totalCancelledEl(), t);

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
// Reward Modal Logic
function createRewardModal() {
    if (document.getElementById('rewardModal')) return;

    const modal = document.createElement('div');
    modal.className = 'reward-modal-overlay';
    modal.id = 'rewardModal';
    modal.innerHTML = `
        <div class="reward-modal-content">
            <span class="material-icons-round reward-icon" id="rewardIcon">emoji_events</span>
            <div class="reward-title" id="rewardTitle">Title</div>
            <div class="reward-value" id="rewardValue">0</div>
            <button class="reward-close-btn" onclick="document.getElementById('rewardModal').classList.remove('active')">Awesome!</button>
        </div>
    `;
    document.body.appendChild(modal);

    // Close on overlay click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
    });
}

function showReward(title, value, type) {
    createRewardModal(); // Ensure it exists
    const modal = document.getElementById('rewardModal');

    document.getElementById('rewardTitle').textContent = title;
    document.getElementById('rewardValue').textContent = value;

    // Icon selection
    const icons = {
        'weekly': 'date_range',
        'monthly': 'calendar_today',
        'yearly': 'star',
        'pending': 'pending_actions',
        'completed': 'verified',
        'cancelled': 'cancel'
    };
    document.getElementById('rewardIcon').textContent = icons[type] || 'emoji_events';

    modal.classList.add('active');
    createConfetti();
}

function createConfetti() {
    const colors = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#6366F1', '#EC4899'];
    const container = document.getElementById('rewardModal');

    for (let i = 0; i < 50; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'reward-confetti';
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.animationDuration = (Math.random() * 3 + 2) + 's';
        confetti.style.animationDelay = Math.random() * 2 + 's';
        container.appendChild(confetti);

        // Cleanup
        setTimeout(() => confetti.remove(), 5000);
    }
}

function updateOverviewDisplay(data) {
    // 卡片数据列表（HTML 已包含渐变卡片结构，仅更新数值）
    const cardDataList = [
        { id: 'weeklyLessons', label: '本周课程', value: data.weeklyCount || 0, type: 'weekly' },
        { id: 'monthlyLessons', label: '本月课程', value: data.monthlyCount || 0, type: 'monthly' },
        { id: 'yearlyLessons', label: '本年课程', value: data.yearlyCount || 0, type: 'yearly' },
        { id: 'totalPending', label: '待排课确认', value: data.totalPending || 0, type: 'pending' },
        { id: 'totalCompleted', label: '已学课程', value: data.totalCompleted || 0, type: 'completed' },
        { id: 'totalCancelled', label: '课程取消', value: data.totalCancelled || 0, type: 'cancelled' }
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
    groupedSchedules.forEach(group => {
        // 使用统一的排序函数
        group.items.sort(sortTeachersByIdAndType);
        fragment.appendChild(buildTodayScheduleCard(group.base, group.items));
    });

    container.appendChild(fragment);

    // 检查溢出并添加跑马灯类
    setTimeout(() => checkLocationOverflow(container), 0);
}

function checkLocationOverflow(container) {
    const locations = container.querySelectorAll('.today-card-bottom .location');
    locations.forEach(el => {
        if (el.scrollWidth > el.offsetWidth) {
            el.classList.add('animate-marquee');
        } else {
            el.classList.remove('animate-marquee');
        }
    });
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

    const timeStr = schedule.start_time;
    const h = parseInt((timeStr || '00:00').substring(0, 2), 10);
    let slotId = 'morning';
    let slotLabel = '上午';
    if (h >= 12) {
        slotId = 'afternoon';
        slotLabel = '下午';
    }
    if (h >= 18) {
        slotId = 'evening';
        slotLabel = '晚上';
    }
    const slotClass = `slot-${slotId}`;

    // Get Type Info
    let typeLabel = schedule.schedule_type_cn;
    if (!typeLabel) {
        if (window.ScheduleTypesStore && window.ScheduleTypesStore.getAll) {
            const allTypes = window.ScheduleTypesStore.getAll();
            const found = allTypes.find(t =>
                (schedule.course_id && t.id == schedule.course_id) ||
                (schedule.schedule_type && t.name === schedule.schedule_type)
            );
            if (found) typeLabel = found.description || found.name;
        }
        if (!typeLabel) typeLabel = schedule.schedule_type || '课程';
    }

    let typeClass = 'type-default';
    if (typeLabel.includes('入户')) typeClass = 'type-visit';
    else if (typeLabel.includes('试教')) typeClass = 'type-trial';
    else if (typeLabel.includes('评审')) typeClass = 'type-review';

    // Create Card Container
    const card = createElement('div', `today-card-modern ${slotClass} ${typeClass} sc-status-${status}`);
    card.setAttribute('role', 'listitem');

    // 上部分容器：3.5:4.5:2 三栏布局
    const topPart = createElement('div', 'today-card-top');

    // 1. Time Column - 左侧时间段显示区
    const timeCol = createElement('div', 'today-card-time');

    const timeText = createElement('div', 'time-range', {
        textContent: formatTimeRange(schedule.start_time, schedule.end_time)
    });

    const slotLabelEl = createElement('div', 'time-slot-label', { textContent: slotLabel });

    timeCol.appendChild(timeText);
    timeCol.appendChild(slotLabelEl);
    topPart.appendChild(timeCol);

    // 2. Info Column - 中间课程信息显示区
    const infoCol = createElement('div', 'today-card-info');

    // Teacher Name + Type
    const titleDiv = createElement('div', 'today-card-title');

    // Teacher Name
    let teacherNameText = schedule.teacher_name || '未分配教师';
    if (isMerged) {
        const tNames = [...new Set(items.map(i => i.teacher_name))];
        teacherNameText = tNames.join('、');
    }

    const nameSpan = createElement('span', 'sc-student-name', { textContent: teacherNameText });
    if (isMerged) nameSpan.title = items.map(i => i.teacher_name).join(', ');
    titleDiv.appendChild(nameSpan);

    const typeBadge = createElement('span', 'today-card-type', { textContent: typeLabel });
    titleDiv.appendChild(typeBadge);

    // Merged Badge
    if (isMerged) {
        const mergedBadge = createElement('span', 'today-card-type', {
            textContent: `${items.length}个合并`,
            style: 'background-color:#E0F2FE; color:#0284C7; border-color:#BAE6FD;'
        });
        titleDiv.appendChild(mergedBadge);
    }

    infoCol.appendChild(titleDiv);

    // 2.2 Location Row (PC 专用显示区) - 新增
    const isMobile = window.innerWidth <= 768;
    if (!isMobile) {
        const locationRow = createElement('div', 'today-card-detail-item location pc-location');
        const pcLocIcon = createElement('i', 'material-icons-round', { textContent: 'location_on' });
        const pcLocText = createElement('span', 'location-text', {
            textContent: schedule.location || '地点待定'
        });
        if (!schedule.location) {
            pcLocText.style.fontStyle = 'italic';
            pcLocText.style.color = '#94a3b8';
        }
        locationRow.appendChild(pcLocIcon);
        locationRow.appendChild(pcLocText);
        infoCol.appendChild(locationRow);
    }

    topPart.appendChild(infoCol);

    // 3. Status Column - 右侧状态显示区
    const statusCol = createElement('div', 'today-card-status');
    const statusPill = createElement('span', `status-pill ${status}`, { textContent: displayStatus });
    statusCol.appendChild(statusPill);
    topPart.appendChild(statusCol);

    card.appendChild(topPart);

    // 下部分容器：上课地点靠右显示
    const bottomPart = createElement('div', 'today-card-bottom');

    const details = createElement('div', 'today-card-details');

    const locationItem = createElement('div', 'today-card-detail-item location');
    const locIcon = createElement('i', 'material-icons-round', { textContent: 'location_on' });

    locationItem.appendChild(locIcon);

    const locSpan = createElement('span', 'location-text', {
        textContent: schedule.location || '地点待定'
    });
    if (!schedule.location) {
        locSpan.style.fontStyle = 'italic';
        locSpan.style.color = '#94a3b8';
    }
    locationItem.appendChild(locSpan);
    details.appendChild(locationItem);
    bottomPart.appendChild(details);
    card.appendChild(bottomPart);

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
