/**
 * 数据导出工具模块
 * 提供数据验证、转换、安全处理等功能
 */

const db = require('../db/db');

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
                // 获取本周的第一天（周一）
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
                // 自定义日期范围
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
     * @param {Date} startDate - 开始日期
     * @param {Date} endDate - 结束日期
     * @param {number} maxDays - 最大跨度天数（默认365天）
     * @throws {Error} 如果日期范围无效
     */
    static validateDateRange(startDate, endDate, maxDays = 365) {
        if (!(startDate instanceof Date) || !(endDate instanceof Date)) {
            throw new Error('日期格式无效');
        }

        if (startDate > endDate) {
            throw new Error('开始日期不能晚于结束日期');
        }

        const daysDiff = Math.floor((endDate - startDate) / (1000 * 60 * 60 * 24));
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
            throw new Error(`数据量过大（${recordCount} 条），超过限制（${maxRecords} 条）。请缩小导出范围或分次导出。`);
        }
        return true;
    }

    /**
     * 获取日期列表达式（用于SQL查询）
     * @returns {Promise<string>} SQL日期表达式
     */
    static async getDateExpression() {
        try {
            const result = await db.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_schema='public' AND table_name='course_arrangement' 
                AND column_name IN ('arr_date','class_date','date')
                LIMIT 3
            `);

            const cols = new Set((result.rows || []).map(x => x.column_name));
            const parts = [];
            
            if (cols.has('arr_date')) parts.push('ca.arr_date');
            if (cols.has('class_date')) parts.push('ca.class_date');
            if (cols.has('date')) parts.push('ca.date');

            if (parts.length === 0) {
                return 'CURRENT_DATE';
            }

            return parts.length > 1 ? `COALESCE(${parts.join(', ')})` : parts[0];
        } catch (error) {
            console.warn('获取日期列表达式失败，使用默认值:', error.message);
            return 'CURRENT_DATE';
        }
    }

    /**
     * 格式化日期为字符串
     * @param {Date} date - 日期对象
     * @returns {string} ISO格式日期字符串
     */
    static formatDateToISO(date) {
        return date.toISOString().split('T')[0];
    }

    /**
     * 格式化日期为本地格式
     * @param {Date|string} date - 日期
     * @returns {string} 本地格式日期时间字符串
     */
    static formatDateToLocale(date) {
        if (!date) return '无';
        try {
            const d = new Date(date);
            return d.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch (error) {
            return String(date);
        }
    }

    /**
     * 转义数据中的敏感信息（可选）
     * @param {any} value - 要转义的值
     * @returns {any} 转义后的值
     */
    static sanitizeValue(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') {
            // 移除可能包含的脚本标签等危险内容
            return value.replace(/<script|javascript:|onerror|onclick/gi, '');
        }
        return value;
    }

    /**
     * 构建教师导出数据
     * @param {Array} teacherData - 教师数据行
     * @returns {Array} 格式化的导出数据
     */
    static buildTeacherExportData(teacherData) {
        return (teacherData || []).map(teacher => ({
            '教师ID': this.sanitizeValue(teacher.id),
            '用户名': this.sanitizeValue(teacher.username),
            '姓名': this.sanitizeValue(teacher.name),
            '专业': this.sanitizeValue(teacher.profession),
            '联系方式': this.sanitizeValue(teacher.contact),
            '工作地点': this.sanitizeValue(teacher.work_location),
            '家庭住址': this.sanitizeValue(teacher.home_address),
            '最后登录': teacher.last_login ? this.formatDateToLocale(teacher.last_login) : '从未登录',
            '创建时间': this.formatDateToLocale(teacher.created_at),
            '总排课数': teacher.total_schedules || 0,
            '已确认排课': teacher.confirmed_schedules || 0,
            '待确认排课': teacher.pending_schedules || 0,
            '完成率': teacher.total_schedules > 0 
                ? `${Math.round((teacher.confirmed_schedules / teacher.total_schedules) * 100)}%`
                : 'N/A'
        }));
    }

    /**
     * 构建学生导出数据
     * @param {Array} studentData - 学生数据行
     * @returns {Array} 格式化的导出数据
     */
    static buildStudentExportData(studentData) {
        return (studentData || []).map(student => ({
            '学生ID': this.sanitizeValue(student.id),
            '用户名': this.sanitizeValue(student.username),
            '姓名': this.sanitizeValue(student.name),
            '专业': this.sanitizeValue(student.profession),
            '联系方式': this.sanitizeValue(student.contact),
            '访问地点': this.sanitizeValue(student.visit_location),
            '家庭住址': this.sanitizeValue(student.home_address),
            '最后登录': student.last_login ? this.formatDateToLocale(student.last_login) : '从未登录',
            '创建时间': this.formatDateToLocale(student.created_at),
            '总排课数': student.total_schedules || 0,
            '已确认排课': student.confirmed_schedules || 0,
            '待确认排课': student.pending_schedules || 0,
            '参课率': student.total_schedules > 0 
                ? `${Math.round((student.confirmed_schedules / student.total_schedules) * 100)}%`
                : 'N/A'
        }));
    }

    /**
     * 构建导出文件元数据
     * @param {string} title - 文件标题
     * @param {Date} startDate - 起始日期
     * @param {Date} endDate - 结束日期
     * @param {number} totalRecords - 总记录数
     * @returns {Object} 元数据对象
     */
    static buildMetadata(title, startDate, endDate, totalRecords) {
        return {
            title,
            dateRange: `${this.formatDateToISO(startDate)} 至 ${this.formatDateToISO(endDate)}`,
            exportTime: this.formatDateToLocale(new Date()),
            totalRecords,
            exportVersion: '1.0'
        };
    }

    /**
     * 构建完整的Excel导出数据结构
     * @param {string} dataType - 数据类型（'teacher' 或 'student'）
     * @param {Array} data - 原始数据
     * @param {Date} startDate - 起始日期
     * @param {Date} endDate - 结束日期
     * @returns {Object} 包含filename、data和metadata的对象
     */
    static buildExportPayload(dataType, data, startDate, endDate) {
        let formattedData, title;

        if (dataType === 'teacher') {
            formattedData = this.buildTeacherExportData(data);
            title = '教师数据统计';
        } else if (dataType === 'student') {
            formattedData = this.buildStudentExportData(data);
            title = '学生数据统计';
        } else {
            throw new Error('无效的数据类型');
        }

        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '');
        const filename = `${title}_${this.formatDateToISO(startDate)}_${this.formatDateToISO(endDate)}_${timestamp}.xlsx`;

        return {
            filename,
            data: formattedData,
            metadata: this.buildMetadata(title, startDate, endDate, data.length)
        };
    }
}

module.exports = ExportUtils;
