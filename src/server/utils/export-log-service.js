/**
 * 导出操作日志服务
 * 记录所有端的导出操作，用于监控和分析
 * 支持: admin, teacher, student, teacher_homeroom
 */

class ExportLogService {
    constructor(db) {
        this.db = db;
    }

    /**
     * 确保表结构包含所需字段
     * 兼容旧表结构，添加新字段
     * 使用 Promise 缓存避免并发重复执行
     */
    async ensureSchema() {
        // 使用类级别的 Promise 缓存，避免并发执行
        if (!ExportLogService._schemaCheckPromise) {
            ExportLogService._schemaCheckPromise = this._doEnsureSchema();
        }
        return ExportLogService._schemaCheckPromise;
    }

    async _doEnsureSchema() {
        try {
            // 合并所有列检查为单次查询，减少 DB 往返（11 次 → 1 次）
            await this.db.query(`
                DO $$
                BEGIN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'user_type') THEN
                        ALTER TABLE export_logs ADD COLUMN user_type VARCHAR(50);
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'user_id') THEN
                        ALTER TABLE export_logs ADD COLUMN user_id INTEGER;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'start_date') THEN
                        ALTER TABLE export_logs ADD COLUMN start_date DATE;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'end_date') THEN
                        ALTER TABLE export_logs ADD COLUMN end_date DATE;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'record_count') THEN
                        ALTER TABLE export_logs ADD COLUMN record_count INTEGER;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'file_size') THEN
                        ALTER TABLE export_logs ADD COLUMN file_size BIGINT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'duration_ms') THEN
                        ALTER TABLE export_logs ADD COLUMN duration_ms INTEGER;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'error_message') THEN
                        ALTER TABLE export_logs ADD COLUMN error_message TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'student_id') THEN
                        ALTER TABLE export_logs ADD COLUMN student_id INTEGER;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'teacher_id') THEN
                        ALTER TABLE export_logs ADD COLUMN teacher_id INTEGER;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'export_logs' AND column_name = 'file_name') THEN
                        ALTER TABLE export_logs ADD COLUMN file_name VARCHAR(255);
                    END IF;
                END $$;

                CREATE INDEX IF NOT EXISTS idx_export_logs_user ON export_logs(user_id, user_type);
                CREATE INDEX IF NOT EXISTS idx_export_logs_exported_at ON export_logs(exported_at);
            `);

        } catch (error) {
            console.warn('扩展导出日志表结构失败（非致命错误）:', error.message);
        }
    }

    /**
     * 记录导出开始
     * @returns {number|null} logId - 日志ID，用于后续更新
     */
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
            // 确保表结构（使用类级别的 Promise 缓存）
            await this.ensureSchema();

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
            console.warn('记录导出开始日志失败（非致命错误）:', error.message);
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
            console.warn('记录导出成功日志失败（非致命错误）:', error.message);
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
            console.warn('记录导出失败日志失败（非致命错误）:', error.message);
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
            console.warn('获取导出统计失败:', error.message);
            return null;
        }
    }
}

module.exports = ExportLogService;
