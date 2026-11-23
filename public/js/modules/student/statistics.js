/**
 * Student Statistics Module
 * Displays total learning count within a selected date range
 */
import { generateDateRange } from '../shared/schedule-helpers.js';
import { setButtonLoading, showTableLoading, hideTableLoading } from '../shared/loading-ui.js';
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

import { API_ENDPOINTS, STATUS_LABELS, getScheduleTypeLabel } from './constants.js';
import { formatDateDisplay } from './utils.js';

// Chart.js 由 /js/utils/load-chart.js 按需注入到 window，模块求值时还不能解构到局部变量，
// 否则会永久持有 undefined。渲染前统一 await ensureChartReady()，用 window.Chart 调用。

let currentLearningData = null;
let dailyChartInstance = null;

function clearChartError() {
    const chartCard = document.getElementById('dailyTeachingChartCard');
    const canvas = document.getElementById('dailyTeachingChart');
    document.getElementById('dailyTeachingChartError')?.remove();
    if (canvas?.parentElement) canvas.parentElement.hidden = false;
    if (chartCard) chartCard.removeAttribute('aria-busy');
}

function renderChartError(error) {
    const chartCard = document.getElementById('dailyTeachingChartCard');
    const canvas = document.getElementById('dailyTeachingChart');
    if (!chartCard || !canvas?.parentElement) return;

    canvas.parentElement.hidden = true;
    let errorContainer = document.getElementById('dailyTeachingChartError');
    if (!errorContainer) {
        errorContainer = document.createElement('div');
        errorContainer.id = 'dailyTeachingChartError';
        chartCard.appendChild(errorContainer);
    }
    renderErrorState(errorContainer, {
        error,
        title: '学习趋势加载失败',
        detail: null,
        onRetry: () => loadLearningStats(),
        retryText: '重试',
        compact: true
    });
}

/**
 * Initialize the statistics section
 */
export async function initStatisticsSection() {
    setupDateRangePickers();
    setupEventListeners();

    // Auto-load data when section is initialized
    await loadLearningStats();
}

// setupDateRangePickers / formatDate / getLegendColor 由 shared/stats-view-utils.js 提供

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
            // 按钮加载态：与三端统一的小号 spinner（shared/loading-ui.js）
            setButtonLoading(queryBtn, true, '加载中...');

            try {
                if (typeof loadLearningStats === 'function') await loadLearningStats();
            } finally {
                setButtonLoading(queryBtn, false);
            }
        });
    }

    const exportBtn = document.getElementById('teachingExportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            const startDate = document.getElementById('teachingStartDate')?.value;
            const endDate = document.getElementById('teachingEndDate')?.value;
            if (window.ExportDialog) {
                window.ExportDialog.open({ startDate, endDate });
            }
        });
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

    // 统一加载视觉：与管理端排课管理同款遮罩（shared/loading-ui.js）
    const typeStatsCard = document.getElementById('typeStatsCard');
    const chartCard = document.getElementById('dailyTeachingChartCard');
    const detailsCard = document.getElementById('teachingDetailsCard');
    if (typeStatsCard) showTableLoading(typeStatsCard, '正在加载统计数据...', null);
    if (chartCard) showTableLoading(chartCard, '正在生成分析图表...', 'h3');
    if (detailsCard) showTableLoading(detailsCard, '正在读取明细数据...', 'thead');

    try {
        const data = await window.apiUtils.get(
            `${API_ENDPOINTS.STATISTICS}?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`,
            {},
            { timeoutMs: 15000, suppressErrorToast: true }
        );

        if (!data || typeof data !== 'object' || Array.isArray(data) ||
            !Array.isArray(data.typeStats) ||
            !Array.isArray(data.schedules) ||
            !Array.isArray(data.monthlyStats) ||
            data.typeStats.some(item => !item || typeof item !== 'object' ||
                typeof item.type !== 'string' || !item.type.trim() ||
                !Number.isFinite(Number(item.count)) || Number(item.count) < 0)) {
            throw new Error('学习统计响应格式无效');
        }

        // 转换 typeStats 数组为对象
        const statsObj = {};
        data.typeStats.forEach(item => {
            statsObj[item.type] = Number(item.count);
        });

        currentLearningData = {
            schedules: data.schedules,
            typeStats: statsObj,
            monthlyStats: data.monthlyStats
        };

        clearChartError();

        // 第一阶段：立即渲染卡片和图表（轻量级）
        await updateDisplay(currentLearningData);

        // 第二阶段：延迟渲染详情表格（避免阻塞 UI）
        requestAnimationFrame(() => {
            renderDetailsTable(currentLearningData.schedules);
        });
    } catch (error) {
        currentLearningData = null;
        if (dailyChartInstance) {
            dailyChartInstance.destroy();
            dailyChartInstance = null;
        }
        if (typeStatsCard) {
            const statsGrid = document.getElementById('teachingTypeStats');
            if (statsGrid) {
                renderErrorState(statsGrid, {
                    error,
                    title: '学习统计加载失败',
                    detail: null,
                    onRetry: () => loadLearningStats(),
                    retryText: '重试',
                    compact: true
                });
            }
        }
        // 失败时不要保留上一周期的折算明细
        const breakdown = document.getElementById('teachingStatsBreakdown');
        if (breakdown) {
            breakdown.textContent = '';
            breakdown.hidden = true;
        }
        if (chartCard) {
            renderChartError(error);
        }
        const tbody = document.getElementById('teachingDetailsBody');
        if (tbody) {
            renderTableErrorRow(tbody, {
                colspan: 6,
                error,
                title: '学习明细加载失败',
                detail: null,
                onRetry: () => loadLearningStats(),
                retryText: '重试'
            });
        }
    } finally {
        if (typeStatsCard) hideTableLoading(typeStatsCard);
        if (chartCard) hideTableLoading(chartCard);
        if (detailsCard) hideTableLoading(detailsCard);
    }
}

/**
 * Update the display with learning stats and detailed table
 */
async function updateDisplay(data) {
    // 主卡片只展示折算后的口径桶；原始类型计数与分老师明细见下方 breakdown
    renderConvertedTypeCards('teachingTypeStats', data.typeStats, {
        emptyTitle: '折算后总上课数'
    });

    const persons = aggregatePersonStats(data.schedules, {
        nameOf: row => row.teacher_name,
        typeOf: row => row.schedule_type_cn || row.schedule_type
    });

    renderStatsBreakdown('teachingStatsBreakdown', {
        typeStats: data.typeStats,
        persons,
        personLabel: '分老师（折算）'
    });

    // Render daily chart（图表库按需下载，失败由调用方 catch 落到区域错误态）
    await renderDailyLearningChart(data.schedules);
}

/**
 * 渲染详情表格（独立函数，支持延迟渲染）
 */
function renderDetailsTable(schedules) {
    const tbody = document.getElementById('teachingDetailsBody');
    if (!tbody) return;

    window.SecurityUtils.safeSetHTML(tbody, '');

    if (!schedules || schedules.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="6" style="text-align: center; padding: 20px; color: #888;">暂无学习记录</td>';
        tbody.appendChild(tr);
        return;
    }

    // 使用 DocumentFragment 批量插入，减少重排
    const fragment = document.createDocumentFragment();
    schedules.forEach(schedule => {
        const tr = document.createElement('tr');
        const trHtml = `
            <td>${formatDateDisplay(schedule.date || schedule.lesson_date)}</td>
            <td>${schedule.start_time} - ${schedule.end_time}</td>
            <td>${getScheduleTypeLabel(schedule.schedule_type)}</td>
            <td>${schedule.teacher_name || '--'}</td>
            <td>${schedule.location || '--'}</td>
            <td>${STATUS_LABELS[schedule.status] || schedule.status}</td>
        `;
        // 使用 innerHTML：safeSetHTML 的 DOMParser 会在 <body> 上下文中解析 <td> 导致结构丢失
        tr.innerHTML = trHtml;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

// generateDateRange is imported from ../shared/schedule-helpers.js

/**
 * Render daily learning chart
 */
async function renderDailyLearningChart(schedules) {
    const canvas = document.getElementById('dailyTeachingChart');
    if (!canvas) return;

    if (dailyChartInstance) {
        dailyChartInstance.destroy();
        dailyChartInstance = null;
    }

    if (!schedules || schedules.length === 0) return;

    // 无数据可画时不白下 204KB；有数据则先确保 Chart.js 就绪（首次会触发按需加载）
    await ensureChartReady();

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
    dailyChartInstance = new window.Chart(ctx, {
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



