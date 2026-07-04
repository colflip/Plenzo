/**
 * 数据导出工具模块
 * 提供数据验证、转换、安全处理等功能
 * 作为所有导出相关模块的通用工具层
 */

/**
 * 导出工具类
 */
class ExportUtils {
    /**
     * 计算实际日期范围
     * @param {string} startDate - 开始日期
     * @param {string} endDate - 结束日期
     * @param {string} preset - 预设类型
     * @returns {Object} 包含 actualStartDate 和 actualEndDate 的对象
     */
    static calculateDateRange(startDate, endDate, preset) {
        const now = new Date();
        let actualStartDate, actualEndDate;

        switch (preset) {
            case 'today':
                actualStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                actualEndDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
                break;
            case 'week':
                const dayOfWeek = now.getDay();
                const diff = now.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
                actualStartDate = new Date(now.getFullYear(), now.getMonth(), diff);
                actualEndDate = new Date(now.getFullYear(), now.getMonth(), diff + 7);
                break;
            case 'month':
                actualStartDate = new Date(now.getFullYear(), now.getMonth(), 1);
                actualEndDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
                break;
            case 'quarter':
                const quarter = Math.floor(now.getMonth() / 3);
                actualStartDate = new Date(now.getFullYear(), quarter * 3, 1);
                actualEndDate = new Date(now.getFullYear(), quarter * 3 + 3, 0);
                break;
            case 'year':
                actualStartDate = new Date(now.getFullYear(), 0, 1);
                actualEndDate = new Date(now.getFullYear(), 11, 31);
                break;
            default:
                if (!startDate || !endDate) {
                    throw new Error('请提供有效的日期范围');
                }
                actualStartDate = new Date(startDate);
                actualEndDate = new Date(endDate);
        }

        return { actualStartDate, actualEndDate };
    }

    /**
     * 验证日期范围有效性
     * 支持 Date 对象和字符串两种输入
     * @param {Date|string} startDate - 开始日期
     * @param {Date|string} endDate - 结束日期
     * @param {number} maxDays - 最大跨度天数（默认365天）
     * @throws {Error} 如果日期范围无效
     */
    static validateDateRange(startDate, endDate, maxDays = 365) {
        const start = startDate instanceof Date ? startDate : new Date(startDate);
        const end = endDate instanceof Date ? endDate : new Date(endDate);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            throw new Error('日期格式无效');
        }

        if (start > end) {
            throw new Error('开始日期不能晚于结束日期');
        }

        const daysDiff = Math.floor((end - start) / (1000 * 60 * 60 * 24));
        if (daysDiff > maxDays) {
            throw new Error(`数据导出跨度不能超过 ${maxDays} 天，当前跨度为 ${daysDiff} 天`);
        }

        return true;
    }

    /**
     * 验证导出数据量
     * @param {number} recordCount - 记录数
     * @param {number} maxRecords - 最大记录数（默认50000）
     * @throws {Error} 如果数据量超出限制
     */
    static validateDataSize(recordCount, maxRecords = 50000) {
        if (recordCount > maxRecords) {
            const error = new Error(`数据量过大（${recordCount} 条），超过限制（${maxRecords} 条）。请缩小导出范围或分次导出。`);
            error.status = 413;
            throw error;
        }
        return true;
    }

    /**
     * 脱敏处理 - 移除潜在危险的脚本标签和事件处理器
     * @param {any} value - 要脱敏的值
     * @returns {string} 脱敏后的字符串
     */
    static sanitizeValue(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        // 快速路径：大多数值不含 HTML 标记，跳过正则
        if (str.indexOf('<') === -1 && str.indexOf('on') === -1) return str;
        return str
            .replace(/<script[^>]*>.*?<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '');
    }

}

module.exports = ExportUtils;
