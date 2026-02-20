
/**
 * Student Availability Management Module
 * Mirrors the functionality of Teacher Availability in legacy-adapter.js
 */

const studentAvailabilityState = {
    currentDate: new Date(),
    initialized: false
};

// Expose init function globally so legacy-adapter.js can call it
window.initStudentAvailability = function () {
    if (studentAvailabilityState.initialized) {
        loadStudentAvailability();
        return;
    }

    // Bind navigation buttons
    const prevBtn = document.getElementById('avStudentPrevWeek');
    const nextBtn = document.getElementById('avStudentNextWeek');

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            studentAvailabilityState.currentDate.setDate(studentAvailabilityState.currentDate.getDate() - 7);
            loadStudentAvailability();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            studentAvailabilityState.currentDate.setDate(studentAvailabilityState.currentDate.getDate() + 7);
            loadStudentAvailability();
        });
    }

    studentAvailabilityState.initialized = true;
    loadStudentAvailability();
    ensureStudentFloatingBar();
};

async function loadStudentAvailability() {
    const tableBody = document.getElementById('studentAvailabilityBody');
    const weekRangeSpan = document.getElementById('avStudentWeekRange');

    if (!tableBody || !weekRangeSpan) return;

    tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px 0;"><div class="loading-spinner" style="margin: 0 auto 12px;"></div><div style="color: #64748b;">加载中...</div></td></tr>';

    const curr = new Date(studentAvailabilityState.currentDate);
    const day = curr.getDay();
    const diff = curr.getDate() - (day === 0 ? 6 : day - 1);

    const monday = new Date(curr.setDate(diff));
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        dates.push(d);
    }

    const formatDateRange = (d) => `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
    weekRangeSpan.textContent = `${formatDateRange(dates[0])} - ${formatDateRange(dates[6])}`;

    renderStudentAvailabilityHeader(dates);

    const toLocalISODate = (d) => {
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    };

    const queryStart = toLocalISODate(dates[0]);
    const queryEnd = toLocalISODate(dates[6]);

    try {
        // Try the dedicated endpoint first
        const data = await window.apiUtils.get('/admin/student-availability', {
            startDate: queryStart,
            endDate: queryEnd
        }, {
            suppressErrorToast: true,
            suppressConsole: true
        });
        renderStudentAvailabilityBody(data, dates);
    } catch (error) {
        // Fallback: Load students from WeeklyDataStore or User Cache

        // Fallback: Load students from WeeklyDataStore or User Cache
        try {
            let students = [];
            if (window.WeeklyDataStore && window.WeeklyDataStore.getStudents) {
                try {
                    students = await window.WeeklyDataStore.getStudents();
                } catch (e) { console.warn('WeeklyDataStore.getStudents failed', e); }
            }

            if ((!students || students.length === 0) && window.apiUtils) {
                // Try fetching students directly if store failed
                const resp = await window.apiUtils.get('/admin/users/student');
                students = Array.isArray(resp) ? resp : (resp.data || []);
            }

            if (students && students.length > 0) {
                // Initialize empty availability for fallback
                const fallbackData = students.map(s => ({
                    id: s.id,
                    name: s.name,
                    availability: {} // Empty availability
                }));

                renderStudentAvailabilityBody(fallbackData, dates);
                // Optionally show a toast that we are in fallback mode
                // if (window.apiUtils) window.apiUtils.showToast('无法获取详细时间安排，仅显示学生列表', 'info');
            } else {
                throw new Error('No students found in fallback');
            }
        } catch (fallbackError) {
            console.error('Fallback loading failed:', fallbackError);
            tableBody.innerHTML = '<tr><td colspan="8" class="error-cell">加载失败，请重试</td></tr>';
        }
    }
}

function renderStudentAvailabilityHeader(dates) {
    const thead = document.getElementById('studentAvailabilityHeader');
    if (!thead) return;

    const days = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    const today = new Date().toDateString();

    let html = '<tr><th style="width: 120px; min-width: 120px;">学生姓名</th>';
    dates.forEach((date, i) => {
        const isToday = date.toDateString() === today;
        let lunarLabel = '';
        try {
            const lunarStr = new Intl.DateTimeFormat('zh-u-ca-chinese', { dateStyle: 'full' }).format(date);
            const match = lunarStr.match(/(正月|腊月)(.*?)(?=星期)/);
            if (match) {
                lunarLabel = `<br><span style="font-size: 11px; color: #64748B;">(${match[0]})</span>`;
            }
        } catch (e) { }

        const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日`;
        html += `<th class="${isToday ? 'today-col' : ''}">
            <div class="th-content">
                <span class="th-date" style="line-height:1.2;">${dateStr}${lunarLabel}</span>
                <span class="th-day">${days[i]}</span>
            </div>
        </th>`;
    });
    html += '</tr>';
    thead.innerHTML = html;
}

function renderStudentAvailabilityBody(students, dates) {
    const tbody = document.getElementById('studentAvailabilityBody');
    if (!tbody) return;

    if (!students || students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="no-data">暂无学生数据</td></tr>';
        return;
    }

    let html = '';
    students.forEach(student => {
        html += `<tr>`;
        html += `<td class="fixed-col font-medium">${student.name}</td>`;

        dates.forEach(date => {
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const da = String(date.getDate()).padStart(2, '0');
            const dateKey = `${year}-${month}-${da}`;

            const availability = (student.availability && student.availability[dateKey]) || {};

            html += `<td class="availability-cell">${renderStudentAvailabilityCell(availability, student.id, dateKey)}</td>`;
        });

        html += `</tr>`;
    });

    tbody.innerHTML = html;
}

function renderStudentAvailabilityCell(data, studentId, dateKey) {
    const effective = StudentPendingChangesManager.getStatus(studentId, dateKey, {
        morning: data.morning,
        afternoon: data.afternoon,
        evening: data.evening
    });

    return `<div id="idx-student-cell-${studentId}-${dateKey}" class="slot-container" 
        data-orig-m="${data.morning === true}" 
        data-orig-a="${data.afternoon === true}" 
        data-orig-e="${data.evening === true}">
        ${renderStudentInnerCell(effective, studentId, dateKey)}
    </div>`;
}

function renderStudentInnerCell(data, studentId, dateKey) {
    const getIconClass = (key, val) => {
        let cls = 'icon-slot interactive material-icons-round';
        if (val === true) cls += ' available';
        else cls += ' busy'; // Or 'unavailable' depending on logic, effectively 'busy' style

        const pKey = `${studentId}|${dateKey}`;
        const pending = StudentPendingChangesManager.changes.get(pKey);
        if (pending && pending[key] !== undefined) {
            cls += ' changed';
        }
        return cls;
    };

    return `
        <span class="${getIconClass('morning', data.morning)}" onclick="toggleStudentAvailability(${studentId}, '${dateKey}', 'morning')" title="上午">wb_sunny</span>
        <span class="${getIconClass('afternoon', data.afternoon)}" onclick="toggleStudentAvailability(${studentId}, '${dateKey}', 'afternoon')" title="下午">brightness_6</span>
        <span class="${getIconClass('evening', data.evening)}" onclick="toggleStudentAvailability(${studentId}, '${dateKey}', 'evening')" title="晚上">nights_stay</span>
    `;
}

const StudentPendingChangesManager = {
    changes: new Map(),

    getStatus(studentId, dateKey, originalData) {
        const key = `${studentId}|${dateKey}`;
        if (this.changes.has(key)) {
            return this.changes.get(key);
        }
        return {
            morning: originalData.morning === true,
            afternoon: originalData.afternoon === true,
            evening: originalData.evening === true
        };
    },

    toggle(studentId, dateKey, period, originalData) {
        const current = this.getStatus(studentId, dateKey, originalData);
        const next = { ...current, [period]: !current[period] };

        const key = `${studentId}|${dateKey}`;
        this.changes.set(key, next);
        this.updateUI();
        return next;
    },

    hasChanges() {
        return this.changes.size > 0;
    },

    clear() {
        this.changes.clear();
        this.updateUI();
    },

    updateUI() {
        const bar = document.getElementById('studentAvailabilitySaveBar');
        if (!bar) return;
        if (this.hasChanges()) {
            bar.style.display = 'flex';
            const count = document.getElementById('studentAvailabilityChangeCount');
            if (count) count.textContent = `${this.changes.size} 处更改`;
        } else {
            bar.style.display = 'none';
        }
    }
};

window.toggleStudentAvailability = function (studentId, dateKey, period) {
    const cellId = `idx-student-cell-${studentId}-${dateKey}`;
    const cellEl = document.getElementById(cellId);
    if (!cellEl) return;

    const origM = cellEl.dataset.origM === 'true';
    const origA = cellEl.dataset.origA === 'true';
    const origE = cellEl.dataset.origE === 'true';
    const original = { morning: origM, afternoon: origA, evening: origE };

    const newState = StudentPendingChangesManager.toggle(studentId, dateKey, period, original);

    cellEl.innerHTML = renderStudentInnerCell(newState, studentId, dateKey);
};

window.saveStudentAvailabilityChanges = async function () {
    if (!StudentPendingChangesManager.hasChanges()) return;

    const changesSnapshot = new Map(StudentPendingChangesManager.changes);
    const affectedKeys = Array.from(StudentPendingChangesManager.changes.keys());

    try {
        const btn = document.getElementById('saveStudentAvailabilityBtn');
        if (btn) btn.textContent = '保存中...';

        const updates = [];
        for (const [key, state] of changesSnapshot.entries()) {
            const [studentId, date] = key.split('|');
            updates.push({
                student_id: studentId,
                date: date,
                morning: state.morning ? 1 : 0,
                afternoon: state.afternoon ? 1 : 0,
                evening: state.evening ? 1 : 0
            });
        }

        await window.apiUtils.post('/admin/student-availability', { updates });

        window.apiUtils.showToast('学生时间安排已保存', 'success');

        for (const [key, state] of changesSnapshot.entries()) {
            const [studentId, dateKey] = key.split('|');
            const cellId = `idx-student-cell-${studentId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                cellEl.dataset.origM = state.morning ? 'true' : 'false';
                cellEl.dataset.origA = state.afternoon ? 'true' : 'false';
                cellEl.dataset.origE = state.evening ? 'true' : 'false';
            }
        }

        StudentPendingChangesManager.clear();

        affectedKeys.forEach(key => {
            const [studentId, dateKey] = key.split('|');
            const cellId = `idx-student-cell-${studentId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                const origM = cellEl.dataset.origM === 'true';
                const origA = cellEl.dataset.origA === 'true';
                const origE = cellEl.dataset.origE === 'true';
                cellEl.innerHTML = renderStudentInnerCell(
                    { morning: origM, afternoon: origA, evening: origE },
                    studentId,
                    dateKey
                );
            }
        });

    } catch (e) {
        console.error(e);
        window.apiUtils.showToast('保存失败: ' + e.message, 'error');
    } finally {
        const btn = document.getElementById('saveStudentAvailabilityBtn');
        if (btn) btn.textContent = '保存更改';
    }
};

window.cancelStudentAvailabilityChanges = function () {
    if (confirm('确定放弃所有未保存的学生时间安排更改吗？')) {
        const affectedKeys = Array.from(StudentPendingChangesManager.changes.keys());
        StudentPendingChangesManager.clear();

        affectedKeys.forEach(key => {
            const [studentId, dateKey] = key.split('|');
            const cellId = `idx-student-cell-${studentId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                const origM = cellEl.dataset.origM === 'true';
                const origA = cellEl.dataset.origA === 'true';
                const origE = cellEl.dataset.origE === 'true';

                cellEl.innerHTML = renderStudentInnerCell(
                    { morning: origM, afternoon: origA, evening: origE },
                    studentId,
                    dateKey
                );
            }
        });
    }
};

function ensureStudentFloatingBar() {
    if (!document.getElementById('studentAvailabilitySaveBar')) {
        const bar = document.createElement('div');
        bar.id = 'studentAvailabilitySaveBar';
        // Reuse style from teacher bar, just ID differs
        // Copying styles or assuming shared class?
        // legacy-adapter creates a specific style block. 
        // We should reuse the styles if possible. 
        // The previous styles for #availabilitySaveBar are ID specific in legacy-adapter.js line 6728.
        // We need to add style for this new ID or modify legacy-adapter to use class.
        // Since I can't easily modify legacy-adapter style injection without replacing big chunk, 
        // I'll inject style here for this specific ID.

        bar.style.cssText = `
            position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
            background: white; padding: 12px 24px; border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.15); display: none; 
            align-items: center; gap: 16px; z-index: 1000;
            min-width: 300px;
        `;

        bar.innerHTML = `
            <span style="font-weight:500; color:#334155" id="studentAvailabilityChangeCount">0 处更改</span>
            <div style="flex:1"></div>
            <button class="btn btn-secondary btn-sm" onclick="cancelStudentAvailabilityChanges()">取消</button>
            <button class="btn btn-primary btn-sm" id="saveStudentAvailabilityBtn" onclick="saveStudentAvailabilityChanges()">保存更改</button>
        `;
        document.body.appendChild(bar);
    }
}
