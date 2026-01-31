/**
 * Student Data Summary Module
 */

import { API_ENDPOINTS, STATUS_LABELS } from './constants.js';
import { formatDate, formatDateDisplay, showToast, handleApiError } from './utils.js';

let currentSummaryData = null;

/**
 * Initialize data summary section
 */
export async function initDataSummarySection() {

    // Set default date range (last 30 days)
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    const startInput = document.getElementById('summaryStartDate');
    const endInput = document.getElementById('summaryEndDate');

    if (startInput) startInput.value = formatDate(startDate);
    if (endInput) endInput.value = formatDate(endDate);

    // Set up event listeners
    const queryBtn = document.getElementById('summaryQueryBtn');
    const exportBtn = document.getElementById('summaryExportBtn');

    if (queryBtn) queryBtn.addEventListener('click', loadDataSummary);
    if (exportBtn) exportBtn.addEventListener('click', exportSummaryData);

    // Load initial data
    await loadDataSummary();
}

/**
 * Load data summary
 */
export async function loadDataSummary() {
    const startInput = document.getElementById('summaryStartDate');
    const endInput = document.getElementById('summaryEndDate');

    if (!startInput || !endInput) return;

    const startDate = startInput.value;
    const endDate = endInput.value;

    if (!startDate || !endDate) {
        showToast('请选择日期范围', 'error');
        return;
    }

    try {
        const response = await fetch(
            `${API_ENDPOINTS.DATA_SUMMARY}?startDate=${startDate}&endDate=${endDate}`,
            {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
            }
        );

        if (!response.ok) {
            throw new Error('获取数据汇总失败');
        }

        const data = await response.json();
        currentSummaryData = {
            schedules: Array.isArray(data) ? data : [],
            startDate,
            endDate
        };

        updateSummaryDisplay();
    } catch (error) {
        handleApiError(error, '加载数据汇总失败');
    }
}

/**
 * Update summary display
 */
function updateSummaryDisplay() {
    if (!currentSummaryData) return;

    const schedules = currentSummaryData.schedules;

    // Calculate type statistics
    const typeStats = {};
    schedules.forEach(schedule => {
        const type = schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '其他';
        typeStats[type] = (typeStats[type] || 0) + 1;
    });

    // Update type stats grid
    updateTypeStatsGrid(typeStats);

    // Update details table
    updateDetailsTable(schedules);
}

/**
 * Update type stats grid
 */
function updateTypeStatsGrid(typeStats) {
    const grid = document.getElementById('summaryTypeStats');
    if (!grid) return;

    grid.innerHTML = '';

    const types = Object.keys(typeStats);
    if (types.length === 0) {
        grid.innerHTML = `
            <div class="type-stat-card">
                <h3>总课程数</h3>
                <div class="count-value">0</div>
            </div>
        `;
        return;
    }

    types.forEach(type => {
        const count = typeStats[type];
        const card = document.createElement('div');
        card.className = 'type-stat-card';
        card.innerHTML = `
            <h3>${type}</h3>
            <div class="count-value">${count}</div>
        `;
        grid.appendChild(card);
    });
}

/**
 * Update details table
 */
function updateDetailsTable(schedules) {
    const tbody = document.getElementById('summaryDetailsBody');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (schedules.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 20px;">暂无课程记录</td></tr>';
        return;
    }

    schedules.forEach(schedule => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateDisplay(schedule.date || schedule.lesson_date)}</td>
            <td>${schedule.start_time} - ${schedule.end_time}</td>
            <td>${schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '--'}</td>
            <td>${schedule.teacher_name || '--'}</td>
            <td>${schedule.location || '--'}</td>
            <td>${STATUS_LABELS[schedule.status] || schedule.status || '未知'}</td>
        `;
        tbody.appendChild(tr);
    });
}

/**
 * Export summary data
 */
function exportSummaryData() {
    if (!currentSummaryData || !currentSummaryData.schedules || currentSummaryData.schedules.length === 0) {
        showToast('没有可导出的数据', 'error');
        return;
    }

    const headers = ['日期', '时间段', '课程类型', '教师姓名', '上课地点', '状态'];
    const rows = currentSummaryData.schedules.map(schedule => [
        formatDateDisplay(schedule.date || schedule.lesson_date),
        `${schedule.start_time} - ${schedule.end_time}`,
        schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '--',
        schedule.teacher_name || '--',
        schedule.location || '--',
        STATUS_LABELS[schedule.status] || schedule.status || '未知'
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);

    link.setAttribute('href', url);
    link.setAttribute('download', `课程记录_${formatDate(new Date())}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    showToast('数据导出成功', 'success');
}
