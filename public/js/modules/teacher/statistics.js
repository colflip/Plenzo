/**
 * Teacher Teaching Display Section
 * Displays total teaching count within a selected date range
 */
import { generateDateRange } from '../shared/schedule-helpers.js';
import { showTableLoading, hideTableLoading, setButtonLoading } from '../shared/loading-ui.js';
import {
    setupDateRangePickers,
    formatDate,
    getLegendColor,
    ensureChartReady,
    renderConvertedTypeCards,
    renderStatsBreakdown,
    aggregatePersonStats
} from '../shared/stats-view-utils.js';
import { renderErrorState, renderTableErrorRow } from '../shared/error-ui.js';
import { initRewardEasterEgg } from './reward-easter-egg.js';

let currentTeachingData = null;

// 明细接口单页上限 1000（服务端 Math.min(1000, limit)）；分学生折算需要完整数据，
// 不能像以前那样只取前 500 行。多页上限只是防跑飞的保险，正常一个月远到不了。
const DETAIL_PAGE_SIZE = 1000;
const DETAIL_MAX_PAGES = 10;
const INACTIVE_STATUSES = new Set(['cancelled', 'modified_away']);

/**
 * Initialize the statistics section
 */
export async function initStatisticsSection() {
    setupDateRangePickers();
    setupEventListeners();
    initRewardEasterEgg();

    // 汇总与明细互不依赖，各自负责对应区域的错误态。
    await Promise.allSettled([loadTeachingSummary(), loadTeachingCount()]);
}

// setupDateRangePickers / formatDate / getLegendColor 由 shared/stats-view-utils.js 提供

/**
 * Apply date preset
 */
function applyDatePreset(type) {
    const now = new Date();
    let start, end;

    switch (type) {
        case 'last-week': {
            // Find last week's Monday
            const dayOfWeek = now.getDay() || 7; // 1 (Mon) - 7 (Sun)
            const daysToLastMonday = dayOfWeek + 6;
            start = new Date(now);
            start.setDate(now.getDate() - daysToLastMonday);
            end = new Date(start);
            end.setDate(start.getDate() + 6);
            break;
        }
        case 'last-month': {
            start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            end = new Date(now.getFullYear(), now.getMonth(), 0);
            break;
        }
        case 'last-quarter': {
            const currentQuarter = Math.floor(now.getMonth() / 3);
            let targetQuarter = currentQuarter - 1;
            let targetYear = now.getFullYear();

            if (targetQuarter < 0) {
                targetQuarter = 3;
                targetYear -= 1;
            }

            start = new Date(targetYear, targetQuarter * 3, 1);
            end = new Date(targetYear, (targetQuarter + 1) * 3, 0);
            break;
        }
        case 'last-year': {
            start = new Date(now.getFullYear() - 1, 0, 1);
            end = new Date(now.getFullYear() - 1, 11, 31);
            break;
        }
    }

    if (start && end) {
        const startDateInput = document.getElementById('teachingStartDate');
        const endDateInput = document.getElementById('teachingEndDate');
        if (startDateInput) startDateInput.value = formatDate(start);
        if (endDateInput) endDateInput.value = formatDate(end);
    }
}

/**
 * Setup event listeners for buttons
 */
function setupEventListeners() {
    const queryBtn = document.getElementById('teachingQueryBtn');

    if (queryBtn) {
        queryBtn.addEventListener('click', async () => {
            // 按钮加载态：与三端统一的小号 spinner（shared/loading-ui.js）
            setButtonLoading(queryBtn, true, '加载中...');

            try {
                // Load summary immediately to update top cards & chart
                await loadTeachingSummary();

                // Fetch detailed table data in background to stay responsive
                loadTeachingCount();
            } finally {
                setButtonLoading(queryBtn, false);
            }
        });
    }

    // Quick Query Buttons Logic (Delegation or Nodelist)
    let container = document.getElementById('teachingStatsContent') || document;
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

            // Load data: summary awaits to unblock UI, count in background
            await loadTeachingSummary();
            loadTeachingCount();
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

    const exportBtn = document.getElementById('teachingExportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const startDate = document.getElementById('teachingStartDate')?.value;
            const endDate = document.getElementById('teachingEndDate')?.value;
            if (window.ExportDialog) {
                // 统计管理入口只导出本人授课记录，锁定类型避免切到班主任学生数据
                window.ExportDialog.open({
                    startDate,
                    endDate,
                    type: 'teacher_schedule',
                    allowedTypes: ['teacher_schedule']
                });
            }
        });
    }

    // Preset buttons manual styling is handled by DateRangeUtils now, removing conflicting preset logic.
}

/**
 * 拉取完整授课明细（分页取全）。
 * 分学生折算必须基于完整数据；原实现固定 limit=500，超过后分学生数字会少算。
 */
async function fetchAllDetailedSchedules(startDate, endDate) {
    if (!window.apiUtils) {
        throw new Error('API 客户端尚未加载');
    }

    const all = [];
    for (let page = 0; page < DETAIL_MAX_PAGES; page++) {
        const offset = page * DETAIL_PAGE_SIZE;
        const batch = await window.apiUtils.get(
            `/teacher/detailed-schedules?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&limit=${DETAIL_PAGE_SIZE}&offset=${offset}`,
            {},
            { timeoutMs: 20000, suppressErrorToast: true }
        );
        if (!Array.isArray(batch)) {
            throw new Error('授课明细响应格式无效');
        }
        all.push(...batch);
        if (batch.length < DETAIL_PAGE_SIZE) break;
    }
    return all;
}

/** 分学生折算：过滤掉已取消 / 已调整的 pair，与 statistics 接口的活跃 pair 口径一致 */
function buildStudentBreakdown(schedules) {
    return aggregatePersonStats(schedules, {
        nameOf: row => row.student_name,
        typeOf: row => row.schedule_type_cn || row.schedule_type,
        isActive: row => !INACTIVE_STATUSES.has(String(row.status || '').toLowerCase())
    });
}

/**
 * Load teaching data from API (using schedules endpoint for detailed info)
 */
export async function loadTeachingCount() {
    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;

    if (!startDate || !endDate) return;

    // 显示列表加载动画
    const tableCard = document.getElementById('teachingDetailsCard');
    if (tableCard) {
        showTableLoading(tableCard, '正在读取明细数据...', 'thead');
    }

    try {
        const schedules = await fetchAllDetailedSchedules(startDate, endDate);

        currentTeachingData = currentTeachingData || {};
        currentTeachingData.schedules = schedules;
        currentTeachingData.persons = buildStudentBreakdown(schedules);

        renderStatsBreakdown('teachingStatsBreakdown', {
            typeStats: currentTeachingData.typeStats || {},
            persons: currentTeachingData.persons,
            personLabel: '分学生（折算）'
        });

        updateDisplay(currentTeachingData);
    } catch (error) {
        const tbody = document.getElementById('teachingDetailsBody');
        if (tbody) {
            renderTableErrorRow(tbody, {
                colspan: 6,
                error,
                title: '授课明细加载失败',
                detail: null,
                onRetry: () => loadTeachingCount(),
                retryText: '重试'
            });
        }
        // 主卡片与原始计数仍可用，只把分学生区域标成失败，避免误读成「没有学生数据」
        renderStatsBreakdown('teachingStatsBreakdown', {
            typeStats: currentTeachingData?.typeStats || {},
            persons: null,
            personLabel: '分学生（折算）',
            pendingText: '分学生数据加载失败，请重试'
        });
    } finally {
        // 隐藏列表加载动画
        const tableCard = document.getElementById('teachingDetailsCard');
        if (tableCard) {
            hideTableLoading(tableCard);
        }
    }
}

function clearTeachingSummaryErrors() {
    document.getElementById('teachingTypeStatsError')?.remove();
    document.getElementById('dailyTeachingChartError')?.remove();

    const statsGrid = document.getElementById('teachingTypeStats');
    const chartCanvas = document.getElementById('dailyTeachingChart');
    if (statsGrid) statsGrid.hidden = false;
    if (chartCanvas?.parentElement) chartCanvas.parentElement.hidden = false;
}

function renderTeachingSummaryErrors(error) {
    const statsGrid = document.getElementById('teachingTypeStats');
    const typeStatsCard = statsGrid?.closest('.stats-component-card');
    const chartCard = document.getElementById('dailyTeachingChartCard');
    const chartCanvas = document.getElementById('dailyTeachingChart');

    if (statsGrid) statsGrid.hidden = true;
    if (chartCanvas?.parentElement) chartCanvas.parentElement.hidden = true;
    // 汇总失败时下方明细没有可信的原始计数可展示，整块隐藏，避免上一周期的旧数字残留
    const breakdown = document.getElementById('teachingStatsBreakdown');
    if (breakdown) breakdown.hidden = true;

    const regions = [
        {
            parent: typeStatsCard,
            id: 'teachingTypeStatsError',
            title: '授课统计加载失败'
        },
        {
            parent: chartCard,
            id: 'dailyTeachingChartError',
            title: '每日授课统计加载失败'
        }
    ];

    regions.forEach(({ parent, id, title }) => {
        if (!parent) return;
        let container = document.getElementById(id);
        if (!container) {
            container = document.createElement('div');
            container.id = id;
            parent.appendChild(container);
        }
        renderErrorState(container, {
            error,
            title,
            detail: null,
            onRetry: () => loadTeachingSummary(),
            retryText: '重试',
            compact: true
        });
    });
}

/**
 * Load aggregated summary (typeStats + dailyStats) from server - fast
 */
export async function loadTeachingSummary(showLoading = true) {
    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;
    if (!startDate || !endDate) return;

    // 获取统计卡片容器
    const statsContainer = document.getElementById('teaching-display');

    // 1. 先显示表头/内容，确保加载动画能正确探测高度
    // （统计模块的"表头"是已有的卡片结构，无需额外渲染）

    // 2. 显示加载动画
    if (showLoading && statsContainer) {
        const typeStatsCard = statsContainer.querySelector('#teachingTypeStats')?.closest('.stats-component-card');
        const chartCard = document.getElementById('dailyTeachingChartCard');

        if (typeStatsCard) showTableLoading(typeStatsCard, '正在加载统计数据...', null);
        if (chartCard) showTableLoading(chartCard, '正在生成分析图表...', 'h3');
    }

    try {
        if (!window.apiUtils) {
            throw new Error('API 客户端尚未加载');
        }
        const payload = await window.apiUtils.get(
            `/teacher/statistics?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
            {},
            { timeoutMs: 15000, suppressErrorToast: true }
        );
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.typeStats) || !Array.isArray(payload.dailyStats)) {
            throw new Error('授课统计响应格式无效');
        }

        // Convert typeStats array to map-like object for compatibility
        const typeStatsObj = {};
        if (Array.isArray(payload.typeStats)) {
            payload.typeStats.forEach(row => {
                const key = row.type || row.name || '未分类';
                typeStatsObj[key] = Number(row.count) || 0;
            });
        }

        // Update currentTeachingData with available aggregated info
        currentTeachingData = currentTeachingData || {};
        currentTeachingData.typeStats = typeStatsObj;
        currentTeachingData.dailyStats = payload.dailyStats;

        clearTeachingSummaryErrors();

        // Update UI using aggregated data
        await updateDisplayFromAggregates(currentTeachingData);
    } catch (error) {
        if (dailyChartInstance) {
            dailyChartInstance.destroy();
            dailyChartInstance = null;
        }
        renderTeachingSummaryErrors(error);
    } finally {
        // 3. 加载完成后隐藏动画
        if (showLoading && statsContainer) {
            const typeStatsCard = statsContainer.querySelector('#teachingTypeStats')?.closest('.stats-component-card');
            const chartCard = document.getElementById('dailyTeachingChartCard');

            if (typeStatsCard) hideTableLoading(typeStatsCard);
            if (chartCard) hideTableLoading(chartCard);
        }
    }
}

/**
 * Update display using aggregated data (avoids iterating full schedule list)
 */
async function updateDisplayFromAggregates(data) {
    // 主卡片只展示折算后的口径桶；原始类型计数与分学生明细见下方 breakdown
    renderConvertedTypeCards('teachingTypeStats', data.typeStats || {}, {
        emptyTitle: '折算后总授课数'
    });

    renderStatsBreakdown('teachingStatsBreakdown', {
        typeStats: data.typeStats || {},
        persons: data.persons || null,
        personLabel: '分学生（折算）',
        pendingText: '正在统计分学生数据...'
    });

    // dailyStats 是当前查询周期的权威结果；为空时清空图表，不能回退到可能属于上一周期的明细缓存。
    if (data.dailyStats && data.dailyStats.length > 0) {
        // 图表库按需下载，下载失败由调用方 catch 落到区域错误态
        await renderDailyTeachingChart(null, data.dailyStats);
    } else {
        const canvas = document.getElementById('dailyTeachingChart');
        if (canvas && dailyChartInstance) {
            dailyChartInstance.destroy();
            dailyChartInstance = null;
        }
    }

    // Clear or show placeholder in details table until detailed fetch completes
    const tbody = document.getElementById('teachingDetailsBody');
    if (tbody && !data.schedules) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:#64748b; background:#f8fafc; border-radius:8px;">正在飞速加载明细数据...</td></tr>';
    }
}

/**
 * Update the display with detailed rows (table only; cards/breakdown come from the summary + person aggregation)
 */
function updateDisplay(data) {
    // Update details table
    const tbody = document.getElementById('teachingDetailsBody');
    if (tbody) {
        window.SecurityUtils.safeSetHTML(tbody, '');

        if (!data.schedules || data.schedules.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="6" style="text-align: center; padding: 20px; color: #888;">暂无授课记录</td>';
            tbody.appendChild(tr);
            return;
        }

        data.schedules.forEach(schedule => {
            const tr = document.createElement('tr');
            const cells = [
                formatDateDisplay(schedule.date || schedule.lesson_date),
                `${schedule.start_time} - ${schedule.end_time}`,
                schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '--',
                schedule.student_name || '--',
                schedule.location || '--',
                getStatusLabel(schedule.status)
            ].map(c => `<td>${window.SecurityUtils.escapeHtml(c)}</td>`).join('');
            // 使用 innerHTML：safeSetHTML 的 DOMParser 会在 <body> 上下文中解析 <td> 导致结构丢失
            tr.innerHTML = cells;
            tbody.appendChild(tr);
        });
    }
}

let dailyChartInstance = null;

// generateDateRange is imported from ../shared/schedule-helpers.js

/**
 * Render daily teaching chart
 */
async function renderDailyTeachingChart(schedules, dailyStats = null) {
    const canvas = document.getElementById('dailyTeachingChart');
    if (!canvas) return;

    // Destroy existing chart if it exists
    if (dailyChartInstance) {
        dailyChartInstance.destroy();
        dailyChartInstance = null;
    }

    if ((!schedules || schedules.length === 0) && (!dailyStats || dailyStats.length === 0)) {
        return;
    }

    // 无数据可画时不要白下 204KB；有数据则先确保 Chart.js 就绪（首次会触发按需加载）
    await ensureChartReady();

    // Get date range from inputs
    const startDateInput = document.getElementById('teachingStartDate');
    const endDateInput = document.getElementById('teachingEndDate');
    const startDate = startDateInput?.value;
    const endDate = endDateInput?.value;

    if (!startDate || !endDate) {
        return;
    }

    // Generate all dates in range
    const allDates = generateDateRange(startDate, endDate);

    // Group schedules by date and type
    const dailyData = {};
    const allTypes = new Set();

    // Initialize all dates with empty data
    allDates.forEach(date => {
        dailyData[date] = {};
    });

    if (dailyStats && dailyStats.length > 0) {
        dailyStats.forEach(stat => {
            const dateKey = stat.date;
            const type = stat.type || '未分类';
            const count = parseInt(stat.count, 10);
            if (dailyData[dateKey]) {
                dailyData[dateKey][type] = (dailyData[dateKey][type] || 0) + count;
                allTypes.add(type);
            }
        });
    } else if (schedules && schedules.length > 0) {
        schedules.forEach(schedule => {
            const status = (schedule.status || '').toLowerCase();
            if (status === 'cancelled' || status === 'modified_away') return;
            // Normalize date to YYYY-MM-DD
            let dateKey = schedule.date || schedule.lesson_date;
            if (dateKey) {
                // Handle ISO strings or other formats
                try {
                    if (dateKey.includes('T')) {
                        dateKey = dateKey.split('T')[0];
                    } else {
                        // Try to parse and format if it's not already YYYY-MM-DD
                        const d = new Date(dateKey);
                        if (!isNaN(d.getTime())) {
                            const year = d.getFullYear();
                            const month = String(d.getMonth() + 1).padStart(2, '0');
                            const day = String(d.getDate()).padStart(2, '0');
                            dateKey = `${year}-${month}-${day}`;
                        }
                    }
                } catch (e) {
                }
            }

            const type = schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '未分类';

            if (dailyData[dateKey]) {
                if (!dailyData[dateKey][type]) {
                    dailyData[dateKey][type] = 0;
                }
                dailyData[dateKey][type]++;
                allTypes.add(type);
            }
        });
    }

    const types = Array.from(allTypes);

    // Create datasets for each type
    const datasets = types.map((type) => {
        return {
            label: type,
            data: allDates.map(date => dailyData[date][type] || 0),
            backgroundColor: getLegendColor(type),
            borderColor: getLegendColor(type),
            borderWidth: 0,
            borderRadius: 6,
            barPercentage: 0.6,
            categoryPercentage: 0.8
        };
    });

    // Debug logging
    // Debug logging - removed


    // ============================================
    // 响应式配置检测
    // ============================================
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    const isSmallMobile = window.matchMedia('(max-width: 480px)').matches;
    const isTablet = window.matchMedia('(min-width: 769px) and (max-width: 1024px)').matches;

    // Format date labels based on context
    const formatDateLabel = (dateStr, index, allDates) => {
        const current = new Date(dateStr + 'T00:00:00');
        const first = new Date(allDates[0] + 'T00:00:00');
        const last = new Date(allDates[allDates.length - 1] + 'T00:00:00');

        const currentYear = current.getFullYear();
        const currentMonth = current.getMonth();
        const currentDay = current.getDate();

        const firstYear = first.getFullYear();
        const firstMonth = first.getMonth();

        const lastYear = last.getFullYear();
        const lastMonth = last.getMonth();

        // Across years: show year-month-day
        if (firstYear !== lastYear) {
            return `${currentYear}-${currentMonth + 1}-${currentDay}`;
        }

        // Across months: show month-day
        if (firstMonth !== lastMonth) {
            return `${currentMonth + 1}-${currentDay}`;
        }

        // Within same month: show day only
        return `${currentDay}`;
    };

    // Create chart
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
            animation: {
                duration: 800,
                easing: 'easeOutQuart'
            },
            interaction: {
                mode: 'index',
                intersect: false,
            },
            scales: {
                x: {
                    stacked: true,
                    border: { display: false },
                    grid: {
                        display: false
                    },
                    ticks: {
                        font: {
                            family: "'Inter', 'Segoe UI', system-ui, sans-serif",
                            size: isSmallMobile ? 9 : (isMobile ? 10 : 11),
                            weight: '500'
                        },
                        padding: 8,
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
                                    return '#ef4444'; // 红色
                                }
                            }
                            return '#64748b'; // 默认深灰色
                        }
                    }
                },
                y: {
                    stacked: true,
                    beginAtZero: true,
                    border: { display: false },
                    ticks: {
                        stepSize: 1,
                        padding: 12,
                        font: {
                            family: "'Inter', 'Segoe UI', system-ui, sans-serif",
                            size: isSmallMobile ? 9 : (isMobile ? 10 : 11),
                            weight: '500'
                        },
                        color: '#94a3b8'
                    },
                    grid: {
                        color: '#f1f5f9',
                        drawTicks: false,
                        borderDash: [5, 5]
                    }
                }
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        pointStyle: 'circle',
                        boxWidth: isSmallMobile ? 8 : (isMobile ? 10 : 12),
                        boxHeight: isSmallMobile ? 8 : (isMobile ? 10 : 12),
                        padding: isSmallMobile ? 8 : (isMobile ? 10 : 15),
                        font: {
                            size: isSmallMobile ? 10 : (isMobile ? 11 : 12),
                            family: "'Inter', 'Segoe UI', system-ui, sans-serif",
                            weight: '500'
                        },
                        color: '#374151',
                        generateLabels: function (chart) {
                            const datasets = chart.data.datasets;
                            return datasets.map((dataset, i) => ({
                                text: dataset.label,
                                fillStyle: dataset.backgroundColor,
                                strokeStyle: dataset.borderColor,
                                lineWidth: dataset.borderWidth,
                                hidden: !chart.isDatasetVisible(i),
                                index: i,
                                pointStyle: 'circle'
                            }));
                        }
                    },
                    // Responsive legend layout
                    maxHeight: 120,
                    onClick: function (e, legendItem, legend) {
                        const index = legendItem.index;
                        const chart = legend.chart;
                        const meta = chart.getDatasetMeta(index);

                        // Toggle visibility
                        meta.hidden = meta.hidden === null ? !chart.data.datasets[index].hidden : null;
                        chart.update();
                    }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.95)',
                    titleColor: '#f8fafc',
                    bodyColor: '#f8fafc',
                    footerColor: '#cbd5e1',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    borderWidth: 1,
                    padding: 12,
                    cornerRadius: 8,
                    titleFont: {
                        family: "'Inter', sans-serif",
                        size: 13,
                        weight: '600'
                    },
                    bodyFont: {
                        family: "'Inter', sans-serif",
                        size: 12
                    },
                    footerFont: {
                        family: "'Inter', sans-serif",
                        size: 12,
                        weight: 'bold'
                    },
                    displayColors: true,
                    boxPadding: 4,
                    callbacks: {
                        title: function (context) {
                            const dateStr = allDates[context[0].dataIndex];
                            return `${formatDateDisplay(dateStr)}`;
                        },
                        label: function (context) {
                            const label = context.dataset.label || '';
                            const value = context.parsed.y;
                            return `${label}: ${value}次`;
                        },
                        footer: function (context) {
                            let sum = 0;
                            context.forEach(item => {
                                sum += item.parsed.y;
                            });
                            return `总计: ${sum}次`;
                        }
                    }
                }
            },
            // Responsive behavior for different screen sizes
            interaction: {
                mode: 'index',
                intersect: false
            }
        }
    });
}

/**
 * Get status label in Chinese
 */
function getStatusLabel(status) {
    const statusMap = {
        'confirmed': '已确认',
        'pending': '待确认',
        'completed': '已完成',
        'cancelled': '已取消',
        'modified_away': '已调整'
    };
    return statusMap[status] || status || '未知';
}

/**
 * Format date for display (YYYY年MM月DD日)
 */
function formatDateDisplay(dateStr) {
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${year}年${month}月${day}日`;
}

