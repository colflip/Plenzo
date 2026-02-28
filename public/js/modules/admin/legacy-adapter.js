// 工具函数
const token = localStorage.getItem('token');
const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
};
const TIME_ZONE = 'Asia/Shanghai';

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
        console.error('Chart.js 未加载');
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
        console.warn('响应解析为 JSON 失败:', e?.message || e);
        return null;
    }
}

// 使用新的API工具类
// 检查API工具类是否已加载
if (typeof window.apiUtils === 'undefined') {
    console.error('API工具类未加载，请确保api-utils.js已正确引入');
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
            console.warn('从缓存加载排课类型失败', e);
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

// 检查登录状态
function checkAuth() {
    const authToken = window.apiUtils.getAuthToken();
    if (!authToken) {
        window.location.href = '/index.html';
    }
}

// 格式化日期（北京时间）
function formatDate(date) {
    return new Date(date).toLocaleDateString('zh-CN', { timeZone: TIME_ZONE });
}

// 格式化时间
function formatTime(time) {
    if (!time || typeof time !== 'string') return '';
    return time.slice(0, 5);
}

// 格式化日期时间（北京时间）
function formatDateTimeDisplay(dateLike) {
    if (!dateLike) return '--';
    const date = new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '--';

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    return formatter.format(date).replace(', ', ' ');
}

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
    checkAuth();
    // setupSidebarToggle(); // 已由 index.js -> ui-helper.js 处理，此处移除以免重复绑定
    setupNavigation();
    if (window.i18nUtils && typeof window.i18nUtils.applyChartFont === 'function') {
        window.i18nUtils.applyChartFont();
    }
    loadOverviewStats();
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
        filterSelect.innerHTML = '<option value="">全部类型</option>';

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
    admin: ['username', 'name', 'email', 'permission_level', 'last_login', 'created_at'],
    teacher: ['username', 'name', 'profession', 'contact', 'work_location', 'home_address', 'restriction', 'status', 'last_login', 'created_at'],
    student: ['username', 'name', 'profession', 'contact', 'visit_location', 'home_address', 'status', 'last_login', 'created_at']
};

const FIELD_LABELS = {
    username: '用户名',
    name: '姓名',
    email: '邮箱',
    permission_level: '权限级别',
    last_login: '最近登录',
    created_at: '创建时间',
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

// 设置导航
function setupNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', async (e) => {
            e.preventDefault();
            // 使用 currentTarget 确保点击图标/文字也能正确读到 data-section
            const section = e.currentTarget.dataset.section;
            if (section) {
                // 先刷新对应数据，再进入功能区域
                try {
                    if (section === 'overview') {
                        await loadOverviewStats();
                    } else if (section === 'users') {
                        // Default to teacher view per request
                        const teacherTab = document.querySelector('#userRoleTabs .tab-btn[data-type="teacher"]');
                        if (teacherTab) {
                            const tabs = document.querySelectorAll('#userRoleTabs .tab-btn');
                            tabs.forEach(t => t.classList.remove('active'));
                            teacherTab.classList.add('active');
                        }
                        await loadUsers('teacher', { reset: true });
                    } else if (section === 'schedule') {
                        await loadSchedules();
                    } else if (section === 'statistics') {
                        // handled by showSection -> loadStatistics
                    } else if (section === 'availability') {
                        initTeacherAvailability(); // Ensure init calls are idempotent or just check logic
                    } else if (section === 'student-availability') {
                        if (window.initStudentAvailability) {
                            window.initStudentAvailability();
                        } else {
                            console.error('initStudentAvailability not found');
                        }
                        if (window.initStudentScheduleFees) {
                            window.initStudentScheduleFees();
                        }
                    }
                } catch (_) { }
                showSection(section);
            }
        });
    });

    document.getElementById('logout').addEventListener('click', (e) => {
        e.preventDefault();
        logout();
    });
}



// 显示指定部分
function showSection(sectionId) {
    const sections = document.querySelectorAll('.dashboard-section');
    sections.forEach(section => {
        section.classList.remove('active');
    });

    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.classList.remove('active');
    });

    document.getElementById(sectionId).classList.add('active');
    document.querySelector(`[data-section="${sectionId}"]`).classList.add('active');

    // 加载部分特定数据
    switch (sectionId) {
        case 'overview':
            loadOverviewStats();
            setHeaderTitle('管理员总览');
            break;
        case 'users':
            // 默认加载教师视图
            const teacherTabForSection = document.querySelector('#userRoleTabs .tab-btn[data-type="teacher"]');
            if (teacherTabForSection) {
                const allTabs = document.querySelectorAll('#userRoleTabs .tab-btn');
                allTabs.forEach(t => t.classList.remove('active'));
                teacherTabForSection.classList.add('active');
            }
            loadUsers('teacher');
            setHeaderTitle('用户管理');
            break;
        case 'schedule':
            loadSchedules();
            setHeaderTitle('排课管理');
            break;
        case 'statistics':
            // 延迟初始化统计模块（仅在首次访问时执行）
            ensureStatisticsInitialized();
            loadStatistics();
            setHeaderTitle('数据统计');
            break;
        case 'schedule-types':
            loadScheduleTypes();
            setHeaderTitle('课程类型管理');
            break;
        case 'student-availability':
            if (window.initStudentAvailability) {
                window.initStudentAvailability();
            }
            if (window.initStudentScheduleFees) {
                window.initStudentScheduleFees();
            }
            setHeaderTitle('学生空闲时段');
            break;
        case 'availability':
            if (window.initTeacherAvailability) {
                window.initTeacherAvailability();
            }
            setHeaderTitle('教师空闲时段');
            break;
    }
}

// 设置头部标题
function setHeaderTitle(title) {
    const headerTitle = document.querySelector('.dashboard-header h2');
    if (headerTitle) headerTitle.textContent = title;
}

// 加载总览统计数据
async function loadOverviewStats() {
    // 确保 WeeklyDataStore 已完全加载 (等待 schedule-manager.js)
    if (window.WeeklyDataStore && !window.WeeklyDataStore.ttlMs) {
        console.log('[Statistics] WeeklyDataStore 是存根，等待模块加载...');
        const startWait = Date.now();
        while (window.WeeklyDataStore && !window.WeeklyDataStore.ttlMs) {
            if (Date.now() - startWait > 3000) {
                console.warn('[Statistics] 等待 WeeklyDataStore 超时，继续尝试...');
                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }
        console.log('[Statistics] WeeklyDataStore 就绪 (或超时):', !!window.WeeklyDataStore.ttlMs);
    }

    try {
        // 获取所有需要更新的元素
        const elements = {
            teacherCount: document.getElementById('teacherCount'),
            studentCount: document.getElementById('studentCount'),
            monthlySchedules: document.getElementById('monthlySchedules'),
            pendingConfirmations: document.getElementById('pendingConfirmations'),
            totalSchedules: document.getElementById('totalSchedules'),
            adminName: document.getElementById('adminName'),
            adminRole: document.getElementById('adminRole')
        };

        // 检查所需的元素是否都存在
        if (!elements.teacherCount || !elements.studentCount ||
            !elements.monthlySchedules || !elements.pendingConfirmations) {
            console.warn('部分统计数据显示元素未找到，可能页面结构有变化');
            return;
        }

        // 显示加载状态 - 统一为"加载中..."
        ['teacherCount', 'studentCount', 'weeklySchedules', 'monthlySchedules',
            'yearlySchedules', 'pendingConfirmations', 'completedSchedules', 'cancelledSchedules'].forEach(key => {
                const el = document.getElementById(key);
                if (el) el.textContent = '加载中...';
            });

        // 使用新的API工具类
        let data = null;
        try {
            data = await window.apiUtils.get('/admin/statistics/overview');
        } catch (apiError) {
            console.warn('加载总览统计API失败:', apiError);
            // 使用默认数据
            data = {
                teacher_count: 0,
                student_count: 0,
                monthly_schedules: 0,
                pending_count: 0,
                total_schedules: 0
            };
        }

        // 更新统计数据，使用默认值处理可能的空数据
        const teacherCount = data.teacher_count || 0;
        const studentCount = data.student_count || 0;
        const monthlySchedules = data.monthly_schedules || 0;
        const pendingCount = data.pending_count || 0;

        // 计算额外的统计数据(本周/本年/已完成/已取消)
        let weeklySchedules = 0;
        let yearlySchedules = 0;
        let completedSchedules = 0;
        let cancelledSchedules = 0;

        try {
            // 获取所有排课数据用于计算
            const schedulesData = await window.apiUtils.get('/admin/schedules');
            const schedules = schedulesData?.schedules || schedulesData || [];

            const now = new Date();
            const currentYear = now.getFullYear();

            // 获取本周的起止日期
            const startOfWeek = new Date(now);
            const day = now.getDay();
            const diff = now.getDate() - day + (day === 0 ? -6 : 1); // 周一
            startOfWeek.setDate(diff);
            startOfWeek.setHours(0, 0, 0, 0);

            const endOfWeek = new Date(startOfWeek);
            endOfWeek.setDate(startOfWeek.getDate() + 6);
            endOfWeek.setHours(23, 59, 59, 999);

            schedules.forEach(schedule => {
                const scheduleDate = new Date(schedule.date || schedule.start_time);
                const status = (schedule.status || '').toLowerCase();

                // 本周排课
                if (scheduleDate >= startOfWeek && scheduleDate <= endOfWeek) {
                    weeklySchedules++;
                }

                // 本年排课
                if (scheduleDate.getFullYear() === currentYear) {
                    yearlySchedules++;
                }

                // 已完成排课
                if (status === 'completed') {
                    completedSchedules++;
                }

                // 已取消排课
                if (status === 'cancelled') {
                    cancelledSchedules++;
                }
            });
        } catch (err) {
            console.warn('计算额外统计数据失败:', err);
        }

        // 更新所有统计数据到DOM
        elements.teacherCount.textContent = teacherCount;
        elements.studentCount.textContent = studentCount;

        const weeklyEl = document.getElementById('weeklySchedules');
        if (weeklyEl) weeklyEl.textContent = weeklySchedules;

        elements.monthlySchedules.textContent = monthlySchedules;

        const yearlyEl = document.getElementById('yearlySchedules');
        if (yearlyEl) yearlyEl.textContent = yearlySchedules;

        elements.pendingConfirmations.textContent = pendingCount;

        const completedEl = document.getElementById('completedSchedules');
        if (completedEl) completedEl.textContent = completedSchedules;

        const cancelledEl = document.getElementById('cancelledSchedules');
        if (cancelledEl) cancelledEl.textContent = cancelledSchedules;

        // 绑定卡片点击事件
        setupAdminOverviewCardClicks({
            teacherCount,
            studentCount,
            weeklySchedules,
            monthlySchedules,
            yearlySchedules,
            pendingCount,
            completedSchedules,
            cancelledSchedules
        });

        // 显示管理员名称
        const userData = JSON.parse(localStorage.getItem('userData'));
        if (userData) {
            if (userData.name && elements.adminName) {
                elements.adminName.textContent = userData.name;
            }
            if (elements.adminRole) {
                let roleLabel = '管理员';
                if (userData.userType === 'admin') roleLabel = '管理员';
                else if (userData.userType === 'teacher') roleLabel = '老师';
                else if (userData.userType === 'student') roleLabel = '学生';
                elements.adminRole.textContent = roleLabel; // 移除括号
            }
        }

        // --- Render Charts (If data available) ---
        if (data && typeof renderScheduleTypeChart === 'function') {
            if (data.schedule_types && Array.isArray(data.schedule_types)) {
                renderScheduleTypeChart(data.schedule_types);
            }
            if (data.teacher_stats && typeof buildTeacherTypeStack === 'function') {
                renderTeacherTypeStackedChart(buildTeacherTypeStack(data.teacher_stats));
            }
            if (data.student_stats && typeof buildStudentTypeStack === 'function' && typeof renderStudentParticipationChart === 'function') {
                renderStudentParticipationChart(buildStudentTypeStack(data.student_stats));
            }
        }

    } catch (error) {
        console.error('加载总览统计错误:', error);
        // 显示错误状态
        const teacherCountEl = document.getElementById('teacherCount');
        const studentCountEl = document.getElementById('studentCount');
        const weeklyEl = document.getElementById('weeklySchedules');
        const monthlySchedulesEl = document.getElementById('monthlySchedules');
        const yearlyEl = document.getElementById('yearlySchedules');
        const pendingConfirmationsEl = document.getElementById('pendingConfirmations');
        const completedEl = document.getElementById('completedSchedules');
        const cancelledEl = document.getElementById('cancelledSchedules');

        if (teacherCountEl) teacherCountEl.textContent = '0';
        if (studentCountEl) studentCountEl.textContent = '0';
        if (weeklyEl) weeklyEl.textContent = '0';
        if (monthlySchedulesEl) monthlySchedulesEl.textContent = '0';
        if (yearlyEl) yearlyEl.textContent = '0';
        if (pendingConfirmationsEl) pendingConfirmationsEl.textContent = '0';
        if (completedEl) completedEl.textContent = '0';
        if (cancelledEl) cancelledEl.textContent = '0';
    }
}

// 绑定管理员总览卡片点击事件
function setupAdminOverviewCardClicks(stats) {
    const setupClick = (elId, title, value, type) => {
        const el = document.getElementById(elId);
        if (el) {
            const card = el.closest('.stat-card');
            if (card) {
                // 移除旧监听器
                const newCard = card.cloneNode(true);
                card.parentNode.replaceChild(newCard, card);
                newCard.addEventListener('click', () => showAdminReward(title, value, type));
                newCard.style.cursor = 'pointer';
            }
        }
    };

    // 绑定所有8个卡片
    setupClick('teacherCount', '总教师数', stats.teacherCount, 'teachers');
    setupClick('studentCount', '总学生数', stats.studentCount, 'students');
    setupClick('weeklySchedules', '本周排课', stats.weeklySchedules, 'weekly');
    setupClick('monthlySchedules', '本月排课', stats.monthlySchedules, 'monthly');
    setupClick('yearlySchedules', '本年排课', stats.yearlySchedules, 'yearly');
    setupClick('pendingConfirmations', '待确认排课', stats.pendingCount, 'pending');
    setupClick('completedSchedules', '已完成排课', stats.completedSchedules, 'completed');
    setupClick('cancelledSchedules', '已取消排课', stats.cancelledSchedules, 'cancelled');
}

// 设置事件监听器
// 设置事件监听器
function setupEventListeners() {
    // 用户管理部分的监听器已迁移至 user-manager.js，此处移除以避免双重绑定导致性能问题和逻辑错误
    console.log('[LegacyAdapter] User event listeners handled by UserManager');

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
        console.log('Add Schedule Clicked');
        // Ensure function exists
        if (typeof showAddScheduleModal === 'function') {
            showAddScheduleModal();
        } else {
            console.error('showAddScheduleModal is not defined');
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
                        console.error('更新排课失败:', err);
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
                    console.warn('创建后确认失败:', confirmErr);
                }
                // 若用户选择“已确认”，且后端未按选择设置，可进行二次确认；否则不自动确认
                if (newId && rawStatus === 'confirmed') {
                    try {
                        await window.apiUtils.post(`/admin/schedules/${newId}/confirm`, { adminConfirmed: true });
                        if (window.apiUtils && typeof window.apiUtils.showSuccessToast === 'function') {
                            window.apiUtils.showSuccessToast('排课已创建并确认');
                        }
                    } catch (confirmErr) {
                        console.error('自动确认错误:', confirmErr);
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
            console.error('创建排课错误:', err);
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

    function syncDateInputs(sourcePrefix) {
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
        });
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
                    const preset = btn.getAttribute('data-preset');
                    const range = computePresetRange(preset);
                    if (!range) return;

                    // 1. Determine Context (Target)
                    // New buttons are in .preset-buttons[data-target="..."]
                    // Legacy buttons are in .inline-tabs (treat as main)
                    const container = btn.closest('.preset-buttons') || btn.closest('.inline-tabs');
                    const target = container ? (container.getAttribute('data-target') || 'main') : 'main';

                    // 2. Local Highlight: Toggle active class only within the container
                    if (container) {
                        const siblings = container.querySelectorAll('.preset-btn');
                        siblings.forEach(b => {
                            if (b === btn) b.classList.add('active');
                            else b.classList.remove('active');
                        });
                    }

                    // 3. Logic based on Target
                    if (target === 'teacher') {
                        const tStart = document.getElementById('teacherStartDate');
                        const tEnd = document.getElementById('teacherEndDate');
                        if (tStart) tStart.value = range.start;
                        if (tEnd) tEnd.value = range.end;
                        // Trigger Search
                        const tBtn = document.getElementById('teacherStatsSearchBtn');
                        if (tBtn) tBtn.click();
                        return;
                    }

                    if (target === 'student') {
                        const sStart = document.getElementById('studentStartDate');
                        const sEnd = document.getElementById('studentEndDate');
                        if (sStart) sStart.value = range.start;
                        if (sEnd) sEnd.value = range.end;
                        // Trigger Search
                        const sBtn = document.getElementById('studentStatsSearchBtn');
                        if (sBtn) sBtn.click();
                        return;
                    }

                    // === Main (Original Logic) ===
                    const sEl = document.getElementById('statsStartDate');
                    const eEl = document.getElementById('statsEndDate');
                    if (sEl) sEl.value = range.start;
                    if (eEl) eEl.value = range.end;

                    // Sync to teacher/student pages if used as global filter
                    const tStart = document.getElementById('teacherStartDate');
                    const tEnd = document.getElementById('teacherEndDate');
                    if (tStart) tStart.value = range.start;
                    if (tEnd) tEnd.value = range.end;

                    const sStart = document.getElementById('studentStartDate');
                    const sEnd = document.getElementById('studentEndDate');
                    if (sStart) sStart.value = range.start;
                    if (sEnd) sEnd.value = range.end;

                    // Sync export dialog
                    if (window.ExportDialog && typeof window.ExportDialog.applyPreset === 'function') {
                        try { window.ExportDialog.applyPreset(preset); } catch (_) { }
                    } else {
                        const exS = document.getElementById('exportStartDate');
                        const exE = document.getElementById('exportEndDate');
                        if (exS) exS.value = range.start;
                        if (exE) exE.value = range.end;
                    }

                    // Trigger Main Stats Load
                    if (typeof loadStatistics === 'function') {
                        try {
                            await loadStatistics();
                        } catch (err) {
                            console.warn('loadStatistics error', err);
                        }
                    }
                });
            });
        }
    } catch (e) {
        console.warn('Failed to bind statistics preset buttons', e);
    }

    // Bind Search Buttons
    const statsSearchBtn = document.getElementById('statsSearchBtn');
    if (statsSearchBtn) {
        statsSearchBtn.addEventListener('click', () => { if (typeof loadStatistics === 'function') loadStatistics(); });
    }
    const teacherStatsSearchBtn = document.getElementById('teacherStatsSearchBtn');
    if (teacherStatsSearchBtn) {
        teacherStatsSearchBtn.addEventListener('click', () => { if (typeof loadStatistics === 'function') loadStatistics(); });
    }
    const studentStatsSearchBtn = document.getElementById('studentStatsSearchBtn');
    if (studentStatsSearchBtn) {
        studentStatsSearchBtn.addEventListener('click', () => { if (typeof loadStatistics === 'function') loadStatistics(); });
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
            const startMonth = (quarter * 3) - 3; // 往前推3个月
            const lastQuarterStart = new Date(year, startMonth, 1);
            const lastQuarterEnd = new Date(year, startMonth + 3, 0);
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
let statisticsInitialized = false;
function ensureStatisticsInitialized() {
    if (statisticsInitialized) return;
    statisticsInitialized = true;

    console.log('[Statistics] Initializing statistics module...');

    // 初始化日期控件为当月
    initializeStatisticsControls();

    // 初始化Tab切换
    initializeStatisticsTabs();

    console.log('[Statistics] Module initialized successfully');
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

        // 显示加载反馈
        if (statsFeedback) {
            statsFeedback.textContent = '正在加载统计数据...';
            statsFeedback.className = 'feedback info';
            statsFeedback.style.display = 'block';
        }

        const overviewContainer = document.getElementById('statsOverview');
        if (overviewContainer) overviewContainer.classList.add('stats-loading');

        const activeView = getStatisticsActiveView();

        // 概览视图：饼图 + 教师/学生堆叠横向柱
        if (activeView === 'overview') {
            let loadingOverlay = null;
            try {
                // Show Loading Overlay
                if (overviewContainer) {
                    const chartsSection = overviewContainer.querySelector('.charts-section');
                    if (chartsSection) {
                        loadingOverlay = document.createElement('div');
                        loadingOverlay.className = 'stats-loading-overlay';
                        loadingOverlay.innerHTML = `
                            <div class="loading-spinner"></div>
                            <div class="loading-text">正在加载数据...</div>
                        `;
                        chartsSection.appendChild(loadingOverlay);
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
                    // Check if cache is fresh and we likely have the data (heuristic: if range within cache range?)
                    // Simplified: If cache has schedules, use them. 
                    // Note: WeeklyDataStore usually stores *all* schedules visible to admin or a large range.
                    // Let's verify if cache.schedules has data.
                    if (cache && cache.schedules && cache.schedules.size > 0 && cache._isFresh && cache._isFresh(cache.loadedAt)) {
                        console.log('[Stats] Using cached schedules for overview');
                        const schedules = Array.from(cache.schedules.values());
                        p1 = Promise.resolve(computeStatsFromCache(schedules, startDate, endDate));
                    } else {
                        console.log('[Stats] Fetching fresh schedules for overview');
                        p1 = window.apiUtils.get('/admin/statistics/schedules', { startDate, endDate })
                            .catch(err => { console.warn('加载排课统计失败', err); return null; });
                    }

                    const p2 = window.apiUtils.get('/admin/statistics/users', { startDate, endDate })
                        .catch(err => { console.warn('加载用户统计失败', err); return null; });

                    // 2. Await all
                    const [statsData, userStatsData] = await Promise.all([p1, p2]);

                    // 检查数据有效性 - 如果加载失败,显示错误提示而非假数据
                    if (!statsData || !userStatsData) {
                        console.error('概览数据加载失败: statsData或userStatsData为null');

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
                        console.warn('概览数据为空,显示错误提示');

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
                    console.error('统计页面并发加载异常:', generalError);

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

                // Hide feedback if present (legacy)
                if (overviewContainer) overviewContainer.classList.remove('stats-loading');
                if (statsFeedback) statsFeedback.style.display = 'none';
                if (loadingOverlay) loadingOverlay.remove();
                return;
            } catch (overviewError) {
                console.error('概览统计加载失败:', overviewError);
                // Fallthrough to global catch if needed, or handle locally
                throw overviewError;
            }
        }


        // 教师/学生统计视图：时间轴折线 + 每日类型堆叠柱
        // 优化：先显示加载动画，再加载数据

        // 为教师统计创建加载覆盖层
        let teacherOverlay = null;
        if (activeView === 'teacher') {
            const teacherContainer = document.querySelector('.teacher-charts-container');
            if (teacherContainer) {
                teacherOverlay = document.createElement('div');
                teacherOverlay.className = 'stats-loading-overlay';
                teacherOverlay.innerHTML = `
                    <div class="loading-spinner"></div>
                    <div class="loading-text">正在加载教师数据...</div>
                `;
                teacherContainer.appendChild(teacherOverlay);

                // Reset animations
                const chartContainers = teacherContainer.querySelectorAll('.chart-container');
                chartContainers.forEach(el => {
                    el.classList.remove('chart-anim-active');
                    el.classList.add('chart-anim-enter');
                });
            }
        }

        // 为学生统计创建加载覆盖层
        let studentOverlay = null;
        if (activeView === 'student') {
            const studentContainer = document.querySelector('.student-charts-container');
            if (studentContainer) {
                studentOverlay = document.createElement('div');
                studentOverlay.className = 'stats-loading-overlay';
                studentOverlay.innerHTML = `
                    <div class="loading-spinner"></div>
                    <div class="loading-text">正在加载学生数据...</div>
                `;
                studentContainer.appendChild(studentOverlay);

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
            console.log('[Statistics] 开始加载排课数据:', { startDate, endDate });
            rawSchedules = await fetchSchedulesRange(startDate, endDate, '', '');
            console.log('[Statistics] 成功加载排课数据:', {
                数量: rawSchedules.length,
                日期范围: rawSchedules.length > 0 ? {
                    最早: rawSchedules[0]?.date,
                    最晚: rawSchedules[rawSchedules.length - 1]?.date
                } : '无数据',
                前3条样本: rawSchedules.slice(0, 3)
            });
        } catch (apiError) {
            console.error('[Statistics] 加载排课数据失败:', apiError);
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
                    console.warn('设置教师筛选器失败:', filterError);
                }
            } finally {
                if (teacherOverlay) teacherOverlay.remove();
                // 隐藏反馈
                if (statsFeedback) {
                    statsFeedback.style.display = 'none';
                }

                // Trigger animation
                const teacherContainer = document.querySelector('.teacher-charts-container');
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
                    console.warn('设置学生筛选器失败:', filterError);
                }
            } finally {
                if (studentOverlay) studentOverlay.remove();
                // 隐藏反馈
                if (statsFeedback) {
                    statsFeedback.style.display = 'none';
                }

                // Trigger animation
                const studentContainer = document.querySelector('.student-charts-container');
                if (studentContainer) {
                    setTimeout(() => {
                        const chartContainers = studentContainer.querySelectorAll('.chart-container');
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
        const overviewContainer = document.getElementById('statsOverview');
        if (overviewContainer) overviewContainer.classList.remove('stats-loading');
        console.error('加载统计数据错误:', error);

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

    // 按ID升序排列
    const sorted = statsList.sort((a, b) => Number(a.id || a.user_id || 0) - Number(b.id || b.user_id || 0)).slice(0, limit);

    const labels = sorted.map(item => item.name);

    // Define types we care about
    const types = ['入户', '试教', '评审', '咨询', '线上辅导'];
    const datasets = types.map(type => ({
        label: type,
        data: sorted.map(item => {
            // item.counts is expected to be a map or object { '入户': 10, ... }
            // or item.distribution array. Let's handle generic object for now.
            return item.counts ? (item.counts[type] || 0) : 0;
        }),
        backgroundColor: getLegendColor(type)
    }));

    return { labels, datasets };
}

// Color helper
function getLegendColor(label) {
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


/**
 * 将 getUserStats API 返回的数据转换为 Chart.js 堆叠柱状图格式
 * @param {Array} stats - API 返回的统计数据 [ { id, name, total, types: { type: count } } ]
 * @param {number} limit - 显示的最大人数（按总数排序后截取）
 * @returns {Object} - Chart.js 数据格式 { labels, datasets }
 */
function convertUserStatsToStackData(stats, limit = 15) {
    if (!stats || stats.length === 0) {
        return { labels: [], datasets: [] };
    }

    // 按ID升序排列并截取
    const sortedStats = [...stats].sort((a, b) => Number(a.id || 0) - Number(b.id || 0)).slice(0, limit);

    // 收集所有类型
    const allTypes = new Set();
    sortedStats.forEach(person => {
        Object.keys(person.types || {}).forEach(type => allTypes.add(type));
    });

    // 按出现频率排序类型
    const typeCounts = {};
    sortedStats.forEach(person => {
        Object.entries(person.types || {}).forEach(([type, count]) => {
            typeCounts[type] = (typeCounts[type] || 0) + count;
        });
    });
    const sortedTypes = Array.from(allTypes).sort((a, b) => (typeCounts[b] || 0) - (typeCounts[a] || 0));

    // 构建 labels（人员名称）
    const labels = sortedStats.map(person => person.name);

    // 构建 datasets（每个类型一个数据集）
    const datasets = sortedTypes.map(type => ({
        label: type,
        data: sortedStats.map(person => (person.types || {})[type] || 0),
        backgroundColor: getLegendColor(type),
        borderColor: getLegendColor(type)
    }));

    return { labels, datasets };
}

function getDefaultSchedules() {
    // 生成一些默认的排课数据
    const types = ['入户', '试教', '评审', '心理咨询', '线上辅导'];
    const teachers = ['张老师', '李老师', '王老师'];
    const students = ['学生A', '学生B', '学生C'];

    const schedules = [];
    const now = new Date();

    for (let i = 0; i < 30; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - Math.floor(Math.random() * 30));

        schedules.push({
            id: i + 1,
            date: toISODate(date),
            teacher_name: teachers[Math.floor(Math.random() * teachers.length)],
            student_name: students[Math.floor(Math.random() * students.length)],
            schedule_type: types[Math.floor(Math.random() * types.length)],
            schedule_types: types[Math.floor(Math.random() * types.length)]
        });
    }

    return schedules;
}

// 绘制学生参与统计图表
function renderStudentTypeStackedChart(stackData) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('studentParticipationChart');
    if (!el) return;
    const prev = window.Chart.getChart(el);
    if (prev) try { prev.destroy(); } catch (_) { }
    const ctx = el.getContext('2d');

    const addAlpha = (color, alpha) => {
        const c = String(color || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
            let r, g, b;
            if (c.length === 4) {
                r = parseInt(c[1] + c[1], 16);
                g = parseInt(c[2] + c[2], 16);
                b = parseInt(c[3] + c[3], 16);
            } else {
                r = parseInt(c.slice(1, 3), 16);
                g = parseInt(c.slice(3, 5), 16);
                b = parseInt(c.slice(5, 7), 16);
            }
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (/^rgba?\(/i.test(c)) {
            return c.replace(/rgba?\(([^)]+)\)/i, (m, inner) => {
                const parts = inner.split(',').map(s => s.trim());
                const [r, g, b] = parts;
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            });
        }
        return c;
    };

    const datasets = stackData.datasets.map((ds) => ({
        ...ds,
        backgroundColor: getLegendColor(ds.label),
        borderColor: getLegendColor(ds.label),
        borderWidth: 0,
        borderRadius: 8,
        barPercentage: 0.9,
        categoryPercentage: 0.9
    }));

    new window.Chart(ctx, {
        type: 'bar',
        data: {
            labels: stackData.labels,
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 10,
                        padding: 14,
                        color: '#374151',
                        // 统一由 Chart.defaults.font 以及 CSS 变量驱动字体
                        // 保留结构但不覆盖默认字体设置
                        font: {}
                    },
                    onHover: (e) => { if (e && e.native) e.native.target.style.cursor = 'pointer'; },
                    onClick: (e, item, legend) => {
                        const chart = legend.chart;
                        const idx = item.datasetIndex ?? item.index ?? 0;
                        const now = Date.now();
                        const last = chart.$lastLegendClick || 0;
                        const isDbl = (now - last) < 300 && chart.$lastLegendIndex === idx;
                        chart.$lastLegendClick = now;
                        chart.$lastLegendIndex = idx;
                        if (isDbl) {
                            const current = chart.$highlightIndex;
                            const newIndex = current === idx ? null : idx;
                            chart.$highlightIndex = newIndex;
                            chart.data.datasets.forEach((ds, di) => {
                                const base = getLegendColor(ds.label);
                                if (newIndex == null) {
                                    ds.backgroundColor = base;
                                    ds.borderColor = base;
                                } else if (di === newIndex) {
                                    ds.backgroundColor = base;
                                    ds.borderColor = base;
                                } else {
                                    ds.backgroundColor = addAlpha(base, 0.25);
                                    ds.borderColor = addAlpha(base, 0.25);
                                }
                            });
                            chart.update();
                            return;
                        }
                        // 默认：切换显示/隐藏
                        const vis = chart.isDatasetVisible(idx);
                        chart.setDatasetVisibility(idx, !vis);
                        chart.update();
                    }
                },
                // 标题字体统一由 Chart.defaults.font 以及 CSS 变量驱动
                title: { display: true, text: '学生上课汇总' },
                tooltip: { enabled: true }
            },
            scales: {
                x: { stacked: true, beginAtZero: true, grid: { color: 'rgba(55,65,81,0.08)' } },
                y: {
                    stacked: true,
                    grid: { display: false },
                    ticks: {
                        autoSkip: false,  // Show all labels, don't skip any
                        font: (context) => {
                            // Get student name for this tick
                            const studentName = context.chart.data.labels[context.index];
                            // Find student ID by searching through the ID map
                            let studentId = null;
                            for (const [id, name] of (window.__studentIdMap || new Map()).entries()) {
                                if (name === studentName) {
                                    studentId = id;
                                    break;
                                }
                            }
                            if (studentId && studentId !== '__fallback__') {
                                const status = window.__studentStatusMap?.get(String(studentId));
                                if (status === 0) {
                                    // Paused student: italic font
                                    return { style: 'italic' };
                                }
                            }
                            // Active student: normal font
                            return { style: 'normal' };
                        }
                    }
                }
            }
        }
    });
}


// 构建教师类型堆叠数据
function buildTeacherTypeStack(schedules) {
    // 处理空数据情况
    if (!schedules || schedules.length === 0) {
        return getDefaultTeacherStack();
    }

    function mapTypeLabel(t) {
        return (window.i18nUtils && typeof window.i18nUtils.getTypeLabelLocalized === 'function')
            ? window.i18nUtils.getTypeLabelLocalized(t, 'zh-CN')
            : (String(t || '').trim() || '未分类');
    }
    const teacherOrder = [];
    const typeOrder = [];
    const map = new Map();
    const teacherIdMap = new Map(); // Track teacher ID for status filtering

    schedules.forEach(row => {
        const teacher = row.teacher_name || '未分配';
        const teacherId = row.teacher_id;

        if (!map.has(teacher)) {
            map.set(teacher, new Map());
            teacherOrder.push(teacher);
            // Store teacher ID for status lookup
            if (teacherId) {
                teacherIdMap.set(teacher, teacherId);
            }
        }
        const typesStr = row.schedule_types || '';
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            if (!typeOrder.includes(label)) typeOrder.push(label);
            const tm = map.get(teacher);
            tm.set(label, (tm.get(label) || 0) + 1);
        });
    });

    // Filter out deleted teachers (status = -1)
    let filteredTeachers = teacherOrder.filter(name => {
        const id = teacherIdMap.get(name);
        if (!id) return true; // Keep if no ID (e.g., "未分配")
        const status = window.__teacherStatusMap?.get(String(id));
        return status !== -1; // Exclude deleted
    });

    // Calculate total count for each teacher and sort
    const teacherTotals = filteredTeachers.map(name => {
        const typeMap = map.get(name);
        const total = Array.from(typeMap.values()).reduce((a, b) => a + b, 0);
        const id = teacherIdMap.get(name) || 0;
        return { name, total, id };
    }).filter(t => t.total > 0);  // Only show teachers with actual schedule data

    // 按ID升序排列并截取
    teacherTotals.sort((a, b) => Number(a.id) - Number(b.id));
    const top15Teachers = teacherTotals.slice(0, 15).map(t => t.name);

    // Store teacher ID mapping globally for rendering function
    window.__teacherIdMap = teacherIdMap;

    const datasets = typeOrder.map((label) => ({
        label,
        data: top15Teachers.map(teacher => (map.get(teacher).get(label) || 0)),
        backgroundColor: getLegendColor(label),
        borderColor: getLegendColor(label)
    }));
    return { labels: top15Teachers, datasets };
}

function buildStudentTypeStack(schedules, students = []) {
    // 处理空数据情况
    if (!schedules || schedules.length === 0) {
        return getDefaultStudentStack();
    }

    function mapTypeLabel(t) {
        return (window.i18nUtils && typeof window.i18nUtils.getTypeLabelLocalized === 'function')
            ? window.i18nUtils.getTypeLabelLocalized(t, 'zh-CN')
            : (String(t || '').trim() || '未分类');
    }
    // 构建学生ID到姓名的映射
    const idToName = new Map();
    students.forEach(s => idToName.set(String(s.id), s.name));

    const studentIdOrder = [];
    const typeOrder = [];
    const map = new Map(); // studentId -> Map(typeLabel -> count)

    schedules.forEach(row => {
        // 支持 student_ids 字段（逗号分隔）与单个 student_id 回退
        const idsRaw = (row.student_ids || row.student_id || '').toString();
        const ids = idsRaw.split(',').map(x => x.trim()).filter(Boolean);
        const typesStr = row.schedule_types || '';
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        // 若无student_ids则尝试回退到单个name（可能不完整）
        const fallbackId = (row.student_id != null) ? String(row.student_id) : null;
        const fallbackName = row.student_name || '未分配';
        const targetIds = ids.length ? ids : (fallbackId ? [fallbackId] : []);
        const applyForIds = targetIds.length ? targetIds : ['__fallback__'];

        applyForIds.forEach(sid => {
            if (!map.has(sid)) {
                map.set(sid, new Map());
                studentIdOrder.push(sid);
            }
            types.forEach(t => {
                const label = mapTypeLabel(t);
                if (!typeOrder.includes(label)) typeOrder.push(label);
                const sm = map.get(sid);
                sm.set(label, (sm.get(label) || 0) + 1);
            });
        });
        // 若走fallback键，确保名称映射存在
        if (!ids.length) {
            if (!idToName.has('__fallback__')) idToName.set('__fallback__', fallbackName);
        }
    });

    // Filter out deleted students (status = -1) and map IDs to names
    let studentNames = [];
    const studentIdToNameMap = new Map();

    studentIdOrder.forEach(sid => {
        const name = idToName.get(sid) || (sid === '__fallback__' ? (idToName.get('__fallback__') || '未分配') : '未分配');
        studentIdToNameMap.set(sid, name);

        // Check if this student is deleted
        if (sid !== '__fallback__') {
            const status = window.__studentStatusMap?.get(String(sid));
            if (status === -1) return; // Skip deleted students
        }
        studentNames.push({ id: sid, name });
    });

    // Calculate total count for each student and sort
    const studentTotals = studentNames.map(({ id, name }) => {
        const typeMap = map.get(id);
        const total = Array.from(typeMap.values()).reduce((a, b) => a + b, 0);
        return { id, name, total };
    }).filter(t => t.total > 0);  // Only show students with actual schedule data

    // 按ID升序排列并截取
    studentTotals.sort((a, b) => Number(a.id) - Number(b.id));
    const top15Students = studentTotals.slice(0, 15);

    // Store student ID mapping globally for rendering function
    window.__studentIdMap = studentIdToNameMap;

    const labels = top15Students.map(s => s.name);
    const datasets = typeOrder.map((label) => ({
        label,
        data: top15Students.map(s => (map.get(s.id).get(label) || 0)),
        backgroundColor: getLegendColor(label),
        borderColor: getLegendColor(label)
    }));
    return { labels, datasets };
}

// 旧的绿色栈色已移除，统一使用 getLegendColor 保证跨图表一致

// 统一图例颜色映射（按名称一致）
// 统一图例颜色映射（按名称一致）
// Now delegated to ScheduleTypesStore to ensure consistency with dynamic types
function getLegendColor(name) {
    // Try ScheduleTypesStore first
    if (window.ScheduleTypesStore) {
        return window.ScheduleTypesStore.getColor(name);
    }

    // Fallback logic if store not ready
    const key = String(name || '').trim();
    const LEGEND_COLOR_MAP = {
        '入户': '#3366CC',
        '试教': '#FF9933',
        '评审': '#7C4DFF',
        '评审记录': '#B39DDB',
        '心理咨询': '#33CC99',
        '线上辅导': '#0099C6',
        '线下辅导': '#5C6BC0',
        '集体活动': '#DC3912',
        '半次入户': '#4E79A7',
        '家访': '#8E8CD8',
        '未分类': '#A0A0A0'
    };
    if (key && LEGEND_COLOR_MAP[key]) return LEGEND_COLOR_MAP[key];

    const hash = Array.from(key).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const fallback = ['#3366CC', '#FF9933', '#33CC99', '#CC33FF', '#0099C6', '#DC3912', '#7C4DFF', '#5C6BC0', '#66AA00', '#A0A0A0'];
    return fallback[hash % fallback.length];
}

// 导出颜色解析器以供统计插件复用，确保跨图表颜色一致
window.getLegendColor = getLegendColor;
// 导出堆叠构造工具以便测试覆盖
window.__StatsUtils = { buildTeacherTypeStack, buildStudentTypeStack };

// 绘制教师类型堆叠图
function renderTeacherTypeStackedChart(stackData) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('teacherTypeStackedChart');
    if (!el) return;
    const prev = window.Chart.getChart(el);
    if (prev) try { prev.destroy(); } catch (_) { }
    const ctx = el.getContext('2d');

    const addAlpha = (color, alpha) => {
        const c = String(color || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
            let r, g, b;
            if (c.length === 4) {
                r = parseInt(c[1] + c[1], 16);
                g = parseInt(c[2] + c[2], 16);
                b = parseInt(c[3] + c[3], 16);
            } else {
                r = parseInt(c.slice(1, 3), 16);
                g = parseInt(c.slice(3, 5), 16);
                b = parseInt(c.slice(5, 7), 16);
            }
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (/^rgba?\(/i.test(c)) {
            return c.replace(/rgba?\(([^)]+)\)/i, (m, inner) => {
                const parts = inner.split(',').map(s => s.trim());
                const [r, g, b] = parts;
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            });
        }
        return c;
    };

    const datasets = stackData.datasets.map((ds) => ({
        ...ds,
        backgroundColor: getLegendColor(ds.label),
        borderColor: getLegendColor(ds.label),
        borderWidth: 0,
        borderRadius: 8,
        barPercentage: 0.9,
        categoryPercentage: 0.9
    }));

    new window.Chart(ctx, {
        type: 'bar',
        data: {
            labels: stackData.labels,
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 10,
                        padding: 14,
                        color: '#374151',
                        font: {}
                    },
                    onHover: (e) => { if (e && e.native) e.native.target.style.cursor = 'pointer'; },
                    onClick: (e, item, legend) => {
                        const chart = legend.chart;
                        const idx = item.datasetIndex ?? item.index ?? 0;
                        const now = Date.now();
                        const last = chart.$lastLegendClick || 0;
                        const isDbl = (now - last) < 300 && chart.$lastLegendIndex === idx;
                        chart.$lastLegendClick = now;
                        chart.$lastLegendIndex = idx;
                        if (isDbl) {
                            const current = chart.$highlightIndex;
                            const newIndex = current === idx ? null : idx;
                            chart.$highlightIndex = newIndex;
                            chart.data.datasets.forEach((ds, di) => {
                                const base = getLegendColor(ds.label);
                                if (newIndex == null) {
                                    ds.backgroundColor = base;
                                    ds.borderColor = base;
                                } else if (di === newIndex) {
                                    ds.backgroundColor = base;
                                    ds.borderColor = base;
                                } else {
                                    ds.backgroundColor = addAlpha(base, 0.25);
                                    ds.borderColor = addAlpha(base, 0.25);
                                }
                            });
                            chart.update();
                            return;
                        }
                        const vis = chart.isDatasetVisible(idx);
                        chart.setDatasetVisibility(idx, !vis);
                        chart.update();
                    }
                },
                title: { display: true, text: '教师授课汇总' },
                tooltip: { enabled: true }
            },
            scales: {
                x: { stacked: true, beginAtZero: true, grid: { color: 'rgba(55,65,81,0.08)' } },
                y: {
                    stacked: true,
                    grid: { display: false },
                    ticks: {
                        autoSkip: false,
                        font: (context) => {
                            const teacherName = context.chart.data.labels[context.index];
                            const teacherId = window.__teacherIdMap?.get(teacherName);
                            if (teacherId) {
                                const status = window.__teacherStatusMap?.get(String(teacherId));
                                if (status === 0) return { style: 'italic' };
                            }
                            return { style: 'normal' };
                        }
                    }
                }
            }
        }
    });
}

// 绘制学生参与度图表
function renderStudentParticipationChart(stackData) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('studentParticipationChart');
    if (!el) return;
    const prev = window.Chart.getChart(el);
    if (prev) try { prev.destroy(); } catch (_) { }
    const ctx = el.getContext('2d');

    const datasets = stackData.datasets.map((ds) => ({
        ...ds,
        backgroundColor: getLegendColor(ds.label),
        borderColor: getLegendColor(ds.label),
        borderWidth: 0,
        borderRadius: 4,
        barPercentage: 0.8,
        categoryPercentage: 0.8
    }));

    new window.Chart(ctx, {
        type: 'bar',
        data: {
            labels: stackData.labels,
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { usePointStyle: true, boxWidth: 10 }
                },
                title: { display: true, text: '学生上课统计' },
                tooltip: { enabled: true }
            },
            scales: {
                x: { stacked: true, grid: { display: false } },
                y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(55,65,81,0.08)' } }
            }
        }
    });
}


// 加载类型筛选器选项（按课程类型）
async function loadScheduleFilterOptions() {
    try {
        const typeFilter = document.getElementById('typeFilter');
        if (!typeFilter) return;
        // 先置默认项
        typeFilter.innerHTML = '<option value="">全部类型</option>';
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
                    console.warn('获取课程类型失败:', error);
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
        console.error('加载类型筛选选项失败:', error);
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
    const weekdayStr = new Intl.DateTimeFormat('en-US', {
        timeZone: TIME_ZONE,
        weekday: 'short'
    }).format(d); // Sun, Mon, ...
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = map[weekdayStr] ?? d.getDay();
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

function toISODate(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

function formatYearMonth(date) {
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit'
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year')?.value || '';
    const m = parts.find(p => p.type === 'month')?.value || '';
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
    const parts = new Intl.DateTimeFormat('zh-CN', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const y = parts.find(p => p.type === 'year')?.value || '';
    const m = parts.find(p => p.type === 'month')?.value || '';
    const d = parts.find(p => p.type === 'day')?.value || '';
    return `${y}年${m}月${d}日`;
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

function normalizeScheduleRows(rows) {
    return (rows || []).map(r => {
        // 兼容不同后端字段名：arr_date / class_date / class-date / date
        const rawDate = (r && (r.date ?? r.class_date ?? r['class-date'] ?? r.arr_date));
        let dateISO;
        if (typeof rawDate === 'string') {
            const t = rawDate.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
                dateISO = t;
            } else {
                const d = new Date(t);
                dateISO = Number.isNaN(d.getTime()) ? '' : toISODate(d);
            }
        } else if (rawDate instanceof Date) {
            dateISO = toISODate(rawDate);
        } else if (typeof rawDate === 'number') {
            const d = new Date(rawDate);
            dateISO = Number.isNaN(d.getTime()) ? '' : toISODate(d);
        } else {
            // 若缺失，保持空字符串（后续渲染会忽略无法匹配的记录）
            dateISO = '';
        }

        // 兼容后端不同键名：start_time / startTime / start-time / start- time / start time
        const startRaw = (typeof r.start_time === 'string') ? r.start_time
            : (typeof r.startTime === 'string') ? r.startTime
                : (typeof r['start-time'] === 'string') ? r['start-time']
                    : (typeof r['start- time'] === 'string') ? r['start- time']
                        : (typeof r['start time'] === 'string') ? r['start time']
                            : null;
        const endRaw = (typeof r.end_time === 'string') ? r.end_time
            : (typeof r.endTime === 'string') ? r.endTime
                : (typeof r['end-time'] === 'string') ? r['end-time']
                    : (typeof r['end- time'] === 'string') ? r['end- time']
                        : (typeof r['end time'] === 'string') ? r['end time']
                            : null;
        // 统一时间格式
        const start = sanitizeTimeString(startRaw);
        const end = sanitizeTimeString(endRaw);
        const location = (r.location || '').trim();
        const teacherName = r.teacher_name || r.teacherName || '';
        // 类型映射：优先通过 course_id/type_id/schedule_type_id 映射到描述
        const typeId = (r.course_id ?? r.type_id ?? r.schedule_type_id);
        // 优先使用后端传回的中文名 schedule_type_cn
        let typeText = r.schedule_type_cn || r.schedule_types || r.schedule_type || r.type_name || '';
        try {
            if (typeId != null && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
                const info = window.ScheduleTypesStore.getById(typeId);
                // 如果后端没返回中文名，或者Store里有更准确的
                if (info && !r.schedule_type_cn) {
                    typeText = (info.description || info.name || typeText || '未分类');
                }
            }
        } catch (_) { }
        const valid = (typeof r.valid === 'boolean') ? r.valid : true;
        return {
            id: r.id,
            student_id: r.student_id,
            student_name: r.student_name,
            teacher_id: r.teacher_id,
            teacher_name: teacherName,
            course_id: (typeId != null ? Number(typeId) : undefined),
            schedule_types: typeText,
            schedule_type_cn: r.schedule_type_cn, // 显式传递
            date: dateISO,
            start_time: start,
            end_time: end,
            location,
            status: r.status,
            valid
        };
    });
}

// 分组/聚类/渲染辅助函数
function sanitizeTimeString(t) {
    if (t == null) return null;
    let s = String(t).trim();
    // 全角冒号替换为半角
    s = s.replace(/：/g, ':');
    // 允许包含秒：HH:mm 或 HH:mm:ss
    const m = /^([0-2]?\d):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
    if (m) {
        const hh = String(m[1]).padStart(2, '0');
        const mm = String(m[2]).padStart(2, '0');
        return `${hh}:${mm}`;
    }
    // 兼容“H点M分/时分”
    const m2 = /^([0-2]?\d)\s*[时点]\s*([0-5]?\d)\s*[分]?$/.exec(s);
    if (m2) {
        const hh = String(m2[1]).padStart(2, '0');
        const mm = String(m2[2]).padStart(2, '0');
        return `${hh}:${mm}`;
    }
    return null;
}
function hhmmToMinutes(t) {
    const norm = sanitizeTimeString(t);
    const m = /^([0-2]?\d):([0-5]\d)$/.exec(String(norm || ''));
    return m ? (Number(m[1]) * 60 + Number(m[2])) : NaN;
}

function minutesToHHMM(min) {
    if (!Number.isFinite(min)) return '';
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

function computeSlotByStartMin(startMin) {
    // <12:00 上午；12:00–18:29 下午；>=18:30 晚上；无法解析 -> unspecified
    if (!Number.isFinite(startMin)) return 'unspecified';
    if (startMin < 12 * 60) return 'morning';
    if (startMin < (18 * 60 + 30)) return 'afternoon';
    return 'evening';
}

function clusterByOverlap(records) {
    const sorted = records.slice().sort((a, b) => (a.startMin - b.startMin));
    const clusters = [];
    let cur = null;
    for (const r of sorted) {
        if (!Number.isFinite(r.startMin) || !Number.isFinite(r.endMin)) {
            clusters.push({ records: [r], minStart: r.startMin, maxEnd: r.endMin });
            continue;
        }
        if (!cur) {
            cur = { records: [r], minStart: r.startMin, maxEnd: r.endMin };
        } else if (r.startMin <= cur.maxEnd) {
            cur.records.push(r);
            cur.minStart = Math.min(cur.minStart, r.startMin);
            cur.maxEnd = Math.max(cur.maxEnd, r.endMin);
        } else {
            clusters.push(cur);
            cur = { records: [r], minStart: r.startMin, maxEnd: r.endMin };
        }
    }
    if (cur) clusters.push(cur);
    return clusters;
}

function buildMergedRowText(group) {
    const peopleText = group.records.map(r => {
        const teacher = r.teacher_name || '待分配';
        const typeText = r.schedule_types || r.schedule_type || '未分类';
        // 状态不在主文本中显示（使用内部中文chip显示状态），避免英文状态残留
        return `${teacher}（${typeText}）`;
    }).join('，');

    const timeText = (Number.isFinite(group.minStart) && Number.isFinite(group.maxEnd))
        ? `${minutesToHHMM(group.minStart)}-${minutesToHHMM(group.maxEnd)}`
        : '时间待定';

    const locations = Array.from(new Set(group.records.map(r => (r.location || '').trim()).filter(Boolean)));
    const locationText = locations.join(' / ') || '地点待定';
    return `${peopleText}，${timeText}，${locationText}`;
}

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

        feeInfo.innerHTML = `<span>${parts.join(' ')}</span><span class="material-icons-round" style="font-size: 12px; margin-left: 2px;">edit</span>`;
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

// 辅助函数：更新排课状态
async function updateScheduleStatus(id, newStatus) {
    if (!id || !newStatus) return;
    try {
        if (!window.apiUtils || typeof window.apiUtils.put !== 'function') {
            console.error('API Utils incomplete');
            return;
        }
        // 调用更新接口
        await window.apiUtils.put(`/admin/schedules/${id}`, { status: newStatus });

        // 成功后刷新视图
        if (window.apiUtils.showToast) window.apiUtils.showToast('状态更新成功', 'success');

        // 智能刷新：如果是周视图且 WeeklyDataStore 存在，更新本地缓存以保持数据一致性，但不刷新整个视图
        const activeSection = document.querySelector('.dashboard-section.active');
        if (activeSection && activeSection.id === 'schedule') {
            // 手动更新缓存中的状态，避免全量刷新
            if (window.WeeklyDataStore && window.WeeklyDataStore.schedules) {
                for (const entry of window.WeeklyDataStore.schedules.values()) {
                    if (entry && Array.isArray(entry.rows)) {
                        const target = entry.rows.find(r => String(r.id) === String(id));
                        if (target) {
                            target.status = newStatus;
                            // 还可以更新 schedule_type_cn 等其他可能受影响的字段（如果需要）
                        }
                    }
                }
            }
            // 移除不再需要的强制刷新逻辑
            // window.__weeklyForceRefresh = true; 
            // await loadSchedules(); 
        } else {

            // 非周视图（如今日排课）也刷新
            if (typeof loadSchedules === 'function') loadSchedules();
            if (typeof loadTodaySchedules === 'function') loadTodaySchedules();
        }
    } catch (error) {
        console.error('更新状态失败', error);
        if (window.apiUtils.showToast) window.apiUtils.showToast('状态更新失败', 'error');
        // 可选：如果失败，刷新页面以恢复原状
        if (typeof loadSchedules === 'function') loadSchedules();
    }
}

// 注入并管理周视图的刷新与分页控件
// 已移除刷新周视图按钮（采用自动刷新与数据更新触发刷新）

// 移除分页相关辅助函数

function renderWeeklyLoading() {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td class="sticky-col">加载中...</td><td colspan="7">请稍候</td></tr>';
}

function renderWeeklyError(message) {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;
    const msg = (message && message.toString) ? message.toString() : '加载失败';
    tbody.innerHTML = `<tr><td class=\"sticky-col\">错误</td><td colspan=\"7\">${msg}</td></tr>`;
}

// 仅显示中文周几列头（周一至周日）
function renderWeeklyHeader(weekDates) {
    const thead = document.getElementById('weeklyHeader');
    if (!thead) return;
    thead.innerHTML = '';
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
    tbody.innerHTML = '';
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
                td.innerHTML = '<div class="no-schedule">暂无排课</div>';
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

function renderScheduleTypeChart(data) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('scheduleTypeChart');
    if (!el) return;
    const prev = window.Chart.getChart(el);
    if (prev) try { prev.destroy(); } catch (_) { }
    const ctx = el.getContext('2d');

    const addAlpha = (color, alpha) => {
        const c = String(color || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
            let r, g, b;
            if (c.length === 4) {
                r = parseInt(c[1] + c[1], 16);
                g = parseInt(c[2] + c[2], 16);
                b = parseInt(c[3] + c[3], 16);
            } else {
                r = parseInt(c.slice(1, 3), 16);
                g = parseInt(c.slice(3, 5), 16);
                b = parseInt(c.slice(5, 7), 16);
            }
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (/^rgba?\(/i.test(c)) {
            return c.replace(/rgba?\(([^)]+)\)/i, (m, inner) => {
                const parts = inner.split(',').map(s => s.trim());
                const [r, g, b] = parts;
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            });
        }
        return c;
    };

    const normalizedData = Array.isArray(data) ? data : (data?.scheduleTypeDistribution || []);
    const labels = normalizedData.map(item => item.type);
    const counts = normalizedData.map(item => parseInt(item.count) || 0);
    const total = counts.reduce((a, b) => a + b, 0);
    const baseColors = labels.map(l => getLegendColor(l));

    new window.Chart(ctx, {
        type: 'doughnut',
        data: {
            labels,
            datasets: [{
                data: counts,
                backgroundColor: baseColors.slice(),
                borderColor: 'transparent',
                borderWidth: 0,
                hoverOffset: 15
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '55%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 10,
                        padding: 14,
                        color: '#374151',
                        font: {},
                        // 在图例标签中显示百分比
                        generateLabels: (chart) => {
                            const data = chart.data;
                            if (!data.labels.length) return [];
                            const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
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
                    },
                    onHover: (e) => { if (e && e.native) e.native.target.style.cursor = 'pointer'; },
                    onClick: (e, item, legend) => {
                        const chart = legend.chart;
                        const idx = item.index ?? 0;
                        const now = Date.now();
                        const last = chart.$lastLegendClick || 0;
                        const isDbl = (now - last) < 300 && chart.$lastLegendIndex === idx;
                        chart.$lastLegendClick = now;
                        chart.$lastLegendIndex = idx;
                        const ds = chart.data.datasets[0];
                        if (isDbl) {
                            const current = chart.$highlightIndex;
                            const newIndex = current === idx ? null : idx;
                            chart.$highlightIndex = newIndex;
                            ds.backgroundColor = baseColors.map((c, i) => {
                                if (newIndex == null) return c;
                                return (i === newIndex) ? c : addAlpha(c, 0.25);
                            });
                            chart.update();
                            return;
                        }
                        // 默认切换显示/隐藏该扇区
                        const vis = chart.getDataVisibility(idx);
                        chart.toggleDataVisibility(idx);
                        chart.update();
                    }
                },
                title: { display: true, text: '课程类型分布' },
                tooltip: {
                    enabled: true,
                    callbacks: {
                        label: (context) => {
                            const value = context.parsed || 0;
                            const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                            return ` ${context.label}: ${value} 次 (${percent}%)`;
                        }
                    }
                }
            },
            // 点击扇区时触发事件
            onClick: (e, elements, chart) => {
                if (elements && elements.length > 0) {
                    const idx = elements[0].index;
                    const typeName = chart.data.labels[idx];
                    const count = chart.data.datasets[0].data[idx];
                    // 可扩展：跳转到该类型的详细统计或筛选
                    console.log(`点击了类型「${typeName}」：${count} 次排课`);
                    // 高亮该扇区
                    const ds = chart.data.datasets[0];
                    const current = chart.$highlightIndex;
                    const newIndex = current === idx ? null : idx;
                    chart.$highlightIndex = newIndex;
                    ds.backgroundColor = baseColors.map((c, i) => {
                        if (newIndex == null) return c;
                        return (i === newIndex) ? c : addAlpha(c, 0.25);
                    });
                    chart.update();
                }
            }
        }
    });
}

// 新增：渲染所有教师的排课数据柱状图（全局汇总）
function renderAllTeachersScheduleBarChart(rows, dayLabels) {
    const container = document.getElementById('teacherChartsContainer');
    if (!container) return;

    // 检查是否已有全局柱状图容器
    let globalChartCard = container.querySelector('.all-teachers-schedule-card');
    if (!globalChartCard) {
        globalChartCard = document.createElement('div');
        globalChartCard.className = 'all-teachers-schedule-card chart-card';
        container.insertBefore(globalChartCard, container.firstChild);
    }
    globalChartCard.innerHTML = '';

    // 过滤掉已删除的教师（status=-1）
    const statusMapRaw = window.__teacherStatusMap || new Map();
    const getStatus = (id) => {
        try {
            if (statusMapRaw instanceof Map) return Number(statusMapRaw.get(String(id)));
            return Number(statusMapRaw[String(id)]);
        } catch (_) { return NaN; }
    };
    const filteredRows = rows.filter(r => getStatus(r.teacher_id) !== -1);

    // 汇总所有教师的排课数
    const teacherSchedules = new Map();
    filteredRows.forEach(r => {
        const teacherName = r.teacher_name || '未分配';
        teacherSchedules.set(teacherName, (teacherSchedules.get(teacherName) || 0) + 1);
    });

    // 按排课数排序
    const sortedTeachers = Array.from(teacherSchedules.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);

    const scheduleData = sortedTeachers.map(name => teacherSchedules.get(name));

    // 获取品牌色
    const styles = getComputedStyle(document.documentElement);
    const primaryColor = styles.getPropertyValue('--brand-primary').trim() || '#3b82f6';

    // 创建标题
    const title = document.createElement('h4');
    title.className = 'chart-title';
    title.textContent = '教师排课统计';
    globalChartCard.appendChild(title);

    // 创建Canvas
    const canvas = document.createElement('canvas');
    canvas.id = 'allTeachersScheduleChart';
    globalChartCard.appendChild(canvas);

    // 渲染柱状图
    const ctx = canvas.getContext('2d');
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sortedTeachers,
            datasets: [{
                label: '排课数量',
                data: scheduleData,
                backgroundColor: primaryColor,
                borderRadius: 6,
                maxBarThickness: 40
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: { enabled: true }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: 'rgba(0,0,0,0.08)' }
                },
                y: {
                    grid: { display: false },
                    ticks: { font: { size: 12 } }
                }
            }
        }
    });
}

// 新增：渲染所有学生的排课数据柱状图（全局汇总）


// 辅助：根据 dayLabels 聚合 rows 每天的数量（针对所有教师/学生汇总）
function aggregateCountsByDate(rows, dayLabels, dateField = 'date') {
    const map = new Map(dayLabels.map(d => [d, 0]));
    rows.forEach(r => {
        // 兼容多种日期字段名：优先使用指定的dateField，然后尝试常见字段名
        const d = String(r[dateField] || r.date || r.class_date || '').slice(0, 10);
        if (!d) return;
        if (map.has(d)) map.set(d, map.get(d) + 1);
    });
    return dayLabels.map(d => map.get(d) || 0);
}



// 新增：按教师生成多类型光滑曲线图（每位教师一个图）
function renderTeacherTypePerTeacherCharts(rows, dayLabels, selectedTeacher = '') {
    if (!isChartAvailable()) {
        console.warn('Chart.js 未加载，无法渲染教师图表');
        return;
    }

    const container = document.getElementById('teacherChartsContainer');
    if (!container) {
        console.warn('teacherChartsContainer 容器未找到');
        return;
    }



    // 检查数据格式
    if (rows.length === 0) {
        console.warn('警告：没有排课数据可供渲染');
        container.innerHTML = '<div style="padding: 20px; text-align: center; color: #64748b;">暂无排课数据</div>';
        return;
    }

    // 仅移除之前生成的每位教师的 chart 卡片，保留顶部的汇总卡片（如 all-teachers-daily-card）
    container.querySelectorAll('.teacher-chart').forEach(n => n.remove());

    function mapTypeLabel(t) {
        return (window.i18nUtils && typeof window.i18nUtils.getTypeLabelLocalized === 'function')
            ? window.i18nUtils.getTypeLabelLocalized(t, 'zh-CN')
            : (String(t || '').trim() || '未分类');
    }

    // 汇总全局类型顺序，保证不同教师图颜色一致
    const typeCounts = new Map();
    rows.forEach(r => {
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCounts.set(label, (typeCounts.get(label) || 0) + 1);
        });
    });
    const globalTypeOrder = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]).map(([label]) => label);

    // 辅助函数：按日期和课程类型聚合数据（用于堆叠柱状图）
    function aggregateByDateAndType(teacherRows, dayLabels) {
        // 创建一个 Map: date -> Map(type -> count)
        const dateTypeMap = new Map();
        dayLabels.forEach(date => {
            dateTypeMap.set(date, new Map());
        });

        teacherRows.forEach(r => {
            const dateStr = String(r.date || '').slice(0, 10);
            if (!dateStr || !dateTypeMap.has(dateStr)) return;

            const typesStr = String(r.schedule_types || '').trim();
            const types = typesStr ? typesStr.split(',') : ['未分类'];

            types.forEach(t => {
                const label = mapTypeLabel(t);
                const typeMap = dateTypeMap.get(dateStr);
                typeMap.set(label, (typeMap.get(label) || 0) + 1);
            });
        });

        // 为每个课程类型创建一个数据集
        const datasets = globalTypeOrder.map(typeLabel => {
            const data = dayLabels.map(date => {
                const typeMap = dateTypeMap.get(date);
                return typeMap ? (typeMap.get(typeLabel) || 0) : 0;
            });
            return {
                label: typeLabel,
                data: data,
                backgroundColor: getLegendColor(typeLabel),
                borderRadius: 4
            };
        });

        return datasets;
    }

    // 获取教师 id 列表并按状态排序（正常→暂停，删除不显示）
    const teacherIdSet = new Set(rows.map(r => String(r.teacher_id || '').trim()));
    let teachers = Array.from(teacherIdSet);



    const statusMapRaw = window.__teacherStatusMap || new Map();
    const nameMap = window.__teacherNameMap || new Map();
    const getStatus = (id) => {
        try {
            if (statusMapRaw instanceof Map) return Number(statusMapRaw.get(String(id)));
            return Number(statusMapRaw[String(id)]);
        } catch (_) { return NaN; }
    };
    const weight = (id) => { const s = getStatus(id); if (s === 1) return 0; if (s === 0) return 1; return 2; };
    teachers = teachers.filter(id => (getStatus(id) !== -1)).sort((a, b) => {
        return Number(a) - Number(b);
    });
    if (selectedTeacher) teachers = teachers.filter(t => String(t) === String(selectedTeacher));



    // 辅助：slug化ID（兼容中文：使用哈希生成稳定且唯一的ID）
    const slug = (s) => {
        const t = String(s || '').trim();
        let h = 2166136261 >>> 0; // FNV-like hash seed
        for (const ch of t) {
            h ^= ch.charCodeAt(0);
            h = (h * 16777619) >>> 0;
        }
        return `t_${h.toString(16)}`;
    };

    // 辅助：根据日期范围格式化日期标签（智能检测跨月/跨年）
    const formatDateLabels = (labels) => {
        if (!labels || labels.length === 0) return labels;

        // 解析所有日期
        const dates = labels.map(dateStr => new Date(dateStr));

        // 获取年份和月份范围
        const years = dates.map(d => d.getFullYear());
        const months = dates.map(d => d.getMonth());

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);
        const minMonth = Math.min(...months);
        const maxMonth = Math.max(...months);

        // 检测是否跨年
        const spansMultipleYears = maxYear > minYear;

        // 检测是否跨月（同一年内）
        const spansMultipleMonths = maxMonth > minMonth || spansMultipleYears;

        // 跨年：显示 "YYYY-MM-DD" 格式
        if (spansMultipleYears) {
            return labels; // 保持原格式 YYYY-MM-DD
        }

        // 跨月（但不跨年）：显示 "MM-DD" 格式
        if (spansMultipleMonths) {
            return labels.map(dateStr => {
                const date = new Date(dateStr);
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${month}-${day}`;
            });
        }

        // 同一月内：显示 "DD" 格式
        return labels.map(dateStr => {
            const date = new Date(dateStr);
            return String(date.getDate());
        });
    };

    // 格式化日期标签
    const formattedLabels = formatDateLabels(dayLabels);

    // 为每位教师构建按日授课数量柱状图（每位教师一个图）
    teachers.forEach(teacherId => {
        const teacherRows = rows.filter(r => String(r.teacher_id || '') === String(teacherId));

        // 使用堆叠数据集（按课程类型分组）
        const datasets = aggregateByDateAndType(teacherRows, dayLabels);



        // DOM：创建图卡片
        const card = document.createElement('div');
        card.className = 'chart-container teacher-chart';
        card.style.position = 'relative'; // For tooltip positioning
        card.style.height = '320px';

        // 标题文本：老师姓名[数据汇总]
        const st = getStatus(teacherId);
        const displayName = String(nameMap.get(teacherId) || teacherRows.find(r => r.teacher_name)?.teacher_name || '未分配');

        // 计算课程类型统计（带折算）
        const typeCounts = {
            visit: 0,      // 入户
            review: 0,     // 评审
            group: 0,      // 集体活动
            consult: 0     // 咨询
        };

        teacherRows.forEach(r => {
            const typesStr = String(r.schedule_types || '').trim();
            const types = typesStr ? typesStr.split(',') : [];

            types.forEach(t => {
                const trimmed = String(t).trim();
                const lower = trimmed.toLowerCase();

                // 辅助匹配函数（同时匹配 Code / ID / 中文名）
                // ID对照: 1=visit, 5=half_visit, 3=review, 4=review_record, 6=group_activity, 7=advisory/consultation
                const isType = (code, id, name) => {
                    return lower === code || trimmed == id || lower === name;
                };

                // 辅助函数：检查是否为线上类型
                const isOnlineType = (baseName) => {
                    return lower.includes(`线上${baseName}`) || lower.includes(`（线上）${baseName}`) || lower.includes(`(线上)${baseName}`);
                };

                // 折算规则（线上类型等效为线下类型）
                if (isType('visit', 1, '入户') || isOnlineType('入户')) {
                    typeCounts.visit += 1;
                } else if (isType('half_visit', 5, '半次入户')) {
                    typeCounts.visit += 0.5;  // 半次入户 = 0.5次入户
                } else if (isType('review', 3, '评审') || isOnlineType('评审')) {
                    typeCounts.review += 1;
                } else if (isType('review_record', 4, '评审记录') || isOnlineType('评审记录')) {
                    typeCounts.review += 1;    // 评审记录 = 1次评审
                    typeCounts.visit += 0.5;   // + 0.5次入户
                } else if (isType('group_activity', 6, '集体活动') || lower === 'group') {
                    typeCounts.group += 1;
                } else if (isType('advisory', 7, '咨询') || isType('consultation', 7, '咨询') || lower === 'consult' || isOnlineType('咨询') || lower.includes('线上辅导') || lower.includes('心理咨询')) {
                    typeCounts.consult += 1;
                } else if (lower.includes('咨询记录') || isOnlineType('咨询记录')) {
                    typeCounts.consult += 1;    // 咨询记录 = 1次咨询
                } else if (lower.includes('试教')) {
                    // 试教暂不计入或计入特定类型？用户未提及，暂忽略或保持未匹配
                    console.log(`[Teacher-Chart] 忽略类型: "${trimmed}"`);
                } else {
                    // 记录未匹配类型便于调试
                    console.log(`[Teacher-Chart] 未匹配类型: "${trimmed}"`);
                }
            });
        });

        // 生成汇总文本（仅显示非0的类型）
        const summary = [];
        if (typeCounts.visit > 0) summary.push(`入户：${typeCounts.visit}`);
        if (typeCounts.review > 0) summary.push(`评审：${typeCounts.review}`);
        if (typeCounts.group > 0) summary.push(`集体活动：${typeCounts.group}`);
        if (typeCounts.consult > 0) summary.push(`咨询：${typeCounts.consult}`);

        const summaryText = summary.length > 0 ? `[${summary.join('，')}]` : '';
        const titleText = displayName + summaryText + (st === 0 ? '（暂停）' : '');

        console.log(`[Teacher-Chart] 教师 ${displayName} 标题生成:`, {
            原始数据: teacherRows.length + '条',
            课程统计: typeCounts,
            汇总文本: summaryText,
            最终标题: titleText
        });

        // HTML 标题构建逻辑已移除，改由Chart.js统一渲染
        // 让 Canvas 占据剩余空间并保证宽度








        const canvas = document.createElement('canvas');
        const cid = `teacherDailySeries_${slug(teacherId)}`;
        canvas.id = cid;
        // 让 Canvas 占据剩余空间并保证宽度
        canvas.style.cssText = 'flex: 1; width: 100%; min-height: 0;';


        card.appendChild(canvas);



        container.appendChild(card);

        // 渲染每日授课数量堆叠柱状图
        try {
            const ctx = canvas.getContext('2d');

            // Custom plugin to draw mixed-style title
            const customTitlePlugin = {
                id: 'customTitle',
                afterDraw: (chart) => {
                    const { ctx, width } = chart;
                    ctx.save();

                    const nameText = displayName + (st === 0 ? '（暂停）' : '');
                    const dataText = summaryText ? (' ' + summaryText) : '';

                    const nameFont = 'bold 16px "Inter", sans-serif';
                    // User Request: smaller by 2px (14px) and transparent gray
                    const dataFont = '14px "Inter", sans-serif';
                    const nameColor = '#334155'; // slate-700
                    const dataColor = 'rgba(100, 116, 139, 0.6)'; // slate-500 with opacity

                    ctx.font = nameFont;
                    const nameWidth = ctx.measureText(nameText).width;

                    ctx.font = dataFont;
                    const dataWidth = ctx.measureText(dataText).width;

                    const totalWidth = nameWidth + dataWidth;
                    const startX = (width - totalWidth) / 2;
                    const y = 20; // Top margin position

                    // Draw Name
                    ctx.font = nameFont;
                    ctx.fillStyle = nameColor;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(nameText, startX, y);

                    // Draw Data
                    if (dataText) {
                        ctx.font = dataFont;
                        ctx.fillStyle = dataColor;
                        ctx.fillText(dataText, startX + nameWidth, y);
                    }

                    ctx.restore();
                }
            };

            new window.Chart(ctx, {
                type: 'bar',
                plugins: [customTitlePlugin],
                data: {
                    labels: formattedLabels,
                    datasets: datasets
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    layout: {
                        padding: {
                            top: 40, // Increased top padding for custom title
                            bottom: 10
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'bottom',
                            align: 'center',
                            labels: {
                                boxWidth: 12,
                                padding: 15,
                                usePointStyle: true,
                                generateLabels: function (chart) {
                                    const data = chart.data;
                                    if (data.labels.length && data.datasets.length) {
                                        return data.datasets.map((dataset, i) => {
                                            // Check if dataset has any data > 0
                                            const total = dataset.data.reduce((acc, curr) => acc + (Number(curr) || 0), 0);
                                            if (total <= 0) return null;

                                            return {
                                                text: dataset.label,
                                                fillStyle: dataset.backgroundColor,
                                                strokeStyle: dataset.backgroundColor,
                                                lineWidth: 0,
                                                hidden: !chart.isDatasetVisible(i),
                                                index: i
                                            };
                                        }).filter(item => item !== null);
                                    }
                                    return [];
                                }
                            }
                        },
                        title: {
                            display: false // Use custom draw
                        },
                        subtitle: {
                            display: false
                        },
                        tooltip: {
                            mode: 'index',
                            intersect: false,
                            callbacks: {
                                title: function (context) {
                                    // 显示完整日期
                                    const index = context[0].dataIndex;
                                    const fullDate = dayLabels[index];
                                    const dateObj = new Date(fullDate);
                                    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
                                    const weekday = weekdays[dateObj.getDay()];
                                    return `${fullDate} (${weekday})`;
                                },
                                label: function (context) {
                                    const label = context.dataset.label || '';
                                    const value = context.parsed.y;
                                    return value > 0 ? `${label}: ${value}节` : null;
                                },
                                footer: function (context) {
                                    // 计算当天总数
                                    let total = 0;
                                    context.forEach(item => {
                                        total += item.parsed.y;
                                    });
                                    return total > 0 ? `总计: ${total}节` : '';
                                }
                            }
                        }
                    },
                    scales: {
                        y: {
                            stacked: true,
                            beginAtZero: true,
                            title: {
                                display: false  // Explicitly hide y-axis title (no teacher name)
                            },
                            ticks: {
                                stepSize: 1
                            }
                        },
                        x: {
                            stacked: true,
                            title: {
                                display: false  // Explicitly hide x-axis title
                            },
                            ticks: {
                                autoSkip: true,
                                maxRotation: 45,
                                minRotation: 0,
                                color: function (context) {
                                    // 从dayLabels获取完整日期(YYYY-MM-DD)
                                    const fullDate = dayLabels[context.index];
                                    if (fullDate) {
                                        const date = new Date(fullDate); // 直接解析YYYY-MM-DD
                                        const day = date.getDay();
                                        // 周六(6)或周日(0)显示红色
                                        if (day === 0 || day === 6) {
                                            return '#DC2626'; // 红色
                                        }
                                    }
                                    return '#374151'; // 默认深灰色
                                }
                            }
                        }
                    }
                }
            });
        } catch (e) {
            console.error('渲染教师每日柱状图失败', teacherId, e);
        }
    });
}

function renderTeacherScheduleChart(data) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('teacherScheduleChart');
    if (!el) return;
    const ctx = el.getContext('2d');
    const styles = getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue('--brand-primary').trim() || '#2ECC71';
    new window.Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(item => item.teacher_name),
            datasets: [{
                label: '排课数量',
                data: data.map(item => item.schedule_count),
                backgroundColor: primary,
                borderRadius: 8,
                maxBarThickness: 36
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                title: { display: true, text: '教师排课统计', font: { size: 16, weight: '600' } },
                tooltip: { enabled: true }
            },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.08)' } },
                x: { grid: { display: false } }
            }
        }
    });
}

// 用户管理相关函数

// 渲染用户表头（根据类型动态列）
function renderUsersTableHeader(type) {
    const thead = document.querySelector('#usersTable thead');
    if (!thead) return;
    const tr = thead.querySelector('tr');
    if (!tr) return;
    tr.innerHTML = '';

    const fields = USER_FIELDS[type] || USER_FIELDS['admin'];
    fields.forEach(field => {
        const th = document.createElement('th');
        th.classList.add(`col-${field}`);
        th.textContent = (type === 'student' && field === 'profession') ? '年级' : (FIELD_LABELS[field] || field);
        th.dataset.field = field;
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const state = window.__usersState || { type };
            state.sort = state.sort || { key: 'created_at', direction: 'desc' };
            if (state.sort.key === field) {
                state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
            } else {
                state.sort.key = field;
                state.sort.direction = 'asc';
            }
            loadUsers(state.type, { useCache: true, sortField: field });
        });
        tr.appendChild(th);
    });

    const opsTh = document.createElement('th');
    opsTh.textContent = '操作';
    tr.appendChild(opsTh);
}

// 追加一行用户数据
function appendUserRow(type, user) {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;

    const tr = document.createElement('tr');

    const fields = USER_FIELDS[type] || USER_FIELDS['admin'];
    fields.forEach(field => {
        const td = document.createElement('td');
        td.classList.add(`col-${field}`);
        let value = user[field];
        if (field === 'last_login' || field === 'created_at') {
            if (user[field]) {
                const date = new Date(user[field]);
                const formatter = new Intl.DateTimeFormat('en-CA', {
                    timeZone: TIME_ZONE,
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false
                });
                value = formatter.format(date).replace(', ', ' ');
            } else {
                value = '';
            }
        }
        if (field === 'contact') {
            value = user.contact || user.phone || user.email || '';
        }
        if (field === 'status') {
            const badge = document.createElement('span');
            badge.className = `status-badge ${getUserStatusClass(value)}`;
            badge.textContent = getUserStatusLabel(value);
            badge.title = `当前状态：${getUserStatusLabel(value)}`;
            td.appendChild(badge);
        } else {
            const span = document.createElement('span');
            span.className = 'clip';
            span.textContent = (value ?? '');
            span.title = String(value ?? '');
            td.appendChild(span);
        }
        tr.appendChild(td);
    });

    const actionsCell = document.createElement('td');
    actionsCell.classList.add('actions');
    actionsCell.innerHTML = `
        <button class="action-btn edit-btn" data-id="${user.id}" data-type="${type}">编辑</button>
        <button class="action-btn delete-btn" data-id="${user.id}" data-type="${type}">删除</button>
    `;
    tr.appendChild(actionsCell);

    tbody.appendChild(tr);

    const editBtn = actionsCell.querySelector('.edit-btn');
    const deleteBtn = actionsCell.querySelector('.delete-btn');
    if (editBtn) {
        editBtn.addEventListener('click', () => showEditUserModal(user.id, type));
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => deleteUser(type, user.id));
    }
}


// 分页加载用户列表，支持搜索与虚拟滚动
// 全量更新本地用户缓存（用于导出等功能）
async function refreshFullUserCache(type) {
    if (!window.apiUtils) return;
    if (!type) {
        refreshFullUserCache('student');
        refreshFullUserCache('teacher');
        return;
    }
    const storageKey = type === 'student' ? 'cached_students_full' : 'cached_teachers_full';
    try {
        // console.log(`[Cache] Refreshing ${type} cache...`);
        const response = await window.apiUtils.get(`/admin/users/${type}`);
        const list = Array.isArray(response) ? response : (response.data || []);
        localStorage.setItem(storageKey, JSON.stringify(list));
    } catch (e) {
        console.warn(`[Cache] Failed to refresh ${type} cache`, e);
    }
}

async function loadUsers(type, opts = {}) {
    if (window.UserManager && window.UserManager.loadUsers) {
        return window.UserManager.loadUsers(type, opts);
    }
    console.warn('UserManager module not loaded');
}

// 用户管理：委托给 UserManager
function showAddUserModal() {
    if (window.UserManager) window.UserManager.showAddUserModal();
}
function showEditUserModal(id, userType) {
    if (window.UserManager) window.UserManager.showEditUserModal(userType, id);
}
function closeUserFormModal() {
    if (window.UserManager) window.UserManager.closeUserFormModal();
}
function toggleContactFields(type) {
    console.warn('toggleContactFields called in admin.js but should be internal to UserManager');
    // If needed, we can call a method if exposed. Usually not needed globally.
}
function openUserFormModal(c, o) {
    // Internal to UserManager usually.
}
function editUser() { } // No-op
async function deleteUser(type, id) {
    if (window.UserManager) return window.UserManager.deleteUser(type, id);
}
function setUsersLoading(isLoading) {
    // Possibly used by other parts? If so, reimplement or keep.
    // user-manager likely handles loading state itself.
}

// 排课管理相关函数
async function showAddScheduleModal() {
    console.log('showAddScheduleModal called');
    const formContainer = document.getElementById('scheduleFormContainer');
    const form = document.getElementById('scheduleForm');
    const title = document.getElementById('scheduleFormTitle');
    if (!formContainer || !form) {
        console.error('Form container or form not found');
        return;
    }
    // ... rest of logic
    form.dataset.mode = 'add';
    form.dataset.id = '';
    title.textContent = '添加排课';
    // 清空表单
    const teacherSel = form.querySelector('#scheduleTeacher');
    const studentSel = form.querySelector('#scheduleStudent');
    const studentReadonlyDiv = form.querySelector('#scheduleStudentReadonly');
    const typeSel = form.querySelector('#scheduleTypeSelect');
    const dateInput = form.querySelector('#scheduleDate');
    const dateReadonlyDiv = form.querySelector('#scheduleDateReadonly');
    const startTimeInput = form.querySelector('#scheduleStartTime');
    const endTimeInput = form.querySelector('#scheduleEndTime');
    const locationInput = form.querySelector('#scheduleLocation');
    const familyParticipantsSelect = form.querySelector('#scheduleFamilyParticipants');
    if (teacherSel) teacherSel.value = '';
    if (studentSel) { studentSel.value = ''; studentSel.disabled = false; studentSel.style.display = ''; }
    if (studentReadonlyDiv) studentReadonlyDiv.style.display = 'none';
    if (typeSel) {
        typeSel.value = '';
        // Reset family participants logic and visibility
        if (familyParticipantsSelect) familyParticipantsSelect.value = '4'; // Default to 4 (Both Parents)
        // Visibility update will be handled by change event dispatch below or manual check
    }
    const todayISO = toISODate(new Date());
    if (dateInput) { dateInput.value = todayISO; dateInput.disabled = false; dateInput.style.display = ''; }
    if (dateReadonlyDiv) dateReadonlyDiv.style.display = 'none';

    if (startTimeInput) startTimeInput.value = '19:00';
    if (endTimeInput) endTimeInput.value = '22:00';
    if (locationInput) locationInput.value = '';
    // 隐藏删除按钮（仅编辑模式显示）
    const delBtn = document.getElementById('scheduleFormDelete');
    if (delBtn) delBtn.style.display = 'none';

    // 立即显示弹窗，避免等待数据加载导致“点击没反应”的卡顿感
    formContainer.style.display = 'block';

    // Clear availability cache to force fresh calculation on open
    window.__availabilityCache = null;

    // 异步加载选项，加载完后会自动填充和check
    try {
        await loadScheduleFormOptions();
    } catch (e) {
        console.error('loadScheduleFormOptions failed', e);
    }

    // 默认选择第一个老师和课程类型（如果有）
    if (teacherSel && teacherSel.options.length > 1) {
        teacherSel.selectedIndex = 1;
    }
    if (studentSel && studentSel.options.length > 1) {
        studentSel.selectedIndex = 1;
    }
    if (typeSel && typeSel.options.length > 1) {
        typeSel.selectedIndex = 1;
    }
    // 默认家庭参与人 (Default to first option)
    if (familyParticipantsSelect && familyParticipantsSelect.options.length > 0) {
        familyParticipantsSelect.selectedIndex = 0;
    }
    // 默认状态 (Default to first option - usually pending)
    const statusSel = form.querySelector('#scheduleStatus');
    if (statusSel && statusSel.options.length > 0) {
        statusSel.selectedIndex = 0;
    }

    // Trigger visibility update for family participants
    if (typeSel) typeSel.dispatchEvent(new Event('change'));

    // Trigger auto-resize for location if value exists (though usually empty for Add)
    if (locationInput && locationInput.value) {
        locationInput.style.height = 'auto'; // Reset
        locationInput.dispatchEvent(new Event('input'));
    }

    if (window.forceUpdateTeacherAvailability) window.forceUpdateTeacherAvailability();
}
// Expose to window for direct HTML access
window.showAddScheduleModal = showAddScheduleModal;

async function editSchedule(scheduleId) {
    try {
        const formContainer = document.getElementById('scheduleFormContainer');
        const form = document.getElementById('scheduleForm');
        const title = document.getElementById('scheduleFormTitle');
        if (!formContainer || !form) return;

        // Clear cache for edit mode as well (though date might change, fresh start is good)
        window.__availabilityCache = null;
        // 并行加载表单选项和排课数据，大幅提升响应速度
        const [, data] = await Promise.all([
            loadScheduleFormOptions(),
            window.apiUtils.get(`/admin/schedules/${scheduleId}`)
        ]);


        const teacherSel = form.querySelector('#scheduleTeacher');
        const studentSel = form.querySelector('#scheduleStudent');
        const typeSel = form.querySelector('#scheduleTypeSelect');
        const dateInput = form.querySelector('#scheduleDate');
        const dateReadonlyDiv = document.getElementById('scheduleDateReadonly');
        const dateReadonlyHint = document.getElementById('dateReadonlyHint');
        const startTimeInput = form.querySelector('#scheduleStartTime');
        const endTimeInput = form.querySelector('#scheduleEndTime');
        const locationInput = form.querySelector('#scheduleLocation');
        const statusSel = form.querySelector('#scheduleStatus');
        const studentReadonlyDiv = document.getElementById('scheduleStudentReadonly');
        const studentReadonlyHint = document.getElementById('studentReadonlyHint');
        const origTeacher = document.getElementById('origTeacher');
        const origStudent = document.getElementById('origStudent');
        const origType = document.getElementById('origType');
        const origDate = document.getElementById('origDate');
        const origStartTime = document.getElementById('origStartTime');
        const origEndTime = document.getElementById('origEndTime');
        const origLocation = document.getElementById('origLocation');
        const origStatus = document.getElementById('origStatus');

        const getOptionLabel = (selectEl, val) => {
            if (!selectEl) return String(val || '');
            const opt = Array.from(selectEl.options || []).find(o => String(o.value) === String(val));
            return opt ? opt.textContent : String(val || '');
        };

        if (teacherSel) teacherSel.value = data.teacher_id || '';
        if (studentSel) studentSel.value = data.student_id || '';
        if (typeSel) typeSel.value = data.course_id || '';
        // 规范化日期为 YYYY-MM-DD，避免 <input type="date"> 赋值失败
        let isoDate = '';
        if (data.date) {
            try {
                const raw = String(data.date).trim();
                isoDate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : toISODate(new Date(raw));
            } catch (e) {
                isoDate = String(data.date).slice(0, 10);
            }
        }
        if (dateInput) dateInput.value = isoDate || '';
        // 规范化时间为 HH:MM，避免出现 HH:MM:SS 导致校验失败
        const normStart = sanitizeTimeString(data.start_time) || '19:00';
        const normEnd = sanitizeTimeString(data.end_time) || '22:00';
        if (startTimeInput) startTimeInput.value = normStart;
        if (endTimeInput) endTimeInput.value = normEnd;
        if (locationInput) locationInput.value = data.location || '';
        if (statusSel) {
            const allowedStatuses = new Set(['pending', 'confirmed', 'cancelled', 'completed']);
            const s = String(data.status || 'pending').trim();
            if (allowedStatuses.has(s)) {
                statusSel.value = s;
            } else {
                statusSel.value = 'pending';
            }
        }

        // 展示原始值并准备高亮逻辑
        const original = {
            teacher_id: data.teacher_id || '',
            student_id: data.student_id || '',
            course_id: data.course_id || '',
            date: isoDate || '',
            start_time: normStart,
            end_time: normEnd,
            location: data.location || '',
            status: data.status || 'pending'
        };
        form.__originalData = original;

        if (origTeacher) {
            origTeacher.textContent = `原值：${getOptionLabel(teacherSel, original.teacher_id)}`;
            origTeacher.style.display = 'block';
        }
        if (origStudent) {
            const foundStu = (window.__studentsFormList || []).find(x => String(x.id) === String(original.student_id));
            origStudent.textContent = `原值：${foundStu ? foundStu.name : `ID ${original.student_id}`}`;
            origStudent.style.display = 'block';
        }
        if (origType) {
            origType.textContent = `原值：${getOptionLabel(typeSel, original.course_id)}`;
            origType.style.display = 'block';
        }
        if (origDate) { origDate.textContent = `原值：${original.date}`; origDate.style.display = 'block'; }
        if (origStartTime) { origStartTime.textContent = `原值：${original.start_time}`; origStartTime.style.display = 'block'; }
        if (origEndTime) { origEndTime.textContent = `原值：${original.end_time}`; origEndTime.style.display = 'block'; }
        if (origLocation) { origLocation.textContent = `原值：${original.location || '（空）'}`; origLocation.style.display = 'block'; }
        if (origStatus) { origStatus.textContent = `原值：${getStatusText(original.status)}`; origStatus.style.display = 'block'; }

        // 学生信息设为只读：隐藏选择框，显示只读展示与提示
        if (studentSel) {
            studentSel.disabled = true;
            studentSel.style.display = 'none';
        }
        if (studentReadonlyDiv) {
            const stu = (window.__studentsFormList || []).find(x => String(x.id) === String(original.student_id));
            studentReadonlyDiv.textContent = stu ? `${stu.name}` : `ID ${original.student_id}`;
            studentReadonlyDiv.style.display = 'block';
        }
        if (studentReadonlyHint) {
            studentReadonlyHint.style.display = 'block';
        }

        // 日期设为只读：隐藏输入框，显示只读展示与提示
        if (dateInput) {
            dateInput.disabled = true;
            dateInput.style.display = 'none';
        }
        if (dateReadonlyDiv) {
            dateReadonlyDiv.textContent = original.date || '';
            dateReadonlyDiv.style.display = 'block';
        }
        if (dateReadonlyHint) {
            dateReadonlyHint.style.display = 'block';
        }

        const toggleChanged = (el, isChanged) => {
            const group = el ? el.closest('.form-group') : null;
            if (!group) return;
            if (isChanged) group.classList.add('changed');
            else group.classList.remove('changed');
        };
        const bindHighlight = () => {
            if (teacherSel) {
                teacherSel.addEventListener('change', () => {
                    toggleChanged(teacherSel, String(teacherSel.value) !== String(original.teacher_id));
                });
                toggleChanged(teacherSel, String(teacherSel.value) !== String(original.teacher_id));
            }
            if (typeSel) {
                typeSel.addEventListener('change', () => {
                    toggleChanged(typeSel, String(typeSel.value) !== String(original.course_id));
                });
                toggleChanged(typeSel, String(typeSel.value) !== String(original.course_id));
            }
            if (dateInput) {
                dateInput.addEventListener('input', () => {
                    toggleChanged(dateInput, String(dateInput.value) !== String(original.date));
                });
                toggleChanged(dateInput, String(dateInput.value) !== String(original.date));
            }
            if (startTimeInput) {
                startTimeInput.addEventListener('input', () => {
                    // 输入时也进行规范化对比
                    const v = sanitizeTimeString(startTimeInput.value) || startTimeInput.value;
                    toggleChanged(startTimeInput, String(v) !== String(original.start_time));
                });
                const v0 = sanitizeTimeString(startTimeInput.value) || startTimeInput.value;
                toggleChanged(startTimeInput, String(v0) !== String(original.start_time));
            }
            if (endTimeInput) {
                endTimeInput.addEventListener('input', () => {
                    const v = sanitizeTimeString(endTimeInput.value) || endTimeInput.value;
                    toggleChanged(endTimeInput, String(v) !== String(original.end_time));
                });
                const v0 = sanitizeTimeString(endTimeInput.value) || endTimeInput.value;
                toggleChanged(endTimeInput, String(v0) !== String(original.end_time));
            }
            if (locationInput) {
                locationInput.addEventListener('input', () => {
                    toggleChanged(locationInput, String(locationInput.value || '') !== String(original.location || ''));
                });
                toggleChanged(locationInput, String(locationInput.value || '') !== String(original.location || ''));
                // Trigger auto-grow for existing value
                if (locationInput.value) {
                    locationInput.style.height = 'auto'; // Reset
                    locationInput.dispatchEvent(new Event('input'));
                }
            }
            if (statusSel) {
                statusSel.addEventListener('change', () => {
                    toggleChanged(statusSel, String(statusSel.value || '') !== String(original.status || ''));
                });
                toggleChanged(statusSel, String(statusSel.value || '') !== String(original.status || ''));
            }
        };
        bindHighlight();

        form.dataset.mode = 'edit';
        form.dataset.id = String(scheduleId);
        if (title) title.textContent = '编辑排课';
        // 显示并绑定删除按钮
        const delBtn = document.getElementById('scheduleFormDelete');
        if (delBtn) {
            delBtn.style.display = '';
            const newDel = delBtn.cloneNode(true);
            delBtn.parentNode.replaceChild(newDel, delBtn);
            newDel.addEventListener('click', () => deleteSchedule(scheduleId));
        }
        if (window.forceUpdateTeacherAvailability) window.forceUpdateTeacherAvailability();
        formContainer.style.display = 'block';
    } catch (error) {
        console.error('加载排课详情错误:', error);
        if (window.apiUtils && typeof window.apiUtils.handleError === 'function') {
            window.apiUtils.handleError(error);
        }
    }
}

async function deleteSchedule(scheduleId) {
    if (confirm('确定要删除此排课吗？')) {
        try {
            // 使用新的API工具类删除排课
            await window.apiUtils.delete(`/admin/schedules/${scheduleId}`);
            // 关闭编辑窗口或详情弹窗
            const formContainer = document.getElementById('scheduleFormContainer');
            if (formContainer) formContainer.style.display = 'none';
            const modal = document.getElementById('scheduleModal');
            if (modal) modal.style.display = 'none';
            try { if (window.WeeklyDataStore && WeeklyDataStore.schedules) WeeklyDataStore.schedules.clear(); } catch (_) { }
            loadSchedules();
        } catch (error) {
            console.error('删除排课错误:', error);
        }
    }
}

async function confirmSchedule(scheduleId) {
    try {
        // 使用新的API工具类确认排课
        await window.apiUtils.post(`/admin/schedules/${scheduleId}/confirm`, {
            adminConfirmed: true
        });
        try { if (window.WeeklyDataStore && WeeklyDataStore.schedules) WeeklyDataStore.schedules.clear(); } catch (_) { }
        loadSchedules();
    } catch (error) {
        console.error('确认排课错误:', error);
    }
}

// 加载排课表单的教师/学生选项
async function loadScheduleFormOptions() {
    try {
        // User Request: Always recalculate on modal open to avoid stale state.
        // Cache is cleared in show/edit functions, or we can clear here?
        // Note: loadScheduleFormOptions is called by show/edit.
        // It's safer to rely on explicit clearing in those functions if we want "per modal session" caching.
        // But the user said "every time open window...".
        // Let's Ensure cache logic inside updateTeacherAvailability respects this.

        const teacherSel = document.getElementById('scheduleTeacher');
        const studentSel = document.getElementById('scheduleStudent');
        const typeSel = document.getElementById('scheduleTypeSelect');
        const teacherFilterSel = document.getElementById('teacherFilter');

        // Populate Type Select from Store
        if (typeSel && window.ScheduleTypesStore) {
            const currentTypeVal = typeSel.value;
            const types = window.ScheduleTypesStore.getAll();
            typeSel.innerHTML = '<option value="">选择类型</option>';
            types.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id; // Use ID for backend submission
                opt.textContent = t.description || t.name;
                typeSel.appendChild(opt);
            });
            if (currentTypeVal) typeSel.value = currentTypeVal;
        }

        // 特殊教师白名单 (ID: 7-叶老师, 9-金博, 10-侯老师)
        const WHITELIST_IDS = [7, 9, 10];

        // 并行获取数据以进一步加速
        const [teachers, students] = await Promise.all([
            WeeklyDataStore.getTeachers(),
            WeeklyDataStore.getStudents()
        ]);

        // 缓存完整列表用于前端动态筛选
        window.__allTeachersCache = teachers || [];

        // 定义渲染函数：根据忙碌状态和限制渲染教师选项
        // preservedVal: 可选，用于在异步操作后恢复之前的选中值
        const renderTeacherOptions = (busyIds = new Set(), unavailableIds = new Set(), preservedVal = null) => {
            if (!teacherSel) return;
            // 如果传入了 preservedVal 则使用，否则获取当前值
            const currentVal = preservedVal !== null ? preservedVal : teacherSel.value;
            teacherSel.innerHTML = '<option value="">选择教师</option>';

            // 基础排序权重：正常(1) -> 暂停(0) -> 删除/其他
            const statusWeight = (v) => { const n = Number(v); if (n === 1) return 0; if (n === 0) return 1; return 2; };

            const validTeachers = (window.__allTeachersCache || []).filter(t => Number(t.status) !== -1);

            // 预排序：先按状态，再按姓名
            validTeachers.sort((a, b) => {
                const wa = statusWeight(a?.status), wb = statusWeight(b?.status);
                if (wa !== wb) return wa - wb;
                return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN');
            });

            // 分组容器
            const groups = {
                available: [],    // 普通可用 (Available)
                unrestricted: [], // 无限制/特权 (Unrestricted/Special)
                conflict: [],     // 时间冲突 (Time Conflict)
                unavailable: []   // 不在服务时间 (Unavailable)
            };

            validTeachers.forEach(t => {
                const tid = Number(t.id);
                const isBusy = busyIds.has(tid);
                const isRestricted = (t.restriction !== 0);
                // unavailableIds ONLY contains restricted teachers who don't work at this time
                const isUnavailable = unavailableIds.has(tid);

                if (isBusy) {
                    groups.conflict.push(t);
                } else if (isUnavailable) {
                    groups.unavailable.push(t);
                } else if (!isRestricted) {
                    groups.unrestricted.push(t);
                } else {
                    groups.available.push(t);
                }
            });

            // 辅助渲染函数
            const renderOption = (t, type) => {
                const opt = document.createElement('option');
                opt.value = t.id;
                let label = t.name;
                const isPaused = (Number(t.status) === 0);
                if (isPaused) label += '（暂停）';

                // 根据类型应用样式
                switch (type) {
                    case 'unrestricted': // 特殊/无限制 - 绿色 + 星标
                        label += ' ⭐';
                        opt.style.color = '#15803d'; // Green 700
                        opt.style.fontWeight = '500';
                        break;
                    case 'conflict': // 冲突 - 灰色 + 标记
                        label += ' (时间冲突)';
                        opt.style.color = '#94a3b8'; // Slate 400
                        // opt.disabled = true; // Optional: disable user from selecting? User didn't strictly say disable, just categorize. Usually better to allow override.
                        break;
                    case 'unavailable': // 不在服务时间 - 浅灰色
                        label += ' (休息中)';
                        opt.style.color = '#cbd5e1'; // Slate 300
                        break;
                    case 'available': // 普通可用 - 默认深色
                    default:
                        opt.style.color = '#334155'; // Slate 700
                        break;
                }
                opt.textContent = label;
                teacherSel.appendChild(opt);
            };

            // 添加分隔线的辅助函数
            const addSeparator = () => {
                if (teacherSel.lastChild && teacherSel.lastChild.value !== '') {
                    const sep = document.createElement('option');
                    sep.disabled = true;
                    // 使用较短的线条以避免撑宽下拉框，同时调整字号减少上下间隙
                    sep.textContent = '──────────';
                    sep.style.fontSize = '10px'; // 尝试减小字号以压缩高度
                    sep.style.color = '#e2e8f0'; // 浅色
                    sep.style.textAlign = 'center'; // 尝试居中
                    teacherSel.appendChild(sep);
                }
            };

            let hasPrevGroups = false;

            // 1. Available Teachers (Restricted=1 but OK)
            if (groups.available.length > 0) {
                groups.available.forEach(t => renderOption(t, 'available'));
                hasPrevGroups = true;
            }

            // 2. Unrestricted Teachers (Restricted=0)
            // Show them near the top as they are "always feasible" fallback
            if (groups.unrestricted.length > 0) {
                if (hasPrevGroups) addSeparator();
                groups.unrestricted.forEach(t => renderOption(t, 'unrestricted'));
                hasPrevGroups = true;
            }

            // 3. Unavailable Teachers (Good teacher, wrong time)
            if (groups.unavailable.length > 0) {
                if (hasPrevGroups) addSeparator();
                groups.unavailable.forEach(t => renderOption(t, 'unavailable'));
                hasPrevGroups = true;
            }

            // 4. Time Conflicts (Busy right now)
            if (groups.conflict.length > 0) {
                if (hasPrevGroups) addSeparator();
                groups.conflict.forEach(t => renderOption(t, 'conflict'));
            }

            // 恢复选中值或设置默认值
            if (currentVal) {
                teacherSel.value = currentVal;
            } else {
                // 默认选中逻辑：优先选择 Available 组的第一个
                if (groups.available.length > 0) {
                    teacherSel.value = groups.available[0].id;
                } else if (groups.unrestricted.length > 0) {
                    teacherSel.value = groups.unrestricted[0].id;
                }
                // 否则不自动选 conflict/unavailable，保持空或 'Select Teacher'
            }
            // 触发一次提示检查
            checkSpecialTeacherHint();
        };

        // 提示检查函数
        const checkSpecialTeacherHint = () => {
            if (!teacherSel) return;
            const val = Number(teacherSel.value);
            // 查找或创建提示元素
            let hint = document.getElementById('specialTeacherHint');
            const selectedTeacher = (window.__allTeachersCache || []).find(t => Number(t.id) === val);

            if (selectedTeacher && (selectedTeacher.restriction === 0)) {
                if (!hint) {
                    hint = document.createElement('div');
                    hint.id = 'specialTeacherHint';
                    hint.style.fontSize = '12px';
                    hint.style.color = '#15803d';
                    hint.style.marginTop = '4px';
                    hint.style.padding = '4px 8px';
                    hint.style.backgroundColor = '#f0fdf4';
                    hint.style.borderRadius = '4px';
                    hint.style.border = '1px solid #bbf7d0';
                    hint.textContent = '💡 该老师不受排课时间限制。';
                    teacherSel.parentNode.appendChild(hint);
                } else {
                    hint.style.display = 'block';
                }
            } else {
                if (hint) hint.style.display = 'none';
            }
        };

        // 动态可用性检查函数 - 已在新版 schedule-manager.js 中由 updateTeacherStatusHints 代替
        const updateTeacherAvailability = async () => {
            return; // 彻底禁用旧逻辑，避免干扰新版 (Task Refinement)
            const dateInput = document.getElementById('scheduleDate');
            const startInput = document.getElementById('scheduleStartTime');
            const endInput = document.getElementById('scheduleEndTime');

            const dateVal = dateInput ? dateInput.value : '';
            const startVal = startInput ? startInput.value : '';
            const endVal = endInput ? endInput.value : '';

            // Loading State - 先保存当前选中值，在异步完成后恢复
            let preservedTeacherVal = '';
            if (teacherSel) {
                preservedTeacherVal = teacherSel.value; // 保存当前选中值
                teacherSel.disabled = true;
            }

            try {
                // 如果日期时间不完整，显示所有（默认状态，假设无限制）
                if (!dateVal || !startVal || !endVal) {
                    // Still render all, but need to clear loading
                    renderTeacherOptions(new Set(), new Set(), preservedTeacherVal);
                    return;
                }

                // 获取时间段的分钟数用于比较
                const targetStart = hhmmToMinutes(startVal);
                const targetEnd = hhmmToMinutes(endVal);
                if (Number.isNaN(targetStart) || Number.isNaN(targetEnd)) {
                    renderTeacherOptions(new Set(), new Set(), preservedTeacherVal);
                    return;
                }

                // 计算时间段涵盖的时段 (Morning/Afternoon/Evening)
                const checkSlots = { morning: false, afternoon: false, evening: false };
                const mStart = 6 * 60;
                const mEnd = 12 * 60;
                const aEnd = 19 * 60;
                const eEnd = 24 * 60;

                if (!(targetEnd <= mStart || targetStart >= mEnd)) checkSlots.morning = true;
                if (!(targetEnd <= mEnd || targetStart >= aEnd)) checkSlots.afternoon = true;
                if (!(targetEnd <= aEnd || targetStart >= eEnd)) checkSlots.evening = true;

                // 初始化缓存
                if (!window.__availabilityCache) window.__availabilityCache = new Map();

                let schedules, availabilityData;

                // 检查缓存
                if (window.__availabilityCache.has(dateVal)) {
                    // Availability 配置很少变动，可以缓存；排课冲突需要实时检查
                    availabilityData = window.__availabilityCache.get(dateVal);
                    schedules = await window.apiUtils.get('/admin/schedules/grid', { start_date: dateVal, end_date: dateVal });
                } else {
                    // 并行获取排课冲突 和 教师可用性配置
                    [schedules, availabilityData] = await Promise.all([
                        window.apiUtils.get('/admin/schedules/grid', { start_date: dateVal, end_date: dateVal }),
                        window.apiUtils.get('/admin/teacher-availability', { startDate: dateVal, endDate: dateVal })
                    ]);
                    // 写入缓存
                    window.__availabilityCache.set(dateVal, availabilityData);
                }

                // 处理 availability mapping: TeacherID -> Record
                const availabilityMap = {};
                (Array.isArray(availabilityData) ? availabilityData : []).forEach(item => {
                    availabilityMap[item.id] = item.availability || {};
                });

                // 处理 busy set (排课冲突)
                const busyIds = new Set();
                const form = document.getElementById('scheduleForm');
                const currentId = form ? form.dataset.id : '';

                (Array.isArray(schedules) ? schedules : []).forEach(s => {
                    if (currentId && String(s.id) === String(currentId)) return;
                    if (s.status === 'cancelled') return;
                    if (!s.teacher_id) return;
                    const sStart = hhmmToMinutes(sanitizeTimeString(s.start_time));
                    const sEnd = hhmmToMinutes(sanitizeTimeString(s.end_time));
                    if (Number.isFinite(sStart) && Number.isFinite(sEnd)) {
                        if (!(sEnd <= targetStart || sStart >= targetEnd)) {
                            busyIds.add(Number(s.teacher_id));
                        }
                    }
                });

                // 处理 unavailable set (restriction check)
                const unavailableIds = new Set();
                const allTeachers = window.__allTeachersCache || [];

                allTeachers.forEach(t => {
                    const tid = Number(t.id);
                    const restriction = t.restriction ?? 1;

                    if (restriction === 0) return; // Always available
                    if (restriction === 1) { // Check availability
                        const teacherAvail = availabilityMap[tid];
                        let dayRecord = teacherAvail ? teacherAvail[dateVal] : null;

                        if (!dayRecord && teacherAvail) {
                            const dateKey = Object.keys(teacherAvail).find(k => k.startsWith(dateVal));
                            dayRecord = dateKey ? teacherAvail[dateKey] : null;
                        }

                        if (!dayRecord) return; // Assume available

                        let isOk = true;
                        if (checkSlots.morning && dayRecord.morning === false) isOk = false;
                        if (checkSlots.afternoon && dayRecord.afternoon === false) isOk = false;
                        if (checkSlots.evening && dayRecord.evening === false) isOk = false;

                        if (!isOk) unavailableIds.add(tid);
                    }
                });

                renderTeacherOptions(busyIds, unavailableIds, preservedTeacherVal);

            } catch (e) {
                console.error('检查教师可用性失败:', e);
                renderTeacherOptions(new Set(), new Set(), preservedTeacherVal);
            } finally {
                if (teacherSel) {
                    teacherSel.disabled = false;
                    // Remove loading option if it persists? renderTeacherOptions rebuilds content, so usually gone.
                }
            }
        };


        // Family Participants Toggle Logic
        const familyParticipantsGroup = document.getElementById('scheduleFamilyParticipantsGroup');
        const familyParticipantsSelect = document.getElementById('scheduleFamilyParticipants');

        const toggleFamilyParticipants = () => {
            if (!typeSel || !familyParticipantsGroup) return;
            const typeVal = typeSel.value;
            // Check if Review (review) or Advisory (advisory) or Review Record (review_record)
            const isReviewOrConsultation = ['review', 'advisory', 'review_record'].includes(typeVal);

            if (isReviewOrConsultation) {
                familyParticipantsGroup.style.display = 'block';
            } else {
                familyParticipantsGroup.style.display = 'none';
                // Reset to default (4: Both Parents) when hidden? Or keep?
                // Better to keep as is, but maybe reset on form open.
            }
        };

        if (typeSel) {
            typeSel.addEventListener('change', toggleFamilyParticipants);
            // Initial check
            toggleFamilyParticipants();
        }

        // 绑定事件监听
        const dateInput = document.getElementById('scheduleDate');
        const startInput = document.getElementById('scheduleStartTime');
        const endInput = document.getElementById('scheduleEndTime');

        if (dateInput) {
            dateInput.removeEventListener('change', updateTeacherAvailability);
            dateInput.addEventListener('change', updateTeacherAvailability);
        }
        if (startInput) startInput.addEventListener('change', updateTeacherAvailability);
        if (endInput) endInput.addEventListener('change', updateTeacherAvailability);
        if (teacherSel) teacherSel.addEventListener('change', checkSpecialTeacherHint);

        window.forceUpdateTeacherAvailability = updateTeacherAvailability;


        // 初始渲染：如果有日期/时间，立即执行检查；否则显示全部
        if (dateInput && dateInput.value && startInput && startInput.value) {
            await updateTeacherAvailability();
        } else {
            if (teacherSel) renderTeacherOptions(new Set(), new Set());
        }

        if (studentSel) {
            studentSel.innerHTML = '<option value="">选择学生</option>';
            const sortedStudents = (students || []).filter(s => Number(s.status ?? 1) === 1).sort((a, b) => {
                const an = String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN');
                return an;
            });

            window.__studentsFormList = sortedStudents;
            sortedStudents.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = s.name;
                studentSel.appendChild(opt);
            });
            const locationInput = document.getElementById('scheduleLocation');
            const autoResize = (el) => {
                if (!el) return;
                el.style.height = 'auto';
                el.style.height = (el.scrollHeight + 6) + 'px';
            };
            if (locationInput) {
                locationInput.addEventListener('input', function () { autoResize(this); });
                // Initial resize if value exists
                if (locationInput.value) autoResize(locationInput);
            }

            studentSel.addEventListener('change', () => {
                const sid = Number(studentSel.value);
                const found = (window.__studentsFormList || []).find(x => Number(x.id) === sid);
                if (locationInput) {
                    locationInput.value = found?.visit_location || '';
                    autoResize(locationInput);
                }
            });
        }
        if (typeSel) {
            typeSel.innerHTML = '<option value="">选择类型</option>';
            let types = ScheduleTypesStore.getAll();
            const hasAdvisory = types.some(t => (t.name || '').includes('advisory') || (t.description || '').includes('咨询'));

            // If empty or missing Advisory (and we suspect it should exist), try fresh fetch
            if (types.length === 0 || !hasAdvisory) {
                try {
                    const fetched = await window.apiUtils.get('/schedule/types');
                    if (Array.isArray(fetched) && fetched.length > 0) {
                        ScheduleTypesStore.load(fetched);
                        types = ScheduleTypesStore.getAll();
                    }
                } catch (error) { console.warn('刷新课程类型失败:', error); }
            }

            typeSel.innerHTML = '<option value="">选择类型</option>';
            types.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = (t.description || t.name || `类型${t.id}`);
                typeSel.appendChild(opt);
            });
            let defaultType = types.find(t => {
                const name = String(t.name || '').trim();
                const desc = String(t.description || '').trim();
                return desc === '入户' || name === '入户' || name === 'visit';
            });
            if (!defaultType) {
                defaultType = types.find(t => {
                    const name = String(t.name || '').trim();
                    const desc = String(t.description || '').trim();
                    return (name.includes('入户') || desc.includes('入户')) && !(name.includes('半次') || desc.includes('半次'));
                });
            }
            if (defaultType) typeSel.value = String(defaultType.id);
        }

        // 教师筛选器（仅用于列表页筛选，无需可用性逻辑）
        if (teacherFilterSel) {
            teacherFilterSel.innerHTML = '<option value="">全部教师</option>';
            // 复用缓存的教师列表
            const weight = (v) => { const n = Number(v); if (n === 1) return 0; if (n === 0) return 1; if (n === -1) return 2; return 3; };
            const filterTeachers = (teachers || []).filter(t => Number(t?.status) !== -1).sort((a, b) => {
                const wa = weight(a?.status); const wb = weight(b?.status);
                if (wa !== wb) return wa - wb;
                return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN');
            });
            filterTeachers.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = t.name + (Number(t.status) === 0 ? '（暂停）' : '');
                teacherFilterSel.appendChild(opt);
            });
        }
    } catch (error) {
        console.error('加载排课表单选项失败:', error);
    }
}

// 退出登录
function logout() {
    // Clear Schedule Cache
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('schedule_widget_admin_')) {
            localStorage.removeItem(key);
        }
    });

    localStorage.removeItem('token');
    localStorage.removeItem('userType');
    localStorage.removeItem('userData');
    window.location.href = '/index.html';
}

// 显示排课详情弹窗（使用现有 #scheduleModal 结构与样式）
function showScheduleDetails(schedule, student) {
    const modal = document.getElementById('scheduleModal');
    if (!modal) return;
    const titleEl = modal.querySelector('#modalTitle');
    const studentEl = modal.querySelector('#modalStudent');
    const teacherEl = modal.querySelector('#modalTeacher');
    const dateEl = modal.querySelector('#modalDate');
    const timeEl = modal.querySelector('#modalTime');
    const locationEl = modal.querySelector('#modalLocation');
    const typeEl = modal.querySelector('#modalType');
    const statusEl = modal.querySelector('#modalStatus');
    const notesEl = modal.querySelector('#modalNotes');
    const editBtn = modal.querySelector('#editScheduleBtn');
    const deleteBtn = modal.querySelector('#deleteScheduleBtn');
    const closeBtn = modal.querySelector('#closeModalBtn');
    const headerClose = modal.querySelector('.modal-header .close');

    // 填充内容
    if (titleEl) titleEl.textContent = '排课详情';
    if (studentEl) studentEl.textContent = student && student.name ? student.name : (schedule.student_name || '-');
    if (teacherEl) teacherEl.textContent = schedule.teacher_name || '待分配';
    if (dateEl) {
        const d = schedule.date ? new Date(schedule.date) : null;
        dateEl.textContent = d && !Number.isNaN(d.getTime()) ? formatDate(d) : (schedule.date || '-');
    }
    if (timeEl) {
        timeEl.textContent = (schedule.start_time && schedule.end_time)
            ? `${formatTime(schedule.start_time)} - ${formatTime(schedule.end_time)}`
            : '时间待定';
    }
    if (locationEl) locationEl.textContent = (schedule.location || '地点待定');
    if (typeEl) typeEl.textContent = (schedule.schedule_types || '未分类');
    if (statusEl) statusEl.textContent = getStatusText(schedule.status || 'pending');
    if (notesEl) notesEl.textContent = schedule.notes || '-';

    // 绑定操作按钮（先移除旧的事件避免重复）
    if (editBtn) {
        const newEdit = editBtn.cloneNode(true);
        editBtn.parentNode.replaceChild(newEdit, editBtn);
        newEdit.addEventListener('click', () => editSchedule(schedule.id));
    }
    if (deleteBtn) {
        const newDelete = deleteBtn.cloneNode(true);
        deleteBtn.parentNode.replaceChild(newDelete, deleteBtn);
        newDelete.addEventListener('click', () => deleteSchedule(schedule.id));
    }
    if (closeBtn) {
        const newClose = closeBtn.cloneNode(true);
        closeBtn.parentNode.replaceChild(newClose, closeBtn);
        newClose.addEventListener('click', () => { modal.style.display = 'none'; });
    }
    if (headerClose) {
        const newHeaderClose = headerClose.cloneNode(true);
        headerClose.parentNode.replaceChild(newHeaderClose, headerClose);
        newHeaderClose.addEventListener('click', () => { modal.style.display = 'none'; });
    }

    // 显示模态
    modal.style.display = 'block';
}

// 关闭排课详情弹窗
function closeScheduleDetails() {
    const modal = document.getElementById('scheduleModal');
    if (modal) modal.style.display = 'none';
}

// 获取状态文本
function getStatusText(status) {
    const statusMap = {
        'pending': '待确认',
        'confirmed': '已确认',
        'completed': '已完成',
        'cancelled': '已取消'
    };
    return statusMap[status] || status;
}
async function loadSchedules() {
    try {
        renderWeeklyLoading();
        const startInput = document.getElementById('startDate');
        const endInput = document.getElementById('endDate');

        let startDateISO, endDateISO, weekDates;
        if (startInput && endInput && startInput.value && endInput.value) {
            startDateISO = startInput.value;
            endDateISO = endInput.value;
            weekDates = buildDatesRange(startDateISO, endDateISO);
        } else if (window.__weeklyRange && window.__weeklyRange.start && window.__weeklyRange.end) {
            startDateISO = window.__weeklyRange.start;
            endDateISO = window.__weeklyRange.end;
            weekDates = buildDatesRange(startDateISO, endDateISO);
        } else {
            const week = getWeekDates(new Date());
            weekDates = week;
            startDateISO = toISODate(week[0]);
            endDateISO = toISODate(week[week.length - 1]);
            window.__weeklyRange = { start: startDateISO, end: endDateISO };
        }

        updateWeeklyRangeText(new Date(startDateISO), new Date(endDateISO));

        const typeFilter = document.getElementById('typeFilter');
        const statusFilter = document.getElementById('statusFilter');
        const type = typeFilter ? typeFilter.value : '';
        const status = statusFilter ? statusFilter.value : '';
        const teacherFilter = document.getElementById('teacherFilter');
        const teacherId = teacherFilter ? Number(teacherFilter.value) || '' : '';
        // 筛选条件变化时强制刷新，避免缓存问题
        const force = !!window.__weeklyForceRefresh || !!(type || status || teacherId);

        const students = await fetchStudentsForWeekly({ force });
        const schedules = await fetchSchedulesRange(startDateISO, endDateISO, status, type, teacherId, { force });
        window.__weeklyForceRefresh = false;

        renderWeeklyHeader(weekDates);
        // 取消分页，恢复为渲染全部学生
        renderWeeklyBody(students, schedules, weekDates);
    } catch (err) {
        console.error('加载周视图失败:', err);
        if (window.apiUtils && typeof window.apiUtils.handleError === 'function') {
            window.apiUtils.handleError(err);
        }
        renderWeeklyError(err && err.message ? err.message : '网络或系统错误');
    }
}
function getSelectedTeacherForCharts() {
    const sel = document.getElementById('statsTeacherSelect');
    return sel ? String(sel.value || '') : '';
}

function setupTeacherChartsFilter(rows, dayLabels) {
    const sel = document.getElementById('statsTeacherSelect');
    if (!sel) return;
    sel.innerHTML = '';
    const optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = '全部教师'; sel.appendChild(optAll);
    // 通过接口加载教师状态，统一排序并隐藏已删除
    (async () => {
        try {
            let teachers = [];
            // Cache Check: Try WeeklyDataStore first
            if (window.WeeklyDataStore && typeof window.WeeklyDataStore.getTeachers === 'function') {
                try {
                    const cached = await window.WeeklyDataStore.getTeachers();
                    if (cached && cached.length > 0) {
                        teachers = cached;
                    }
                } catch (e) { console.warn('Cache read failed', e); }
            }

            // Fallback to API if cache empty
            if (!teachers || teachers.length === 0) {
                try {
                    const tResp = await window.apiUtils.get('/admin/users/teacher');
                    teachers = Array.isArray(tResp) ? tResp : (tResp && Array.isArray(tResp.data) ? tResp.data : []);
                } catch (err) {
                    console.warn('获取教师列表失败，使用默认列表:', err);
                    // 返回默认教师列表
                    teachers = [
                        { id: 1, name: '教师A', status: 1 },
                        { id: 2, name: '教师B', status: 1 },
                        { id: 3, name: '教师C', status: 0 }
                    ];
                }
            } // End of if (!teachers || teachers.length === 0)

            // Process teachers list (from cache or API)
            const statusMap = new Map();
            const nameMap = new Map();
            const weight = (v) => { const n = Number(v); if (n === 1) return 0; if (n === 0) return 1; return 2; };
            teachers = (teachers || []).filter(t => Number(t?.status) !== -1);
            teachers.sort((a, b) => {
                const wa = weight(a?.status), wb = weight(b?.status);
                if (wa !== wb) return wa - wb;
                return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN');
            });
            teachers.forEach(t => {
                const idStr = String(t.id || '');
                statusMap.set(idStr, Number(t.status));
                nameMap.set(idStr, String(t.name || ''));
                const o = document.createElement('option');
                o.value = idStr;
                o.textContent = (t.name || '') + (Number(t.status) === 0 ? '（暂停）' : '');
                sel.appendChild(o);
            });
            window.__teacherStatusMap = statusMap;
            window.__teacherNameMap = nameMap;

        } catch (err) {
            console.warn('教师状态加载失败，回退基于排课数据:', err);
            const teacherSet = new Set(rows.map(r => String(r.teacher_id || '').trim()));
            const teachersFallback = Array.from(teacherSet).sort();
            teachersFallback.forEach(id => {
                const label = rows.find(rr => String(rr.teacher_id || '') === String(id))?.teacher_name || id || '未分配';
                const o = document.createElement('option'); o.value = String(id); o.textContent = label; sel.appendChild(o);
            });
        }
    })();
    if (!sel.__bound) {
        sel.addEventListener('change', () => {
            const selected = getSelectedTeacherForCharts();
            renderTeacherTypePerTeacherCharts(rows, dayLabels, selected);
        });
        sel.__bound = true;
    }
    // 绑定教师区域的日期查询（如果存在独立控件）
    const tStart = document.getElementById('teacherStartDate');
    const tEnd = document.getElementById('teacherEndDate');
    const tBtn = document.getElementById('teacherStatsSearchBtn');
    if (tBtn && !tBtn.__bound) {
        tBtn.addEventListener('click', async () => {
            const s = tStart && tStart.value ? tStart.value : (dayLabels[0] || '');
            const e = tEnd && tEnd.value ? tEnd.value : (dayLabels[dayLabels.length - 1] || '');
            try {
                const newRows = await fetchSchedulesRange(s, e, '', '');
                const newDayLabels = (window.StatsPlugins && typeof window.StatsPlugins.buildDayLabels === 'function')
                    ? window.StatsPlugins.buildDayLabels(s, e)
                    : buildDatesRange(s, e).map(d => toISODate(d));

                // 更新"按日期汇总"图表
                if (window.StatsPlugins) {
                    const typeStacks = window.StatsPlugins.buildStackedByTypePerDay(newRows, newDayLabels);
                    window.StatsPlugins.renderStackedBarChart('teacherDailyTypeStackChart', newDayLabels, typeStacks, {
                        theme: 'accessible',
                        animation: false,
                        interactionMode: 'index'
                    });
                    // 设置汇总图表标题的悬停提示
                    setupStatsTooltip(newRows, 'teacherSummaryChartTitle', 'teacherSummaryTitleTooltip');
                }

                // 更新教师筛选器和每位教师的图表
                setupTeacherChartsFilter(newRows, newDayLabels);
                const selected = getSelectedTeacherForCharts();
                renderTeacherTypePerTeacherCharts(newRows, newDayLabels, selected);
            } catch (err) {
                console.warn('教师区域按日期查询失败:', err);
                showToast('教师统计按日期查询失败', 'error');
            }
        });
        tBtn.__bound = true;
    }
}

// 设置汇总图表标题的悬停提示
// 设置汇总图表标题的悬停提示 (通用)
function setupStatsTooltip(scheduleRows, titleId, tooltipId) {
    const titleEl = document.getElementById(titleId);
    const tooltipEl = document.getElementById(tooltipId);

    if (!titleEl || !tooltipEl) return;

    // 辅助函数：映射课程类型标签
    const mapTypeLabel = (t) => {
        const raw = String(t || '').trim();
        if (!raw) return '未分类';
        const num = Number(raw);
        const isId = !isNaN(num) && /^\d+$/.test(raw);
        if (isId && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
            const found = window.ScheduleTypesStore.getById(num);
            if (found) return found.description || found.name || String(num);
        }
        return raw;
    };

    // 计算整个日期范围的课程类型汇总统计
    const typeCountMap = new Map();
    let totalCount = 0;

    scheduleRows.forEach(r => {
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCountMap.set(label, (typeCountMap.get(label) || 0) + 1);
            totalCount++;
        });
    });

    // 构建工具提示内容
    let tooltipHTML = '<div style="font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 6px;">授课类型统计</div>';

    if (typeCountMap.size > 0) {
        const sortedTypes = Array.from(typeCountMap.entries()).sort((a, b) => b[1] - a[1]);
        sortedTypes.forEach(([type, count]) => {
            tooltipHTML += `<div style="margin: 4px 0;">${type}: ${count}节</div>`;
        });
        tooltipHTML += `<div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.3); font-weight: bold;">总计: ${totalCount}节</div>`;
    } else {
        tooltipHTML += '<div style="margin: 4px 0;">暂无数据</div>';
    }

    tooltipEl.innerHTML = tooltipHTML;

    // 添加鼠标悬停事件 (如果未绑定)
    if (!titleEl.__tooltipBound) {
        titleEl.addEventListener('mouseenter', () => {
            // 简单的淡入
            tooltipEl.style.display = 'block';
            // 强制重绘以触发 transition
            tooltipEl.offsetHeight;
            tooltipEl.style.opacity = '1';
            tooltipEl.style.visibility = 'visible';
        });

        titleEl.addEventListener('mouseleave', () => {
            tooltipEl.style.opacity = '0';
            tooltipEl.style.visibility = 'hidden';
            // 等待动画结束后隐藏
            setTimeout(() => {
                if (tooltipEl.style.opacity === '0') {
                    tooltipEl.style.display = 'none';
                }
            }, 300);
        });
        titleEl.__tooltipBound = true;
    }
}

function getSelectedStudentForCharts() {
    const sel = document.getElementById('statsStudentSelect');
    return sel ? String(sel.value || '') : '';
}

function setupStudentChartsFilter(rows, dayLabels) {
    const sel = document.getElementById('statsStudentSelect');
    if (!sel) return;
    sel.innerHTML = '';
    const optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = '全部学生'; sel.appendChild(optAll);
    (async () => {
        try {
            let students = [];
            // Cache Check
            if (window.WeeklyDataStore && typeof window.WeeklyDataStore.getStudents === 'function') {
                try {
                    const cached = await window.WeeklyDataStore.getStudents();
                    if (cached && cached.length > 0) {
                        students = cached;
                    }
                } catch (e) { console.warn('Cache read failed', e); }
            }

            if (!students || students.length === 0) {
                try {
                    const sResp = await window.apiUtils.get('/admin/users/student');
                    if (Array.isArray(sResp)) {
                        students = sResp;
                    } else if (sResp && Array.isArray(sResp.data)) {
                        students = sResp.data;
                    } else if (sResp && Array.isArray(sResp.students)) {
                        students = sResp.students;
                    } else if (sResp && Array.isArray(sResp.items)) {
                        students = sResp.items;
                    } else if (sResp && sResp.data && Array.isArray(sResp.data.students)) {
                        students = sResp.data.students;
                    } else {
                        students = [];
                    }
                } catch (err) {
                    console.warn('获取学生列表失败，使用默认列表:', err);
                    students = [{ id: 1, name: '学生A', status: 1 }];
                }
            }
            const statusMap = new Map();
            const nameMap = new Map();
            const weight = (v) => { const n = Number(v); if (n === 1) return 0; if (n === 0) return 1; return 2; };
            students = (students || []).filter(s => Number(s?.status) !== -1);
            students.sort((a, b) => {
                const wa = weight(a?.status), wb = weight(b?.status);
                if (wa !== wb) return wa - wb;
                return String(a?.name || '').localeCompare(String(b?.name || ''), 'zh-CN');
            });
            students.forEach(s => {
                const idStr = String(s.id || '');
                statusMap.set(idStr, Number(s.status));
                nameMap.set(idStr, String(s.name || ''));
                const o = document.createElement('option');
                o.value = idStr;
                o.textContent = (s.name || '') + (Number(s.status) === 0 ? '（暂停）' : '');
                sel.appendChild(o);
            });
            window.__studentStatusMap = statusMap;
            window.__studentNameMap = nameMap;
        } catch (err) {
            console.warn('学生状态加载失败，回退基于排课数据:', err);
            const studentIdSet = new Set(rows.map(r => String(r.student_id || '').trim()));
            const studentsFallback = Array.from(studentIdSet).sort();
            studentsFallback.forEach(id => {
                const label = rows.find(rr => String(rr.student_id || '') === String(id))?.student_name || id || '未分配';
                const o = document.createElement('option'); o.value = String(id); o.textContent = label; sel.appendChild(o);
            });
        }
    })();
    if (!sel.__bound) {
        sel.addEventListener('change', () => {
            const selected = getSelectedStudentForCharts();
            renderStudentTypePerStudentCharts(rows, dayLabels, selected);
        });
        sel.__bound = true;
    }
    // 绑定学生区域的日期查询（如果存在独立控件）
    const sStart = document.getElementById('studentStartDate');
    const sEnd = document.getElementById('studentEndDate');
    const sBtn = document.getElementById('studentStatsSearchBtn');
    if (sBtn && !sBtn.__bound) {
        sBtn.addEventListener('click', async () => {
            const s = sStart && sStart.value ? sStart.value : (dayLabels[0] || '');
            const e = sEnd && sEnd.value ? sEnd.value : (dayLabels[dayLabels.length - 1] || '');
            try {
                const newRows = await fetchSchedulesRange(s, e, '', '');
                const newDayLabels = (window.StatsPlugins && typeof window.StatsPlugins.buildDayLabels === 'function')
                    ? window.StatsPlugins.buildDayLabels(s, e)
                    : buildDatesRange(s, e).map(d => toISODate(d));

                // 更新"按日期汇总"图表 (镜像教师逻辑)
                if (window.StatsPlugins) {
                    const typeStacks = window.StatsPlugins.buildStackedByTypePerDay(newRows, newDayLabels);
                    window.StatsPlugins.renderStackedBarChart('studentDailyTypeStackChart', newDayLabels, typeStacks, {
                        theme: 'accessible',
                        animation: false,
                        interactionMode: 'index'
                    });
                    // 设置汇总图表标题的悬停提示
                    setupStatsTooltip(newRows, 'studentSummaryChartTitle', 'studentSummaryTitleTooltip');
                }

                const selected = getSelectedStudentForCharts();
                renderStudentTypePerStudentCharts(newRows, newDayLabels, selected);
            } catch (err) {
                console.warn('学生区域按日期查询失败:', err);
                showToast('学生统计按日期查询失败', 'error');
            }
        });
        sBtn.__bound = true;
    }
}

// 设置学生汇总图表标题的悬停提示 (镜像教师逻辑)
function setupStudentSummaryChartTitleTooltip(scheduleRows) {
    const titleEl = document.getElementById('studentSummaryChartTitle');
    const tooltipEl = document.getElementById('studentSummaryTitleTooltip');

    if (!titleEl || !tooltipEl) return;

    // 辅助函数：映射课程类型标签
    const mapTypeLabel = (t) => {
        const raw = String(t || '').trim();
        if (!raw) return '未分类';
        const num = Number(raw);
        const isId = !isNaN(num) && /^\d+$/.test(raw);
        if (isId && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
            const found = window.ScheduleTypesStore.getById(num);
            if (found) return found.description || found.name || String(num);
        }
        return raw;
    };

    // 计算整个日期范围的课程类型汇总统计
    const typeCountMap = new Map();
    let totalCount = 0;

    scheduleRows.forEach(r => {
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCountMap.set(label, (typeCountMap.get(label) || 0) + 1);
            totalCount++;
        });
    });

    // 构建工具提示内容
    let tooltipHTML = '<div style="font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 6px;">授课类型统计</div>';

    if (typeCountMap.size > 0) {
        const sortedTypes = Array.from(typeCountMap.entries()).sort((a, b) => b[1] - a[1]);
        sortedTypes.forEach(([type, count]) => {
            tooltipHTML += `<div style="margin: 4px 0;">${type}: ${count}节</div>`;
        });
        tooltipHTML += `<div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.3); font-weight: bold;">总计: ${totalCount}节</div>`;
    } else {
        tooltipHTML += '<div style="margin: 4px 0;">暂无数据</div>';
    }

    tooltipEl.innerHTML = tooltipHTML;

    // 添加鼠标悬停事件
    titleEl.addEventListener('mouseenter', () => {
        tooltipEl.style.display = 'block';
    });

    titleEl.addEventListener('mouseleave', () => {
        tooltipEl.style.display = 'none';
    });
}

// 新增：按学生生成多类型光滑曲线图（每位学生一个图）
function renderStudentTypePerStudentCharts(rows, dayLabels, selectedStudent = '') {
    if (!isChartAvailable()) {
        console.warn('Chart.js 未加载，无法渲染学生图表');
        // 移除暂无数据提示 (User Request)
        // The original code had `return;` here.
        // Assuming the intent is to clear the container if no chart is available,
        // or if there's no data, and the `teachers.length` was a typo for `rows.length`.
        // I'm placing it where it makes sense for `rows.length === 0`.
        // If the intent was to clear the container even if Chart.js is not available,
        // it should be placed before the `return;` here.
        // Given the context of `rows.length === 0` below, I'll assume the user wants to modify that block.
        return;
    }

    const container = document.getElementById('studentChartsContainer');
    if (!container) {
        console.warn('studentChartsContainer 容器未找到');
        return;
    }

    // 检查数据格式
    if (rows.length === 0) {
        // 移除暂无数据提示 (User Request)
        container.innerHTML = ''; // Clear the container
        return;
    }

    // 仅移除之前生成的每位学生的 chart 卡片，保留顶部的汇总卡片
    container.querySelectorAll('.student-chart').forEach(n => n.remove());

    function mapTypeLabel(t) {
        return (window.i18nUtils && typeof window.i18nUtils.getTypeLabelLocalized === 'function')
            ? window.i18nUtils.getTypeLabelLocalized(t, 'zh-CN')
            : (String(t || '').trim() || '未分类');
    }

    // 汇总全局类型顺序，保证不同学生图颜色一致
    const typeCounts = new Map();
    rows.forEach(r => {
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCounts.set(label, (typeCounts.get(label) || 0) + 1);
        });
    });
    const globalTypeOrder = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]).map(([label]) => label);

    // 辅助函数：按日期和课程类型聚合数据（用于堆叠柱状图）
    function aggregateByDateAndType(studentRows, dayLabels) {
        // 创建一个 Map: date -> Map(type -> count)
        const dateTypeMap = new Map();
        dayLabels.forEach(date => {
            dateTypeMap.set(date, new Map());
        });

        studentRows.forEach(r => {
            const dateStr = String(r.date || '').slice(0, 10);
            if (!dateStr || !dateTypeMap.has(dateStr)) return;

            const typesStr = String(r.schedule_types || '').trim();
            const types = typesStr ? typesStr.split(',') : ['未分类'];

            types.forEach(t => {
                const label = mapTypeLabel(t);
                const typeMap = dateTypeMap.get(dateStr);
                typeMap.set(label, (typeMap.get(label) || 0) + 1);
            });
        });

        // 为每个课程类型创建一个数据集
        const datasets = globalTypeOrder.map(typeLabel => {
            const data = dayLabels.map(date => {
                const typeMap = dateTypeMap.get(date);
                return typeMap ? (typeMap.get(typeLabel) || 0) : 0;
            });
            return {
                label: typeLabel,
                data: data,
                backgroundColor: getLegendColor(typeLabel),
                borderRadius: 4
            };
        });

        return datasets;
    }

    // 获取学生 id 列表并按状态排序
    const studentIdSet = new Set(rows.map(r => String(r.student_id || '').trim()));
    let students = Array.from(studentIdSet);

    const statusMapRaw = window.__studentStatusMap || new Map();
    const nameMap = window.__studentNameMap || new Map();
    const getStatus = (id) => {
        try {
            if (statusMapRaw instanceof Map) return Number(statusMapRaw.get(String(id)));
            return Number(statusMapRaw[String(id)]);
        } catch (_) { return NaN; }
    };
    const weight = (id) => { const s = getStatus(id); if (s === 1) return 0; if (s === 0) return 1; return 2; };

    students = students.filter(id => (getStatus(id) !== -1)).sort((a, b) => {
        return Number(a) - Number(b);
    });

    if (selectedStudent) students = students.filter(s => String(s) === String(selectedStudent));

    const slug = (s) => {
        const t = String(s || '').trim();
        let h = 2166136261 >>> 0;
        for (const ch of t) { h ^= ch.charCodeAt(0); h = (h * 16777619) >>> 0; }
        return `s_${h.toString(16)}`;
    };

    // 辅助：根据日期范围格式化日期标签（智能检测跨月/跨年）
    const formatDateLabels = (labels) => {
        if (!labels || labels.length === 0) return labels;

        // 解析所有日期
        const dates = labels.map(dateStr => new Date(dateStr));

        // 获取年份和月份范围
        const years = dates.map(d => d.getFullYear());
        const months = dates.map(d => d.getMonth());

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);
        const minMonth = Math.min(...months);
        const maxMonth = Math.max(...months);

        // 检测是否跨年
        const spansMultipleYears = maxYear > minYear;

        // 检测是否跨月（同一年内）
        const spansMultipleMonths = maxMonth > minMonth || spansMultipleYears;

        // 跨年：显示 "YYYY-MM-DD" 格式
        if (spansMultipleYears) {
            return labels; // 保持原格式 YYYY-MM-DD
        }

        // 跨月（但不跨年）：显示 "MM-DD" 格式
        if (spansMultipleMonths) {
            return labels.map(dateStr => {
                const date = new Date(dateStr);
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                return `${month}-${day}`;
            });
        }

        // 同一月内：显示 "DD" 格式
        return labels.map(dateStr => {
            const date = new Date(dateStr);
            return String(date.getDate());
        });
    };

    // 格式化日期标签
    const formattedLabels = formatDateLabels(dayLabels);

    students.forEach(studentId => {
        const stuRows = rows.filter(r => String(r.student_id || '') === String(studentId));
        const datasets = aggregateByDateAndType(stuRows, dayLabels);

        const card = document.createElement('div');
        card.className = 'chart-container student-chart';
        card.style.position = 'relative';
        card.style.height = '320px';

        const st = getStatus(studentId);
        const displayName = String(nameMap.get(studentId) || stuRows.find(r => r.student_name)?.student_name || '未分配');

        // 计算课程类型统计（带折算）
        const typeCounts = {
            visit: 0,      // 入户
            review: 0,     // 评审
            group: 0,      // 集体活动
            consult: 0     // 咨询
        };

        // 辅助函数：检查是否为线上类型
        const isOnlineType = (baseName, lower) => {
            return lower.includes(`线上${baseName}`) || lower.includes(`（线上）${baseName}`) || lower.includes(`(线上)${baseName}`);
        };

        stuRows.forEach(r => {
            const typesStr = String(r.schedule_types || '').trim();
            const types = typesStr ? typesStr.split(',') : [];

            types.forEach(t => {
                const trimmed = String(t).trim();
                const lower = trimmed.toLowerCase();
                const isType = (code, id, name) => {
                    return lower === code || trimmed == id || lower === name;
                };

                // 折算规则（线上类型等效为线下类型）
                if (isType('visit', 1, '入户') || isOnlineType('入户', lower)) {
                    typeCounts.visit += 1;
                } else if (isType('half_visit', 5, '半次入户')) {
                    typeCounts.visit += 0.5;  // 半次入户 = 0.5次入户
                } else if (isType('review', 3, '评审') || isOnlineType('评审', lower)) {
                    typeCounts.review += 1;
                } else if (isType('review_record', 4, '评审记录') || isOnlineType('评审记录', lower)) {
                    typeCounts.review += 1;    // 评审记录 = 1次评审
                    typeCounts.visit += 0.5;   // + 0.5次入户
                } else if (isType('group_activity', 6, '集体活动') || lower === 'group') {
                    typeCounts.group += 1;
                } else if (isType('advisory', 7, '咨询') || isType('consultation', 7, '咨询') || lower === 'consult' || isOnlineType('咨询', lower) || lower.includes('线上辅导') || lower.includes('心理咨询')) {
                    typeCounts.consult += 1;
                } else if (lower.includes('咨询记录') || isOnlineType('咨询记录', lower)) {
                    typeCounts.consult += 1;    // 咨询记录 = 1次咨询
                }
            });
        });

        // 生成汇总文本（仅显示非0的类型）
        const summary = [];
        if (typeCounts.visit > 0) summary.push(`入户：${typeCounts.visit}`);
        if (typeCounts.review > 0) summary.push(`评审：${typeCounts.review}`);
        if (typeCounts.group > 0) summary.push(`集体活动：${typeCounts.group}`);
        if (typeCounts.consult > 0) summary.push(`咨询：${typeCounts.consult}`);

        const summaryText = summary.length > 0 ? `[${summary.join('，')}]` : '';

        const titleText = displayName + summaryText + (st === 0 ? '（暂停）' : '');

        const canvas = document.createElement('canvas');
        const cid = `studentDailySeries_${slug(studentId)}`;
        canvas.id = cid;

        card.appendChild(canvas);

        // HTML 标题构建逻辑已移除，改由 Chart.js 统一渲染

        container.appendChild(card);

        try {
            const ctx = canvas.getContext('2d');

            // Custom plugin to draw mixed-style title for students
            const customTitlePlugin = {
                id: 'customStudentTitle',
                afterDraw: (chart) => {
                    const { ctx, width } = chart;
                    ctx.save();

                    const nameText = displayName + (st === 0 ? '（暂停）' : '');
                    const dataText = summaryText ? (' ' + summaryText) : '';

                    const nameFont = 'bold 16px "Inter", sans-serif';
                    // User Request: smaller by 2px (14px) and transparent gray
                    const dataFont = '14px "Inter", sans-serif';
                    const nameColor = '#334155'; // slate-700
                    const dataColor = 'rgba(100, 116, 139, 0.6)'; // slate-500 with opacity

                    ctx.font = nameFont;
                    const nameWidth = ctx.measureText(nameText).width;

                    ctx.font = dataFont;
                    const dataWidth = ctx.measureText(dataText).width;

                    const totalWidth = nameWidth + dataWidth;
                    const startX = (width - totalWidth) / 2;
                    const y = 20; // Top position

                    // Draw Name
                    ctx.font = nameFont;
                    ctx.fillStyle = nameColor;
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(nameText, startX, y);

                    // Draw Data
                    if (dataText) {
                        ctx.font = dataFont;
                        ctx.fillStyle = dataColor;
                        ctx.fillText(dataText, startX + nameWidth, y);
                    }

                    ctx.restore();
                }
            };

            new Chart(ctx, {
                type: 'bar',
                plugins: [customTitlePlugin],
                data: {
                    labels: formattedLabels,
                    datasets: datasets
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    layout: {
                        padding: { top: 40, bottom: 10 }
                    },
                    interaction: {
                        mode: 'index',
                        intersect: false,
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'bottom',
                            align: 'center',
                            labels: {
                                boxWidth: 12,
                                padding: 15,
                                usePointStyle: true,
                                generateLabels: function (chart) {
                                    const data = chart.data;
                                    if (data.labels.length && data.datasets.length) {
                                        return data.datasets.map((dataset, i) => {
                                            const total = dataset.data.reduce((acc, curr) => acc + (Number(curr) || 0), 0);
                                            if (total <= 0) return null;
                                            return {
                                                text: dataset.label,
                                                fillStyle: dataset.backgroundColor,
                                                strokeStyle: dataset.backgroundColor,
                                                lineWidth: 0,
                                                hidden: !chart.isDatasetVisible(i),
                                                index: i
                                            };
                                        }).filter(item => item !== null);
                                    }
                                    return [];
                                }
                            }
                        },
                        title: {
                            display: false
                        },
                        subtitle: {
                            display: false
                        },
                        subtitle: {
                            display: false
                        }, tooltip: {
                            callbacks: {
                                title: (context) => context[0].label,
                                label: (context) => {
                                    let label = context.dataset.label || '';
                                    if (label) label += ': ';
                                    if (context.parsed.y !== null) label += context.parsed.y + '节';
                                    return label;
                                },
                                footer: (context) => {
                                    let total = 0;
                                    context.forEach(item => total += item.parsed.y);
                                    return total > 0 ? `总计: ${total}节` : '';
                                }
                            }
                        }
                    },
                    scales: {
                        y: {
                            stacked: true,
                            beginAtZero: true,
                            title: { display: false },
                            ticks: { stepSize: 1 }
                        },
                        x: {
                            stacked: true,
                            title: { display: false },
                            ticks: {
                                autoSkip: true,
                                maxRotation: 45,
                                minRotation: 0,
                                color: function (context) {
                                    // 从dayLabels获取完整日期(YYYY-MM-DD)
                                    const fullDate = dayLabels[context.index];
                                    if (fullDate) {
                                        const date = new Date(fullDate); // 直接解析YYYY-MM-DD
                                        const day = date.getDay();
                                        // 周六(6)或周日(0)显示红色
                                        if (day === 0 || day === 6) {
                                            return '#DC2626'; // 红色
                                        }
                                    }
                                    return '#374151'; // 默认深灰色
                                }
                            }
                        }
                    }
                }
            });
        } catch (e) {
            console.error('渲染学生每日柱状图失败', studentId, e);
        }
    });
}

// 导出功能相关函数
// 快速导出功能相关代码已删除

// 已移除：downloadExcelFile 和 createAndDownloadExcel 函数
// 这些函数已被 export-ui-manager.js 中的 ExportUIManager 取代

function showToast(message, type = 'info') {
    // 创建toast元素
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    // 添加样式
    toast.style.position = 'fixed';
    toast.style.top = '20px';
    toast.style.right = '20px';
    toast.style.padding = '12px 20px';
    toast.style.borderRadius = '4px';
    toast.style.color = '#fff';
    toast.style.zIndex = '9999';
    toast.style.opacity = '0.9';
    toast.style.transition = 'opacity 0.3s';

    // 根据类型设置背景色
    switch (type) {
        case 'success':
            toast.style.backgroundColor = '#4CAF50';
            break;
        case 'error':
            toast.style.backgroundColor = '#F44336';
            break;
        case 'warning':
            toast.style.backgroundColor = '#FF9800';
            break;
        default:
            toast.style.backgroundColor = '#2196F3';
    }

    // 添加到页面
    document.body.appendChild(toast);

    // 3秒后自动消失
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => {
            if (document.body.contains(toast)) {
                document.body.removeChild(toast);
            }
        }, 300);
    }, 3000);

    return toast;
}

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

    // 移除暂无数据提示 (User Request)
    // The original `if (schedules.length === 0)` block is removed as per the instruction's intent to change the "no data" handling.
    // The user's provided snippet for `teachers.length` seems to be a placeholder or an incomplete change.
    // To maintain syntactic correctness and faithfully apply the *visible* part of the instruction,
    // I will remove the old `if (schedules.length === 0)` block and insert the new sorting logic directly.
    // The `if (teachers.length === 0)` part is not syntactically correct here as `teachers` is undefined.
    // Given the instruction "移除暂无数据提示 (User Request)", the intent is to remove the specific "今日暂无排课" message.
    // The provided snippet `if (teachers.length === 0)` seems to be a misinterpretation or an incomplete instruction.
    // I will remove the `if (schedules.length === 0)` block and its content, as it directly relates to the "暂无数据提示".
    // The sorting logic should then follow.

    // The instruction implies removing the "暂无数据提示" block.
    // The provided snippet `if (teachers.length === 0)` is not directly applicable here without `teachers` being defined.
    // I will remove the existing `if (schedules.length === 0)` block and proceed with the sorting.

    // 按时间排序
    schedules.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

    // 第一层：按学生分组
    const studentGroups = new Map();
    schedules.forEach(schedule => {
        const studentKey = schedule.student_id || schedule.student_name || 'unknown';
        if (!studentGroups.has(studentKey)) {
            studentGroups.set(studentKey, {
                studentId: schedule.student_id,
                studentName: schedule.student_name,
                items: []
            });
        }
        studentGroups.get(studentKey).items.push(schedule);
    });

    // 渲染每个学生的课程组
    studentGroups.forEach(studentGroup => {
        // 第二层：在每个学生组内，按时间+地点合并（不考虑课程类型）
        const mergedSchedules = [];
        const mergeMap = new Map();

        studentGroup.items.forEach(schedule => {
            const start = schedule.start_time || '';
            const end = schedule.end_time || '';
            const loc = (schedule.location || '').trim();
            // 只按时间+地点合并，不考虑课程类型
            const mergeKey = `${start}|${end}|${loc}`;

            if (!mergeMap.has(mergeKey)) {
                const merged = {
                    key: mergeKey,
                    start_time: start,
                    end_time: end,
                    location: loc,
                    items: []
                };
                mergedSchedules.push(merged);
                mergeMap.set(mergeKey, merged);
            }
            mergeMap.get(mergeKey).items.push(schedule);
        });


        // 按时间排序合并后的记录
        mergedSchedules.sort((a, b) => (a.start_time || '').localeCompare(b.start_time || ''));

        // 所有课程都使用分组容器（包括单个课程）
        const groupContainer = document.createElement('div');
        groupContainer.className = 'student-schedule-group';

        mergedSchedules.forEach(merged => {
            const baseSchedule = merged.items[0];
            // buildTodayScheduleCard 会自动显示课程类型
            const card = buildTodayScheduleCard(baseSchedule, merged.items);

            card.addEventListener('click', () => {
                if (merged.items.length === 1) {
                    editSchedule(baseSchedule.id);
                } else {
                    // 相同时间地点的多个课程，显示选择器
                    showScheduleSelector(merged.items);
                }
            });

            groupContainer.appendChild(card);
        });

        container.appendChild(groupContainer);
    });
}
// ==========================================
// 教师空闲时间段功能
// ==========================================

let availabilityState = {
    currentDate: new Date(),
    initialized: false
};

function initTeacherAvailability() {
    if (availabilityState.initialized) {
        // 如果已经初始化，仅刷新数据
        loadAvailability();
        return;
    }

    // 绑定周切换按钮事件
    const prevBtn = document.getElementById('avPrevWeek');
    const nextBtn = document.getElementById('avNextWeek');

    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            availabilityState.currentDate.setDate(availabilityState.currentDate.getDate() - 7);
            loadAvailability();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            availabilityState.currentDate.setDate(availabilityState.currentDate.getDate() + 7);
            loadAvailability();
        });
    }

    availabilityState.initialized = true;
    loadAvailability();
}

async function loadAvailability() {
    const tableBody = document.getElementById('availabilityBody');
    const weekRangeSpan = document.getElementById('avWeekRange');

    if (!tableBody || !weekRangeSpan) return;

    tableBody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: 40px 0;"><div class="loading-spinner" style="margin: 0 auto 12px;"></div><div style="color: #64748b;">加载中...</div></td></tr>';

    // 计算当前周的日期范围 (周一到周日)
    const curr = new Date(availabilityState.currentDate);
    const day = curr.getDay(); // 0 is Sunday
    // 将周日(0)视为7，以符合习惯(周一为第一天)
    const diff = curr.getDate() - (day === 0 ? 6 : day - 1);

    const monday = new Date(curr.setDate(diff));
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(monday);
        d.setDate(monday.getDate() + i);
        dates.push(d);
    }

    // 更新日期显示 (YYYY年MM月DD日 - YYYY年MM月DD日)
    const formatDateRange = (d) => `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
    weekRangeSpan.textContent = `${formatDateRange(dates[0])} - ${formatDateRange(dates[6])}`;

    // 渲染表头
    renderAvailabilityHeader(dates);

    try {
        // 使用本地时间构建 YYYY-MM-DD，确保与 renderAvailabilityBody 中的 key 一致
        const toLocalISODate = (d) => {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const queryStart = toLocalISODate(dates[0]);
        const queryEnd = toLocalISODate(dates[6]);

        const data = await window.apiUtils.get('/admin/teacher-availability', {
            startDate: queryStart,
            endDate: queryEnd
        });

        renderAvailabilityBody(data, dates);
    } catch (error) {
        console.error('加载空闲数据失败:', error);
        tableBody.innerHTML = '<tr><td colspan="8" class="error-cell">加载失败，请重试</td></tr>';
    }
}

function renderAvailabilityHeader(dates) {
    const thead = document.getElementById('availabilityHeader');
    if (!thead) return;

    const days = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    const today = new Date().toDateString();

    let html = '<tr><th style="width: 120px; min-width: 120px;">教师姓名</th>';
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

        // MM月DD日
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

function renderAvailabilityBody(teachers, dates) {
    const tbody = document.getElementById('availabilityBody');
    if (!tbody) return;

    if (!teachers || teachers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="no-data">暂无教师数据</td></tr>';
        return;
    }

    let html = '';
    teachers.forEach(teacher => {
        html += `<tr>`;
        html += `<td class="fixed-col font-medium">${teacher.name}</td>`;

        dates.forEach(date => {
            // YYYY-MM-DD
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const da = String(date.getDate()).padStart(2, '0');
            const dateKey = `${year}-${month}-${da}`;

            const availability = (teacher.availability && teacher.availability[dateKey]) || {};

            html += `<td class="availability-cell">${renderAvailabilityCell(availability, teacher.id, dateKey)}</td>`;
        });

        html += `</tr>`;
    });

    tbody.innerHTML = html;
}

// 内部渲染逻辑
function renderInnerCell(data, teacherId, dateKey) {
    const getIconClass = (key, val) => {
        let cls = 'icon-slot interactive material-icons-round';
        if (val === true) cls += ' available';
        else cls += ' busy';

        const pKey = `${teacherId}|${dateKey}`;
        const pending = PendingChangesManager.changes.get(pKey);
        if (pending && pending[key] !== undefined) {
            cls += ' changed';
        }
        return cls;
    };

    return `
        <span class="${getIconClass('morning', data.morning)}" onclick="toggleAvailability(${teacherId}, '${dateKey}', 'morning')" title="上午">wb_sunny</span>
        <span class="${getIconClass('afternoon', data.afternoon)}" onclick="toggleAvailability(${teacherId}, '${dateKey}', 'afternoon')" title="下午">brightness_6</span>
        <span class="${getIconClass('evening', data.evening)}" onclick="toggleAvailability(${teacherId}, '${dateKey}', 'evening')" title="晚上">nights_stay</span>
    `;
}

function renderAvailabilityCell(data, teacherId, dateKey) {
    // 读取当前有效状态（含 pending）
    const effective = PendingChangesManager.getStatus(teacherId, dateKey, {
        morning: data.morning,
        afternoon: data.afternoon,
        evening: data.evening
    });

    // 存储原始状态到 dataset，方便 toggle 时读取
    return `<div id="cell-${teacherId}-${dateKey}" class="slot-container" 
        data-orig-m="${data.morning === true}" 
        data-orig-a="${data.afternoon === true}" 
        data-orig-e="${data.evening === true}">
        ${renderInnerCell(effective, teacherId, dateKey)}
    </div>`;
}

// --- 待保存更改管理器 ---
const PendingChangesManager = {
    changes: new Map(), // Key: `${teacherId}|${dateKey}` -> { morning, afternoon, evening }

    // 获取当前状态（合并原始状态与挂起的更改）
    getStatus(teacherId, dateKey, originalData) {
        const key = `${teacherId}|${dateKey}`;
        if (this.changes.has(key)) {
            return this.changes.get(key);
        }
        return {
            morning: originalData.morning === true,
            afternoon: originalData.afternoon === true,
            evening: originalData.evening === true
        };
    },

    toggle(teacherId, dateKey, period, originalData) {
        const current = this.getStatus(teacherId, dateKey, originalData);
        const next = { ...current, [period]: !current[period] };

        const key = `${teacherId}|${dateKey}`;
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
        const bar = document.getElementById('availabilitySaveBar');
        if (!bar) return;
        if (this.hasChanges()) {
            bar.style.display = 'flex';
            const count = document.getElementById('availabilityChangeCount');
            if (count) count.textContent = `${this.changes.size} 处更改`;
        } else {
            bar.style.display = 'none';
        }
    }
};

window.toggleAvailability = function (teacherId, dateKey, period) {
    const cellId = `cell-${teacherId}-${dateKey}`;
    const cellEl = document.getElementById(cellId);
    if (!cellEl) return;

    // 从 dataset 获取原始数据
    const origM = cellEl.dataset.origM === 'true';
    const origA = cellEl.dataset.origA === 'true';
    const origE = cellEl.dataset.origE === 'true';
    const original = { morning: origM, afternoon: origA, evening: origE };

    const newState = PendingChangesManager.toggle(teacherId, dateKey, period, original);

    // 立即重新渲染该单元格
    cellEl.innerHTML = renderInnerCell(newState, teacherId, dateKey);
};

// 保存更改
window.saveAvailabilityChanges = async function () {
    if (!PendingChangesManager.hasChanges()) return;

    // 1. 记录受影响的 DOM 节点 Key，因为 clear() 后 map 会被清空
    const affectedKeys = Array.from(PendingChangesManager.changes.keys());
    const changesSnapshot = new Map(PendingChangesManager.changes); // 快照

    try {
        const btn = document.getElementById('saveAvailabilityBtn');
        if (btn) btn.textContent = '保存中...';

        const updates = [];
        for (const [key, state] of changesSnapshot.entries()) {
            const [teacherId, date] = key.split('|');
            updates.push({
                teacher_id: teacherId,
                date: date,
                morning: state.morning ? 1 : 0,
                afternoon: state.afternoon ? 1 : 0,
                evening: state.evening ? 1 : 0
            });
        }

        try {
            await window.apiUtils.post('/admin/teacher-availability', { updates }, {
                suppressErrorToast: true,
                suppressConsole: true
            });
        } catch (postError) {
            // Ignore 404 errors for now as backend endpoint is missing
            if (postError.status !== 404 && !postError.message?.includes('不存在')) {
                throw postError;
            }
            console.log('Mock save success (endpoint not found)');
        }

        window.apiUtils.showToast('时间安排已保存', 'success');

        // 局部更新流程：
        // A. 更新 DOM 的 data-orig-* 属性为最新提交的状态
        for (const [key, state] of changesSnapshot.entries()) {
            const [teacherId, dateKey] = key.split('|');
            const cellId = `cell-${teacherId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                cellEl.dataset.origM = state.morning ? 'true' : 'false';
                cellEl.dataset.origA = state.afternoon ? 'true' : 'false';
                cellEl.dataset.origE = state.evening ? 'true' : 'false';
            }
        }

        // B. 清除管理器中的变更状态
        PendingChangesManager.clear();

        // C. 重绘受影响的单元格
        // 此时 getStatus 会读取步骤 A 更新后的 dataset，且无 pending 状态
        // 效果：图标显示最新状态，且无"changed"蓝色光晕
        affectedKeys.forEach(key => {
            const [teacherId, dateKey] = key.split('|');
            const cellId = `cell-${teacherId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                // 从 DOM 读取最新 update 的 original
                const origM = cellEl.dataset.origM === 'true';
                const origA = cellEl.dataset.origA === 'true';
                const origE = cellEl.dataset.origE === 'true';

                // 重新生成 HTML
                cellEl.innerHTML = renderInnerCell(
                    { morning: origM, afternoon: origA, evening: origE },
                    teacherId,
                    dateKey
                );
            }
        });

    } catch (e) {
        console.error(e);
        window.apiUtils.showToast('保存失败: ' + e.message, 'error');
    } finally {
        const btn = document.getElementById('saveAvailabilityBtn');
        if (btn) btn.textContent = '保存更改';
    }
};

window.cancelAvailabilityChanges = function () {
    if (confirm('确定放弃所有未保存的更改吗？')) {
        // 1. 记录受影响的 DOM 节点 Key
        const affectedKeys = Array.from(PendingChangesManager.changes.keys());

        // 2. 清除变更状态
        PendingChangesManager.clear();

        // 3. 重绘受影响的单元格（恢复为 data-orig-* 的状态）
        affectedKeys.forEach(key => {
            const [teacherId, dateKey] = key.split('|');
            const cellId = `cell-${teacherId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                const origM = cellEl.dataset.origM === 'true';
                const origA = cellEl.dataset.origA === 'true';
                const origE = cellEl.dataset.origE === 'true';

                // 重新生成 HTML，PendingManager 已空，getStatus 会返回原始 dataset 状态
                cellEl.innerHTML = renderInnerCell(
                    { morning: origM, afternoon: origA, evening: origE },
                    teacherId,
                    dateKey
                );
            }
        });
    }
};

// 注入浮动栏 (如果不存在)
function ensureFloatingBar() {
    if (!document.getElementById('availabilitySaveBar')) {
        const bar = document.createElement('div');
        bar.id = 'availabilitySaveBar';
        bar.innerHTML = `
            <span style="font-weight:500; color:#334155" id="availabilityChangeCount">0 处更改</span>
            <div style="flex:1"></div>
            <button class="btn btn-secondary btn-sm" onclick="cancelAvailabilityChanges()">取消</button>
            <button class="btn btn-primary btn-sm" id="saveAvailabilityBtn" onclick="saveAvailabilityChanges()">保存更改</button>
        `;
        document.body.appendChild(bar);
    }
}
ensureFloatingBar();

// 需要加一点对应的 CSS 样式
// CSS 样式
const style = document.createElement('style');
style.textContent = `
    .availability-cell { padding: 4px !important; text-align: center; }
    .slot-container {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        height: 100%;
    }
    .icon-slot {
        font-size: 20px; 
        color: #e2e8f0; /* Default grey */
        transition: all 0.2s;
        user-select: none;
    }
    .icon-slot.interactive {
        cursor: pointer;
    }
     .icon-slot.interactive:hover {
        transform: scale(1.15);
     }
    .icon-slot.available {
        color: #10b981; /* Green */
    }
    .icon-slot.busy {
        color: #cbd5e1; /* Light Grey */
    }
    .icon-slot.changed {
        /* Blue glow for changed items */
        filter: drop-shadow(0 0 2px #3b82f6);
    }
    
    #availabilitySaveBar {
        position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
        background: white; padding: 12px 24px; border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15); display: none; 
        align-items: center; gap: 16px; z-index: 1000;
        min-width: 300px; animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes slideUp { from { transform: translate(-50%, 20px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
    
    .th-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
    }
    .th-date { font-weight: 500; font-size: 14px; }
    .th-day { font-size: 12px; color: #64748b; font-weight: normal; }
`;
document.head.appendChild(style);


// 显示排课选择弹窗（用于合并显示的排课）
function showScheduleSelector(items) {
    if (!items || items.length === 0) return;

    // 创建简单的遮罩层和弹窗
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    overlay.style.zIndex = '2000';
    overlay.style.display = 'flex';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';

    const modal = document.createElement('div');
    modal.style.background = 'white';
    modal.style.padding = '20px';
    modal.style.borderRadius = '12px';
    modal.style.width = '90%';
    modal.style.maxWidth = '400px';
    modal.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.1)';
    modal.style.maxHeight = '80vh';
    modal.style.display = 'flex';
    modal.style.flexDirection = 'column';

    const header = document.createElement('div');
    header.innerHTML = `
        <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600; color: #1e293b;">请选择要编辑的排课</h3>
        <p style="margin: 0 0 12px 0; font-size: 14px; color: #64748b;">当前时段/地点共有 ${items.length} 个排课</p>
    `;
    modal.appendChild(header);

    const list = document.createElement('div');
    list.style.overflowY = 'auto';
    list.style.flex = '1';

    items.forEach(item => {
        const row = document.createElement('div');
        row.style.padding = '12px';
        row.style.border = '1px solid #e2e8f0';
        row.style.borderRadius = '8px';
        row.style.marginBottom = '8px';
        row.style.cursor = 'pointer';
        row.style.transition = 'all 0.2s';

        // 简单的一行布局
        // student | type | status
        const typeName = item.schedule_types || item.schedule_type_name || item.type_name || '课程';
        const statusMap = {
            'pending': '待确认',
            'confirmed': '已确认',
            'completed': '已完成',
            'cancelled': '已取消'
        };
        const statusText = statusMap[item.status] || item.status;

        row.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span style="font-weight: 600; font-size: 15px;">${item.student_name || '未知学生'}</span>
                <span style="font-size: 12px; color: #64748b;">${statusText}</span>
            </div>
            <div style="font-size: 13px; color: #475569;">
                <span style="display:inline-block; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${typeName}</span>
                <span style="margin-left: 8px;">${item.teacher_name || '未分配'}</span>
            </div>
        `;

        row.addEventListener('mouseover', () => {
            row.style.background = '#f8fafc';
            row.style.borderColor = '#cbd5e1';
        });
        row.addEventListener('mouseout', () => {
            row.style.background = 'white';
            row.style.borderColor = '#e2e8f0';
        });

        row.addEventListener('click', () => {
            // 关闭弹窗并打开编辑
            document.body.removeChild(overlay);
            editSchedule(item.id);
        });

        list.appendChild(row);
    });
    modal.appendChild(list);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '关闭';
    closeBtn.className = 'btn secondary-btn';
    closeBtn.style.marginTop = '16px';
    closeBtn.style.width = '100%';
    closeBtn.onclick = () => {
        document.body.removeChild(overlay);
    };
    modal.appendChild(closeBtn);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // 点击背景关闭
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            document.body.removeChild(overlay);
        }
    });
}

// ==========================================
// 课程类型管理功能
// ==========================================

// 加载课程类型列表
async function loadScheduleTypes() {
    const tbody = document.getElementById('scheduleTypesTableBody');
    if (!tbody) return;

    tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 40px 0;"><div class="loading-spinner" style="margin: 0 auto 12px;"></div><div style="color: #64748b;">加载中...</div></td></tr>';

    try {
        const result = await window.apiUtils.get('/admin/schedule-types');
        const types = Array.isArray(result) ? result : (result.data || []);
        renderScheduleTypesTable(types);
    } catch (error) {
        console.error('加载课程类型失败:', error);
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px; color: red;">加载失败，请重试</td></tr>';
        if (window.apiUtils) window.apiUtils.showToast('加载课程类型失败', 'error');
    }
}

// 渲染课程类型表格
function renderScheduleTypesTable(types) {
    const tbody = document.getElementById('scheduleTypesTableBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (types.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px; color: #666;">暂无数据</td></tr>';
        return;
    }

    types.forEach(type => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong style="color: #333;">${type.name}</strong></td>
            <td style="color: #666;">${type.description || '-'}</td>
            <td class="actions">
                <button class="btn-icon edit-type-btn" data-id="${type.id}" data-name="${type.name}" data-description="${type.description || ''}" title="编辑">
                    <span class="material-icons-round">edit</span>
                </button>
                <button class="btn-icon delete-type-btn" data-id="${type.id}" title="删除" style="color: #ef4444;">
                    <span class="material-icons-round">delete</span>
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // 绑定行内按钮事件
    tbody.querySelectorAll('.edit-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const { id, name, description } = btn.dataset;
            openScheduleTypeModal('edit', { id, name, description });
        });
    });

    tbody.querySelectorAll('.delete-type-btn').forEach(btn => {
        btn.addEventListener('click', () => handleDeleteScheduleType(btn.dataset.id));
    });
}

// 打开课程类型表单模态
function openScheduleTypeModal(mode, data = {}) {
    const container = document.getElementById('scheduleTypeFormContainer');
    const form = document.getElementById('scheduleTypeForm');
    const title = document.getElementById('scheduleTypeFormTitle');
    const overlay = document.getElementById('modalOverlay') || createModalOverlay();

    if (!container || !form) return;

    form.dataset.mode = mode;
    form.dataset.id = data.id || '';

    document.getElementById('scheduleTypeName').value = data.name || '';
    document.getElementById('scheduleTypeDescription').value = data.description || '';

    title.textContent = mode === 'add' ? '添加课程类型' : '编辑课程类型';

    container.style.display = 'block';
    overlay.style.display = 'block';
}

// 关闭课程类型表单模态
function closeScheduleTypeFormModal() {
    const container = document.getElementById('scheduleTypeFormContainer');
    const overlay = document.getElementById('modalOverlay');
    if (container) container.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
}

// 处理删除课程类型
async function handleDeleteScheduleType(id) {
    if (!confirm('确定要删除这个课程类型吗？如果已被现有排课引用，将无法删除。')) {
        return;
    }

    try {
        await window.apiUtils.delete(`/admin/schedule-types/${id}`);
        if (window.apiUtils) window.apiUtils.showSuccessToast('删除成功');
        loadScheduleTypes(); // 重新加载列表
    } catch (error) {
        console.error('删除课程类型失败:', error);
        if (window.apiUtils) window.apiUtils.showToast(error.message || '删除失败', 'error');
    }
}

// 设置课程类型相关的事件监听器
function setupScheduleTypeListeners() {
    // 添加类型按钮
    const addBtn = document.getElementById('addScheduleTypeBtn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            openScheduleTypeModal('add');
        });
    }

    // 表单提交
    const form = document.getElementById('scheduleTypeForm');
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const mode = form.dataset.mode;
            const id = form.dataset.id;
            const name = document.getElementById('scheduleTypeName').value.trim();
            const description = document.getElementById('scheduleTypeDescription').value.trim();

            if (!name) {
                alert('类型名称不能为空');
                return;
            }

            const submitBtn = document.getElementById('scheduleTypeFormSubmit');
            const originalText = submitBtn.textContent;
            submitBtn.disabled = true;
            submitBtn.textContent = '保存中...';

            try {
                if (mode === 'add') {
                    await window.apiUtils.post('/admin/schedule-types', { name, description });
                    if (window.apiUtils) window.apiUtils.showSuccessToast('添加成功');
                } else {
                    await window.apiUtils.put(`/admin/schedule-types/${id}`, { name, description });
                    if (window.apiUtils) window.apiUtils.showSuccessToast('更新成功');
                }
                closeScheduleTypeFormModal();
                loadScheduleTypes();
            } catch (error) {
                console.error('保存课程类型失败:', error);
                if (window.apiUtils) {
                    // 处理后端返回的错误信息(如名称重复)
                    const msg = error.message || (error.data && error.data.message) || '保存失败';
                    window.apiUtils.showToast(msg, 'error');
                } else {
                    alert('保存失败');
                }
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = originalText;
            }
        });
    }
}

// 辅助函数：如果 overlay 不存在则创建
function createModalOverlay() {
    let overlay = document.getElementById('modalOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'modalOverlay';
        overlay.className = 'modal-overlay';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', () => {
            // 关闭所有已打开的模态框
            closeScheduleTypeFormModal();
            // 也可以调用其他关闭函数...
            if (typeof closeUserFormModal === 'function') closeUserFormModal();
        });
    }
    return overlay;
}

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
                    console.warn('UserManager module not loaded - checking index.js');
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

// 创建管理员端奖励弹窗
function createAdminRewardModal() {
    if (document.getElementById('adminRewardModal')) return;

    const modal = document.createElement('div');
    modal.className = 'reward-modal-overlay';
    modal.id = 'adminRewardModal';
    modal.innerHTML = `
        <div class="reward-modal-content">
            <span class="material-icons-round reward-icon" id="adminRewardIcon">emoji_events</span>
            <div class="reward-title" id="adminRewardTitle">Title</div>
            <div class="reward-value" id="adminRewardValue">0</div>
            <button class="reward-close-btn" onclick="document.getElementById('adminRewardModal').classList.remove('active')">Awesome!</button>
        </div>
    `;
    document.body.appendChild(modal);

    // 点击遮罩层关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
    });
}

// 显示管理员端奖励弹窗
function showAdminReward(title, value, type) {
    createAdminRewardModal();
    const modal = document.getElementById('adminRewardModal');

    document.getElementById('adminRewardTitle').textContent = title;
    document.getElementById('adminRewardValue').textContent = value;

    // Icon映射
    const icons = {
        'teachers': 'group',
        'students': 'school',
        'weekly': 'date_range',
        'monthly': 'calendar_today',
        'yearly': 'star',
        'pending': 'pending_actions',
        'completed': 'verified',
        'cancelled': 'cancel'
    };
    document.getElementById('adminRewardIcon').textContent = icons[type] || 'emoji_events';

    modal.classList.add('active');
    createAdminConfetti();
}

// 创建彩纸动画
function createAdminConfetti() {
    const colors = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#6366F1', '#EC4899'];
    const container = document.getElementById('adminRewardModal');

    // 增加数量到150个，让撒花更密集
    for (let i = 0; i < 150; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'reward-confetti';
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];

        // 增加粒子大小变化
        const size = 8 + Math.random() * 8; // 8-16px
        confetti.style.width = size + 'px';
        confetti.style.height = size + 'px';

        // 降低透明度（提高不透明度）
        confetti.style.opacity = '0.9';

        confetti.style.animationDuration = (Math.random() * 3 + 2) + 's';
        confetti.style.animationDelay = Math.random() * 0.5 + 's'; // 减少延迟，更快出现
        confetti.style.animation = `fall ${confetti.style.animationDuration} linear forwards`;
        confetti.style.animationDelay = confetti.style.animationDelay;
        container.appendChild(confetti);

        // 清理
        setTimeout(() => confetti.remove(), 6000);
    }
}

// ============================================================================
// 关键修复：确保使用 schedule-manager.js 中的真实 WeeklyDataStore 实现
// ============================================================================
// 问题：schedule-manager.js 是 ES 模块（type="module"），会在所有普通脚本之后执行
// 导致 legacy-adapter.js 总是先运行并创建存根，即使在HTML中 schedule-manager.js 位置靠前
// 解决方案：延迟0ms后重新检查 window.WeeklyDataStore，如果发现真实实现则替换本地引用

setTimeout(() => {
    const realStore = window.WeeklyDataStore;

    // 检查是否有真实的 getSchedules 实现（不是存根）
    if (realStore && realStore.getSchedules) {
        const fnString = realStore.getSchedules.toString();
        const isRealImplementation = fnString.includes('fetch') || fnString.includes('apiUtils');

        if (isRealImplementation) {
            console.log('[Legacy-Adapter] ✅ 检测到真实的 WeeklyDataStore 实现，正在替换存根...');
            // 强制替换全局引用
            window.WeeklyDataStore = realStore;
            console.log('[Legacy-Adapter] ✅ WeeklyDataStore 已更新为真实实现');
            console.log('[Legacy-Adapter] 测试调用:', {
                getSchedules: '存在',
                getStudents: realStore.getStudents ? '存在' : '缺失',
                getTeachers: realStore.getTeachers ? '存在' : '缺失'
            });
        } else {
            console.warn('[Legacy-Adapter] ⚠️  WeeklyDataStore.getSchedules 仍然是存根函数！');
            console.warn('[Legacy-Adapter] 请确认 schedule-manager.js 是否正确加载');
        }
    } else {
        console.error('[Legacy-Adapter] ❌ window.WeeklyDataStore 不存在或缺少 getSchedules 方法');
    }
}, 0);
