const logger = require('./logger.js');
/**
 * 导出操作日志服务
 * 记录所有端的导出操作，用于监控和分析
 * 支持: admin, teacher, student, teacher_homeroom
 */

class ExportLogService {
    constructor(db) {
        this.db = db;
    }

    // 表结构与扩展列的建表/加列语句已移到 db/migrations.js 的 legacy_migrations@v4 批次，
    // 启动时执行一次。原来它们挂在 logExportStart 上、还与取数查询并发发出 ——
    // 于是每个 serverless 实例的第一次导出都会对生产库施 DDL 并占着这个请求
    // （11 个条件 ALTER + 2 个 CREATE INDEX，审查报告 P2-18）。

    async logExportStart(details) {
        const {
            userId,
            userType,
            startDate,
            endDate,
            studentId,
            teacherId,
            exportType
        } = details;

        try {
            const result = await this.db.query(`
                INSERT INTO export_logs (
                    exported_by,
                    user_id,
                    user_type,
                    export_type,
                    start_date,
                    end_date,
                    student_id,
                    teacher_id,
                    status,
                    exported_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'in_progress', NOW())
                RETURNING id
            `, [
                userId || null,           // exported_by (兼容旧字段)
                userId || null,           // user_id (新字段)
                userType || 'unknown',    // user_type
                exportType || 'advanced', // export_type
                startDate || null,        // start_date
                endDate || null,          // end_date
                studentId || null,        // student_id
                teacherId || null         // teacher_id
            ]);

            return result.rows[0]?.id;
        } catch (error) {
            logger.warn('记录导出开始日志失败（非致命错误）:', error.message);
            return null;
        }
    }

    /**
     * 记录导出成功
     */
    async logExportSuccess(logId, details) {
        if (!logId) return;

        const {
            recordCount,
            fileSize,
            fileName,
            duration
        } = details;

        try {
            await this.db.query(`
                UPDATE export_logs
                SET status = 'success',
                    record_count = $2,
                    file_size = $3,
                    file_name = $4,
                    duration_ms = $5
                WHERE id = $1
            `, [logId, recordCount || 0, fileSize || 0, fileName || '', duration || 0]);
        } catch (error) {
            logger.warn('记录导出成功日志失败（非致命错误）:', error.message);
        }
    }

    /**
     * 记录导出失败
     */
    async logExportError(logId, errorMessage) {
        if (!logId) return;

        try {
            await this.db.query(`
                UPDATE export_logs
                SET status = 'failed',
                    error_message = $2
                WHERE id = $1
            `, [logId, errorMessage || '未知错误']);
        } catch (error) {
            logger.warn('记录导出失败日志失败（非致命错误）:', error.message);
        }
    }

    /**
     * 获取导出统计
     */
    async getExportStats(userType, days = 7) {
        try {
            const result = await this.db.query(`
                SELECT
                    COUNT(*) as total_exports,
                    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as successful,
                    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                    AVG(CASE WHEN status = 'success' THEN duration_ms END) as avg_duration_ms,
                    AVG(CASE WHEN status = 'success' THEN record_count END) as avg_record_count,
                    AVG(CASE WHEN status = 'success' THEN file_size END) as avg_file_size
                FROM export_logs
                WHERE user_type = $1
                AND exported_at >= NOW() - INTERVAL '1 day' * $2
            `, [userType, parseInt(days, 10) || 7]);

            return result.rows[0];
        } catch (error) {
            logger.warn('获取导出统计失败:', error.message);
            return null;
        }
    }
}

module.exports = ExportLogService;
