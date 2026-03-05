import { DEFAULT_LOCATION_PLACEHOLDER, EMPTY_STATES, getScheduleTypeLabel, getStatusLabel } from './constants.js';
import { clearChildren, createElement, formatTimeRange, setText, toISODate } from './utils.js';

const weeklyLessonsEl = () => document.getElementById('weeklyLessons');
const monthlyLessonsEl = () => document.getElementById('monthlyLessons');
const yearlyLessonsEl = () => document.getElementById('yearlyLessons');

const totalPendingEl = () => document.getElementById('totalPending');
const totalCompletedEl = () => document.getElementById('totalCompleted');
const totalCancelledEl = () => document.getElementById('totalCancelled');

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

        updateOverviewStats(overviewData);
        renderTodaySchedules(Array.isArray(overviewData.todaySchedules) ? overviewData.todaySchedules : []);
    } catch (error) {

        showStatsErrorState();
        renderTodaySchedules([]);
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
        clearChildren(list);
        list.appendChild(createElement('div', 'today-empty-state', { textContent: '正在加载今日排课...' }));
    }
}

function showStatsErrorState() {
    const errorText = 'Err';
    setText(weeklyLessonsEl(), errorText);
    setText(monthlyLessonsEl(), errorText);
    setText(yearlyLessonsEl(), errorText);
    setText(totalPendingEl(), errorText);
    setText(totalCompletedEl(), errorText);
    setText(totalCancelledEl(), errorText);

    const list = todayListEl();
    if (list) {
        clearChildren(list);
        list.appendChild(createElement('div', 'today-empty-state', {
            textContent: '今日排课加载失败，请稍后重试'
        }));
    }
}

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

function updateOverviewStats(overviewData) {
    // 卡片数据列表（HTML 已包含渐变卡片结构，仅更新数值）
    const cardDataList = [
        { id: 'weeklyLessons', label: '本周授课', value: overviewData?.weeklyCount ?? 0, type: 'weekly' },
        { id: 'monthlyLessons', label: '本月授课', value: overviewData?.monthlyCount ?? 0, type: 'monthly' },
        { id: 'yearlyLessons', label: '本年授课', value: overviewData?.yearlyCount ?? 0, type: 'yearly' },
        { id: 'totalPending', label: '待我确认', value: overviewData?.totalPending ?? 0, type: 'pending' },
        { id: 'totalCompleted', label: '已完成授课', value: overviewData?.totalCompleted ?? 0, type: 'completed' },
        { id: 'totalCancelled', label: '已取消记录', value: overviewData?.totalCancelled ?? 0, type: 'cancelled' }
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

    // Status localization map (Teacher view usually uses getStatusLabel import)
    const displayStatus = getStatusLabel(status);

    // Get time slot
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

    // Determine Course Type Class for overall card styling
    const typeLabel = getScheduleTypeLabel(schedule.schedule_type || schedule.schedule_types);
    let typeClass = 'type-default';
    if (typeLabel.includes('入户')) typeClass = 'type-visit';
    else if (typeLabel.includes('试教')) typeClass = 'type-trial';
    else if (typeLabel.includes('评审')) typeClass = 'type-review';

    // Create Card Container
    const card = createElement('div', `today-card-modern ${slotClass} ${typeClass} sc-status-${status}`);
    card.setAttribute('role', 'listitem');

    // 1. Time Column
    const timeCol = createElement('div', 'today-card-time');

    const timeText = createElement('div', 'time-range', {
        textContent: formatTimeRange(schedule.start_time, schedule.end_time)
    });

    const slotLabelEl = createElement('div', 'time-slot-label', { textContent: slotLabel });

    timeCol.appendChild(timeText);
    timeCol.appendChild(slotLabelEl);
    card.appendChild(timeCol);

    // 2. Info Column
    const infoCol = createElement('div', 'today-card-info');

    // Header: Student Name + Type
    const header = createElement('div', 'today-card-header');

    // Student Name(s) rendering logic
    let studentNameText = schedule.student_name || '未指定学生';
    if (isMerged) {
        const uniqueNames = [...new Set(items.map(i => i.student_name))];
        studentNameText = uniqueNames.join('、');
        if (uniqueNames.length > 3) {
            studentNameText = `${uniqueNames.slice(0, 3).join('、')} 等${uniqueNames.length}人`;
        }
    }

    const titleDiv = createElement('div', 'today-card-title');
    const nameSpan = createElement('span', 'sc-student-name', { textContent: studentNameText });
    if (isMerged) nameSpan.title = items.map(i => i.student_name).join(', ');
    titleDiv.appendChild(nameSpan);

    // Type Badge
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

    header.appendChild(titleDiv);
    infoCol.appendChild(header);

    // Details: Location
    const details = createElement('div', 'today-card-details');

    const locationItem = createElement('div', 'today-card-detail-item location');
    const locIcon = createElement('i', 'material-icons-round', { textContent: 'location_on' });
    const locationText = createElement('span', '', {
        textContent: schedule.location || DEFAULT_LOCATION_PLACEHOLDER
    });

    locationItem.appendChild(locIcon);
    locationItem.appendChild(locationText);
    details.appendChild(locationItem);

    infoCol.appendChild(details);
    card.appendChild(infoCol);

    // 3. Status Column
    const statusCol = createElement('div', 'today-card-status');
    const statusPill = createElement('span', `status-pill ${status}`, { textContent: displayStatus });
    statusCol.appendChild(statusPill);
    card.appendChild(statusCol);

    return card;
}

