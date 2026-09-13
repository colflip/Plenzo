/**
 * Admin Overview Module
 * 处理首页总览统计面板的逻辑
 */

import { renderErrorState } from '../shared/error-ui.js';

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

        const data = await window.apiUtils.get('/admin/statistics/overview');
        const metricKeys = [
            'teacher_count', 'student_count', 'monthly_schedules', 'pending_count',
            'weekly_schedules', 'yearly_schedules', 'completed_schedules', 'cancelled_schedules'
        ];
        if (!data || typeof data !== 'object' ||
            metricKeys.some(key => !Number.isFinite(Number(data[key])))) {
            throw new Error('总览统计响应格式无效');
        }
        document.getElementById('overviewStatsError')?.remove();

        // 8 个指标全部来自 /admin/statistics/overview 这一条接口（服务端同一条 SQL 的
        // subselect 算好）。原先本周/本年/已完成/已取消是另拉 /admin/schedules 全量
        // （实测 164KB、2.6s）再在浏览器里 forEach 数出来的 —— 4 个整数不值这个代价。
        const teacherCount = Number(data.teacher_count);
        const studentCount = Number(data.student_count);
        const monthlySchedules = Number(data.monthly_schedules);
        const pendingCount = Number(data.pending_count);
        const weeklySchedules = Number(data.weekly_schedules);
        const yearlySchedules = Number(data.yearly_schedules);
        const completedSchedules = Number(data.completed_schedules);
        const cancelledSchedules = Number(data.cancelled_schedules);

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
                if (userData.userType === 'admin') {
                    // 权限落地（Phase 3）：按级别细化身份显示
                    const lvl = parseInt(userData.permission_level, 10);
                    if (lvl === 1) roleLabel = '超级管理员';
                    else if (lvl === 2) roleLabel = '普通管理员';
                    else roleLabel = '操作员';
                }
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
            // 教师/学生汇总按较多人数对齐：先各自构建 stack，取较多人数为共享槽位，人数少的一方补空沉底
            const tStack = (data.teacher_stats && typeof buildTeacherTypeStack === 'function')
                ? buildTeacherTypeStack(data.teacher_stats) : null;
            const sStack = (data.student_stats && typeof buildStudentTypeStack === 'function')
                ? buildStudentTypeStack(data.student_stats) : null;
            const summarySlots = (typeof computeSummarySlotTarget === 'function')
                ? computeSummarySlotTarget(tStack, sStack)
                : Math.max((tStack && tStack.labels || []).length, (sStack && sStack.labels || []).length);
            if (tStack) {
                renderTeacherTypeStackedChart(tStack, summarySlots);
            }
            if (sStack && typeof renderStudentParticipationChart === 'function') {
                renderStudentParticipationChart(sStack, summarySlots);
            }
        }

    } catch (error) {
        const section = document.getElementById('overview');
        if (!section) return;
        let errorContainer = document.getElementById('overviewStatsError');
        if (!errorContainer) {
            errorContainer = document.createElement('div');
            errorContainer.id = 'overviewStatsError';
            const statsGrid = section.querySelector('.stats-grid');
            if (statsGrid) statsGrid.insertAdjacentElement('beforebegin', errorContainer);
            else section.prepend(errorContainer);
        }
        renderErrorState(errorContainer, {
            error,
            title: '总览数据加载失败',
            detail: null,
            onRetry: () => loadOverviewStats(),
            retryText: '重试',
            compact: true
        });
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
