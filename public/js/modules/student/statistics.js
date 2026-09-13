/**
 * Student Statistics Module
 * Displays total learning count within a selected date range
 */
import { generateDateRange } from '../shared/schedule-helpers.js';
import { setButtonLoading, showTableLoading, hideTableLoading } from '../shared/loading-ui.js';
import { setupDateRangePickers, formatDate, getLegendColor } from '../shared/stats-view-utils.js';
import { renderErrorState, renderTableErrorRow } from '../shared/error-ui.js';

import { API_ENDPOINTS, STATUS_LABELS, getScheduleTypeLabel } from './constants.js';
import { formatDateDisplay } from './utils.js';

// 声明Chart为全局变量（由CDN加载）
const Chart = window.Chart;

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
        updateDisplay(currentLearningData);

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
function updateDisplay(data) {
    // 使用与教师端一致的淡色渐变卡片样式
    const statsGrid = document.getElementById('teachingTypeStats');
    if (statsGrid) {
        window.SecurityUtils.safeSetHTML(statsGrid, '');

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
                    <h3 style="color: #475569; opacity: 0.9; margin-bottom: 8px; font-weight: 600; font-size: var(--fs-300);">总学习次数</h3>
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

                const cardHtml = `
                    <div style="position: absolute; right: 10px; top: 10px; opacity: 0.15; transform: scale(3.5) translate(-15%, 15%); pointer-events: none;">
                        <span class="material-icons-round" style="color: ${colorConfig.text};">${colorConfig.icon}</span>
                    </div>
                    <div style="position: relative; z-index: 1;">
                        <h3 style="color: ${colorConfig.text}; opacity: 0.95; margin-bottom: 8px; font-weight: 600; font-size: var(--fs-300);">${type}</h3>
                        <p style="color: ${colorConfig.text}; margin: 0; font-size: 32px; font-weight: 700; line-height: 1;">${count}</p>
                    </div>
                `;
                if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(card, cardHtml);
                else card.innerHTML = cardHtml;
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



