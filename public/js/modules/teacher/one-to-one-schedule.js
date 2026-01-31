// 1对1课程安排模块 - 排课信息卡片组件

/**
 * 格式化日期为标准格式
 * @param {string|Date} date - 日期对象或日期字符串
 * @returns {string} 格式化后的日期字符串 (YYYY-MM-DD)
 */
function formatDate(date) {
    if (!date) return '';
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 格式化时间为标准格式
 * @param {string} time - 时间字符串
 * @returns {string} 格式化后的时间字符串 (HH:MM)
 */
function formatTime(time) {
    if (!time) return '';
    // 确保是字符串
    const timeStr = String(time);
    // 如果已经是 HH:MM 格式，直接返回
    if (/^\d{2}:\d{2}$/.test(timeStr)) {
        return timeStr;
    }
    // 处理可能的其他格式
    return timeStr;
}

/**
 * 获取状态对应的文本
 * @param {string} status - 课程状态
 * @returns {string} 状态文本
 */
function getStatusText(status) {
    const statusMap = {
        'pending': '待确认',
        'confirmed': '已确认',
        'completed': '已完成',
        'cancelled': '已取消'
    };
    return statusMap[status] || status;
}

/**
 * 创建1对1课程安排卡片
 * @param {Object} schedule - 课程安排数据
 * @param {boolean} showActions - 是否显示操作按钮
 * @returns {string} HTML字符串
 */
function createOneToOneScheduleCard(schedule, showActions = true) {
    if (!schedule) return '';
    
    // 构建卡片内容
    const timeSlotHtml = schedule.start_time ? 
        `<div class="item-time">${formatTime(schedule.start_time)} - ${formatTime(schedule.end_time || schedule.start_time)}</div>` : '';
    
    const studentName = schedule.student_name ? 
        `<div class="item-student">${schedule.student_name}</div>` : '';
    
    const type = schedule.schedule_type ? 
        `<div class="item-type">${schedule.schedule_type}</div>` : '';
    
    const location = schedule.location ? 
        `<div class="item-location"><i class="material-icons-round">location_on</i>${schedule.location}</div>` : '';
    
    const status = schedule.status ? 
        `<div class="item-status">${getStatusText(schedule.status)}</div>` : '';
    
    // 构建操作按钮
    let actions = '';
    if (showActions) {
        const pending = (schedule.status === 'pending' || (!schedule.teacher_confirmed && schedule.status !== 'cancelled'));
        if (pending) {
            actions = `
                <div class="item-actions">
                    <button class="confirm-btn btn-small" data-id="${schedule.id}">确认</button>
                    <button class="reject-btn btn-small" data-id="${schedule.id}">拒绝</button>
                </div>`;
        }
    }
    
    // 返回完整的卡片HTML
    return `
        <div class="schedule-card ${schedule.status} card-shadow">
            <div class="card-header">
                ${timeSlotHtml}
                ${status}
            </div>
            <div class="card-body">
                ${studentName}
                ${type}
                ${location}
            </div>
            ${actions}
        </div>`;
}

/**
 * 渲染1对1课程安排列表
 * @param {Array} schedules - 课程安排数据数组
 * @param {HTMLElement} container - 容器元素
 * @param {boolean} showActions - 是否显示操作按钮
 */
function renderOneToOneSchedules(schedules, container, showActions = true) {
    if (!container) return;
    
    if (!schedules || schedules.length === 0) {
        container.innerHTML = '<div class="no-schedule">暂无1对1课程安排</div>';
        return;
    }
    
    // 按时间排序课程
    const sortedSchedules = [...schedules].sort((a, b) => {
        const dateA = new Date(`${a.date || ''} ${a.start_time || ''}`);
        const dateB = new Date(`${b.date || ''} ${b.start_time || ''}`);
        return dateA - dateB;
    });
    
    // 渲染卡片列表
    container.innerHTML = sortedSchedules.map(schedule => 
        createOneToOneScheduleCard(schedule, showActions)
    ).join('');
    
    // 设置事件监听器
    setupOneToOneScheduleCardListeners(container);
}

/**
 * 设置1对1课程卡片的事件监听器
 * @param {HTMLElement} container - 容器元素
 */
function setupOneToOneScheduleCardListeners(container) {
    // 委托事件处理
    container.addEventListener('click', (e) => {
        const confirmBtn = e.target.closest('.confirm-btn');
        const rejectBtn = e.target.closest('.reject-btn');
        
        if (confirmBtn) {
            const id = Number(confirmBtn.dataset.id);
            confirmOneToOneSchedule(id, true);
        } else if (rejectBtn) {
            const id = Number(rejectBtn.dataset.id);
            confirmOneToOneSchedule(id, false);
        }
    });
}

/**
 * 确认1对1课程
 * @param {number} scheduleId - 课程ID
 * @param {boolean} isConfirmed - 是否确认
 */
async function confirmOneToOneSchedule(scheduleId, isConfirmed) {
    try {
        // 显示加载状态
        const buttons = document.querySelectorAll(
            `.confirm-btn[data-id="${scheduleId}"], .reject-btn[data-id="${scheduleId}"]`
        );
        buttons.forEach(btn => {
            btn.disabled = true;
            btn.textContent = '处理中...';
        });
        
        // 获取拒绝原因（如果拒绝）
        const notes = isConfirmed ? '' : prompt('请输入拒绝原因');
        if (!isConfirmed && !notes) {
            // 恢复按钮状态
            buttons.forEach(btn => {
                btn.disabled = false;
                btn.textContent = btn.classList.contains('confirm-btn') ? '确认' : '拒绝';
            });
            alert('请输入拒绝原因');
            return;
        }
        
        // 发送确认请求
        await window.apiUtils.post(`/teacher/schedules/${scheduleId}/confirm`, {
            teacherConfirmed: isConfirmed,
            notes
        });
        
        // 显示成功提示
        alert(isConfirmed ? '课程已确认' : '课程已拒绝');
        
        // 重新加载课程数据
        loadOneToOneSchedules();
    } catch (error) {
        console.error('确认课程错误:', error);
        alert(error.message || '操作失败，请重试');
        
        // 恢复按钮状态
        const buttons = document.querySelectorAll(
            `.confirm-btn[data-id="${scheduleId}"], .reject-btn[data-id="${scheduleId}"]`
        );
        buttons.forEach(btn => {
            btn.disabled = false;
            btn.textContent = btn.classList.contains('confirm-btn') ? '确认' : '拒绝';
        });
    }
}

/**
 * 加载1对1课程安排数据
 * @param {Date} baseDate - 基准日期
 */
async function loadOneToOneSchedules(baseDate = new Date()) {
    try {
        // 显示加载中状态
        const container = document.getElementById('oneToOneSchedulesContainer');
        if (container) {
            container.innerHTML = '<div class="loading">加载中...</div>';
        }
        
        // 计算日期范围（本周）
        const dayOfWeek = baseDate.getDay() || 7; // 将周日从0转换为7
        const startOfWeek = new Date(baseDate);
        startOfWeek.setDate(baseDate.getDate() - dayOfWeek + 1); // 设置为本周周一
        
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6); // 设置为本周周日
        
        // 请求数据
        const response = await window.apiUtils.get('/teacher/schedules', {
            startDate: formatDate(startOfWeek),
            endDate: formatDate(endOfWeek),
            type: 'one-to-one' // 假设API支持按类型筛选
        });
        
        const schedules = response || [];
        
        // 渲染课程列表
        if (container) {
            renderOneToOneSchedules(schedules, container);
        }
    } catch (error) {
        console.error('加载1对1课程安排错误:', error);
        const container = document.getElementById('oneToOneSchedulesContainer');
        if (container) {
            container.innerHTML = '<div class="error-message">加载失败，请刷新页面重试</div>';
        }
    }
}

/**
 * 初始化1对1课程安排模块
 */
function initOneToOneScheduleModule() {
    // 导出方法到全局，以便在其他地方调用
    window.OneToOneSchedule = {
        renderSchedules: renderOneToOneSchedules,
        loadSchedules: loadOneToOneSchedules,
        createCard: createOneToOneScheduleCard
    };
    
    // 页面加载完成后自动加载数据
    document.addEventListener('DOMContentLoaded', () => {
        if (document.getElementById('oneToOneSchedulesContainer')) {
            loadOneToOneSchedules();
        }
    });
}

// 初始化模块
initOneToOneScheduleModule();