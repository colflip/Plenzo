// 在主应用启动时运行数据库迁移
const db = require('./db');

async function runDatabaseMigrations() {
    try {
        // 检查是否需要添加 updated_at 列
        const result = await db.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name = 'teacher_daily_availability'
              AND column_name = 'updated_at'
        `);

        if (result.rows.length === 0) {
            // 添加 updated_at 列
            await db.query(`
                ALTER TABLE teacher_daily_availability
                ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            `);

            // 创建更新触发器函数
            await db.query(`
                CREATE OR REPLACE FUNCTION update_updated_at()
                RETURNS TRIGGER AS $$
                BEGIN
                    NEW.updated_at = CURRENT_TIMESTAMP;
                    RETURN NEW;
                END;
                $$ LANGUAGE plpgsql
            `);

            // 创建触发器（分两步执行，避免 Neon 不支持多条语句）
            await db.query(`
                DROP TRIGGER IF EXISTS tr_teacher_daily_availability_updated_at ON teacher_daily_availability
            `);
            await db.query(`
                CREATE TRIGGER tr_teacher_daily_availability_updated_at
                BEFORE UPDATE ON teacher_daily_availability
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at()
            `);

            console.log('数据库迁移完成：添加更新时间字段');
        }

        // 添加 course_arrangement 的费用字段 和 teachers 的 student_ids 字段
        const feesResult = await db.query(`
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_schema = 'public' 
              AND table_name = 'course_arrangement'
              AND column_name = 'transport_fee'
        `);

        if (feesResult.rows.length === 0) {
            await db.query(`ALTER TABLE course_arrangement ADD COLUMN IF NOT EXISTS transport_fee DECIMAL(10,2) DEFAULT 0`);
            await db.query(`ALTER TABLE course_arrangement ADD COLUMN IF NOT EXISTS other_fee DECIMAL(10,2) DEFAULT 0`);
            await db.query(`ALTER TABLE teachers ADD COLUMN IF NOT EXISTS student_ids VARCHAR(500)`);
            await db.query(`COMMENT ON COLUMN course_arrangement.transport_fee IS '交通费'`);
            await db.query(`COMMENT ON COLUMN course_arrangement.other_fee IS '其他费用'`);
            await db.query(`COMMENT ON COLUMN teachers.student_ids IS '关联学生ID列表 (逗号分隔)'`);
            console.log('数据库迁移完成：添加 transport_fee, other_fee 和 student_ids 字段');
        }

        // 检查是否需要添加 fee_audit_logs 表
        const feeAuditTableResult = await db.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
              AND table_name = 'fee_audit_logs'
        `);

        if (feeAuditTableResult.rows.length === 0) {
            await db.query(`
                CREATE TABLE public.fee_audit_logs (
                    id SERIAL PRIMARY KEY,
                    schedule_id INTEGER NOT NULL REFERENCES public.course_arrangement(id) ON DELETE CASCADE,
                    operator_id INTEGER NOT NULL,
                    operator_role VARCHAR(20) NOT NULL,
                    old_transport_fee DECIMAL(10,2) DEFAULT 0,
                    new_transport_fee DECIMAL(10,2) DEFAULT 0,
                    old_other_fee DECIMAL(10,2) DEFAULT 0,
                    new_other_fee DECIMAL(10,2) DEFAULT 0,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await db.query(`CREATE INDEX idx_fee_audit_logs_schedule ON public.fee_audit_logs(schedule_id)`);
            await db.query(`CREATE INDEX idx_fee_audit_logs_operator ON public.fee_audit_logs(operator_id, operator_role)`);
            await db.query(`COMMENT ON TABLE public.fee_audit_logs IS '排课费用修改审计日志表'`);
            console.log('数据库迁移完成：添加 fee_audit_logs 表');
        }

    } catch (error) {
        console.error('数据库迁移失败:', error);
        // 不要因为迁移失败而中断应用启动
    }
}

module.exports = runDatabaseMigrations;