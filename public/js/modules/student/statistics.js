/**
 * Student Statistics Module
 * Displays total learning count within a selected date range
 */

import { API_ENDPOINTS, STATUS_LABELS, SCHEDULE_TYPE_MAP, getScheduleTypeLabel } from './constants.js';
import { formatDateDisplay, handleApiError, showToast } from './utils.js';

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
            const originalHTML = queryBtn.innerHTML;
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(queryBtn, '<span class="material-icons-round rotate">hourglass_empty</span><span>加载中...</span>'); } else { queryBtn.innerHTML = '<span class="material-icons-round rotate">hourglass_empty</span><span>加载中...</span>'; }

            try {
                if (typeof loadLearningStats === 'function') await loadLearningStats();
            } finally {
                queryBtn.disabled = false;
                if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(queryBtn, originalHTML); } else { queryBtn.innerHTML = originalHTML; }
            }
        });
    }

    const exportBtn = document.getElementById('teachingExportBtn');
    if (exportBtn) {
        // 统一样式为翠绿色
        exportBtn.style.backgroundColor = '#10b981';
        exportBtn.style.color = '#ffffff';

        exportBtn.replaceWith(exportBtn.cloneNode(true)); // Remove old listeners
        const newExportBtn = document.getElementById('teachingExportBtn');
        newExportBtn.addEventListener('click', exportLearningData);
    }

    // Quick Query Buttons Logic
    let container = document.getElementById('learningStatsContent') || document;
    const presetBtns = container.querySelectorAll('.preset-btn');
    presetBtns.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const preset = e.target.dataset.range || e.target.dataset.preset;
            if (!window.DateRangeUtils) return;
            const range = window.DateRangeUtils.computeRange(preset);
            if (!range) return;

            const startDateInput = document.getElementById('teachingStartDate');
            const endDateInput = document.getElementById('teachingEndDate');
            if (startDateInput) startDateInput.value = range.start;
            if (endDateInput) endDateInput.value = range.end;

            // Trigger Highlight Sync
            window.DateRangeUtils.syncPresetButtons(range.start, range.end, container);

            // Trigger Query
            if (typeof loadLearningStats === 'function') await loadLearningStats();
        });
    });

    const startDateInput = document.getElementById('teachingStartDate');
    const endDateInput = document.getElementById('teachingEndDate');
    if (startDateInput && endDateInput) {
        const sync = () => {
            if (window.DateRangeUtils && window.DateRangeUtils.syncPresetButtons) {
                window.DateRangeUtils.syncPresetButtons(startDateInput.value, endDateInput.value, container);
            }
        };
        startDateInput.addEventListener('change', sync);
        endDateInput.addEventListener('change', sync);
        // 初次同步
        sync();
    }
}

/**
 * Load learning data from API (Optimized: Use statistics endpoint)
 */
export async function loadLearningStats() {
    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;

    if (!startDate || !endDate) {
        return;
    }

    try {
        // 使用 AbortController 设置超时
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        const response = await fetch(
            `${API_ENDPOINTS.STATISTICS}?startDate=${startDate}&endDate=${endDate}`,
            {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('token')}`
                },
                signal: controller.signal
            }
        );
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error('获取学习统计失败');
        }

        const data = await response.json();

        // 转换 typeStats 数组为对象
        const statsObj = {};
        if (Array.isArray(data.typeStats)) {
            data.typeStats.forEach(item => {
                statsObj[item.type] = item.count;
            });
        }

        currentLearningData = {
            schedules: data.schedules || [],
            typeStats: statsObj,
            monthlyStats: data.monthlyStats || []
        };

        // 第一阶段：立即渲染卡片和图表（轻量级）
        updateDisplay(currentLearningData);

        // 第二阶段：延迟渲染详情表格（避免阻塞 UI）
        requestAnimationFrame(() => {
            renderDetailsTable(currentLearningData.schedules);
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            console.warn('加载统计超时');
        } else {
            console.error('加载统计失败:', error);
        }
        handleApiError(error, '加载学习统计失败');
        updateDisplay({ schedules: [], typeStats: {} });
    }
}

/**
 * Update the display with learning stats and detailed table
 */
function updateDisplay(data) {
    // 使用与教师端一致的淡色渐变卡片样式
    const statsGrid = document.getElementById('teachingTypeStats');
    if (statsGrid) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(statsGrid, ''); } else { statsGrid.innerHTML = ''; }

        const uiColors = [
            { bg: 'linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%)', text: '#0369a1', icon: 'school' },
            { bg: 'linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)', text: '#15803d', icon: 'check_circle' },
            { bg: 'linear-gradient(135deg, #fef08a 0%, #fde047 100%)', text: '#a16207', icon: 'star' },
            { bg: 'linear-gradient(135deg, #fce7f3 0%, #fbcfe8 100%)', text: '#be185d', icon: 'favorite' },
            { bg: 'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%)', text: '#4338ca', icon: 'assessment' },
            { bg: 'linear-gradient(135deg, #ffedd5 0%, #fed7aa 100%)', text: '#c2410c', icon: 'emoji_events' }
        ];

        const types = Object.keys(data.typeStats);
        if (types.length === 0) {
            const emptyCard = document.createElement('div');
            emptyCard.className = 'stat-card';
            emptyCard.style.background = 'linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%)';
            emptyCard.style.border = 'none';
            emptyCard.style.position = 'relative';
            emptyCard.style.overflow = 'hidden';
            emptyCard.style.display = 'flex';
            emptyCard.style.flexDirection = 'column';
            emptyCard.style.justifyContent = 'center';
            emptyCard.style.minHeight = '120px';
            emptyCard.innerHTML = `
                <div style="position: absolute; right: 10px; opacity: 0.1; transform: scale(3) translate(-10%, 10%);">
                    <span class="material-icons-round" style="color: #64748b;">sentiment_dissatisfied</span>
                </div>
                <div style="position: relative; z-index: 1;">
                    <h3 style="color: #475569; opacity: 0.9; margin-bottom: 8px; font-weight: 600; font-size: 15px;">总学习次数</h3>
                    <div class="count-value" style="color: #475569; font-size: 32px; font-weight: 700;">0</div>
                </div>
            `;
            statsGrid.appendChild(emptyCard);
        } else {
            types.forEach((type, index) => {
                const count = data.typeStats[type];
                const colorConfig = uiColors[index % uiColors.length];
                const card = document.createElement('div');
                card.className = 'stat-card scale-hover';
                card.style.background = colorConfig.bg;
                card.style.border = 'none';
                card.style.position = 'relative';
                card.style.overflow = 'hidden';
                card.style.display = 'flex';
                card.style.flexDirection = 'column';
                card.style.justifyContent = 'center';
                card.style.minHeight = '120px';

                card.innerHTML = `
                    <div style="position: absolute; right: 10px; top: 10px; opacity: 0.15; transform: scale(3.5) translate(-15%, 15%); pointer-events: none;">
                        <span class="material-icons-round" style="color: ${colorConfig.text};">${colorConfig.icon}</span>
                    </div>
                    <div style="position: relative; z-index: 1;">
                        <h3 style="color: ${colorConfig.text}; opacity: 0.95; margin-bottom: 8px; font-weight: 600; font-size: 15px;">${type}</h3>
                        <p style="color: ${colorConfig.text}; margin: 0; font-size: 32px; font-weight: 700; line-height: 1;">${count}</p>
                    </div>
                `;
                statsGrid.appendChild(card);
            });
        }
    }

    // Render daily chart
    renderDailyLearningChart(data.schedules);
}

/**
 * 渲染详情表格（独立函数，支持延迟渲染）
 */
function renderDetailsTable(schedules) {
    const tbody = document.getElementById('teachingDetailsBody');
    if (!tbody) return;

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }

    if (!schedules || schedules.length === 0) {
        const tr = document.createElement('tr');
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tr, '<td colspan="6" style="text-align: center; padding: 20px; color: #888;">暂无学习记录</td>'); } else { tr.innerHTML = '<td colspan="6" style="text-align: center; padding: 20px; color: #888;">暂无学习记录</td>'; }
        tbody.appendChild(tr);
        return;
    }

    // 使用 DocumentFragment 批量插入，减少重排
    const fragment = document.createDocumentFragment();
    schedules.forEach(schedule => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${formatDateDisplay(schedule.date || schedule.lesson_date)}</td>
            <td>${schedule.start_time} - ${schedule.end_time}</td>
            <td>${getScheduleTypeLabel(schedule.schedule_type)}</td>
            <td>${schedule.teacher_name || '--'}</td>
            <td>${schedule.location || '--'}</td>
            <td>${STATUS_LABELS[schedule.status] || schedule.status}</td>
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

/**
 * Get color for course type
 */
function getLegendColor(name) {
    if (window.ColorUtils && window.ColorUtils.getLegendColor) {
        return window.ColorUtils.getLegendColor(name);
    }
    // Fallback if not loaded
    const hash = Array.from(String(name || '')).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const fallbackPalette = ['#3366CC', '#FF9933', '#33CC99', '#DC3912', '#7C4DFF'];
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

        const type = getScheduleTypeLabel(schedule.schedule_type);

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
        showToast('请先选择日期范围', 'error');
        return;
    }

    const originalText = exportBtn ? exportBtn.innerHTML : '导出数据';
    if (exportBtn) {
        exportBtn.disabled = true;
        if (window.SecurityUtils) {
            window.SecurityUtils.safeSetHTML(exportBtn, '<span class="material-icons-round rotate">hourglass_empty</span><span>导出中...</span>');
        } else {
            exportBtn.innerHTML = '<span class="material-icons-round rotate">hourglass_empty</span><span>导出中...</span>';
        }
    }

    try {
        // 获取汇总数据 JSON (高级导出流程)
        const response = await fetch(`${API_ENDPOINTS.DATA_SUMMARY}?startDate=${startDate}&endDate=${endDate}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });

        if (!response.ok) {
            const errorJson = await response.json().catch(() => ({}));
            throw new Error(errorJson.message || errorJson.error || '导出失败');
        }

        const rawData = await response.json();

        if (window.ExportManager && rawData) {
            const EXPORT_TYPES = { TEACHER_SCHEDULE: 'teacher_schedule', STUDENT_SCHEDULE: 'student_schedule' };
            const state = {
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                selectedType: EXPORT_TYPES.STUDENT_SCHEDULE
            };

            const studentName = document.getElementById('studentName')?.textContent || '学生';
            const timestamp = new Date().getTime();
            const fileName = `我的学习记录[${studentName}][${startDate}至${endDate}]_${timestamp}.xlsx`;

            // 调用多 Sheet 转换逻辑 (由 export-manager.js 内部根据 student 角色处理后续)
            const transformedData = window.ExportManager.transformExportData(
                rawData,
                null,
                '全部老师',
                'student',
                state,
                EXPORT_TYPES
            );
            await window.ExportManager.generateExcelFile(transformedData, fileName);
            showToast('导出成功', 'success');
        } else {
            throw new Error('导出组件未加载或返回数据异常');
        }

    } catch (error) {
        console.error('Export Error:', error);
        showToast('导出失败: ' + error.message, 'error');
    } finally {
        if (exportBtn) {
            if (window.SecurityUtils) {
                window.SecurityUtils.safeSetHTML(exportBtn, originalText);
            } else {
                exportBtn.innerHTML = originalText;
            }
            exportBtn.disabled = false;
        }
    }
}

