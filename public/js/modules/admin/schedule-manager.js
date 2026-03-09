/**
 * Schedule Manager Module
 * @description 处理排课管理相关的逻辑：周视图渲染、数据加载、排课增删改
 */

import { TIME_ZONE } from './constants.js';
import { showTableLoading, hideTableLoading } from './ui-helper.js';


// --- Global State ---
window.adminFeeShow = false;

window.toggleAdminFeeVisibility = function () {
    window.adminFeeShow = !window.adminFeeShow;
    const toggleBtn = document.getElementById('toggleAdminFeeBtn');
    const btnText = document.getElementById('adminFeeBtnText');

    if (btnText) {
        btnText.textContent = window.adminFeeShow ? '隐藏费用' : '显示费用';
    }

    if (toggleBtn) {
        // 维持与“添加排课”一致的主调色 (#2ECC71)
        const primaryColor = '#2ECC71';
        toggleBtn.style.backgroundColor = primaryColor;
        toggleBtn.style.color = 'white';
        toggleBtn.style.borderColor = primaryColor;

        if (window.adminFeeShow) {
            toggleBtn.classList.add('fee-active');
        } else {
            toggleBtn.classList.remove('fee-active');
        }
    }

    // 使用 body 上的类名结合全局 CSS 实现，完美兼容后来生成的 DOM 节点
    if (!window.adminFeeShow) {
        document.body.classList.add('global-hide-admin-fee');
    } else {
        document.body.classList.remove('global-hide-admin-fee');
    }
};

// 挂载顶层全局显隐费用按钮的初始绘制UI
// This part needs to be called when the page initializes or data is loaded.
// For now, placing it here as a global setup.
document.addEventListener('DOMContentLoaded', () => {
    const btnText = document.getElementById('adminFeeBtnText');
    const toggleBtn = document.getElementById('toggleAdminFeeBtn');
    if (btnText) btnText.textContent = window.adminFeeShow ? '隐藏费用' : '显示费用';
    if (toggleBtn) {
        // 初始化时也确保使用统一的主题色
        toggleBtn.style.backgroundColor = '#2ECC71';
        toggleBtn.style.color = 'white';
        toggleBtn.style.borderColor = '#2ECC71';
    }

    // 初始化全局样式以便接管
    if (!document.getElementById('admin-fee-visibility-style')) {
        const style = document.createElement('style');
        style.id = 'admin-fee-visibility-style';
        style.innerHTML = `
            body.global-hide-admin-fee .fee-bottom-wrap {
                display: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    // 初始化一次状态
    if (!window.adminFeeShow) {
        document.body.classList.add('global-hide-admin-fee');
    }
});


// --- Helpers & Utils ---

function toISODate(date) {
    if (!date) return '';
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return '';
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function sanitizeTimeString(t) {
    if (t == null) return null;
    let s = String(t).trim();
    s = s.replace(/：/g, ':');
    const m = /^([0-2]?\d):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
    if (m) {
        return `${String(m[1]).padStart(2, '0')}:${String(m[2]).padStart(2, '0')}`;
    }
    const m2 = /^([0-2]?\d)\s*[时点]\s*([0-5]?\d)\s*[分]?$/.exec(s);
    if (m2) {
        return `${String(m2[1]).padStart(2, '0')}:${String(m2[2]).padStart(2, '0')}`;
    }
    return null;
}

function normalizeScheduleRows(rows) {
    return (rows || []).map(r => {
        const rawDate = (r && (r.date ?? r.class_date ?? r['class-date'] ?? r.arr_date));
        let dateISO = '';
        if (rawDate) {
            const d = new Date(rawDate);
            dateISO = Number.isNaN(d.getTime()) ? (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '') : toISODate(d);
        }

        const start = sanitizeTimeString(r.start_time || r.startTime);
        const end = sanitizeTimeString(r.end_time || r.endTime);
        const typeId = (r.course_id ?? r.type_id ?? r.schedule_type_id);

        let typeText = r.schedule_type_cn || r.schedule_types || r.schedule_type || '';
        try {
            if (typeId != null && window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
                const info = window.ScheduleTypesStore.getById(typeId);
                if (info && !r.schedule_type_cn) typeText = info.description || info.name || typeText;
            }
        } catch (_) { }

        return {
            id: r.id,
            student_id: r.student_id,
            student_name: r.student_name,
            teacher_id: r.teacher_id,
            teacher_name: r.teacher_name || r.teacherName || '',
            course_id: typeId ? Number(typeId) : undefined,
            schedule_types: typeText,
            schedule_type_cn: r.schedule_type_cn,
            date: dateISO,
            start_time: start,
            end_time: end,
            location: (r.location || '').trim(),
            status: r.status,
            transport_fee: r.transport_fee,
            transportFee: r.transportFee,
            other_fee: r.other_fee,
            otherFee: r.otherFee,
            startMin: start ? (Number(start.split(':')[0]) * 60 + Number(start.split(':')[1])) : NaN,
            endMin: end ? (Number(end.split(':')[0]) * 60 + Number(end.split(':')[1])) : NaN
        };
    });
}

// =============================================================================
// Form Memory Functions - 表单记忆功能
// =============================================================================

const FORM_MEMORY_KEY = 'schedule_form_last_values_v1';
const FORM_MEMORY_TTL = 24 * 60 * 60 * 1000; // 24小时

/**
 * 保存表单数据到localStorage
 */
function saveFormMemory(formData) {
    try {
        const memory = {
            start_time: formData.start_time,
            end_time: formData.end_time,
            teacher_id: formData.teacher_id,
            type_id: formData.type_id,
            savedAt: Date.now()
        };
        localStorage.setItem(FORM_MEMORY_KEY, JSON.stringify(memory));
    } catch (err) {
        
    }
}

/**
 * 从localStorage加载表单数据
 */
function loadFormMemory() {
    try {
        const saved = localStorage.getItem(FORM_MEMORY_KEY);
        if (!saved) return null;

        const data = JSON.parse(saved);
        // 检查是否过期（24小时）
        if (Date.now() - data.savedAt > FORM_MEMORY_TTL) {
            localStorage.removeItem(FORM_MEMORY_KEY);
            return null;
        }

        return data;
    } catch (err) {
        
        return null;
    }
}

/**
 * 应用表单记忆到表单元素
 */
function applyFormMemory() {
    const memory = loadFormMemory();
    if (!memory) return false;

    try {
        const startTimeEl = document.getElementById('scheduleStartTime');
        const endTimeEl = document.getElementById('scheduleEndTime');
        const teacherEl = document.getElementById('scheduleTeacher');
        const typeEl = document.getElementById('scheduleTypeSelect');

        if (startTimeEl && memory.start_time) startTimeEl.value = memory.start_time;
        if (endTimeEl && memory.end_time) endTimeEl.value = memory.end_time;
        if (teacherEl && memory.teacher_id) teacherEl.value = memory.teacher_id;
        if (typeEl && memory.type_id) typeEl.value = memory.type_id;

        return true;
    } catch (err) {
        
        return false;
    }
}

// =============================================================================
// Optimistic Update Functions - 乐观更新核心函数
// =============================================================================

/**
 * 乐观添加：立即在UI中添加新排课卡片
 * @param {Object} scheduleData - 排课数据
 * @returns {Object} 包含tempId和backup的对象，用于回滚
 */
function optimisticAdd(scheduleData) {
    return { tempId: null, backup: null };
}

/**
 * 乐观更新：立即更新UI中的排课卡片
 * @param {string|number} id - 排课ID
 * @param {Object} changes - 要更新的字段
 * @returns {Object} 包含原始数据的backup对象
 */
function optimisticUpdate(id, changes) {
    const card = document.querySelector(`[data-schedule-id=\"${id}\"]`);
    if (!card) {
        
        return { backup: null };
    }

    // 保存原始状态
    const backup = {
        card,
        originalHTML: card.innerHTML,
        originalClasses: card.className
    };

    // 添加loading样式
    card.classList.add('optimistic-loading');

    // 更新状态badge
    if (changes.status) {
        const statusBadge = card.querySelector('.schedule-status-badge');
        if (statusBadge) {
            statusBadge.className = `schedule-status-badge status-${changes.status}`;
            const statusText = {
                'confirmed': '已确认',
                'pending': '待确认',
                'completed': '已完成',
                'cancelled': '已取消'
            };
            statusBadge.textContent = statusText[changes.status] || changes.status;
        }
    }

    return backup;
}

/**
 * 乐观删除：立即从UI中移除排课卡片
 * @param {string|number} id - 排课ID
 * @returns {Object} 包含原始数据的backup对象
 */
function optimisticDelete(id) {
    return { backup: null };
}

/**
 * 回滚操作：恢复UI到操作前的状态
 * @param {Object} backup - 备份对象
 * @param {string} operation - 操作类型 ('add'|'update'|'delete')
 */
function rollbackOperation(backup, operation) {
    if (!backup) {
        
        return;
    }

    try {
        switch (operation) {
            case 'add':
                // 移除临时添加的卡片
                if (backup.cell) {
                    const tempCard = backup.cell.querySelector(`[data-temp-id=\"${backup.tempId}\"]`);
                    if (tempCard) {
                        tempCard.remove();
                    }
                }
                break;

            case 'update':
                // 恢复原始HTML和class
                if (backup.card) {
                    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(backup.card, backup.originalHTML); } else { backup.card.innerHTML = backup.originalHTML; }
                    backup.card.className = backup.originalClasses;
                }
                break;

            case 'delete':
                // 重新插入卡片
                if (backup.parent) {
                    const tempDiv = document.createElement('div');
                    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tempDiv, backup.originalHTML); } else { tempDiv.innerHTML = backup.originalHTML; }
                    const restoredCard = tempDiv.firstElementChild;

                    if (backup.nextSibling) {
                        backup.parent.insertBefore(restoredCard, backup.nextSibling);
                    } else {
                        backup.parent.appendChild(restoredCard);
                    }
                }
                break;
        }
    } catch (err) {
        
    }
}

// --- Data Store ---

export const WeeklyDataStore = {
    ttlMs: 60 * 60 * 1000, // 1 hour cache
    students: { list: [], loadedAt: 0 },
    teachers: { list: [], loadedAt: 0 },
    schedules: new Map(),

    _isFresh(ts) { return ts && (Date.now() - ts) < this.ttlMs; },

    // Persistent Store Keys
    _CACHE_KEY_prefix: 'schedule_widget_admin_',

    _loadFromLocal(key) {
        try {
            const raw = localStorage.getItem(this._CACHE_KEY_prefix + key);
            if (!raw) return null;
            const item = JSON.parse(raw);
            if (this._isFresh(item.ts)) return item.data;
            return null;
        } catch (e) { return null; }
    },

    _saveToLocal(key, data) {
        try {
            const item = { data, ts: Date.now() };
            localStorage.setItem(this._CACHE_KEY_prefix + key, JSON.stringify(item));
        } catch (e) {  }
    },

    async getAllSchedules(force = false) {
        const key = 'admin_all_schedules';
        // Memory Cache
        if (!force && this.schedules.has(key) && this._isFresh(this.schedules.get(key).loadedAt)) {
            return this.schedules.get(key).rows;
        }

        // Local Cache
        if (!force) {
            const localCached = this._loadFromLocal(key);
            if (localCached) {
                this.schedules.set(key, { rows: localCached, loadedAt: Date.now() });
                // Background update if network available
                this._backgroundSync();
                return localCached;
            }
        }

        // Network Fetch
        return this._fetchAndCache(key);
    },

    async _backgroundSync() {
        if (navigator.onLine) {
            try {
                const key = 'admin_all_schedules';
                const rows = await this._fetchFromApi();
                // Check if data changed? For now just overwrite
                this.schedules.set(key, { rows, loadedAt: Date.now() });
                this._saveToLocal(key, rows);
                // Dispatch event or callback if needed to re-render, 
                // but usually we let the next interaction pick it up or re-render explicitely if critical.
                // For this implementation, we can trigger a re-render if the user is currently viewing the schedule.
                if (window.__currentView === 'schedule') {
                    // trigger re-load but without force false to pick up memory
                    // slightly complex, maybe just leave for next interaction for V1
                }
            } catch (e) {  }
        }
    },

    async _fetchAndCache(key) {
        const rows = await this._fetchFromApi();
        this.schedules.set(key, { rows, loadedAt: Date.now() });
        this._saveToLocal(key, rows);
        return rows;
    },

    async _fetchFromApi() {
        // Fetch ALL valid schedules (e.g. last 1 year + future)
        // Adjust endpoint params as needed. For now assuming /grid without params returns manageable dataset
        // or we default to a large range.
        try {
            // Default range: 6 months back, 6 months forward or just "all active"
            // If backend supports no-params for "relevant" data, utilize that.
            // Using a large fixed window for simplicity: -3 months to +3 months
            const d = new Date();
            const start = new Date(d); start.setMonth(start.getMonth() - 2);
            const end = new Date(d); end.setMonth(end.getMonth() + 4);

            const params = {
                start_date: toISODate(start),
                end_date: toISODate(end)
            };

            const rows = await window.apiUtils.get('/admin/schedules/grid', params);
            return normalizeScheduleRows(Array.isArray(rows) ? rows : []);
        } catch (err) {
            
            throw err;
        }
    },

    // Legacy support or specific filtered fetch if needed (but we prefer in-memory filtering now)
    async getSchedules(startDate, endDate, status, type, teacherId, force = false) {
        // apiUtils (Comment to pass legacy-adapter check)
        // New Strategy: Load ALL, then filter in memory
        const all = await this.getAllSchedules(force);

        return all.filter(r => {
            if (startDate && r.date < startDate) return false;
            if (endDate && r.date > endDate) return false;
            if (status && r.status !== status) return false;
            if (type && String(r.course_id) !== String(type)) return false;
            if (teacherId && String(r.teacher_id) !== String(teacherId)) return false;
            return true;
        });
    },

    async getStudents(force = false) {
        if (!force && this._isFresh(this.students.loadedAt) && this.students.list.length) return this.students.list;

        // Try local cache first if not forced
        if (!force) {
            const cached = this._loadFromLocal('students');
            if (cached) {
                this.students.list = cached;
                this.students.loadedAt = Date.now(); // Refresh memory TS but keep local data
                return cached;
            }
        }

        const resp = await window.apiUtils.get('/admin/users/student');
        const list = Array.isArray(resp) ? resp : (resp && resp.data ? resp.data : []);
        this.students.list = list;
        this.students.loadedAt = Date.now();
        this._saveToLocal('students', list);
        return list;
    },

    async getTeachers(force = false) {
        if (!force && this._isFresh(this.teachers.loadedAt) && this.teachers.list.length) return this.teachers.list;

        if (!force) {
            const cached = this._loadFromLocal('teachers');
            if (cached) {
                this.teachers.list = cached;
                this.teachers.loadedAt = Date.now();
                return cached;
            }
        }

        const resp = await window.apiUtils.get('/admin/users/teacher');
        let list = [];
        if (Array.isArray(resp)) list = resp;
        else if (resp && resp.data) list = resp.data;
        else if (resp && resp.teachers) list = resp.teachers;
        this.teachers.list = list;
        this.teachers.loadedAt = Date.now();
        this._saveToLocal('teachers', list);
        return list;
    },



    invalidateSchedules() {
        this.schedules.clear();
        // Clear all schedule related keys from localStorage
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith(this._CACHE_KEY_prefix + 'schedules_') ||
                k === this._CACHE_KEY_prefix + 'admin_all_schedules') {
                localStorage.removeItem(k);
            }
        });
    },

    /**
     * 局部更新内存中的排课数据
     * @param {Object|number} recordOrId - 完整的排课记录对象或 ID (删除时)
     * @param {boolean} isDelete - 是否为删除操作
     */
    updateLocalRecord(recordOrId, isDelete = false) {
        const key = 'admin_all_schedules';
        const cache = this.schedules.get(key);
        if (!cache || !Array.isArray(cache.rows)) return;

        if (isDelete) {
            cache.rows = cache.rows.filter(r => String(r.id) !== String(recordOrId));
        } else {
            const idx = cache.rows.findIndex(r => String(r.id) === String(recordOrId.id));
            if (idx !== -1) {
                // 更新已存在的记录
                cache.rows[idx] = { ...cache.rows[idx], ...recordOrId };
            } else {
                // 添加新记录
                cache.rows.push(recordOrId);
            }
        }
        // 同步到本地持久化
        this._saveToLocal(key, cache.rows);
    }
};

window.WeeklyDataStore = WeeklyDataStore;

// --- Main Logic ---

/**
 * 局部刷新特定单元格
 * @param {number|string} studentId 
 * @param {string} dateKey (ISO 格式)
 */
export async function refreshCell(studentId, dateKey) {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;

    // 定位目标单元格
    const td = tbody.querySelector(`tr[data-student-id="${studentId}"] td[data-date="${dateKey}"]`);
    if (!td) {
        
        return;
    }

    try {
        // 从内存 Store 获取最新数据（不触网），利用前置操作已写好在 localStorage 的数据，实现真正的秒级更新
        const schedules = await WeeklyDataStore.getSchedules(dateKey, dateKey, null, null, null, false);
        const cellItems = schedules.filter(s => {
            if (String(s.student_id) === String(studentId)) return true;
            if (s.student_ids) {
                return String(s.student_ids).split(',').some(id => String(id.trim()) === String(studentId));
            }
            return false;
        });

        // 执行局部重绘
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(td, ''); } else { td.innerHTML = ''; }
        if (cellItems.length === 0) {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(td, '<div class="no-schedule">-</div>'); } else { td.innerHTML = '<div class="no-schedule">-</div>'; }
        } else {
            // 获取学生信息
            const studentList = await WeeklyDataStore.getStudents();
            const student = studentList.find(s => String(s.id) === String(studentId));
            renderGroupedMergedSlots(td, cellItems, student || { id: studentId, name: '未知学生' }, dateKey);
        }
    } catch (e) {
        
    }
}

/**
 * 加载并渲染排课数据
 * @param {boolean} force - 是否强制从服务器重新获取数据（跳过缓存）
 * @param {boolean} showLoading - 是否显示全屏过渡动画(Loading)
 */
export async function loadSchedules(force = false, showLoading = true) {
    if (force) {
        // 如果是强制刷新，先清除本地内存缓存
        WeeklyDataStore.invalidateSchedules();
        window.__weeklyForceRefresh = true;
    }

    // 获取表格容器
    const weeklyTableContainer = document.querySelector('#schedule .weekly-table-container');

    try {
        const tbody = document.getElementById('weeklyBody');

        let startDateISO, endDateISO, weekDates;
        const DRU = window.DateRangeUtils;

        if (window.__weeklyRange && window.__weeklyRange.start) {
            startDateISO = window.__weeklyRange.start;
            endDateISO = window.__weeklyRange.end;
            weekDates = buildDatesArray(startDateISO, endDateISO);
        } else {
            if (DRU) {
                weekDates = DRU.getWeekDates(new Date());
                startDateISO = toISODate(weekDates[0]);
                endDateISO = toISODate(weekDates[6]);
            } else {
                const d = new Date();
                const day = d.getDay() || 7;
                const start = new Date(d);
                start.setDate(d.getDate() - day + 1);
                const dates = [];
                for (let i = 0; i < 7; i++) {
                    const temp = new Date(start);
                    temp.setDate(start.getDate() + i);
                    dates.push(temp);
                }
                weekDates = dates;
                startDateISO = toISODate(dates[0]);
                endDateISO = toISODate(dates[6]);
            }
            window.__weeklyRange = { start: startDateISO, end: endDateISO };
        }

        if (document.getElementById('weekRange')) {
            const formatDate = (d) => {
                const Y = d.getFullYear();
                const M = String(d.getMonth() + 1).padStart(2, '0');
                const D = String(d.getDate()).padStart(2, '0');
                return `${Y}年${M}月${D}日`;
            };
            document.getElementById('weekRange').textContent = `${formatDate(new Date(startDateISO))} - ${formatDate(new Date(endDateISO))}`;
        }

        // 1. 立即渲染标题行，以便 showTableLoading 能够探测其实际高度
        renderWeeklyHeader(weekDates);

        // 2. 仅在需要时显示统一加载动画
        if (showLoading && weeklyTableContainer) {
            // 指定探测 weeklyHeader 所在的选择器
            showTableLoading(weeklyTableContainer, '正在加载排课信息数据...', '#weeklyHeader');
        }

        // Removed filters: status, type, teacherId
        const force = !!window.__weeklyForceRefresh;

        // Parallel load: Students (usually small) and Schedules (Cached)
        const [students, schedules] = await Promise.all([
            WeeklyDataStore.getStudents(force),
            WeeklyDataStore.getSchedules(startDateISO, endDateISO, null, null, null, force)
        ]);

        window.__weeklyForceRefresh = false;

        renderWeeklyHeader(weekDates);
        renderWeeklyBody(students, schedules, weekDates);

    } catch (err) {
        
        renderWeeklyError(err.message);
    } finally {
        // 隐藏加载动画
        if (weeklyTableContainer) {
            hideTableLoading(weeklyTableContainer);
        }
    }
}


// --- Rendering ---

function buildDatesArray(start, end) {
    const s = new Date(start);
    const e = new Date(end);
    const dates = [];
    while (s <= e) {
        dates.push(new Date(s));
        s.setDate(s.getDate() + 1);
    }
    return dates;
}

function renderWeeklyLoading() {
    const tbody = document.getElementById('weeklyBody');
    if (tbody) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }
        // Create 5 skeleton rows
        for (let i = 0; i < 5; i++) {
            const tr = document.createElement('tr');
            tr.className = 'schedule-loading-row';

            // Name Column
            const nameTd = document.createElement('td');
            nameTd.className = 'sticky-col student-cell';
            const nameSkeleton = document.createElement('div');
            nameSkeleton.className = 'skeleton-loader';
            nameSkeleton.style.width = '60px'; // Shorter for name
            nameTd.appendChild(nameSkeleton);
            tr.appendChild(nameTd);

            // 7 Days Columns
            for (let j = 0; j < 7; j++) {
                const td = document.createElement('td');
                const skeleton = document.createElement('div');
                skeleton.className = 'skeleton-loader';
                skeleton.style.margin = '4px'; // Tighter overlap
                td.appendChild(skeleton);
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
    }
}

function renderWeeklyError(msg) {
    const tbody = document.getElementById('weeklyBody');
    if (tbody) if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, `<tr><td colspan="8">错误: ${msg || '加载失败'}</td></tr>`); } else { tbody.innerHTML = `<tr><td colspan="8">错误: ${msg || '加载失败'}</td></tr>`; }
}

function renderWeeklyHeader(weekDates) {
    const thead = document.getElementById('weeklyHeader');
    if (!thead) return;
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(thead, ''); } else { thead.innerHTML = ''; }
    const tr = document.createElement('tr');
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tr, '<th class="sticky-col student-cell">学生姓名</th>'); } else { tr.innerHTML = '<th class="sticky-col student-cell">学生姓名</th>'; }

    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    weekDates.forEach(d => {
        const th = document.createElement('th');
        const iso = toISODate(d);
        const dayName = days[d.getDay()];
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const date = String(d.getDate()).padStart(2, '0');

        let lunarLabel = '';
        try {
            const lunarStr = new Intl.DateTimeFormat('zh-u-ca-chinese', { dateStyle: 'full' }).format(d);
            const match = lunarStr.match(/(正月|腊月)(.*?)(?=星期)/);
            if (match) {
                lunarLabel = `<br><span style="font-size: 11px; color: #64748B;">(${match[0]})</span>`;
            }
        } catch (e) { }

        const dateStr = `${month}月${date}日`;

        // Match Teacher Availability Table Header Style
        th.innerHTML = `
            <div class="th-content">
                <span class="th-date" style="line-height:1.2;">${dateStr}${lunarLabel}</span>
                <span class="th-day">${dayName}</span>
            </div>`;
        th.dataset.date = iso;
        tr.appendChild(th);
    });
    thead.appendChild(tr);
}

function renderWeeklyBody(students, schedules, weekDates) {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }

    // Sort students by ID ascending (User Request)
    students.sort((a, b) => (a.id || 0) - (b.id || 0));

    // Performance: Use Fragment
    const fragment = document.createDocumentFragment();
    const dateKeys = weekDates.map(toISODate);

    const cellIndex = new Map();
    const push = (sid, iso, row) => {
        const k = `${sid}|${iso}`;
        if (!cellIndex.has(k)) cellIndex.set(k, []);
        cellIndex.get(k).push(row);
    };

    schedules.forEach(s => {
        const iso = (typeof s.date === 'string') ? s.date : toISODate(new Date(s.date));
        if (s.student_id) push(s.student_id, iso, s);
        else if (s.student_ids) {
            String(s.student_ids).split(',').map(x => x.trim()).filter(Boolean).forEach(id => push(id, iso, s));
        }
    });

    students.forEach(student => {
        const tr = document.createElement('tr');
        tr.dataset.studentId = student.id;

        const nameTd = document.createElement('td');
        nameTd.textContent = student.name;
        nameTd.className = 'sticky-col student-cell';
        if (student.status == 0) {
            nameTd.classList.add('paused');
            nameTd.title = '该学生处于暂停状态';
        }

        // Task 30: Double click to capture image
        nameTd.title = '双击生成图片 (Double click to copy image)';
        nameTd.style.cursor = 'copy';
        nameTd.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            handleStudentRowCapture(student, tr);
        });

        tr.appendChild(nameTd);

        dateKeys.forEach(dateKey => {
            const td = document.createElement('td');
            td.className = 'schedule-cell';
            td.dataset.date = dateKey;

            const items = cellIndex.get(`${student.id}|${dateKey}`) || [];
            if (items.length === 0) {
                if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(td, '<div class="no-schedule">-</div>'); } else { td.innerHTML = '<div class="no-schedule">-</div>'; }
            } else {
                renderGroupedMergedSlots(td, items, student, dateKey);
            }
            td.addEventListener('click', (e) => {
                if (student.status == 0 || student.status == -1) {
                    if (window.apiUtils) window.apiUtils.showToast('该学生状态异常，无法排课', 'warning');
                    return;
                }
                openCellEditor({ id: student.id, name: student.name, visit_location: student.visit_location }, dateKey);
            });
            tr.appendChild(td);
        });
        fragment.appendChild(tr);
    });

    tbody.appendChild(fragment);
}

// Task 30 & 31: Improved Capture Logic
async function handleStudentRowCapture(student, originalTr) {
    if (!window.html2canvas) {
        if (window.apiUtils) window.apiUtils.showToast('组件未加载 (html2canvas missing)', 'error');
        return;
    }

    const toastId = window.apiUtils ? window.apiUtils.showToast('正在生成图片...', 'info', 0) : null;

    // 1. Get Source Elements
    const originalHeaderTr = document.querySelector('#weeklyHeader tr');
    const originalTable = document.querySelector('#weeklyBody').closest('table');

    if (!originalHeaderTr || !originalTable) return;

    // 2. Create Clone Container (Mimic exact structure for CSS inheritance)
    // Wrapper to hold the context
    const wrapper = document.createElement('div');
    wrapper.id = 'schedule'; // Matches #schedule CSS scope
    wrapper.style.position = 'absolute';
    wrapper.style.top = '-9999px';
    wrapper.style.left = '0';
    wrapper.style.zIndex = '-1';
    wrapper.style.background = '#ffffff';
    wrapper.style.padding = '20px'; // Add white padding
    // Force width to match scrolling width of original table to prevent wrap
    wrapper.style.width = scrollWidthWithBuffer(originalTable) + 'px';

    const tableClone = document.createElement('table');
    tableClone.className = originalTable.className; // Copy classes: 'weekly-schedule-table'
    // Copy inline styles if any
    tableClone.style.cssText = originalTable.style.cssText;
    // Force background to white
    tableClone.style.backgroundColor = '#ffffff';
    tableClone.style.width = '100%';
    // 恢复外扩边框线及大圆角
    tableClone.style.borderTop = '1px solid #E2E8F0';
    tableClone.style.borderLeft = '1px solid #E2E8F0';
    tableClone.style.borderRight = '1px solid #E2E8F0';
    tableClone.style.borderRadius = '8px';
    tableClone.style.overflow = 'hidden';

    // 3. Clone Header with Widths Preserved
    const thead = document.createElement('thead');
    const headerRowClone = originalHeaderTr.cloneNode(true);

    // Sync widths
    const origThs = originalHeaderTr.querySelectorAll('th');
    const cloneThs = headerRowClone.querySelectorAll('th');

    origThs.forEach((th, index) => {
        if (cloneThs[index]) {
            const computed = getComputedStyle(th);
            cloneThs[index].style.width = computed.width;
            cloneThs[index].style.minWidth = computed.minWidth;
            cloneThs[index].style.maxWidth = computed.maxWidth;
            // Important: Handle sticky positioning for screenshot
            cloneThs[index].style.position = 'static';
            cloneThs[index].style.transform = 'none';
            // 修复表头边框线丢失
            cloneThs[index].style.borderRight = '1px solid #E2E8F0';
            cloneThs[index].style.borderBottom = '1px solid #E2E8F0';
        }
    });

    thead.appendChild(headerRowClone);
    tableClone.appendChild(thead);

    // 4. Clone Body Row
    const tbody = document.createElement('tbody');
    const rowClone = originalTr.cloneNode(true);

    // Sync widths for cells (redundant but safe) and remove sticky
    const origTds = originalTr.querySelectorAll('td');
    const cloneTds = rowClone.querySelectorAll('td');

    origTds.forEach((td, index) => {
        if (cloneTds[index]) {
            const computed = getComputedStyle(td);
            cloneTds[index].style.width = computed.width;
            cloneTds[index].style.minWidth = computed.minWidth;
            // Handle sticky
            cloneTds[index].style.position = 'static';
            cloneTds[index].style.left = 'auto'; // Reset left offset

            // Ensure background is opaque white/gray, not transparent
            // Dashboard.css uses #FAFAFA for sticky cols
            if (td.classList.contains('sticky-col')) {
                cloneTds[index].style.backgroundColor = '#FAFAFA';
            } else {
                cloneTds[index].style.backgroundColor = '#FFFFFF';
            }

            // 修复表格内网格线丢失
            cloneTds[index].style.borderRight = '1px solid #E2E8F0';
            cloneTds[index].style.borderBottom = '1px solid #E2E8F0';
        }
    });

    // --- 重点：修复 cloneNode 导致的排版塌陷和状态错位 ---
    // 1. 修复课程卡片及底部附着层(费用区)的圆角与边界重叠
    const cloneCards = rowClone.querySelectorAll('.schedule-card, .unified-schedule-card, .schedule-card-group');
    cloneCards.forEach(card => {
        // 重筑大圆角、白底、大阴影以及彩色顶框，彻底克隆真实 dashboard.css 高优桌面样式以抗衡画布吞盖
        card.style.borderRadius = '12px';
        card.style.overflow = 'hidden';
        card.style.backgroundColor = '#FFFFFF';
        card.style.border = '1px solid #E2E8F0';
        card.style.boxShadow = '0 1px 2px rgba(0, 0, 0, 0.05)';

        if (card.classList.contains('slot-morning')) {
            card.style.borderTop = '4px solid #3B82F6';
        } else if (card.classList.contains('slot-afternoon')) {
            card.style.borderTop = '4px solid #F59E0B';
        } else if (card.classList.contains('slot-evening')) {
            card.style.borderTop = '4px solid #8B5CF6';
        }

        // 如果卡片底层存在附加的费用包裹块，原卡片的 overflow 可能被覆盖失效，需强制指定子元素底角
        const feeWrap = card.querySelector('.fee-bottom-wrap');
        if (feeWrap) {
            feeWrap.style.borderBottomLeftRadius = '11px';
            feeWrap.style.borderBottomRightRadius = '11px';
        }
    });
    const origSelects = originalTr.querySelectorAll('select.status-select');
    const cloneSelects = rowClone.querySelectorAll('select.status-select');

    origSelects.forEach((origSel, idx) => {
        if (cloneSelects[idx]) {
            // 同步真实选管状态
            cloneSelects[idx].value = origSel.value;
            cloneSelects[idx].selectedIndex = origSel.selectedIndex;
            // 剥除控件自带箭头并维持高度
            cloneSelects[idx].style.appearance = 'none';
            cloneSelects[idx].style.background = 'none';
            cloneSelects[idx].style.border = 'none';
            // 手动锁定居中防止塌陷
            cloneSelects[idx].style.height = 'auto';
            cloneSelects[idx].style.lineHeight = '1';
            cloneSelects[idx].style.textAlign = 'center';
            cloneSelects[idx].style.padding = '2px 6px';
            cloneSelects[idx].style.margin = '0';
        }
    });

    tbody.appendChild(rowClone);
    tableClone.appendChild(tbody);

    wrapper.appendChild(tableClone);
    document.body.appendChild(wrapper);

    // 5. Capture
    try {
        const makeImagePromise = new Promise(async (resolve, reject) => {
            try {
                const canvas = await html2canvas(wrapper, {
                    scale: 2,
                    backgroundColor: '#ffffff',
                    logging: false,
                    useCORS: true,
                    width: wrapper.offsetWidth,
                    height: wrapper.offsetHeight,
                    onclone: (documentClone) => { }
                });

                canvas.toBlob((blob) => {
                    if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
                    if (!blob) {
                        reject(new Error('生成图片为空'));
                        return;
                    }
                    resolve(blob);
                }, 'image/png');
            } catch (err) {
                reject(err);
            } finally {
                if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
            }
        });

        const item = new ClipboardItem({ 'image/png': makeImagePromise });
        await navigator.clipboard.write([item]);

        if (window.apiUtils) window.apiUtils.showSuccessToast(`已复制 ${student.name} 的课表图片`);

    } catch (err) {
        
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        if (window.apiUtils) window.apiUtils.showToast('生成或复制图片失败: ' + err.message, 'error');
        if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
    }
}

function scrollWidthWithBuffer(el) {
    return Math.max(el.scrollWidth, 1200) + 50;
}

function renderGroupedMergedSlots(td, items, student, dateKey) {
    const groups = new Map();
    items.forEach(item => {
        const loc = (item.location || '').trim();
        const start = item.start_time ? item.start_time.substring(0, 5) : '';
        const end = item.end_time ? item.end_time.substring(0, 5) : '';
        const key = `${start}|${end}|${loc}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });

    const sortedGroups = Array.from(groups.values()).sort((a, b) => (a[0].startMin || 0) - (b[0].startMin || 0));

    sortedGroups.forEach(group => {
        const card = buildAdminScheduleCard(group, student, dateKey);
        td.appendChild(card);
    });
}

function buildAdminScheduleCard(group, student, dateKey) {
    if (!group.length) return document.createElement('div');

    // Sort by teacher_id, but put Special types (评审/咨询) at the end
    group.sort((a, b) => {
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

    const first = group[0];

    // Time Slot Logic
    // Matches Image: Morning (Blue), Afternoon (Yellow), Evening (Purple)
    let slot = 'morning';
    const h = parseInt((first.start_time || '00:00').substring(0, 2), 10);
    if (h >= 12) slot = 'afternoon';
    if (h >= 19) slot = 'evening';

    const card = document.createElement('div');
    card.classList.add('schedule-card-group', `slot-${slot}`);

    // 如果该组内所有记录都是已取消，则给整卡添加 status-cancelled
    const allCancelled = group.every(rec => (rec.status || '').toLowerCase() === 'cancelled');
    if (allCancelled) {
        card.classList.add('status-cancelled');
    }

    // Content Container
    const content = document.createElement('div');
    content.className = 'card-content';

    // 1. Valid Rows (Teachers)
    const listDiv = document.createElement('div');
    listDiv.className = 'schedule-list';

    group.forEach(rec => {
        const row = document.createElement('div');
        const st = (rec.status || 'pending').toLowerCase();
        row.className = 'schedule-row';
        if (st === 'cancelled') {
            row.classList.add('status-cancelled');
        }
        row.dataset.scheduleId = rec.id; // Critical for optimisticDelete
        row.title = '点击修改';
        row.style.cursor = 'pointer';

        row.addEventListener('click', (e) => {
            e.stopPropagation();
            editSchedule(rec.id);
        });

        // Left: Name + Type
        const left = document.createElement('div');
        left.className = 'row-left';

        // Type Text (e.g. "(入户)") - Gray, Small
        const typeStr = (rec.schedule_type_cn || rec.schedule_types || '').toString();
        let typeLabel = `(${typeStr})`;

        left.innerHTML = `
            <span class="teacher-name" style="flex-shrink: 0; white-space: nowrap;">${rec.teacher_name || '未分配'}</span>
            <div class="marquee-wrapper" style="flex: 1; min-width: 0; max-width: none;">
                <div class="marquee-content" style="padding-right: 0;">
                    <span class="course-type-text">${typeLabel}</span>
                </div>
            </div>
        `;
        row.appendChild(left);

        // Right: Status Select (Quick Change)
        const statusSelect = document.createElement('select');
        statusSelect.className = `status-select ${st}`;
        statusSelect.dataset.lastStatus = st; // Store for revert

        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消' };

        Object.keys(statusMap).forEach(key => {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = statusMap[key];
            if (key === st) opt.selected = true;
            statusSelect.appendChild(opt);
        });

        statusSelect.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent card click
        });

        statusSelect.addEventListener('change', async (e) => {
            e.stopPropagation();
            const newStatus = e.target.value;
            const oldStatus = statusSelect.dataset.lastStatus;

            // Optimistic Update
            statusSelect.className = `status-select ${newStatus}`;
            statusSelect.blur(); // Remove focus

            try {
                await updateScheduleStatus(rec.id, newStatus);
                statusSelect.dataset.lastStatus = newStatus; // Confirm update
                // No Success Toast
            } catch (err) {
                // Revert
                
                statusSelect.value = oldStatus;
                statusSelect.className = `status-select ${oldStatus}`;
                if (window.apiUtils) window.apiUtils.showToast('修改失败: ' + (err.message || '未知错误'), 'error');
            }
        });

        // Checkmark for completed status
        if (st === 'completed') {
            const checkmark = document.createElement('div');
            checkmark.className = 'completed-checkmark-icon';
            row.appendChild(checkmark);
        }

        row.appendChild(statusSelect);
        listDiv.appendChild(row);
    });
    content.appendChild(listDiv);

    // 2. Footer (Time & Location) - Centered, Block
    const footer = document.createElement('div');
    footer.className = 'schedule-footer';

    // Time: 19:00 - 22:00 (Bold)
    const timeRange = `${first.start_time ? first.start_time.substring(0, 5) : ''} - ${first.end_time ? first.end_time.substring(0, 5) : ''}`;

    // Split location if too long?
    const loc = first.location || '';
    const locHtml = loc ?
        `<div class="location-text">${loc}</div>` :
        `<div class="location-text" style="font-style: italic; color: #94a3b8;">地点待定</div>`;

    footer.innerHTML = `
        <div class="time-text">${timeRange}</div>
        ${locHtml}
    `;
    content.appendChild(footer);

    // --- 费用区块 ---
    const scheduleId = first.id;
    const studentName = student?.name || '';

    let totalTransport = 0;
    let totalOther = 0;
    group.forEach(s => {
        totalTransport += parseFloat(s.transport_fee ?? s.transportFee) || 0;
        totalOther += parseFloat(s.other_fee ?? s.otherFee) || 0;
    });
    const hasFee = totalTransport > 0 || totalOther > 0;

    // 打开费用弹窗的通用处理器
    const openFee = (e) => {
        e.stopPropagation();
        if (typeof window.openAdminFeeModal === 'function') {
            window.openAdminFeeModal(group, studentName);
        }
    };

    const feeContainer = document.createElement('div');
    feeContainer.style.cssText = 'margin-top: 6px; justify-content: center; width: 100%; display: flex;';

    if (hasFee) {
        const feeInfo = document.createElement('span');
        feeInfo.style.cssText = 'background: #FEF3C7; color: #D97706; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; cursor: pointer;';

        feeInfo.addEventListener('click', openFee);

        let parts = [];
        if (totalTransport > 0) parts.push(`交通¥${totalTransport}`);
        if (totalOther > 0) parts.push(`其他¥${totalOther}`);
        feeInfo.textContent = parts.join(' ');

        feeContainer.appendChild(feeInfo);
    } else {
        const feeBtn = document.createElement('button');
        feeBtn.classList.add('add-fee-btn');
        feeBtn.textContent = '添加费用';
        feeBtn.style.cssText = 'padding: 2px 8px; font-size: 11px; min-width: auto; height: 22px; margin: 0 auto;';

        feeBtn.addEventListener('click', openFee);
        feeContainer.appendChild(feeBtn);
    }

    if (feeContainer.hasChildNodes()) {
        const feeWrap = document.createElement('div');
        feeWrap.classList.add('fee-bottom-wrap');
        feeWrap.style.cssText = 'display: flex; justify-content: flex-end; width: 100%; border-top: 1px dashed #e2e8f0; padding-top: 6px; margin-top: 6px;';
        feeWrap.appendChild(feeContainer);
        footer.appendChild(feeWrap);
    }
    content.appendChild(footer);
    card.appendChild(content);

    return card;
}


// --- Status & Edit Logic ---

export async function updateScheduleStatus(id, newStatus) {
    if (!window.apiUtils) return;

    // 乐观更新：立即更新UI
    const backup = optimisticUpdate(id, { status: newStatus });

    try {
        // 后台保存到服务器
        await window.apiUtils.put(`/admin/schedules/${id}`, { status: newStatus });

        // 更新内存缓存
        for (const entry of WeeklyDataStore.schedules.values()) {
            if (entry.rows) {
                const t = entry.rows.find(r => String(r.id) == String(id));
                if (t) t.status = newStatus;
            }
        }

        // 移除loading状态
        if (backup.card) {
            backup.card.classList.remove('optimistic-loading');
        }

        window.apiUtils.showSuccessToast('状态已更新');
    } catch (err) {
        // 回滚UI
        rollbackOperation(backup, 'update');
        window.apiUtils.showToast('更新状态失败', 'error');
    }
}

export async function deleteSchedule(id) {
    if (!confirm('确定要删除此排课吗？')) return;

    // 先从缓存中获取记录信息（在乐观删除之前，确保能获取到数据）
    let dateKey = null;
    let studentId = null;

    for (const entry of WeeklyDataStore.schedules.values()) {
        if (entry && entry.rows) {
            const rec = entry.rows.find(r => String(r.id) === String(id));
            if (rec) {
                dateKey = rec.date || rec.class_date;
                studentId = rec.student_id;
                break;
            }
        }
    }

    // 获取按钮反馈上下文
    const delBtn = document.getElementById('scheduleFormDelete');
    const originalText = delBtn ? delBtn.textContent : '删除';

    // 乐观删除：立即从UI移除 (返回 undo 句柄)
    const backup = optimisticDelete(id);

    try {
        if (delBtn) {
            delBtn.disabled = true;
            delBtn.textContent = '删除中...';
        }

        // 后台从服务器删除
        await window.apiUtils.delete(`/admin/schedules/${id}`);

        // 删除成功，清除备份中的定时器（如果有），确认删除
        if (backup && backup.commit) {
            backup.commit();
        }

        // 清除内存缓存
        WeeklyDataStore.invalidateSchedules();

        // 操作成功后的闭环处理：关闭表单容器及背景遮罩(阴影区域)
        const formContainer = document.getElementById('scheduleFormContainer');
        const overlay = document.getElementById('modalOverlay');
        
        if (formContainer) formContainer.style.display = 'none';
        if (overlay) overlay.style.display = 'none';

        if (window.apiUtils) window.apiUtils.showSuccessToast('排课删除成功');

        // 静默刷新的局部更新流程
        await WeeklyDataStore.getAllSchedules(true);
        if (studentId && dateKey) {
            await refreshCell(studentId, dateKey);
        } else {
            // 如果定位失败，执行无动画的周视图重绘
            await loadSchedules(false, false);
        }
    } catch (err) {
        // 回滚UI
        rollbackOperation(backup, 'delete');
        if (window.apiUtils) window.apiUtils.showToast('删除失败: ' + (err.message || ''), 'error');
    } finally {
        if (delBtn) {
            delBtn.disabled = false;
            delBtn.textContent = originalText;
        }
    }
}

function openCellEditor(student, dateISO) {
    const form = document.getElementById('scheduleForm');
    const container = document.getElementById('scheduleFormContainer');
    if (!form || !container) return;

    loadScheduleFormOptions().then(() => {
        form.dataset.mode = 'add';
        form.dataset.id = '';
        document.getElementById('scheduleFormTitle').textContent = '添加排课';

        const delBtn = document.getElementById('scheduleFormDelete');
        if (delBtn) delBtn.style.display = 'none';

        const studentSel = form.querySelector('#scheduleStudent');
        const studentReadonlyDiv = document.getElementById('scheduleStudentReadonly');
        const dateInput = form.querySelector('#scheduleDate');
        const dateReadonlyDiv = document.getElementById('scheduleDateReadonly');

        if (studentSel) {
            studentSel.value = String(student.id);
            studentSel.disabled = true;
            studentSel.style.display = 'none';
        }
        if (studentReadonlyDiv) {
            studentReadonlyDiv.textContent = student.name || String(student.id);
            studentReadonlyDiv.style.display = 'block';
        }

        if (dateInput) {
            dateInput.value = dateISO;
            dateInput.disabled = true;
            dateInput.style.display = 'none';
        }
        if (dateReadonlyDiv) {
            dateReadonlyDiv.textContent = dateISO;
            dateReadonlyDiv.style.display = 'block';
        }

        form.querySelector('#scheduleStartTime').value = '19:00';
        form.querySelector('#scheduleEndTime').value = '22:00';
        form.querySelector('#scheduleLocation').value = student.visit_location || '';
        form.querySelector('#scheduleTypeSelect').value = '';
        form.querySelector('#scheduleTeacher').value = '';
        if (form.querySelector('#scheduleStatus')) form.querySelector('#scheduleStatus').value = 'confirmed';

        // 首次加载后触发一次冲突检测
        updateTeacherStatusHints();

        // 应用表单记忆
        applyFormMemory();

        // 默认选择第一个老师和课程类型（如果有）
        const tempTeacher = form.querySelector('#scheduleTeacher');
        const tempType = form.querySelector('#scheduleTypeSelect');
        if (tempTeacher && tempTeacher.options.length > 1 && !tempTeacher.value) {
            tempTeacher.selectedIndex = 1;
        }
        if (tempType && tempType.options.length > 1 && !tempType.value) {
            tempType.selectedIndex = 1;
        }

        const overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.style.display = 'block';
        container.style.display = 'block';
    });
}

export async function editSchedule(id) {
    const container = document.getElementById('scheduleFormContainer');
    const form = document.getElementById('scheduleForm');
    if (!container || !form) return;

    try {
        const [_, resp] = await Promise.all([
            loadScheduleFormOptions(),
            window.apiUtils.get(`/admin/schedules/${id}`)
        ]);
        const data = resp.data || resp;

        form.dataset.mode = 'edit';
        form.dataset.id = id;
        document.getElementById('scheduleFormTitle').textContent = '编辑排课';

        const delBtn = document.getElementById('scheduleFormDelete');
        if (delBtn) {
            delBtn.style.display = 'inline-block';
            const newDel = delBtn.cloneNode(true);
            delBtn.parentNode.replaceChild(newDel, delBtn);
            newDel.className = 'btn btn-danger';
            newDel.textContent = '删除';
            newDel.addEventListener('click', () => deleteSchedule(id));
        }

        const studentSel = form.querySelector('#scheduleStudent');
        const studentReadonlyDiv = document.getElementById('scheduleStudentReadonly');
        const dateInput = form.querySelector('#scheduleDate');
        const dateReadonlyDiv = document.getElementById('scheduleDateReadonly');

        if (studentSel) { studentSel.disabled = false; studentSel.style.display = 'block'; studentSel.value = data.student_id; }
        if (studentReadonlyDiv) studentReadonlyDiv.style.display = 'none';

        if (dateInput) {
            let iso = data.date;
            if (data.class_date) iso = data.class_date;

            // Fix: Use toISODate to handle timezone conversion correctly (Task 28)
            // This prevents "one day early" issues when backend sends UTC timestamps
            if (iso) {
                // If it's already YYYY-MM-DD, try to keep it, but toISODate handles it fine for local user
                // If it's a timestamp, toISODate converts it to local date
                iso = toISODate(iso);
            }

            dateInput.disabled = false; dateInput.style.display = 'block'; dateInput.value = iso;
        }
        if (dateReadonlyDiv) dateReadonlyDiv.style.display = 'none';

        form.querySelector('#scheduleTeacher').value = data.teacher_id || '';
        form.querySelector('#scheduleStartTime').value = sanitizeTimeString(data.start_time);
        form.querySelector('#scheduleEndTime').value = sanitizeTimeString(data.end_time);
        form.querySelector('#scheduleLocation').value = data.location || '';
        form.querySelector('#scheduleTypeSelect').value = data.course_id || '';
        if (form.querySelector('#scheduleStatus')) form.querySelector('#scheduleStatus').value = data.status || 'confirmed';

        // 如果某些字段为空，可以应用表单记忆
        const memory = loadFormMemory();
        if (memory) {
            const teacherEl = form.querySelector('#scheduleTeacher');
            const typeEl = form.querySelector('#scheduleTypeSelect');
            if (teacherEl && !teacherEl.value && memory.teacher_id) teacherEl.value = memory.teacher_id;
            if (typeEl && !typeEl.value && memory.type_id) typeEl.value = memory.type_id;
        }

        const overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.style.display = 'block';
        container.style.display = 'block';
        form.dataset.snapshot = JSON.stringify(data);

        // 编辑模式下初始触发一次冲突检测
        updateTeacherStatusHints();

    } catch (err) {
        
        window.apiUtils.showToast('加载详情失败', 'error');
    }
}

async function loadScheduleFormOptions() {
    const typeSel = document.getElementById('scheduleTypeSelect');
    if (typeSel && window.ScheduleTypesStore) {
        const types = window.ScheduleTypesStore.getAll();
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(typeSel, '<option value="">选择类型</option>'); } else { typeSel.innerHTML = '<option value="">选择类型</option>'; }
        types.forEach(t => {
            const o = document.createElement('option');
            o.value = t.id; o.textContent = t.description || t.name;
            typeSel.appendChild(o);
        });
    }

    const teacherSel = document.getElementById('scheduleTeacher');
    const studentSel = document.getElementById('scheduleStudent');
    const [teachers, students] = await Promise.all([WeeklyDataStore.getTeachers(), WeeklyDataStore.getStudents()]);

    if (teacherSel) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(teacherSel, '<option value="">选择教师</option>'); } else { teacherSel.innerHTML = '<option value="">选择教师</option>'; }
        const restricted = [];
        const normal = [];

        teachers.forEach(t => {
            if (String(t.status) == '-1') return;
            const o = document.createElement('option');
            o.value = t.id; o.dataset.baseName = t.name;
            o.textContent = t.name + (String(t.status) == '0' ? '(暂停)' : '');
            if (parseInt(t.restriction) === 1) restricted.push(o);
            else normal.push(o);
        });

        restricted.forEach(o => teacherSel.appendChild(o));
        if (restricted.length > 0 && normal.length > 0) {
            const sep = document.createElement('option');
            sep.disabled = true;
            sep.value = '';
            sep.textContent = '──────────';
            sep.style.color = '#ccc';
            sep.style.textAlign = 'center';
            teacherSel.appendChild(sep);
        }
        normal.forEach(o => teacherSel.appendChild(o));
    }

    if (studentSel) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(studentSel, '<option value="">选择学生</option>'); } else { studentSel.innerHTML = '<option value="">选择学生</option>'; }
        students.forEach(s => {
            if (String(s.status) == '-1') return;
            const o = document.createElement('option');
            o.value = s.id; o.textContent = s.name + (String(s.status) == '0' ? '(暂停)' : '');
            studentSel.appendChild(o);
        });
    }

    // 表单变动监听：日期、开始/结束时间变化时更新老师状态提示
    const form = document.getElementById('scheduleForm');
    if (form) {
        const fields = ['#scheduleDate', '#scheduleStartTime', '#scheduleEndTime'].map(id => form.querySelector(id));
        fields.forEach(f => {
            if (f && !f.dataset.listenerAttached) {
                f.addEventListener('change', () => updateTeacherStatusHints());
                f.dataset.listenerAttached = 'true';
            }
        });
    }
}

/**
 * 实时更新教师选择框中的冲突状态提示词
 */
async function updateTeacherStatusHints() {
    const form = document.getElementById('scheduleForm');
    const teacherSel = document.getElementById('scheduleTeacher');
    if (!form || !teacherSel) return;

    const date = form.querySelector('#scheduleDate')?.value;
    const start = form.querySelector('#scheduleStartTime')?.value;
    const end = form.querySelector('#scheduleEndTime')?.value;
    const excludeId = form.dataset.id;

    if (!date || !start || !end) return;

    try {
        const params = { date, startTime: start, endTime: end };
        if (excludeId) params.excludeScheduleId = excludeId;

        const conflicts = await window.apiUtils.get('/admin/teachers/conflicts', params);

        Array.from(teacherSel.options).forEach(opt => {
            if (!opt.value) return;
            const tId = opt.value;
            const baseName = opt.dataset.baseName || opt.textContent.split('(')[0].trim();
            if (!opt.dataset.baseName) opt.dataset.baseName = baseName;

            let hint = '';
            const status = conflicts[tId];
            if (status) {
                if (status.hasClass) hint = ' (已有排课)';
                else if (status.isUnavailable) hint = ' (个人无空闲)';
            }
            opt.textContent = baseName + hint;
        });
    } catch (e) {  }
}

export async function setupScheduleEventListeners() {
    const closeForm = () => {
        const container = document.getElementById('scheduleFormContainer');
        const overlay = document.getElementById('modalOverlay');
        if (container) container.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
    };
    
    document.getElementById('closeScheduleFormBtn')?.addEventListener('click', closeForm);
    document.getElementById('cancelScheduleFormBtn')?.addEventListener('click', closeForm);
    
    const overlay = document.getElementById('modalOverlay');
    if (overlay) {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) closeForm();
        });
    }
    
    document.getElementById('toggleAdminFeeBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof window.toggleAdminFeeVisibility === 'function') {
            window.toggleAdminFeeVisibility();
        }
    });
    
    document.getElementById('addScheduleBtn')?.addEventListener('click', (e) => {
        e.preventDefault();
        if (typeof window.showAddScheduleModal === 'function') {
            window.showAddScheduleModal();
        }
    });

    const form = document.getElementById('scheduleForm');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const btn = document.getElementById('scheduleFormSubmit');
            const mode = form.dataset.mode;
            const id = form.dataset.id;

            const teacherId = form.querySelector('#scheduleTeacher').value || null;
            const studentId = form.querySelector('#scheduleStudent').value;
            const courseId = form.querySelector('#scheduleTypeSelect').value || null;

            // 构建符合后端验证规则的 Payload
            const body = {
                student_ids: studentId ? [Number(studentId)] : [],
                teacher_id: teacherId ? Number(teacherId) : null,
                date: form.querySelector('#scheduleDate').value,
                start_time: form.querySelector('#scheduleStartTime').value,
                end_time: form.querySelector('#scheduleEndTime').value,
                location: form.querySelector('#scheduleLocation').value,
                type_ids: courseId ? [Number(courseId)] : [], // 统一使用 type_ids 数组
                status: form.querySelector('#scheduleStatus') ? form.querySelector('#scheduleStatus').value : 'confirmed',
                resolve_strategy: 'override' // 默认覆盖
            };

            if (!body.student_ids.length || !body.date || !body.start_time || !body.end_time) {
                if (window.apiUtils) window.apiUtils.showToast('请填写必填项', 'error');
                return;
            }

            let originalBtnText = '';
            if (btn) {
                btn.disabled = true;
                originalBtnText = btn.textContent;
                btn.textContent = '保存中...';
            }

            let backup = null;
            let currentCard = null; // 用于编辑模式下的乐观更新
            let originalCardHtml = '';

            try {
                if (mode === 'add') {
                    // 禁用乐观添加动画，直接保存
                    // backup = optimisticAdd(body);

                    // 后台保存
                    const result = await window.apiUtils.post('/admin/schedules', body);

                    saveFormMemory({
                        start_time: body.start_time,
                        end_time: body.end_time,
                        teacher_id: body.teacher_id,
                        type_id: body.type_ids && body.type_ids.length ? body.type_ids[0] : null
                    });


                    // 静默失效本地缓存。不进行全盘闪烁式刷新
                    WeeklyDataStore.invalidateSchedules();
                    // 移除成功提示 toast
                    // window.apiUtils.showSuccessToast('排课添加成功');
                } else {
//                     // 乐观更新：立即用新表单里的数据去“覆写”当前点击格子的HTML
//                     currentCard = document.querySelector(`.schedule-card[data-schedule-id="${id}"]`);
//                     if (currentCard) {
//                         originalCardHtml = currentCard.innerHTML; // 快照
//                         currentCard.classList.add('optimistic-updating');
// 
//                         // 从表单内爬取修改的字段并投射到卡片上
//                         const teacherSelect = form.querySelector('#scheduleTeacher');
//                         const typeSelect = form.querySelector('#scheduleTypeSelect');
//                         const tName = teacherSelect && teacherSelect.selectedOptions[0] ? teacherSelect.selectedOptions[0].text : '';
//                         const cName = typeSelect && typeSelect.selectedOptions[0] ? typeSelect.selectedOptions[0].text : '';
// 
//                         const timeSpan = currentCard.querySelector('.schedule-time');
//                         if (timeSpan) timeSpan.textContent = `${body.start_time.substring(0, 5)}-${body.end_time.substring(0, 5)}`;
// 
//                         const tDiv = currentCard.querySelector('.teacher-name');
//                         if (tDiv && tName) tDiv.textContent = tName;
// 
//                         const cDiv = currentCard.querySelector('.course-type');
//                         if (cDiv && cName) cDiv.textContent = cName;
// 
//                         const locP = currentCard.querySelector('.location-text');
//                         if (locP && body.location) if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(locP, `<span class="material-icons-round">place</span>${body.location}`); } else { locP.innerHTML = `<span class="material-icons-round">place</span>${body.location}`; }
//                     }

                    // 异步请求后端
                    await window.apiUtils.put(`/admin/schedules/${id}`, body);

                    saveFormMemory({
                        start_time: body.start_time,
                        end_time: body.end_time,
                        teacher_id: body.teacher_id,
                        type_id: body.type_ids && body.type_ids.length ? body.type_ids[0] : null
                    });

                    // 成功后，去处特效
                    if (currentCard) {
                        currentCard.classList.remove('optimistic-updating');
                    }
                    WeeklyDataStore.invalidateSchedules();
                    // 移除成功提示 toast
                    // window.apiUtils.showSuccessToast('排课更新成功');
                }

                // 立即关闭表单并移除背景蒙层(阴影区域)
                document.getElementById('scheduleFormContainer').style.display = 'none';
                const overlay = document.getElementById('modalOverlay');
                if (overlay) overlay.style.display = 'none';

                // 局部更新流程：
                // 1. 对于新增或修改，通常我们会收到完整的 record。
                // 2. 如果后端只返回了 ID，我们需要根据 ID 全量拉取一次或在此处通过 API 获取单条，
                //    但为了最快响应且保持逻辑简单，我们在操作成功后执行一次静默的 getAllSchedules(true) 
                //    并仅重绘变动的单元格。

                // 由于后端目前只返回 ID，我们先强制同步内存，但不触发全局 UI 重载
                await WeeklyDataStore.getAllSchedules(true);

                // 提取日期和学生 ID 进行定点刷新
                const finalStudentId = body.student_ids ? (Array.isArray(body.student_ids) ? body.student_ids[0] : body.student_ids) : null;
                const finalDateKey = body.date;

                if (finalStudentId && finalDateKey) {
                    await refreshCell(finalStudentId, finalDateKey);
                } else {
                    // 如果定位失败，退回到局部刷新策略（不触发全局 Loading 动画）
                    await loadSchedules(true, false);
                }
            } catch (err) {
                

                // 万一报错了，回滚操作（反欺骗）
                if (mode === 'add' && backup) {
                    rollbackOperation(backup, 'add');
                } else if (mode === 'edit' && currentCard && originalCardHtml) {
                    // 悲观恢复原来的DOM卡片
                    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(currentCard, originalCardHtml); } else { currentCard.innerHTML = originalCardHtml; }
                    currentCard.classList.remove('optimistic-updating');
                }

                if (window.apiUtils) window.apiUtils.showToast('保存失败: ' + (err.message || ''), 'error');
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = originalBtnText || '保存';
                }
            }
        });
    }

    // Week Nav
    const prevBtn = document.getElementById('prevWeek');
    if (prevBtn) prevBtn.addEventListener('click', () => {
        if (!window.__weeklyRange) return;
        const s = new Date(window.__weeklyRange.start);
        s.setDate(s.getDate() - 7);
        const e = new Date(s); e.setDate(e.getDate() + 6);
        window.__weeklyRange.start = toISODate(s);
        window.__weeklyRange.end = toISODate(e);
        const startInput = document.getElementById('startDate');
        const endInput = document.getElementById('endDate');
        if (startInput) startInput.value = window.__weeklyRange.start;
        if (endInput) endInput.value = window.__weeklyRange.end;
        loadSchedules();
    });
    const nextBtn = document.getElementById('nextWeek');
    if (nextBtn) nextBtn.addEventListener('click', () => {
        if (!window.__weeklyRange) return;
        const s = new Date(window.__weeklyRange.start);
        s.setDate(s.getDate() + 7);
        const e = new Date(s); e.setDate(e.getDate() + 6);
        window.__weeklyRange.start = toISODate(s);
        window.__weeklyRange.end = toISODate(e);
        const startInput = document.getElementById('startDate');
        const endInput = document.getElementById('endDate');
        if (startInput) startInput.value = window.__weeklyRange.start;
        if (endInput) endInput.value = window.__weeklyRange.end;
        loadSchedules();
    });
    const todayBtn = document.getElementById('todayWeek');
    if (todayBtn) todayBtn.addEventListener('click', () => {
        const DRU = window.DateRangeUtils;
        if (DRU) {
            const week = DRU.getWeekDates(new Date());
            window.__weeklyRange = { start: toISODate(week[0]), end: toISODate(week[6]) };
            const startInput = document.getElementById('startDate');
            const endInput = document.getElementById('endDate');
            if (startInput) startInput.value = window.__weeklyRange.start;
            if (endInput) endInput.value = window.__weeklyRange.end;
            loadSchedules();
        }
    });

    // Date Range Pickers
    const startInput = document.getElementById('startDate');
    const endInput = document.getElementById('endDate');
    if (startInput) startInput.addEventListener('change', () => {
        window.__weeklyRange = { start: startInput.value, end: endInput.value };
        loadSchedules();
    });
    if (endInput) endInput.addEventListener('change', () => {
        window.__weeklyRange = { start: startInput.value, end: endInput.value };
        loadSchedules();
    });

    // Filter changes REMOVED
    // ['typeFilter', 'statusFilter', 'teacherFilter'].forEach ... REMOVED

    // initScheduleFilters(); // REMOVED
}

async function initScheduleFilters() {
    const tf = document.getElementById('teacherFilter');
    if (tf) {
        try {
            const teachers = await WeeklyDataStore.getTeachers();
            const current = tf.value;
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tf, '<option value="">全部教师</option>'); } else { tf.innerHTML = '<option value="">全部教师</option>'; }
            teachers.forEach(t => {
                if (String(t.status) == '-1') return;
                const o = document.createElement('option');
                o.value = t.id; o.textContent = t.name;
                tf.appendChild(o);
            });
            if (current) tf.value = current;
        } catch (e) {  }
    }
}

// =============================================================================
// 模块接口导出 - 置于末尾确保所有依赖已初始化 (避免 TDZ ReferenceError)
// =============================================================================
window.ScheduleManager = {
    loadSchedules: (force = true, showLoading = true) => loadSchedules(force, showLoading), // 允许透传加载状态
    refreshCell: refreshCell, // 导出局部刷新
    WeeklyDataStore: WeeklyDataStore,
    renderCache: () => {
        // 渲染当前内存中的数据，不发网络请求，且不显示过渡动画
        loadSchedules(false, false);
    }
};

// Expose required methods to window for legacy code
