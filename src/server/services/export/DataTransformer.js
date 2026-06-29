/**
 * 数据转换器
 * 负责数据标准化、类型归一化、格式转换等辅助功能
 */

const { TYPE_NORMALIZATION, NON_COUNTABLE_STATUSES } = require('./ExportConstants');

class DataTransformer {
    /**
     * 标准化类型键：线上类型 → 基础类型
     * @param {string} typeKey - 原始类型键
     * @returns {string} 标准化后的类型键
     */
    static normalizeTypeKey(typeKey) {
        const lower = String(typeKey || '').toLowerCase().trim();
        if (lower === 'review_online' || lower === 'online_review') return 'review';
        if (lower === 'visit_online' || lower === 'online_visit') return 'visit';
        if (lower === 'consultation_online' || lower === 'online_consultation' ||
            lower === 'advisory_online' || lower === 'online_advisory') return 'consultation';
        if (lower === 'review_record_online' || lower === 'online_review_record') return 'review_record';
        if (lower === 'consultation_record_online' || lower === 'online_consultation_record') return 'consultation_record';
        return lower;
    }

    /**
     * 判断是否为可统计的课程（排除已取消、已调整）
     * @param {Object} row - 课程记录
     * @returns {boolean} 是否可统计
     */
    static isCountableSchedule(row) {
        const status = String(row?.status ?? row?.['状态'] ?? '').toLowerCase();
        return !NON_COUNTABLE_STATUSES.includes(status) &&
               !['0', 'cancelled', '已取消', 'modified_away', '已调整'].includes(status);
    }

    /**
     * 格式化费用值
     * @param {*} val - 费用值
     * @returns {string} 格式化后的费用字符串
     */
    static formatFee(val) {
        if (val === null || val === undefined || val === '' || val === 0 || val === '0') {
            return '/';
        }
        const num = parseFloat(val);
        if (isNaN(num) || num === 0) return '/';
        return String(Math.ceil(num * 100) / 100);
    }

    /**
     * 格式化日期为 YYYY-MM-DD
     * @param {*} date - 日期对象或字符串
     * @returns {string} 格式化后的日期字符串
     */
    static formatLocaleDate(date) {
        if (!date) return '';
        const d = new Date(date);
        if (isNaN(d.getTime())) return String(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    /**
     * 格式化时间戳为本地时间字符串
     * @param {*} val - 时间戳
     * @returns {string} 格式化后的时间字符串
     */
    static formatTimestamp(val) {
        if (!val) return '';
        const date = new Date(val);
        return isNaN(date.getTime())
            ? String(val)
            : date.toLocaleString('zh-CN', { hour12: false });
    }

    /**
     * 清理文件名中的特殊字符
     * @param {string} name - 原始名称
     * @returns {string} 清理后的名称
     */
    static sanitizeFilename(name) {
        if (!name) return '未知';
        return String(name)
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')  // 移除文件系统非法字符
            .replace(/\s+/g, '_')                     // 空格转下划线
            .replace(/\.+/g, '_')                     // 连续点号转下划线
            .slice(0, 50);                            // 限制长度
    }

    /**
     * 生成时间戳 (YYYYMMDDHHMMSS)
     * @returns {string} 时间戳字符串
     */
    static generateTimestamp() {
        const now = new Date();
        // 转换为东八区时间
        const utc8Time = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const year = utc8Time.getUTCFullYear();
        const month = String(utc8Time.getUTCMonth() + 1).padStart(2, '0');
        const day = String(utc8Time.getUTCDate()).padStart(2, '0');
        const hours = String(utc8Time.getUTCHours()).padStart(2, '0');
        const minutes = String(utc8Time.getUTCMinutes()).padStart(2, '0');
        const seconds = String(utc8Time.getUTCSeconds()).padStart(2, '0');
        return `${year}${month}${day}${hours}${minutes}${seconds}`;
    }

    /**
     * 按日期分组数据
     * @param {Array} rawData - 原始数据
     * @returns {Map} 按日期分组的Map
     */
    static groupDataByDate(rawData) {
        const grouped = new Map();

        rawData.forEach(row => {
            const dateStr = DataTransformer.formatLocaleDate(
                row.date || row.class_date || row.arr_date
            );
            if (!dateStr) return;

            if (!grouped.has(dateStr)) {
                grouped.set(dateStr, []);
            }
            grouped.get(dateStr).push(row);
        });

        return grouped;
    }

    /**
     * 按时间段分组（同一时间段的课程合并）
     * @param {Array} schedules - 课程列表
     * @returns {Array} 分组后的时间段数组
     */
    static groupByTimeSlot(schedules) {
        const slotMap = new Map();

        schedules.forEach(schedule => {
            const startTime = String(schedule.start_time || '').substring(0, 5);
            const endTime = String(schedule.end_time || '').substring(0, 5);
            const key = `${startTime}-${endTime}`;

            if (!slotMap.has(key)) {
                slotMap.set(key, { timeSlot: key, schedules: [] });
            }
            slotMap.get(key).schedules.push(schedule);
        });

        const groups = Array.from(slotMap.values());

        // 按时间段从早到晚排序
        groups.sort((a, b) => {
            const parseSlot = (slot) => {
                const [start] = slot.split('-');
                const [h, m] = start.split(':').map(Number);
                return h * 60 + m;
            };
            return parseSlot(a.timeSlot) - parseSlot(b.timeSlot);
        });

        return groups;
    }
}

module.exports = DataTransformer;
