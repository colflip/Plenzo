/**
 * 高级数据导出处理模块
 * 提供教师/学生信息查询和排课数据查询能力
 * 供 UnifiedExportService 和 adminController 使用
 *
 * 通用工具方法（validateDateRange, validateDataSize, sanitizeValue）委托给 ExportUtils
 */

const enhancedExcel = require('./enhancedExcelService');
const { EXPORT_LIMITS } = require('./export/ExportConstants');
const ExportUtils = require('../utils/exportUtils');
const SchemaHelper = require('../utils/schemaHelper');

class AdvancedExportService {
    constructor(db) {
        this.db = db;
        this.MAX_RECORDS = EXPORT_LIMITS.MAX;
        this.MAX_DATE_RANGE = 365; // 天
    }

    /**
     * 验证日期范围（委托给 ExportUtils）
     * @param {string} startDate - 开始日期 (YYYY-MM-DD)
     * @param {string} endDate - 结束日期 (YYYY-MM-DD)
     */
    validateDateRange(startDate, endDate) {
        if (!startDate || !endDate) {
            throw new Error('开始日期和结束日期不能为空');
        }
        ExportUtils.validateDateRange(startDate, endDate, this.MAX_DATE_RANGE);
    }

    /**
     * 验证数据量（委托给 ExportUtils）
     * @param {number} count - 记录数
     */
    validateDataSize(count) {
        ExportUtils.validateDataSize(count, this.MAX_RECORDS);
    }

    /**
     * 脱敏处理（委托给 ExportUtils）
     * @param {any} value - 要脱敏的值
     * @returns {string} 脱敏后的字符串
     */
    sanitizeValue(value) {
        return ExportUtils.sanitizeValue(value);
    }

    /**
     * 获取日期表达式（兼容多种日期列名）
     * 委托给 SchemaHelper 统一处理
     */
    async getDateExpression() {
        return SchemaHelper.getDateExpr('ca');
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
            created_at: enhancedExcel.formatDateTime(row.created_at),
            last_login: enhancedExcel.formatDateTime(row.last_login)
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
            created_at: enhancedExcel.formatDateTime(row.created_at),
            last_login: enhancedExcel.formatDateTime(row.last_login)
        }));
    }


    /**
     * 查询教师排课数据 (支持过滤)
     * 优化：只选择需要的列，避免 SELECT *
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
    ${dateExpr}::date as date,
    ca.start_time,
    ca.end_time,
    (TO_CHAR(ca.start_time, 'HH24:MI') || '-' || TO_CHAR(ca.end_time, 'HH24:MI')) as time_range,
    ca.location,
    st.id as course_id,
    st.name as type_name,
    COALESCE(st.description, st.name) as type_desc,
    ca.status,
    ca.teacher_comment as notes,
    ca.created_at,
    ca.updated_at,
    ca.last_auto_update,
    ca.created_by,
    ca.transport_fee,
    ca.other_fee,
    ca.family_participants,
    ca.teacher_rating,
    ca.student_rating,
    ca.student_comment,
    ca.adjustment_type
FROM course_arrangement ca
LEFT JOIN teachers t ON ca.teacher_id = t.id
LEFT JOIN students s ON ca.student_id = s.id
LEFT JOIN schedule_types st ON ca.course_id = st.id
WHERE ${dateExpr}::date BETWEEN $1 AND $2
  AND ca.status NOT IN ('cancelled', 'deleted')
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

        const queryStartTime = Date.now();
        const result = await this.db.query(query, values);
        const queryTime = Date.now() - queryStartTime;

        console.log(`[Performance] queryTeacherSchedule - 查询耗时: ${queryTime}ms, 记录数: ${result.rows?.length || 0}`);

        return result.rows || [];
    }

    /**
     * 查询学生排课数据
     * 优化：只选择需要的列，避免 SELECT *
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
    ${dateExpr}::date as date,
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
    ca.other_fee,
    ca.adjustment_type
FROM course_arrangement ca
LEFT JOIN students s ON ca.student_id = s.id
LEFT JOIN teachers t ON ca.teacher_id = t.id
LEFT JOIN schedule_types st ON ca.course_id = st.id
WHERE ${dateExpr}::date BETWEEN $1 AND $2
  AND ca.status NOT IN ('cancelled', 'deleted')
        `;

        const values = [startDate, endDate];

        if (filters.student_id) {
            values.push(filters.student_id);
            query += ` AND ca.student_id = $${values.length} `;
        }

        query += ` ORDER BY ${dateExpr} DESC, ca.start_time ASC`;

        const queryStartTime = Date.now();
        const result = await this.db.query(query, values);
        const queryTime = Date.now() - queryStartTime;

        console.log(`[Performance] queryStudentSchedule - 查询耗时: ${queryTime}ms, 记录数: ${result.rows?.length || 0}`);

        return result.rows || [];
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
            course_id: row.course_id,
            type: this.sanitizeValue(row.type_name),
            type_desc: this.sanitizeValue(row.type_desc),
            status: row.status,
            notes: this.sanitizeValue(row.notes),
            created_at: row.created_at,
            updated_at: row.updated_at,
            last_auto_update: row.last_auto_update,
            created_by: row.created_by,
            transport_fee: row.transport_fee,
            other_fee: row.other_fee,
            family_participants: row.family_participants,
            teacher_rating: row.teacher_rating,
            teacher_comment: this.sanitizeValue(row.notes),
            student_rating: row.student_rating,
            student_comment: this.sanitizeValue(row.student_comment),
            adjustment_type: row.adjustment_type
        }));
    }

    async exportStudentSchedule(startDate, endDate, filters = {}) {
        const rows = await this.queryStudentSchedule(startDate, endDate, filters);
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
            other_fee: row.other_fee,
            adjustment_type: row.adjustment_type
        }));
    }

}

module.exports = AdvancedExportService;
