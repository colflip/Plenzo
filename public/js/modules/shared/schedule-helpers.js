/**
 * 课表共享工具函数
 * @description 消除 student/teacher/admin 模块间的重复代码
 */

/**
 * 获取时间段ID（统一阈值）
 * 上午: < 12:00, 下午: 12:00-17:59, 晚上: >= 18:00
 * @param {string} timeStr - 时间字符串 HH:MM
 * @returns {'morning'|'afternoon'|'evening'|'unspecified'}
 */
export function getTimeSlotId(timeStr) {
    if (!timeStr) return 'unspecified';
    const parts = timeStr.split(':');
    const hour = parseInt(parts[0], 10);
    if (isNaN(hour)) return 'unspecified';
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}

/**
 * 格式化日期为 YYYY-MM-DD（使用 Asia/Shanghai 时区）
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatDate(date) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d).split('-');
    return `${parts[0]}-${parts[1]}-${parts[2]}`;
}

/**
 * 格式化日期时间为 YYYY-MM-DD HH:mm（使用 Asia/Shanghai 时区）
 * @param {Date|string|number} date
 * @returns {string}
 */
export function formatDateTime(date) {
    if (!date) return '';
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
    return formatter.format(d).replace(', ', ' ');
}

/**
 * 获取 ISO 周数
 * @param {Date} date
 * @returns {number}
 */
export function getISOWeekNumber(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const week1 = new Date(d.getFullYear(), 0, 4);
    return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

/**
 * 获取本周起始日期（周一）
 * @param {Date} [date]
 * @returns {Date}
 */
export function getWeekStart(date) {
    const d = new Date(date || Date.now());
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

/**
 * 生成日期范围数组
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @returns {string[]}
 */
export function generateDateRange(startDate, endDate) {
    const dates = [];
    const start = new Date(startDate + 'T00:00:00+08:00');
    const end = new Date(endDate + 'T00:00:00+08:00');
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        dates.push(formatDate(d));
    }
    return dates;
}

/**
 * 状态标签映射（单一权威来源）
 */
export const STATUS_LABELS = {
    pending: '待确认',
    confirmed: '已确认',
    completed: '已完成',
    cancelled: '已取消',
    modified_away: '已调整'
};

/**
 * 获取状态中文标签
 * @param {string} status
 * @returns {string}
 */
export function getStatusLabel(status) {
    return STATUS_LABELS[String(status)] || String(status || '未知');
}

/**
 * 按时间段分组课表
 * @param {Array} schedules
 * @returns {{morning: Array, afternoon: Array, evening: Array, unspecified: Array}}
 */
export function groupSchedulesBySlot(schedules) {
    const groups = { morning: [], afternoon: [], evening: [], unspecified: [] };
    for (const s of (schedules || [])) {
        const slot = getTimeSlotId(s.start_time || s.startTime);
        (groups[slot] || groups.unspecified).push(s);
    }
    return groups;
}

/**
 * 按日期分组课表
 * @param {Array} schedules
 * @returns {Map<string, Array>}
 */
export function groupSchedulesByDate(schedules) {
    const map = new Map();
    for (const s of (schedules || [])) {
        const dateKey = formatDate(s.class_date || s.classDate || s.date);
        if (!map.has(dateKey)) map.set(dateKey, []);
        map.get(dateKey).push(s);
    }
    return map;
}

/**
 * 图例颜色映射
 * @param {string} type
 * @returns {string}
 */
export function getLegendColor(type) {
    const colors = {
        '入户': '#FF6B6B',
        '试教': '#4ECDC4',
        '评审': '#45B7D1',
        '集体活动': '#96CEB4',
        '咨询': '#FFEAA7',
        '线上入户': '#FF8A80',
        '线上评审': '#80DEEA',
        '线上咨询': '#FFF59D',
    };
    const normalized = String(type || '').replace(/（线上）/g, '线上').trim();
    return colors[normalized] || '#95A5A6';
}

/**
 * 读取排课记录的「调整类型」
 *
 * 数据源已从旧表的 adjustment_type / is_temp 两列换成状态码的类别位
 * （`status_category`：normal | adjusted | temp，由列表接口透出）。
 * 这里保持 0/1/2 的返回契约不变，所以全部调用点（水印、今日视图、周视图导出、
 * 导出「计划安排」筛选）都不需要跟着改 —— 兼容层收拢在这一个函数里。
 *
 * 0 = 普通课（含被调走的原记录）；1 = 临时加课；2 = 调整增补
 * @param {object} rec
 * @returns {number} 0 | 1 | 2
 */
export function getAdjustmentType(rec) {
    if (!rec) return 0;
    const category = rec.status_category
        || (rec.status_code ? String(rec.status_code).split('.')[0] : '');
    if (category === 'temp') return 1;
    if (category === 'adjusted') return 2;
    return 0;
}

/**
 * 水印文本生成（组感知）
 *
 * 统一全校各类视图（教师端 / 学生端 / 班主任 / 管理员 / 周视图导出）的判定规则：
 *   - 「已调整」判定必须与导出逻辑保持一致：adjustment_type === 2 或 status === 'modified_away'
 *     任一成立即视为已调整（"调"水印）。旧实现只认 adjustment_type === 2，导致
 *     modified_away 原记录（adjustment_type = 0）在混合分组（如「全部安排」视图下与原
 *     课程同槽）中无法触发水印。
 *   - 整组均为 modified_away + adjustment_type=0（即全部为被调走的原课程）时标记「原」。
 *   - adjustment_type === 1 标记「加」（临时加课）。
 *
 * @param {object|Array<object>} scheduleOrGroup 单条记录或同槽记录组
 * @returns {string} '' | '原' | '调' | '加' | '调/加'
 */
export function getScheduleWatermarkText(scheduleOrGroup) {
    const recs = Array.isArray(scheduleOrGroup) ? scheduleOrGroup : [scheduleOrGroup];
    if (recs.length === 0 || !recs[0]) return '';

    const statusOf = (r) => (r.status || '').toLowerCase();
    const isOriginal = (r) => statusOf(r) === 'modified_away' && getAdjustmentType(r) === 0;
    const isAdjusted = (r) => getAdjustmentType(r) === 2 || statusOf(r) === 'modified_away';
    const isTemp = (r) => getAdjustmentType(r) === 1;

    // 整组均为「已调整调走」的原课程时，标记「原」
    if (recs.every(isOriginal)) return '原';

    const parts = [];
    if (recs.some(isAdjusted)) parts.push('调');
    if (recs.some(isTemp)) parts.push('加');
    return parts.join('/');
}

/**
 * 排课按类型和ID排序
 * @param {Array} items
 * @param {string} nameKey - 'teacher_name' 或 'student_name'
 * @returns {Array}
 */
export function sortSchedulesByTypeAndId(items, nameKey = 'teacher_name') {
    return [...(items || [])].sort((a, b) => {
        const typeA = a.schedule_type || a.scheduleType || '';
        const typeB = b.schedule_type || b.scheduleType || '';
        if (typeA !== typeB) return typeA.localeCompare(typeB, 'zh');
        const nameA = a[nameKey] || '';
        const nameB = b[nameKey] || '';
        return nameA.localeCompare(nameB, 'zh');
    });
}

/**
 * 判断是否为移动端视图
 * @returns {boolean}
 */
export function isMobileView() {
    return window.innerWidth <= 768;
}
