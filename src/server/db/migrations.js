const logger = require('../utils/logger.js');
// 在主应用启动时运行数据库迁移
const db = require('./db');
const { tableExists } = require('./table-utils');
const { migrateCourseSessions, isApplied, markApplied } = require('./migrations-course-sessions');

/**
 * 历史迁移批次的版本标记。**往下面那个 try 块里加任何迁移语句，都要把尾号 +1**，
 * 否则新语句不会在已部署的库上执行。
 *
 * 为什么要标记：这批语句全是 information_schema 探测 + 条件 DDL，语义上幂等，
 * 但在远程 Neon 上每条约 250ms，十几条就是 3 秒；而迁移是 app.js 模块加载时
 * fire-and-forget 发出的，正好和首批用户请求抢同一个连接池。加标记后稳态是 0 条。
 */
const LEGACY_SCHEMA_KEY = 'legacy_migrations@v1';

async function runDatabaseMigrations() {
    // course_sessions 先跑，并独占一个 try/catch。
    // 下面那一批历史迁移共用一个「记日志但不中断启动」的 catch，任何一条语句报错都会
    // 静默跳过它之后的全部语句 —— 旧表 course_arrangement 一旦改名/删除，那些针对它的
    // ALTER 就会硬报错。course_sessions 是运行时唯一使用的排课表，不能被这类失败带下去。
    try {
        await migrateCourseSessions();
    } catch (error) {
        // 打印因果链而非整个 Error 对象：undici 的 "fetch failed" 只有展开 cause
        // 才能看出是 DNS / 超时 / TLS；直接打对象则是一屏堆栈，信息量反而更低。
        logger.error('course_sessions 迁移失败:', db.describeError(error));
    }

    try {
        if (await isApplied(LEGACY_SCHEMA_KEY)) return;

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

            logger.log('数据库迁移完成：添加更新时间字段');
        }

        // teachers.student_ids：班主任绑定的学生列表，与旧排课表无关，任何时候都要保证存在
        const teacherStudentIdsResult = await db.query(`
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'teachers'
              AND column_name = 'student_ids'
        `);
        if (teacherStudentIdsResult.rows.length === 0) {
            await db.query(`ALTER TABLE teachers ADD COLUMN IF NOT EXISTS student_ids VARCHAR(500)`);
            await db.query(`COMMENT ON COLUMN teachers.student_ids IS '关联学生ID列表 (逗号分隔)'`);
            logger.log('数据库迁移完成：添加 teachers.student_ids 字段');
        }

        // ↓↓↓ 以下针对旧排课表 course_arrangement 的迁移块只在该表仍存在时执行。
        // 排课运行时已全量迁到 course_sessions（见 migrations-course-sessions.js），旧表按计划
        // 阶段 7 改名归档；改名后这些 ALTER 会硬报错，而它们与下方 holidays / feedbacks /
        // ai_config / nickname / availability 等迁移共用一个 catch，报错会把后面的语句一起跳过。
        // 因此统一用一次探测门控，等旧表 DROP 后整块删除即可。
        const hasLegacyArrangement = await tableExists('course_arrangement');

        if (hasLegacyArrangement) {
            // 添加 course_arrangement 的费用字段
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
                await db.query(`COMMENT ON COLUMN course_arrangement.transport_fee IS '交通费'`);
                await db.query(`COMMENT ON COLUMN course_arrangement.other_fee IS '其他费用'`);
                logger.log('数据库迁移完成：添加 transport_fee, other_fee 字段');
            }

            // 让 transport_fee / other_fee 能区分「未填写」(NULL) 与「填写 0」(0)
            // 列本身无 NOT NULL，仅移除 DEFAULT 0：新排课默认 NULL = 未填写；
            // 用户主动「清除费用」仍显式写入 0，与从未填写区分。幂等。
            const feeDefaultResult = await db.query(`
                SELECT column_name, column_default
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'course_arrangement'
                  AND column_name IN ('transport_fee', 'other_fee')
            `);
            const needsDropDefault = (feeDefaultResult.rows || []).some(r => r.column_default !== null && r.column_default !== 'NULL');
            if (needsDropDefault) {
                await db.query(`ALTER TABLE course_arrangement ALTER COLUMN transport_fee DROP DEFAULT`);
                await db.query(`ALTER TABLE course_arrangement ALTER COLUMN other_fee DROP DEFAULT`);
                logger.log('数据库迁移完成：transport_fee/other_fee 移除默认值（NULL=未填写，0=已填0）');
            }

            // 检查是否需要添加 fee_audit_logs 表（schedule_id 外键指向 course_arrangement，
            // 所以它与旧表同生共死；新表的对应审计表是 session_fee_audit_logs）
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
                logger.log('数据库迁移完成：添加 fee_audit_logs 表');
            }
        }

        // 检查是否需要添加 holidays 表
        const holidaysTableResult = await db.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'holidays'
        `);

        if (holidaysTableResult.rows.length === 0) {
            await db.query(`
                CREATE TABLE public.holidays (
                    id SERIAL PRIMARY KEY,
                    year INTEGER NOT NULL,
                    type VARCHAR(20) NOT NULL,
                    label VARCHAR(100) NOT NULL,
                    start_date DATE NOT NULL,
                    end_date DATE NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await db.query(`CREATE INDEX idx_holidays_year ON public.holidays(year)`);
            await db.query(`COMMENT ON TABLE public.holidays IS '节假日/调休补班配置表'`);
            logger.log('数据库迁移完成：添加 holidays 表');
        }

        // 检查是否需要添加 feedbacks 表（用户反馈/Bug 报告/新功能需求）
        const feedbacksTableResult = await db.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'feedbacks'
        `);

        if (feedbacksTableResult.rows.length === 0) {
            await db.query(`
                CREATE TABLE public.feedbacks (
                    id SERIAL PRIMARY KEY,
                    type VARCHAR(20) NOT NULL,
                    priority VARCHAR(10) NOT NULL DEFAULT 'medium',
                    title VARCHAR(120) NOT NULL,
                    description TEXT NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'open',
                    submitter_id INTEGER,
                    submitter_role VARCHAR(20),
                    submitter_name VARCHAR(80),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await db.query(`CREATE INDEX idx_feedbacks_status ON public.feedbacks(status)`);
            await db.query(`CREATE INDEX idx_feedbacks_submitter ON public.feedbacks(submitter_id, submitter_role)`);
            await db.query(`COMMENT ON TABLE public.feedbacks IS '用户反馈/Bug/新功能需求表'`);
            logger.log('数据库迁移完成：添加 feedbacks 表');
        }

        // Migration: Add nickname column to teachers, students and administrators
        const nicknameTables = ['teachers', 'students', 'administrators'];
        for (const table of nicknameTables) {
            const nicknameResult = await db.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = '${table}'
                  AND column_name = 'nickname'
            `);
            if ((nicknameResult.rows || []).length === 0) {
                await db.query(`ALTER TABLE ${table} ADD COLUMN nickname VARCHAR(50)`);
                logger.log(`[Migration] Added nickname column to ${table}`);
            }
        }

        // 检查是否需要添加 ai_config 表（AI 运行时配置持久化）
        // 替代老旧的「运行时读写 .env 文件」方案：该方案在 Vercel 等 Serverless
        // 环境下会因 /var/task/.env 不存在而崩溃（ENOENT），且只读文件系统 +
        // 实例无状态导致修改无法跨请求生效。改用数据库单行持久化。
        const aiConfigTableResult = await db.query(`
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_name = 'ai_config'
        `);

        if (aiConfigTableResult.rows.length === 0) {
            await db.query(`
                CREATE TABLE public.ai_config (
                    id INTEGER PRIMARY KEY DEFAULT 1,
                    provider VARCHAR(50) NOT NULL DEFAULT 'deepseek',
                    protocol VARCHAR(20) NOT NULL DEFAULT 'openai',
                    api_key TEXT,
                    base_url TEXT,
                    model VARCHAR(100),
                    timeout INTEGER NOT NULL DEFAULT 30000,
                    max_tokens INTEGER NOT NULL DEFAULT 8000,
                    enabled BOOLEAN NOT NULL DEFAULT false,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await db.query(`COMMENT ON TABLE public.ai_config IS 'AI 运行时配置（管理后台动态切换模型，持久化以跨 Serverless 实例生效）'`);
            logger.log('数据库迁移完成：添加 ai_config 表');
        }

        if (hasLegacyArrangement) {
            // 费用报销状态：course_arrangement.fee_status 字段 + fee_status_logs 审计表
            const feeStatusColResult = await db.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'course_arrangement'
                  AND column_name = 'fee_status'
            `);
            if (feeStatusColResult.rows.length === 0) {
                await db.query(`ALTER TABLE course_arrangement ADD COLUMN IF NOT EXISTS fee_status VARCHAR(32) DEFAULT 'draft'`);
                await db.query(`CREATE INDEX IF NOT EXISTS idx_ca_fee_status_date ON course_arrangement(fee_status, class_date)`);
                await db.query(`COMMENT ON COLUMN course_arrangement.fee_status IS '费用报销状态: draft 待提交 / teacher_submitted 待审核 / admin_submitted 已审核 / reimbursed 已报销 / returned 已退回 / reimbursement_returned 退回报销'`);
                logger.log('数据库迁移完成：添加 course_arrangement.fee_status 字段');
            }
            // 确保 CHECK 约束覆盖最新枚举（先删后建，幂等；兼容已部署旧约束）
            await db.query(`ALTER TABLE course_arrangement DROP CONSTRAINT IF EXISTS chk_ca_fee_status`);
            await db.query(`ALTER TABLE course_arrangement ADD CONSTRAINT chk_ca_fee_status CHECK (fee_status IN ('draft','teacher_submitted','admin_submitted','reimbursed','returned','reimbursement_returned'))`);

            // 修复历史列宽不足：'reimbursement_returned' 共 22 字符，早期 VARCHAR(20) 会导致
            // 退回报销 UPDATE 直接报错、审计写入静默失败。加宽到 32（幂等，仅对旧库生效）。
            const narrowFeeCols = await db.query(`
                SELECT table_name, column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND data_type = 'character varying'
                  AND character_maximum_length IS NOT NULL
                  AND character_maximum_length < 32
                  AND (
                        (table_name = 'course_arrangement' AND column_name = 'fee_status')
                     OR (table_name = 'fee_status_logs' AND column_name IN ('old_status', 'new_status'))
                      )
            `);
            for (const col of narrowFeeCols.rows || []) {
                await db.query(`ALTER TABLE ${col.table_name} ALTER COLUMN ${col.column_name} TYPE VARCHAR(32)`);
                logger.log(`[Migration] ${col.table_name}.${col.column_name} 加宽为 VARCHAR(32)（容纳 reimbursement_returned）`);
            }

            const feeStatusLogResult = await db.query(`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = 'fee_status_logs'
            `);
            if (feeStatusLogResult.rows.length === 0) {
                await db.query(`
                    CREATE TABLE public.fee_status_logs (
                        id SERIAL PRIMARY KEY,
                        schedule_id INTEGER NOT NULL REFERENCES public.course_arrangement(id) ON DELETE CASCADE,
                        old_status VARCHAR(32),
                        new_status VARCHAR(32) NOT NULL,
                        operator_id INTEGER,
                        actor_type VARCHAR(20) NOT NULL DEFAULT 'admin',
                        note TEXT,
                        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                await db.query(`CREATE INDEX IF NOT EXISTS idx_fee_status_logs_sid ON public.fee_status_logs(schedule_id)`);
                await db.query(`COMMENT ON TABLE public.fee_status_logs IS '费用状态流转审计日志（可分辨 admin/headteacher/teacher 操作身份）'`);
                logger.log('数据库迁移完成：添加 fee_status_logs 表');
            }
        }

        // 权限落地（Phase 1）：availability 两表增加 created_by 创建者追踪。
        // L3 操作员的数据范围过滤依赖此列（仅自己创建 + 无主存量全员可见）。幂等。
        const availabilityOwnerTables = ['teacher_daily_availability', 'student_daily_availability'];
        for (const table of availabilityOwnerTables) {
            const ownerColResult = await db.query(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = '${table}'
                  AND column_name = 'created_by'
            `);
            if ((ownerColResult.rows || []).length === 0) {
                await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS created_by INTEGER`);
                // 管理员被删时不级联清理可用性数据，置空即可（NO ACTION 默认行为）
                try {
                    await db.query(`ALTER TABLE ${table} ADD CONSTRAINT fk_${table}_created_by FOREIGN KEY (created_by) REFERENCES administrators(id) ON UPDATE CASCADE`);
                } catch (fkErr) {
                    // 约束已存在或创建失败不阻断迁移（列已就位即可）
                    logger.warn(`[Migration] ${table} created_by 外键创建跳过:`, fkErr.message);
                }
                await db.query(`CREATE INDEX IF NOT EXISTS idx_${table}_created_by ON ${table}(created_by)`);
                logger.log(`[Migration] ${table} 增加 created_by 列（权限级别数据范围过滤）`);
            }
        }

        // 标记放在最后：中途任何一条报错都不写标记，下次启动重跑（全部语句都是幂等的）
        await markApplied(LEGACY_SCHEMA_KEY);
        logger.log(`数据库迁移完成：${LEGACY_SCHEMA_KEY}（后续启动只查一次版本标记）`);

    } catch (error) {
        logger.error('数据库迁移失败:', db.describeError(error));
        // 不要因为迁移失败而中断应用启动
    }
}

module.exports = runDatabaseMigrations;