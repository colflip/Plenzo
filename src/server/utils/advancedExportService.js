/**
 * 高级数据导出处理模块
 * 支持：
 * 1. 老师信息数据
 * 2. 学生信息数据
 * 3. 指定时间段的老师排课记录
 * 4. 指定时间段的学生排课记录
 */

class AdvancedExportService {
    constructor(db) {
        this.db = db;
        this.MAX_RECORDS = 50000;
        this.MAX_DATE_RANGE = 365; // 天
    }

    /**
     * 导出类型配置
     */
    static EXPORT_TYPES = {
        TEACHER_INFO: 'teacher_info',
        STUDENT_INFO: 'student_info',
        TEACHER_SCHEDULE: 'teacher_schedule',
        STUDENT_SCHEDULE: 'student_schedule'
    };

    /**
     * 列映射配置（用于 CSV/Excel 列名）
     */
    static COLUMN_CONFIG = {
        teacher_info: [
            { key: 'id', header: '教师ID', width: 12 },
            { key: 'username', header: '用户名', width: 15 },
            { key: 'name', header: '姓名', width: 12 },
            { key: 'profession', header: '职业', width: 15 },
            { key: 'contact', header: '联系方式', width: 15 },
            { key: 'work_location', header: '工作地点', width: 20 },
            { key: 'home_address', header: '家庭地址', width: 25 },
            { key: 'last_login', header: '最后登录', width: 18 },
            { key: 'created_at', header: '创建时间', width: 18 },
            { key: 'total_schedules', header: '总排课数', width: 10 },
            { key: 'confirmed_schedules', header: '已确认', width: 10 },
            { key: 'pending_schedules', header: '待确认', width: 10 },
            { key: 'completion_rate', header: '完成率', width: 10 }
        ],
        student_info: [
            { key: 'id', header: '学生ID', width: 12 },
            { key: 'username', header: '用户名', width: 15 },
            { key: 'name', header: '姓名', width: 12 },
            { key: 'profession', header: '职业', width: 15 },
            { key: 'contact', header: '联系方式', width: 15 },
            { key: 'visit_location', header: '探访地点', width: 20 },
            { key: 'home_address', header: '家庭地址', width: 25 },
            { key: 'last_login', header: '最后登录', width: 18 },
            { key: 'created_at', header: '创建时间', width: 18 },
            { key: 'total_schedules', header: '总排课数', width: 10 },
            { key: 'confirmed_schedules', header: '已确认', width: 10 },
            { key: 'pending_schedules', header: '待确认', width: 10 },
            { key: 'participation_rate', header: '参课率', width: 10 }
        ],
        teacher_schedule: [
            { key: 'teacher_name', header: '教师名称', width: 15 },
            { key: 'student_name', header: '学生名称', width: 15 },
            { key: 'type', header: '类型', width: 12 },
            { key: 'date', header: '日期', width: 15 },
            { key: 'week', header: '星期', width: 10 },
            { key: 'time_range', header: '时间段', width: 15 },
            { key: 'start_time', header: '开始时间', width: 10 },
            { key: 'end_time', header: '结束时间', width: 10 },
            { key: 'status', header: '状态', width: 12 },
            { key: 'created_at', header: '创建时间', width: 18 },
            { key: 'schedule_id', header: '排课ID', width: 12 },
            { key: 'teacher_id', header: '教师ID', width: 12 },
            { key: 'student_id', header: '学生ID', width: 12 },
            { key: 'notes', header: '备注', width: 25 }
        ],
        student_schedule: [
            { key: 'schedule_id', header: '排课ID', width: 12 },
            { key: 'student_id', header: '学生ID', width: 12 },
            { key: 'student_name', header: '学生名称', width: 15 },
            { key: 'teacher_id', header: '教师ID', width: 12 },
            { key: 'teacher_name', header: '教师名称', width: 15 },
            { key: 'date', header: '日期', width: 15 },
            { key: 'time_range', header: '时间', width: 15 },
            { key: 'start_time', header: 'start_time', width: 10 },
            { key: 'end_time', header: 'end_time', width: 10 },
            { key: 'location', header: '地点', width: 20 },
            { key: 'type', header: '类型', width: 12 },
            { key: 'status', header: '状态', width: 12 },
            { key: 'notes', header: '备注', width: 25 },
            { key: 'created_at', header: '创建时间', width: 18 }
        ]
    };

    /**
     * 验证导出类型
     */
    validateExportType(type) {
        if (!Object.values(AdvancedExportService.EXPORT_TYPES).includes(type)) {
            throw new Error('无效的导出类型');
        }
    }

    /**
     * 验证文件格式
     */
    validateFormat(format) {
        if (!['excel', 'csv'].includes(format)) {
            throw new Error('不支持的文件格式');
        }
    }

    /**
     * 验证日期范围
     */
    validateDateRange(startDate, endDate) {
        if (!startDate || !endDate) {
            throw new Error('开始日期和结束日期不能为空');
        }

        const start = new Date(startDate);
        const end = new Date(endDate);

        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
            throw new Error('日期格式无效');
        }

        if (start > end) {
            throw new Error('开始日期不能晚于结束日期');
        }

        const daysDiff = Math.floor((end - start) / (1000 * 60 * 60 * 24));
        if (daysDiff > this.MAX_DATE_RANGE) {
            throw new Error(`日期范围不能超过 ${this.MAX_DATE_RANGE} 天`);
        }
    }

    /**
     * 验证数据量
     */
    validateDataSize(count) {
        if (count > this.MAX_RECORDS) {
            const error = new Error(`导出数据量超过限制 (${count}/${this.MAX_RECORDS})`);
            error.status = 413;
            throw error;
        }
    }

    /**
     * 脱敏处理
     */
    sanitizeValue(value) {
        if (value === null || value === undefined) return '';
        const str = String(value);
        // 移除危险的脚本标签和事件处理器
        return str
            .replace(/<script[^>]*>.*?<\/script>/gi, '')
            .replace(/javascript:/gi, '')
            .replace(/on\w+\s*=/gi, '');
    }

    /**
     * 获取日期表达式（兼容多种日期列名）
     * 增加缓存机制，避免每次导出都要查询 information_schema
     */
    async getDateExpression() {
        if (this._cachedDateExpr) return this._cachedDateExpr;

        try {
            const result = await this.db.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'course_arrangement'
                AND column_name IN ('arr_date', 'class_date', 'date')
                ORDER BY column_name DESC
            `);

            const columns = (result.rows || []).map(r => r.column_name);

            if (columns.length === 0) {
                throw new Error('course_arrangement 表中找不到日期列');
            }

            // 使用 COALESCE 或单列，优先级：arr_date > class_date > date
            let expr = '';
            if (columns.length === 1) {
                expr = `ca.${columns[0]}`;
            } else {
                const parts = [];
                ['arr_date', 'class_date', 'date'].forEach(col => {
                    if (columns.includes(col)) parts.push(`ca.${col}`);
                });
                expr = parts.length > 1 ? `COALESCE(${parts.join(', ')})` : parts[0];
            }

            this._cachedDateExpr = expr;
            return expr;
        } catch (error) {
            console.error('获取日期表达式失败:', error);
            // 降级方案：使用最常见的列，不缓存以便下次重试
            return 'ca.class_date';
        }
    }

    /**
     * 导出教师信息
     */
    async exportTeacherInfo() {
        const query = `
            SELECT 
                t.id,
                t.username,
                t.name,
                t.profession,
                t.contact,
                t.work_location,
                t.home_address,
                t.last_login,
                t.created_at,
                COALESCE(COUNT(ca.id), 0) as total_schedules,
                COALESCE(SUM(CASE WHEN ca.status = 'confirmed' THEN 1 ELSE 0 END), 0) as confirmed_schedules,
                COALESCE(SUM(CASE WHEN ca.status = 'pending' THEN 1 ELSE 0 END), 0) as pending_schedules
            FROM teachers t
            LEFT JOIN course_arrangement ca ON t.id = ca.teacher_id
            GROUP BY t.id, t.username, t.name, t.profession, t.contact, 
                     t.work_location, t.home_address, t.last_login, t.created_at
            ORDER BY t.created_at DESC
        `;

        const result = await this.db.query(query);
        const rows = result.rows || [];

        // 验证数据量
        this.validateDataSize(rows.length);

        // 数据转换
        return rows.map(row => ({
            ...row,
            completion_rate: row.total_schedules > 0
                ? ((row.confirmed_schedules / row.total_schedules) * 100).toFixed(2) + '%'
                : '0%',
            created_at: this.formatDateTime(row.created_at),
            last_login: this.formatDateTime(row.last_login)
        }));
    }

    /**
     * 导出学生信息
     */
    async exportStudentInfo() {
        const query = `
            SELECT 
                s.id,
                s.username,
                s.name,
                s.profession,
                s.contact,
                s.visit_location,
                s.home_address,
                s.last_login,
                s.created_at,
                COALESCE(COUNT(ca.id), 0) as total_schedules,
                COALESCE(SUM(CASE WHEN ca.status = 'confirmed' THEN 1 ELSE 0 END), 0) as confirmed_schedules,
                COALESCE(SUM(CASE WHEN ca.status = 'pending' THEN 1 ELSE 0 END), 0) as pending_schedules
            FROM students s
            LEFT JOIN course_arrangement ca ON s.id = ca.student_id
            GROUP BY s.id, s.username, s.name, s.profession, s.contact, 
                     s.visit_location, s.home_address, s.last_login, s.created_at
            ORDER BY s.created_at DESC
        `;

        const result = await this.db.query(query);
        const rows = result.rows || [];

        // 验证数据量
        this.validateDataSize(rows.length);

        // 数据转换
        return rows.map(row => ({
            ...row,
            participation_rate: row.total_schedules > 0
                ? ((row.confirmed_schedules / row.total_schedules) * 100).toFixed(2) + '%'
                : '0%',
            created_at: this.formatDateTime(row.created_at),
            last_login: this.formatDateTime(row.last_login)
        }));
    }


    /**
     * 生成导出数据（Controller入口）
     */
    async generateExportData(type, startDate, endDate, filters = {}) {
        // 验证参数
        this.validateExportType(type);
        this.validateDateRange(startDate, endDate);

        let data;
        let filenamePrefix = '';
        let userName = filters.user_name;

        if (type === 'teacher_schedule') {
            // 获取原始数据
            const rawData = await this.queryTeacherSchedule(startDate, endDate, filters);

            if (!userName && rawData.length > 0) userName = rawData[0].teacher_name;
            filenamePrefix = `[${userName || '教师'}]授课记录`;

            // 构建多Sheet数据
            data = {
                '总览表': this.formatOverviewData(rawData, 'teacher'),
                '明细信息表': this.aggregateDetails(rawData, 'teacher')
            };
        } else if (type === 'student_schedule') {
            const rawData = await this.queryStudentSchedule(startDate, endDate, filters);

            if (!userName && rawData.length > 0) userName = rawData[0].student_name;
            filenamePrefix = `[${userName || '学生'}]授课记录`;

            data = {
                '总览表': this.formatOverviewData(rawData, 'student'),
                '明细信息表': this.aggregateDetails(rawData, 'student')
            };
        }

        // 返回统一结果结构
        return {
            format: 'excel',
            data: data,
            filename: `${filenamePrefix}_[${startDate}_${endDate}]_${this.getTimestamp()}.xlsx`
        };
    }

    getTimestamp() {
        const now = new Date();
        const yyyyMMdd = now.toISOString().slice(0, 10).replace(/-/g, '');
        const hhmmss = now.toTimeString().slice(0, 8).replace(/:/g, '');
        return `${yyyyMMdd}${hhmmss}`;
    }

    /**
     * 查询教师排课数据 (支持过滤)
     */
    async queryTeacherSchedule(startDate, endDate, filters) {
        const dateExpr = await this.getDateExpression();
        let query = `
SELECT
ca.id as schedule_id,
    ca.teacher_id,
    t.name as teacher_name,
    ca.student_id,
    s.name as student_name,
    ${dateExpr}:: date as date,
        ca.start_time,
        ca.end_time,
        (TO_CHAR(ca.start_time, 'HH24:MI') || '-' || TO_CHAR(ca.end_time, 'HH24:MI')) as time_range,
        ca.location,
        st.name as type_name,
        COALESCE(st.description, st.name) as type_desc,
        ca.status,
        ca.teacher_comment as notes,
        ca.created_at,
        ca.updated_at,
        ca.last_auto_update,
        ca.created_by,
        ca.transport_fee,
        ca.other_fee
            FROM course_arrangement ca
            LEFT JOIN teachers t ON ca.teacher_id = t.id
            LEFT JOIN students s ON ca.student_id = s.id
            LEFT JOIN schedule_types st ON ca.course_id = st.id
            WHERE ${dateExpr}::date BETWEEN $1 AND $2
        `;

        const values = [startDate, endDate];

        // 应用过滤器
        if (filters.teacher_id) {
            values.push(filters.teacher_id);
            query += ` AND ca.teacher_id = $${values.length} `;
        }
        if (filters.student_id) {
            values.push(filters.student_id);
            query += ` AND ca.student_id = $${values.length} `;
        }

        query += ` ORDER BY ${dateExpr} DESC, ca.start_time ASC`;

        const result = await this.db.query(query, values);
        return result.rows || [];
    }

    /**
     * 查询学生排课数据
     */
    async queryStudentSchedule(startDate, endDate, filters) {
        const dateExpr = await this.getDateExpression();
        let query = `
SELECT
ca.id as schedule_id,
    ca.student_id,
    s.name as student_name,
    ca.teacher_id,
    t.name as teacher_name,
    ${dateExpr}:: date as date,
        ca.start_time,
        ca.end_time,
        (TO_CHAR(ca.start_time, 'HH24:MI') || '-' || TO_CHAR(ca.end_time, 'HH24:MI')) as time_range,
        ca.location,
        st.name as type_name,
        COALESCE(st.description, st.name) as type_desc,
        ca.status,
        ca.student_comment as notes,
        ca.created_at,
        ca.updated_at,
        ca.last_auto_update,
        ca.created_by,
        ca.transport_fee,
        ca.other_fee
            FROM course_arrangement ca
            LEFT JOIN students s ON ca.student_id = s.id
            LEFT JOIN teachers t ON ca.teacher_id = t.id
            LEFT JOIN schedule_types st ON ca.course_id = st.id
            WHERE ${dateExpr}::date BETWEEN $1 AND $2
        `;

        const values = [startDate, endDate];

        if (filters.student_id) {
            values.push(filters.student_id);
            query += ` AND ca.student_id = $${values.length} `;
        }

        query += ` ORDER BY ${dateExpr} DESC, ca.start_time ASC`;

        const result = await this.db.query(query, values);
        return result.rows || [];
    }

    /**
     * 格式化总览表数据
     */
    formatOverviewData(rawData, role) {
        return rawData.map(row => {
            const dateObj = new Date(row.date);
            const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            const week = days[dateObj.getDay()];

            // 基础字段
            const item = {
                'student_name': row.student_name,
                'type': row.type_name || '未知',
                'date': row.date instanceof Date ? row.date.toISOString().slice(0, 10) : row.date,
                'week': week,
                'time_range': row.time_range,
                'status': this.formatStatus(row.status),
                'created_at': this.formatDateTime(row.created_at),
                'schedule_id': row.schedule_id,
                'teacher_id': row.teacher_id,
                'student_id': row.student_id,
                'notes': row.notes || ''
            };
            return item;
        });
    }

    /**
     * 聚合明细信息表
     */
    aggregateDetails(rawData, role) {
        // 如果是教师导出，按学生聚合；如果是学生导出，按教师聚合
        const groupKey = role === 'teacher' ? 'student_name' : 'teacher_name';
        const stats = {};

        rawData.forEach(row => {
            const name = row[groupKey] || '未知';
            if (!stats[name]) {
                stats[name] = {
                    '老师姓名': name,
                    '试教': 0,
                    '入户': 0,
                    '半次入户': 0,
                    '评审': 0,
                    '评审记录': 0,
                    '集体活动': 0,
                    '咨询': 0,
                    '备注': ''
                };
            }

            const type = row.type_name;
            if (type && stats[name].hasOwnProperty(type)) {
                stats[name][type]++;
            } else if (type === '入户课') { // 兼容旧名称
                stats[name]['入户']++;
            }
        });

        return Object.values(stats);
    }

    formatStatus(status) {
        const map = {
            'pending': '待确认',
            'confirmed': '已确认',
            'completed': '已完成',
            'cancelled': '已取消'
        };
        return map[status] || status;
    }

    /**
     * 导出指定时间段的老师排课记录 (Admin兼容)
     */
    async exportTeacherSchedule(startDate, endDate, filters = {}) {
        const rows = await this.queryTeacherSchedule(startDate, endDate, filters);
        return rows.map(row => ({
            schedule_id: row.schedule_id,
            teacher_id: row.teacher_id,
            teacher_name: this.sanitizeValue(row.teacher_name),
            student_id: row.student_id,
            student_name: this.sanitizeValue(row.student_name),
            date: row.date,
            start_time: row.start_time,
            end_time: row.end_time,
            time_range: row.time_range,
            location: this.sanitizeValue(row.location),
            type: this.sanitizeValue(row.type_name),
            type_desc: this.sanitizeValue(row.type_desc),
            status: row.status,
            notes: this.sanitizeValue(row.notes),
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_auto_update: row.last_auto_update,
            created_by: row.created_by,
            transport_fee: row.transport_fee,
            other_fee: row.other_fee
        }));
    }

    async exportStudentSchedule(startDate, endDate) {
        const rows = await this.queryStudentSchedule(startDate, endDate, {});
        return rows.map(row => ({
            schedule_id: row.schedule_id,
            student_id: row.student_id,
            student_name: this.sanitizeValue(row.student_name),
            teacher_id: row.teacher_id,
            teacher_name: this.sanitizeValue(row.teacher_name),
            date: row.date,
            start_time: row.start_time,
            end_time: row.end_time,
            time_range: row.time_range,
            location: this.sanitizeValue(row.location),
            type: this.sanitizeValue(row.type_name),
            type_desc: this.sanitizeValue(row.type_desc),
            status: row.status,
            notes: this.sanitizeValue(row.notes),
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_auto_update: row.last_auto_update,
            created_by: row.created_by,
            transport_fee: row.transport_fee,
            other_fee: row.other_fee
        }));
    }

    /**
     * 将数据转换为 Excel 格式的列数组
     */
    toExcelFormat(data, type) {
        const config = AdvancedExportService.COLUMN_CONFIG[type];
        if (!config) throw new Error('不支持的导出类型配置');

        return data.map(row => {
            const excelRow = {};
            config.forEach(col => {
                excelRow[col.header] = row[col.key] !== undefined ? row[col.key] : '';
            });
            return excelRow;
        });
    }

    /**
     * 获取 Excel 列宽配置
     */
    getExcelColumnWidths(type) {
        const config = AdvancedExportService.COLUMN_CONFIG[type];
        return config.map(col => ({ wch: col.width }));
    }

    /**
     * 将数据转换为 CSV 格式
     */
    toCsvFormat(data, type) {
        const config = AdvancedExportService.COLUMN_CONFIG[type];
        if (!config) throw new Error('不支持的导出类型配置');

        const headers = config.map(col => col.header);
        const rows = data.map(row =>
            config.map(col => {
                const value = row[col.key];
                if (value === null || value === undefined) return '';
                const strValue = String(value);
                if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
                    return `"${strValue.replace(/"/g, '""')}"`;
                }
                return strValue;
            }).join(',')
        );

        return [
            headers.join(','),
            ...rows
        ].join('\n');
    }

    /**
     * 执行导出
     */
    async execute(type, format, startDate, endDate, filters = {}) {
        this.validateExportType(type);
        this.validateFormat(format);

        let data;
        switch (type) {
            case AdvancedExportService.EXPORT_TYPES.TEACHER_INFO:
                data = await this.exportTeacherInfo();
                break;
            case AdvancedExportService.EXPORT_TYPES.STUDENT_INFO:
                data = await this.exportStudentInfo();
                break;
            case AdvancedExportService.EXPORT_TYPES.TEACHER_SCHEDULE:
                data = await this.exportTeacherSchedule(startDate, endDate, filters);
                break;
            case AdvancedExportService.EXPORT_TYPES.STUDENT_SCHEDULE:
                data = await this.exportStudentSchedule(startDate, endDate);
                break;
            default:
                throw new Error('未知的导出类型');
        }

        if (format === 'excel') {
            return {
                format: 'excel',
                data: this.toExcelFormat(data, type),
                columns: this.getExcelColumnWidths(type),
                filename: `${this.getExportFilename(type)}.xlsx`
            };
        } else {
            return {
                format: 'csv',
                data: this.toCsvFormat(data, type),
                filename: `${this.getExportFilename(type)}.csv`
            };
        }
    }

    /**
     * 获取导出文件名
     */
    getExportFilename(type) {
        const now = new Date().toISOString().split('T')[0];
        const typeNames = {
            [AdvancedExportService.EXPORT_TYPES.TEACHER_INFO]: `教师信息_${now}`,
            [AdvancedExportService.EXPORT_TYPES.STUDENT_INFO]: `学生信息_${now}`,
            [AdvancedExportService.EXPORT_TYPES.TEACHER_SCHEDULE]: `教师排课记录_${now}`,
            [AdvancedExportService.EXPORT_TYPES.STUDENT_SCHEDULE]: `学生排课记录_${now}`
        };
        return typeNames[type] || '导出数据';
    }

    /**
     * Format date time
     */
    formatDateTime(value) {
        if (!value) return '';
        try {
            return new Date(value).toLocaleString('zh-CN', { hour12: false });
        } catch (e) {
            return String(value);
        }
    }

}

module.exports = AdvancedExportService;
