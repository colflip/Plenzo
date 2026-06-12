// Extracted Statistics Logic
// This file contains functions for rendering various statistics charts using Chart.js.
import { showTableLoading, hideTableLoading } from './ui-helper.js';

function isCountableSchedule(row) {
    const status = String(row?.status ?? row?.['状态'] ?? '').toLowerCase();
    return !['0', 'cancelled', '已取消', 'modified_away', '已调整'].includes(status);
}


/**
 * 将 getUserStats API 返回的数据转换为 Chart.js 堆叠柱状图格式
 * @param {Array} stats - API 返回的统计数据 [ { id, name, total, types: { type: count } } ]
 * @param {number} limit - 显示的最大人数（按总数排序后截取）
 * @returns {Object} - Chart.js 数据格式 { labels, datasets }
 */
export function convertUserStatsToStackData(stats, limit = 15) {
    if (!stats || stats.length === 0) {
        return { labels: [], datasets: [] };
    }

    // Filter out 0 total counts
    const filteredStats = stats.filter(person => {
        if (!person.types) return false;
        const total = Object.values(person.types).reduce((acc, val) => acc + (Number(val) || 0), 0);
        return total > 0;
    });

    // 按ID升序排列，最多显示 SUMMARY_MAX_SLOTS (15) 人
    const maxDisplay = typeof SUMMARY_MAX_SLOTS !== 'undefined' ? SUMMARY_MAX_SLOTS : 15;
    const effectiveLimit = Math.min(limit, maxDisplay);
    const sortedStats = [...filteredStats].sort((a, b) => Number(a.id || 0) - Number(b.id || 0)).slice(0, effectiveLimit);

    // 收集所有类型
    const allTypes = new Set();
    sortedStats.forEach(person => {
        Object.keys(person.types || {}).forEach(type => allTypes.add(type));
    });

    // 按出现频率排序类型
    const typeCounts = {};
    sortedStats.forEach(person => {
        Object.entries(person.types || {}).forEach(([type, count]) => {
            typeCounts[type] = (typeCounts[type] || 0) + count;
        });
    });
    const sortedTypes = Array.from(allTypes).sort((a, b) => (typeCounts[b] || 0) - (typeCounts[a] || 0));

    // 构建 labels（人员名称）
    const labels = sortedStats.map(person => person.name);

    // 构建 datasets（每个类型一个数据集）
    const datasets = sortedTypes.map(type => ({
        label: type,
        data: sortedStats.map(person => (person.types || {})[type] || 0),
        backgroundColor: getLegendColor(type),
        borderColor: getLegendColor(type)
    }));

    return { labels, datasets };
}

export function getDefaultSchedules() {
    // 生成一些默认的排课数据
    const types = ['入户', '试教', '评审', '心理咨询', '线上辅导'];
    const teachers = ['张老师', '李老师', '王老师'];
    const students = ['学生A', '学生B', '学生C'];

    const schedules = [];
    const now = new Date();

    for (let i = 0; i < 30; i++) {
        const date = new Date(now);
        date.setDate(date.getDate() - Math.floor(Math.random() * 30));

        schedules.push({
            id: i + 1,
            date: toISODate(date),
            teacher_name: teachers[Math.floor(Math.random() * teachers.length)],
            student_name: students[Math.floor(Math.random() * students.length)],
            schedule_type: types[Math.floor(Math.random() * types.length)],
            schedule_types: types[Math.floor(Math.random() * types.length)]
        });
    }

    return schedules;
}

// --- 统一图表视觉常量 ---
// 浅色现代 tooltip，与卡片设计语言一致
const MODERN_TOOLTIP = {
    enabled: true,
    backgroundColor: 'rgba(255, 255, 255, 0.96)',
    titleColor: '#1F2937',
    bodyColor: '#4B5563',
    footerColor: '#1F2937',
    borderColor: '#E5E7EB',
    borderWidth: 1,
    padding: 12,
    cornerRadius: 8,
    boxPadding: 4,
    usePointStyle: true
};

// 汇总横向柱图：最多显示15人
const SUMMARY_MAX_SLOTS = 15;
// 每行像素高度（柱 22px + 间距）与图例/坐标轴的额外高度
const SUMMARY_ROW_PX = 34;
const SUMMARY_EXTRA_PX = 120;

// 两个汇总（教师/学生）按"较多人数"对齐：较多者不补空，较少者前部补空使真实数据沉底。
// 取各 stack 的实际人数最大值作为共享目标槽位数。
export function computeSummarySlotTarget(...stacks) {
    return stacks.reduce((m, s) => Math.max(m, (s && Array.isArray(s.labels)) ? s.labels.length : 0), 0);
}

// 人数不足 targetSlots 时，在 labels/datasets 前部补空占位，使真实数据沉到底部。
// 不传 targetSlots 或目标≤自身人数时不补空（单图独立渲染场景）。
function padStackToBottom(stackData, targetSlots) {
    const labels = (stackData && stackData.labels) ? stackData.labels : [];
    const target = Math.max(Number(targetSlots) || 0, 0);
    if (!labels.length || labels.length >= target) return stackData;
    const pad = target - labels.length;
    return {
        ...stackData,
        labels: [...new Array(pad).fill(''), ...labels],
        datasets: (stackData.datasets || []).map(ds => ({
            ...ds,
            data: [...new Array(pad).fill(0), ...(ds.data || [])]
        }))
    };
}

// 容器高度交由 CSS（.chart-box aspect-ratio）控制，保持三图正方形等大。
// 保留函数签名以兼容调用点，但不再强制内联高度。
function sizeSummaryChartBox(_canvasEl, _slots) {
    /* no-op: 高度由 CSS aspect-ratio 决定 */
}

// 绘制学生参与统计图表
// slotTarget：与教师汇总图对齐的共享槽位数（人数少的一方补空沉底）
export function renderStudentTypeStackedChart(stackData, slotTarget) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('studentParticipationChart');
    if (!el) return;
    const prev = window.Chart.getChart(el);
    if (prev) try { prev.destroy(); } catch (_) { }
    const ctx = el.getContext('2d');

    const addAlpha = (color, alpha) => {
        const c = String(color || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
            let r, g, b;
            if (c.length === 4) {
                r = parseInt(c[1] + c[1], 16);
                g = parseInt(c[2] + c[2], 16);
                b = parseInt(c[3] + c[3], 16);
            } else {
                r = parseInt(c.slice(1, 3), 16);
                g = parseInt(c.slice(3, 5), 16);
                b = parseInt(c.slice(5, 7), 16);
            }
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (/^rgba?\(/i.test(c)) {
            return c.replace(/rgba?\(([^)]+)\)/i, (m, inner) => {
                const parts = inner.split(',').map(s => s.trim());
                const [r, g, b] = parts;
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            });
        }
        return c;
    };

    // 与另一汇总图按较多人数对齐：人数少则前部补空沉底
    const target = Math.max(Number(slotTarget) || 0, (stackData.labels || []).length);
    stackData = padStackToBottom(stackData, target);
    sizeSummaryChartBox(el, target);

    const datasets = stackData.datasets.map((ds) => ({
        ...ds,
        backgroundColor: getLegendColor(ds.label),
        borderColor: getLegendColor(ds.label),
        borderWidth: 0,
        borderRadius: 6,
        maxBarThickness: 24,
        barPercentage: 0.85,
        categoryPercentage: 0.85
    }));

    new window.Chart(ctx, {
        type: 'bar',
        data: {
            labels: stackData.labels,
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 10,
                        padding: 14,
                        color: '#374151',
                        // 统一由 Chart.defaults.font 以及 CSS 变量驱动字体
                        // 保留结构但不覆盖默认字体设置
                        font: {}
                    },
                    onHover: (e) => { if (e && e.native) e.native.target.style.cursor = 'pointer'; },
                    onClick: (e, item, legend) => {
                        const chart = legend.chart;
                        const idx = item.datasetIndex ?? item.index ?? 0;
                        const now = Date.now();
                        const last = chart.$lastLegendClick || 0;
                        const isDbl = (now - last) < 300 && chart.$lastLegendIndex === idx;
                        chart.$lastLegendClick = now;
                        chart.$lastLegendIndex = idx;
                        if (isDbl) {
                            const current = chart.$highlightIndex;
                            const newIndex = current === idx ? null : idx;
                            chart.$highlightIndex = newIndex;
                            chart.data.datasets.forEach((ds, di) => {
                                const base = getLegendColor(ds.label);
                                if (newIndex == null) {
                                    ds.backgroundColor = base;
                                    ds.borderColor = base;
                                } else if (di === newIndex) {
                                    ds.backgroundColor = base;
                                    ds.borderColor = base;
                                } else {
                                    ds.backgroundColor = addAlpha(base, 0.25);
                                    ds.borderColor = addAlpha(base, 0.25);
                                }
                            });
                            chart.update();
                            return;
                        }
                        // 默认：切换显示/隐藏
                        const vis = chart.isDatasetVisible(idx);
                        chart.setDatasetVisibility(idx, !vis);
                        chart.update();
                    }
                },
                // 标题外置为 HTML h4，统一排版
                title: { display: false },
                tooltip: MODERN_TOOLTIP
            },
            scales: {
                x: { stacked: true, beginAtZero: true, grid: { color: 'rgba(15,23,42,0.06)' }, border: { display: false } },
                y: {
                    stacked: true,
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        autoSkip: false,  // Show all labels, don't skip any
                        font: (context) => {
                            // Get student name for this tick
                            const studentName = context.chart.data.labels[context.index];
                            // Find student ID by searching through the ID map
                            let studentId = null;
                            for (const [id, name] of (window.__studentIdMap || new Map()).entries()) {
                                if (name === studentName) {
                                    studentId = id;
                                    break;
                                }
                            }
                            if (studentId && studentId !== '__fallback__') {
                                const status = window.__studentStatusMap?.get(String(studentId));
                                if (status === 0) {
                                    // Paused student: italic font
                                    return { style: 'italic' };
                                }
                            }
                            // Active student: normal font
                            return { style: 'normal' };
                        }
                    }
                }
            }
        }
    });
}


// 构建教师类型堆叠数据
export function buildTeacherTypeStack(schedules) {
    // 处理空数据情况
    if (!schedules || schedules.length === 0) {
        return getDefaultTeacherStack();
    }

    function mapTypeLabel(t) {
        return (window.i18nUtils && typeof window.i18nUtils.getTypeLabelLocalized === 'function')
            ? window.i18nUtils.getTypeLabelLocalized(t, 'zh-CN')
            : (String(t || '').trim() || '未分类');
    }
    const teacherOrder = [];
    const typeOrder = [];
    const map = new Map();
    const teacherIdMap = new Map(); // Track teacher ID for status filtering

    schedules.forEach(row => {
        if (!isCountableSchedule(row)) return;
        const teacher = row.teacher_name || '未分配';
        const teacherId = row.teacher_id;

        if (!map.has(teacher)) {
            map.set(teacher, new Map());
            teacherOrder.push(teacher);
            // Store teacher ID for status lookup
            if (teacherId) {
                teacherIdMap.set(teacher, teacherId);
            }
        }
        const typesStr = row.schedule_types || '';
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            if (!typeOrder.includes(label)) typeOrder.push(label);
            const tm = map.get(teacher);
            tm.set(label, (tm.get(label) || 0) + 1);
        });
    });

    // Filter out deleted teachers (status = -1)
    let filteredTeachers = teacherOrder.filter(name => {
        const id = teacherIdMap.get(name);
        if (!id) return true; // Keep if no ID (e.g., "未分配")
        const status = window.__teacherStatusMap?.get(String(id));
        return status !== -1; // Exclude deleted
    });

    // Calculate total count for each teacher and sort
    const teacherTotals = filteredTeachers.map(name => {
        const typeMap = map.get(name);
        const total = Array.from(typeMap.values()).reduce((a, b) => a + b, 0);
        const id = teacherIdMap.get(name) || 0;
        return { name, total, id };
    }).filter(t => t.total > 0);  // Only show teachers with actual schedule data

    // 按ID升序排列并截取
    teacherTotals.sort((a, b) => Number(a.id) - Number(b.id));
    const top15Teachers = teacherTotals.slice(0, 15).map(t => t.name);

    // Store teacher ID mapping globally for rendering function
    window.__teacherIdMap = teacherIdMap;

    const datasets = typeOrder.map((label) => ({
        label,
        data: top15Teachers.map(teacher => (map.get(teacher).get(label) || 0)),
        backgroundColor: getLegendColor(label),
        borderColor: getLegendColor(label)
    }));
    return { labels: top15Teachers, datasets };
}

export function buildStudentTypeStack(schedules, students = []) {
    // 处理空数据情况
    if (!schedules || schedules.length === 0) {
        return getDefaultStudentStack();
    }

    function mapTypeLabel(t) {
        return (window.i18nUtils && typeof window.i18nUtils.getTypeLabelLocalized === 'function')
            ? window.i18nUtils.getTypeLabelLocalized(t, 'zh-CN')
            : (String(t || '').trim() || '未分类');
    }
    // 构建学生ID到姓名的映射
    const idToName = new Map();
    students.forEach(s => idToName.set(String(s.id), s.name));

    const studentIdOrder = [];
    const typeOrder = [];
    const map = new Map(); // studentId -> Map(typeLabel -> count)

    schedules.forEach(row => {
        if (!isCountableSchedule(row)) return;
        // 支持 student_ids 字段（逗号分隔）与单个 student_id 回退
        const idsRaw = (row.student_ids || row.student_id || '').toString();
        const ids = idsRaw.split(',').map(x => x.trim()).filter(Boolean);
        const typesStr = row.schedule_types || '';
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        // 若无student_ids则尝试回退到单个name（可能不完整）
        const fallbackId = (row.student_id != null) ? String(row.student_id) : null;
        const fallbackName = row.student_name || '未分配';
        const targetIds = ids.length ? ids : (fallbackId ? [fallbackId] : []);
        const applyForIds = targetIds.length ? targetIds : ['__fallback__'];

        applyForIds.forEach(sid => {
            if (!map.has(sid)) {
                map.set(sid, new Map());
                studentIdOrder.push(sid);
            }
            types.forEach(t => {
                const label = mapTypeLabel(t);
                if (!typeOrder.includes(label)) typeOrder.push(label);
                const sm = map.get(sid);
                sm.set(label, (sm.get(label) || 0) + 1);
            });
        });
        // 若走fallback键，确保名称映射存在
        if (!ids.length) {
            if (!idToName.has('__fallback__')) idToName.set('__fallback__', fallbackName);
        }
    });

    // Filter out deleted students (status = -1) and map IDs to names
    let studentNames = [];
    const studentIdToNameMap = new Map();

    studentIdOrder.forEach(sid => {
        const name = idToName.get(sid) || (sid === '__fallback__' ? (idToName.get('__fallback__') || '未分配') : '未分配');
        studentIdToNameMap.set(sid, name);

        // Check if this student is deleted
        if (sid !== '__fallback__') {
            const status = window.__studentStatusMap?.get(String(sid));
            if (status === -1) return; // Skip deleted students
        }
        studentNames.push({ id: sid, name });
    });

    // Calculate total count for each student and sort
    const studentTotals = studentNames.map(({ id, name }) => {
        const typeMap = map.get(id);
        const total = Array.from(typeMap.values()).reduce((a, b) => a + b, 0);
        return { id, name, total };
    }).filter(t => t.total > 0);  // Only show students with actual schedule data

    // 按ID升序排列并截取
    studentTotals.sort((a, b) => Number(a.id) - Number(b.id));
    const top15Students = studentTotals.slice(0, 15);

    // Store student ID mapping globally for rendering function
    window.__studentIdMap = studentIdToNameMap;

    const labels = top15Students.map(s => s.name);
    const datasets = typeOrder.map((label) => ({
        label,
        data: top15Students.map(s => (map.get(s.id).get(label) || 0)),
        backgroundColor: getLegendColor(label),
        borderColor: getLegendColor(label)
    }));
    return { labels, datasets };
}

// 旧的绿色栈色已移除，统一使用 getLegendColor 保证跨图表一致

// 统一图例颜色映射（按名称一致）
// 统一图例颜色映射（按名称一致）
// Now delegated to ScheduleTypesStore to ensure consistency with dynamic types
export function getLegendColor(name) {
    if (window.ColorUtils && window.ColorUtils.getLegendColor) {
        return window.ColorUtils.getLegendColor(name);
    }
    // Try ScheduleTypesStore first
    if (window.ScheduleTypesStore) {
        return window.ScheduleTypesStore.getColor(name);
    }

    // Fallback logic if store not ready（与 color-utils.js 保持一致）
    const key = String(name || '').trim();
    const LEGEND_COLOR_MAP = {
        '评审': '#2563EB',
        '(线上)评审': '#60A5FA',
        '评审记录': '#93C5FD',
        '入户': '#10B981',
        '(线上)入户': '#34D399',
        '半次入户': '#6EE7B7',
        '咨询': '#8B5CF6',
        '(线上)咨询': '#A78BFA',
        '咨询记录': '#C4B5FD',
        '试教': '#06B6D4',
        '集体活动': '#F59E0B',
        '未分类': '#94A3B8'
    };
    if (key && LEGEND_COLOR_MAP[key]) return LEGEND_COLOR_MAP[key];

    const hash = Array.from(key).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const fallback = ['#F472B6', '#FB923C', '#6366F1', '#14B8A6', '#FACC15', '#A3E635'];
    return fallback[hash % fallback.length];
}

// 导出颜色解析器以供统计插件复用，确保跨图表颜色一致
window.getLegendColor = getLegendColor;
// 导出堆叠构造工具以便测试覆盖
window.__StatsUtils = { buildTeacherTypeStack, buildStudentTypeStack };

// 绘制教师类型堆叠图
// slotTarget：与学生汇总图对齐的共享槽位数（人数少的一方补空沉底）
export function renderTeacherTypeStackedChart(stackData, slotTarget) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('teacherTypeStackedChart');
    if (!el) return;
    const prev = window.Chart.getChart(el);
    if (prev) try { prev.destroy(); } catch (_) { }
    const ctx = el.getContext('2d');

    const addAlpha = (color, alpha) => {
        const c = String(color || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
            let r, g, b;
            if (c.length === 4) {
                r = parseInt(c[1] + c[1], 16);
                g = parseInt(c[2] + c[2], 16);
                b = parseInt(c[3] + c[3], 16);
            } else {
                r = parseInt(c.slice(1, 3), 16);
                g = parseInt(c.slice(3, 5), 16);
                b = parseInt(c.slice(5, 7), 16);
            }
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (/^rgba?\(/i.test(c)) {
            return c.replace(/rgba?\(([^)]+)\)/i, (m, inner) => {
                const parts = inner.split(',').map(s => s.trim());
                const [r, g, b] = parts;
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            });
        }
        return c;
    };

    // 与另一汇总图按较多人数对齐：人数少则前部补空沉底
    const target = Math.max(Number(slotTarget) || 0, (stackData.labels || []).length);
    stackData = padStackToBottom(stackData, target);
    sizeSummaryChartBox(el, target);

    const datasets = stackData.datasets.map((ds) => ({
        ...ds,
        backgroundColor: getLegendColor(ds.label),
        borderColor: getLegendColor(ds.label),
        borderWidth: 0,
        borderRadius: 6,
        maxBarThickness: 24,
        barPercentage: 0.85,
        categoryPercentage: 0.85
    }));

    new window.Chart(ctx, {
        type: 'bar',
        data: {
            labels: stackData.labels,
            datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 10,
                        padding: 14,
                        color: '#374151',
                        font: {}
                    },
                    onHover: (e) => { if (e && e.native) e.native.target.style.cursor = 'pointer'; },
                    onClick: (e, item, legend) => {
                        const chart = legend.chart;
                        const idx = item.datasetIndex ?? item.index ?? 0;
                        const now = Date.now();
                        const last = chart.$lastLegendClick || 0;
                        const isDbl = (now - last) < 300 && chart.$lastLegendIndex === idx;
                        chart.$lastLegendClick = now;
                        chart.$lastLegendIndex = idx;
                        if (isDbl) {
                            const current = chart.$highlightIndex;
                            const newIndex = current === idx ? null : idx;
                            chart.$highlightIndex = newIndex;
                            chart.data.datasets.forEach((ds, di) => {
                                const base = getLegendColor(ds.label);
                                if (newIndex == null) {
                                    ds.backgroundColor = base;
                                    ds.borderColor = base;
                                } else if (di === newIndex) {
                                    ds.backgroundColor = base;
                                    ds.borderColor = base;
                                } else {
                                    ds.backgroundColor = addAlpha(base, 0.25);
                                    ds.borderColor = addAlpha(base, 0.25);
                                }
                            });
                            chart.update();
                            return;
                        }
                        const vis = chart.isDatasetVisible(idx);
                        chart.setDatasetVisibility(idx, !vis);
                        chart.update();
                    }
                },
                // 标题外置为 HTML h4，统一排版
                title: { display: false },
                tooltip: MODERN_TOOLTIP
            },
            scales: {
                x: { stacked: true, beginAtZero: true, grid: { color: 'rgba(15,23,42,0.06)' }, border: { display: false } },
                y: {
                    stacked: true,
                    grid: { display: false },
                    border: { display: false },
                    ticks: {
                        autoSkip: false,
                        font: (context) => {
                            const teacherName = context.chart.data.labels[context.index];
                            const teacherId = window.__teacherIdMap?.get(teacherName);
                            if (teacherId) {
                                const status = window.__teacherStatusMap?.get(String(teacherId));
                                if (status === 0) return { style: 'italic' };
                            }
                            return { style: 'normal' };
                        }
                    }
                }
            }
        }
    });
}

// 绘制学生参与度图表
// 与 renderStudentTypeStackedChart 渲染同一画布（studentParticipationChart），
// 仅入口不同（overview.js vs legacy-adapter.js）。统一委托，保证两条路径外观一致。
export function renderStudentParticipationChart(stackData, slotTarget) {
    return renderStudentTypeStackedChart(stackData, slotTarget);
}


export function renderScheduleTypeChart(data) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('scheduleTypeChart');
    if (!el) return;
    const prev = window.Chart.getChart(el);
    if (prev) try { prev.destroy(); } catch (_) { }
    const ctx = el.getContext('2d');

    const addAlpha = (color, alpha) => {
        const c = String(color || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
            let r, g, b;
            if (c.length === 4) {
                r = parseInt(c[1] + c[1], 16);
                g = parseInt(c[2] + c[2], 16);
                b = parseInt(c[3] + c[3], 16);
            } else {
                r = parseInt(c.slice(1, 3), 16);
                g = parseInt(c.slice(3, 5), 16);
                b = parseInt(c.slice(5, 7), 16);
            }
            return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (/^rgba?\(/i.test(c)) {
            return c.replace(/rgba?\(([^)]+)\)/i, (m, inner) => {
                const parts = inner.split(',').map(s => s.trim());
                const [r, g, b] = parts;
                return `rgba(${r}, ${g}, ${b}, ${alpha})`;
            });
        }
        return c;
    };

    const normalizedData = Array.isArray(data) ? data : (data?.scheduleTypeDistribution || []);
    // 从大到小排列，未分类永远置于最后
    const sorted = normalizedData
        .map(item => ({ type: item.type, count: parseInt(item.count) || 0 }))
        .sort((a, b) => {
            if (a.type === '未分类') return 1;
            if (b.type === '未分类') return -1;
            return b.count - a.count;
        });
    const labels = sorted.map(item => item.type);
    const counts = sorted.map(item => item.count);
    const total = counts.reduce((a, b) => a + b, 0);
    const baseColors = labels.map(l => getLegendColor(l));

    // 中心文字：默认显示总课时，悬停分段时切换为该类型详情
    const centerTextPlugin = {
        id: 'doughnutCenterText',
        afterDraw: (chart) => {
            const area = chart.chartArea;
            if (!area) return;
            const cx = (area.left + area.right) / 2;
            const cy = (area.top + area.bottom) / 2;
            let main = String(total);
            let sub = '总课时';
            const active = chart.getActiveElements ? chart.getActiveElements() : [];
            if (active && active.length) {
                const i = active[0].index;
                const v = chart.data.datasets[0].data[i] || 0;
                const pct = total > 0 ? ((v / total) * 100).toFixed(1) : 0;
                main = String(v);
                sub = `${chart.data.labels[i]} · ${pct}%`;
            }
            const c = chart.ctx;
            c.save();
            c.textAlign = 'center';
            c.textBaseline = 'middle';
            c.font = "700 30px 'Inter', sans-serif";
            c.fillStyle = '#1F2937';
            c.fillText(main, cx, cy - 10);
            c.font = "500 13px 'Inter', sans-serif";
            c.fillStyle = '#9CA3AF';
            c.fillText(sub, cx, cy + 16);
            c.restore();
        }
    };

    new window.Chart(ctx, {
        type: 'doughnut',
        plugins: [centerTextPlugin],
        data: {
            labels,
            datasets: [{
                data: counts,
                backgroundColor: baseColors.slice(),
                borderColor: '#FFFFFF',
                borderWidth: 2,
                borderRadius: 4,
                hoverOffset: 8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '68%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        usePointStyle: true,
                        boxWidth: 10,
                        padding: 14,
                        color: '#374151',
                        font: {},
                        // 图例显示数量与百分比：入户 · 124 (38%)
                        generateLabels: (chart) => {
                            const data = chart.data;
                            if (!data.labels.length) return [];
                            const total = data.datasets[0].data.reduce((a, b) => a + b, 0);
                            return data.labels.map((label, i) => {
                                const value = data.datasets[0].data[i];
                                const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                                return {
                                    text: `${label} · ${value} (${percent}%)`,
                                    fillStyle: data.datasets[0].backgroundColor[i],
                                    strokeStyle: 'transparent',
                                    hidden: !chart.getDataVisibility(i),
                                    index: i
                                };
                            });
                        }
                    },
                    onHover: (e) => { if (e && e.native) e.native.target.style.cursor = 'pointer'; },
                    onClick: (e, item, legend) => {
                        const chart = legend.chart;
                        const idx = item.index ?? 0;
                        const now = Date.now();
                        const last = chart.$lastLegendClick || 0;
                        const isDbl = (now - last) < 300 && chart.$lastLegendIndex === idx;
                        chart.$lastLegendClick = now;
                        chart.$lastLegendIndex = idx;
                        const ds = chart.data.datasets[0];
                        if (isDbl) {
                            const current = chart.$highlightIndex;
                            const newIndex = current === idx ? null : idx;
                            chart.$highlightIndex = newIndex;
                            ds.backgroundColor = baseColors.map((c, i) => {
                                if (newIndex == null) return c;
                                return (i === newIndex) ? c : addAlpha(c, 0.25);
                            });
                            chart.update();
                            return;
                        }
                        // 默认切换显示/隐藏该扇区
                        const vis = chart.getDataVisibility(idx);
                        chart.toggleDataVisibility(idx);
                        chart.update();
                    }
                },
                // 标题外置为 HTML h4
                title: { display: false },
                tooltip: {
                    ...MODERN_TOOLTIP,
                    callbacks: {
                        label: (context) => {
                            const value = context.parsed || 0;
                            const percent = total > 0 ? ((value / total) * 100).toFixed(1) : 0;
                            return ` ${context.label}: ${value} 次 (${percent}%)`;
                        }
                    }
                }
            },
            // 点击扇区时触发事件
            onClick: (e, elements, chart) => {
                if (elements && elements.length > 0) {
                    const idx = elements[0].index;
                    const typeName = chart.data.labels[idx];
                    const count = chart.data.datasets[0].data[idx];
                    // 可扩展：跳转到该类型的详细统计或筛选
                    // 高亮该扇区
                    const ds = chart.data.datasets[0];
                    const current = chart.$highlightIndex;
                    const newIndex = current === idx ? null : idx;
                    chart.$highlightIndex = newIndex;
                    ds.backgroundColor = baseColors.map((c, i) => {
                        if (newIndex == null) return c;
                        return (i === newIndex) ? c : addAlpha(c, 0.25);
                    });
                    chart.update();
                }
            }
        }
    });
}

// 新增：渲染所有教师的排课数据柱状图（全局汇总）
export function renderAllTeachersScheduleBarChart(rows, dayLabels) {
    const container = document.getElementById('teacherChartsContainer');
    if (!container) return;

    // 检查是否已有全局柱状图容器
    let globalChartCard = container.querySelector('.all-teachers-schedule-card');
    if (!globalChartCard) {
        globalChartCard = document.createElement('div');
        globalChartCard.className = 'all-teachers-schedule-card chart-card';
        container.insertBefore(globalChartCard, container.firstChild);
    }
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(globalChartCard, ''); } else { globalChartCard.innerHTML = ''; }

    // 过滤掉已删除的教师（status=-1）
    const statusMapRaw = window.__teacherStatusMap || new Map();
    const getStatus = (id) => {
        try {
            if (statusMapRaw instanceof Map) return Number(statusMapRaw.get(String(id)));
            return Number(statusMapRaw[String(id)]);
        } catch (_) { return NaN; }
    };
    const filteredRows = rows.filter(r => getStatus(r.teacher_id) !== -1);

    // 汇总所有教师的排课数
    const teacherSchedules = new Map();
    filteredRows.forEach(r => {
        const teacherName = r.teacher_name || '未分配';
        teacherSchedules.set(teacherName, (teacherSchedules.get(teacherName) || 0) + 1);
    });

    // 按排课数排序
    const sortedTeachers = Array.from(teacherSchedules.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);

    const scheduleData = sortedTeachers.map(name => teacherSchedules.get(name));

    // 获取品牌色
    const styles = getComputedStyle(document.documentElement);
    const primaryColor = styles.getPropertyValue('--brand-primary').trim() || '#3b82f6';

    // 创建标题
    const title = document.createElement('h4');
    title.className = 'chart-title';
    title.textContent = '教师排课统计';
    globalChartCard.appendChild(title);

    // 创建Canvas
    const canvas = document.createElement('canvas');
    canvas.id = 'allTeachersScheduleChart';
    globalChartCard.appendChild(canvas);

    // 渲染柱状图
    const ctx = canvas.getContext('2d');
    new Chart(ctx, {
        type: 'bar',
        data: {
            labels: sortedTeachers,
            datasets: [{
                label: '排课数量',
                data: scheduleData,
                backgroundColor: primaryColor,
                borderRadius: 6,
                maxBarThickness: 40
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            indexAxis: 'y',
            plugins: {
                legend: { display: false },
                tooltip: { enabled: true }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    grid: { color: 'rgba(0,0,0,0.08)' }
                },
                y: {
                    grid: { display: false },
                    ticks: { font: { size: 12 } }
                }
            }
        }
    });
}

// 新增：渲染所有学生的排课数据柱状图（全局汇总）


// 辅助：根据 dayLabels 聚合 rows 每天的数量（针对所有教师/学生汇总）
export function aggregateCountsByDate(rows, dayLabels, dateField = 'date') {
    const map = new Map(dayLabels.map(d => [d, 0]));
    rows.forEach(r => {
        if (!isCountableSchedule(r)) return;
        // 兼容多种日期字段名：优先使用指定的dateField，然后尝试常见字段名
        const d = String(r[dateField] || r.date || r.class_date || '').slice(0, 10);
        if (!d) return;
        if (map.has(d)) map.set(d, map.get(d) + 1);
    });
    return dayLabels.map(d => map.get(d) || 0);
}



// --- 详情信息卡（教师/学生 tab 内每人一张卡，整行显示） ---
// 卡片含：姓名+总数、类型占比条、文本图例、折算汇总，以及一张
// 按类型堆叠的每日明细图（X=日期 / Y=数量），完整展示该人所有数据。
function renderPersonInfoCard(container, opts) {
    const {
        cardClass,       // 'teacher-chart' / 'student-chart'（保留原类名供清理选择器使用）
        canvasId,
        displayName,
        paused,
        personRows,
        dayLabels,
        typeOrder,       // 全局类型顺序，保证卡片间颜色/顺序一致
        mapTypeLabel,
        convertedText    // 折算汇总文本（业务口径，可为空）
    } = opts;

    // 按类型聚合本人课时
    const typeCountMap = new Map();
    personRows.forEach(r => {
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCountMap.set(label, (typeCountMap.get(label) || 0) + 1);
        });
    });
    const orderedTypes = typeOrder.filter(t => typeCountMap.has(t));
    const total = Array.from(typeCountMap.values()).reduce((a, b) => a + b, 0);

    const card = document.createElement('div');
    card.className = `person-stat-card ${cardClass}` + (paused ? ' person-paused' : '');

    // 单行信息：姓名 + 总数 + 分类课程数 + 折算课程数
    const header = document.createElement('div');
    header.className = 'person-card-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'person-name';
    nameEl.textContent = displayName + (paused ? '（暂停）' : '');
    header.appendChild(nameEl);

    const badge = document.createElement('span');
    badge.className = 'person-total-badge';
    badge.textContent = `共 ${total} 节`;
    header.appendChild(badge);

    // 分类课程数（色点 + 类型 + 数量）
    const legend = document.createElement('span');
    legend.className = 'person-type-legend';
    orderedTypes.forEach(t => {
        const item = document.createElement('span');
        item.className = 'person-legend-item';
        const dot = document.createElement('i');
        dot.className = 'person-legend-dot';
        dot.style.backgroundColor = getLegendColor(t);
        item.appendChild(dot);
        item.appendChild(document.createTextNode(`${t} ${typeCountMap.get(t)}`));
        legend.appendChild(item);
    });
    header.appendChild(legend);

    // 折算后课程数
    if (convertedText) {
        const conv = document.createElement('span');
        conv.className = 'person-converted';
        conv.textContent = `折算：${convertedText}`;
        header.appendChild(conv);
    }

    card.appendChild(header);

    // 每日明细图：整行显示，按类型堆叠，X=日期 / Y=数量（节）
    const chartWrap = document.createElement('div');
    chartWrap.className = 'person-daily-chart';
    const canvas = document.createElement('canvas');
    canvas.id = canvasId;
    chartWrap.appendChild(canvas);
    card.appendChild(chartWrap);

    container.appendChild(card);

    try {
        // 按 日期 -> 类型 -> 数量 聚合
        const dateTypeMap = new Map(dayLabels.map(d => [d, new Map()]));
        personRows.forEach(r => {
            const d = String(r.date || '').slice(0, 10);
            if (!dateTypeMap.has(d)) return;
            const typesStr = String(r.schedule_types || '').trim();
            const types = typesStr ? typesStr.split(',') : ['未分类'];
            const tm = dateTypeMap.get(d);
            types.forEach(t => {
                const label = mapTypeLabel(t);
                tm.set(label, (tm.get(label) || 0) + 1);
            });
        });

        // 每个类型一个堆叠数据集（沿用全局类型顺序与配色）
        const datasets = orderedTypes.map(label => ({
            label,
            data: dayLabels.map(d => dateTypeMap.get(d).get(label) || 0),
            backgroundColor: getLegendColor(label),
            borderColor: getLegendColor(label),
            borderWidth: 0,
            borderRadius: 4,
            maxBarThickness: 26
        }));

        // 日期标签格式：跨年 YYYY-MM-DD / 跨月 MM-DD / 同月 DD
        const fmtDate = (() => {
            const ds = dayLabels.map(s => new Date(s));
            const ys = ds.map(d => d.getFullYear());
            const ms = ds.map(d => d.getMonth());
            const multiYear = Math.max(...ys) > Math.min(...ys);
            const multiMonth = multiYear || Math.max(...ms) > Math.min(...ms);
            return dayLabels.map(s => {
                const d = new Date(s);
                if (multiYear) return s;
                if (multiMonth) return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                return String(d.getDate());
            });
        })();

        new window.Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: { labels: fmtDate, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: 'index', intersect: false },
                plugins: {
                    legend: { display: false },
                    title: { display: false },
                    tooltip: {
                        ...MODERN_TOOLTIP,
                        callbacks: {
                            title: (items) => {
                                if (!items || !items.length) return '';
                                const full = dayLabels[items[0].dataIndex];
                                const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
                                const dt = new Date(full);
                                return `${full} (${wd[dt.getDay()]})`;
                            },
                            label: (ctx) => (ctx.parsed.y > 0 ? `${ctx.dataset.label}: ${ctx.parsed.y} 节` : null),
                            footer: (items) => {
                                const sum = items.reduce((a, it) => a + (it.parsed.y || 0), 0);
                                return sum > 0 ? `总计: ${sum} 节` : '';
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        stacked: true,
                        grid: { display: false },
                        border: { display: false },
                        ticks: {
                            autoSkip: true,
                            maxRotation: 0,
                            color: (ctx) => {
                                const full = dayLabels[ctx.index];
                                if (full) {
                                    const day = new Date(full).getDay();
                                    if (day === 0 || day === 6) return '#DC2626';
                                }
                                return '#64748B';
                            }
                        }
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        grid: { color: 'rgba(15,23,42,0.06)' },
                        border: { display: false },
                        ticks: { precision: 0 }
                    }
                }
            }
        });
    } catch (_) { }
}

// 新增：按教师生成多类型光滑曲线图（每位教师一个图）
export function renderTeacherTypePerTeacherCharts(rows, dayLabels, selectedTeacher = '') {
    if (!isChartAvailable()) {
        return;
    }

    const container = document.getElementById('teacherChartsContainer');
    if (!container) {
        return;
    }



    // 检查数据格式
    rows = (rows || []).filter(isCountableSchedule);

    if (rows.length === 0) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(container, '<div style="padding: 20px; text-align: center; color: #64748b;">暂无排课数据</div>'); } else { container.innerHTML = '<div style="padding: 20px; text-align: center; color: #64748b;">暂无排课数据</div>'; }
        return;
    }

    // 仅移除之前生成的每位教师的 chart 卡片，保留顶部的汇总卡片（如 all-teachers-daily-card）
    container.querySelectorAll('.teacher-chart').forEach(n => n.remove());

    function mapTypeLabel(t) {
        return (window.i18nUtils && typeof window.i18nUtils.getTypeLabelLocalized === 'function')
            ? window.i18nUtils.getTypeLabelLocalized(t, 'zh-CN')
            : (String(t || '').trim() || '未分类');
    }

    // 汇总全局类型顺序，保证不同教师图颜色一致
    const typeCounts = new Map();
    rows.forEach(r => {
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCounts.set(label, (typeCounts.get(label) || 0) + 1);
        });
    });
    const globalTypeOrder = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]).map(([label]) => label);

    // 获取教师 id 列表并按状态排序（正常→暂停，删除不显示）
    const teacherIdSet = new Set(rows.map(r => String(r.teacher_id || '').trim()));
    let teachers = Array.from(teacherIdSet);



    const statusMapRaw = window.__teacherStatusMap || new Map();
    const nameMap = window.__teacherNameMap || new Map();
    const getStatus = (id) => {
        try {
            if (statusMapRaw instanceof Map) return Number(statusMapRaw.get(String(id)));
            return Number(statusMapRaw[String(id)]);
        } catch (_) { return NaN; }
    };
    const weight = (id) => { const s = getStatus(id); if (s === 1) return 0; if (s === 0) return 1; return 2; };
    teachers = teachers.filter(id => (getStatus(id) !== -1)).sort((a, b) => {
        return Number(a) - Number(b);
    });
    if (selectedTeacher) teachers = teachers.filter(t => String(t) === String(selectedTeacher));



    // 辅助：slug化ID（兼容中文：使用哈希生成稳定且唯一的ID）
    const slug = (s) => {
        const t = String(s || '').trim();
        let h = 2166136261 >>> 0; // FNV-like hash seed
        for (const ch of t) {
            h ^= ch.charCodeAt(0);
            h = (h * 16777619) >>> 0;
        }
        return `t_${h.toString(16)}`;
    };

    // 为每位教师构建详情信息卡
    teachers.forEach(teacherId => {
        const teacherRows = rows.filter(r => String(r.teacher_id || '') === String(teacherId));

        const st = getStatus(teacherId);
        const displayName = String(nameMap.get(teacherId) || teacherRows.find(r => r.teacher_name)?.teacher_name || '未分配');

        // 计算课程类型统计（带折算）
        const typeCounts = {
            visit: 0,      // 入户
            review: 0,     // 评审
            group: 0,      // 集体活动
            consult: 0     // 咨询
        };

        teacherRows.forEach(r => {
            const typesStr = String(r.schedule_types || '').trim();
            const types = typesStr ? typesStr.split(',') : [];

            types.forEach(t => {
                const trimmed = String(t).trim();
                const lower = trimmed.toLowerCase();

                // 辅助匹配函数（同时匹配 Code / ID / 中文名）
                // ID对照: 1=visit, 5=half_visit, 3=review, 4=review_record, 6=group_activity, 7=advisory/consultation
                const isType = (code, id, name) => {
                    return lower === code || trimmed == id || lower === name;
                };

                // 辅助函数：检查是否为线上类型
                const isOnlineType = (baseName) => {
                    return lower.includes(`线上${baseName}`) || lower.includes(`（线上）${baseName}`) || lower.includes(`(线上)${baseName}`);
                };

                // 折算规则（线上类型等效为线下类型）
                if (isType('visit', 1, '入户') || isOnlineType('入户')) {
                    typeCounts.visit += 1;
                } else if (isType('half_visit', 5, '半次入户')) {
                    typeCounts.visit += 0.5;  // 半次入户 = 0.5次入户
                } else if (isType('review', 3, '评审') || isOnlineType('评审')) {
                    typeCounts.review += 1;
                } else if (isType('review_record', 4, '评审记录') || isOnlineType('评审记录')) {
                    typeCounts.review += 1;    // 评审记录 = 1次评审
                    typeCounts.visit += 0.5;   // + 0.5次入户
                } else if (isType('group_activity', 6, '集体活动') || lower === 'group') {
                    typeCounts.group += 1;
                } else if (isType('advisory', 7, '咨询') || isType('consultation', 7, '咨询') || lower === 'consult' || isOnlineType('咨询') || lower.includes('线上辅导') || lower.includes('心理咨询')) {
                    typeCounts.consult += 1;
                } else if (lower.includes('咨询记录') || isOnlineType('咨询记录')) {
                    typeCounts.consult += 1;    // 咨询记录 = 1次咨询
                }
            });
        });

        // 生成折算汇总文本（仅显示非0的类型）
        const summary = [];
        if (typeCounts.visit > 0) summary.push(`入户 ${typeCounts.visit}`);
        if (typeCounts.review > 0) summary.push(`评审 ${typeCounts.review}`);
        if (typeCounts.group > 0) summary.push(`集体活动 ${typeCounts.group}`);
        if (typeCounts.consult > 0) summary.push(`咨询 ${typeCounts.consult}`);

        renderPersonInfoCard(container, {
            cardClass: 'teacher-chart',
            canvasId: `teacherDailySeries_${slug(teacherId)}`,
            displayName,
            paused: st === 0,
            personRows: teacherRows,
            dayLabels,
            typeOrder: globalTypeOrder,
            mapTypeLabel,
            convertedText: summary.join(' · ')
        });
    });
}

export function renderTeacherScheduleChart(data) {
    if (!isChartAvailable()) return;
    const el = document.getElementById('teacherScheduleChart');
    if (!el) return;
    const ctx = el.getContext('2d');
    const styles = getComputedStyle(document.documentElement);
    const primary = styles.getPropertyValue('--brand-primary').trim() || '#2ECC71';
    new window.Chart(ctx, {
        type: 'bar',
        data: {
            labels: data.map(item => item.teacher_name),
            datasets: [{
                label: '排课数量',
                data: data.map(item => item.schedule_count),
                backgroundColor: primary,
                borderRadius: 8,
                maxBarThickness: 36
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                title: { display: true, text: '教师排课统计', font: { size: 16, weight: '600' } },
                tooltip: { enabled: true }
            },
            scales: {
                y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.08)' } },
                x: { grid: { display: false } }
            }
        }
    });
}

// Global exposure for backward compatibility
window.StatsLogic = {
    convertUserStatsToStackData,
    getDefaultSchedules,
    renderStudentTypeStackedChart,
    buildTeacherTypeStack,
    buildStudentTypeStack,
    getLegendColor,
    renderTeacherTypeStackedChart,
    renderStudentParticipationChart,
    computeSummarySlotTarget,
    renderScheduleTypeChart,
    renderAllTeachersScheduleBarChart,
    aggregateCountsByDate,
    renderTeacherTypePerTeacherCharts,
    renderTeacherScheduleChart
};

// Also expose generic helpers directly to window for legacy inline calls
window.getLegendColor = getLegendColor;
window.__StatsUtils = { buildTeacherTypeStack, buildStudentTypeStack };
window.convertUserStatsToStackData = convertUserStatsToStackData;
window.getDefaultSchedules = getDefaultSchedules;
window.renderStudentTypeStackedChart = renderStudentTypeStackedChart;
window.buildTeacherTypeStack = buildTeacherTypeStack;
window.buildStudentTypeStack = buildStudentTypeStack;
window.renderTeacherTypeStackedChart = renderTeacherTypeStackedChart;
window.renderStudentParticipationChart = renderStudentParticipationChart;
window.computeSummarySlotTarget = computeSummarySlotTarget;
window.renderScheduleTypeChart = renderScheduleTypeChart;
window.renderAllTeachersScheduleBarChart = renderAllTeachersScheduleBarChart;
window.aggregateCountsByDate = aggregateCountsByDate;
window.renderTeacherTypePerTeacherCharts = renderTeacherTypePerTeacherCharts;
window.renderTeacherScheduleChart = renderTeacherScheduleChart;

// --- Extracted from legacy-adapter.js ---
export function getSelectedTeacherForCharts() {
    const sel = document.getElementById('statsTeacherSelect');
    return sel ? String(sel.value || '') : '';
}

export function setupTeacherChartsFilter(rows, dayLabels) {
    const sel = document.getElementById('statsTeacherSelect');
    if (!sel) return;
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(sel, ''); } else { sel.innerHTML = ''; }
    const optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = '全部教师'; sel.appendChild(optAll);
    // 通过接口加载教师状态，统一排序并隐藏已删除
    (async () => {
        try {
            let teachers = [];
            // Cache Check: Try WeeklyDataStore first
            if (window.WeeklyDataStore && typeof window.WeeklyDataStore.getTeachers === 'function') {
                try {
                    const cached = await window.WeeklyDataStore.getTeachers();
                    if (cached && cached.length > 0) {
                        teachers = cached;
                    }
                } catch (e) { }
            }

            // Fallback to API if cache empty
            if (!teachers || teachers.length === 0) {
                try {
                    const tResp = await window.apiUtils.get('/admin/users/teacher');
                    teachers = Array.isArray(tResp) ? tResp : (tResp && Array.isArray(tResp.data) ? tResp.data : []);
                } catch (err) {
                    // 返回默认教师列表
                    teachers = [
                        { id: 1, name: '教师A', status: 1 },
                        { id: 2, name: '教师B', status: 1 },
                        { id: 3, name: '教师C', status: 0 }
                    ];
                }
            } // End of if (!teachers || teachers.length === 0)

            // Process teachers list (from cache or API)
            const statusMap = new Map();
            const nameMap = new Map();
            const weight = (v) => { const n = Number(v); if (n === 1) return 0; if (n === 0) return 1; return 2; };
            teachers = (teachers || []).filter(t => Number(t?.status) !== -1);
            teachers.sort((a, b) => {
                const wa = weight(a?.status), wb = weight(b?.status);
                if (wa !== wb) return wa - wb;
                // 按教师 ID 数字从小到大排序
                return Number(a?.id || 0) - Number(b?.id || 0);
            });
            teachers.forEach(t => {
                const idStr = String(t.id || '');
                statusMap.set(idStr, Number(t.status));
                nameMap.set(idStr, String(t.name || ''));
                const o = document.createElement('option');
                o.value = idStr;
                o.textContent = (t.name || '') + (Number(t.status) === 0 ? '（暂停）' : '');
                sel.appendChild(o);
            });
            window.__teacherStatusMap = statusMap;
            window.__teacherNameMap = nameMap;

        } catch (err) {
            const teacherSet = new Set(rows.map(r => String(r.teacher_id || '').trim()));
            const teachersFallback = Array.from(teacherSet).sort();
            teachersFallback.forEach(id => {
                const label = rows.find(rr => String(rr.teacher_id || '') === String(id))?.teacher_name || id || '未分配';
                const o = document.createElement('option'); o.value = String(id); o.textContent = label; sel.appendChild(o);
            });
        }
    })();
    if (!sel.__bound) {
        sel.addEventListener('change', () => {
            const selected = getSelectedTeacherForCharts();
            renderTeacherTypePerTeacherCharts(rows, dayLabels, selected);
        });
        sel.__bound = true;
    }
    // 绑定教师区域的日期查询（如果存在独立控件）
    const tStart = document.getElementById('teacherStartDate');
    const tEnd = document.getElementById('teacherEndDate');
    const tBtn = document.getElementById('teacherStatsSearchBtn');
    if (tBtn && !tBtn.__bound) {
        tBtn.addEventListener('click', async () => {
            const s = tStart && tStart.value ? tStart.value : (dayLabels[0] || '');
            const e = tEnd && tEnd.value ? tEnd.value : (dayLabels[dayLabels.length - 1] || '');
            try {
                const newRows = await fetchSchedulesRange(s, e, '', '');
                const newDayLabels = (window.StatsPlugins && typeof window.StatsPlugins.buildDayLabels === 'function')
                    ? window.StatsPlugins.buildDayLabels(s, e)
                    : buildDatesRange(s, e).map(d => toISODate(d));

                // 更新"按日期汇总"图表
                if (window.StatsPlugins) {
                    const typeStacks = window.StatsPlugins.buildStackedByTypePerDay(newRows, newDayLabels);
                    window.StatsPlugins.renderStackedBarChart('teacherDailyTypeStackChart', newDayLabels, typeStacks, {
                        theme: 'accessible',
                        animation: false,
                        interactionMode: 'index'
                    });
                    // 设置汇总图表标题的悬停提示
                    setupStatsTooltip(newRows, 'teacherSummaryChartTitle', 'teacherSummaryTitleTooltip');
                }

                // 更新教师筛选器和每位教师的图表
                setupTeacherChartsFilter(newRows, newDayLabels);
                const selected = getSelectedTeacherForCharts();
                renderTeacherTypePerTeacherCharts(newRows, newDayLabels, selected);
            } catch (err) {
                showToast('教师统计按日期查询失败', 'error');
            }
        });
        tBtn.__bound = true;
    }
}

// 设置汇总图表标题的悬停提示
// 设置汇总图表标题的悬停提示 (通用)
export function setupStatsTooltip(scheduleRows, titleId, tooltipId) {
    const titleEl = document.getElementById(titleId);
    const tooltipEl = document.getElementById(tooltipId);

    if (!titleEl || !tooltipEl) return;

    // 辅助函数：映射课程类型标签
    const mapTypeLabel = (t) => {
        const raw = String(t || '').trim();
        if (!raw) return '未分类';
        const num = Number(raw);
        const isId = !isNaN(num) && /^\d+$/.test(raw);
        if (isId && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
            const found = window.ScheduleTypesStore.getById(num);
            if (found) return found.description || found.name || String(num);
        }
        return raw;
    };

    // 计算整个日期范围的课程类型汇总统计
    const typeCountMap = new Map();
    let totalCount = 0;

    scheduleRows.forEach(r => {
        if (!isCountableSchedule(r)) return;
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCountMap.set(label, (typeCountMap.get(label) || 0) + 1);
            totalCount++;
        });
    });

    // 构建工具提示内容
    let tooltipHTML = '<div style="font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 6px;">授课类型统计</div>';

    if (typeCountMap.size > 0) {
        const sortedTypes = Array.from(typeCountMap.entries()).sort((a, b) => b[1] - a[1]);
        sortedTypes.forEach(([type, count]) => {
            tooltipHTML += `<div style="margin: 4px 0;">${type}: ${count}节</div>`;
        });
        tooltipHTML += `<div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.3); font-weight: bold;">总计: ${totalCount}节</div>`;
    } else {
        tooltipHTML += '<div style="margin: 4px 0;">暂无数据</div>';
    }

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tooltipEl, tooltipHTML); } else { tooltipEl.innerHTML = tooltipHTML; }

    // 添加鼠标悬停事件 (如果未绑定)
    if (!titleEl.__tooltipBound) {
        titleEl.addEventListener('mouseenter', () => {
            // 简单的淡入
            tooltipEl.style.display = 'block';
            // 强制重绘以触发 transition
            tooltipEl.offsetHeight;
            tooltipEl.style.opacity = '1';
            tooltipEl.style.visibility = 'visible';
        });

        titleEl.addEventListener('mouseleave', () => {
            tooltipEl.style.opacity = '0';
            tooltipEl.style.visibility = 'hidden';
            // 等待动画结束后隐藏
            setTimeout(() => {
                if (tooltipEl.style.opacity === '0') {
                    tooltipEl.style.display = 'none';
                }
            }, 300);
        });
        titleEl.__tooltipBound = true;
    }
}

export function getSelectedStudentForCharts() {
    const sel = document.getElementById('statsStudentSelect');
    return sel ? String(sel.value || '') : '';
}

export function setupStudentChartsFilter(rows, dayLabels) {
    const sel = document.getElementById('statsStudentSelect');
    if (!sel) return;
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(sel, ''); } else { sel.innerHTML = ''; }
    const optAll = document.createElement('option'); optAll.value = ''; optAll.textContent = '全部学生'; sel.appendChild(optAll);
    (async () => {
        try {
            let students = [];
            // Cache Check
            if (window.WeeklyDataStore && typeof window.WeeklyDataStore.getStudents === 'function') {
                try {
                    const cached = await window.WeeklyDataStore.getStudents();
                    if (cached && cached.length > 0) {
                        students = cached;
                    }
                } catch (e) { }
            }

            if (!students || students.length === 0) {
                try {
                    const sResp = await window.apiUtils.get('/admin/users/student');
                    if (Array.isArray(sResp)) {
                        students = sResp;
                    } else if (sResp && Array.isArray(sResp.data)) {
                        students = sResp.data;
                    } else if (sResp && Array.isArray(sResp.students)) {
                        students = sResp.students;
                    } else if (sResp && Array.isArray(sResp.items)) {
                        students = sResp.items;
                    } else if (sResp && sResp.data && Array.isArray(sResp.data.students)) {
                        students = sResp.data.students;
                    } else {
                        students = [];
                    }
                } catch (err) {
                    students = [{ id: 1, name: '学生A', status: 1 }];
                }
            }
            const statusMap = new Map();
            const nameMap = new Map();
            const weight = (v) => { const n = Number(v); if (n === 1) return 0; if (n === 0) return 1; return 2; };
            students = (students || []).filter(s => Number(s?.status) !== -1);
            students.sort((a, b) => {
                const wa = weight(a?.status), wb = weight(b?.status);
                if (wa !== wb) return wa - wb;
                // 按学生 ID 数字从小到大排序
                return Number(a?.id || 0) - Number(b?.id || 0);
            });
            students.forEach(s => {
                const idStr = String(s.id || '');
                statusMap.set(idStr, Number(s.status));
                nameMap.set(idStr, String(s.name || ''));
                const o = document.createElement('option');
                o.value = idStr;
                o.textContent = (s.name || '') + (Number(s.status) === 0 ? '（暂停）' : '');
                sel.appendChild(o);
            });
            window.__studentStatusMap = statusMap;
            window.__studentNameMap = nameMap;
        } catch (err) {
            const studentIdSet = new Set(rows.map(r => String(r.student_id || '').trim()));
            const studentsFallback = Array.from(studentIdSet).sort();
            studentsFallback.forEach(id => {
                const label = rows.find(rr => String(rr.student_id || '') === String(id))?.student_name || id || '未分配';
                const o = document.createElement('option'); o.value = String(id); o.textContent = label; sel.appendChild(o);
            });
        }
    })();
    if (!sel.__bound) {
        sel.addEventListener('change', () => {
            const selected = getSelectedStudentForCharts();
            renderStudentTypePerStudentCharts(rows, dayLabels, selected);
        });
        sel.__bound = true;
    }
    // 绑定学生区域的日期查询（如果存在独立控件）
    const sStart = document.getElementById('studentStartDate');
    const sEnd = document.getElementById('studentEndDate');
    const sBtn = document.getElementById('studentStatsSearchBtn');
    if (sBtn && !sBtn.__bound) {
        sBtn.addEventListener('click', async () => {
            const s = sStart && sStart.value ? sStart.value : (dayLabels[0] || '');
            const e = sEnd && sEnd.value ? sEnd.value : (dayLabels[dayLabels.length - 1] || '');
            try {
                const newRows = await fetchSchedulesRange(s, e, '', '');
                const newDayLabels = (window.StatsPlugins && typeof window.StatsPlugins.buildDayLabels === 'function')
                    ? window.StatsPlugins.buildDayLabels(s, e)
                    : buildDatesRange(s, e).map(d => toISODate(d));

                // 更新"按日期汇总"图表 (镜像教师逻辑)
                if (window.StatsPlugins) {
                    const typeStacks = window.StatsPlugins.buildStackedByTypePerDay(newRows, newDayLabels);
                    window.StatsPlugins.renderStackedBarChart('studentDailyTypeStackChart', newDayLabels, typeStacks, {
                        theme: 'accessible',
                        animation: false,
                        interactionMode: 'index'
                    });
                    // 设置汇总图表标题的悬停提示
                    setupStatsTooltip(newRows, 'studentSummaryChartTitle', 'studentSummaryTitleTooltip');
                }

                const selected = getSelectedStudentForCharts();
                renderStudentTypePerStudentCharts(newRows, newDayLabels, selected);
            } catch (err) {
                showToast('学生统计按日期查询失败', 'error');
            }
        });
        sBtn.__bound = true;
    }
}

// 设置学生汇总图表标题的悬停提示 (镜像教师逻辑)
export function setupStudentSummaryChartTitleTooltip(scheduleRows) {
    const titleEl = document.getElementById('studentSummaryChartTitle');
    const tooltipEl = document.getElementById('studentSummaryTitleTooltip');

    if (!titleEl || !tooltipEl) return;

    // 辅助函数：映射课程类型标签
    const mapTypeLabel = (t) => {
        const raw = String(t || '').trim();
        if (!raw) return '未分类';
        const num = Number(raw);
        const isId = !isNaN(num) && /^\d+$/.test(raw);
        if (isId && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
            const found = window.ScheduleTypesStore.getById(num);
            if (found) return found.description || found.name || String(num);
        }
        return raw;
    };

    // 计算整个日期范围的课程类型汇总统计
    const typeCountMap = new Map();
    let totalCount = 0;

    scheduleRows.forEach(r => {
        if (!isCountableSchedule(r)) return;
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCountMap.set(label, (typeCountMap.get(label) || 0) + 1);
            totalCount++;
        });
    });

    // 构建工具提示内容
    let tooltipHTML = '<div style="font-weight: bold; margin-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.3); padding-bottom: 6px;">授课类型统计</div>';

    if (typeCountMap.size > 0) {
        const sortedTypes = Array.from(typeCountMap.entries()).sort((a, b) => b[1] - a[1]);
        sortedTypes.forEach(([type, count]) => {
            tooltipHTML += `<div style="margin: 4px 0;">${type}: ${count}节</div>`;
        });
        tooltipHTML += `<div style="margin-top: 8px; padding-top: 6px; border-top: 1px solid rgba(255,255,255,0.3); font-weight: bold;">总计: ${totalCount}节</div>`;
    } else {
        tooltipHTML += '<div style="margin: 4px 0;">暂无数据</div>';
    }

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tooltipEl, tooltipHTML); } else { tooltipEl.innerHTML = tooltipHTML; }

    // 添加鼠标悬停事件
    titleEl.addEventListener('mouseenter', () => {
        tooltipEl.style.display = 'block';
    });

    titleEl.addEventListener('mouseleave', () => {
        tooltipEl.style.display = 'none';
    });
}

// 新增：按学生生成多类型光滑曲线图（每位学生一个图）
export function renderStudentTypePerStudentCharts(rows, dayLabels, selectedStudent = '') {
    if (!isChartAvailable()) {
        return;
    }

    const container = document.getElementById('studentChartsContainer');
    if (!container) {
        return;
    }

    rows = (rows || []).filter(isCountableSchedule);

    // 检查数据格式
    if (rows.length === 0) {
        // 移除暂无数据提示 (User Request)
        container.innerHTML = ''; // Clear the container
        return;
    }

    // 仅移除之前生成的每位学生的 chart 卡片，保留顶部的汇总卡片
    container.querySelectorAll('.student-chart').forEach(n => n.remove());

    function mapTypeLabel(t) {
        return (window.i18nUtils && typeof window.i18nUtils.getTypeLabelLocalized === 'function')
            ? window.i18nUtils.getTypeLabelLocalized(t, 'zh-CN')
            : (String(t || '').trim() || '未分类');
    }

    // 汇总全局类型顺序，保证不同学生图颜色一致
    const typeCounts = new Map();
    rows.forEach(r => {
        const typesStr = String(r.schedule_types || '').trim();
        const types = typesStr ? typesStr.split(',') : ['未分类'];
        types.forEach(t => {
            const label = mapTypeLabel(t);
            typeCounts.set(label, (typeCounts.get(label) || 0) + 1);
        });
    });
    const globalTypeOrder = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1]).map(([label]) => label);

    // 获取学生 id 列表并按状态排序
    const studentIdSet = new Set(rows.map(r => String(r.student_id || '').trim()));
    let students = Array.from(studentIdSet);

    const statusMapRaw = window.__studentStatusMap || new Map();
    const nameMap = window.__studentNameMap || new Map();
    const getStatus = (id) => {
        try {
            if (statusMapRaw instanceof Map) return Number(statusMapRaw.get(String(id)));
            return Number(statusMapRaw[String(id)]);
        } catch (_) { return NaN; }
    };
    const weight = (id) => { const s = getStatus(id); if (s === 1) return 0; if (s === 0) return 1; return 2; };

    students = students.filter(id => (getStatus(id) !== -1)).sort((a, b) => {
        return Number(a) - Number(b);
    });

    if (selectedStudent) students = students.filter(s => String(s) === String(selectedStudent));

    const slug = (s) => {
        const t = String(s || '').trim();
        let h = 2166136261 >>> 0;
        for (const ch of t) { h ^= ch.charCodeAt(0); h = (h * 16777619) >>> 0; }
        return `s_${h.toString(16)}`;
    };

    // 为每位学生构建详情信息卡
    students.forEach(studentId => {
        const stuRows = rows.filter(r => String(r.student_id || '') === String(studentId));

        const st = getStatus(studentId);
        const displayName = String(nameMap.get(studentId) || stuRows.find(r => r.student_name)?.student_name || '未分配');

        // 计算课程类型统计（带折算）
        const typeCounts = {
            visit: 0,      // 入户
            review: 0,     // 评审
            group: 0,      // 集体活动
            consult: 0     // 咨询
        };

        // 辅助函数：检查是否为线上类型
        const isOnlineType = (baseName, lower) => {
            return lower.includes(`线上${baseName}`) || lower.includes(`（线上）${baseName}`) || lower.includes(`(线上)${baseName}`);
        };

        stuRows.forEach(r => {
            const typesStr = String(r.schedule_types || '').trim();
            const types = typesStr ? typesStr.split(',') : [];

            types.forEach(t => {
                const trimmed = String(t).trim();
                const lower = trimmed.toLowerCase();
                const isType = (code, id, name) => {
                    return lower === code || trimmed == id || lower === name;
                };

                // 折算规则（线上类型等效为线下类型）
                if (isType('visit', 1, '入户') || isOnlineType('入户', lower)) {
                    typeCounts.visit += 1;
                } else if (isType('half_visit', 5, '半次入户')) {
                    typeCounts.visit += 0.5;  // 半次入户 = 0.5次入户
                } else if (isType('review', 3, '评审') || isOnlineType('评审', lower)) {
                    typeCounts.review += 1;
                } else if (isType('review_record', 4, '评审记录') || isOnlineType('评审记录', lower)) {
                    typeCounts.review += 1;    // 评审记录 = 1次评审
                    typeCounts.visit += 0.5;   // + 0.5次入户
                } else if (isType('group_activity', 6, '集体活动') || lower === 'group') {
                    typeCounts.group += 1;
                } else if (isType('advisory', 7, '咨询') || isType('consultation', 7, '咨询') || lower === 'consult' || isOnlineType('咨询', lower) || lower.includes('线上辅导') || lower.includes('心理咨询')) {
                    typeCounts.consult += 1;
                } else if (lower.includes('咨询记录') || isOnlineType('咨询记录', lower)) {
                    typeCounts.consult += 1;    // 咨询记录 = 1次咨询
                }
            });
        });

        // 生成折算汇总文本（仅显示非0的类型）
        const summary = [];
        if (typeCounts.visit > 0) summary.push(`入户 ${typeCounts.visit}`);
        if (typeCounts.review > 0) summary.push(`评审 ${typeCounts.review}`);
        if (typeCounts.group > 0) summary.push(`集体活动 ${typeCounts.group}`);
        if (typeCounts.consult > 0) summary.push(`咨询 ${typeCounts.consult}`);

        renderPersonInfoCard(container, {
            cardClass: 'student-chart',
            canvasId: `studentDailySeries_${slug(studentId)}`,
            displayName,
            paused: st === 0,
            personRows: stuRows,
            dayLabels,
            typeOrder: globalTypeOrder,
            mapTypeLabel,
            convertedText: summary.join(' · ')
        });
    });
}

// 导出功能相关函数
// 快速导出功能相关代码已删除

// 已移除：downloadExcelFile 和 createAndDownloadExcel 函数
// 这些函数已被 export-ui-manager.js 中的 ExportUIManager 取代

// Global exposure
window.setupTeacherChartsFilter = setupTeacherChartsFilter;
window.setupStatsTooltip = setupStatsTooltip;
window.setupStudentChartsFilter = setupStudentChartsFilter;
window.setupStudentSummaryChartTitleTooltip = setupStudentSummaryChartTitleTooltip;
window.renderStudentTypePerStudentCharts = renderStudentTypePerStudentCharts;
window.getSelectedTeacherForCharts = getSelectedTeacherForCharts;
window.getSelectedStudentForCharts = getSelectedStudentForCharts;
