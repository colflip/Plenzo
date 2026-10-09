/**
 * course_sessions 迁移块：一场课一行 + 教师/学生双 pair 数组
 * @description 建表、两个 IMMUTABLE 校验函数、派生列辅助函数、三张审计表、pair 展开视图。
 *              全部幂等，由 migrations.js 在应用启动时调用。
 *
 *   一行 = 一场课。头部放整场共享字段，teachers / students 两个 JSONB 数组各存 pair，
 *   每个 pair 自带场次内唯一的 uid；所有交互用「课程 id + uid」定位。
 *
 * 设计约束（已在远程 PostgreSQL 17.11 实测）：
 * - JSONB 元素拿不到外键、CHECK 也不能带子查询，所以「必填齐全 + 枚举合法 + 活跃 pair 内
 *   teacher_id 不重复」由两个 IMMUTABLE plpgsql 函数钉在数据库层；teacher_id / student_id /
 *   type_id 的引用完整性改由服务层写入前一次性校验。
 * - teacher_ids / student_ids 是 GENERATED ALWAYS ... STORED，服务层写它会被数据库拒绝
 *   （UPDATE 报 column "teacher_ids" can only be updated to DEFAULT），因此不存在漂移。
 * - jsonb_agg 只是 STABLE，只能出现在 UPDATE 里，绝不能进 CHECK 或生成列。
 */

const db = require('./db');
const logger = require('../utils/logger.js');
const { tableExists } = require('./table-utils');
// 「哪些生命周期位算不活跃」的唯一源在 shared-utils，这里只是把它拼成 SQL 字面量。
// 以前 JS 侧、迁移 DDL、导出常量各抄了一份，加一个归档态就会漏改（漏了导出的那份，
// 已归档的课还会被计进报销单）。生命周期/类别的**全量枚举**同样取自那一处：
// LIFECYCLE_MAP / CATEGORY_MAP 的键顺序与原来手抄的这两行逐位相同，派生不改动要下发的 DDL 文本
// （由 pair-status-vocabulary.test.js 钉住）。
const { INACTIVE_LIFECYCLES, LIFECYCLE_MAP, CATEGORY_MAP,
    CHANGE_ACTIONS: CHANGE_ACTIONS_MAP } = require('../utils/shared-utils');
const { FEE_STATUSES: FEE_STATUSES_SHARED } = require('../utils/fee-status');

/** 生命周期位：沿用旧表字面量（含 modified_away），前端 16 处判定与 3 条 CSS 规则因此无需改动 */
const LIFECYCLES = Object.keys(LIFECYCLE_MAP);
/** 类别位：normal 普通 / adjusted 调整增补（仅作废+增补流程可写）/ temp 临时加课 */
const CATEGORIES = Object.keys(CATEGORY_MAP);
/** 费用报销 6 状态：唯一源在 utils/fee-status.js（写方与前端展示都吃它），这里只是拼 CHECK 文本 */
const FEE_STATUSES = FEE_STATUSES_SHARED;
/**
 * session_change_logs.action 的取值：唯一源在 shared-utils（course-session-service 是写入方，
 * 这里是 CHECK 约束），加动作只改那一处。约束本身先删后建，见 migrateCourseSessions。
 */
const CHANGE_ACTIONS = Object.values(CHANGE_ACTIONS_MAP);


const sqlArray = (values) => values.map(v => `'${v}'`).join(',');
/** 逗号后带空格：与已部署的函数体逐字节一致，改派生方式不该让 DDL 文本漂移 */
const sqlInList = (values) => values.map(v => `'${v}'`).join(', ');

const FN_PAIR_IDS = `
CREATE OR REPLACE FUNCTION jsonb_pair_ids(arr jsonb, key text)
RETURNS integer[] LANGUAGE sql IMMUTABLE AS $fn$
    SELECT COALESCE(array_agg(DISTINCT (e->>key)::int), '{}')
      FROM jsonb_array_elements(arr) e
$fn$`;

const FN_VALIDATE_TEACHERS = `
CREATE OR REPLACE FUNCTION validate_session_teachers(arr jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
    e jsonb;
    f record;
    uids text[] := '{}';
    active_ids int[] := '{}';
    cat text;
    life text;
    rating int;
    fee numeric;
BEGIN
    IF arr IS NULL OR jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) = 0 THEN
        RETURN false;   -- 数组必须存在且非空：一场课至少一位老师
    END IF;

    FOR e IN SELECT * FROM jsonb_array_elements(arr) LOOP
        -- 必填字段
        IF e->>'uid' IS NULL OR e->>'teacher_id' IS NULL OR e->>'type_id' IS NULL
           OR e->>'status' IS NULL OR e->>'fee_status' IS NULL THEN
            RETURN false;
        END IF;

        -- uid 场次内唯一（所有交互靠它定位）
        IF e->>'uid' = ANY(uids) THEN RETURN false; END IF;
        uids := uids || (e->>'uid');

        -- 状态是「类别.生命周期」两段码，3 × 5 = 15 个合法组合
        cat  := split_part(e->>'status', '.', 1);
        life := split_part(e->>'status', '.', 2);
        IF cat NOT IN (${sqlArray(CATEGORIES)}) THEN RETURN false; END IF;
        IF life NOT IN (${sqlArray(LIFECYCLES)}) THEN RETURN false; END IF;

        IF e->>'fee_status' NOT IN (${sqlArray(FEE_STATUSES)}) THEN RETURN false; END IF;

        rating := NULLIF(e->>'teacher_rating', '')::int;
        IF rating IS NOT NULL AND (rating < 1 OR rating > 5) THEN RETURN false; END IF;

        fee := NULLIF(e->>'transport_fee', '')::numeric;
        IF fee IS NOT NULL AND fee < 0 THEN RETURN false; END IF;
        fee := NULLIF(e->>'other_fee', '')::numeric;
        IF fee IS NOT NULL AND fee < 0 THEN RETURN false; END IF;

        -- 逐学生费用：fees 是「学生 pair uid → 金额」的映射，键必须是该教师 pair 的
        -- fees 对象里的字符串，值必须是对象，且两个金额字段非负（null = 未填写）。
        -- 缺省即「这一趟按整笔记」的老数据，所以整个键允许不存在。
        IF e ? 'fees' THEN
            IF jsonb_typeof(e -> 'fees') <> 'object' THEN RETURN false; END IF;
            FOR f IN SELECT * FROM jsonb_each(e -> 'fees') LOOP
                IF jsonb_typeof(f.value) <> 'object' THEN RETURN false; END IF;
                fee := NULLIF(f.value ->> 'transport_fee', '')::numeric;
                IF fee IS NOT NULL AND fee < 0 THEN RETURN false; END IF;
                fee := NULLIF(f.value ->> 'other_fee', '')::numeric;
                IF fee IS NOT NULL AND fee < 0 THEN RETURN false; END IF;
            END LOOP;
        END IF;

        -- 活跃 pair 内 teacher_id 不得重复；作废（cancelled）与已调整（modified_away）
        -- 不占用活跃名额 —— 这正是「作废+增补」里同一位老师能有两个 pair 的依据。
        IF life NOT IN (${sqlInList(INACTIVE_LIFECYCLES)}) THEN
            IF (e->>'teacher_id')::int = ANY(active_ids) THEN RETURN false; END IF;
            active_ids := active_ids || (e->>'teacher_id')::int;
        END IF;
    END LOOP;

    RETURN true;
END
$fn$`;

const FN_VALIDATE_STUDENTS = `
CREATE OR REPLACE FUNCTION validate_session_students(arr jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $fn$
DECLARE
    e jsonb;
    uids text[] := '{}';
    sids int[] := '{}';
    rating int;
    fam int;
BEGIN
    IF arr IS NULL OR jsonb_typeof(arr) <> 'array' OR jsonb_array_length(arr) = 0 THEN
        RETURN false;   -- 一场课至少一位学生
    END IF;

    FOR e IN SELECT * FROM jsonb_array_elements(arr) LOOP
        IF e->>'uid' IS NULL OR e->>'student_id' IS NULL THEN RETURN false; END IF;

        IF e->>'uid' = ANY(uids) THEN RETURN false; END IF;
        uids := uids || (e->>'uid');

        -- 学生维度没有状态，所以同一学生在一场里只能出现一次
        IF (e->>'student_id')::int = ANY(sids) THEN RETURN false; END IF;
        sids := sids || (e->>'student_id')::int;

        fam := NULLIF(e->>'family_participants', '')::int;
        IF fam IS NOT NULL AND (fam < 0 OR fam > 5) THEN RETURN false; END IF;

        rating := NULLIF(e->>'student_rating', '')::int;
        IF rating IS NOT NULL AND (rating < 1 OR rating > 5) THEN RETURN false; END IF;
    END LOOP;

    RETURN true;
END
$fn$`;

const DDL_TABLE = `
CREATE TABLE public.course_sessions (
    id          SERIAL PRIMARY KEY,
    class_date  DATE NOT NULL,
    start_time  TIME NOT NULL,
    end_time    TIME NOT NULL,
    location    TEXT,
    notes       TEXT,
    teachers    JSONB NOT NULL DEFAULT '[]'::jsonb,
    students    JSONB NOT NULL DEFAULT '[]'::jsonb,
    teacher_ids INTEGER[] GENERATED ALWAYS AS (jsonb_pair_ids(teachers, 'teacher_id')) STORED,
    student_ids INTEGER[] GENERATED ALWAYS AS (jsonb_pair_ids(students, 'student_id')) STORED,
    version     INTEGER NOT NULL DEFAULT 0,
    created_by  INTEGER REFERENCES public.administrators(id) ON UPDATE CASCADE,
    updated_by  INTEGER REFERENCES public.administrators(id) ON UPDATE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_cs_time_order CHECK (end_time > start_time),
    CONSTRAINT chk_cs_teachers   CHECK (validate_session_teachers(teachers)),
    CONSTRAINT chk_cs_students   CHECK (validate_session_students(students))
)`;

const INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_cs_date ON public.course_sessions(class_date)`,
    `CREATE INDEX IF NOT EXISTS idx_cs_teacher_ids ON public.course_sessions USING GIN (teacher_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_cs_student_ids ON public.course_sessions USING GIN (student_ids)`,
    `CREATE INDEX IF NOT EXISTS idx_cs_teachers_gin ON public.course_sessions USING GIN (teachers jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_cs_students_gin ON public.course_sessions USING GIN (students jsonb_path_ops)`,
    `CREATE INDEX IF NOT EXISTS idx_cs_created_by ON public.course_sessions(created_by)`
];

// 四张审计表按 (session_id, teacher_uid) 记账。teacher_uid 只是文本、无外键
// —— JSONB 数组元素无法被外键引用。
// session_fee_audit_logs 额外带 student_uid（可空）：逐学生填的费用一行一档，
// 整趟一笔的老数据留 NULL。费用报销状态仍是「一趟一笔」，所以状态表不加这一列。
//
// 前三张的 session_id 带 ON DELETE CASCADE，随场次一起清理；
// **session_change_logs 刻意不加外键** —— 它要记「整场被删除」这件事，
// 带 CASCADE 的话这条记录会在写入的同一刻被连带删掉，等于没记。
const AUDIT_TABLES = {
    session_status_logs: `
        CREATE TABLE public.session_status_logs (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES public.course_sessions(id) ON DELETE CASCADE,
            teacher_uid VARCHAR(32) NOT NULL,
            old_status VARCHAR(48),
            new_status VARCHAR(48) NOT NULL,
            operator_id INTEGER,
            actor_type VARCHAR(20) NOT NULL DEFAULT 'admin',
            note TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
    session_fee_audit_logs: `
        CREATE TABLE public.session_fee_audit_logs (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES public.course_sessions(id) ON DELETE CASCADE,
            teacher_uid VARCHAR(32) NOT NULL,
            student_uid VARCHAR(32),
            operator_id INTEGER NOT NULL,
            operator_role VARCHAR(20) NOT NULL,
            old_transport_fee DECIMAL(10,2),
            new_transport_fee DECIMAL(10,2),
            old_other_fee DECIMAL(10,2),
            new_other_fee DECIMAL(10,2),
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
    session_fee_status_logs: `
        CREATE TABLE public.session_fee_status_logs (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL REFERENCES public.course_sessions(id) ON DELETE CASCADE,
            teacher_uid VARCHAR(32) NOT NULL,
            old_status VARCHAR(32),
            new_status VARCHAR(32) NOT NULL,
            operator_id INTEGER,
            actor_type VARCHAR(20) NOT NULL DEFAULT 'admin',
            note TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`,
    session_change_logs: `
        CREATE TABLE public.session_change_logs (
            id SERIAL PRIMARY KEY,
            session_id INTEGER NOT NULL,
            action VARCHAR(24) NOT NULL,
            pair_kind VARCHAR(10),
            pair_uid VARCHAR(32),
            changes JSONB,
            operator_id INTEGER,
            actor_type VARCHAR(20) NOT NULL DEFAULT 'admin',
            note TEXT,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT chk_scl_action CHECK (action IN (${sqlArray(CHANGE_ACTIONS)}))
        )`
};

const AUDIT_INDEXES = [
    `CREATE INDEX IF NOT EXISTS idx_ssl_session ON public.session_status_logs(session_id, teacher_uid)`,
    `CREATE INDEX IF NOT EXISTS idx_sfal_session ON public.session_fee_audit_logs(session_id, teacher_uid)`,
    `CREATE INDEX IF NOT EXISTS idx_sfsl_session ON public.session_fee_status_logs(session_id, teacher_uid)`,
    `CREATE INDEX IF NOT EXISTS idx_scl_session ON public.session_change_logs(session_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_scl_action ON public.session_change_logs(action, created_at DESC)`
];

const AUDIT_COMMENTS = [
    `COMMENT ON TABLE public.session_change_logs IS
'排课结构与内容变更审计（状态流转看 session_status_logs、费用看 session_fee_* 两张）。
 session_id 刻意不加外键：action=''delete'' 记的就是整场被删除，带 CASCADE 会让这条记录随场次一起消失。
 changes 为 JSONB：header/pair_patch 记 {字段: {from, to}}，create/delete 记快照，pair_add/pair_remove 记该 pair。'`
];


// pair 展开视图：一行 = 一个教师 pair × 一个学生 pair（纯交叉积，教师默认覆盖全场学生）。
// 两个消费者：① 约 20 处只做 COUNT/GROUP BY 的统计查询；② 列表/网格接口的兼容形状
// （展开后的一行恰好等于旧 course_arrangement 的一行，前端显示代码因此几乎不用改）。
const VIEW_PAIRS = `
CREATE OR REPLACE VIEW public.v_session_pairs AS
SELECT cs.id AS session_id,
       cs.id AS id,
       (t->>'uid') AS teacher_uid,
       (s->>'uid') AS student_uid,
       (t->>'teacher_id')::int AS teacher_id,
       (s->>'student_id')::int AS student_id,
       (t->>'type_id')::int AS type_id,
       cs.class_date, cs.start_time, cs.end_time, cs.location, cs.notes,
       split_part(t->>'status', '.', 2) AS status,
       split_part(t->>'status', '.', 1) AS status_category,
       (t->>'status') AS status_code,
       (t->>'auto_at')::timestamptz AS auto_at,
       NULLIF(t->>'teacher_rating', '')::smallint AS teacher_rating,
       (t->>'teacher_comment') AS teacher_comment,
       NULLIF(s->>'student_rating', '')::smallint AS student_rating,
       (s->>'student_comment') AS student_comment,
       -- 本行这一「教师 pair × 学生 pair」的生效费用。逐学生金额存在时只认它自己
       -- （写它的同时会把整趟金额清空，见 fee-service 的 applyStudentFees），
       -- 否则回落到整趟一笔金额 —— 老数据与单师单生的常规场次都走这条回落。
       COALESCE(NULLIF(t #>> ARRAY['fees', (s->>'uid'), 'transport_fee'], '')::numeric,
                NULLIF(t->>'transport_fee', '')::numeric) AS transport_fee,
       COALESCE(NULLIF(t #>> ARRAY['fees', (s->>'uid'), 'other_fee'], '')::numeric,
                NULLIF(t->>'other_fee', '')::numeric) AS other_fee,
       -- fee_scope 决定合计口径：'student' 的金额每位学生各算一份（逐行相加）；
       --                        'pair' 的是「一趟一笔」，按 (场次, 老师) 只计一次，
       --                        交叉积展开出的多学生行不得重复计入。
       CASE WHEN jsonb_typeof(t #> ARRAY['fees', (s->>'uid')]) = 'object'
            THEN 'student' ELSE 'pair' END AS fee_scope,
       (t->>'fee_status') AS fee_status,
       NULLIF(s->>'family_participants', '')::int AS family_participants,
       NULLIF(t->>'created_by', '')::int AS teacher_pair_created_by,
       NULLIF(s->>'created_by', '')::int AS student_pair_created_by,
       cs.created_by, cs.created_at, cs.updated_by, cs.updated_at, cs.version
  FROM public.course_sessions cs
  CROSS JOIN LATERAL jsonb_array_elements(cs.teachers) t
  CROSS JOIN LATERAL jsonb_array_elements(cs.students) s`;

// 三条使用纪律写进视图注释，避免被误用
const VIEW_COMMENT = `COMMENT ON VIEW public.v_session_pairs IS
'教师 pair × 学生 pair 交叉积展开。使用纪律：
 1) 费用绝不在此视图上无条件聚合 —— transport_fee/other_fee 已是按 fee_scope 取出的生效值，
    但 scope=pair 的那一档是「一趟一笔」，交叉积会把同一个数按学生数重复，合计必须按
    (session_id, teacher_uid) 折叠；scope=student 的是逐学生金额，逐行相加即可。
 2) 过滤活跃排课用 status NOT IN (''cancelled'',''modified_away'')（status 列已是生命周期位）。
 3) 「计划安排」排除临时/增补用 status_category = ''normal''。
 status = 生命周期位（沿用旧字面量），status_code = 完整两段码，status_category = 类别位。'`;

/**
 * 幂等执行 course_sessions 相关迁移。
 * 两个校验函数与 jsonb_pair_ids 每次都 CREATE OR REPLACE（改枚举时靠这一步生效）；
 * 表与审计表按 information_schema 判存在；索引与视图自带幂等语法。
 *
 * **但整块只在版本标记缺失时才跑**（见 SCHEMA_KEY）。原因是实测出来的性能问题：
 * 这一批 24 条语句在远程 Neon 上每条约 250ms，合计 6-9 秒；而 CREATE INDEX 与
 * 「CREATE OR REPLACE 被生成列引用的 jsonb_pair_ids」都要在 course_sessions 上加锁，
 * 迁移是 app.js 模块加载时 fire-and-forget 发出的，正好和首批用户请求撞在一起 ——
 * 实测首个 /api/admin/schedules 被拖到 8.6 秒（其中 jsonb_pair_ids 那条等锁等了 7.7 秒）。
 * 加版本标记后稳态只剩 1 条 SELECT。**改动本文件任何 DDL 都要把 SCHEMA_KEY 的版本号 +1**，
 * 否则新语句不会在已部署的库上生效。
 */

/** 版本标记：改本文件的 DDL 就把尾号 +1（v2 起启用标记短路）
 *  v4 = 教师 pair 增加逐学生费用 fees 映射 + 视图生效费用/fee_scope + 费用审计带 student_uid
 *  v5 = 视图改为「先试 CREATE OR REPLACE，仅 42P16 才删建」；不 +1 的话这条修复在
 *       已标记 v4 的库（生产就是，实测 schema_migrations 里有 course_sessions@v4）上永不执行。
 *       代价：下一次启动会重跑这一整批 DDL（24 条，约 6-9 秒，期间 jsonb_pair_ids 那条会取锁）。*/
const SCHEMA_KEY = 'course_sessions@v5';

/**
 * 版本标记是否已写入。schema_migrations 不存在时顺手建出来并返回 false。
 * 稳态路径只花一条 SELECT —— 这正是加它的目的。migrations.js 也用这一对函数。
 */
async function isApplied(key) {
    try {
        const r = await db.query(`SELECT 1 FROM public.schema_migrations WHERE key = $1`, [key]);
        return (r.rows || []).length > 0;
    } catch (e) {
        if (!/schema_migrations/i.test(e.message || '')) throw e;
        await db.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
            key TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`);
        return false;
    }
}

/** 写入版本标记。必须放在该批 DDL 全部成功之后 —— 中途失败就不写，下次启动重跑 */
async function markApplied(key) {
    await db.query(
        `INSERT INTO public.schema_migrations (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`,
        [key]
    );
}

async function migrateCourseSessions() {
    if (await isApplied(SCHEMA_KEY)) return { skipped: true };

    await db.query(FN_PAIR_IDS);
    await db.query(FN_VALIDATE_TEACHERS);
    await db.query(FN_VALIDATE_STUDENTS);

    if (!await tableExists('course_sessions')) {
        await db.query(DDL_TABLE);
        await db.query(`COMMENT ON TABLE public.course_sessions IS '排课场次表：一行一场课，teachers/students 为 pair 数组，pair 内 uid 场次内唯一'`);
        await db.query(`COMMENT ON COLUMN public.course_sessions.teacher_ids IS '派生列（GENERATED ALWAYS），仅供索引与存在性查询，服务层不可写'`);
        await db.query(`COMMENT ON COLUMN public.course_sessions.version IS '乐观锁：整列写 teachers/students 的路径才用；状态路径靠原地重建，不用它'`);
        logger.log('数据库迁移完成：创建 course_sessions 表（一场一行 + 双 pair 数组）');
    }

    for (const sql of INDEXES) await db.query(sql);

    for (const [name, ddl] of Object.entries(AUDIT_TABLES)) {
        if (!await tableExists(name)) {
            await db.query(ddl);
            logger.log(`数据库迁移完成：创建 ${name} 表`);
        }
    }
    for (const sql of AUDIT_INDEXES) await db.query(sql);
    for (const sql of AUDIT_COMMENTS) await db.query(sql);

    // 逐学生费用上线：老库的费用审计表补 student_uid（新建库由 AUDIT_TABLES 自带）
    await db.query(`ALTER TABLE public.session_fee_audit_logs
        ADD COLUMN IF NOT EXISTS student_uid VARCHAR(32)`);

    // action 枚举先删后建，这样往 CHANGE_ACTIONS 里加动作对已建好的表也生效（幂等）
    await db.query(`ALTER TABLE public.session_change_logs DROP CONSTRAINT IF EXISTS chk_scl_action`);
    await db.query(`ALTER TABLE public.session_change_logs ADD CONSTRAINT chk_scl_action CHECK (action IN (${sqlArray(CHANGE_ACTIONS)}))`);

    // 视图：先按正常路径 CREATE OR REPLACE。v4 把 fee_scope 插在 other_fee 与 fee_status
    // 之间，这种「中间插列」会报 42P16 cannot change name of view column —— 以前是无条件
    // 先 DROP 再建，结果视图本来就对时也要在 course_sessions 上白挨一次 ACCESS EXCLUSIVE，
    // 而且 DROP 与 CREATE 是两条 autocommit 语句，中间那段时间 30 处读 v_session_pairs 的
    // 查询全部报 undefined_object。现在只在真的对不上时才删建，且两步之间不再留窗口。
    try {
        await db.query(VIEW_PAIRS);
    } catch (err) {
        if (!err || err.code !== '42P16') throw err;
        logger.warn('[migration] v_session_pairs 列序与定义对不上，删掉重建（42P16）');
        await db.query(`DROP VIEW IF EXISTS public.v_session_pairs`);
        await db.query(VIEW_PAIRS);
    }
    await db.query(VIEW_COMMENT);

    // 标记放在最后：中途失败则不写标记，下次启动重跑（DDL 本身全部幂等）
    await markApplied(SCHEMA_KEY);
    logger.log(`数据库迁移完成：${SCHEMA_KEY}（后续启动只查一次版本标记）`);
    return { skipped: false };
}

module.exports = {
    migrateCourseSessions, LIFECYCLES, CATEGORIES, FEE_STATUSES, CHANGE_ACTIONS,
    SCHEMA_KEY, isApplied, markApplied,
    // 导出 DDL 文本只为测试用：断言「不活跃清单」确实由 shared-utils 那一份派生（见 pair-status-vocabulary.test.js）
    FN_VALIDATE_TEACHERS
};
