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
        await loadTeachingSummary();

        // Load details in background without blocking
        loadTeachingCount();
    } catch (error) {
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
                // Load summary immediately to update top cards & chart
                await loadTeachingSummary();

                // Fetch detailed table data in background to stay responsive
                loadTeachingCount();
            } finally {
                queryBtn.disabled = false;
                queryBtn.textContent = originalText;
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
        exportBtn.addEventListener('click', async () => {
            const startDate = document.getElementById('teachingStartDate')?.value;
            const endDate = document.getElementById('teachingEndDate')?.value;

            if (!startDate || !endDate) {
                alert('请先选择日期范围');
                return;
            }

            const originalText = exportBtn.innerHTML;
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(exportBtn, '<span class="material-icons-round rotate">hourglass_empty</span><span>导出中...</span>'); } else { exportBtn.innerHTML = '<span class="material-icons-round rotate">hourglass_empty</span><span>导出中...</span>'; }
            exportBtn.disabled = true;

            try {
                const response = await fetch(`/api/teacher/export-advanced?startDate=${startDate}&endDate=${endDate}`, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${localStorage.getItem('token')}`
                    }
                });

                if (!response.ok) {
                    const errorJson = await response.json().catch(() => ({}));
                    throw new Error(errorJson.message || errorJson.error || '导出失败');
                }

                const result = await response.json();
                if (!result.success || !result.data) {
                    throw new Error(result.message || '获取导出数据失败');
                }

                // 借助通用 ExportManager 输出 Excel
                if (window.ExportManager && result.data && result.data.data) {
                    const EXPORT_TYPES = { TEACHER_SCHEDULE: 'teacher_schedule', STUDENT_SCHEDULE: 'student_schedule' };
                    const state = {
                        startDate: new Date(startDate),
                        endDate: new Date(endDate),
                        selectedType: EXPORT_TYPES.TEACHER_SCHEDULE
                    };
                    const teacherName = document.getElementById('teacherName')?.textContent || '教师';
                    const timestamp = new Date().getTime();
                    const fileName = `我的授课记录[${teacherName}][${startDate}至${endDate}]_${timestamp}.xlsx`;

                    const transformedData = window.ExportManager.transformExportData(
                        result.data.data,
                        null,
                        '全部学生',
                        'teacher',
                        state,
                        EXPORT_TYPES
                    );
                    await window.ExportManager.generateExcelFile(transformedData, fileName);
                    if (window.Toast) { window.Toast.show('导出成功', 'success'); } else { alert('导出成功'); }
                } else {
                    throw new Error('导出组件未加载或返回数据异常');
                }

            } catch (error) {
                console.error('Export Error:', error);
                if (window.Toast) { window.Toast.show('导出失败: ' + error.message, 'error'); } else { alert('导出失败: ' + error.message); }
            } finally {
                if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(exportBtn, originalText); } else { exportBtn.innerHTML = originalText; }
                exportBtn.disabled = false;
            }
        });
    }

    // Preset buttons manual styling is handled by DateRangeUtils now, removing conflicting preset logic.
}

/**
 * Load teaching data from API (using schedules endpoint for detailed info)
 */
export async function loadTeachingCount() {
    const startDate = document.getElementById('teachingStartDate')?.value;
    const endDate = document.getElementById('teachingEndDate')?.value;

    if (!startDate || !endDate) {

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

        // Preserve typeStats and dailyStats from the summary fetch if available
        currentTeachingData = currentTeachingData || {};
        currentTeachingData.schedules = schedules;

        // If typeStats empty, calculate it minimally from schedules for fallback
        if (!currentTeachingData.typeStats || Object.keys(currentTeachingData.typeStats).length === 0) {
            const typeStats = {};
            schedules.forEach(schedule => {
                const type = schedule.schedule_type_cn || schedule.schedule_type || schedule.course_type || '其他';
                typeStats[type] = (typeStats[type] || 0) + 1;
            });
            currentTeachingData.typeStats = typeStats;
        }

        updateDisplay(currentTeachingData, startDate, endDate);
    } catch (error) {

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

        }
    }
}

/**
 * Update display using aggregated data (avoids iterating full schedule list)
 */
function updateDisplayFromAggregates(data, startDate, endDate) {
    // 使用淡色渐变卡片渲染课程类型统计
    const statsGrid = document.getElementById('teachingTypeStats');
    if (statsGrid) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(statsGrid, ''); } else { statsGrid.innerHTML = ''; }
        const types = Object.keys(data.typeStats || {});
        if (types.length === 0) {
            statsGrid.innerHTML = `
                <div class="stat-card" style="background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%); border: none; position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: center; min-height: 120px;">
                    <div style="position: absolute; right: 10px; opacity: 0.1; transform: scale(3) translate(-10%, 10%);">
                        <span class="material-icons-round" style="color: #64748b;">sentiment_dissatisfied</span>
                    </div>
                    <div style="position: relative; z-index: 1;">
                        <h3 style="color: #475569; opacity: 0.9; margin-bottom: 8px; font-weight: 600; font-size: 15px;">总授课数</h3>
                        <div class="count-value" style="color: #475569; font-size: 32px; font-weight: 700;">0</div>
                    </div>
                </div>
            `;
        } else {
            const uiColors = [
                { bg: 'linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%)', text: '#0369a1', icon: 'school' },
                { bg: 'linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)', text: '#15803d', icon: 'check_circle' },
                { bg: 'linear-gradient(135deg, #fef08a 0%, #fde047 100%)', text: '#a16207', icon: 'star' },
                { bg: 'linear-gradient(135deg, #fce7f3 0%, #fbcfe8 100%)', text: '#be185d', icon: 'favorite' },
                { bg: 'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%)', text: '#4338ca', icon: 'assessment' },
                { bg: 'linear-gradient(135deg, #ffedd5 0%, #fed7aa 100%)', text: '#c2410c', icon: 'emoji_events' }
            ];

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

    // Render chart from dailyStats or schedules
    // Always use the full renderDailyTeachingChart for consistency
    // It will handle the full date range properly
    // Render chart from dailyStats
    if (data.dailyStats && data.dailyStats.length > 0) {
        renderDailyTeachingChart(data.schedules, data.dailyStats);
    } else if (data.schedules && data.schedules.length > 0) {
        renderDailyTeachingChart(data.schedules, null);
    } else {
        // If only aggregated data available, clear the chart
        const canvas = document.getElementById('dailyTeachingChart');
        if (canvas && dailyChartInstance) {
            dailyChartInstance.destroy();
            dailyChartInstance = null;
        }
    }

    // Mark summary as rendered so detailed fetch doesn't overwrite it
    data.summaryRendered = true;

    // Clear or show placeholder in details table until detailed fetch completes
    const tbody = document.getElementById('teachingDetailsBody');
    if (tbody && !data.schedules) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, '<tr><td colspan="6" style="text-align:center; padding:30px; color:#64748b; background:#f8fafc; border-radius:8px;">正在飞速加载明细数据...</td></tr>'); } else { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:30px; color:#64748b; background:#f8fafc; border-radius:8px;">正在飞速加载明细数据...</td></tr>'; }
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
    if (!data.summaryRendered) {
        // 回退：使用淡色渐变卡片渲染
        const statsGrid = document.getElementById('teachingTypeStats');
        if (statsGrid) {
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(statsGrid, ''); } else { statsGrid.innerHTML = ''; }

            const types = Object.keys(data.typeStats || {});
            if (types.length === 0) {
                statsGrid.innerHTML = `
                    <div class="stat-card" style="background: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%); border: none; position: relative; overflow: hidden; display: flex; flex-direction: column; justify-content: center; min-height: 120px;">
                        <div style="position: absolute; right: 10px; opacity: 0.1; transform: scale(3) translate(-10%, 10%);">
                            <span class="material-icons-round" style="color: #64748b;">sentiment_dissatisfied</span>
                        </div>
                        <div style="position: relative; z-index: 1;">
                            <h3 style="color: #475569; opacity: 0.9; margin-bottom: 8px; font-weight: 600; font-size: 15px;">总授课数</h3>
                            <div class="count-value" style="color: #475569; font-size: 32px; font-weight: 700;">0</div>
                        </div>
                    </div>
                `;
            } else {
                const uiColors = [
                    { bg: 'linear-gradient(135deg, #e0f2fe 0%, #bae6fd 100%)', text: '#0369a1', icon: 'school' },
                    { bg: 'linear-gradient(135deg, #dcfce7 0%, #bbf7d0 100%)', text: '#15803d', icon: 'check_circle' },
                    { bg: 'linear-gradient(135deg, #fef08a 0%, #fde047 100%)', text: '#a16207', icon: 'star' },
                    { bg: 'linear-gradient(135deg, #fce7f3 0%, #fbcfe8 100%)', text: '#be185d', icon: 'favorite' },
                    { bg: 'linear-gradient(135deg, #e0e7ff 0%, #c7d2fe 100%)', text: '#4338ca', icon: 'assessment' },
                    { bg: 'linear-gradient(135deg, #ffedd5 0%, #fed7aa 100%)', text: '#c2410c', icon: 'emoji_events' }
                ];

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

        // Render daily teaching chart only as a fallback
        renderDailyTeachingChart(data.schedules, data.dailyStats);
        data.summaryRendered = true; // prevent repeated fallback
    }

    // Update details table
    const tbody = document.getElementById('teachingDetailsBody');
    if (tbody) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, ''); } else { tbody.innerHTML = ''; }

        if (!data.schedules || data.schedules.length === 0) {
            const tr = document.createElement('tr');
            if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tr, '<td colspan="6" style="text-align: center; padding: 20px; color: #888;">暂无授课记录</td>'); } else { tr.innerHTML = '<td colspan="6" style="text-align: center; padding: 20px; color: #888;">暂无授课记录</td>'; }
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
 * Get color for teaching type
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
 * Render daily teaching chart
 */
function renderDailyTeachingChart(schedules, dailyStats = null) {
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
