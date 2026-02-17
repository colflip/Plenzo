/**
 * Student Statistics Module
 * Displays total learning count within a selected date range
 */

import { API_ENDPOINTS, STATUS_LABELS, SCHEDULE_TYPE_MAP } from './constants.js';
import { formatDateDisplay, handleApiError } from './utils.js';

// 声明Chart为全局变量（由CDN加载）
const Chart = window.Chart;

let currentLearningData = null;
let dailyChartInstance = null;

/**
 * Initialize the statistics section
 */
export async function initStatisticsSection() {
    setupDateRangePickers();
    setupEventListeners();

    // Auto-load data when section is initialized

    try {
        await loadLearningStats();
    } catch (error) {
        console.error('[Statistics] Failed to auto-load data:', error);
        updateDisplay({ schedules: [], typeStats: {} });
    }
}

/**
 * Setup date range pickers with default values (current month)
 */
function setupDateRangePickers() {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const startDateInput = document.getElementById('teachingStartDate');
    const endDateInput = document.getElementById('teachingEndDate');

    if (startDateInput) {
        startDateInput.value = formatDate(firstDay);
    }
    if (endDateInput) {
        endDateInput.value = formatDate(lastDay);
    }
}

/**
 * Format date to YYYY-MM-DD
 */
function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Setup event listeners for buttons
 */
/**
 * Setup event listeners for buttons
 */
function setupEventListeners() {
    const queryBtn = document.getElementById('teachingQueryBtn');

    if (queryBtn) {
        queryBtn.addEventListener('click', async () => {
            // Show loading state
            queryBtn.disabled = true;
            const originalText = queryBtn.textContent;
            queryBtn.textContent = '加载中...';

            try {
                await loadLearningStats();
            } finally {
                queryBtn.disabled = false;
                queryBtn.textContent = originalText;
            }
        });
    }

    const exportBtn = document.getElementById('teachingExportBtn');
    if (exportBtn) {
        exportBtn.replaceWith(exportBtn.cloneNode(true)); // Remove old listeners
        const newExportBtn = document.getElementById('teachingExportBtn');
        newExportBtn.addEventListener('click', exportLearningData);
    }

    // Quick Query Buttons Logic
    const presetBtns = document.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            // UI Feedback
            presetBtns.forEach(b => {
                b.style.backgroundColor = 'white';
                b.style.color = '#333';
            });
            e.target.style.backgroundColor = '#dcfce7';
            e.target.style.color = '#15803d';

            const range = e.target.dataset.range;
            const today = new Date();
            let start = new Date();
            let end = new Date(); // End is always today

            switch (range) {
                case 'today':
                    start = new Date(today);
                    end = new Date(today);
                    break;
                case 'yesterday':
                    start = new Date(today);
                    start.setDate(today.getDate() - 1);
                    end = new Date(start);
                    break;
                case 'this_week':
                    // 本周 (Current ISO Week: Monday to Sunday)
                    const dayThis = today.getDay();
                    const diffToMonThis = today.getDate() - dayThis + (dayThis === 0 ? -6 : 1);
                    const thisMon = new Date(today);
                    thisMon.setDate(diffToMonThis);
                    const thisSun = new Date(thisMon);
                    thisSun.setDate(thisMon.getDate() + 6);
                    start = thisMon;
                    end = thisSun;
                    break;
                case 'prev_week':
                    // 上周 (Last full week: Monday to Sunday)
                    const day = today.getDay();
                    const diffToMon = today.getDate() - day + (day === 0 ? -6 : 1);
                    const lastSun = new Date(today);
                    lastSun.setDate(diffToMon - 1);
                    const lastMon = new Date(today);
                    lastMon.setDate(diffToMon - 7);
                    start = lastMon;
                    end = lastSun;
                    break;
                case 'this_month':
                    start = new Date(today.getFullYear(), today.getMonth(), 1);
                    end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
                    break;
                case 'prev_month':
                    // 上月 (Last full Month)
                    start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
                    end = new Date(today.getFullYear(), today.getMonth(), 0);
                    break;
                case 'this_quarter':
                    const currQ = Math.floor((today.getMonth() + 3) / 3);
                    start = new Date(today.getFullYear(), (currQ - 1) * 3, 1);
                    end = new Date(today.getFullYear(), currQ * 3, 0);
                    break;
                case 'prev_quarter':
                    // 上季度 (Last full Quarter)
                    const currentQuarter = Math.floor((today.getMonth() + 3) / 3);
                    const lastQuarter = currentQuarter - 1;
                    if (lastQuarter === 0) { // Was Q1, so now Q4 of last year
                        start = new Date(today.getFullYear() - 1, 9, 1);
                        end = new Date(today.getFullYear() - 1, 12, 0);
                    } else {
                        start = new Date(today.getFullYear(), (lastQuarter - 1) * 3, 1);
                        end = new Date(today.getFullYear(), lastQuarter * 3, 0);
                    }
                    break;
                case 'this_year':
                    start = new Date(today.getFullYear(), 0, 1);
                    end = new Date(today.getFullYear(), 11, 31);
                    break;
                case 'prev_year':
                    // 去年 (Last full Year)
                    start = new Date(today.getFullYear() - 1, 0, 1);
                    end = new Date(today.getFullYear() - 1, 11, 31);
                    break;
            }

            // Set inputs
            const startDateInput = document.getElementById('teachingStartDate');
            const endDateInput = document.getElementById('teachingEndDate');

            if (startDateInput && endDateInput) {
                // Ensure date objects are valid before formatting
                if (!isNaN(start) && !isNaN(end)) {
                    startDateInput.value = formatDate(start);
                    endDateInput.value = formatDate(end);

                    // Trigger Query
                    if (queryBtn) queryBtn.click();
                }
            }
        });
    });
}

/**
 * Load learning data from API
 */
export async function loadLearningStats() {
    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;

    if (!startDate || !endDate) {
        console.error('请选择日期范围');
        return;
    }

    try {
        // Use schedules endpoint to get detailed data
        const response = await fetch(
            `${API_ENDPOINTS.SCHEDULES}?startDate=${startDate}&endDate=${endDate}`,
            {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                }
            }
        );

        if (!response.ok) {
            throw new Error('获取学习数据失败');
        }

        const data = await response.json();
        let schedules = Array.isArray(data) ? data : [];

        // Filter out cancelled courses
        schedules = schedules.filter(schedule => {
            const status = (schedule.status || '').toLowerCase();
            return status !== 'cancelled';
        });

        // Calculate stats by type
        const typeStats = {};
        schedules.forEach(schedule => {
            const typeCode = schedule.schedule_type || '';
            const type = schedule.schedule_type_cn || SCHEDULE_TYPE_MAP[typeCode] || typeCode || '其他';
            typeStats[type] = (typeStats[type] || 0) + 1;
        });

        currentLearningData = {
            schedules: schedules,
            typeStats: typeStats
        };

        updateDisplay(currentLearningData);
    } catch (error) {
        console.error('加载学习数据失败:', error);
        handleApiError(error, '加载学习统计失败');
        updateDisplay({ schedules: [], typeStats: {} });
    }
}

/**
 * Update the display with learning stats and detailed table
 */
function updateDisplay(data) {
    // Update type stats grid
    const statsGrid = document.getElementById('teachingTypeStats');
    if (statsGrid) {
        statsGrid.innerHTML = '';

        const types = Object.keys(data.typeStats);
        if (types.length === 0) {
            statsGrid.innerHTML = `
                <div class="type-stat-card">
                    <h3>总课程数</h3>
                    <div class="count-value">0</div>
                </div>
            `;
        } else {
            types.forEach(type => {
                const count = data.typeStats[type];
                const card = document.createElement('div');
                card.className = 'stat-card';
                card.innerHTML = `
                    <h3>${type}</h3>
                    <p>${count}</p>
                `;
                statsGrid.appendChild(card);
            });
        }
    }

    // Render daily chart
    renderDailyLearningChart(data.schedules);

    // Update details table
    const tbody = document.getElementById('teachingDetailsBody');
    if (tbody) {
        tbody.innerHTML = '';

        if (!data.schedules || data.schedules.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="6" style="text-align: center; padding: 20px; color: #888;">暂无学习记录</td>';
            tbody.appendChild(tr);
            return;
        }

        data.schedules.forEach(schedule => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDateDisplay(schedule.date || schedule.lesson_date)}</td>
                <td>${schedule.start_time} - ${schedule.end_time}</td>
                <td>${schedule.schedule_type_cn || SCHEDULE_TYPE_MAP[schedule.schedule_type] || schedule.schedule_type || '--'}</td>
                <td>${schedule.teacher_name || '--'}</td>
                <td>${schedule.location || '--'}</td>
                <td>${STATUS_LABELS[schedule.status] || schedule.status}</td>
            `;
            tbody.appendChild(tr);
        });
    }
}

/**
 * Get color for course type
 */
function getLegendColor(name) {
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
        '其他': '#78909C',
        '未分类': '#9E9E9E'
    };

    const key = String(name || '').trim();
    if (key && LEGEND_COLOR_MAP[key]) {
        return LEGEND_COLOR_MAP[key];
    }

    for (const [typeKey, color] of Object.entries(LEGEND_COLOR_MAP)) {
        if (key.includes(typeKey) || typeKey.includes(key)) {
            return color;
        }
    }

    const hash = Array.from(key).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const fallbackPalette = [
        '#3366CC', '#FF9933', '#33CC99', '#DC3912', '#7C4DFF',
        '#0099C6', '#5C6BC0', '#66AA00', '#E91E63', '#00ACC1'
    ];
    return fallbackPalette[hash % fallbackPalette.length];
}

/**
 * Generate all dates in range
 */
function generateDateRange(startDate, endDate) {
    const dates = [];
    const current = new Date(startDate);
    const end = new Date(endDate);

    while (current <= end) {
        dates.push(current.toISOString().split('T')[0]);
        current.setDate(current.getDate() + 1);
    }
    return dates;
}

/**
 * Render daily learning chart
 */
function renderDailyLearningChart(schedules) {
    const canvas = document.getElementById('dailyTeachingChart');
    if (!canvas) return;

    if (dailyChartInstance) {
        dailyChartInstance.destroy();
        dailyChartInstance = null;
    }

    if (!schedules || schedules.length === 0) return;

    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;

    if (!startDate || !endDate) return;

    const allDates = generateDateRange(startDate, endDate);
    const dailyData = {};
    const allTypes = new Set();

    allDates.forEach(date => {
        dailyData[date] = {};
    });

    schedules.forEach(schedule => {
        let dateKey = schedule.date || schedule.lesson_date;
        if (dateKey) {
            try {
                if (dateKey.includes('T')) {
                    dateKey = dateKey.split('T')[0];
                } else {
                    const d = new Date(dateKey);
                    if (!isNaN(d.getTime())) {
                        dateKey = formatDate(d);
                    }
                }
            } catch (e) {
            }
        }

        const typeCode = schedule.schedule_type || '';
        const type = schedule.schedule_type_cn || SCHEDULE_TYPE_MAP[typeCode] || typeCode || '未分类';

        if (dailyData[dateKey]) {
            if (!dailyData[dateKey][type]) {
                dailyData[dateKey][type] = 0;
            }
            dailyData[dateKey][type]++;
            allTypes.add(type);
        }
    });

    const types = Array.from(allTypes);
    const datasets = types.map((type) => {
        return {
            label: type,
            data: allDates.map(date => dailyData[date][type] || 0),
            backgroundColor: getLegendColor(type),
            borderColor: getLegendColor(type),
            borderWidth: 0,
            borderRadius: 4
        };
    });

    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    const isSmallMobile = window.matchMedia('(max-width: 480px)').matches;

    const formatDateLabel = (dateStr, index, allDates) => {
        const current = new Date(dateStr + 'T00:00:00');
        const first = new Date(allDates[0] + 'T00:00:00');
        const last = new Date(allDates[allDates.length - 1] + 'T00:00:00');

        if (first.getFullYear() !== last.getFullYear()) {
            return `${current.getFullYear()}-${current.getMonth() + 1}-${current.getDate()}`;
        }
        if (first.getMonth() !== last.getMonth()) {
            return `${current.getMonth() + 1}-${current.getDate()}`;
        }
        return `${current.getDate()}`;
    };

    const ctx = canvas.getContext('2d');
    dailyChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: allDates.map((date, index) => formatDateLabel(date, index, allDates)),
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    stacked: true,
                    grid: { display: false },
                    ticks: {
                        font: { size: isSmallMobile ? 9 : (isMobile ? 10 : 11) },
                        maxRotation: isMobile ? 45 : 0,
                        minRotation: isMobile ? 45 : 0,
                        autoSkip: true,
                        maxTicksLimit: isSmallMobile ? 7 : (isMobile ? 10 : 15),
                        color: function (context) {
                            // 获取完整日期字符串
                            const dateStr = allDates[context.index];
                            if (dateStr) {
                                const date = new Date(dateStr + 'T00:00:00');
                                const day = date.getDay();
                                // 周六(6)或周日(0)显示红色
                                if (day === 0 || day === 6) {
                                    return '#DC2626'; // 红色
                                }
                            }
                            return '#374151'; // 默认深灰色
                        }
                    }
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    ticks: { stepSize: 1, font: { size: isSmallMobile ? 9 : (isMobile ? 10 : 11) } },
                    grid: { color: 'rgba(55,65,81,0.08)' }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 10,
                        padding: 15,
                        font: { size: 11 }
                    }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        title: (context) => {
                            const dateStr = allDates[context[0].dataIndex];
                            return `日期: ${formatDateDisplay(dateStr)}`;
                        },
                        label: (context) => `${context.dataset.label}: ${context.parsed.y}次`,
                        footer: (context) => {
                            let sum = 0;
                            context.forEach(item => sum += item.parsed.y);
                            return `总计: ${sum}次`;
                        }
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}

/**
 * Export learning data via Independent Service (Direct Download)
 */
async function exportLearningData() {
    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;
    const exportBtn = document.getElementById('teachingExportBtn');

    if (!startDate || !endDate) {
        alert('请先选择日期范围');
        return;
    }

    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.innerHTML = '<span class="material-icons-round spinner" style="font-size:18px; margin-right:4px; animation:spin 1s linear infinite;">sync</span> 导出中...';
    }

    try {
        const response = await fetch(`/api/student/export?startDate=${startDate}&endDate=${endDate}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || '导出失败');
        }

        // Check Content-Type
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            const error = await response.json();
            throw new Error(error.message || '导出虽成功但在返回JSON: ' + JSON.stringify(error));
        }

        // Get Filename from headers
        const disposition = response.headers.get('Content-Disposition');
        let filename = `学习记录_${startDate}_${endDate}.xlsx`; // Fallback

        // Try to get student name from UI for better fallback
        const studentName = document.querySelector('.user-info .name')?.textContent?.trim() || '';
        if (studentName) {
            filename = `[${studentName}]${filename}`;
        }

        if (disposition && disposition.indexOf('attachment') !== -1) {
            // Regex to capture filename="encoded_string"
            const matches = /filename="([^"]*)"/.exec(disposition);
            if (matches != null && matches[1]) {
                filename = decodeURIComponent(matches[1]);
            }
        }

        const blob = await response.blob();

        if (blob.size < 100) {
            // Suspiciously small, might be an error text
            const text = await blob.text();
            // Don't throw yet, let user try to open it, or alert?
        }

        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

    } catch (error) {
        console.error('Export failed:', error);
        alert('导出失败: ' + error.message);
    } finally {
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.innerHTML = '<span class="material-icons-round" style="font-size:18px; margin-right:4px;">download</span> 导出';
        }
    }
}

