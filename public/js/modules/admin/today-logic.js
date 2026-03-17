
// 加载今日排课
async function loadTodaySchedules() {
    const container = document.getElementById('todayScheduleList');
    if (!container) return;

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, '<div class="no-data" style="text-align: center; color: #64748b; padding: 20px;">加载中...</div>'); } else { container.innerHTML = '<div class="no-data" style="text-align: center; color: #64748b; padding: 20px;">加载中...</div>'; }

    try {
        // Fix: Use local date instead of server UTC date to avoid 0:00 timezone issues
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        const dateStr = `${year}-${month}-${day}`;

        // 复用 WeeklyDataStore.getSchedules 或直接调用 API
        // 这里直接调用 API 以获取今日所有排课（不分老师/学生）
        const schedules = await window.apiUtils.get('/admin/schedules/grid', {
            start_date: dateStr,
            end_date: dateStr
        });

        const normalized = normalizeScheduleRows(Array.isArray(schedules) ? schedules : []);
        renderTodaySchedules(normalized);
    } catch (error) {

        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, '<div class="no-data" style="text-align: center; color: #ef4444; padding: 20px;">加载失败，请重试</div>'); } else { container.innerHTML = '<div class="no-data" style="text-align: center; color: #ef4444; padding: 20px;">加载失败，请重试</div>'; }
    }
}

// 渲染今日排课列表

function renderTodaySchedules(schedules) {
    const container = document.getElementById('todayScheduleList');
    if (!container) return;

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, ''); } else { container.innerHTML = ''; }

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

    // --- 1. First Group by Students ---
    const studentGroups = {};
    schedules.forEach(s => {
        const sid = s.student_id || 0;
        if (!studentGroups[sid]) {
            studentGroups[sid] = {
                id: sid,
                name: s.student_name || '未知学生',
                schedules: []
            };
        }
        studentGroups[sid].schedules.push(s);
    });

    // Convert to array and sort by student name or ID (optional)
    const sortedStudentGroups = Object.values(studentGroups).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

    sortedStudentGroups.forEach(group => {
        // Create a container for this student
        const groupContainer = document.createElement('div');
        groupContainer.className = 'student-group-container';
        
        // --- 2. Inside Student Group: Apply Time+Location Merging Logic ---
        const subGroups = {};
        group.schedules.forEach(schedule => {
            const key = `${schedule.start_time}-${schedule.end_time}-${schedule.location || 'unknown'}`;
            if (!subGroups[key]) {
                subGroups[key] = {
                    base: schedule,
                    items: []
                };
            }
            subGroups[key].items.push(schedule);
        });

        // Sort by Start Time
        const groupedSchedules = Object.values(subGroups).sort((a, b) => {
            return (a.base.start_time || '').localeCompare(b.base.start_time || '');
        });

        groupedSchedules.forEach(subGroup => {
            // Sort items: Normal first, then Special (matching previous logic)
            subGroup.items.sort((a, b) => {
                const getTypeName = (item) => (item.schedule_type_name || item.type_name || item.schedule_type_cn || item.schedule_types || item.schedule_type || '').toString();
                const isSpecial = (name) => name.includes('评审') || name.includes('咨询');
                const typeA = getTypeName(a);
                const typeB = getTypeName(b);
                const specialA = isSpecial(typeA);
                const specialB = isSpecial(typeB);
                if (specialA && !specialB) return 1;
                if (!specialA && specialB) return -1;
                return (a.teacher_id || 0) - (b.teacher_id || 0);
            });

            groupContainer.appendChild(buildTodayScheduleCard(subGroup.base, subGroup.items));
        });

        container.appendChild(groupContainer);
    });
}

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

    // Time Slot Logic (保留slotId用于CSS样式，不显示标签)
    const h = parseInt((schedule.start_time || '00:00').substring(0, 2), 10);
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

    // 智能选择主要课程类型（出现次数最多的）
    const typeCountMap = new Map();
    items.forEach(item => {
        const type = item.schedule_type_name || item.type_name || item.schedule_types || '未知课程';
        typeCountMap.set(type, (typeCountMap.get(type) || 0) + 1);
    });

    // 找出数量最多的类型
    let typeName = '未知课程';
    let maxCount = 0;
    typeCountMap.forEach((count, type) => {
        if (count > maxCount) {
            maxCount = count;
            typeName = type;
        }
    });

    // 调试日志


    // Determine Course Type Class
    let typeClass = 'type-default';
    if (typeName.includes('入户')) typeClass = 'type-visit';
    else if (typeName.includes('试教')) typeClass = 'type-trial';
    else if (typeName.includes('评审')) typeClass = 'type-review';

    // Create Card Element
    const card = document.createElement('div');
    card.className = `today-card-modern slot-${slotId} sc-status-${status}`;
    card.setAttribute('role', 'listitem');
    card.style.cursor = 'pointer';

    // 1. Time Column
    const timeCol = document.createElement('div');
    timeCol.className = 'today-card-time';
    timeCol.innerHTML = `
        <div class="time-range">${(schedule.start_time || '').substring(0, 5)} - ${(schedule.end_time || '').substring(0, 5)}</div>
        <div class="time-slot-label">${slotLabel}</div>
    `;
    card.appendChild(timeCol);

    // 2. Info Column
    const infoCol = document.createElement('div');
    infoCol.className = 'today-card-info';

    // Header (Student + Type)
    const header = document.createElement('div');
    header.className = 'today-card-header';

    // Prepare Student Name Display
    const studentNames = [...new Set(items.map(i => i.student_name || '未知学生'))];
    let studentDisplay = studentNames.join('、');
    if (studentNames.length > 3) {
        studentDisplay = `${studentNames.slice(0, 3).join('、')} 等${studentNames.length}人`;
    }

    // Inner Title Div
    const titleDiv = document.createElement('div');
    titleDiv.className = 'today-card-title';

    // Type Badge (Unified structure: [Student Name] [Type Badge])
    const nameSpan = document.createElement('span');
    nameSpan.className = 'sc-student-name';
    nameSpan.textContent = studentDisplay;
    nameSpan.title = studentNames.join(', ');
    titleDiv.appendChild(nameSpan);

    const typeBadge = document.createElement('span');
    typeBadge.className = 'today-card-type';
    typeBadge.textContent = typeName;

    // Add type category class to card for border color
    card.classList.add(typeClass);

    titleDiv.appendChild(typeBadge);

    // Merged Badge
    if (isMerged) {
        const mergedBadge = document.createElement('span');
        mergedBadge.className = 'sc-merged-badge'; // Use class from admin-schedule.css or inline style to match teacher
        // Teacher inline style: 'background-color:#E0F2FE; color:#0284C7; border-color:#BAE6FD;'
        // Let's use the class sc-merged-count from previous admin code or adapt. 
        // overview.js uses inline styles for merged badge. Let's replicate or use a clean class.
        // I'll use a class and ensure it is styled or inline if needed.
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(mergedBadge, `<span style="background-color:#E0F2FE; color:#0284C7; padding:2px 6px; border-radius:4px; font-size:11px;">${items.length}个合并</span>`); } else { mergedBadge.innerHTML = `<span style="background-color:#E0F2FE; color:#0284C7; padding:2px 6px; border-radius:4px; font-size:11px;">${items.length}个合并</span>`; }
        titleDiv.appendChild(mergedBadge);
    }

    header.appendChild(titleDiv);
    infoCol.appendChild(header);

    // Details (Teacher & Location)
    const details = document.createElement('div');
    details.className = 'today-card-details';

    // 按教师ID排序，并标注非主要类型
    const teacherMap = new Map();
    items.forEach(item => {
        const tid = item.teacher_id || 0;
        const tname = item.teacher_name || '未分配';
        const ttype = item.schedule_type_name || item.type_name || item.schedule_types || '未知课程';

        if (!teacherMap.has(tid)) {
            teacherMap.set(tid, { id: tid, name: tname, type: ttype });
        }
    });

    // 按ID排序
    const sortedTeachers = Array.from(teacherMap.values()).sort((a, b) => a.id - b.id);

    // 检查是否有多种类型（只在多种类型时才标注）
    const uniqueTypes = new Set(sortedTeachers.map(t => t.type));
    const hasMultipleTypes = uniqueTypes.size > 1;

    // 分组：主要类型和非主要类型
    const mainTypeTeachers = [];
    const otherTypeTeachers = [];

    sortedTeachers.forEach(teacher => {
        if (teacher.type === typeName) {
            mainTypeTeachers.push(teacher.name);
        } else {
            // 只在有多种类型时才标注
            if (hasMultipleTypes) {
                otherTypeTeachers.push(`${teacher.name}(${teacher.type})`);
            } else {
                otherTypeTeachers.push(teacher.name);
            }
        }
    });

    // 合并显示：主要类型在前，非主要类型在后
    const allTeachers = [...mainTypeTeachers, ...otherTypeTeachers];
    const teacherDisplay = allTeachers.join('、');

    const teacherItem = document.createElement('div');
    teacherItem.className = 'today-card-detail-item';
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(teacherItem, `<i class="material-icons-round">person</i> <span>${teacherDisplay}</span>`); } else { teacherItem.innerHTML = `<i class="material-icons-round">person</i> <span>${teacherDisplay}</span>`; }
    details.appendChild(teacherItem);

    // Location Info
    const locationItem = document.createElement('div');
    locationItem.className = 'today-card-detail-item location';

    // Default Location Logic (Task 26)
    const locationHtml = schedule.location ?
        `<span>${schedule.location}</span>` :
        `<span style="font-style: italic; color: #94a3b8;">地点待定</span>`;

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(locationItem, `<i class="material-icons-round">place</i> ${locationHtml}`); } else { locationItem.innerHTML = `<i class="material-icons-round">place</i> ${locationHtml}`; }
    details.appendChild(locationItem);

    infoCol.appendChild(details);
    card.appendChild(infoCol);

    // 3. Status Column
    const statusCol = document.createElement('div');
    statusCol.className = 'today-card-status';
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(statusCol, `<span class="status-pill ${status}">${displayStatus}</span>`); } else { statusCol.innerHTML = `<span class="status-pill ${status}">${displayStatus}</span>`; }
    card.appendChild(statusCol);

    // Interaction
    card.addEventListener('click', () => {
        if (typeof editSchedule === 'function') {
            editSchedule(schedule.id); // Use the base schedule ID for editing
        }
    });

    return card;
}
