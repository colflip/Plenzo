
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

    // 3. Render Cards
    groupedSchedules.forEach(group => {
        const { base, items } = group;
        const isMerged = items.length > 1;

        // Aggregate Data
        const studentNames = [...new Set(items.map(i => i.student_name || '未知学生'))];
        const teacherNames = [...new Set(items.map(i => i.teacher_name || '未分配'))];
        const studentDisplay = studentNames.join('，');
        const teacherDisplay = teacherNames.join('，');

        // Type Logic
        const typeName = base.schedule_type_name || base.type_name || '课程';
        let typeClass = 'type-default';
        if (typeName.includes('入户')) typeClass = 'type-visit';
        else if (typeName.includes('试教')) typeClass = 'type-trial';
        else if (typeName.includes('评审')) typeClass = 'type-review';

        // Status Logic
        const allStatuses = [...new Set(items.map(i => (i.status || 'pending').toLowerCase()))];
        const mainStatus = allStatuses.includes('pending') ? 'pending' : allStatuses[0];
        const statusClass = `status-${mainStatus}`;

        // Create Card
        const card = document.createElement('div');
        card.className = `schedule-card-modern ${statusClass}`;

        // Format Times (HH:MM)
        const formatTimeSimple = (t) => (t || '').substring(0, 5);
        const startTime = formatTimeSimple(base.start_time);
        const endTime = formatTimeSimple(base.end_time);

        const countBadge = isMerged ? `<span class="sc-merged-count">+${items.length}</span>` : '';

        card.innerHTML = `
            <div class="sc-status-strip"></div>
            
            <div class="sc-content">
                <div class="sc-time-section">
                    <span class="sc-start-time">${startTime}</span>
                    <span class="sc-end-time">${endTime}</span>
                </div>
                
                <div class="sc-details-section">
                    <div class="sc-student-row">
                        <span class="sc-student-name">${studentDisplay}</span>
                        <div class=" ${typeClass}">
                            <span class="sc-type-badge">${typeName}</span>
                        </div>
                        ${countBadge}
                    </div>
                    
                    <div class="sc-meta-row">
                        <div class="sc-meta-item" title="教师">
                            <i class="material-icons-round">person_outline</i>
                            <span>${teacherDisplay}</span>
                        </div>
                        <div class="sc-meta-item" title="地点">
                            <i class="material-icons-round">place</i>
                            <span>${base.location || '未指定地点'}</span>
                        </div>
                    </div>
                </div>

                <div class="sc-action-section">
                    <i class="material-icons-round">chevron_right</i>
                </div>
            </div>
        `;

        // Interaction
        card.addEventListener('click', () => {
            // Assuming editSchedule is available in global scope or imported
            if (typeof editSchedule === 'function') {
                editSchedule(base.id);
            } else {
                console.warn('editSchedule function not found');
            }
        });

        container.appendChild(card);
    });
}
