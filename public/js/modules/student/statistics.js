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
    // 使用深色渐变卡片渲染课程类型统计
    const statsGrid = document.getElementById('teachingTypeStats');
    if (statsGrid) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(statsGrid, ''); } else { statsGrid.innerHTML = ''; }

        const types = Object.keys(data.typeStats);
        if (types.length === 0) {
            const emptyCard = document.createElement('div');
            emptyCard.className = 'type-stat-card';
            emptyCard.style.cssText = 'background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%); border: 1px dashed #cbd5e1;';
            emptyCard.innerHTML = `
                <h3>总学习次数</h3>
                <div class="count-value">0</div>
            `;
            statsGrid.appendChild(emptyCard);
        } else {
            // 深色渐变卡片配色
            const colorMap = {
                '试教': { bg: 'linear-gradient(135deg, #10b981 0%, #059669 100%)', icon: 'auto_stories', shadow: 'rgba(16, 185, 129, 0.2)' },
                '入户': { bg: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)', icon: 'home', shadow: 'rgba(59, 130, 246, 0.2)' },
                '评审': { bg: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)', icon: 'fact_check', shadow: 'rgba(139, 92, 246, 0.2)' },
                '咨询': { bg: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', icon: 'forum', shadow: 'rgba(245, 158, 11, 0.2)' },
                '待确认': { bg: 'linear-gradient(135deg, #64748b 0%, #475569 100%)', icon: 'pending_actions', shadow: 'rgba(100, 116, 139, 0.2)' },
                'default': { bg: 'linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%)', icon: 'stars', shadow: 'rgba(14, 165, 233, 0.2)' }
            };

            types.forEach(type => {
                const count = data.typeStats[type];
                const cardConfig = colorMap[type] || colorMap['default'];
                const card = document.createElement('div');
                card.className = 'type-stat-card premium-card';
                card.style.cssText = `
                    background: ${cardConfig.bg};
                    box-shadow: 0 10px 20px -5px ${cardConfig.shadow};
                    color: white;
                    padding: 24px;
                    border-radius: 16px;
                    position: relative;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                    justify-content: center;
                    align-items: center;
                    min-width: 160px;
                    flex: 1;
                `;
                card.innerHTML = `
                    <span class="material-icons-round" style="position: absolute; right: -10px; bottom: -10px; font-size: 80px; opacity: 0.15; transform: rotate(-15deg); pointer-events: none;">${cardConfig.icon}</span>
                    <h3 style="margin: 0; font-size: 14px; font-weight: 500; opacity: 0.9; text-transform: uppercase; letter-spacing: 0.5px;">${type}</h3>
                    <div class="count-value" style="font-size: 32px; font-weight: 800; margin-top: 8px; text-shadow: 0 2px 4px rgba(0,0,0,0.1);">${count}</div>
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

