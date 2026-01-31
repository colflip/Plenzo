// 在主应用启动时运行数据库迁移
const db = require('./db/db');

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

            // 创建触发器
            await db.query(`
                DROP TRIGGER IF EXISTS tr_teacher_daily_availability_updated_at ON teacher_daily_availability;
                CREATE TRIGGER tr_teacher_daily_availability_updated_at
                BEFORE UPDATE ON teacher_daily_availability
                FOR EACH ROW
                EXECUTE FUNCTION update_updated_at()
            `);

            console.log('数据库迁移完成：添加更新时间字段');
        }
    } catch (error) {
        console.error('数据库迁移失败:', error);
        // 不要因为迁移失败而中断应用启动
    }
}

module.exports = runDatabaseMigrations;