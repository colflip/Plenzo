/**
 * Admin Overview Module
 * 处理首页总览统计面板的逻辑
 */

// 加载总览统计数据
export async function loadOverviewStats() {
    // 确保 WeeklyDataStore 已完全加载 (等待 schedule-manager.js)
    if (window.WeeklyDataStore && !window.WeeklyDataStore.ttlMs) {

        const startWait = Date.now();
        while (window.WeeklyDataStore && !window.WeeklyDataStore.ttlMs) {
            if (Date.now() - startWait > 3000) {

                break;
            }
            await new Promise(r => setTimeout(r, 100));
        }

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

            return;
        }

        // 使用新的API工具类
        let data = null;
        try {
            data = await window.apiUtils.get('/admin/statistics/overview');
        } catch (apiError) {

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

        }

        // 直接更新卡片数值（HTML 已包含渐变卡片结构）
        const valueUpdates = {
            'teacherCount': teacherCount,
            'studentCount': studentCount,
            'weeklySchedules': weeklySchedules,
            'monthlySchedules': monthlySchedules,
            'yearlySchedules': yearlySchedules,
            'pendingConfirmations': pendingCount,
            'completedSchedules': completedSchedules,
            'cancelledSchedules': cancelledSchedules
        };

        Object.entries(valueUpdates).forEach(([id, value]) => {
            const el = document.getElementById(id);
            if (el) el.textContent = value;
        });

        // 绑定卡片点击事件
        setupAdminOverviewCardClicks({
            teacherCount, studentCount, weeklySchedules, monthlySchedules,
            yearlySchedules, pendingCount, completedSchedules, cancelledSchedules
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
export function setupAdminOverviewCardClicks(stats) {
    const setupClick = (elId, title, value, type) => {
        const el = document.getElementById(elId);
        if (el) {
            const card = el.closest('.stat-card');
            if (card) {
                // 移除旧监听器
                const newCard = card.cloneNode(true);
                card.parentNode.replaceChild(newCard, card);
                // Requires showAdminReward to be defined globally (it's in legacy-adapter.js or nearby)
                if (typeof showAdminReward === 'function') {
                    newCard.addEventListener('click', () => showAdminReward(title, value, type));
                    newCard.style.cursor = 'pointer';
                }
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
