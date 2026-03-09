/**
 * 数据导出对话框模块
 * 提供灵活的导出配置界面，支持多种导出类型和文件格式
 * 
 * 导出类型：
 * 1. 老师信息数据 - 基本信息+统计数据
 * 2. 学生信息数据 - 基本信息+统计数据
 * 3. 指定时间段的老师授课记录 - 详细排课信息
 * 4. 指定时间段的学生排课记录 - 详细排课信息
 * 
 * 导出格式：Excel, CSV
 */

window.ExportDialog = (function () {
    // ============ 内部助手函数 ============
    /**
     * 获取当前用户信息（兼容 window.currentUser 和 localStorage）
     */
    function getCurrentUser() {
        if (window.currentUser && window.currentUser.userType) return window.currentUser;
        
        try {
            const userType = localStorage.getItem('userType');
            if (userType) return { userType };
            
            const userData = localStorage.getItem('userData');
            if (userData) {
                const user = JSON.parse(userData);
                if (user && typeof user === 'object') {
                    user.userType = user.userType || 'admin';
                    return user;
                }
            }
        } catch (e) { }
        
        return { userType: 'admin' };
    }

    // ============ 常量定义 ============
    const EXPORT_TYPES = {
        TEACHER_INFO: 'teacher_info',           // 老师信息数据
        STUDENT_INFO: 'student_info',           // 学生信息数据
        TEACHER_SCHEDULE: 'teacher_schedule',   // 老师授课记录
        STUDENT_SCHEDULE: 'student_schedule'    // 学生排课记录
    };

    const EXPORT_FORMATS = {
        EXCEL: 'excel',
        CSV: 'csv'
    };

    const EXPORT_TYPE_CONFIG = {
        [EXPORT_TYPES.TEACHER_INFO]: {
            label: '老师信息数据',
            description: '导出所有老师的基本信息及相关统计数据',
            requiresDateRange: false,
            icon: 'person'
        },
        [EXPORT_TYPES.STUDENT_INFO]: {
            label: '学生信息数据',
            description: '导出所有学生的基本信息及相关统计数据',
            requiresDateRange: false,
            icon: 'people'
        },
        [EXPORT_TYPES.TEACHER_SCHEDULE]: {
            label: '老师授课记录',
            description: '导出老师在指定时间范围内的排课详细记录',
            requiresDateRange: true,
            icon: 'event_note'
        },
        [EXPORT_TYPES.STUDENT_SCHEDULE]: {
            label: '学生上课记录',
            description: '导出学生在指定时间范围内的上课详细记录',
            requiresDateRange: true,
            icon: 'calendar_month'
        }
    };

    // ============ 状态管理 ============
    const state = {
        isOpen: false,
        selectedType: null,
        selectedFormat: EXPORT_FORMATS.EXCEL,
        startDate: null,
        endDate: null,
        isExporting: false
    };

    // ============ DOM 引用 ============
    let dialogElement = null;
    let modalOverlay = null;

    // ============ 类型标准化工具 ============
    /**
     * 标准化类型名称（英文key）
     * 将线上类型统一为基础类型：
     * - review_online → review
     * - visit_online → visit
     * - consultation_online → consultation
     * - review_record_online → review_record
     * - consultation_record_online → consultation_record
     * @param {string} typeKey - 类型英文标识 (如 review, review_online, visit, visit_online)
     * @returns {string} 标准化后的类型英文标识
     */
    const normalizeTypeKey = (typeKey) => {
        const lower = String(typeKey || '').toLowerCase().trim();
        // 线上评审 → 评审
        if (lower === 'review_online' || lower === 'online_review') return 'review';
        // 线上入户 → 入户
        if (lower === 'visit_online' || lower === 'online_visit') return 'visit';
        // 线上咨询 → 咨询
        if (lower === 'consultation_online' || lower === 'online_consultation' || lower === 'advisory_online' || lower === 'online_advisory') return 'consultation';
        // 线上评审记录 → 评审记录
        if (lower === 'review_record_online' || lower === 'online_review_record') return 'review_record';
        // 线上咨询记录 → 咨询记录
        if (lower === 'consultation_record_online' || lower === 'online_consultation_record') return 'consultation_record';
        return lower;
    };

    /**
     * 标准化类型中文描述
     * 将（线上）评审/（线上）入户/（线上）咨询统一为基础类型
     * @param {string} typeDesc - 类型中文描述 (如 评审, （线上）评审, 入户, （线上）入户)
     * @returns {string} 标准化后的中文描述
     */
    const normalizeTypeDesc = (typeDesc) => {
        let desc = String(typeDesc || '').trim();
        // （线上）评审 / 线上评审 → 评审
        if (desc === '（线上）评审' || desc === '(线上)评审' || desc === '线上评审') return '评审';
        // （线上）入户 / 线上入户 → 入户
        if (desc === '（线上）入户' || desc === '(线上)入户' || desc === '线上入户') return '入户';
        // （线上）咨询 / 线上咨询 → 咨询
        if (desc === '（线上）咨询' || desc === '(线上)咨询' || desc === '线上咨询') return '咨询';
        // （线上）评审记录 / 线上评审记录 → 评审记录
        if (desc === '（线上）评审记录' || desc === '(线上)评审记录' || desc === '线上评审记录') return '评审记录';
        // （线上）咨询记录 / 线上咨询记录 → 咨询记录
        if (desc === '（线上）咨询记录' || desc === '(线上)咨询记录' || desc === '线上咨询记录') return '咨询记录';
        return desc;
    };

    // V1 createDialogHTML 已移除，统一使用文件末尾的 V2 版本

    /**
     * 初始化对话框样式
     */
    // V1 injectStyles 已移除，统一使用文件末尾的 V2 版本



    /**
     * 关闭对话框
     * @param {boolean} force - 是否强制关闭（用于导出完成后）
     */
    function close(force = false) {
        // 如果正在导出且未强制关闭，则阻止关闭
        if (state.isExporting && !force) {
            return;
        }
        
        if (modalOverlay) modalOverlay.style.display = 'none';
        if (dialogElement) dialogElement.style.display = 'none';
        document.body.style.overflow = '';
        state.isOpen = false;
        state.isExporting = false;
        resetState();
    }

    /**
     * 初始化对话框
     */
    function init() {
        // 防止重复创建：先移除已存在的 DOM
        const existing = document.getElementById('exportDialogOverlay');
        if (existing) {
            existing.remove();
            dialogElement = null; // 重置引用
        }

        if (dialogElement) return; // double check

        // 注入样式
        injectStyles();

        // 创建 HTML
        const html = createDialogHTML();
        const tempDiv = document.createElement('div');
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tempDiv, html); } else { tempDiv.innerHTML = html; }
        const element = tempDiv.firstElementChild;
        document.body.appendChild(element);

        modalOverlay = document.getElementById('exportDialogOverlay');
        dialogElement = document.getElementById('exportDialog');

        // 绑定事件
        bindEvents();
    }

    /**
     * 绑定事件处理
     */
    /**
     * 绑定事件处理
     */
    function bindEvents() {
        // 关闭按钮 (Header & Footer)
        document.querySelectorAll('.export-dialog-close, #exportDialogCancelBtn').forEach(btn => {
            btn.addEventListener('click', close);
        });

        // 侧边栏类型选择
        document.querySelectorAll('.export-type-item').forEach(item => {
            item.addEventListener('click', () => {
                const typeId = item.getAttribute('data-type');
                selectExportType(typeId);
            });
        });

        // 快速日期选择
        document.querySelectorAll('.export-preset-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const preset = this.getAttribute('data-preset');
                setQuickSelectDate(preset);
            });
        });

        // 日期输入变化
        const startInput = document.getElementById('exportStartDate');
        const endInput = document.getElementById('exportEndDate');
        if (startInput) startInput.addEventListener('change', validateForm);
        if (endInput) endInput.addEventListener('change', validateForm);

        // 导出按钮
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', performExport);
        }

        // 点击背景关闭
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                close();
            }
        });

        // 复制按钮事件 (已移除)
    }

    /**
     * 选择导出类型
     */
    function selectExportType(typeId) {
        // 防御性检查
        const config = EXPORT_TYPE_CONFIG[typeId];
        if (!config) {
            return;
        }

        state.selectedType = typeId;

        // 1. 更新侧边栏状态
        document.querySelectorAll('.export-type-item').forEach(item => {
            const isActive = item.getAttribute('data-type') === typeId;
            item.classList.toggle('active', isActive);
        });

        // 2. 更新头部信息
        const titleEl = document.getElementById('exportMainTitle');
        const descEl = document.getElementById('exportMainDesc');
        if (titleEl) titleEl.textContent = config.label;
        if (descEl) descEl.textContent = config.description;

        // 3. 显示配置容器
        const configContainer = document.getElementById('exportConfigContainer');
        if (configContainer) configContainer.style.display = 'block';

        // 4. 显示/隐藏日期范围
        const dateSection = document.getElementById('dateRangeSection');
        if (dateSection) {
            dateSection.style.display = config.requiresDateRange ? 'block' : 'none';
        }

        // 5. 显示/隐藏筛选区域（老师授课记录时显示学生+教师筛选）
        const filterSection = document.getElementById('exportFilterSection');
        const studentFilter = document.getElementById('exportStudentFilter');
        const teacherFilter = document.getElementById('exportTeacherFilter');
        const showFilters = (typeId === EXPORT_TYPES.TEACHER_SCHEDULE || typeId === EXPORT_TYPES.STUDENT_SCHEDULE);

        // 显示筛选区域容器
        if (filterSection) {
            filterSection.style.display = showFilters ? 'block' : 'none';
        }

        // 显示学生筛选
        if (studentFilter) {
            studentFilter.style.display = showFilters ? 'block' : 'none';
            if (showFilters && !state.studentsLoaded) {
                loadStudentList();
            }
        }

        // 显示教师筛选
        if (teacherFilter) {
            teacherFilter.style.display = showFilters ? 'block' : 'none';
            if (showFilters && !state.teachersLoaded) {
                loadTeacherList();
            }
        }

        // 如果需要日期范围且未设置，默认选中本月
        if (config.requiresDateRange && (!state.startDate || !state.endDate)) {
            setQuickSelectDate('last-month');
        } else {
            validateForm();
        }
    }

    /**
     * 应用日期预设
     */
    /**
     * 应用日期预设
     */
    function setQuickSelectDate(preset) {
        const today = new Date();
        const year = today.getFullYear();
        let start, end;

        // 辅助格式化
        const formatDate = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };

        const getWeekRange = (date, offset = 0) => {
            const currentDay = date.getDay(); // 0-6 (Sun-Sat)
            const diffToMon = currentDay === 0 ? 6 : currentDay - 1;
            const mon = new Date(date);
            mon.setDate(date.getDate() - diffToMon + (offset * 7));
            const sun = new Date(mon);
            sun.setDate(mon.getDate() + 6);
            return [mon, sun];
        };

        switch (preset) {
            case 'week': {
                // 本周
                const [mon, sun] = getWeekRange(today, 0);
                start = formatDate(mon);
                end = formatDate(sun);
                break;
            }
            case 'last-week': {
                // 上周
                const [mon, sun] = getWeekRange(today, -1);
                start = formatDate(mon);
                end = formatDate(sun);
                break;
            }
            case 'month': {
                // 本月
                const firstDay = new Date(year, today.getMonth(), 1);
                const lastDay = new Date(year, today.getMonth() + 1, 0);
                start = formatDate(firstDay);
                end = formatDate(lastDay);
                break;
            }
            case 'last-month': {
                // 上月
                const firstDay = new Date(year, today.getMonth() - 1, 1);
                const lastDay = new Date(year, today.getMonth(), 0);
                start = formatDate(firstDay);
                end = formatDate(lastDay);
                break;
            }
            case 'quarter': {
                // 本季度
                const currMonth = today.getMonth();
                const startMonth = Math.floor(currMonth / 3) * 3;
                const firstDay = new Date(year, startMonth, 1);
                const lastDay = new Date(year, startMonth + 3, 0);
                start = formatDate(firstDay);
                end = formatDate(lastDay);
                break;
            }
            case 'last-quarter': {
                // 上季度
                const currMonth = today.getMonth();
                const startMonth = Math.floor(currMonth / 3) * 3 - 3; // Move back 3 months
                const firstDay = new Date(year, startMonth, 1);
                // end date is last day of the quarter (startMonth + 3)
                // Note: new Date(year, month, 0) gives last day of previous month, so we want startMonth + 3
                const lastDay = new Date(year, startMonth + 3, 0);
                start = formatDate(firstDay);
                end = formatDate(lastDay);
                break;
            }
            default:
                break;
        }

        const sInput = document.getElementById('exportStartDate');
        const eInput = document.getElementById('exportEndDate');
        if (sInput && start) sInput.value = start;
        if (eInput && end) eInput.value = end;

        // 更新按钮状态
        document.querySelectorAll('.export-preset-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-preset') === preset);
        });

        validateForm();
    }

    /**
     * 加载学生列表
     */
    async function loadStudentList() {
        const studentSelect = document.getElementById('exportStudentSelect');
        if (!studentSelect) return;

        // 优先检查本地缓存
        let cachedData = null;
        try {
            const raw = localStorage.getItem('cached_students_full');
            if (raw) cachedData = JSON.parse(raw);
        } catch (e) {
        }

        const renderList = (list) => {
            let html = '';
            // 需求：如果只有一个学生关联，则不显示全部学生。
            if (list.length > 1) {
                html += '<option value="">全部学生</option>';
            }

            // Sort by name for better UX
            list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            list.forEach(s => {
                const name = s.name || s.username || '未知';
                html += `<option value="${s.id}">${name}</option>`;
            });
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(studentSelect, html); } else { studentSelect.innerHTML = html; }
        };

        // 需求：如果是教师/班主任，应实时获取其关联的学生列表，而不应使用管理员缓存的全体学生
        const currentUser = getCurrentUser();
        const userType = currentUser.userType || 'admin';

        if (userType === 'admin' && cachedData && Array.isArray(cachedData) && cachedData.length > 0) {
            // 管理员可以使用全体学生缓存
            renderList(cachedData);
            studentSelect.disabled = false;
            state.studentsLoaded = true;
        } else {
            // 班主任或无缓存时，显示 Loading 并从接口获取
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(studentSelect, '<option value="">加载中...</option>'); } else { studentSelect.innerHTML = '<option value="">加载中...</option>'; }
            studentSelect.disabled = true;
        }

        // 无论有无缓存，如果当前尚未标记为 'fresh' (或者我们决定每次打开都静默刷新)，都可以尝试 Fetch。
        // 但为了避免 UI 跳变和 "加载不出" 的问题，如果有了缓存，我们在本次会话中就不必频繁 Fetch，除非显式触发刷新。
        // 根据用户描述："用户进入系统读取的时候...保存到本地缓存"，我们可以在 Dialog Init 或者 Admin Init 加载一次。
        // 这里作为 fallback：如果没有缓存，或者缓存数据为空，强制 Fetch。如果有缓存，我们可以信任缓存（由 Admin 模块负责更新）。

        // 对于班主任，必须强制 Fetch 以获取最新的关联学生映射
        if (userType === 'teacher' || !cachedData || cachedData.length === 0) {
            try {
                const apiPath = userType === 'teacher' ? '/teacher/associated-students' : '/admin/users/student';

                const response = await window.apiUtils.get(apiPath);
                const students = Array.isArray(response) ? response : (response.data || []);

                // 更新缓存
                localStorage.setItem('cached_students_full', JSON.stringify(students));

                // 渲染
                renderList(students);
                studentSelect.disabled = false;
                state.studentsLoaded = true;
            } catch (e) {
                // 如果没有缓存且加载失败
                if (!cachedData) {
                    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(studentSelect, '<option value="">加载失败</option>'); } else { studentSelect.innerHTML = '<option value="">加载失败</option>'; }
                    studentSelect.disabled = false;
                }
            }
        }
    }

    /**
     * 加载教师列表
     */
    async function loadTeacherList() {
        const teacherSelect = document.getElementById('exportTeacherSelect');
        if (!teacherSelect) return;

        // 优先检查本地缓存
        let cachedData = null;
        try {
            const raw = localStorage.getItem('cached_teachers_full');
            if (raw) cachedData = JSON.parse(raw);
        } catch (e) {
        }

        const renderList = (list) => {
            let html = '<option value="">全部教师</option>';
            const activeTeachers = list.filter(t => Number(t.status) !== -1);
            activeTeachers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            activeTeachers.forEach(t => {
                const name = t.name || t.username || '未知';
                html += `<option value="${t.id}">${name}</option>`;
            });
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(teacherSelect, html); } else { teacherSelect.innerHTML = html; }
        };

        if (cachedData && Array.isArray(cachedData) && cachedData.length > 0) {
            renderList(cachedData);
            teacherSelect.disabled = false;
            state.teachersLoaded = true;
        } else {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(teacherSelect, '<option value="">加载中...</option>'); } else { teacherSelect.innerHTML = '<option value="">加载中...</option>'; }
            teacherSelect.disabled = true;
        }

        if (!cachedData || cachedData.length === 0) {
            try {
                const currentUser = window.currentUser || {};
                const userType = currentUser.userType || 'admin';
                const apiPath = userType === 'teacher' ? '/teacher/all-teachers' : '/admin/users/teacher';

                const response = await window.apiUtils.get(apiPath);
                const teachers = Array.isArray(response) ? response : (response.data || []);

                // 更新缓存
                localStorage.setItem('cached_teachers_full', JSON.stringify(teachers));

                renderList(teachers);
                teacherSelect.disabled = false;
                state.teachersLoaded = true;
            } catch (e) {
                if (!cachedData) {
                    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(teacherSelect, '<option value="">加载失败</option>'); } else { teacherSelect.innerHTML = '<option value="">加载失败</option>'; }
                    teacherSelect.disabled = false;
                }
            }
        }
    }


    /**
     * 验证表单并更新按钮状态
     */
    function validateForm() {
        const exportBtn = document.getElementById('exportBtn');
        const msgSpan = document.getElementById('exportDateValidationMsg');
        if (!state.selectedType) {
            if (exportBtn) exportBtn.disabled = true;
            return;
        }

        const config = EXPORT_TYPE_CONFIG[state.selectedType];
        let isValid = true;
        let message = '';

        if (config.requiresDateRange) {
            const sVal = document.getElementById('exportStartDate')?.value;
            const eVal = document.getElementById('exportEndDate')?.value;

            if (!sVal || !eVal) {
                isValid = false;
            } else {
                const sDate = new Date(sVal);
                const eDate = new Date(eVal);

                if (sDate > eDate) {
                    isValid = false;
                    message = '开始日期不能晚于结束日期';
                } else if ((eDate - sDate) / (1000 * 3600 * 24) > 365) {
                    isValid = false;
                    message = '时间跨度不能超过一年';
                }

                if (isValid) {
                    state.startDate = sDate;
                    state.endDate = eDate;
                }
            }
        }

        if (msgSpan) {
            msgSpan.textContent = message;
            msgSpan.style.display = message ? 'block' : 'none';
            msgSpan.className = 'validation-msg error'; // Ensure style
        }

        if (exportBtn) exportBtn.disabled = !isValid;

        // 复制按钮状态更新 (已移除)
    }

    // performCopy 已被移除

    /**
     * 执行导出
     */
    async function performExport() {


        if (state.isExporting) {
            return;
        }
        state.isExporting = true;

        const typeConfig = EXPORT_TYPE_CONFIG[state.selectedType];
        const format = state.selectedFormat;

        if (!typeConfig) {
            state.isExporting = false;
            return;
        }

        try {
            // 立即更新按钮状态
            const exportBtn = document.getElementById('exportBtn');
            const originalBtnText = exportBtn ? exportBtn.innerHTML : '导出 Excel';
            if (exportBtn) {
                exportBtn.disabled = true;
                if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(exportBtn, '<i class="fas fa-spinner fa-spin"></i> 导出 Excel···'); } else { exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 导出 Excel···'; }
            }

            // 更新 UI
            updateProgress(5, '验证参数...');
            // 减少模拟过渡动画时间，提升响应感
            await new Promise(r => setTimeout(r, 300));

            // 构建请求参数
            const params = new URLSearchParams({
                type: state.selectedType,
                format: format
            });

            // 添加学生筛选
            const studentSelect = document.getElementById('exportStudentSelect');
            if ((state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE || state.selectedType === EXPORT_TYPES.STUDENT_SCHEDULE) &&
                studentSelect && studentSelect.value) {
                params.append('student_id', studentSelect.value);
            }

            // 添加教师筛选
            const teacherSelect = document.getElementById('exportTeacherSelect');
            if ((state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE || state.selectedType === EXPORT_TYPES.STUDENT_SCHEDULE) &&
                teacherSelect && teacherSelect.value) {
                params.append('teacher_id', teacherSelect.value);
                state.teacherName = teacherSelect.options[teacherSelect.selectedIndex].text;
            } else {
                state.teacherName = '全部老师';
            }

            if (typeConfig.requiresDateRange) {
                if (!state.startDate || !state.endDate) {
                    throw new Error('需要有效的导出日期范围');
                }
                const formatDateLocal = (d) => {
                    const year = d.getFullYear();
                    const month = String(d.getMonth() + 1).padStart(2, '0');
                    const day = String(d.getDate()).padStart(2, '0');
                    return `${year}-${month}-${day}`;
                };
                const startDateStr = formatDateLocal(state.startDate);
                const endDateStr = formatDateLocal(state.endDate);
                // 兼容不同后端命名习惯 (camelCase 和 snake_case)
                params.append('startDate', startDateStr);
                params.append('endDate', endDateStr);
                params.append('start_date', startDateStr);
                params.append('end_date', endDateStr);
            }

            // 确保 type 也传对
            params.append('type_id', state.selectedType || '');



            // 确保类型数据已加载
            if (window.ScheduleTypesStore) {
                await window.ScheduleTypesStore.init();
            }

            updateProgress(20, '正在加载数据...');
            await new Promise(r => setTimeout(r, 300));

            // 调用导出 API
            // 根据角色判断调用哪个接口
            let apiUrl = `/admin/export-advanced?${params.toString()}`;
            const currentUser = getCurrentUser();
            const userType = currentUser.userType || 'admin';

            if (userType === 'teacher') {
                // 如果是教师导出教师排课记录，路由应指向 /teacher/student-schedules/export (apiUtils 会自动加 /api)
                // 彻底移除 '/api' 前缀，防止产生 '/api/api/...' 的错误路径
                if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) {
                    apiUrl = `/teacher/student-schedules/export?${params.toString()}`;
                } else {
                    apiUrl = `/teacher/export?${params.toString()}`;
                }
            } else if (userType === 'student') {
                apiUrl = `/student/export?${params.toString()}`;
            }

            const response = await window.apiUtils.get(apiUrl);


            updateProgress(60, '正在生成文件...');
            await new Promise(r => setTimeout(r, 300));

            if (!response) {
                throw new Error('导出 API 返回为空');
            }

            // 检测是否已经是底层 Blob （教师和学生端的定制化导出直接返回的已经是完整二进制表）
            if (response && response.blob) {
                const url = window.URL.createObjectURL(response.blob);
                const a = document.createElement('a');
                a.href = url;
                // 使用后端传递的文件名（已解译）作为兜底，如果为空则走回退
                const dispositionFilename = response.filename
                    ? decodeURIComponent(response.filename)
                    : `数据导出_${Date.now()}.xlsx`;

                a.download = dispositionFilename;
                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(url);

                updateProgress(100, `文件生成完成，正在下载...`);
                state.isExporting = false;
                setTimeout(() => {
                    showToast(`导出成功`, 'success');
                    setTimeout(() => close(true), 400);
                }, 300);
                return;
            }

            // API 直接返回导出结果对象 {format, data, columns?, filename} 或直接返回数组
            const exportResult = response;

            // 5. 构建优化后的文件名
            // 5. 构建优化后的文件名
            // 格式要求：
            // 管理员: [教师/学生]授课记录指定时间[开始_结束]_当前[管理员名].xlsx
            // 教师/学生: [姓名]授课记录[开始_结束]_当前.xlsx

            const now = new Date();
            const formatDateForFilename = (d) => {
                const year = d.getFullYear();
                const month = String(d.getMonth() + 1).padStart(2, '0');
                const day = String(d.getDate()).padStart(2, '0');
                return `${year}${month}${day}`;
            };
            const yyyyMMdd = formatDateForFilename(now);
            const hhmmss = now.toTimeString().slice(0, 8).replace(/:/g, '');
            const timestamp = `${yyyyMMdd}${hhmmss}`; // YYYYMMDDHHMMSS

            let dateRangeStr = '';
            if (state.startDate && state.endDate) {
                const s = formatDateForFilename(state.startDate);
                const e = formatDateForFilename(state.endDate);
                dateRangeStr = `[${s}_${e}]`;
            }

            // 尝试获取用户数据 (兼容 window.currentUser 或 localStorage)
            let appUser = currentUser || {};
            if (!appUser.username && !appUser.name) {
                try {
                    const localData = JSON.parse(localStorage.getItem('userData'));
                    if (localData) appUser = localData;
                } catch (e) {
                }
            }
            let filename = '';

            // 文件名生成逻辑
            if (exportResult && exportResult.filename) {
                // 教师端直接使用后端返回的文件名（后端已按需求格式生成）
                if (userType === 'teacher') {
                    filename = exportResult.filename;
                } else if (state.selectedType !== EXPORT_TYPES.TEACHER_SCHEDULE &&
                    state.selectedType !== EXPORT_TYPES.STUDENT_SCHEDULE) {
                    // 管理端的非排课类型使用后端文件名
                    filename = exportResult.filename;
                }
            }

            // 如果后端没有返回文件名，或管理端排课类型，使用前端生成的格式
            if (!filename) {
                if (userType === 'admin') {
                    // 管理员格式
                    // 授课记录指定时间 -> 这里的 typeConfig.label 可能是 "教师授课记录" 或 "学生授课记录"
                    // 去掉可能的 "导出" 字样，保持核心名词
                    let coreName = typeConfig.label || '数据导出';
                    // 如果是特定格式的需求，强制调整 coreName
                    if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) coreName = '教师授课记录';
                    if (state.selectedType === EXPORT_TYPES.STUDENT_SCHEDULE) coreName = '学生排课记录';

                    // 管理员名称使用 username
                    const adminName = appUser.username || appUser.name || 'admin';

                    // 获取筛选值文本
                    const studentSelect = document.getElementById('exportStudentSelect');
                    const teacherSelect = document.getElementById('exportTeacherSelect');

                    let studentFilterStr = '全部学生';
                    if (studentSelect && studentSelect.value) {
                        const option = studentSelect.options[studentSelect.selectedIndex];
                        if (option) studentFilterStr = option.text;
                    }

                    let teacherFilterStr = '全部教师';
                    if (teacherSelect && teacherSelect.value) {
                        const option = teacherSelect.options[teacherSelect.selectedIndex];
                        if (option) teacherFilterStr = option.text;
                    }

                    // 格式：教师授课/学生排课记录[学生筛选][老师筛选][导出日期段][导出人用户名]_当前时间戳
                    filename = `${coreName}[${studentFilterStr}][${teacherFilterStr}]${dateRangeStr}[${adminName}]_${timestamp}`;
                } else {
                    // 学生格式
                    const myName = appUser.name || appUser.username || '用户';

                    filename = `[${myName}]授课记录${dateRangeStr}_${timestamp}`;
                }

                filename += `.${format === EXPORT_FORMATS.EXCEL ? 'xlsx' : 'csv'}`;
            }

            // 生成文件 - 传递 filename 参数
            // 兼容直接返回数组，或嵌套在 data.data 中的情况
            let rawData = [];

            if (Array.isArray(exportResult)) {
                rawData = exportResult;
            } else if (exportResult && exportResult.data) {
                // 如果是数组或者是对象（多 Sheet），都作为 rawData 处理词词词
                if (Array.isArray(exportResult.data) || (typeof exportResult.data === 'object' && exportResult.data !== null)) {
                    rawData = exportResult.data;
                } else if (Array.isArray(exportResult.data.data)) {
                    rawData = exportResult.data.data;
                }
            }



            // const studentSelect ... (removed to fix lint, already declared)
            const selectedStudentId = (document.getElementById('exportStudentSelect') || {}).value;
            // Get selected student name for remark generation
            let selectedStudentName = '全部学生';
            const studentSelectEl = document.getElementById('exportStudentSelect');
            if (studentSelectEl && studentSelectEl.value) {
                const opt = studentSelectEl.options[studentSelectEl.selectedIndex];
                if (opt) selectedStudentName = opt.text;
            }

            const transformedData = window.ExportManager.transformExportData(rawData, selectedStudentId, selectedStudentName, userType, state, EXPORT_TYPES);

            if (format === EXPORT_FORMATS.EXCEL) {
                await window.ExportManager.generateExcelFile(transformedData, filename, userType);
            } else {
                // CSV 不支持多 Sheet，如果是多 Sheet 数据，默认仅导出 "总览表"
                let csvData = transformedData;

                if (!Array.isArray(transformedData)) {
                    if (transformedData['总览表']) {
                        csvData = transformedData['总览表'];
                    } else if (typeof transformedData === 'object') {
                        // 兜底：如果没找到"总览表"，取第一个是数组的值
                        const values = Object.values(transformedData);
                        const firstArray = values.find(v => Array.isArray(v));
                        if (firstArray) {
                            csvData = firstArray;
                        }
                    }
                }

                showToast('暂不支持 CSV 导出，请升级功能或使用 Excel', 'warning');
            }








            // 计算记录数用于显示
            const recordCount = rawData.length || 0;

            updateProgress(100, `导出完成！共 ${recordCount} 条记录`);

            // 重置导出状态（放在前面确保后续点击能正常触发）
            state.isExporting = false;

            // 导出成功，自动关闭对话框
            const msg = `导出成功！文件名：${filename}`;
            showToast(msg, 'success');
            setTimeout(() => close(true), 400);
        } catch (error) {
            updateProgress(0, '导出失败');

            // 显示错误提示并提供重试按钮
            const progressMsg = document.getElementById('exportProgressMsg');
            if (progressMsg) {
                    progressMsg.innerHTML = `
                    <span style="color: #ef4444;">导出失败: ${error.message || '未知错误'}</span>
                    <button onclick="window.ExportDialog.retryExport()" style="
                        margin-left: 12px;
                        padding: 4px 12px;
                        background: #10b981;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    ">重试</button>
                `;
            }
            showToast(`导出失败: ${error.message} `, 'error');
            state.isExporting = false;

            // 恢复按钮状态
            const exportBtn = document.getElementById('exportBtn');
            if (exportBtn) {
                exportBtn.disabled = false;
                if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(exportBtn, '<span class="material-icons-round">download</span> 导出 Excel'); } else { exportBtn.innerHTML = '<span class="material-icons-round">download</span> 导出 Excel'; }
            }
        }
    }


    /**
     * 重试导出
     */
    function retryExport() {
        state.isExporting = false;
        performExport();
    }

    /**
     * 更新导出进度
     */
    function updateProgress(percent, message) {
        const fill = document.getElementById('exportProgressFill');
        const percentSpan = document.getElementById('exportProgressPercent');
        const msgSpan = document.getElementById('exportProgressMsg');

        if (fill) fill.style.width = percent + '%';
        if (percentSpan) percentSpan.textContent = percent + '%';
        if (msgSpan) msgSpan.textContent = message;
    }



    /**
     * 显示提示信息（使用右上角Toast组件）
     */
    function showToast(message, type = 'info') {
        if (window.Toast) {
            window.Toast.show(message, { type: type, duration: 3000 });
        }
    }

    /**
     * 重置状态
     */
    /**
     * 重置状态
     * @param {Object} options - 初始化选项 { startDate, endDate }
     */
    function resetState(options = {}) {
        state.selectedType = null;
        state.selectedFormat = EXPORT_FORMATS.EXCEL;
        state.isExporting = false;
        state.studentsLoaded = false;
        state.teachersLoaded = false;

        // 使用传入的日期或默认为空
        state.startDate = options.startDate || null;
        state.endDate = options.endDate || null;

        // 如果 DOM 已存在，立即更新日期输入框
        const startInput = document.getElementById('exportStartDate');
        const endInput = document.getElementById('exportEndDate');
        if (startInput) startInput.value = state.startDate || '';
        if (endInput) endInput.value = state.endDate || '';

        // 重置进度和 Loading 状态
        const progressFill = document.getElementById('exportProgressFill');
        if (progressFill) progressFill.style.width = '0%';

        const progressMsg = document.getElementById('exportProgressMsg');
        if (progressMsg) {
            progressMsg.textContent = '准备就绪';
            progressMsg.style.color = '#64748b';
            // remove any error html
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(progressMsg, '准备就绪'); } else { progressMsg.innerHTML = '准备就绪'; }
        }

        const overlay = document.getElementById('exportLoadingOverlay');
        if (overlay) overlay.style.display = 'none';
    }

    /**
     * 显示对话框
     * @param {Object} options - 配置项 { startDate, endDate }
     */
    function show(options) {
        init();
        // 确保 DOM 初始化后再重置状态，并传入选项
        resetState(options);

        const currentUser = getCurrentUser();
        
        if (currentUser.userType === 'teacher' || currentUser.userType === 'student') {
            // 针对班主任/学生，如果只有一个导出选项，侧边栏可能显得多余，但为了样式统一保留。
            // 强制选中对应的单选项。
            setTimeout(() => {
                const type = currentUser.userType === 'teacher' ? 'teacher_schedule' : 'student_schedule';
                const el = document.querySelector(`.export-type-item[data-type="${type}"]`);
                if (el) {
                    el.click();
                }
            }, 50);
        } else if (currentUser.userType === 'admin') {
            // 管理员默认选中教师授课记录
            setTimeout(() => {
                const el = document.querySelector(`.export-type-item[data-type="teacher_schedule"]`);
                if (el) {
                    el.click();
                }
            }, 50);
        }

        if (dialogElement) dialogElement.style.display = 'flex';
        if (modalOverlay) modalOverlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        state.isOpen = true;
    }

    /**
     * 初始化对话框 HTML 结构 - Split View Layout
     */
    function createDialogHTML() {
        // 根据角色过滤导出类型
        const currentUser = getCurrentUser();
        const userType = currentUser.userType || 'admin';
        
        let filteredTypes = Object.entries(EXPORT_TYPE_CONFIG);
        if (userType === 'teacher') {
            // 班主任只保留教师授课记录导出
            filteredTypes = filteredTypes.filter(([id]) => id === EXPORT_TYPES.TEACHER_SCHEDULE);
        } else if (userType === 'student') {
            filteredTypes = filteredTypes.filter(([id]) => id === EXPORT_TYPES.STUDENT_SCHEDULE);
        }
        
        const html = `
            <div id="exportDialogOverlay" class="export-dialog-overlay" style="display: none;">
                <div id="exportDialog" class="export-dialog-container">
                    
                    <!-- 侧边栏：类型选择 -->
                    <div class="export-sidebar">
                        <div class="export-sidebar-header">
                            <h3>导出类型</h3>
                        </div>
                        <div class="export-type-list">
                            ${filteredTypes.map(([typeId, config]) => `
                                <div class="export-type-item" data-type="${typeId}">
                                    <span class="material-icons-round export-type-icon">${config.icon}</span>
                                    <div class="export-type-text">
                                        <span class="export-type-label">${config.label}</span>
                                    </div>
                                    <span class="material-icons-round check-icon">check</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- 主内容区：配置与操作 -->
                    <div class="export-main">
                        <div class="export-header">
                            <div class="export-title-group">
                                <h2 id="exportMainTitle">请选择导出类型</h2>
                                <p id="exportMainDesc">选择左侧类型以配置导出选项</p>
                            </div>
                            <button class="export-dialog-close" aria-label="关闭">
                                <span class="material-icons-round">close</span>
                            </button>
                        </div>

                        <div class="export-body">
                            <!-- 配置表单容器 -->
                            <div id="exportConfigContainer" class="export-config-container" style="display:none;">
                                
                                <!-- 日期范围 -->
                                <div class="config-section" id="dateRangeSection">
                                    <label class="section-label">时间范围</label>
                                    <div class="date-input-group">
                                        <div class="input-wrapper">
                                            <label>开始日期</label>
                                            <input type="date" id="exportStartDate">
                                        </div>
                                        <div class="input-wrapper">
                                            <label>结束日期</label>
                                            <input type="date" id="exportEndDate">
                                        </div>
                                    </div>
                                    
                                    <!-- 快速选择胶囊按钮 -->
                                    <div class="quick-select-group">
                                        <button type="button" class="export-preset-btn" data-preset="week">本周</button>
                                        <button type="button" class="export-preset-btn" data-preset="month">本月</button>
                                        <button type="button" class="export-preset-btn" data-preset="quarter">本季度</button>
                                        <button type="button" class="export-preset-btn" data-preset="last-week">上周</button>
                                        <button type="button" class="export-preset-btn active" data-preset="last-month">上月</button>
                                        <button type="button" class="export-preset-btn" data-preset="last-quarter">上季度</button>
                                    </div>
                                    <div class="validation-msg" id="exportDateValidationMsg" style="display:none"></div>
                                </div>

                                <!-- 学生/教师筛选 (并列布局) -->
                                <div class="config-section filter-row" id="exportFilterSection" style="display: none;">
                                    <label class="section-label">筛选条件</label>
                                    <div class="filter-select-group" style="display: flex; gap: 16px;">
                                        <!-- 学生筛选 -->
                                        <div class="filter-item" id="exportStudentFilter" style="flex: 1; display: none;">
                                            <label class="filter-label" style="font-size: 13px; color: #64748b; margin-bottom: 6px; display: block;">筛选学生</label>
                                            <select id="exportStudentSelect" class="student-select" style="width: 100%;">
                                                <option value="">全部学生</option>
                                                <option value="loading" disabled>加载中...</option>
                                            </select>
                                        </div>
                                        <!-- 教师筛选 -->
                                        <div class="filter-item" id="exportTeacherFilter" style="flex: 1; display: none;">
                                            <label class="filter-label" style="font-size: 13px; color: #64748b; margin-bottom: 6px; display: block;">筛选教师</label>
                                            <select id="exportTeacherSelect" class="teacher-select" style="width: 100%;">
                                                <option value="">全部教师</option>
                                                <option value="loading" disabled>加载中...</option>
                                            </select>
                                        </div>
                                    </div>
                                    <p class="section-hint">选择特定人员以导出相关记录</p>
                                </div>

                            </div>
                            
                            <!-- 导出进度遮罩 (覆盖在主内容区) -->
                            <div id="exportLoadingOverlay" class="export-loading-overlay" style="display: none;">
                                <div class="loading-content">
                                    <div class="spinner-box">
                                        <div class="export-spinner"></div>
                                    </div>
                                    <h3>正在导出...</h3>
                                    <p id="exportProgressMsg">准备数据中</p>
                                    <div class="progress-bar-bg">
                                        <div id="exportProgressFill" class="progress-bar-fill" style="width: 0%"></div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- 底部操作栏 -->
                        <div class="export-footer">
                            <button id="exportDialogCancelBtn" class="btn-cancel">取消</button>

                            <button id="exportBtn" class="btn-export" disabled>
                                <span class="material-icons-round">download</span>
                                导出 Excel
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        return html;
    }

    /**
     * 初始化对话框样式 - Split View Clean UI
     */
    function injectStyles() {
        const existingStyle = document.getElementById('exportDialogStyles');
        if (existingStyle) existingStyle.remove();

        const style = document.createElement('style');
        style.id = 'exportDialogStyles';
        style.textContent = `
            /* ========== 布局容器 ========== */
            .export-dialog-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(15, 23, 42, 0.5);
                backdrop-filter: blur(4px);
                z-index: 9999;
                display: flex; align-items: center; justify-content: center;
                animation: fadeIn 0.2s ease;
            }

            .export-dialog-container {
                background: #fff;
                width: 800px;
                height: 520px;
                border-radius: 16px;
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
                display: flex;
                overflow: hidden;
                animation: scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: 'Inter', system-ui, sans-serif;
            }

            /* ========== 左侧侧边栏 ========== */
            .export-sidebar {
                width: 260px;
                background: #f8fafc;
                border-right: 1px solid #e2e8f0;
                display: flex;
                flex-direction: column;
                padding: 24px 16px;
                flex-shrink: 0;
            }

            .export-sidebar-header h3 {
                margin: 0 0 16px 8px;
                font-size: 12px;
                font-weight: 700;
                text-transform: uppercase;
                color: #94a3b8;
                letter-spacing: 0.05em;
            }

            .export-type-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .export-type-item {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 16px;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s ease;
                color: #475569;
                border: 1px solid transparent;
            }

            .export-type-item:hover {
                background: #fff;
                color: #1e293b;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }

            .export-type-item.active {
                background: #fff;
                color: #059669;
                box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 6px -1px rgba(0,0,0,0.02);
                border-color: #e2e8f0;
            }

            .export-type-item .export-type-icon { font-size: 20px; }
            .export-type-item .check-icon { 
                font-size: 16px; 
                margin-left: auto; 
                opacity: 0; 
                transform: scale(0.5);
                transition: all 0.2s;
            }
            .export-type-item.active .check-icon { opacity: 1; transform: scale(1); }
            
            .export-type-label { font-size: 14px; font-weight: 500; }

            /* ========== 右侧主内容区 ========== */
            .export-main {
                flex: 1;
                display: flex;
                flex-direction: column;
                background: #fff;
                position: relative;
            }

            .export-header {
                padding: 24px 32px;
                border-bottom: 1px solid #f1f5f9;
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
            }

            .export-title-group h2 {
                margin: 0 0 4px 0;
                font-size: 18px;
                font-weight: 600;
                color: #0f172a;
            }

            .export-title-group p {
                margin: 0;
                font-size: 13px;
                color: #64748b;
            }

            .export-dialog-close {
                background: transparent; border: none; cursor: pointer;
                color: #94a3b8; padding: 4px; border-radius: 6px;
                transition: all 0.2s;
            }
            .export-dialog-close:hover { background: #f1f5f9; color: #475569; }

            .export-body {
                flex: 1;
                padding: 32px;
                overflow-y: auto;
                position: relative;
            }

            /* ========== 配置表单 ========== */
            .config-section { margin-bottom: 24px; }
            
            .section-label {
                display: block;
                font-size: 14px;
                font-weight: 600;
                color: #334155;
                margin-bottom: 12px;
            }

            .date-input-group {
                display: flex;
                gap: 16px;
                margin-bottom: 16px;
            }

            .input-wrapper { flex: 1; }
            .input-wrapper label {
                display: block;
                font-size: 12px;
                color: #64748b;
                margin-bottom: 6px;
            }

            .input-wrapper input, .student-select {
                width: 100%;
                padding: 10px 12px;
                font-size: 14px;
                border: 1px solid #cbd5e1;
                border-radius: 8px;
                color: #1e293b;
                background: #f8fafc;
                transition: all 0.2s;
                box-sizing: border-box;
            }

            .input-wrapper input:focus, .student-select:focus {
                background: #fff;
                border-color: #10b981;
                outline: none;
                box-shadow: 0 0 0 3px #d1fae5;
            }

            /* 快速选择 */
            .quick-select-group {
                display: flex;
                gap: 8px;
            }

            .export-preset-btn {
                padding: 6px 14px;
                font-size: 13px;
                border: 1px solid #e2e8f0;
                background: #fff;
                color: #475569;
                border-radius: 20px;
                cursor: pointer;
                transition: all 0.2s;
            }

            .export-preset-btn:hover { border-color: #cbd5e1; color: #1e293b; }
            .export-preset-btn.active {
                background: #ecfdf5;
                border-color: #10b981;
                color: #059669;
                font-weight: 500;
            }

            .section-hint {
                font-size: 12px;
                color: #94a3b8;
                margin: 8px 0 0 0;
            }

            /* ========== 底部操作栏 ========== */
            .export-footer {
                padding: 20px 32px;
                border-top: 1px solid #f1f5f9;
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                background: #fff;
            }

            .btn-cancel {
                padding: 10px 20px;
                border: 1px solid #e2e8f0;
                background: #fff;
                color: #64748b;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
            }
            .btn-cancel:hover { background: #f8fafc; color: #334155; border-color: #cbd5e1; }



            .btn-export {
                padding: 10px 24px;
                background: #059669;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: all 0.2s;
                box-shadow: 0 4px 6px -1px rgba(16, 185, 129, 0.3);
            }
            .btn-export:hover:not(:disabled) {
                background: #047857;
                transform: translateY(-1px);
                box-shadow: 0 6px 8px -1px rgba(16, 185, 129, 0.4);
            }
            .btn-export:disabled {
                background: #94a3b8;
                cursor: not-allowed;
                box-shadow: none;
                transform: none;
            }

            /* ========== Loading Overlay ========== */
            .export-loading-overlay {
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(255,255,255,0.9);
                backdrop-filter: blur(2px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 50;
                border-radius: 0 0 16px 0; /* Corner match */
            }

            .loading-content { text-align: center; }
            .spinner-box { margin-bottom: 20px; }
            
            .export-spinner {
                width: 40px; height: 40px;
                border: 3px solid #e2e8f0;
                border-top-color: #10b981;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto;
            }

            .loading-content h3 {
                margin: 0 0 8px 0;
                color: #1e293b;
                font-size: 16px;
            }
            
            .loading-content p {
                margin: 0 0 16px 0;
                color: #64748b;
                font-size: 13px;
            }

            .progress-bar-bg {
                width: 240px;
                height: 6px;
                background: #f1f5f9;
                border-radius: 3px;
                overflow: hidden;
                margin: 0 auto;
            }

            .progress-bar-fill {
                height: 100%;
                background: #10b981;
                border-radius: 3px;
                transition: width 0.3s ease;
            }

            @keyframes spin { to { transform: rotate(360deg); } }
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes scaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        `;
        document.head.appendChild(style);
    }

    /**
     * 公共 API
     */
    return {
        open: show,
        close,
        init,
        retryExport,
        isOpen: () => state.isOpen,
        // 公开 applyPreset，供页面其它脚本调用以同步预设
        applyPreset: (preset) => {
            // ensure dialog created
            try { init(); } catch (_) { }
        }
    };

})(); // End IIFE

