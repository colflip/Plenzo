/**
 * Teacher Teaching Display Section
 * Displays total teaching count within a selected date range
 */

let currentTeachingData = null;

/**
 * Initialize the statistics section
 */
export async function initStatisticsSection() {
    setupDateRangePickers();
    setupEventListeners();

    try {
        // Parallel load for better performance
        // Start with summary for immediate feedback
        const summaryPromise = loadTeachingSummary();
        const detailedPromise = loadTeachingCount();

        await Promise.allSettled([summaryPromise, detailedPromise]);
    } catch (error) {
        console.error('[Teaching Display] Failed to auto-load data:', error);
        updateDisplay({ schedules: [], typeStats: {} }, '', '');
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
            // Show loading state
            queryBtn.disabled = true;
            const originalText = queryBtn.textContent;
            queryBtn.textContent = '加载中...';

            try {
                // Use the same loading function as auto-load for consistency
                await loadTeachingCount();
            } finally {
                queryBtn.disabled = false;
                queryBtn.textContent = originalText;
            }
        });
    }

    // Quick Query Buttons Logic (Delegation or Nodelist)
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

    const exportBtn = document.getElementById('teachingExportBtn');
    if (exportBtn) {
        exportBtn.addEventListener('click', async () => {
            const startDate = document.getElementById('teachingStartDate')?.value;
            const endDate = document.getElementById('teachingEndDate')?.value;

            if (!startDate || !endDate) {
                alert('请先选择日期范围');
                return;
            }

            const originalText = exportBtn.innerHTML;
            exportBtn.innerHTML = '导出中...';
            exportBtn.disabled = true;

            try {
                const response = await fetch(`/api/teacher/export?startDate=${startDate}&endDate=${endDate}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${localStorage.getItem('token')}` // Ensure token is passed if needed, though cookie usually handles it. 
                        // If token is in header:
                        // 'Authorization': `Bearer ${localStorage.getItem('token')}`
                    }
                });

                if (!response.ok) {
                    const errorJson = await response.json().catch(() => ({}));
                    throw new Error(errorJson.message || errorJson.error || '导出失败');
                }

                // Get filename from header or default
                const disposition = response.headers.get('Content-Disposition');
                let filename = 'export.xlsx';
                if (disposition && disposition.indexOf('attachment') !== -1) {
                    const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition);
                    if (matches != null && matches[1]) {
                        filename = decodeURIComponent(matches[1].replace(/['"]/g, ''));
                    }
                }

                const blob = await response.blob();
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
                exportBtn.innerHTML = originalText;
                exportBtn.disabled = false;
            }
        });
    }

    // Preset Buttons Logic
    const presets = [
        { id: 'btnLastWeek', type: 'last-week' },
        { id: 'btnLastMonth', type: 'last-month' },
        { id: 'btnLastQuarter', type: 'last-quarter' },
        { id: 'btnLastYear', type: 'last-year' }
    ];
    presets.forEach(preset => {
        const btn = document.getElementById(preset.id);
        if (btn) {
            btn.addEventListener('click', async () => {
                // Reset all buttons to default color
                presets.forEach(p => {
                    const b = document.getElementById(p.id);
                    if (b) b.style.backgroundColor = '#64748b'; // Default slate color
                });
                // Set active button to green
                btn.style.backgroundColor = '#10b981'; // Green for active state

                applyDatePreset(preset.type);
                // Trigger query
                const queryBtn = document.getElementById('teachingQueryBtn');
                if (queryBtn) queryBtn.click();
            });
        }
    });
}

/**
 * Load teaching data from API (using schedules endpoint for detailed info)
 */
export async function loadTeachingCount() {
    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;

    if (!startDate || !endDate) {
        console.error('请选择日期范围');
        return;
    }

    try {
        const token = localStorage.getItem('token');
        // Use detailed schedules endpoint to get list of classes
        // fallback: fetch detailed schedules when explicitly requested
        const response = await fetch(
            `/api/teacher/detailed-schedules?startDate=${startDate}&endDate=${endDate}&limit=500`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        if (!response.ok) {
            throw new Error('获取授课数据失败');
        }

        const data = await response.json();
        // data is an array of schedule objects
        let schedules = Array.isArray(data) ? data : [];

        // Filter out cancelled courses - they should not be included in statistics
        schedules = schedules.filter(schedule => {
            const status = (schedule.status || '').toLowerCase();
            return status !== 'cancelled';
        });

        // Calculate stats by type
        const typeStats = {};
        schedules.forEach(schedule => {
            // Use Chinese description if available, otherwise fallback to name or '其他'
            const type = schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '其他';
            typeStats[type] = (typeStats[type] || 0) + 1;
        });

        currentTeachingData = {
            schedules: schedules,
            typeStats: typeStats
        };

        updateDisplay(currentTeachingData, startDate, endDate);
    } catch (error) {
        console.error('加载授课数据失败:', error);
        updateDisplay({ schedules: [], typeStats: {} }, startDate, endDate);
    }
}

/**
 * Load aggregated summary (typeStats + dailyStats) from server - fast
 */
export async function loadTeachingSummary() {
    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;
    if (!startDate || !endDate) return;

    try {
        const token = localStorage.getItem('token');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout for summary

        const res = await fetch(`/api/teacher/statistics?startDate=${startDate}&endDate=${endDate}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();

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
        currentTeachingData.dailyStats = Array.isArray(payload.dailyStats) ? payload.dailyStats : [];

        // Update UI using aggregated data
        updateDisplayFromAggregates(currentTeachingData, startDate, endDate);
    } catch (err) {
        if (err.name === 'AbortError') {
        } else {
            console.error('[Teaching Summary] Error:', err);
        }
    }
}

/**
 * Update display using aggregated data (avoids iterating full schedule list)
 */
function updateDisplayFromAggregates(data, startDate, endDate) {
    // Update type stats
    const statsGrid = document.getElementById('teachingTypeStats');
    if (statsGrid) {
        statsGrid.innerHTML = '';
        const types = Object.keys(data.typeStats || {});
        if (types.length === 0) {
            statsGrid.innerHTML = `
                <div class="type-stat-card">
                    <h3>总授课数</h3>
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

    // Render chart from dailyStats or schedules
    // Always use the full renderDailyTeachingChart for consistency
    // It will handle the full date range properly
    if (data.schedules && data.schedules.length > 0) {
        renderDailyTeachingChart(data.schedules);
    } else {
        // If only aggregated data available, clear the chart
        const canvas = document.getElementById('dailyTeachingChart');
        if (canvas && dailyChartInstance) {
            dailyChartInstance.destroy();
            dailyChartInstance = null;
        }
    }

    // Clear or show placeholder in details table until detailed fetch completes
    const tbody = document.getElementById('teachingDetailsBody');
    if (tbody) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:20px; color:#888;">正在加载明细（如需完整明细，请点击 查询）</td></tr>';
    }
}

/**
 * Fetch detailed schedules in background (non-blocking). If `replaceImmediately` is true,
 * update the details table when data returns.
 */
async function fetchDetailedSchedulesBackground(replaceImmediately = false) {
    try {
        const startDate = document.getElementById('teachingStartDate')?.value;
        const endDate = document.getElementById('teachingEndDate')?.value;
        if (!startDate || !endDate) return;

        const token = localStorage.getItem('token');

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); // 20s timeout

        const res = await fetch(`/api/teacher/detailed-schedules?startDate=${startDate}&endDate=${endDate}&limit=500`, {
            headers: { 'Authorization': `Bearer ${token}` },
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            return;
        }

        const rows = await res.json();

        // Filter out cancelled courses - they should not be included in statistics
        let schedules = Array.isArray(rows) ? rows : [];
        schedules = schedules.filter(schedule => {
            const status = (schedule.status || '').toLowerCase();
            return status !== 'cancelled';
        });

        currentTeachingData = currentTeachingData || {};
        currentTeachingData.schedules = schedules;

        if (replaceImmediately) {
            updateDisplay(currentTeachingData, startDate, endDate);
        }
    } catch (e) {
        if (e.name === 'AbortError') {
        } else {
        }
    }
}

/**
 * Update the display with teaching stats and detailed table
 */
function updateDisplay(data, startDate, endDate) {
    // Update type stats grid
    const statsGrid = document.getElementById('teachingTypeStats');
    if (statsGrid) {
        statsGrid.innerHTML = '';

        const types = Object.keys(data.typeStats);
        if (types.length === 0) {
            statsGrid.innerHTML = `
                <div class="type-stat-card">
                    <h3>总授课数</h3>
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

    // Render daily teaching chart
    renderDailyTeachingChart(data.schedules);

    // Update details table
    const tbody = document.getElementById('teachingDetailsBody');
    if (tbody) {
        tbody.innerHTML = '';

        if (!data.schedules || data.schedules.length === 0) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="6" style="text-align: center; padding: 20px; color: #888;">暂无授课记录</td>';
            tbody.appendChild(tr);
            return;
        }

        data.schedules.forEach(schedule => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${formatDateDisplay(schedule.date || schedule.lesson_date)}</td>
                <td>${schedule.start_time} - ${schedule.end_time}</td>
                <td>${schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '--'}</td>
                <td>${schedule.student_name || '--'}</td>
                <td>${schedule.location || '--'}</td>
                <td>${getStatusLabel(schedule.status)}</td>
            `;
            tbody.appendChild(tr);
        });
    }
}

let dailyChartInstance = null;

/**
 * Get color for teaching type (matches admin dashboard with comprehensive type coverage)
 * Uses a carefully selected palette for maximum visual differentiation
 */
function getLegendColor(name) {
    // Primary color mapping - matches admin dashboard exactly
    const LEGEND_COLOR_MAP = {
        // Core teaching types
        '入户': '#3366CC',           // Blue - primary teaching type
        '试教': '#FF9933',           // Orange - trial lessons
        '评审': '#7C4DFF',           // Purple - evaluations
        '评审记录': '#B39DDB',       // Light purple - evaluation records
        '心理咨询': '#33CC99',       // Teal - counseling
        '线上辅导': '#0099C6',       // Cyan - online tutoring
        '线下辅导': '#5C6BC0',       // Indigo - offline tutoring
        '集体活动': '#DC3912',       // Red - group activities
        '半次入户': '#4E79A7',       // Steel blue - half visit
        '家访': '#8E8CD8',           // Lavender - home visit

        // Extended types for comprehensive coverage
        '正式课': '#1976D2',         // Deep blue
        '体验课': '#FFA726',         // Amber
        '补课': '#66BB6A',           // Green
        '测评': '#AB47BC',           // Deep purple
        '家长会': '#EF5350',         // Light red
        '培训': '#26A69A',           // Teal green
        '观摩': '#5C6BC0',           // Blue grey
        '研讨': '#8D6E63',           // Brown
        '其他': '#78909C',           // Grey blue
        '未分类': '#9E9E9E'          // Grey - fallback
    };

    const key = String(name || '').trim();

    // Direct match
    if (key && LEGEND_COLOR_MAP[key]) {
        return LEGEND_COLOR_MAP[key];
    }

    // Partial match for flexibility (e.g., "入户课程" matches "入户")
    for (const [typeKey, color] of Object.entries(LEGEND_COLOR_MAP)) {
        if (key.includes(typeKey) || typeKey.includes(key)) {
            return color;
        }
    }

    // Fallback: generate consistent color from hash
    // Using a curated palette for better visual distinction
    const hash = Array.from(key).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const fallbackPalette = [
        '#3366CC', '#FF9933', '#33CC99', '#DC3912', '#7C4DFF',
        '#0099C6', '#5C6BC0', '#66AA00', '#E91E63', '#00ACC1',
        '#8BC34A', '#FF5722', '#9C27B0', '#FF6F00', '#00897B'
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
 * Render daily teaching chart
 */
function renderDailyTeachingChart(schedules) {
    const canvas = document.getElementById('dailyTeachingChart');
    if (!canvas) return;

    // Destroy existing chart if it exists
    if (dailyChartInstance) {
        dailyChartInstance.destroy();
        dailyChartInstance = null;
    }

    if (!schedules || schedules.length === 0) {
        return;
    }

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

    schedules.forEach(schedule => {
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

    const types = Array.from(allTypes);

    // Create datasets for each type
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
            scales: {
                x: {
                    stacked: true,
                    grid: {
                        display: false
                    },
                    ticks: {
                        font: {
                            size: isSmallMobile ? 9 : (isMobile ? 10 : 11)
                        },
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
                    ticks: {
                        stepSize: 1,
                        font: {
                            size: isSmallMobile ? 9 : (isMobile ? 10 : 11)
                        }
                    },
                    grid: {
                        color: 'rgba(55,65,81,0.08)'
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
                    mode: 'index',
                    intersect: false,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    titleColor: '#fff',
                    bodyColor: '#fff',
                    borderColor: 'rgba(255, 255, 255, 0.2)',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: true,
                    callbacks: {
                        title: function (context) {
                            const dateStr = allDates[context[0].dataIndex];
                            return `日期: ${formatDateDisplay(dateStr)}`;
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
                mode: 'nearest',
                axis: 'x',
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
        'cancelled': '已取消'
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

/**
 * Export teaching data to CSV
 */
function exportTeachingData() {
    if (!currentTeachingData || !currentTeachingData.schedules || currentTeachingData.schedules.length === 0) {
        alert('没有可导出的数据');
        return;
    }

    const headers = ['日期', '时间段', '课程类型', '学生姓名', '上课地点', '状态'];
    const rows = currentTeachingData.schedules.map(schedule => [
        formatDateDisplay(schedule.date || schedule.lesson_date),
        `${schedule.start_time} - ${schedule.end_time}`,
        schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '--',
        schedule.student_name || '--',
        schedule.location || '--',
        getStatusLabel(schedule.status)
    ]);

    const csvContent = [
        headers.join(','),
        ...rows.map(row => row.join(','))
    ].join('\n');

    const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);

    link.setAttribute('href', url);
    link.setAttribute('download', `授课记录_${formatDate(new Date())}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
