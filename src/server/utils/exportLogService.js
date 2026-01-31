/**
 * 导出操作日志服务
 * 记录所有数据导出操作，便于审计和问题排查
 */

class ExportLogService {
    constructor(db) {
        this.db = db;
    }

    /**
     * 初始化导出日志表（首次运行）
     */
    async initTable() {
        try {
            const query = `
                CREATE TABLE IF NOT EXISTS export_logs (
                    id SERIAL PRIMARY KEY,
                    admin_id INTEGER,
                    admin_name VARCHAR(255),
                    export_type VARCHAR(50) NOT NULL,
                    export_format VARCHAR(20) NOT NULL,
                    start_date DATE,
                    end_date DATE,
                    record_count INTEGER DEFAULT 0,
                    file_size BIGINT,
                    file_name VARCHAR(255),
                    status VARCHAR(20) NOT NULL,
                    error_message TEXT,
                    duration_ms INTEGER,
                    ip_address VARCHAR(45),
                    user_agent TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    completed_at TIMESTAMP,
                    INDEX idx_admin_id (admin_id),
                    INDEX idx_created_at (created_at),
                    INDEX idx_export_type (export_type)
                );
            `;

            await this.db.query(query);
            console.log('导出日志表已初始化');
        } catch (error) {
            if (error.message.includes('already exists')) {
                // 表已存在，不处理
            } else {
                console.error('初始化导出日志表失败:', error);
                throw error;
            }
        }
    }

    /**
     * 记录导出开始
     */
    async logExportStart(adminId, adminName, exportType, exportFormat, options = {}) {
        try {
            const query = `
                INSERT INTO export_logs (
                    admin_id, admin_name, export_type, export_format,
                    start_date, end_date, ip_address, user_agent, status
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'STARTED')
                RETURNING id
            `;

            const result = await this.db.query(query, [
                adminId,
                adminName,
                exportType,
                exportFormat,
                options.startDate || null,
                options.endDate || null,
                options.ipAddress || null,
                options.userAgent || null
            ]);

            return result.rows[0].id;
        } catch (error) {
            console.error('记录导出开始失败:', error);
            throw error;
        }
    }

    /**
     * 记录导出完成
     */
    async logExportComplete(logId, recordCount, fileSize, fileName) {
        try {
            const query = `
                UPDATE export_logs 
                SET 
                    status = 'COMPLETED',
                    record_count = $2,
                    file_size = $3,
                    file_name = $4,
                    completed_at = CURRENT_TIMESTAMP,
                    duration_ms = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) * 1000
                WHERE id = $1
            `;

            await this.db.query(query, [logId, recordCount, fileSize, fileName]);
        } catch (error) {
            console.error('记录导出完成失败:', error);
            throw error;
        }
    }

    /**
     * 记录导出失败
     */
    async logExportFailure(logId, errorMessage) {
        try {
            const query = `
                UPDATE export_logs 
                SET 
                    status = 'FAILED',
                    error_message = $2,
                    completed_at = CURRENT_TIMESTAMP,
                    duration_ms = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - created_at)) * 1000
                WHERE id = $1
            `;

            await this.db.query(query, [logId, errorMessage]);
        } catch (error) {
            console.error('记录导出失败失败:', error);
            throw error;
        }
    }

    /**
     * 查询导出日志
     */
    async queryLogs(filters = {}) {
        try {
            let query = 'SELECT * FROM export_logs WHERE 1=1';
            const params = [];
            let paramCount = 1;

            // 按管理员 ID 筛选
            if (filters.adminId) {
                query += ` AND admin_id = $${paramCount++}`;
                params.push(filters.adminId);
            }

            // 按导出类型筛选
            if (filters.exportType) {
                query += ` AND export_type = $${paramCount++}`;
                params.push(filters.exportType);
            }

            // 按状态筛选
            if (filters.status) {
                query += ` AND status = $${paramCount++}`;
                params.push(filters.status);
            }

            // 按日期范围筛选
            if (filters.startDate) {
                query += ` AND created_at >= $${paramCount++}`;
                params.push(filters.startDate);
            }
            if (filters.endDate) {
                query += ` AND created_at <= $${paramCount++}`;
                params.push(filters.endDate);
            }

            query += ' ORDER BY created_at DESC LIMIT 1000';

            const result = await this.db.query(query, params);
            return result.rows || [];
        } catch (error) {
            console.error('查询导出日志失败:', error);
            throw error;
        }
    }

    /**
     * 获取导出统计
     */
    async getExportStats(days = 30) {
        try {
            const query = `
                SELECT
                    export_type,
                    COUNT(*) as total_count,
                    SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) as success_count,
                    SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) as failure_count,
                    AVG(CASE WHEN status = 'COMPLETED' THEN duration_ms ELSE NULL END) as avg_duration_ms,
                    SUM(CASE WHEN status = 'COMPLETED' THEN record_count ELSE 0 END) as total_records,
                    SUM(CASE WHEN status = 'COMPLETED' THEN file_size ELSE 0 END) as total_file_size
                FROM export_logs
                WHERE created_at >= NOW() - INTERVAL '${days} days'
                GROUP BY export_type
                ORDER BY total_count DESC
            `;

            const result = await this.db.query(query);
            return result.rows || [];
        } catch (error) {
            console.error('获取导出统计失败:', error);
            throw error;
        }
    }

    /**
     * 获取用户导出历史
     */
    async getUserExportHistory(adminId, limit = 100) {
        try {
            const query = `
                SELECT 
                    id, export_type, export_format, record_count, file_size,
                    file_name, status, created_at, completed_at, duration_ms
                FROM export_logs
                WHERE admin_id = $1
                ORDER BY created_at DESC
                LIMIT $2
            `;

            const result = await this.db.query(query, [adminId, limit]);
            return result.rows || [];
        } catch (error) {
            console.error('获取用户导出历史失败:', error);
            throw error;
        }
    }

    /**
     * 清理过期日志（保留指定天数）
     */
    async cleanupOldLogs(daysToKeep = 90) {
        try {
            const query = `
                DELETE FROM export_logs
                WHERE created_at < NOW() - INTERVAL '${daysToKeep} days'
            `;

            const result = await this.db.query(query);
            return result.rowCount;
        } catch (error) {
            console.error('清理过期日志失败:', error);
            throw error;
        }
    }
}

module.exports = ExportLogService;
