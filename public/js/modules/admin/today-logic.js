
// 加载今日排课
async function loadTodaySchedules() {
    const container = document.getElementById('todayScheduleList');
    if (!container) return;

    container.innerHTML = '<div class="no-data" style="text-align: center; color: #64748b; padding: 20px;">加载中...</div>';

    try {
        const today = new Date();
        const dateStr = today.toISOString().split('T')[0];

        // 复用 WeeklyDataStore.getSchedules 或直接调用 API
        // 这里直接调用 API 以获取今日所有排课（不分老师/学生）
        const schedules = await window.apiUtils.get('/admin/schedules/grid', {
            start_date: dateStr,
            end_date: dateStr
        });

        const normalized = normalizeScheduleRows(Array.isArray(schedules) ? schedules : []);
        renderTodaySchedules(normalized);
    } catch (error) {
        console.error('加载今日排课失败:', error);
        container.innerHTML = '<div class="no-data" style="text-align: center; color: #ef4444; padding: 20px;">加载失败，请重试</div>';
    }
}

// 渲染今日排课列表

function renderTodaySchedules(schedules) {
    const container = document.getElementById('todayScheduleList');
    if (!container) return;

    container.innerHTML = '';
    // Reset container style to block/flex column if needed by CSS, 
    // but the CSS will handle #todayScheduleList styling.

    if (schedules.length === 0) {
        container.innerHTML = `
            <div class="today-empty-state">
                <i class="material-icons-round">event_available</i>
                <p>今日暂无排课安排</p>
                <div style="font-size: 13px; margin-top: 4px; color: #cbd5e1;">您可以安排新的课程</div>
            </div>
        `;
        return;
    }

    // 1. Grouping Logic
    const groups = {};
    schedules.forEach(schedule => {
        const key = `${schedule.start_time}-${schedule.end_time}-${schedule.location || 'site-null'}`;
        if (!groups[key]) {
            groups[key] = {
                base: schedule,
                items: []
            };
        }
        groups[key].items.push(schedule);
    });

    // 2. Sort by Start Time
    const groupedSchedules = Object.values(groups).sort((a, b) => {
        return (a.base.start_time || '').localeCompare(b.base.start_time || '');
    });

    // 3. Render Cards (Teacher Style)
    groupedSchedules.forEach(group => {
        const {
            base,
            items
        } = group;
        const isMerged = items.length > 1;

        // Data Preparation
        const studentNames = [...new Set(items.map(i => i.student_name || '未知学生'))];
        const teacherNames = [...new Set(items.map(i => i.teacher_name || '未分配'))];
        // Truncate logic for display
        let studentDisplay = studentNames.join('、');
        if (studentNames.length > 3) {
            studentDisplay = `${studentNames.slice(0, 3).join('、')} 等${studentNames.length}人`;
        }

        const teacherDisplay = teacherNames.join('、');

        // Type Logic
        const typeName = base.schedule_type_name || base.type_name || '课程';
        let typeClass = 'type-default';
        if (typeName.includes('入户')) typeClass = 'type-visit';
        else if (typeName.includes('试教')) typeClass = 'type-trial';
        else if (typeName.includes('评审')) typeClass = 'type-review';

        // Status Logic
        const allStatuses = [...new Set(items.map(i => (i.status || 'pending').toLowerCase()))];
        const mainStatus = allStatuses.includes('pending') ? 'pending' : allStatuses[0];

        const statusMap = {
            'pending': '待确认',
            'confirmed': '已确认',
            'completed': '已完成',
            'cancelled': '已取消'
        };
        const statusText = statusMap[mainStatus] || mainStatus;

        // Slot Logic (Morning/Afternoon/Evening)
        const h = parseInt((base.start_time || '00:00').substring(0, 2), 10);
        let slotId = 'morning';
        let slotLabel = '上午';
        if (h >= 12) {
            slotId = 'afternoon';
            slotLabel = '下午';
        }
        if (h >= 19) {
            slotId = 'evening';
            slotLabel = '晚上';
        }

        // Create Card Element
        const card = document.createElement('div');
        card.className = `today-card-modern slot-${slotId} sc-status-${mainStatus}`;
        card.setAttribute('role', 'listitem');

        // --- 1. Time Column ---
        const timeCol = document.createElement('div');
        timeCol.className = 'today-card-time';
        timeCol.innerHTML = `
            <div class="time-range">${(base.start_time || '').substring(0, 5)} - ${(base.end_time || '').substring(0, 5)}</div>
            <div class="time-slot-label">${slotLabel}</div>
        `;
        card.appendChild(timeCol);

        // --- 2. Info Column ---
        const infoCol = document.createElement('div');
        infoCol.className = 'today-card-info';

        // Header (Student + Type)
        const header = document.createElement('div');
        header.className = 'today-card-header';

        const typeBadge = `<div class="today-card-type"><span class="sc-type-badge">${typeName}</span></div>`; // matching css structure? teacher uses span directly or wrapped?
        // Teacher code: titleDiv.appendChild(typeBadge span)
        // Let's match CSS expectations: .today-card-title contains .today-card-type?
        // CSS: .today-card-title { ... } .today-card-type { ... }
        // Looking at CSS from dashboard.css:
        // .today-card-type is a class with border-radius, etc.

        const mergedBadgeHTML = isMerged ?
            `<span class="sc-merged-count" style="margin-left:8px; font-size:11px; color:#64748B; background:#F1F5F9; padding:2px 6px; border-radius:4px;">${items.length}人合并</span>`
            : '';

        header.innerHTML = `
            <div class="today-card-title">
                <span class="sc-student-name" title="${studentNames.join(', ')}">${studentDisplay}</span>
                <span class="${typeClass}">
                    <span class="sc-type-badge">${typeName}</span>
                </span>
                ${mergedBadgeHTML}
            </div>
        `;
        infoCol.appendChild(header);

        // Details (Location & Teacher)
        const details = document.createElement('div');
        details.className = 'today-card-details';
        details.innerHTML = `
            <div class="today-card-detail-item">
                <i class="material-icons-round">person</i>
                <span>${teacherDisplay}</span>
            </div>
            <div class="today-card-detail-item location">
                <i class="material-icons-round">place</i>
                <span>${base.location || '未指定地点'}</span>
            </div>
        `;
        infoCol.appendChild(details);
        card.appendChild(infoCol);

        // --- 3. Status Column ---
        const statusCol = document.createElement('div');
        statusCol.className = 'today-card-status';
        statusCol.innerHTML = `
            <span class="status-pill ${mainStatus}">${statusText}</span>
        `;
        card.appendChild(statusCol);

        // Interaction
        card.addEventListener('click', () => {
            if (typeof editSchedule === 'function') {
                editSchedule(base.id);
            }
        });

        container.appendChild(card);
    });
}
