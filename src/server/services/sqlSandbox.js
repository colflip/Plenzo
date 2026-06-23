/**
 * SQL 安全沙箱 (SQL Sandbox)
 * @description 为 AI Text-to-SQL 兜底方案提供安全执行环境。
 *              通过白名单表、强制只读、强制 LIMIT、超时、脱敏等措施降低风险。
 * @module services/sqlSandbox
 *
 * 注意：此模块只用于"现有统计 API 无法覆盖"的查询兜底，不应作为常规查询路径。
 */

const db = require('../db/db');
const scheduleService = require('./scheduleService');

/**
 * 允许查询的表白名单
 * 绝不包含 administrators（密码哈希）、users 等敏感表
 */
const ALLOWED_TABLES = new Set([
    'course_arrangement',
    'teachers',
    'students',
    'schedule_types',
    'teacher_daily_availability',
    'student_daily_availability',
    'holidays',
    'fee_audit_logs',
    'operation_logs',
    'export_logs',
    'schedule_auto_update_logs'
]);

/**
 * 禁止的 SQL 关键字（写操作 / DDL / 危险函数）
 */
const FORBIDDEN_PATTERNS = [
    /\binsert\s+into\b/i,
    /\bupdate\s+\w+\s+set\b/i,
    /\bdelete\s+from\b/i,
    /\bdrop\s+(table|database|schema|index)\b/i,
    /\btruncate\b/i,
    /\balter\s+(table|database|schema)\b/i,
    /\bgrant\b/i,
    /\brevoke\b/i,
    /\bcreate\s+(table|database|schema|index|view|function)\b/i,
    /\bexec(ute)?\b/i,
    /\bcall\s+\w+\(/i,
    /\bcopy\b/i,
    /\bpg_(read|sleep|terminate)\b/i,
    /\blo_import\b/i,
    /\blo_export\b/i,
    /\binto\s+(outfile|dumpfile)\b/i,
    /--/,                   // SQL 注释（防止拼接绕过）
    /\/\*/,
    /;\s*\w/                // 多语句拼接（分号后跟内容）
];

/**
 * 脱敏正则
 */
const PII_PATTERNS = [
    { re: /1[3-9]\d{9}/g, replace: (m) => m.slice(0, 3) + '****' + m.slice(-4) },          // 手机号
    { re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replace: (m) => m.slice(0, 2) + '***' + m.slice(m.indexOf('@')) }, // 邮箱
    { re: /\b\d{15,18}[xX]?\b/g, replace: (m) => m.slice(0, 4) + '**********' + m.slice(-4) } // 身份证
];

/**
 * 校验 SQL 安全性
 * @param {string} sql
 * @returns {{ok: boolean, reason?: string, sql: string}}
 */
function validateSQL(sql) {
    if (!sql || typeof sql !== 'string') {
        return { ok: false, reason: 'SQL 为空' };
    }

    // 必须以 SELECT 开头
    const trimmed = sql.trim();
    if (!/^select\s/i.test(trimmed)) {
        return { ok: false, reason: '只允许 SELECT 查询' };
    }

    // 检查禁用关键字
    for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(trimmed)) {
            return { ok: false, reason: `SQL 包含禁用的关键字或写操作: ${pattern.source}` };
        }
    }

    // 检查 FROM / JOIN 的表是否都在白名单内
    // 提取 from xxx, join xxx 中的表名（支持 schema.table 和别名）
    const tableRegex = /(?:from|join)\s+([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)/gi;
    let match;
    while ((match = tableRegex.exec(trimmed)) !== null) {
        const rawTable = match[1];
        const table = rawTable.includes('.') ? rawTable.split('.').pop() : rawTable;
        if (!ALLOWED_TABLES.has(table.toLowerCase())) {
            return { ok: false, reason: `表 "${table}" 不在允许的白名单内` };
        }
    }

    return { ok: true, sql: trimmed };
}

/**
 * 确保 SQL 有 LIMIT，没有则追加
 */
function ensureLimit(sql, max = 100) {
    if (/\blimit\s+\d+/i.test(sql)) {
        return sql;
    }
    return `${sql.replace(/;?\s*$/, '')} LIMIT ${max}`;
}

/**
 * 对结果集做 PII 脱敏
 */
function maskPII(rows) {
    if (!Array.isArray(rows)) return rows;
    return rows.map(row => {
        if (typeof row !== 'object' || row === null) return row;
        const out = {};
        for (const [key, value] of Object.entries(row)) {
            if (typeof value === 'string') {
                let masked = value;
                for (const { re, replace } of PII_PATTERNS) {
                    masked = masked.replace(re, replace);
                }
                out[key] = masked;
            } else {
                out[key] = value;
            }
        }
        return out;
    });
}

/**
 * 生成给 LLM 的 schema 提示（告知可查表结构 + 业务规则）
 */
async function buildSchemaPrompt() {
    const dateExpr = await scheduleService.getCaDateExpr();
    return `你可以生成只读 SQL (PostgreSQL) 来回答用户问题。可查询的表及其关键字段：

1. course_arrangement (排课记录，核心事实表):
   - id, teacher_id, student_id, course_id (关联 schedule_types.id)
   - ${dateExpr} (排课日期；查询时请直接使用此表达式作为日期列)
   - start_time, end_time (TIME 类型)
   - status VARCHAR: 'pending'|'confirmed'|'cancelled'|'completed'|'modified_away'
   - adjustment_type INT: 0=计划, 1=临时加, 2=调整后新记录
   - student_rating, teacher_rating SMALLINT (1-5)
   - student_comment, teacher_comment TEXT
   - transport_fee, other_fee DECIMAL(10,2)
   - location TEXT, created_by, created_at, updated_at

2. teachers (教师): id, username, name, profession, contact, work_location, home_address, status(1正常/0暂停/-1删除), restriction(0-5), student_ids(关联学生CSV)

3. students (学生): id, username, name, profession(实为年级), contact, visit_location(上课地点), home_address, status

4. schedule_types (课程类型): id, name(代码), description(中文显示名)。统计时类型标签用 COALESCE(description, name)

5. teacher_daily_availability / student_daily_availability: teacher_id/student_id, date, morning_available, afternoon_available, evening_available (0/1), start_time, end_time, status('available'/'unavailable')

6. holidays: year, type('holiday'/'makeup'), label, start_date, end_date

7. fee_audit_logs: schedule_id, operator_id, operator_role, old_transport_fee, new_transport_fee, old_other_fee, new_other_fee, created_at

业务规则（生成 SQL 时务必遵守）:
- 有效排课过滤: status NOT IN ('cancelled', '0', 'modified_away')
- "显示用排课"还需排除被调整的原记录: NOT (status='modified_away' AND adjustment_type=0)
- 活跃用户: teachers.status != -1 (同理 students)
- 日期列请用 ${dateExpr} (不要直接写 class_date 或 arr_date)
- 课程类型显示名: COALESCE(schedule_types.description, schedule_types.name)
- 禁止查询 administrators 表；禁止任何写操作

请只输出一条 SELECT 语句，不要解释。`;
}

/**
 * 执行受控 SQL
 * @param {string} sql
 * @param {Object} [opts]
 * @param {number} [opts.timeoutMs=5000] statement 超时
 * @param {number} [opts.maxRows=100] 最大返回行数
 * @param {boolean} [opts.mask=true] 是否脱敏
 * @returns {Promise<{rows: Array, sql: string, rowCount: number, limited: boolean}>}
 */
async function execute(sql, opts = {}) {
    const timeoutMs = opts.timeoutMs || 5000;
    const maxRows = opts.maxRows || 100;
    const shouldMask = opts.mask !== false;

    // 1. 安全校验
    const validation = validateSQL(sql);
    if (!validation.ok) {
        const err = new Error(`SQL 安全校验失败: ${validation.reason}`);
        err.code = 'SQL_VALIDATION_FAILED';
        throw err;
    }

    // 2. 追加 LIMIT
    const finalSql = ensureLimit(validation.sql, maxRows);
    const limited = !/\blimit\s+\d+/i.test(validation.sql);

    // 3. 用 statement_timeout 包裹执行，避免长查询拖垮连接
    const wrappedSql = `SET LOCAL statement_timeout = ${parseInt(timeoutMs, 10)}; ${finalSql}`;

    console.log(`[SqlSandbox] 执行受控查询: ${finalSql.slice(0, 120)}${finalSql.length > 120 ? '...' : ''}`);

    let result;
    try {
        // 用事务执行以保证 SET LOCAL 生效，且出错自动回滚
        result = await db.runInTransaction(async (client, usePool) => {
            const q = usePool ? db.query.bind(db) : client.query.bind(client);
            await q(`SET LOCAL statement_timeout = ${parseInt(timeoutMs, 10)}`);
            return await q(finalSql);
        });
    } catch (err) {
        if (err.code === '57014' || /statement timeout/i.test(err.message || '')) {
            const e = new Error('查询超时，请尝试缩小范围或简化问题');
            e.code = 'SQL_TIMEOUT';
            throw e;
        }
        throw err;
    }

    const rows = (result && result.rows) ? result.rows : (Array.isArray(result) ? result : []);
    const processedRows = shouldMask ? maskPII(rows) : rows;

    return {
        rows: processedRows,
        sql: finalSql,
        rowCount: rows.length,
        limited
    };
}

module.exports = {
    ALLOWED_TABLES,
    validateSQL,
    ensureLimit,
    maskPII,
    buildSchemaPrompt,
    execute
};
