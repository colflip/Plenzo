const logger = require('../../utils/logger.js');
/**
 * 排课数据查询模块（Schedule Queries）
 * 提供教师/学生信息查询和排课数据查询能力（纯数据层，不依赖任何 Excel 生成逻辑）
 * 供 sheet-builder 与各控制器使用
 *
 * 通用工具方法（validateDateRange, validateDataSize, sanitizeValue）委托给 ExportUtils
 */

const db = require('../../db/db');
const { EXPORT_LIMITS } = require('./export-constants');
const ExportUtils = require('../../utils/export-utils');
const SchemaHelper = require('../../utils/schema-helper');
const { formatDateTime } = require('../../utils/shared-utils');

class AdvancedExportService {
    constructor() {
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
        // 新表日期列固定 class_date（v_session_pairs 透出同名列），不再需要动态列探测
        return 'ca.class_date';
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
            LEFT JOIN v_session_pairs ca ON t.id = ca.teacher_id
            GROUP BY t.id, t.username, t.name, t.profession, t.contact,
                     t.work_location, t.home_address, t.last_login, t.created_at
            ORDER BY t.created_at DESC
        `;

        const result = await db.query(query);
        const rows = result.rows || [];

        // 验证数据量
        this.validateDataSize(rows.length);

        // 数据转换
        return rows.map(row => ({
            ...row,
            completion_rate: row.total_schedules > 0
                ? ((row.confirmed_schedules / row.total_schedules) * 100).toFixed(2) + '%'
                : '0%',
            created_at: formatDateTime(row.created_at),
            last_login: formatDateTime(row.last_login)
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
            LEFT JOIN v_session_pairs ca ON s.id = ca.student_id
            GROUP BY s.id, s.username, s.name, s.profession, s.contact,
                     s.visit_location, s.home_address, s.last_login, s.created_at
            ORDER BY s.created_at DESC
        `;

        const result = await db.query(query);
        const rows = result.rows || [];

        // 验证数据量
        this.validateDataSize(rows.length);

        // 数据转换
        return rows.map(row => ({
            ...row,
            participation_rate: row.total_schedules > 0
                ? ((row.confirmed_schedules / row.total_schedules) * 100).toFixed(2) + '%'
                : '0%',
            created_at: formatDateTime(row.created_at),
            last_login: formatDateTime(row.last_login)
        }));
    }


    /**
     * 查询教师排课数据 (支持过滤)
     * 优化：只选择需要的列，避免 SELECT *
     * @param {string} startDate - 开始日期
     * @param {string} endDate - 结束日期
     * @param {Object} filters - { teacher_id?, student_id?, student_ids? }
     *                           student_ids 为学生 ID 数组（班主任按绑定学生范围导出时使用）
     */
    async queryTeacherSchedule(startDate, endDate, filters) {
        const dateExpr = await this.getDateExpression();
        let query = `
SELECT
    ca.session_id as schedule_id,
    ca.teacher_uid,
    ca.student_uid,
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
    ca.auto_at AS last_auto_update,
    ca.created_by,
    ca.transport_fee,
    ca.other_fee,
    ca.fee_status,
    ca.family_participants,
    ca.teacher_rating,
    ca.student_rating,
    ca.student_comment,
    ca.status_category
FROM v_session_pairs ca
LEFT JOIN teachers t ON ca.teacher_id = t.id
LEFT JOIN students s ON ca.student_id = s.id
LEFT JOIN schedule_types st ON ca.type_id = st.id
WHERE ${dateExpr}::date BETWEEN $1 AND $2
  AND ca.status <> 'deleted'`;

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
        if (Array.isArray(filters.student_ids) && filters.student_ids.length > 0) {
            values.push(filters.student_ids);
            query += ` AND ca.student_id = ANY($${values.length}::int[]) `;
        }

        query += ` ORDER BY ${dateExpr} DESC, ca.start_time ASC`;

        const queryStartTime = Date.now();
        const result = await db.query(query, values);
        const queryTime = Date.now() - queryStartTime;

        logger.log(`[Performance] queryTeacherSchedule - 查询耗时: ${queryTime}ms, 记录数: ${result.rows?.length || 0}`);

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
    ca.session_id as schedule_id,
    ca.teacher_uid,
    ca.student_uid,
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
    ca.auto_at AS last_auto_update,
    ca.created_by,
    ca.transport_fee,
    ca.other_fee,
    ca.fee_status,
    ca.status_category
FROM v_session_pairs ca
LEFT JOIN students s ON ca.student_id = s.id
LEFT JOIN teachers t ON ca.teacher_id = t.id
LEFT JOIN schedule_types st ON ca.type_id = st.id
WHERE ${dateExpr}::date BETWEEN $1 AND $2
  AND ca.status <> 'deleted'
        `;

        const values = [startDate, endDate];

        if (filters.student_id) {
            values.push(filters.student_id);
            query += ` AND ca.student_id = $${values.length} `;
        }

        query += ` ORDER BY ${dateExpr} DESC, ca.start_time ASC`;

        const queryStartTime = Date.now();
        const result = await db.query(query, values);
        const queryTime = Date.now() - queryStartTime;

        logger.log(`[Performance] queryStudentSchedule - 查询耗时: ${queryTime}ms, 记录数: ${result.rows?.length || 0}`);

        return result.rows || [];
    }

}

module.exports = new AdvancedExportService();
