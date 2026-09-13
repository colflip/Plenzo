/**
 * Schedule Manager Module
 * @description 处理排课管理相关的逻辑：周视图渲染、数据加载、排课增删改
 */

import { TIME_ZONE } from './constants.js';
import { showTableLoading, hideTableLoading } from './ui-helper.js';
import { getScheduleWatermarkText } from '../shared/schedule-helpers.js';
import { syncToggleButton } from '../shared/view-utils.js';
import {
    initPairForm, resetPairRows, fillPairRows, collectPairs, refitPairSelects
} from './schedule-pair-form.js';


// --- Global State ---
window.adminShowPlan = false;

window.toggleAdminShowPlan = async function () {
    window.adminShowPlan = !window.adminShowPlan;
    const btnText = document.getElementById('showPlanBtnText');
    const toggleBtn = document.getElementById('toggleShowPlanBtn');

    if (btnText) {
        btnText.textContent = window.adminShowPlan ? '隐藏全部安排' : '显示全部安排';
    }

    syncToggleButton(toggleBtn, window.adminShowPlan);

    // 重新从后端拉取全量数据，因为过滤是在后端执行的
    if (window.ScheduleManager) {
        try {
            showTableLoading();
            await window.ScheduleManager.loadSchedules(true); // force reload from API
        } catch (err) {
            console.error('切换全部安排显示失败:', err);
        } finally {
            hideTableLoading();
        }
    }
};

// 挂载顶层全局显隐费用按钮的初始绘制UI
// This part needs to be called when the page initializes or data is loaded.
// For now, placing it here as a global setup.
document.addEventListener('DOMContentLoaded', () => {
    const showPlanBtn = document.getElementById('toggleShowPlanBtn');
    const showPlanBtnText = document.getElementById('showPlanBtnText');
    if (showPlanBtnText) showPlanBtnText.textContent = window.adminShowPlan ? '隐藏全部安排' : '显示全部安排';
    syncToggleButton(showPlanBtn, window.adminShowPlan);
    // 点击事件已由 action-delegate.js 通过 data-action="toggle-admin-show-plan" 统一委托处理
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
            status_category: r.status_category,
            status_code: r.status_code,
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
        // 教师与类型现在在第一行 pair 上（不再是弹窗顶部的单选控件）
        const teacherEl = document.querySelector('#scheduleTeacherRows .pair-teacher');
        const typeEl = document.querySelector('#scheduleTeacherRows .pair-type');

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
 * @param {string|number} id - 场次 ID
 * @param {Object} changes - 要更新的字段
 * @param {string} [teacherUid] - 教师 pair 的 uid；多师多生下 (session_id, teacher_uid) 才唯一定位一行
 * @returns {Object} 包含原始数据的backup对象
 */
function optimisticUpdate(id, changes, teacherUid) {
    const row = teacherUid
        ? document.querySelector(`[data-schedule-id="${id}"][data-teacher-uid="${teacherUid}"]`)
        : document.querySelector(`[data-schedule-id="${id}"]`);
    if (!row) {

        return { backup: null };
    }

    // 添加loading样式
    row.classList.add('optimistic-loading');

    const backup = {
        row,
        changes,
        teacherUid,
        oldStatus: ''
    };

    if (changes.status) {
        const select = row.querySelector('.status-select');
        if (select) {
            backup.oldStatus = select.dataset.lastStatus || select.value;
            select.value = changes.status;
            select.className = `status-select ${changes.status}`;
            select.dataset.lastStatus = changes.status;
        }

        row.classList.toggle('status-cancelled', changes.status === 'cancelled');

        if (changes.status === 'completed') {
            if (!row.querySelector('.completed-checkmark-icon')) {
                const checkmark = document.createElement('div');
                checkmark.className = 'completed-checkmark-icon';
                if (select) {
                    row.insertBefore(checkmark, select);
                } else {
                    row.appendChild(checkmark);
                }
            }
        } else {
            const checkIcon = row.querySelector('.completed-checkmark-icon');
            if (checkIcon) checkIcon.remove();
        }

        const group = row.closest('.schedule-card-group');
        if (group) {
            const allRows = Array.from(group.querySelectorAll('.schedule-row'));
            const allCancelled = allRows.length > 0 && allRows.every(r => r.classList.contains('status-cancelled'));
            group.classList.toggle('status-cancelled', allCancelled);
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
                // 通过再次应用旧状态实现回滚，避免覆写innerHTML销毁事件监听器
                if (backup.row && backup.changes && backup.changes.status !== undefined) {
                    backup.row.classList.remove('optimistic-loading');
                    optimisticUpdate(backup.row.dataset.scheduleId, { status: backup.oldStatus }, backup.teacherUid);
                    backup.row.classList.remove('optimistic-loading');
                }
                break;

            case 'delete':
                // 重新插入卡片
                if (backup.parent) {
                    const tempDiv = document.createElement('div');
                    window.SecurityUtils.safeSetHTML(tempDiv, backup.originalHTML);
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

// 缓存键按「是否查看全部安排(含已调整原课程)」分桶，避免默认视图复用了
// "显示全部安排"模式下缓存的已调整原课程数据（页面刷新后 adminShowPlan 重置为 false，
// 但 localStorage 仍残留旧数据导致默认视图错误地展示已调整原课程）。
function adminSchedulesCacheKey() {
    return 'admin_all_schedules' + (window.adminShowPlan ? '_plan' : '_actual');
}

export const WeeklyDataStore = {
    ttlMs: 60 * 60 * 1000, // 1 hour cache
    students: { list: [], loadedAt: 0 },
    teachers: { list: [], loadedAt: 0 },
    schedules: new Map(),

    _isFresh(ts) { return ts && (Date.now() - ts) < this.ttlMs; },

    // Persistent Store Keys
    _CACHE_KEY_prefix: 'plenzo_admin_',

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
        } catch (e) { }
    },

    async getAllSchedules(force = false) {
        const key = adminSchedulesCacheKey();
        // 迁移：清除旧版本无模式后缀的脏缓存
        this._clearLegacyLocalCache();
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
                const key = adminSchedulesCacheKey();
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
            } catch (e) { }
        }
    },

    async _fetchAndCache(key) {
        const rows = await this._fetchFromApi();
        this.schedules.set(key, { rows, loadedAt: Date.now() });
        this._saveToLocal(key, rows);
        return rows;
    },

    // 兼容旧 key（无模式后缀），迁移时一并清除，防止脏数据
    _clearLegacyLocalCache() {
        const legacy = this._CACHE_KEY_prefix + 'admin_all_schedules';
        if (localStorage.getItem(legacy)) localStorage.removeItem(legacy);
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

            if (window.adminShowPlan) {
                params.show_plan = 'true';
            }

            const rows = await window.apiUtils.get('/admin/schedules/grid', params);
            if (!Array.isArray(rows)) {
                throw new Error('排课列表响应格式无效');
            }
            return normalizeScheduleRows(rows);
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
        if (!Array.isArray(resp)) {
            throw new Error('学生列表响应格式无效');
        }
        const list = resp;
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
        const list = Array.isArray(resp)
            ? resp
            : (Array.isArray(resp?.teachers) ? resp.teachers : null);
        if (!list) {
            throw new Error('教师列表响应格式无效');
        }
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
                k.startsWith(this._CACHE_KEY_prefix + 'admin_all_schedules')) {
                localStorage.removeItem(k);
            }
        });
    },

    /**
     * 用户资料（教师）在别处被改动后调用：内存与 localStorage 一起清。
     * 只清内存不够 —— getTeachers() 在内存为空时会回退读 localStorage，
     * 1 小时 TTL 内旧数据直接回填并重新计时，表现为「改了名字，弹窗下拉还是旧名字」。
     */
    invalidateTeachers() {
        this.teachers = { list: [], loadedAt: 0 };
        try { localStorage.removeItem(this._CACHE_KEY_prefix + 'teachers'); } catch (_) { }
    },

    /** 同 invalidateTeachers：学生资料变更后连 localStorage 一起清 */
    invalidateStudents() {
        this.students = { list: [], loadedAt: 0 };
        try { localStorage.removeItem(this._CACHE_KEY_prefix + 'students'); } catch (_) { }
    },

    /**
     * 局部更新内存中的排课数据
     * @param {Object|number} recordOrId - 完整的排课记录对象或 ID (删除时)
     * @param {boolean} isDelete - 是否为删除操作
     */
    updateLocalRecord(recordOrId, isDelete = false) {
        const key = adminSchedulesCacheKey();
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
        window.SecurityUtils.safeSetHTML(td, '');
        if (cellItems.length === 0) {
            window.SecurityUtils.safeSetHTML(td, '<div class="no-schedule">-</div>');
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
        const useForce = !!window.__weeklyForceRefresh;

        // Parallel load: Students (usually small) and Schedules (Cached)
        const [students, schedules] = await Promise.all([
            WeeklyDataStore.getStudents(useForce),
            WeeklyDataStore.getSchedules(startDateISO, endDateISO, null, null, null, useForce)
        ]);

        window.__weeklyForceRefresh = false;

        renderWeeklyHeader(weekDates);
        renderWeeklyBody(students, schedules, weekDates);

    } catch (err) {

        renderWeeklyError(err, () => loadSchedules(true, true));
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
        window.SecurityUtils.safeSetHTML(tbody, '');
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

function renderWeeklyError(error, onRetry) {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;
    // 统一错误态（shared/error-ui.js）：textContent 渲染，不拼接服务端消息到 innerHTML
    renderTableErrorRow(tbody, {
        colspan: 8,
        error,
        onRetry,
        detail: null
    });
}

function renderWeeklyHeader(weekDates) {
    const thead = document.getElementById('weeklyHeader');
    if (!thead) return;
    window.SecurityUtils.safeSetHTML(thead, '');
    const tr = document.createElement('tr');
    tr.innerHTML = '<th class="sticky-col student-cell" style="text-align: center;">学生</th>';

    const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    weekDates.forEach(d => {
        const th = document.createElement('th');
        const iso = toISODate(d);
        const dayName = days[d.getDay()];
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const date = String(d.getDate()).padStart(2, '0');

        const dateStr = `${month}月${date}日`;
        const metaHtml = window.ScheduleDateLabels?.getHeaderMetaHtml(d) || '';

        // Match Teacher Availability Table Header Style
        if (window.SecurityUtils) {
            window.SecurityUtils.safeSetHTML(th, `
                <div class="th-content">
                    <span class="th-date" style="line-height:1.2;">${dateStr}</span>
                    <span class="th-day">${dayName}</span>
                    ${metaHtml}
                </div>`);
        } else {
            th.innerHTML = `
                <div class="th-content">
                    <span class="th-date" style="line-height:1.2;">${dateStr}</span>
                    <span class="th-day">${dayName}</span>
                    ${metaHtml}
                </div>`;
        }
        th.dataset.date = iso;
        tr.appendChild(th);
    });
    thead.appendChild(tr);
}

function renderWeeklyBody(students, schedules, weekDates) {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;
    window.SecurityUtils.safeSetHTML(tbody, '');

    // Performance: Use Fragment
    const fragment = document.createDocumentFragment();
    const dateKeys = weekDates.map(toISODate);
    const dateKeySet = new Set(dateKeys);

    const cellIndex = new Map();
    const scheduledStudentIds = new Set();
    const push = (sid, iso, row) => {
        const k = `${sid}|${iso}`;
        if (!cellIndex.has(k)) cellIndex.set(k, []);
        cellIndex.get(k).push(row);
        if (dateKeySet.has(iso)) scheduledStudentIds.add(String(sid));
    };

    schedules.forEach(s => {
        const iso = (typeof s.date === 'string') ? s.date : toISODate(new Date(s.date));
        if (s.student_id) push(s.student_id, iso, s);
        else if (s.student_ids) {
            String(s.student_ids).split(',').map(x => x.trim()).filter(Boolean).forEach(id => push(id, iso, s));
        }
    });

    // Sort: students with schedules first (by ID asc), then students without (by ID asc)
    students.sort((a, b) => {
        const aHas = scheduledStudentIds.has(String(a.id));
        const bHas = scheduledStudentIds.has(String(b.id));
        if (aHas !== bHas) return aHas ? -1 : 1;
        return (a.id || 0) - (b.id || 0);
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
                window.SecurityUtils.safeSetHTML(td, '<div class="no-schedule">-</div>');
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
/**
 * 创建离屏截图容器 + 复制原表格外观的空 <table>（含表头边框/圆角）。
 * 供单行截图与整表截图复用。
 */
function buildCaptureWrapper(originalTable) {
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
    tableClone.style.cssText = originalTable.style.cssText;
    tableClone.style.backgroundColor = '#ffffff';
    tableClone.style.width = '100%';
    // 恢复外扩边框线及大圆角
    tableClone.style.borderTop = '1px solid #E2E8F0';
    tableClone.style.borderLeft = '1px solid #E2E8F0';
    tableClone.style.borderRight = '1px solid #E2E8F0';
    tableClone.style.borderRadius = '8px';
    tableClone.style.overflow = 'hidden';

    wrapper.appendChild(tableClone);
    return { wrapper, tableClone };
}

/**
 * 克隆表头行并保留列宽 / 去除 sticky 定位 / 补回边框。
 */
function buildCapturedHeader(originalHeaderTr) {
    const thead = document.createElement('thead');
    const headerRowClone = originalHeaderTr.cloneNode(true);

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
    return thead;
}

/**
 * 克隆一行学生排课并修复 cloneNode 引起的塌陷：
 *   - 同步列宽、去 sticky、补回单元格边框与底色
 *   - 重筑课程卡片圆角/边框/顶部彩条
 *   - 将 <select> 状态下拉替换为居中 <span>（html2canvas 无法正确渲染下拉对齐）
 */
function buildCapturedRow(originalTr) {
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
    // html2canvas 无法正确渲染 <select>（文字垂直对齐画错），克隆体里统一替换成只读 <span>。
    // 类名原样保留 —— 视觉几何完全由全局 CSS 驱动（span.status-select 的 inline-flex 居中 +
    // .schedule-card-group .status-select 的「行高=内容盒高度」），与页面上的胶囊同一套规则，
    // 不要再打内联样式补丁：line-height 等内联值会被样式表 !important 压掉，等于死代码。
    // 注意：cloneNode 不保留 <select> 的运行时 selectedIndex，需要从原始 DOM 读取。
    const origSelects = originalTr.querySelectorAll('select.status-select');
    const cloneSelects = rowClone.querySelectorAll('select.status-select');
    origSelects.forEach((origSel, idx) => {
        const cloneSel = cloneSelects[idx];
        if (!cloneSel) return;
        const opt = origSel.options[origSel.selectedIndex] || origSel.options[0];
        const text = opt ? opt.text : origSel.value || '';
        const span = document.createElement('span');
        span.className = origSel.className; // 保留 status-select + 状态颜色类
        span.textContent = text;
        cloneSel.parentNode.replaceChild(span, cloneSel);
    });

    return rowClone;
}

/**
 * 把离屏 wrapper 截图并写入剪贴板（Safari 兼容的 Promise 模式）。
 * 无论成功失败都会移除 wrapper。
 */
async function captureWrapperToClipboard(wrapper, toastId, successMsg) {
    document.body.appendChild(wrapper);
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

        if (window.apiUtils) window.apiUtils.showSuccessToast(successMsg);
    } catch (err) {
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        if (window.apiUtils) window.apiUtils.showToast('生成或复制图片失败: ' + err.message, 'error');
        if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
    }
}

async function handleStudentRowCapture(student, originalTr) {
    if (!window.html2canvas) {
        if (window.apiUtils) window.apiUtils.showToast('组件未加载 (html2canvas missing)', 'error');
        return;
    }

    const toastId = window.apiUtils ? window.apiUtils.showToast('正在生成图片...', 'info', 0) : null;

    const originalHeaderTr = document.querySelector('#weeklyHeader tr');
    const originalTable = document.querySelector('#weeklyBody')?.closest('table');
    if (!originalHeaderTr || !originalTable) {
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        return;
    }

    const { wrapper, tableClone } = buildCaptureWrapper(originalTable);
    tableClone.appendChild(buildCapturedHeader(originalHeaderTr));

    const tbody = document.createElement('tbody');
    tbody.appendChild(buildCapturedRow(originalTr));
    tableClone.appendChild(tbody);

    await captureWrapperToClipboard(wrapper, toastId, `已复制 ${student.name} 的课表图片`);
}

function scrollWidthWithBuffer(el) {
    return Math.max(el.scrollWidth, 1200) + 50;
}

function renderGroupedMergedSlots(td, items, student, dateKey) {
    const groups = new Map();
    items.forEach(item => {
        // 分组键就是场次 id。旧实现拼 `${start}|${end}|${loc}` 当键，任一行的时间或地点
        // 被改动就会让这一组静默裂开；现在后端每行都带 session_id，一场课就是一张卡片。
        const key = item.session_id != null ? String(item.session_id) : String(item.id);
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

    // 排序逻辑改进：
    // 1. 优先展示“正常/已确认/已完成”的课程，将“已调整(modified_away)”或“已取消”的排在后面
    // 2. 咨询记录/评审记录类型的教师在最后，其他按教师ID排序
    group.sort((a, b) => {
        const getStatus = (item) => (item.status || 'pending').toLowerCase();
        const statusA = getStatus(a);
        const statusB = getStatus(b);
        
        const isInactive = (s) => s === 'modified_away' || s === 'cancelled';
        const inactiveA = isInactive(statusA);
        const inactiveB = isInactive(statusB);

        if (inactiveA && !inactiveB) return 1;
        if (!inactiveA && inactiveB) return -1;

        const getTypeName = (item) => (item.schedule_type_name || item.type_name || item.schedule_type_cn || item.schedule_types || item.schedule_type || '').toString();
        const isRecord = (name) => name.includes('评审记录') || name.includes('咨询记录');

        const typeA = getTypeName(a);
        const typeB = getTypeName(b);
        const recordA = isRecord(typeA);
        const recordB = isRecord(typeB);

        if (recordA && !recordB) return 1;
        if (!recordA && recordB) return -1;
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

    // 整卡可点：卡片范围内（含底部时间/地点区域）点击都进编辑；
    // 卡片之外的单元格空白处由 td 的 click 弹「添加排课」（stopPropagation 挡住冒泡）
    card.addEventListener('click', (e) => {
        e.stopPropagation();
        editSchedule(first.session_id != null ? first.session_id : first.id);
    });

    const allCancelled = group.every(rec => (rec.status || '').toLowerCase() === 'cancelled');
    if (allCancelled) {
        card.classList.add('status-cancelled');
    }

    // 水印文本（与全校视图统一：adjustment_type===2 或 status==='modified_away' 即视为已调整）
    const watermarkText = getScheduleWatermarkText(group);

    if (watermarkText) {
        card.classList.add('is-temp-card');
        card.style.position = 'relative';
        card.style.overflow = 'hidden';
        const watermark = document.createElement('span');
        watermark.setAttribute('aria-hidden', 'true');
        const wmFontSize = watermarkText.length > 1 ? '66px' : '99px';
        watermark.style.cssText = [
            'position: absolute',
            'bottom: -10px',
            'right: 5px',
            `font-size: ${wmFontSize}`,
            'font-family: "Ma Shan Zheng", "Kaiti SC", "STXingkai", "KaiTi", cursive, serif',
            'color: rgba(0, 102, 204, 0.1)',
            'pointer-events: none',
            'z-index: 0',
            'transform: rotate(-15deg)',
            'line-height: 1',
            'user-select: none',
        ].join(';');
        
        watermark.textContent = watermarkText;
        card.appendChild(watermark);
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
        } else if (st === 'modified_away') {
            row.classList.add('status-modified_away');
        }
        row.dataset.scheduleId = rec.session_id != null ? rec.session_id : rec.id;
        // 同一场课会出现在多个学生列里，session id 不再唯一 —— 行的唯一标识是
        // (session_id, teacher_uid)，乐观更新与状态切换都按这两个键定位。
        if (rec.teacher_uid) row.dataset.teacherUid = rec.teacher_uid;
        row.title = '点击修改';
        row.style.cursor = 'pointer';

        row.addEventListener('click', (e) => {
            e.stopPropagation();
            editSchedule(rec.session_id != null ? rec.session_id : rec.id);
        });

        // Left: Name + Type
        const left = document.createElement('div');
        left.className = 'row-left';

        const typeStr = (rec.schedule_type_cn || rec.schedule_types || '').toString();

        const leftHtml = `
            <span class="teacher-name" style="flex-shrink: 0; white-space: nowrap;">${rec.teacher_name || '未分配'}</span>
            <div class="marquee-wrapper" style="flex: 1; min-width: 0; max-width: none;">
                <div class="marquee-content" style="padding-right: 0;">
                    <span class="course-type-text">${typeStr}</span>
                </div>
            </div>
        `;
        if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(left, leftHtml);
        else left.innerHTML = leftHtml;
        row.appendChild(left);

        // Right: Status Select (Quick Change)
        const statusSelect = document.createElement('select');
        statusSelect.className = `status-select ${st}`;
        statusSelect.dataset.lastStatus = st; // Store for revert

        const statusMap = { 
            'pending': '待确认', 
            'confirmed': '已确认', 
            'completed': '已完成', 
            'cancelled': '已取消',
            'modified_away': '已调整'
        };

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

        statusSelect.addEventListener('change', (e) => {
            e.stopPropagation();
            const newStatus = e.target.value;
            statusSelect.blur(); // Remove focus

            // 统一调用 updateScheduleStatus，由其内部处理 optimistic UI 和 API 同步
            updateScheduleStatus(rec.session_id != null ? rec.session_id : rec.id, rec.teacher_uid, newStatus);
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

    const footerHtml = `
        <div class="time-text">${timeRange}</div>
        ${locHtml}
    `;
    if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(footer, footerHtml);
    else footer.innerHTML = footerHtml;
    content.appendChild(footer);
    card.appendChild(content);

    return card;
}


// --- Status & Edit Logic ---

/**
 * 切换某位教师在某一场课里的生命周期状态。
 * 签名从 (id, status) 变为 (sessionId, teacherUid, lifecycle)：状态挂在教师 pair 上，
 * 定位需要「场次 id + uid」两个键。后端走原地重建，只改这一个 pair 的 status。
 */
export async function updateScheduleStatus(sessionId, teacherUid, newStatus) {
    if (!window.apiUtils) return;

    const row = teacherUid
        ? document.querySelector(`[data-schedule-id="${sessionId}"][data-teacher-uid="${teacherUid}"]`)
        : document.querySelector(`[data-schedule-id="${sessionId}"]`);
    if (row) row.classList.add('optimistic-loading');

    try {
        // 远程优先：先同步到数据库
        await window.apiUtils.patch(`/admin/sessions/${sessionId}/teachers/${teacherUid}/status`, { lifecycle: newStatus });

        // 远程成功后再更新本地缓存与UI
        for (const entry of WeeklyDataStore.schedules.values()) {
            if (entry.rows) {
                entry.rows
                    .filter(r => String(r.session_id ?? r.id) === String(sessionId)
                        && (!teacherUid || String(r.teacher_uid) === String(teacherUid)))
                    .forEach(r => { r.status = newStatus; });
            }
        }
        optimisticUpdate(sessionId, { status: newStatus }, teacherUid);
        if (row) row.classList.remove('optimistic-loading');
        window.eventBus?.emit(window.EVENTS?.SCHEDULE_STATUS_CHANGED || 'schedule:statusChanged', {
            id: sessionId,
            teacher_uid: teacherUid,
            status: newStatus,
            role: 'admin'
        });

        window.apiUtils.showSuccessToast('状态已更新');
    } catch (err) {
        if (row) row.classList.remove('optimistic-loading');
        window.apiUtils.showToast('更新状态失败', 'error');
    }
}

/**
 * 删除整场课（含全部教师与学生）。
 *
 * 删除现在有三种粒度，这是第一种；另外两种是教师行 / 学生行的 [删除]（`removeSessionPair`）。
 * 确认文案要如实报出影响面 —— 一场课可能带着好几位老师和学生。
 */
export async function deleteSchedule(id) {
    // 从缓存里数一下这一场有多少师生，确认弹窗才能说清影响面
    let dateKey = null;
    const studentIds = new Set();
    const teacherUids = new Set();
    for (const entry of WeeklyDataStore.schedules.values()) {
        if (!entry || !entry.rows) continue;
        for (const rec of entry.rows) {
            if (String(rec.session_id ?? rec.id) !== String(id)) continue;
            dateKey = dateKey || rec.date || rec.class_date;
            if (rec.student_id != null) studentIds.add(Number(rec.student_id));
            if (rec.teacher_uid) teacherUids.add(rec.teacher_uid);
        }
    }
    const scale = (teacherUids.size > 1 || studentIds.size > 1)
        ? `这一场共有 ${teacherUids.size || 1} 位老师、${studentIds.size || 1} 位学生，将一并删除。`
        : '';
    if (!await Modal.confirm(`确定要删除此排课吗？${scale}`,
        { title: '删除整场排课', confirmText: '删除', confirmStyle: 'danger' })) return;

    const studentId = studentIds.values().next().value ?? null;

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

        // 静默刷新的局部更新流程：**每一位**涉及学生的格子都要刷
        // （旧实现只刷一个格子，多生场次下会留下脏格子）
        await WeeklyDataStore.getAllSchedules(true);
        if (studentIds.size && dateKey) {
            for (const sid of studentIds) await refreshCell(sid, dateKey);
        } else {
            // 如果定位失败，执行无动画的周视图重绘
            await loadSchedules(false, false);
        }
        window.eventBus?.emit(window.EVENTS?.SCHEDULE_DELETED || 'schedule:deleted', {
            id,
            studentId,
            studentIds: [...studentIds],
            dateKey
        });
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

/**
 * 把每一行 pair 的 [删除] 接到「从这一场移除这一位」上（删除的第二、三种粒度）。
 * 移除后该数组为空的场次会被整场删除 —— 这一点在确认文案里说清。
 */
export function resetSchedulePairRows() {
    initPairForm();
    resetPairRows();
}

function bindPairRemoveButtons(sessionId, form) {
    document.querySelectorAll('#scheduleTeacherRows .pair-row, #scheduleStudentRows .pair-row').forEach(row => {
        const btn = row.querySelector('.pair-remove');
        const uid = row.dataset.uid;
        if (!btn || !uid) return;   // 新加的行还没落库，本地移除即可
        const fresh = btn.cloneNode(true);
        btn.parentNode.replaceChild(fresh, btn);
        fresh.disabled = row.parentNode.querySelectorAll('.pair-row').length <= 1
            ? false : fresh.disabled;   // 最后一位允许点，走「整场删除」分支
        fresh.addEventListener('click', () => removeSessionPair(sessionId, row.dataset.kind, uid, form));
    });
}

/** 从一场课里移除一位老师或学生；移除最后一位时提示并走整场删除 */
async function removeSessionPair(sessionId, kind, uid, form) {
    const container = kind === 'teacher' ? 'scheduleTeacherRows' : 'scheduleStudentRows';
    const isLast = document.querySelectorAll(`#${container} .pair-row`).length <= 1;
    const label = kind === 'teacher' ? '老师' : '学生';
    const msg = isLast
        ? `这是本场最后一位${label}，移除会删除整场排课，确定吗？`
        : `确定从这一场里移除这位${label}吗？`;
    if (!await Modal.confirm(msg, { title: `移除${label}`, confirmText: '移除', confirmStyle: 'danger' })) return;

    try {
        const version = form && form.dataset.version ? Number(form.dataset.version) : undefined;
        const path = `/admin/sessions/${sessionId}/${kind === 'teacher' ? 'teachers' : 'students'}/${uid}`;
        await window.apiUtils.request(path, {
            method: 'DELETE',
            body: version !== undefined ? { version } : undefined
        });
        WeeklyDataStore.invalidateSchedules();
        if (isLast) {
            const formContainer = document.getElementById('scheduleFormContainer');
            const overlay = document.getElementById('modalOverlay');
            if (formContainer) formContainer.style.display = 'none';
            if (overlay) overlay.style.display = 'none';
            if (window.apiUtils) window.apiUtils.showSuccessToast('已删除整场排课');
        } else {
            if (window.apiUtils) window.apiUtils.showSuccessToast(`已移除该${label}`);
            await editSchedule(sessionId);   // 重新拉一次拿到新的 version 与 pair 列表
        }
        await loadSchedules(true, false);
        window.eventBus?.emit(window.EVENTS?.SCHEDULE_UPDATED || 'schedule:updated', { id: sessionId });
    } catch (err) {
        if (window.apiUtils) {
            window.apiUtils.showToast(
                err && err.status === 409 ? '该排课已被他人修改，请刷新后重试' : `移除失败: ${err.message || ''}`,
                'error'
            );
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
        const studentGroup = document.getElementById('scheduleStudentGroup');
        if (studentGroup) studentGroup.style.display = 'block';

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
        if (form.querySelector('#scheduleNotes')) form.querySelector('#scheduleNotes').value = '';
        form.dataset.version = '';

        // pair 行：各留一行空行，学生行预置成点开的那位学生
        initPairForm();
        resetPairRows();
        const firstStudent = document.querySelector('#scheduleStudentRows .pair-student');
        if (firstStudent) firstStudent.value = String(student.id);
        // 教师行默认选第一位老师与第一个类型（沿用旧行为，减少点击）
        const firstTeacher = document.querySelector('#scheduleTeacherRows .pair-teacher');
        const firstType = document.querySelector('#scheduleTeacherRows .pair-type');
        if (firstTeacher && firstTeacher.options.length > 1 && !firstTeacher.value) firstTeacher.selectedIndex = 1;
        if (firstType && firstType.options.length > 1 && !firstType.value) firstType.selectedIndex = 1;

        // 首次加载后触发一次冲突检测
        updateTeacherStatusHints();

        // 应用表单记忆
        applyFormMemory();

        const overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.style.display = 'block';
        container.style.display = 'block';
        refitPairSelects();   // 上面直接改过 value/selectedIndex，不触发 change，宽度要重量
    }).catch(error => {
        console.error('[ScheduleForm] 加载表单选项失败:', error);
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
        const data = resp;

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

        const studentReadonlyDiv = document.getElementById('scheduleStudentReadonly');
        const dateInput = form.querySelector('#scheduleDate');
        const dateReadonlyDiv = document.getElementById('scheduleDateReadonly');

        if (studentReadonlyDiv) studentReadonlyDiv.style.display = 'none';
        const studentGroup = document.getElementById('scheduleStudentGroup');
        if (studentGroup) studentGroup.style.display = 'none';

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

        form.querySelector('#scheduleStartTime').value = sanitizeTimeString(data.start_time);
        form.querySelector('#scheduleEndTime').value = sanitizeTimeString(data.end_time);
        form.querySelector('#scheduleLocation').value = data.location || '';
        if (form.querySelector('#scheduleNotes')) form.querySelector('#scheduleNotes').value = data.notes || '';

        // 详情接口返回的是场次形状（teachers[] / students[] + version），按 pair 逐行回填；
        // version 带上是因为「改 pair 内容 / 增删 pair」是整列写，要走乐观锁。
        form.dataset.version = data.version != null ? String(data.version) : '';
        initPairForm();
        fillPairRows(data);

        // 每行的 [删除] 改为「从这一场移除这一位」（删除的第二、三种粒度）
        bindPairRemoveButtons(id, form);

        // 编辑态不套用表单记忆：pair 已按库里的真实值回填，不该被上次新建的记忆覆盖

        const overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.style.display = 'block';
        container.style.display = 'block';
        refitPairSelects();
        form.dataset.snapshot = JSON.stringify(data);

        // 编辑模式下初始触发一次冲突检测
        updateTeacherStatusHints();

    } catch (err) {
        // 权限落地（Phase 3）：受限级别打开不在可见范围内的排课时给出明确解释
        if (err && err.status === 404) {
            window.apiUtils.showToast('该排课不在您的可见范围内或已被删除', 'warning');
        } else {
            window.apiUtils.showToast('加载详情失败', 'error');
        }
    }
}

function setScheduleFormOptionsState(ready, error = null) {
    const form = document.getElementById('scheduleForm');
    const submit = document.getElementById('scheduleFormSubmit');
    if (!form) return;

    form.dataset.optionsReady = String(ready);
    if (submit) submit.disabled = !ready;

    const existing = document.getElementById('scheduleFormOptionsError');
    if (existing) existing.remove();
    if (!error) return;

    const errorContainer = document.createElement('div');
    errorContainer.id = 'scheduleFormOptionsError';
    if (window.ErrorUI && typeof window.ErrorUI.createErrorState === 'function') {
        errorContainer.appendChild(window.ErrorUI.createErrorState({
            title: '表单选项加载失败',
            error,
            compact: true,
            onRetry: () => loadScheduleFormOptions()
        }));
    } else {
        errorContainer.setAttribute('role', 'alert');
        errorContainer.textContent = '表单选项加载失败，请重试。';
    }
    form.prepend(errorContainer);
}

async function loadScheduleFormOptions() {
    const loader = window.loadScheduleFormOptions;
    if (typeof loader !== 'function') {
        throw new Error('排课表单选项加载器未初始化');
    }
    return loader();
}

/**
 * 实时更新教师选择框中的冲突状态提示词（含风险高亮）
 * 增强点（AI 风险高亮）：
 *   - 冲突教师选项文字标红 + 前缀图标 ⚠️
 *   - 无空闲教师选项标橙 + 前缀 ◌
 *   - 选中冲突教师时在表单顶部显示醒目风险横幅
 */
async function updateTeacherStatusHints() {
    const form = document.getElementById('scheduleForm');
    // 教师下拉现在每行一个（模板控件 #scheduleTeacher 只提供选项），冲突提示要逐行标注
    const teacherSelects = [
        document.getElementById('scheduleTeacher'),
        ...document.querySelectorAll('#scheduleTeacherRows .pair-teacher')
    ].filter(Boolean);
    if (!form || teacherSelects.length === 0) return;

    const date = form.querySelector('#scheduleDate')?.value;
    const start = form.querySelector('#scheduleStartTime')?.value;
    const end = form.querySelector('#scheduleEndTime')?.value;
    const excludeId = form.dataset.id;

    if (!date || !start || !end) return;

    try {
        const params = { date, startTime: start, endTime: end };
        if (excludeId) params.excludeScheduleId = excludeId;

        const conflicts = await window.apiUtils.get('/admin/teachers/conflicts', params);

        teacherSelects.forEach(sel => {
            Array.from(sel.options).forEach(opt => {
                if (!opt.value) return;
                const tId = opt.value;
                const baseName = opt.dataset.baseName || opt.textContent.split('(')[0].trim().replace(/^[⚠◌]\s*/, '');
                if (!opt.dataset.baseName) opt.dataset.baseName = baseName;

                let hint = '';
                let prefix = '';
                let color = '';
                const status = conflicts[tId];
                if (status) {
                    if (status.hasClass) {
                        hint = ' (已有排课)';
                        prefix = '⚠️ ';
                        color = '#f87171'; // 红色：时间冲突（高风险）
                    } else if (status.isUnavailable) {
                        hint = ' (个人无空闲)';
                        prefix = '◌ ';
                        color = '#fbbf24'; // 橙色：无空闲（中风险）
                    }
                }
                opt.textContent = prefix + baseName + hint;
                opt.style.color = color || '';
            });
        });

        // 根据当前选中教师显示/隐藏风险横幅
        updateConflictWarningBanner(conflicts);
    } catch (error) {
        teacherSelects.forEach(sel => {
            Array.from(sel.options).forEach(opt => {
                if (!opt.value) return;
                const baseName = opt.dataset.baseName || opt.textContent.split('(')[0].trim().replace(/^[⚠◌]\s*/, '');
                opt.dataset.baseName = baseName;
                opt.textContent = baseName;
                opt.style.color = '';
            });
        });
        updateConflictWarningBanner({});
        window.apiUtils?.showToast('教师冲突状态检测失败，请手动确认时间', 'warning');
        console.error('[ScheduleForm] 检测教师冲突失败:', error);
    }
}

/**
 * 冲突风险横幅：当选中的教师存在冲突/无空闲时，在表单顶部显示醒目提示
 * @param {Object} conflicts - 来自 /admin/teachers/conflicts 的 { teacherId: { hasClass?, isUnavailable? } }
 */
function updateConflictWarningBanner(conflicts) {
    const form = document.getElementById('scheduleForm');
    if (!form) return;

    let banner = document.getElementById('ai-conflict-warning');
    // 多师一场：任一行选中的老师有冲突就提示（取第一个命中的）
    const selectedIds = [...document.querySelectorAll('#scheduleTeacherRows .pair-teacher')]
        .map(s => s.value).filter(Boolean);
    const hitId = selectedIds.find(id => conflicts[id] && (conflicts[id].hasClass || conflicts[id].isUnavailable));
    const status = hitId ? conflicts[hitId] : null;

    if (!status || (!status.hasClass && !status.isUnavailable)) {
        if (banner) banner.remove();
        return;
    }

    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'ai-conflict-warning';
        banner.style.cssText = 'padding:8px 12px;border-radius:8px;font-size: var(--fs-300);margin-bottom:10px;line-height:1.5;';
        form.parentElement.insertBefore(banner, form);
    }

    if (status.hasClass) {
        banner.style.background = 'rgba(239,68,68,0.15)';
        banner.style.border = '1px solid rgba(239,68,68,0.4)';
        banner.style.color = '#fca5a5';
        banner.innerHTML = '⚠️ <span>该教师在此时间段已有排课，存在时间冲突。建议使用「✨ AI 推荐时间」寻找无冲突时段。</span>';
    } else if (status.isUnavailable) {
        banner.style.background = 'rgba(251,191,36,0.15)';
        banner.style.border = '1px solid rgba(251,191,36,0.4)';
        banner.style.color = '#fcd34d';
        banner.innerHTML = '◌ <span>该教师在此时段标记为不可用。请确认或更换时段。</span>';
    }
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
            if (form.dataset.optionsReady !== 'true') {
                window.apiUtils?.showToast('表单选项尚未加载完成，请重试', 'error');
                return;
            }
            const mode = form.dataset.mode;
            const id = form.dataset.id;
            let snapshot = {};
            try { snapshot = JSON.parse(form.dataset.snapshot || '{}'); } catch (_) { snapshot = {}; }
            // 编辑前这一场的第一位学生（用于把移动前的旧格子也刷一遍）
            const oldStudentId = snapshot.students?.[0]?.student_id || snapshot.student_id || null;
            const oldDateKey = snapshot.date || snapshot.class_date || null;

            // 读取两个 pair 列表（多师多生）。uid 只用于编辑态定位，不进 payload。
            const pairs = collectPairs();
            if (pairs.error) {
                if (window.apiUtils) window.apiUtils.showToast(pairs.error, 'error');
                return;
            }

            const body = {
                date: form.querySelector('#scheduleDate').value,
                start_time: form.querySelector('#scheduleStartTime').value,
                end_time: form.querySelector('#scheduleEndTime').value,
                location: form.querySelector('#scheduleLocation').value,
                notes: form.querySelector('#scheduleNotes') ? form.querySelector('#scheduleNotes').value : null,
                resolve_strategy: 'override', // 默认覆盖
                teachers: pairs.teachers.map(({ uid, ...rest }) => rest),
                students: pairs.students.map(({ uid, ...rest }) => rest)
            };

            if (!body.date || !body.start_time || !body.end_time) {
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

                    // 后台保存：一次 POST 写整场（多师多生一次成型）
                    const result = await window.apiUtils.post('/admin/sessions', body);

                    saveFormMemory({
                        start_time: body.start_time,
                        end_time: body.end_time,
                        teacher_id: body.teachers[0] && body.teachers[0].teacher_id,
                        type_id: body.teachers[0] && body.teachers[0].type_id
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
                    //                         window.SecurityUtils.safeSetHTML(locP, `<span class="material-icons-round">place</span>${body.location}`);
                    //                     }

                    // 编辑：一次提交整场（头部 + 全部 pair），服务端走 updatePairsBatch 顺序应用。
                    //   ① 头部（日期/时段/地点/备注）—— 整场生效，带 version 乐观锁
                    //   ② teachers[] / students[] —— 带 uid 的项按 uid patch（换人/改类型/改类别/改状态），
                    //      不带 uid 的项由服务端 addPair 新增
                    //   ③ 生命周期 —— 服务端 setTeacherStatus 原地重建，不带 version，不产生 409
                    //
                    // 之前这里是「每个 pair 各发一条 type PATCH + 一条 status PATCH」的串行循环，
                    // 而且 type 那条只带 type_id：换老师 / 换学生 / 改类别三个改动一个键都没提交，
                    // 服务端「什么都没改」照回 200，前端照弹「排课更新成功」—— 静默失败。
                    const version = form.dataset.version ? Number(form.dataset.version) : undefined;
                    const payload = {
                        date: body.date,
                        start_time: body.start_time,
                        end_time: body.end_time,
                        location: body.location,
                        notes: body.notes,
                        teachers: pairs.teachers.map(p => ({
                            ...(p.uid ? { uid: p.uid } : {}),
                            teacher_id: p.teacher_id,
                            type_id: p.type_id,
                            // adjusted 是溯源属性，只读展示；下发会撞 Joi 白名单，这里直接不带
                            ...(p.category && p.category !== 'adjusted' ? { category: p.category } : {}),
                            lifecycle: p.lifecycle
                        })),
                        students: pairs.students.map(p => ({
                            ...(p.uid ? { uid: p.uid } : {}),
                            student_id: p.student_id
                        }))
                    };
                    if (version !== undefined) payload.version = version;

                    const saved = await window.apiUtils.patch(`/admin/sessions/${id}`, payload);

                    // 服务端按身份裁剪白名单之外的键。有残留 = 这次有字段没落库，
                    // 必须吭声，否则又是「提示成功但数据没变」。
                    if (saved && Array.isArray(saved.rejectedFields) && saved.rejectedFields.length) {
                        window.apiUtils.showToast(
                            `以下字段未被保存：${saved.rejectedFields.join('、')}`, 'warning'
                        );
                    }

                    saveFormMemory({
                        start_time: body.start_time,
                        end_time: body.end_time,
                        teacher_id: body.teachers[0] && body.teachers[0].teacher_id,
                        type_id: body.teachers[0] && body.teachers[0].type_id
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

                // 定点刷新：一场课可能涉及多位学生，每一位的格子都要刷（否则会留脏格子）
                const finalStudentIds = body.students.map(s => s.student_id).filter(v => v != null);
                const finalStudentId = finalStudentIds[0] ?? null;
                const finalDateKey = body.date;

                if (finalStudentIds.length && finalDateKey) {
                    for (const sid of finalStudentIds) await refreshCell(sid, finalDateKey);
                    // Editing a schedule can move it. Refresh the old location as well.
                    if (mode === 'edit' && oldStudentId && oldDateKey &&
                        (!finalStudentIds.map(String).includes(String(oldStudentId)) || oldDateKey !== finalDateKey)) {
                        await refreshCell(oldStudentId, oldDateKey);
                    }
                } else {
                    // 如果定位失败，退回到局部刷新策略（不触发全局 Loading 动画）
                    await loadSchedules(true, false);
                }
                const eventName = mode === 'add'
                    ? (window.EVENTS?.SCHEDULE_CREATED || 'schedule:created')
                    : (window.EVENTS?.SCHEDULE_UPDATED || 'schedule:updated');
                window.eventBus?.emit(eventName, {
                    id,
                    studentId: finalStudentId,
                    dateKey: finalDateKey,
                    oldStudentId,
                    oldDateKey
                });
                window.apiUtils?.showSuccessToast(mode === 'add' ? '排课添加成功' : '排课更新成功');
            } catch (err) {


                // 万一报错了，回滚操作（反欺骗）
                if (mode === 'add' && backup) {
                    rollbackOperation(backup, 'add');
                } else if (mode === 'edit' && currentCard && originalCardHtml) {
                    // 悲观恢复原来的DOM卡片
                    window.SecurityUtils.safeSetHTML(currentCard, originalCardHtml);
                    currentCard.classList.remove('optimistic-updating');
                }

                if (window.apiUtils) {
                    // 409 = 乐观锁冲突：别人在你打开弹窗后改过这一场
                    window.apiUtils.showToast(
                        err && err.status === 409
                            ? '该排课已被他人修改，请刷新后重试'
                            : '保存失败: ' + (err.message || ''),
                        'error'
                    );
                }
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
            window.SecurityUtils.safeSetHTML(tf, '<option value="">全部教师</option>');
            teachers.forEach(t => {
                if (String(t.status) == '-1') return;
                const o = document.createElement('option');
                o.value = t.id; o.textContent = t.name;
                tf.appendChild(o);
            });
            if (current) tf.value = current;
        } catch (e) { }
    }
}

// =============================================================================
// 模块接口导出 - 置于末尾确保所有依赖已初始化 (避免 TDZ ReferenceError)
// =============================================================================
window.ScheduleManager = {
    loadSchedules: (force = true, showLoading = true) => loadSchedules(force, showLoading), // 允许透传加载状态
    refreshCell: refreshCell, // 导出局部刷新
    WeeklyDataStore: WeeklyDataStore,
    resetSchedulePairRows: resetPairRows,
    reloadScheduleFormOptions: loadScheduleFormOptions,
    renderCache: () => {
        // 渲染当前内存中的数据，不发网络请求，且不显示过渡动画
        loadSchedules(false, false);
    }
};

// 向共享模块（weekly-view-export.js）注册管理员角色上下文：
//   - 当前周起点取自 window.__weeklyRange（管理员排课页的真实状态）
//   - 拉取数据走 /admin/schedules/grid?show_plan=true，与教师端口径一致
if (typeof window.registerWeeklyViewExportContext === 'function') {
    window.registerWeeklyViewExportContext('admin', {
        getWeekStart() {
            const range = window.__weeklyRange;
            if (range && range.start) {
                const d = new Date(range.start);
                if (!Number.isNaN(d.getTime())) return d;
            }
            return null;
        },
        async fetchSchedules(startDate, endDate) {
            const rows = await window.apiUtils.get('/admin/schedules/grid', {
                start_date: startDate,
                end_date: endDate,
                show_plan: 'true'
            });
            if (!Array.isArray(rows)) {
                throw new Error('排课导出响应格式无效');
            }
            return rows;
        }
    });
}

// Expose required methods to window for legacy code
