// 工具函数
const token = localStorage.getItem('token');
const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
};
// TIME_ZONE 常量定义
const TIME_ZONE = 'Asia/Shanghai';

// 统计模块初始化标志
let statisticsInitialized = false;

// 日期格式化函数
function toISODate(date) {
    if (!date) return '';
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// --- Administrator Fee Visibility State ---
// 此部分已移动到 schedule-manager.js，此处移除以避免函数定义冲突
// 保持 legacy-adapter.js 专注于旧代码的桥接与适配



// 检查 Chart.js 是否可用
function isChartAvailable() {
    if (typeof window.Chart === 'undefined') {
        // 如果实在没找到，尝试探测是否有局部的 Chart 进行后备挂载
        if (typeof Chart !== 'undefined') {
            window.Chart = Chart;
            return true;
        }
        return false;
    }
    return true;
}

// 安全解析 Response JSON（兼容空响应或非 JSON 内容）
async function safeJson(resp) {
    try {
        const text = await resp.text();
        if (!text || text.trim() === '') return null;
        return JSON.parse(text);
    } catch (e) {
        return null;
    }
}

// 使用新的API工具类
// 检查API工具类是否已加载
if (typeof window.apiUtils === 'undefined') {
}

// 通用重试工具与操作日志
async function withRetry(fn, retries = 2, delayMs = 800) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn(attempt, attempt === retries);
        } catch (err) {
            lastErr = err;
            // 业务类错误无需重试，直接抛出（如验证失败/冲突/资源不存在）
            const status = err && err.status;
            if (status === 400 || status === 409 || status === 404) {
                break;
            }
            if (attempt < retries) {
                await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
            } else {
                break;
            }
        }
    }
    throw lastErr;
}

function logOperation(action, status, details = {}) {
    try {
        window.__opLogs = window.__opLogs || [];
        window.__opLogs.push({ ts: new Date().toISOString(), action, status, details });

    } catch (_) { }
}

// 前端排课类型数据存储与管理（内存 + 本地缓存）
// 已迁移至 public/js/schedule-types-store.js，避免此处覆盖全局对象
/*
const ScheduleTypesStore = {
    list: [],
    map: new Map(),
    loadedAt: null,
    cacheKey: 'schedule_types_cache_v1',
    load(types) {
        if (!Array.isArray(types)) return;
        this.list = types.slice();
        this.map = new Map(types.map(t => [Number(t.id), t]));
        this.loadedAt = Date.now();
        try {
            const payload = { list: this.list, loadedAt: this.loadedAt };
            localStorage.setItem(this.cacheKey, JSON.stringify(payload));
        } catch (_) { }
    },
    fromCache() {
        try {
            const txt = localStorage.getItem(this.cacheKey);
            if (!txt) return false;
            const obj = JSON.parse(txt);
            if (!obj || !Array.isArray(obj.list)) return false;
            this.list = obj.list;
            this.map = new Map(this.list.map(t => [Number(t.id), t]));
            this.loadedAt = obj.loadedAt || Date.now();
            return true;
        } catch (e) {
            return false;
        }
    },
    getAll() { return this.list.slice(); },
    getById(id) { return this.map.get(Number(id)); },
    clear() { this.list = []; this.map.clear(); this.loadedAt = null; }
};
// 暴露到全局，供统计插件映射 ID -> 名称
window.ScheduleTypesStore = ScheduleTypesStore;
*/

// 周视图数据缓存（学生与排课，含TTL）
// 委托给 schedule-manager.js 中的实现
// 仅在 WeeklyDataStore 尚不存在时才定义存根（兼容性回退）
// 如果 schedule-manager.js 已经正确加载，则使用其真正的实现
if (!window.WeeklyDataStore) {
    window.WeeklyDataStore = {
        students: { list: [] },
        teachers: { list: [] },
        schedules: new Map(),
        getStudents: () => Promise.resolve([]),
        getTeachers: () => Promise.resolve([]),
        getSchedules: () => Promise.resolve([]),
        invalidateSchedules: () => { }
    };
}

// ⚠️ 重要：不要使用局部常量，因为它会捕获初始值（存根）
// 即使后来 window.WeeklyDataStore 被 schedule-manager.js 替换，局部常量仍指向旧的存根
// 解决方案：总是通过 window.WeeklyDataStore 访问，确保使用最新的实现

// 检查登录状态和时间格式化的函数已经迁移至 public/js/utils/auth.js 和 public/js/utils/format.js
// 根据选项内容动态设置下拉框最小宽度，确保完整显示
function adjustSelectMinWidth(selectEl) {
    if (!selectEl || !selectEl.options || selectEl.options.length === 0) return;
    const style = getComputedStyle(selectEl);
    const probe = document.createElement('span');
    probe.style.visibility = 'hidden';
    probe.style.position = 'absolute';
    probe.style.whiteSpace = 'nowrap';
    probe.style.fontSize = style.fontSize;
    probe.style.fontFamily = style.fontFamily;
    document.body.appendChild(probe);
    let max = 0;
    Array.from(selectEl.options).forEach(opt => {
        probe.textContent = opt.text;
        const w = probe.offsetWidth + 20; // 预留箭头与内边距空间（缩短）
        if (w > max) max = w;
    });
    probe.remove();
    if (max > 0) {
        const clamped = Math.max(80, Math.min(180, Math.ceil(max)));
        selectEl.style.width = 'auto';
        selectEl.style.minWidth = clamped + 'px';
        selectEl.style.maxWidth = '180px';
        // 高度与滚动处理
        selectEl.style.height = 'auto';
        selectEl.style.minHeight = '30px';
        selectEl.style.maxHeight = '200px';
        selectEl.style.overflow = 'auto';
    }
}

// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', () => {
    if (window.__TEST_MODE__) return; // 测试模式下跳过页面初始化
    if (window.authUtils && window.authUtils.checkAuth) window.authUtils.checkAuth();
    else if (window.checkAuth) window.checkAuth();
    // setupSidebarToggle(); // 已由 index.js -> ui-helper.js 处理，此处移除以免重复绑定
    if (window.UILayout && window.UILayout.setupNavigation) window.UILayout.setupNavigation();
    else if (window.setupNavigation) window.setupNavigation();
    if (window.i18nUtils && typeof window.i18nUtils.applyChartFont === 'function') {
        window.i18nUtils.applyChartFont();
    }
    if (window.Overview && window.Overview.loadOverviewStats) window.Overview.loadOverviewStats();
    else if (window.loadOverviewStats) window.loadOverviewStats();
    loadTodaySchedules();
    setupEventListeners();
    setupScheduleTypeListeners();
    // 调整排课筛选下拉框最小宽度，确保选项文字完整显示
    adjustSelectMinWidth(document.getElementById('statusFilter'));
    adjustSelectMinWidth(document.getElementById('typeFilter'));
    adjustSelectMinWidth(document.getElementById('teacherFilter'));
    // 响应式：窗口尺寸变化时重新计算
    window.addEventListener('resize', () => {
        adjustSelectMinWidth(document.getElementById('statusFilter'));
        adjustSelectMinWidth(document.getElementById('typeFilter'));
        adjustSelectMinWidth(document.getElementById('teacherFilter'));
    });
    // 初始化课程类型存储
    if (window.ScheduleTypesStore) {
        window.ScheduleTypesStore.init().then(() => {
            // 初始化完成后，填充筛选下拉框 (如果当前在排课页面)
            populateScheduleTypeFilter();
        });
    }


    // 动态填充排课类型筛选框
    function populateScheduleTypeFilter() {
        const filterSelect = document.getElementById('typeFilter');
        if (!filterSelect || !window.ScheduleTypesStore) return;

        const types = window.ScheduleTypesStore.getAll();
        const currentVal = filterSelect.value;

        // 清空现有选项（保留第一个"全部类型"）
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(filterSelect, '<option value="">全部类型</option>'); } else { filterSelect.innerHTML = '<option value="">全部类型</option>'; }

        types.forEach(t => {
            const opt = document.createElement('option');
            // value使用ID而不是name，后端查询 course_id
            opt.value = t.id;
            opt.textContent = t.description || t.name;
            filterSelect.appendChild(opt);
        });

        if (currentVal) filterSelect.value = currentVal;

        // 调整宽度
        adjustSelectMinWidth(filterSelect);
    }

    // 定时刷新总览统计，确保数据实时更新
    setInterval(() => {
        // 仅在总览 section 可见时刷新，避免干扰其他页面操作
        const overviewSection = document.getElementById('overview');
        if (overviewSection && overviewSection.classList.contains('active')) {
            loadOverviewStats();
            // loadTodaySchedules(); // 禁用今日排课自动刷新
        }
    }, 15000);
});
// 用户列表字段映射（用于动态渲染表头与数据列，隐藏 ID）
const USER_FIELDS = {
    admin: ['username', 'name', 'email', 'permission_level', 'created_at'],
    teacher: ['username', 'name', 'profession', 'contact', 'work_location', 'home_address', 'restriction', 'status', 'created_at'],
    student: ['username', 'name', 'profession', 'contact', 'visit_location', 'home_address', 'status', 'created_at']
};

const FIELD_LABELS = {
    username: '用户名',
    name: '姓名',
    email: '邮箱',
    permission_level: '权限级别',
    created_at: '注册时间',
    profession: '职业类型',
    contact: '联系方式',
    work_location: '工作地点',
    home_address: '家庭地址',
    visit_location: '入户地点',
    visit_location: '入户地点',
    restriction: '限制',
    status: '状态'
};

// 用户状态标签与样式映射
function getUserStatusLabel(s) {
    const v = Number(s);
    if (v === 1) return '正常';
    if (v === 0) return '暂停';
    if (v === -1) return '删除';
    return String(s ?? '');
}
function getUserStatusClass(s) {
    const v = Number(s);
    if (v === 1) return 'user-status-active';
    if (v === 0) return 'user-status-paused';
    if (v === -1) return 'user-status-deleted';
    return '';
}

// setupNavigation, showSection, setHeaderTitle have been moved to ui-layout.js

// 加载总览统计数据
// loadOverviewStats and setupAdminOverviewCardClicks have been moved to overview.js


// 设置事件监听器
// 设置事件监听器
function setupEventListeners() {
    // 用户管理部分的监听器已迁移至 user-manager.js，此处移除以避免双重绑定导致性能问题和逻辑错误

    // 保留其他非用户管理的监听器（如果有）
}

// 排课筛选（移除顶部日期切周，保留类型与状态）
const typeFilter = document.getElementById('typeFilter');
const statusFilter = document.getElementById('statusFilter');
const teacherFilter = document.getElementById('teacherFilter');
if (typeFilter) typeFilter.addEventListener('change', loadSchedules);
if (statusFilter) statusFilter.addEventListener('change', loadSchedules);
if (teacherFilter) teacherFilter.addEventListener('change', loadSchedules);
// 加载类型筛选选项
loadScheduleFilterOptions();

// 周范围日期控件：初始化为当前周，并支持鼠标调整
const startInput = document.getElementById('startDate');
const endInput = document.getElementById('endDate');
if (startInput && endInput) {
    const today = new Date();
    const week = getWeekDates(today);
    startInput.value = toISODate(week[0]);
    endInput.value = toISODate(week[week.length - 1]);
    updateWeeklyRangeText(week[0], week[week.length - 1]);
    startInput.addEventListener('change', loadSchedules);
    endInput.addEventListener('change', loadSchedules);
    // 初始化后加载一次周视图
    loadSchedules();
} else {
    // 无日期输入控件时，使用内存存储的周范围并初始化
    const today = new Date();
    const week = getWeekDates(today);
    window.__weeklyRange = { start: toISODate(week[0]), end: toISODate(week[week.length - 1]) };
    updateWeeklyRangeText(week[0], week[week.length - 1]);
    loadSchedules();
}
// 增加上一周/下一周按钮交互
// [FIX] 移除重复监听器：已在 schedule-manager.js 中统一处理
/*
const prevBtn = document.getElementById('prevWeek');
const nextBtn = document.getElementById('nextWeek');
if (prevBtn && nextBtn) {
    // ... duplicate logic removed ...
}
*/
// 排课管理 - 新建排课按钮
// 排课管理 - 新建排课按钮 (Event Delegation for robustness)
document.addEventListener('click', (e) => {
    const btn = e.target.closest('#addScheduleBtn');
    if (btn) {
        // Ensure function exists
        if (typeof showAddScheduleModal === 'function') {
            showAddScheduleModal();
        } else {
        }
    }
});

// 排课管理 - 表单提交
// 排课管理 - 表单提交
// [FIX] 移除重复监听器：表单提交已在 schedule-manager.js 中统一处理
// 原有的 scheduleForm.addEventListener('submit', ...) 逻辑已删除，以避免重复创建排课记录。
/*
const scheduleForm = document.getElementById('scheduleForm');
if (scheduleForm) {
    scheduleForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const teacherId = scheduleForm.querySelector('#scheduleTeacher').value;
            const studentId = scheduleForm.querySelector('#scheduleStudent').value;
            let date = scheduleForm.querySelector('#scheduleDate').value;
            // 统一清洗时间为 HH:MM，避免 HH:MM:SS 导致校验失败
            const startTimeInputEl = scheduleForm.querySelector('#scheduleStartTime');
            const endTimeInputEl = scheduleForm.querySelector('#scheduleEndTime');
            const startTimeRaw = startTimeInputEl ? startTimeInputEl.value : '';
            const endTimeRaw = endTimeInputEl ? endTimeInputEl.value : '';
            const startTime = sanitizeTimeString(startTimeRaw) || startTimeRaw;
            const endTime = sanitizeTimeString(endTimeRaw) || endTimeRaw;
            // 写回清洗后的值，保证UI显示与提交一致
            if (startTimeInputEl) startTimeInputEl.value = startTime;
            if (endTimeInputEl) endTimeInputEl.value = endTime;
            const timeSlotEl = scheduleForm.querySelector('#scheduleTimeSlot');
            // 编辑态：当隐藏/禁用的日期控件未能承载值时，使用只读展示或原始值回退，并规范化为YYYY-MM-DD
            let effectiveDate = date;
            if (!effectiveDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate))) {
                const readonlyDiv = scheduleForm.querySelector('#scheduleDateReadonly');
                const candidateText = readonlyDiv ? String(readonlyDiv.textContent || '').trim() : '';

                const originalDate = (scheduleForm.__originalData && scheduleForm.__originalData.date) ? String(scheduleForm.__originalData.date).trim() : '';
                let candidate = candidateText || originalDate || '';
                if (candidate) {
                    try {
                        effectiveDate = /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : toISODate(new Date(candidate));
                    } catch (e) {
                        effectiveDate = candidate.slice(0, 10);
                    }
                    const dateEl = scheduleForm.querySelector('#scheduleDate');
                    if (dateEl) dateEl.value = effectiveDate;
                }
            }
            // 基础必填与格式校验
            try {
                if (window.apiUtils && window.apiUtils.validate) {
                    window.apiUtils.validate.required(teacherId, '授课教师');
                    window.apiUtils.validate.required(studentId, '学生');
                    window.apiUtils.validate.required(effectiveDate, '日期');
                    window.apiUtils.validate.required(startTime, '开始时间');
                    window.apiUtils.validate.required(endTime, '结束时间');
                    window.apiUtils.validate.date(effectiveDate, '日期');
                    window.apiUtils.validate.time(startTime, '开始时间');
                    window.apiUtils.validate.time(endTime, '结束时间');
                }
            } catch (ve) {
                if (window.apiUtils && typeof window.apiUtils.handleError === 'function') {
                    window.apiUtils.handleError(new window.ApiError(ve.message, 400, [{ field: 'form', message: ve.message }], '/admin/schedules'));
                } else {
                    alert(ve.message);
                }
                return;
            }

            // 时间先后关系校验
            const toMinutes = (t) => {
                const m = /^([0-2]?\d):([0-5]\d)$/.exec(String(t || ''));
                if (!m) return NaN;
                return Number(m[1]) * 60 + Number(m[2]);
            };
            const sMin = toMinutes(startTime);
            const eMin = toMinutes(endTime);
            if (isNaN(sMin) || isNaN(eMin) || eMin <= sMin) {
                if (window.apiUtils && typeof window.apiUtils.showToast === 'function') {
                    window.apiUtils.showToast('结束时间必须晚于开始时间', 'error');
                } else {
                    alert('结束时间必须晚于开始时间');
                }
                return;
            }
            // 自动推断时段：优先使用选择的值，否则按开始时间计算
            let timeSlot = (timeSlotEl && timeSlotEl.value) ? timeSlotEl.value : null;
            if (!timeSlot) {
                const [sh, sm] = (startTime || '').split(':').map(n => parseInt(n, 10));
                const minutes = (isNaN(sh) ? 0 : sh) * 60 + (isNaN(sm) ? 0 : sm);
                if (minutes < 12 * 60) timeSlot = 'morning';
                else if (minutes < 18 * 60) timeSlot = 'afternoon';
                else timeSlot = 'evening';
            }
            // 类型选择（单选或多选）
            const typeSel = scheduleForm.querySelector('#scheduleTypeSelect');
            let scheduleTypes = [];
            if (typeSel) {
                if (typeSel.multiple) {
                    scheduleTypes = Array.from(typeSel.selectedOptions).map(o => Number(o.value)).filter(Boolean);
                } else {
                    const val = Number(typeSel.value);
                    if (val) scheduleTypes = [val];
                }
            }
            // 兜底：如果未选择类型，优先精确默认“入户”，否则回退为 1（排除“半次入户”）
            if (scheduleTypes.length === 0) {
                const typesAll = ScheduleTypesStore.getAll();
                let defaultType = typesAll.find(t => {
                    const name = String(t.name || '').trim();
                    const desc = String(t.description || '').trim();
                    return desc === '入户' || name === '入户' || name === 'visit';
                });
                if (!defaultType) {
                    defaultType = typesAll.find(t => {
                        const name = String(t.name || '').trim();
                        const desc = String(t.description || '').trim();
                        return (name.includes('入户') || desc.includes('入户')) && !(name.includes('半次') || desc.includes('半次'));
                    });
                }
                if (defaultType) {
                    scheduleTypes = [Number(defaultType.id)];
                } else {
                    scheduleTypes = [1];
                }
            }
            // 地点：校验并传递
            const locationInput = scheduleForm.querySelector('#scheduleLocation');
            const location = locationInput && locationInput.value ? locationInput.value.trim() : '';
            // 家庭参加人员
            const familyParticipantsSelect = scheduleForm.querySelector('#scheduleFamilyParticipants');
            const familyParticipants = familyParticipantsSelect ? Number(familyParticipantsSelect.value) : 4;

            const mode = scheduleForm.getAttribute('data-mode') || 'add';
            const currentId = scheduleForm.getAttribute('data-id') || '';
            // 校验入户地点
            const locOk = location.length > 0 && location.length <= 100 && /^[\u4e00-\u9fa5A-Za-z0-9\s\-，,]+$/.test(location);
            if (!locOk) {
                if (window.apiUtils && typeof window.apiUtils.showToast === 'function') {
                    window.apiUtils.showToast('入户地点不合法：请填写1-100字符，允许中文、字母、数字、空格、连字符', 'error');
                } else {
                    alert('入户地点不合法：请填写1-100字符，允许中文、字母、数字、空格、连字符');
                }
                return;
            }

            // 防重复提交
            const submitBtn = document.getElementById('scheduleFormSubmit');
            if (submitBtn) submitBtn.disabled = true;

            if (mode === 'edit' && currentId) {
                // 老师时间/地点冲突不再提示且不阻断提交
                // 编辑模式不修改学生信息，仅更新教师/类型/时间/地点
                const statusSel = scheduleForm.querySelector('#scheduleStatus');
                const rawStatus = statusSel ? String(statusSel.value || '').trim() : '';
                const allowedStatuses = new Set(['pending', 'confirmed', 'cancelled', 'completed']);
                const updatePayload = {
                    teacher_id: Number(teacherId) || undefined,
                    start_time: startTime,
                    end_time: endTime,
                    type_ids: scheduleTypes,
                    location,
                    family_participants: familyParticipants
                };
                // 仅当日期发生变化时才提交日期，避免后端不必要的日期校验
                try {
                    const originalDate = (scheduleForm.__originalData && scheduleForm.__originalData.date) ? String(scheduleForm.__originalData.date) : '';
                    if (String(effectiveDate || '') !== String(originalDate || '')) {
                        updatePayload.date = effectiveDate;
                    }
                } catch (_) {
                    // 若无法确定原始日期，则按原逻辑提交
                    updatePayload.date = effectiveDate;
                }
                if (allowedStatuses.has(rawStatus)) {
                    updatePayload.status = rawStatus;
                }
                try {
                    await window.apiUtils.put(`/admin/schedules/${currentId}`, updatePayload);
                    if (window.apiUtils && typeof window.apiUtils.showSuccessToast === 'function') {
                        window.apiUtils.showSuccessToast('排课已更新');
                    }
                    // 立即关闭窗口，提升响应速度
                    const container = document.getElementById('scheduleFormContainer');
                    if (container) container.style.display = 'none';

                    // 非阻塞刷新列表和差异检测
                    (async () => {
                        try {
                            if (window.WeeklyDataStore && WeeklyDataStore.schedules) WeeklyDataStore.schedules.clear();
                            loadSchedules();
                        } catch (_) { }
                    })();
                } catch (err) {
                    if (window.apiUtils && typeof window.apiUtils.handleError === 'function') {
                        window.apiUtils.handleError(err);
                    } else {
                        
                        alert('更新排课失败');
                    }
                } finally {
                    const submitBtn = document.getElementById('scheduleFormSubmit');
                    if (submitBtn) submitBtn.disabled = false;
                }
            } else {
                const payload = {
                    teacherId,
                    studentIds: [studentId].filter(Boolean),
                    date: effectiveDate,
                    timeSlot,
                    startTime,
                    endTime,
                    scheduleTypes,
                    location,
                    family_participants: familyParticipants
                };
                // 老师时间/地点冲突不再提示且不阻断提交
                // 创建模式支持选择状态
                const statusSel = scheduleForm.querySelector('#scheduleStatus');
                const rawStatus = statusSel ? String(statusSel.value || '').trim() : '';
                const allowedCreateStatuses = new Set(['pending', 'confirmed', 'cancelled', 'completed']);
                if (allowedCreateStatuses.has(rawStatus)) {
                    payload.status = rawStatus;
                }

                // 直接创建排课
                let result = null;
                result = await window.apiUtils.post('/admin/schedules', payload);
                const newId = result && result.id ? result.id : null;
                // 创建后确认并检测差异
                try {
                    if (newId) {
                        const confirmItem = await withRetry(() => window.apiUtils.get(`/admin/schedules/${newId}`));
                        const item = (confirmItem && confirmItem.data) ? confirmItem.data : confirmItem;
                        let mismatch = false;
                        mismatch = mismatch || (Number(item.teacher_id) !== Number(payload.teacherId));
                        const expStu = Array.isArray(payload.studentIds) ? Number(payload.studentIds[0]) : Number(payload.studentIds);
                        if (!Number.isNaN(expStu)) mismatch = mismatch || (Number(item.student_id) !== Number(expStu));
                        const idate = String(item.date || '').slice(0, 10);
                        mismatch = mismatch || (String(idate) !== String(payload.date));
                        mismatch = mismatch || (String(item.start_time || '') !== String(payload.startTime || ''));
                        mismatch = mismatch || (String(item.end_time || '') !== String(payload.endTime || ''));
                        const expType = Array.isArray(payload.scheduleTypes) ? Number(payload.scheduleTypes[0]) : Number(payload.scheduleTypes);
                        if (!Number.isNaN(expType)) mismatch = mismatch || (Number(item.course_id) !== Number(expType));
                        if (typeof payload.location !== 'undefined') {
                            mismatch = mismatch || (String(item.location || '') !== String(payload.location || ''));
                        }
                        if (typeof payload.status !== 'undefined') {
                            mismatch = mismatch || (String(item.status || '') !== String(payload.status || ''));
                        }
                        if (mismatch && window.apiUtils) {
                            window.apiUtils.showToast('检测到后端存在差异，已刷新最新数据', 'warning');
                        }
                    }
                } catch (confirmErr) {
                    
                }
                // 若用户选择“已确认”，且后端未按选择设置，可进行二次确认；否则不自动确认
                if (newId && rawStatus === 'confirmed') {
                    try {
                        await window.apiUtils.post(`/admin/schedules/${newId}/confirm`, { adminConfirmed: true });
                        if (window.apiUtils && typeof window.apiUtils.showSuccessToast === 'function') {
                            window.apiUtils.showSuccessToast('排课已创建并确认');
                        }
                    } catch (confirmErr) {
                        
                        if (window.apiUtils && typeof window.apiUtils.showToast === 'function') {
                            window.apiUtils.showToast('排课已创建，但自动确认失败', 'error');
                        }
                    }
                }
            }
            document.getElementById('scheduleFormContainer').style.display = 'none';
            try { if (window.WeeklyDataStore && WeeklyDataStore.schedules) WeeklyDataStore.schedules.clear(); } catch (_) { }
            loadSchedules();
        } catch (err) {
            
            if (window.apiUtils && typeof window.apiUtils.handleError === 'function') {
                window.apiUtils.handleError(err);
            } else {
                alert('创建排课失败，请稍后重试');
            }
        } finally {
            const submitBtn = document.getElementById('scheduleFormSubmit');
            if (submitBtn) submitBtn.disabled = false;
        }
    });
}
*/
// 已在顶部绑定筛选事件

// 统计日期范围
const statsSearchBtn = document.getElementById('statisticsSearchBtn');
if (statsSearchBtn) {
    // 添加防重复点击和加载状态
    let isStatsLoading = false;
    statsSearchBtn.addEventListener('click', async function () {
        if (isStatsLoading) return;

        // 设置按钮为加载状态
        isStatsLoading = true;
        const btnText = statsSearchBtn.querySelector('.btn-text');
        const btnLoading = statsSearchBtn.querySelector('.btn-loading');

        if (btnText) btnText.style.display = 'none';
        if (btnLoading) btnLoading.style.display = 'inline';
        statsSearchBtn.disabled = true;

        try {
            await loadStatistics();
        } finally {
            // 恢复按钮状态
            isStatsLoading = false;
            if (btnText) btnText.style.display = 'inline';
            if (btnLoading) btnLoading.style.display = 'none';
            statsSearchBtn.disabled = false;
        }
    });
}

// 统计模块初始化移至首次访问时（showSection('statistics')）
// 避免在DOM未完全准备好时绑定事件

// 添加导出按钮事件处理程序
// 已删除：快速导出功能的初始化调用


// 初始化统计日期控件（默认当前月份）
function initializeStatisticsControls() {
    const statsStart = document.getElementById('statsStartDate');
    const statsEnd = document.getElementById('statsEndDate');
    if (!statsStart || !statsEnd) return;

    // 默认上个月 (User Request)
    const now = new Date();
    // Get first day of last month
    const firstDay = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    // Get last day of last month
    const lastDay = new Date(now.getFullYear(), now.getMonth(), 0);

    const sDate = toISODate(firstDay);
    const eDate = toISODate(lastDay);

    statsStart.value = sDate;
    statsEnd.value = eDate;

    // 教师/学生周期控件如果存在且为空则也默认设置为上个月
    const tStart = document.getElementById('teacherStartDate');
    const tEnd = document.getElementById('teacherEndDate');
    if (tStart && tEnd) {
        if (!tStart.value) tStart.value = sDate;
        if (!tEnd.value) tEnd.value = eDate;
    }

    const sStart = document.getElementById('studentStartDate');
    const sEnd = document.getElementById('studentEndDate');
    if (sStart && sEnd) {
        if (!sStart.value) sStart.value = sDate;
        if (!sEnd.value) sEnd.value = eDate;
    }

    // --- Date Synchronization Logic ---
    const dateGroups = [
        { prefix: 'stats', start: 'statsStartDate', end: 'statsEndDate' },
        { prefix: 'teacher', start: 'teacherStartDate', end: 'teacherEndDate' },
        { prefix: 'student', start: 'studentStartDate', end: 'studentEndDate' }
    ];

    let isGlobalSyncing = false;
    function syncDateInputs(sourcePrefix, triggerQuery = true) {
        if (isGlobalSyncing) return;
        isGlobalSyncing = true;

        try {
            const startId = sourcePrefix === 'stats' ? 'statsStartDate' : `${sourcePrefix}StartDate`;
            const endId = sourcePrefix === 'stats' ? 'statsEndDate' : `${sourcePrefix}EndDate`;

            const sVal = document.getElementById(startId).value;
            const eVal = document.getElementById(endId).value;

            dateGroups.forEach(group => {
                if (group.prefix !== sourcePrefix) {
                    const sEl = document.getElementById(group.start);
                    const eEl = document.getElementById(group.end);
                    if (sEl) sEl.value = sVal;
                    if (eEl) eEl.value = eVal;
                }

                // 同步当前组的高亮状态
                const containerSelector = `.preset-buttons[data-target="${group.prefix}"]`;
                const container = document.querySelector(containerSelector);
                if (container && window.DateRangeUtils && window.DateRangeUtils.syncPresetButtons) {
                    window.DateRangeUtils.syncPresetButtons(sVal, eVal, container);
                }

                // 如果需要触发查询且不是源端，则点击对应的查询按钮
                if (triggerQuery && group.prefix !== sourcePrefix) {
                    let searchBtnId = '';
                    if (group.prefix === 'stats') searchBtnId = 'statisticsSearchBtn';
                    else if (group.prefix === 'teacher') searchBtnId = 'teacherStatsSearchBtn';
                    else if (group.prefix === 'student') searchBtnId = 'studentStatsSearchBtn';

                    const btn = document.getElementById(searchBtnId);
                    if (btn && typeof btn.click === 'function') {
                        btn.click();
                    }
                }
            });
        } finally {
            isGlobalSyncing = false;
        }
    }

    dateGroups.forEach(group => {
        const sEl = document.getElementById(group.start);
        const eEl = document.getElementById(group.end);
        if (sEl) sEl.addEventListener('change', () => syncDateInputs(group.prefix));
        if (eEl) eEl.addEventListener('change', () => syncDateInputs(group.prefix));
    });
    // 绑定统计页面的预设按钮（今日/本周/本月/本季度），并同步到导出对话框
    // 绑定统计页面的预设按钮（今日/本周/本月/上月/本季度）
    try {
        const allPresetBtns = document.querySelectorAll('.preset-btn');
        if (allPresetBtns && allPresetBtns.length > 0) {
            allPresetBtns.forEach(btn => {
                btn.addEventListener('click', async () => {
                    const preset = btn.getAttribute('data-preset') || btn.getAttribute('data-range');
                    if (!window.DateRangeUtils) return;
                    const range = window.DateRangeUtils.computeRange(preset);
                    if (!range) return;

                    // 1. Determine Context (Target)
                    const container = btn.closest('.preset-buttons');
                    const target = container ? (container.getAttribute('data-target') || 'stats') : 'stats';

                    // 2. 设置本地输入框值 (作为同步源)
                    const startId = target === 'stats' ? 'statsStartDate' : `${target}StartDate`;
                    const endId = target === 'stats' ? 'statsEndDate' : `${target}EndDate`;
                    const sS = document.getElementById(startId);
                    const eS = document.getElementById(endId);
                    if (sS) sS.value = range.start;
                    if (eS) eS.value = range.end;

                    // 3. 执行全局同步并触发其他区域查询
                    syncDateInputs(target, true);

                    // 4. 特殊处理：同步导出对话框和执行本地查询
                    if (window.ExportDialog && typeof window.ExportDialog.applyPreset === 'function') {
                        try { window.ExportDialog.applyPreset(preset); } catch (_) { }
                    }

                    // 如果是在概览 Tab 点击，则直接触发一次 loadStatistics
                    if (target === 'stats') {
                        if (typeof loadStatistics === 'function') {
                            try { await loadStatistics(); } catch (err) { }
                        }
                    }
                });
            });
        }
    } catch (e) {

    }

    // 初次进入页面，触发一次同步高亮
    if (window.DateRangeUtils && window.DateRangeUtils.syncPresetButtons) {
        dateGroups.forEach(group => {
            const sEl = document.getElementById(group.start);
            const eEl = document.getElementById(group.end);
            const containerSelector = group.prefix === 'stats' ? '.inline-tabs' : `.preset-buttons[data-target="${group.prefix}"]`;
            const container = document.querySelector(containerSelector);
            if (sEl && eEl && container) {
                window.DateRangeUtils.syncPresetButtons(sEl.value, eEl.value, container);
            }
        });
    }

    // Bind Search Buttons
    const statsSearchBtn = document.getElementById('statsSearchBtn');
    if (statsSearchBtn) {
        statsSearchBtn.addEventListener('click', () => { if (typeof loadStatistics === 'function') loadStatistics(); });
    }
    const teacherStatsSearchBtn = document.getElementById('teacherStatsSearchBtn');
    if (teacherStatsSearchBtn) {
        teacherStatsSearchBtn.addEventListener('click', () => {
            // 将教师日期输入框的值同步到主统计日期输入框
            const tStart = document.getElementById('teacherStartDate');
            const tEnd = document.getElementById('teacherEndDate');
            const sEl = document.getElementById('statsStartDate');
            const eEl = document.getElementById('statsEndDate');
            if (tStart && tStart.value && sEl) sEl.value = tStart.value;
            if (tEnd && tEnd.value && eEl) eEl.value = tEnd.value;
            if (typeof loadStatistics === 'function') loadStatistics();
        });
    }
    const studentStatsSearchBtn = document.getElementById('studentStatsSearchBtn');
    if (studentStatsSearchBtn) {
        studentStatsSearchBtn.addEventListener('click', () => {
            // 将学生日期输入框的值同步到主统计日期输入框
            const sStart = document.getElementById('studentStartDate');
            const sEnd = document.getElementById('studentEndDate');
            const sEl = document.getElementById('statsStartDate');
            const eEl = document.getElementById('statsEndDate');
            if (sStart && sStart.value && sEl) sEl.value = sStart.value;
            if (sEnd && sEnd.value && eEl) eEl.value = sEnd.value;
            if (typeof loadStatistics === 'function') loadStatistics();
        });
    }
}

// Helper to compute stats from cache
function computeStatsFromCache(schedules, startDate, endDate) {
    const startTs = new Date(startDate).setHours(0, 0, 0, 0);
    const endTs = new Date(endDate).setHours(23, 59, 59, 999);

    // Filter by date
    const inRange = schedules.filter(s => {
        if (!s.date) return false;
        const ts = new Date(s.date).getTime();
        return ts >= startTs && ts <= endTs;
    });

    // Compute Distribution
    const typeCount = {};
    inRange.forEach(s => {
        const t = s.schedule_types || 'Uncategorized';
        // Handle comma separated
        const types = t.split(',').map(s => s.trim()).filter(Boolean);
        types.forEach(type => {
            const mapped = (window.ScheduleTypesStore && window.ScheduleTypesStore.getById)
                ? (function () {
                    // Try to match name or description?
                    // Actually logic in backend might be complex. 
                    // Let's stick to using the schedule_type_cn if available or schedule_types string
                    return s.schedule_type_cn || type;
                })()
                : type;
            typeCount[mapped] = (typeCount[mapped] || 0) + 1;
        });
    });

    // Convert to array
    const scheduleTypeDistribution = Object.keys(typeCount).map(k => ({
        _id: k,
        count: typeCount[k]
    })).sort((a, b) => b.count - a.count);

    return { scheduleTypeDistribution };
}

// 返回 YYYY-MM-DD 格式的 start/end
function computePresetRange(preset) {
    const today = new Date();
    const year = today.getFullYear();
    const month = today.getMonth(); // 0-11
    let start, end;

    switch (preset) {
        case 'yesterday': {
            // 昨天
            const yest = new Date(today);
            yest.setDate(today.getDate() - 1);
            start = end = toISODate(yest);
            break;
        }

        case 'today':
            // 今日：开始和结束都是今天
            start = end = toISODate(today);
            break;

        case 'week': {
            // 本周：周一到周日
            const dayOfWeek = (today.getDay() + 6) % 7; // 0 -> Monday, 6 -> Sunday
            const weekStart = new Date(today);
            weekStart.setDate(today.getDate() - dayOfWeek); // 本周周一
            const weekEnd = new Date(weekStart);
            weekEnd.setDate(weekStart.getDate() + 6); // 本周周日
            start = toISODate(weekStart);
            end = toISODate(weekEnd);
            break;
        }

        case 'last-week': {
            // 上周：本周一减7天
            const dayOfWeek = (today.getDay() + 6) % 7;
            const thisWeekStart = new Date(today);
            thisWeekStart.setDate(today.getDate() - dayOfWeek);
            const lastWeekStart = new Date(thisWeekStart);
            lastWeekStart.setDate(thisWeekStart.getDate() - 7);
            const lastWeekEnd = new Date(lastWeekStart);
            lastWeekEnd.setDate(lastWeekStart.getDate() + 6);
            start = toISODate(lastWeekStart);
            end = toISODate(lastWeekEnd);
            break;
        }

        case 'month': {
            // 本月：本月1日到本月最后一天
            const monthStart = new Date(year, month, 1);
            const monthEnd = new Date(year, month + 1, 0); // 下个月的第0天 = 本月最后一天
            start = toISODate(monthStart);
            end = toISODate(monthEnd);
            break;
        }

        case 'last-month': {
            // 上月：上个月1日到上个月最后一天
            const lastMonthStart = new Date(year, month - 1, 1);
            const lastMonthEnd = new Date(year, month, 0);
            start = toISODate(lastMonthStart);
            end = toISODate(lastMonthEnd);
            break;
        }

        case 'quarter': {
            // 本季度：Q1(1-3月), Q2(4-6月), Q3(7-9月), Q4(10-12月)
            const quarter = Math.floor(month / 3); // 0, 1, 2, 3
            const quarterStartMonth = quarter * 3; // 0, 3, 6, 9
            const quarterEndMonth = quarterStartMonth + 2; // 2, 5, 8, 11
            const quarterStart = new Date(year, quarterStartMonth, 1);
            const quarterEnd = new Date(year, quarterEndMonth + 1, 0); // 下个月的第0天 = 本月最后一天
            start = toISODate(quarterStart);
            end = toISODate(quarterEnd);
            break;
        }

        case 'last-quarter': {
            // 上季度
            const quarter = Math.floor(month / 3);
            let startMonth = (quarter * 3) - 3; // 往前推3个月
            let startYear = year;
            // 处理跨年的情况（如当前是Q1，则上季度是上一年的Q4）
            if (startMonth < 0) {
                startMonth += 12;
                startYear = year - 1;
            }
            const lastQuarterStart = new Date(startYear, startMonth, 1);
            const lastQuarterEnd = new Date(startYear, startMonth + 3, 0);
            start = toISODate(lastQuarterStart);
            end = toISODate(lastQuarterEnd);
            break;
        }

        case 'year': {
            // 本年
            const yearStart = new Date(year, 0, 1);
            const yearEnd = new Date(year, 12, 0);
            start = toISODate(yearStart);
            end = toISODate(yearEnd);
            break;
        }

        case 'last-year': {
            // 上年
            const lastYearStart = new Date(year - 1, 0, 1);
            const lastYearEnd = new Date(year - 1, 12, 0);
            start = toISODate(lastYearStart);
            end = toISODate(lastYearEnd);
            break;
        }

        default:
            return null;
    }
    return { start, end };
}

// 统计模块延迟初始化包装器（仅在首次访问统计页面时执行一次）
function ensureStatisticsInitialized() {
    if (statisticsInitialized) return;
    statisticsInitialized = true;



    // 初始化日期控件为当月
    initializeStatisticsControls();

    // 初始化Tab切换
    initializeStatisticsTabs();


}

function initializeStatisticsTabs() {
    // 修改选择器以匹配新的HTML结构
    // 修改选择器以匹配新的HTML结构 - 放宽选择器
    const tabBtns = document.querySelectorAll('.statistics-tabs .tab-btn');
    const overviewEl = document.getElementById('statsOverview');
    const teacherEl = document.getElementById('statsTeacher');
    const studentEl = document.getElementById('statsStudent');
    if (!tabBtns.length || !overviewEl || !teacherEl || !studentEl) return;

    const showView = (view) => {
        const currentActive = document.querySelector('.stats-view.active');
        const nextActive = view === 'overview' ? overviewEl : (view === 'teacher' ? teacherEl : studentEl);

        if (currentActive === nextActive) return;

        const fadeIn = (el) => {
            el.style.display = 'block';
            el.style.opacity = '0';
            // 强制重绘
            void el.offsetWidth;
            el.classList.add('active');
            el.style.opacity = '';
            el.style.display = '';
        };

        if (currentActive) {
            currentActive.classList.add('fade-out');
            setTimeout(() => {
                currentActive.classList.remove('active', 'fade-out');
                fadeIn(nextActive);
                loadStatistics();
            }, 300);
        } else {
            fadeIn(nextActive);
            loadStatistics();
        }
    };

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // 获取 dataset.view，若无则默认为 overview
            const view = btn.dataset.view || 'overview';
            showView(view);
        });
    });

    // 初始化显示（不带动画，避免首屏闪烁）
    if (!document.querySelector('.stats-view.active')) {
        overviewEl.classList.add('active');

        // 修正：同时设置 Overview 按钮为选中状态，确保 getStatisticsActiveView 获取正确视图
        const overviewBtn = document.querySelector('.statistics-tabs .tab-btn[data-view="overview"]');
        if (overviewBtn) overviewBtn.classList.add('active');

        // 修正：增加延迟加载统计数据，等待 DOM 完全渲染和可见可见，防止 Chart.js 渲染在 0x0 容器上
        setTimeout(() => {
            loadStatistics();
        }, 150); // Increased delay for better reliability on slower layouts
    }
}

function getStatisticsActiveView() {
    // Scope search to the statistics section to avoid collision with other tabs (e.g., user management)
    const container = document.getElementById('statistics');
    if (!container) return 'overview';

    // Find active tab button within statistics container
    const activeBtn = container.querySelector('.statistics-tabs .tab-btn.active');
    return activeBtn ? (activeBtn.dataset.view || activeBtn.getAttribute('data-view')) : 'overview';
}

async function loadStatistics() {
    // 获取反馈元素
    const statsFeedback = document.getElementById('statisticsFeedback');

    try {
        const statsStartEl = document.getElementById('statsStartDate');
        const statsEndEl = document.getElementById('statsEndDate');
        let startDate = statsStartEl && statsStartEl.value;
        let endDate = statsEndEl && statsEndEl.value;

        // 默认本月
        if (!startDate || !endDate) {
            const now = new Date();
            // Get first day of current month
            const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
            // Get last day of current month
            const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
            startDate = toISODate(firstDay);
            endDate = toISODate(lastDay);

            // Sync to elements immediately
            if (statsStartEl) statsStartEl.value = startDate;
            if (statsEndEl) statsEndEl.value = endDate;
        }

        // 显示加载反馈 (Legacy)
        if (statsFeedback) {
            statsFeedback.textContent = '正在加载统计数据...';
            statsFeedback.className = 'feedback info';
            statsFeedback.style.display = 'block';
        }

        const activeView = getStatisticsActiveView();
        const activeWrapper = document.getElementById('stats' + activeView.charAt(0).toUpperCase() + activeView.slice(1));
        if (activeWrapper) activeWrapper.classList.add('stats-loading');

        // 概览视图：饼图 + 教师/学生堆叠横向柱
        if (activeView === 'overview') {
            try {
                // 使用统一的加载动画工具
                if (activeWrapper && window.UIHelper) {
                    const chartsSection = activeWrapper.querySelector('.charts-section');
                    if (chartsSection) {
                        window.UIHelper.showTableLoading(chartsSection, '正在加载统计数据...');
                    }
                }

                // Reset animations for overview charts
                const chartContainers = document.querySelectorAll('#statsOverview .charts-section .chart-container');
                chartContainers.forEach(el => {
                    el.classList.remove('chart-anim-active');
                    el.classList.add('chart-anim-enter');
                });

                // Parallel execution for faster loading
                let scheduleStats = null;
                let teacherStack = null;
                let studentStack = null;

                try {
                    // 1. Define promises - 并行加载数据
                    // Optimization: Check if we can compute schedule stats from local cache
                    let p1;
                    const cache = window.WeeklyDataStore;
                    // Removed broken cache logic that assumed WeeklyDataStore had all historical data
                    p1 = window.apiUtils.get('/admin/statistics/schedules', { startDate, endDate })
                        .catch(err => { return null; });

                    const p2 = window.apiUtils.get('/admin/statistics/users', { startDate, endDate })
                        .catch(err => { return null; });

                    // 2. Await all
                    const [statsData, userStatsData] = await Promise.all([p1, p2]);

                    // 检查数据有效性 - 如果加载失败,显示错误提示而非假数据
                    if (!statsData || !userStatsData) {


                        // 移除加载覆盖层
                        if (loadingOverlay) loadingOverlay.remove();
                        if (overviewContainer) overviewContainer.classList.remove('stats-loading');
                        if (statsFeedback) statsFeedback.style.display = 'none';

                        // 显示错误提示
                        const chartsSection = overviewContainer?.querySelector('.charts-section');
                        if (chartsSection) {
                            chartsSection.innerHTML = `
                                <div class="stats-error-message" style="
                                    display: flex;
                                    flex-direction: column;
                                    align-items: center;
                                    justify-content: center;
                                    padding: 60px 20px;
                                    min-height: 300px;
                                ">
                                    <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
                                    <div style="font-size: 18px; font-weight: 500; color: #ef4444; margin-bottom: 8px;">数据加载失败</div>
                                    <div style="font-size: 14px; color: #6b7280;">请检查网络连接或稍后重试</div>
                                </div>
                            `;
                        }
                        return;
                    }

                    // 3. 转换数据格式 - 鲁棒性处理：支持数组或对象包装格式
                    let scheduleDist = [];
                    if (Array.isArray(statsData)) {
                        scheduleDist = statsData;
                    } else if (statsData && Array.isArray(statsData.scheduleTypeDistribution)) {
                        scheduleDist = statsData.scheduleTypeDistribution;
                    }

                    // 检查关键数据是否存在
                    if (!scheduleDist || scheduleDist.length === 0) {


                        // 移除加载覆盖层
                        if (loadingOverlay) loadingOverlay.remove();
                        if (overviewContainer) overviewContainer.classList.remove('stats-loading');
                        if (statsFeedback) statsFeedback.style.display = 'none';

                        // 显示错误提示
                        const chartsSection = overviewContainer?.querySelector('.charts-section');
                        if (chartsSection) {
                            chartsSection.innerHTML = `
                                <div class="stats-error-message" style="
                                    display: flex;
                                    flex-direction: column;
                                    align-items: center;
                                    justify-content: center;
                                    padding: 60px 20px;
                                    min-height: 300px;
                                ">
                                    <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
                                    <div style="font-size: 18px; font-weight: 500; color: #ef4444; margin-bottom: 8px;">数据加载失败</div>
                                    <div style="font-size: 14px; color: #6b7280;">暂无可用数据</div>
                                </div>
                            `;
                        }
                        return;
                    }

                    const tStack = (userStatsData && userStatsData.teacherStats?.length)
                        ? convertUserStatsToStackData(userStatsData.teacherStats, Infinity)
                        : getDefaultTeacherStack();
                    const sStack = (userStatsData && userStatsData.studentStats?.length)
                        ? convertUserStatsToStackData(userStatsData.studentStats, Infinity)
                        : getDefaultStudentStack();

                    // 4. Render - 延迟一小段时间确保 DOM 稳定（特别是 Canvas 尺寸）
                    setTimeout(() => {
                        renderScheduleTypeChart(scheduleDist);
                        renderTeacherTypeStackedChart(tStack);
                        renderStudentTypeStackedChart(sStack);

                        // 5. Trigger animations - 嵌套 rAF 确保浏览器完成绘制
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                const activeContainers = document.querySelectorAll('#statsOverview .charts-section .chart-container');
                                activeContainers.forEach(el => {
                                    el.classList.remove('chart-anim-enter');
                                    el.classList.add('chart-anim-active');
                                });
                            });
                        });
                    }, 50);

                } catch (generalError) {


                    // 移除加载覆盖层
                    if (loadingOverlay) loadingOverlay.remove();
                    if (overviewContainer) overviewContainer.classList.remove('stats-loading');
                    if (statsFeedback) statsFeedback.style.display = 'none';

                    // 显示错误提示
                    const chartsSection = overviewContainer?.querySelector('.charts-section');
                    if (chartsSection) {
                        chartsSection.innerHTML = `
                            <div class="stats-error-message" style="
                                display: flex;
                                flex-direction: column;
                                align-items: center;
                                justify-content: center;
                                padding: 60px 20px;
                                min-height: 300px;
                            ">
                                <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
                                <div style="font-size: 18px; font-weight: 500; color: #ef4444; margin-bottom: 8px;">数据加载失败</div>
                                <div style="font-size: 14px; color: #6b7280;">发生未知错误，请稍后重试</div>
                            </div>
                        `;
                    }
                }

                // Hide feedback
                if (activeWrapper) {
                    activeWrapper.classList.remove('stats-loading');
                    const chartsSection = activeWrapper.querySelector('.charts-section');
                    if (chartsSection && window.UIHelper) {
                        window.UIHelper.hideTableLoading(chartsSection);
                    }
                }
                if (statsFeedback) statsFeedback.style.display = 'none';
                return;
            } catch (overviewError) {

                // Fallthrough to global catch if needed, or handle locally
                throw overviewError;
            }
        }


        // 教师/学生统计视图：时间轴折线 + 每日类型堆叠柱
        // 优化：先显示加载动画，再加载数据

        if (activeView === 'teacher') {
            const chartGrid = document.getElementById('teacherChartsContainer');
            if (chartGrid) chartGrid.innerHTML = ''; // 清理旧内容，重置高度
            
            const teacherContainer = document.querySelector('.teacher-charts-container');
            if (teacherContainer && window.UIHelper) {
                window.UIHelper.showTableLoading(teacherContainer, '正在加载统计数据...');
                
                // Reset animations
                const chartContainers = teacherContainer.querySelectorAll('.chart-container');
                chartContainers.forEach(el => {
                    el.classList.remove('chart-anim-active');
                    el.classList.add('chart-anim-enter');
                });
            }
        }

        if (activeView === 'student') {
            const chartGrid = document.getElementById('studentChartsContainer');
            if (chartGrid) chartGrid.innerHTML = ''; // 清理旧内容，重置高度

            const studentContainer = document.querySelector('.student-charts-container');
            if (studentContainer && window.UIHelper) {
                window.UIHelper.showTableLoading(studentContainer, '正在加载统计数据...');
                
                // Reset animations
                const chartContainers = studentContainer.querySelectorAll('.chart-container');
                chartContainers.forEach(el => {
                    el.classList.remove('chart-anim-active');
                    el.classList.add('chart-anim-enter');
                });
            }
        }

        // 开始加载数据
        let rawSchedules = [];
        try {

            const resp = await window.apiUtils.get('/admin/schedules/grid', { start_date: startDate, end_date: endDate });
            const dataArr = Array.isArray(resp) ? resp : (resp && resp.data ? resp.data : []);

            rawSchedules = dataArr.map(r => {
                const rawDate = r.date ?? r.class_date ?? r['class-date'] ?? r.arr_date;
                let dateISO = '';
                if (rawDate) {
                    const d = new Date(rawDate);
                    dateISO = Number.isNaN(d.getTime()) ? (typeof rawDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : '') : toISODate(d);
                }
                const typeId = r.course_id ?? r.type_id ?? r.schedule_type_id;
                let typeText = r.schedule_type_cn || r.schedule_types || r.schedule_type || '';
                try {
                    if (typeId != null && window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
                        const info = window.ScheduleTypesStore.getById(typeId);
                        if (info && !r.schedule_type_cn) typeText = info.description || info.name || typeText;
                    }
                } catch (_) { }

                return {
                    ...r,
                    date: dateISO,
                    schedule_types: typeText,
                    schedule_type_cn: r.schedule_type_cn,
                    teacher_name: r.teacher_name || r.teacherName || '未分配',
                    student_name: r.student_name || '未指定'
                };
            });
        } catch (apiError) {

            // 使用默认数据
            rawSchedules = getDefaultSchedules();
        }

        const dayLabels = (window.StatsPlugins && typeof window.StatsPlugins.buildDayLabels === 'function')
            ? window.StatsPlugins.buildDayLabels(startDate, endDate)
            : buildDatesRange(startDate, endDate).map(d => toISODate(d));

        if (activeView === 'teacher') {
            try {
                if (window.StatsPlugins) {
                    const typeStacks = window.StatsPlugins.buildStackedByTypePerDay(rawSchedules, dayLabels);
                    window.StatsPlugins.renderStackedBarChart('teacherDailyTypeStackChart', dayLabels, typeStacks, { theme: 'accessible', interactionMode: 'index', showTotalLine: true });
                    // 设置汇总图表标题的悬停提示
                    setupStatsTooltip(rawSchedules, 'teacherSummaryChartTitle', 'teacherSummaryTitleTooltip');
                }
                // 新增：教师下拉筛选 + 每位教师类型曲线图
                try {
                    setupTeacherChartsFilter(rawSchedules, dayLabels);
                    const selected = getSelectedTeacherForCharts();
                    renderTeacherTypePerTeacherCharts(rawSchedules, dayLabels, selected);
                } catch (filterError) {

                }
            } finally {
                const teacherContainer = document.querySelector('.teacher-charts-container');
                if (teacherContainer && window.UIHelper) {
                    window.UIHelper.hideTableLoading(teacherContainer);
                }
                if (activeWrapper) activeWrapper.classList.remove('stats-loading');
                // 隐藏反馈
                if (statsFeedback) {
                    statsFeedback.style.display = 'none';
                }

                // Trigger animation
                if (teacherContainer) {
                    setTimeout(() => {
                        const chartContainers = teacherContainer.querySelectorAll('.chart-container');
                        chartContainers.forEach(el => {
                            el.classList.add('chart-anim-active');
                        });
                    }, 50);
                }
            }
            return;
        }

        if (activeView === 'student') {
            try {
                if (window.StatsPlugins) {
                    const typeStacks = window.StatsPlugins.buildStackedByTypePerDay(rawSchedules, dayLabels);
                    window.StatsPlugins.renderStackedBarChart('studentDailyTypeStackChart', dayLabels, typeStacks, { theme: 'accessible', interactionMode: 'index', showTotalLine: true });
                    // 设置汇总图表标题的悬停 tooltip
                    setupStatsTooltip(rawSchedules, 'studentSummaryChartTitle', 'studentSummaryTitleTooltip');
                }
                // 新增：学生下拉筛选 + 每位学生类型曲线图
                try {
                    setupStudentChartsFilter(rawSchedules, dayLabels);
                    const selectedStu = getSelectedStudentForCharts();
                    renderStudentTypePerStudentCharts(rawSchedules, dayLabels, selectedStu);
                } catch (filterError) {

                }
            } finally {
                const studentContainerEl = document.querySelector('.student-charts-container');
                if (studentContainerEl && window.UIHelper) {
                    window.UIHelper.hideTableLoading(studentContainerEl);
                }
                
                // 确保同步移除外层容器的加载类
                if (activeWrapper) activeWrapper.classList.remove('stats-loading');
                
                // 隐藏反馈
                if (statsFeedback) {
                    statsFeedback.style.display = 'none';
                }

                // Trigger animation
                if (studentContainerEl) {
                    setTimeout(() => {
                        const chartContainers = studentContainerEl.querySelectorAll('.chart-container');
                        chartContainers.forEach(el => {
                            el.classList.add('chart-anim-active');
                        });
                    }, 50);
                }
            }
            return;
        }



        // Fallback for unexpected activeView value
        if (statsFeedback) statsFeedback.style.display = 'none';

    } catch (error) {
        const activeView = getStatisticsActiveView();
        const activeWrapper = document.getElementById('stats' + activeView.charAt(0).toUpperCase() + activeView.slice(1));
        
        if (activeWrapper) {
            activeWrapper.classList.remove('stats-loading');
            
            // 全局兜底：隐藏所有可能的加载遮罩
            if (window.UIHelper) {
                const containers = [
                    activeWrapper.querySelector('.charts-section'),
                    activeWrapper.querySelector('.teacher-charts-container'),
                    activeWrapper.querySelector('.student-charts-container')
                ];
                containers.forEach(c => {
                    if (c) window.UIHelper.hideTableLoading(c);
                });
            }
        }


        // 显示错误反馈
        if (statsFeedback) {
            // 检查是否是认证错误
            if (error && error.message && error.message.includes('认证令牌已过期')) {
                statsFeedback.textContent = '认证已过期，请重新登录';
            } else {
                statsFeedback.textContent = '统计数据加载失败，请稍后重试';
            }
            statsFeedback.className = 'feedback error';
            statsFeedback.style.display = 'block';
        }
    }
}

// 默认数据函数，用于开发时显示
function getDefaultScheduleStats() {
    return {
        scheduleTypeDistribution: [
            { type: '入户', count: 45 },
            { type: '试教', count: 32 },
            { type: '评审', count: 18 },
            { type: '咨询', count: 12 },

            { type: '线上辅导', count: 28 }
        ]
    };
}

function getDefaultTeacherStack() {
    return {
        labels: ['张老师', '李老师', '王老师', '赵老师', '陈老师'],
        datasets: [
            {
                label: '入户',
                data: [12, 8, 15, 6, 10],
                backgroundColor: getLegendColor('入户')
            },
            {
                label: '试教',
                data: [8, 12, 5, 10, 7],
                backgroundColor: getLegendColor('试教')
            },
            {
                label: '评审',
                data: [3, 5, 2, 4, 6],
                backgroundColor: getLegendColor('评审')
            }
        ]
    };
}

function getDefaultStudentStack() {
    return {
        labels: ['学生A', '学生B', '学生C', '学生D', '学生E'],
        datasets: [
            {
                label: '入户',
                data: [5, 8, 3, 6, 2],
                backgroundColor: getLegendColor('入户')
            },
            {
                label: '试教',
                data: [3, 4, 2, 5, 1],
                backgroundColor: getLegendColor('试教')
            }
        ]
    };
}

// --- Chart Rendering Implementations ---


function renderScheduleTypeChart(data) {
    if (!isChartAvailable()) return;
    const canvasId = 'scheduleTypeChart';
    const el = document.getElementById(canvasId);
    if (!el) return;

    // Destroy previous chart instance if it exists
    const oldChart = window.Chart.getChart(el);
    if (oldChart) oldChart.destroy();

    // Data normalization
    const normalizedData = Array.isArray(data) ? data : (data?.scheduleTypeDistribution || []);
    // Guard against empty data
    if (!normalizedData || normalizedData.length === 0) {
        // Render empty state or return? For now let's render an empty chart which Chart.js handles gracefully-ish or just return
        // Ideally we might want to show "No Data" text
    }

    const labels = normalizedData.map(item => item.type);
    const counts = normalizedData.map(item => parseInt(item.count) || 0);
    const backgroundColors = labels.map(label => getLegendColor(label));
    const total = counts.reduce((a, b) => a + b, 0);

    new window.Chart(el, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: counts,
                backgroundColor: backgroundColors,
                borderWidth: 0,
                hoverOffset: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        padding: 20,
                        font: { size: 12 },
                        generateLabels: (chart) => {
                            const data = chart.data;
                            if (!data.labels.length) return [];
                            return data.labels.map((label, i) => {
                                const value = data.datasets[0].data[i];
                                const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                return {
                                    text: `${label} (${percent}%)`,
                                    fillStyle: data.datasets[0].backgroundColor[i],
                                    strokeStyle: 'transparent',
                                    hidden: !chart.getDataVisibility(i),
                                    index: i
                                };
                            });
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function (context) {
                            const label = context.label || '';
                            // Remove percentage from label if it was added by legend generator (it's not, label is raw)
                            // But wait, the label in tooltip comes from data.labels.
                            // The custom generateLabels affects the LEGEND.
                            const value = context.raw || 0;
                            const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            }
        },
        plugins: [{
            id: 'centerText',
            beforeDraw: function (chart) {
                const width = chart.width,
                    height = chart.height,
                    ctx = chart.ctx;

                ctx.restore();
                const fontSize = (height / 114).toFixed(2);
                ctx.font = `bold ${fontSize}px sans-serif`;
                ctx.textBaseline = "middle";
                ctx.fillStyle = "#333";

                const text = total.toString(),
                    textX = Math.round((width - ctx.measureText(text).width) / 2),
                    textY = height / 2;

                ctx.fillText(text, textX, textY);
                ctx.save();
            }
        }]
    });
}







// Helper: Convert user stats API data to chart data
function convertUserStatsToStackData(statsList, limit = 5) {
    if (!Array.isArray(statsList) || statsList.length === 0) {
        return { labels: [], datasets: [] };
    }

    // Filter out 0 value records
    const filteredStats = statsList.filter(item => {
        if (!item.types || typeof item.types !== 'object') return false;
        const total = Object.values(item.types).reduce((acc, count) => acc + (Number(count) || 0), 0);
        return total > 0;
    });

    // 按ID升序排列
    const sorted = filteredStats.sort((a, b) => Number(a.id || a.user_id || 0) - Number(b.id || b.user_id || 0)).slice(0, limit);

    const labels = sorted.map(item => item.name);

    // 收集所有类型
    const allTypes = new Set();
    sorted.forEach(person => {
        if (person.types && typeof person.types === 'object') {
            Object.keys(person.types).forEach(type => allTypes.add(type));
        }
    });

    // 按出现频率排序类型
    const typeCounts = {};
    sorted.forEach(person => {
        if (person.types && typeof person.types === 'object') {
            Object.entries(person.types).forEach(([type, count]) => {
                typeCounts[type] = (typeCounts[type] || 0) + count;
            });
        }
    });
    const sortedTypes = Array.from(allTypes).sort((a, b) => (typeCounts[b] || 0) - (typeCounts[a] || 0));

    const datasets = sortedTypes.map(type => ({
        label: type,
        data: sorted.map(item => {
            return (item.types && item.types[type]) || 0;
        }),
        backgroundColor: getLegendColor(type)
    }));

    return { labels, datasets };
}

// Color helper
function getLegendColor(label) {
    if (window.ColorUtils && window.ColorUtils.getLegendColor) {
        return window.ColorUtils.getLegendColor(label);
    }
    const map = {
        '入户': '#4e73df', // Blue
        '试教': '#1cc88a', // Green
        '评审': '#36b9cc', // Cyan
        '咨询': '#f6c23e', // Yellow
        '线上辅导': '#e74a3b', // Red
        'Default': '#858796'
    };
    return map[label] || map['Default'];
}

// 供 renderScheduleTypeChart 回调可能需要的构建函数 (虽然 renderScheduleTypeChart 内部自己处理了)



// --- Stats logic has been moved to stats-logic.js --- 

// 加载类型筛选器选项（按课程类型）
async function loadScheduleFilterOptions() {
    try {
        const typeFilter = document.getElementById('typeFilter');
        if (!typeFilter) return;
        // 先置默认项
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(typeFilter, '<option value="">全部类型</option>'); } else { typeFilter.innerHTML = '<option value="">全部类型</option>'; }
        let types = [];
        // 优先使用缓存
        if (ScheduleTypesStore.getAll().length === 0) {
            // 尝试从本地缓存恢复
            const restored = ScheduleTypesStore.loadFromCache();
            if (!restored) {
                try {
                    // 使用新的API工具类获取课程类型
                    const fetched = await window.apiUtils.get('/schedule/types');
                    if (Array.isArray(fetched)) ScheduleTypesStore.updateData(fetched);
                } catch (error) {

                }
            }
        }
        types = ScheduleTypesStore.getAll();
        types.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = (t.description || t.name || `类型${t.id}`);
            typeFilter.appendChild(opt);
        });
    } catch (error) {

    }
}

// 计算一周日期（周一开始）
function getWeekDates(baseDate) {
    // 优先使用集中管理的日期范围工具
    if (window.DateRangeUtils && typeof window.DateRangeUtils.getWeekDates === 'function') {
        return window.DateRangeUtils.getWeekDates(baseDate);
    }
    // 回退到本地实现
    const d = new Date(baseDate);
    const day = d.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const diffToMon = (day === 0 ? -6 : 1 - day);
    const monday = new Date(d);
    monday.setDate(d.getDate() + diffToMon);
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const nd = new Date(monday);
        nd.setDate(monday.getDate() + i);
        dates.push(nd);
    }
    return dates;
}

// 按起止日期生成日期数组（含端点）
function buildDatesRange(startDate, endDate) {
    const s = new Date(startDate);
    const e = new Date(endDate);
    s.setHours(0, 0, 0, 0);
    e.setHours(0, 0, 0, 0);
    const days = [];
    for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
        days.push(new Date(d));
    }
    return days.length ? days : [new Date()];
}

function formatYearMonth(date) {
    const d = (date instanceof Date) ? date : new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}年${m}月`;
}

function formatDayLabel(date) {
    const d = (date instanceof Date) ? date : new Date(date);
    const dayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const weekday = dayNames[d.getDay()];
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    // 返回 HTML 字符串：两行显示
    return `<div style="line-height:1.4;"><div style="font-size:14px;color:#334155;font-weight:600;">${m}月${dd}日</div><div style="font-size:12px;color:#64748b;">${weekday}</div></div>`;
}

function formatYMD(date) {
    const d = (date instanceof Date) ? date : new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}年${m}月${day}日`;
}

// 计算ISO周次（周一为一周开始）
function getISOWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay() || 7; // 周日=7
    d.setDate(d.getDate() + 4 - day); // 跳到本周周四
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return weekNo;
}

function updateWeeklyRangeText(start, end) {
    if (window.DateRangeUtils && typeof window.DateRangeUtils.updateRangeText === 'function') {
        window.DateRangeUtils.updateRangeText({ start, end });
        // 不再提前返回，继续更新标题与文本，确保绑定一致
    }
    const txt = document.getElementById('weekRange');
    if (txt) {
        const weekNo = getISOWeekNumber(start);
        txt.textContent = `${formatYMD(start)} - ${formatYMD(end)}（第${weekNo}周）`;
        // 同步更新标题（仅在排课管理页面）
        const activeSection = document.querySelector('.dashboard-section.active');
        if (activeSection && activeSection.id === 'schedule') {
            setHeaderTitle(`排课管理（第${weekNo}周）`);
        }
    }
}

async function fetchStudentsForWeekly(opts = {}) {
    const force = !!opts.force;
    return WeeklyDataStore.getStudents(force);
}

async function fetchSchedulesRange(startDate, endDate, status, type, teacherId = '', opts = {}) {
    const force = !!opts.force;
    // ✅ 使用 window.WeeklyDataStore 确保调用最新的实现（来自 schedule-manager.js）
    // 而不是局部常量 WeeklyDataStore（可能是旧的存根）
    return window.WeeklyDataStore.getSchedules(startDate, endDate, status, type, teacherId, force);
}

// normalizeScheduleRows, sanitizeTimeString, hhmmToMinutes, minutesToHHMM, computeSlotByStartMin, clusterByOverlap, buildMergedRowText have been moved to schedule-utils.js

function renderGroupedMergedSlots(td, items, student, dateKey) {
    // 注入样式（确保只注入一次）
    if (!document.getElementById('admin-student-style-card')) {
        const style = document.createElement('style');
        style.id = 'admin-student-style-card';
        style.textContent = `
            .schedule-card-group {
                background: #fff;
                border-radius: 8px;
                border: 1px solid; /* 使用元素自身的 border-color (由 bg- classes 定义) */
                margin-bottom: 8px;
                overflow: hidden;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                transition: all 0.2s ease-in-out;
                position: relative;
            }
            .schedule-card-group:hover {
                transform: translateY(-2px);
                box-shadow: 0 8px 16px rgba(0,0,0,0.08); /* 更深邃的阴影 */
                border-color: var(--hover-border) !important; /* 聚焦时显示深色边框 */
            }
            /* 背景色变体 (基于时间段) - 更加深颜色以贴近学生端风格 */
            /* 背景色变体 (基于时间段) - 更加深颜色以贴近学生端风格 */
            /* 上午 (蓝) - #bfdbfe (Tailwind blue-200) */
            .bg-morning { 
                background-color: #bfdbfe; 
                border-color: #93c5fd; /* Default border: blue-300 */
                --hover-border: #2563eb; /* Hover border: blue-600 */
            }
            /* 下午 (黄) - #fde68a (Tailwind amber-200) */
            .bg-afternoon { 
                background-color: #fde68a; 
                border-color: #fcd34d; /* Default border: amber-300 */
                --hover-border: #d97706; /* Hover border: amber-600 */
            }
            /* 晚上 (紫) - #e9d5ff (Tailwind purple-200) */
            .bg-evening { 
                background-color: #e9d5ff; 
                border-color: #d8b4fe; /* Default border: purple-300 */
                --hover-border: #9333ea; /* Hover border: purple-600 */
            }
            /* 默认 */
            .bg-default { 
                background-color: #e2e8f0; 
                border-color: #cbd5e1; /* Default border: slate-300 */
                --hover-border: #475569; /* Hover border: slate-600 */
            }

            .schedule-list {
                padding: 8px 10px;
                display: flex;
                flex-direction: column;
                gap: 6px;
                background-color: rgba(255, 255, 255, 0.5); /* 增加列表区域可读性 */
            }
            .schedule-row {
                display: flex;
                align-items: center;
                justify-content: space-between;
                font-size: 13px;
                padding: 2px 0;
                cursor: pointer;
            }
            .schedule-row:hover .teacher-name {
                text-decoration: underline;
                color: #2563eb;
            }
            .row-left {
                display: flex;
                align-items: center;
                gap: 6px;
                flex: 1;
                min-width: 0;
            }
            .teacher-name {
                font-weight: 600;
                color: #1e293b;
                white-space: nowrap;
            }
            .course-type-inline {
                font-size: 11px; /* 减小字号 */
                color: #94a3b8;  /* 灰色系 (Tailwind slate-400) */
                margin-left: 2px;
                font-weight: normal;
            }
            
            /* 表格列宽自适应优化 */
            #weeklyScheduleTable th, #weeklyScheduleTable td {
                min-width: 150px; /* 确保最小宽度，防止挤压 */
                max-width: 200px; /* 避免过宽 */
                white-space: normal; /* 允许换行 */
                vertical-align: top;
            }
            #weeklyScheduleTable .sticky-col {
                min-width: 100px;
                width: 100px;
                position: sticky;
                left: 0;
                z-index: 10;
                background: #f8fafc;
                border-right: 1px solid #e2e8f0;
            }

            /* Status Badge */
            .status-badge-sm {
                font-size: 11px;
                padding: 1px 6px;
                border-radius: 4px;
                white-space: nowrap;
                font-weight: 500;
                cursor: pointer; /* Clickable */
                transition: opacity 0.2s;
            }
            .status-badge-sm:hover {
                opacity: 0.8;
                box-shadow: 0 1px 2px rgba(0,0,0,0.1);
            }
            .status-badge-sm.confirmed { background: #dcfce7; color: #166534; }
            .status-badge-sm.pending { background: #fff7ed; color: #9a3412; }
            .status-badge-sm.completed { background: #e2e8f0; color: #475569; }
            .status-badge-sm.cancelled { background: #fee2e2; color: #991b1b; }

            .schedule-divider {
                height: 1px;
                background-color: rgba(0,0,0,0.06);
                margin: 0 8px;
            }

            .schedule-footer {
                padding: 8px 10px;
                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 2px;
                font-size: 12px;
                color: #475569;
                background-color: rgba(255,255,255,0.4); /* 轻微透明叠加 */
            }
            .time-range {
                font-weight: 600;
                font-size: 13px;
                color: #334155;
            }
            .location-text {
                text-align: center;
                line-height: 1.3;
                opacity: 0.9;
            }

            /* Status Popup Menu */
            .status-popup-menu {
                position: absolute;
                background: white;
                border: 1px solid #e2e8f0;
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
                border-radius: 6px;
                padding: 4px;
                z-index: 50;
                display: flex;
                flex-direction: column;
                min-width: 80px;
            }
            .status-popup-item {
                padding: 8px 12px; /* 增加点击区域 */
                font-size: 13px;
                color: #334155;
                cursor: pointer;
                border-radius: 4px;
                text-align: left;
                display: flex;
                align-items: center;
                gap: 8px; /* 图标间距 */
                transition: all 0.2s;
            }
            .status-popup-item:hover {
                background-color: #f8fafc;
                color: #2563eb;
            }
            .status-popup-item.current {
                font-weight: 600;
                color: #2563eb;
                background-color: #eff6ff;
            }
            .status-item-icon {
                font-size: 16px;
                width: 16px; 
                height: 16px;
                display: inline-block;
                vertical-align: middle;
            }
            /* 状态颜色点用于下拉菜单 */
            .status-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                display: inline-block;
            }
            .status-dot.pending { background: #f97316; }
            .status-dot.confirmed { background: #10b981; }
            .status-dot.completed { background: #64748b; }
            .status-dot.cancelled { background: #ef4444; }
        `;
        document.head.appendChild(style);
    }

    // 1. 聚合逻辑：按 start_time|end_time|location 分组
    const groups = new Map();
    items.forEach(item => {
        const loc = (item.location || '').trim();
        const start = item.start_time ? item.start_time.substring(0, 5) : '';
        const end = item.end_time ? item.end_time.substring(0, 5) : '';
        const key = `${start}|${end}|${loc}`;

        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });

    // 2. 排序：按开始时间
    const sortedGroups = Array.from(groups.values()).sort((a, b) => {
        return (a[0].start_time || '').localeCompare(b[0].start_time || '');
    });

    // 3. 渲染
    sortedGroups.forEach(group => {
        const card = buildAdminScheduleCard(group, student, dateKey);
        td.appendChild(card);
    });
}

function buildAdminScheduleCard(group, student, dateKey) {
    if (!group || group.length === 0) return document.createElement('div');
    const first = group[0];

    // 确定卡片背景色：根据时间段决定
    // 上午 < 12:00, 下午 12:00-18:00, 晚上 >= 18:00
    let bgClass = 'bg-default';
    const startHour = parseInt((first.start_time || '00:00').substring(0, 2), 10);

    if (startHour < 12) {
        bgClass = 'bg-morning'; // 蓝色
    } else if (startHour < 18) {
        bgClass = 'bg-afternoon'; // 黄色
    } else {
        bgClass = 'bg-evening'; // 紫色
    }

    const card = document.createElement('div');
    card.classList.add('schedule-card-group', bgClass);

    // --- List Section (Rows) ---
    const listDiv = document.createElement('div');
    listDiv.classList.add('schedule-list');

    group.forEach(rec => {
        const row = document.createElement('div');
        row.classList.add('schedule-row');
        row.title = '点击修改此排课状态或信息';

        // 左侧：教师名 + 课程类型
        const left = document.createElement('div');
        left.classList.add('row-left');

        const teacher = document.createElement('span');
        teacher.classList.add('teacher-name');
        teacher.textContent = rec.teacher_name || '未分配';
        left.appendChild(teacher);

        const tType = rec.schedule_type_cn || rec.schedule_type || '未分配';
        if (tType) {
            const typeSpan = document.createElement('span');
            typeSpan.classList.add('course-type-inline');
            typeSpan.textContent = `(${tType})`;
            left.appendChild(typeSpan);
        }

        row.appendChild(left);

        row.appendChild(left);

        // 右侧：状态 Badge (Clickable)
        const status = (rec.status || 'pending').toLowerCase();
        const statusBadge = document.createElement('span');
        statusBadge.classList.add('status-badge-sm', status);
        const statusMap = { 'pending': '待确认', 'confirmed': '已确认', 'completed': '已完成', 'cancelled': '已取消' };
        statusBadge.textContent = statusMap[status] || status;

        // 点击 Badge 弹出状态修改菜单
        statusBadge.addEventListener('click', (e) => {
            e.stopPropagation(); // 阻止冒泡，避免触发整个行点击

            // 移除已存在的菜单
            document.querySelectorAll('.status-popup-menu').forEach(el => el.remove());

            // 创建菜单
            const menu = document.createElement('div');
            menu.classList.add('status-popup-menu');

            const options = [
                { key: 'pending', label: '待确认', icon: 'schedule', color: 'pending' },
                { key: 'confirmed', label: '已确认', icon: 'check_circle', color: 'confirmed' },
                { key: 'completed', label: '已完成', icon: 'task_alt', color: 'completed' },
                { key: 'cancelled', label: '已取消', icon: 'cancel', color: 'cancelled' }
            ];

            options.forEach(opt => {
                const item = document.createElement('div');
                item.classList.add('status-popup-item');
                if (opt.key === status) item.classList.add('current');

                // 添加小圆点或图标
                item.innerHTML = `
                    <span class="status-dot ${opt.color}"></span>
                    <span>${opt.label}</span>
                `;

                item.addEventListener('click', async (ev) => {
                    ev.stopPropagation();
                    menu.remove();
                    if (opt.key !== status) {
                        // 乐观更新：立即更新 UI 样式
                        statusBadge.className = 'status-badge-sm ' + opt.key;
                        statusBadge.textContent = opt.label;

                        // 调用后端更新
                        await updateScheduleStatus(rec.id, opt.key);
                    }
                });
                menu.appendChild(item);
            });

            // 定位菜单
            document.body.appendChild(menu);
            const rect = statusBadge.getBoundingClientRect();
            menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
            menu.style.left = `${rect.left + window.scrollX - 20}px`;

            // 点击外部关闭
            const closeHandler = () => {
                menu.remove();
                document.removeEventListener('click', closeHandler);
            };
            setTimeout(() => document.addEventListener('click', closeHandler), 0);
        });

        row.appendChild(statusBadge);

        // 点击单行编辑 (非 Badge 区域)
        row.addEventListener('click', (e) => {
            e.stopPropagation(); // 防止冒泡
            if (rec.id && typeof editSchedule === 'function') {
                editSchedule(rec.id);
            }
        });

        listDiv.appendChild(row);
    });
    card.appendChild(listDiv);

    // Separator
    const divider = document.createElement('div');
    divider.classList.add('schedule-divider');
    card.appendChild(divider);

    // --- Footer Section (Time & Location) ---
    const footer = document.createElement('div');
    footer.classList.add('schedule-footer');

    const timeDiv = document.createElement('div');
    timeDiv.classList.add('time-range');
    timeDiv.textContent = `${first.start_time?.substring(0, 5) || ''} - ${first.end_time?.substring(0, 5) || ''}`;
    footer.appendChild(timeDiv);

    const locDiv = document.createElement('div');
    locDiv.classList.add('location-text');
    locDiv.textContent = first.location || '地点待定';
    footer.appendChild(locDiv);

    // --- Admin Fee Section ---
    // 始终渲染，通过 display 控制可见性（切换时不需重载）
    const feeShow = window.adminFeeShow || false;
    let totalTransport = 0;
    let totalOther = 0;
    group.forEach(s => {
        totalTransport += parseFloat(s.transport_fee) || 0;
        totalOther += parseFloat(s.other_fee) || 0;
    });
    const hasFee = totalTransport > 0 || totalOther > 0;

    const feeWrap = document.createElement('div');
    feeWrap.classList.add('fee-bottom-wrap');
    feeWrap.style.cssText = `display: ${feeShow ? 'flex' : 'none'}; justify-content: flex-end; width: 100%; border-top: 1px dashed #e2e8f0; padding-top: 6px; margin-top: 6px;`;

    const feeContainer = document.createElement('div');
    feeContainer.style.cssText = 'margin-top: 2px; display: flex; justify-content: center; width: 100%;';

    if (hasFee) {
        const feeInfo = document.createElement('span');
        feeInfo.style.cssText = 'background: #FEF3C7; color: #D97706; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 500; cursor: pointer; display: flex; align-items: center; gap: 4px;';

        let parts = [];
        if (totalTransport > 0) parts.push(`交通¥${totalTransport}`);
        if (totalOther > 0) parts.push(`其他¥${totalOther}`);

        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(feeInfo, `<span>${parts.join(' ')}</span><span class="material-icons-round" style="font-size: 12px; margin-left: 2px;">edit</span>`); } else { feeInfo.innerHTML = `<span>${parts.join(' ')}</span><span class="material-icons-round" style="font-size: 12px; margin-left: 2px;">edit</span>`; }
        feeInfo.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof editSchedule === 'function' && first.id) editSchedule(first.id);
        });
        feeContainer.appendChild(feeInfo);
    } else {
        const feeBtn = document.createElement('button');
        feeBtn.classList.add('add-fee-btn');
        feeBtn.textContent = '添加费用';
        feeBtn.style.cssText = 'padding: 2px 8px; font-size: 11px; min-width: auto; height: 22px; margin: 0 auto; background: white; border: 1px solid #10B981; color: #10B981; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center;';
        feeBtn.onmouseover = () => { feeBtn.style.background = '#F0FDF4'; };
        feeBtn.onmouseout = () => { feeBtn.style.background = 'white'; };
        feeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (typeof editSchedule === 'function' && first.id) editSchedule(first.id);
        });
        feeContainer.appendChild(feeBtn);
    }

    feeWrap.appendChild(feeContainer);
    footer.appendChild(feeWrap);

    card.appendChild(footer);

    return card;
}

// updateScheduleStatus, renderWeeklyLoading, renderWeeklyError have been moved to schedule-utils.js

// 仅显示中文周几列头（周一至周日）
function renderWeeklyHeader(weekDates) {
    const thead = document.getElementById('weeklyHeader');
    if (!thead) return;
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(thead, ''); } else { thead.innerHTML = ''; }
    const tr = document.createElement('tr');
    const thStudent = document.createElement('th');
    thStudent.textContent = '学生';
    thStudent.classList.add('sticky-col', 'student-cell');
    tr.appendChild(thStudent);
    weekDates.forEach(d => {
        const th = document.createElement('th');
        th.innerHTML = formatDayLabel(d); // 使用 innerHTML 渲染两行日期
        // 为匹配与调试添加数据属性：ISO 日期键
        const iso = toISODate(d);
        th.dataset.date = iso;
        th.title = iso;
        tr.appendChild(th);
    });
    thead.appendChild(tr);
}

function renderWeeklyBody(students, schedules, weekDates) {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }
    const dateKeys = weekDates.map(toISODate);

    // 建立索引避免每个单元格重复过滤：key = `${studentId}|${dateISO}` -> [rows]
    const cellIndex = new Map();
    const pushIndex = (sid, iso, row) => {
        const k = `${sid}|${iso}`;
        const list = cellIndex.get(k);
        if (list) { list.push(row); } else { cellIndex.set(k, [row]); }
    };
    (schedules || []).forEach(s => {
        const iso = (typeof s.date === 'string') ? s.date : toISODate(new Date(s.date));
        if (s.student_id != null) {
            pushIndex(String(s.student_id), iso, s);
        } else {
            const ids = String(s.student_ids || '').split(',').map(x => x.trim()).filter(Boolean);
            ids.forEach(id => pushIndex(id, iso, s));
        }
    });

    students.forEach(student => {
        const tr = document.createElement('tr');
        tr.dataset.studentId = student.id;
        const nameTd = document.createElement('td');
        nameTd.textContent = student.name;
        nameTd.classList.add('sticky-col', 'student-cell');
        const st = Number(student.status);
        if (st === 0) {
            nameTd.classList.add('paused');
            nameTd.title = '该学生处于暂停状态';
        }
        tr.appendChild(nameTd);

        dateKeys.forEach(dateKey => {
            const td = document.createElement('td');
            td.classList.add('schedule-cell');
            td.dataset.date = dateKey;
            td.dataset.studentId = student.id;
            const items = cellIndex.get(`${String(student.id)}|${dateKey}`) || [];

            if (items.length === 0) {
                if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(td, '<div class="no-schedule">暂无排课</div>'); } else { td.innerHTML = '<div class="no-schedule">暂无排课</div>'; }
            } else {
                renderGroupedMergedSlots(td, items, student, dateKey);
            }
            // 单元格点击：暂停状态学生禁止排课（不允许新建或编辑）
            td.addEventListener('click', (e) => {
                const stNow = Number(student.status);
                if (stNow === 0 || stNow === -1) {
                    if (window.apiUtils && typeof window.apiUtils.showToast === 'function') {
                        window.apiUtils.showToast('该学生为暂停状态，不能进行排课', 'warning');
                    }
                    return;
                }
                // 点击单元格空白区域：始终打开添加排课（锁定学生与日期）
                openCellEditor({ id: student.id, name: student.name, visit_location: student.visit_location }, dateKey);
            });
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
}

// 周视图自动刷新（仅在“排课管理”页激活时）
if (!window.__weeklyAutoRefreshInit) {
    window.__weeklyAutoRefreshInit = true;
    setInterval(() => {
        const section = document.getElementById('schedule');
        if (section && section.classList.contains('active')) {
            try { loadSchedules(); } catch (_) { }
        }
    }, 15000);
}

// 打开编辑（新建）排课并自动填充学生与日期及默认地点/时间
function openCellEditor(student, isoDate) {
    const formContainer = document.getElementById('scheduleFormContainer');
    const form = document.getElementById('scheduleForm');
    if (!formContainer || !form) return;
    // 加载表单选项后再填充
    loadScheduleFormOptions().then(() => {
        // 设置模式
        form.dataset.mode = 'add';
        form.dataset.id = '';
        document.getElementById('scheduleFormTitle').textContent = '添加排课';
        // 预填学生与日期、默认时间
        const studentSel = form.querySelector('#scheduleStudent');
        const studentReadonlyDiv = form.querySelector('#scheduleStudentReadonly');
        const dateInput = form.querySelector('#scheduleDate');
        const dateReadonlyDiv = form.querySelector('#scheduleDateReadonly');
        const startTimeInput = form.querySelector('#scheduleStartTime');
        const endTimeInput = form.querySelector('#scheduleEndTime');
        const locationInput = form.querySelector('#scheduleLocation');
        if (studentSel) studentSel.value = String(student.id);
        if (dateInput) dateInput.value = isoDate;
        if (startTimeInput) startTimeInput.value = '19:00';
        if (endTimeInput) endTimeInput.value = '22:00';
        if (locationInput) locationInput.value = student.visit_location || '';
        // 锁定学生与日期（不可修改）：显示只读视图并禁用输入控件
        if (studentSel) {
            studentSel.disabled = true;
            studentSel.style.display = 'none';
            if (studentReadonlyDiv) {
                studentReadonlyDiv.textContent = student.name || String(student.id);
                studentReadonlyDiv.style.display = 'block';
            }
        }
        if (dateInput) {
            dateInput.disabled = true;
            dateInput.style.display = 'none';
            if (dateReadonlyDiv) {
                dateReadonlyDiv.textContent = isoDate;
                dateReadonlyDiv.style.display = 'block';
            }
        }
        formContainer.style.display = 'block';
    });
}


// --- Stats logic has been moved to stats-logic.js --- 


// 用户管理相关函数


// --- User logic has been moved to user-logic.js --- 


// --- Schedule UI logic has been moved to schedule-logic.js --- 

// --- Rest of stats logic moved to stats-logic.js ---

// --- showToast moved to ui-layout.js ---

// ============ 导出对话框事件处理 ============
document.addEventListener('DOMContentLoaded', () => {
    // 为"导出数据"按钮添加点击事件
    const exportDialogBtn = document.getElementById('openExportDialogBtn');
    if (exportDialogBtn) {
        exportDialogBtn.addEventListener('click', () => {
            if (window.ExportDialog) {
                const startDate = document.getElementById('startDate')?.value;
                const endDate = document.getElementById('endDate')?.value;
                window.ExportDialog.open({ startDate, endDate });
            } else {
                showToast('导出功能未加载，请刷新页面', 'error');
            }
        });
    }

    // 初始化本地缓存
    setTimeout(() => refreshFullUserCache(), 2000); // 延迟执行以免阻塞主渲染
});
// --- today schedules logic deleted (duplicate of today-logic.js) ---
// --- Teacher availability moved to teacher-availability.js ---
// --- schedule selector moved to schedule-logic.js ---
// --- schedule types moved to schedule-types.js ---

// ==========================================
// MODULARIZATION DELEGATION ADAPTERS
// ==========================================

// User Management Delegation
function showAddUserModal() {
    if (window.UserManager) window.UserManager.showAddUserModal();
}
function showEditUserModal(id, type) {
    if (window.UserManager) window.UserManager.showEditUserModal(type, id);
}
function closeUserFormModal() {
    if (window.UserManager) window.UserManager.closeUserFormModal();
}
async function deleteUser(type, id) {
    if (window.UserManager) return window.UserManager.deleteUser(type, id);
}
async function loadUsers(type, opts) {
    if (window.UserManager) return window.UserManager.loadUsers(type, opts);
}

// Schedule Management Delegation
async function loadSchedules() {
    if (window.ScheduleManager) return window.ScheduleManager.loadSchedules();
}
async function updateScheduleStatus(id, status) {
    if (window.ScheduleManager) return window.ScheduleManager.updateScheduleStatus(id, status);
}
async function deleteSchedule(id) {
    if (window.ScheduleManager) return window.ScheduleManager.deleteSchedule(id);
}
async function editSchedule(id) {
    if (window.ScheduleManager) return window.ScheduleManager.editSchedule(id);
}
function openCellEditor(student, date) {
    if (window.ScheduleManager) window.ScheduleManager.openCellEditor(student, date);
}
async function confirmSchedule(id) {
    if (window.ScheduleManager) return window.ScheduleManager.updateScheduleStatus(id, 'confirmed');
}

// Override setupEventListeners to prevent conflict
function setupEventListeners() {

    // Modules (UserManager, ScheduleManager, UIHelper) attach their own listeners in index.js
}

// ==========================================
// Sidebar Navigation Handler (Ensure Data Load)
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const section = item.dataset.section;
            // Handle User Management
            if (section === 'users') {
                if (window.UserManager && window.UserManager.loadUsers) {
                    // Default to 'teacher' tab if not set, or reload current state
                    const state = window.__usersState || { type: 'teacher' };
                    // Force refresh to ensure data is displayed
                    window.UserManager.loadUsers(state.type, { reset: true });
                } else {

                }
            }
            // Handle Course Type Management
            else if (section === 'schedule-types') {
                if (typeof loadScheduleTypes === 'function') {
                    loadScheduleTypes();
                }
            }
        });
    });
});

// =========================================================================
// Admin Dashboard - Legacy Adapter Module
// =========================================================================
// 负责整体数据加载、页面导航和事件绑定

/**
 * ==========================================================================
 * Admin Overview Reward Modal Functions
 * ==========================================================================
 */
// --- Admin reward moved to admin-reward.js ---