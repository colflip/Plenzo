/**
 * course-session-service.js —— 排课场次写入与定位（一场一行 + 教师/学生双 pair 数组）
 *
 * 承接旧 schedule-service 的四个写入口（adminCreateSchedule / adminUpdateSchedule /
 * adminDeleteSchedule / 状态流转）的职责。三条纪律写在最前面，改这个文件时先读它们：
 *
 * 1. **写派生列会被数据库拒绝**。teacher_ids / student_ids 是 GENERATED ALWAYS ... STORED，
 *    任何 SET 都会报 `column "teacher_ids" can only be updated to DEFAULT`。所有写只碰
 *    teachers / students / 头部列 —— 这正是我们要的：服务层不可能忘记同步、也写不歪。
 *
 * 2. **状态类写入用「相关子查询原地重建」，不读回、不带 version、不产生 409**。
 *    形如 jsonb_agg(CASE WHEN e->>'uid' = $uid THEN jsonb_set(...) ELSE e END ORDER BY ord)：
 *    READ COMMITTED 下第二个 UPDATE 阻塞后按新行版本重新求值（EvalPlanQual），两位老师
 *    同时确认自己的课都会生效。已在远程库用两条连接实测（闸门 B，9/9 通过）。
 *    这也是「语句形态即权限」：这条语句结构上只能改 status 一个键，改不到别人的 pair、
 *    改不到 type_id / 评分 / 费用。**不要给非管理员路径加通用 patch 入口，否则这道防线失效。**
 *
 * 3. **整列写（管理员改 pair 内容、增删 pair、费用）必须带 version**，rowCount = 0 → 409。
 *
 * 类别位（normal / adjusted / temp）是溯源属性：状态切换只替换生命周期后缀，类别前缀原样保留；
 * adjusted 只有「作废+增补」流程能写，请求体不放行。
 *
 * **审计四张表，各管一段，写入方分工固定**：
 * - `session_status_logs` —— 生命周期流转（本文件的 setTeacherStatus / cancelSession /
 *   adjustTeacherPair，以及 jobs/update-schedule-status.js 的定时任务）。
 * - `session_fee_audit_logs` / `session_fee_status_logs` —— 费用金额与报销状态（fee-service.js、
 *   utils/fee-status.js）。
 * - `session_change_logs` —— 结构与内容变更：新建、头部、pair 内容、增删 pair、整场删除、
 *   删用户清理。它的 session_id **没有外键**，否则 action='delete' 那条会被 CASCADE 连带删掉。
 *
 * 审计写入一律「失败只告警、不阻断主流程」，与旧 writeFeeStatusLog 同口径。
 */

const db = require('./../db/db');
const logger = require('../utils/logger');
// CHANGE_ACTIONS 的唯一源也在 shared-utils：写方（这里）与约束方（迁移的 chk_scl_action CHECK）吃同一份
const { LIFECYCLE_MAP, CATEGORY_MAP, INACTIVE_LIFECYCLES, CHANGE_ACTIONS, splitStatus } = require('../utils/shared-utils');

const LIFECYCLES = Object.keys(LIFECYCLE_MAP);
const CATEGORIES = Object.keys(CATEGORY_MAP);

/** 乐观锁冲突：控制器据此回 409 */
class VersionConflictError extends Error {
    constructor() {
        super('该排课已被他人修改，请刷新后重试');
        this.name = 'VersionConflictError';
        this.status = 409;
    }
}

/** 业务校验失败：控制器据此回 400 */
class SessionValidationError extends Error {
    constructor(message, rejectedFields) {
        super(message);
        this.name = 'SessionValidationError';
        this.status = 400;
        if (rejectedFields) this.rejectedFields = rejectedFields;
    }
}

const HEADER_COLUMNS = ['class_date', 'start_time', 'end_time', 'location', 'notes'];

/**
 * 字段白名单：按身份裁剪 pair patch。交集之外的键一律丢弃并计数，
 * 由控制器把 rejectedFields 回给前端（验证清单第 4 条要看到它）。
 * 学生不在表里 —— 学生对排课只读，没有任何写入口。
 *
 * transport_fee / other_fee 一律不在表里（2026-09-22）：钱是「这一趟的这位学生」那一格，
 * 只有 fee-service 那条路带 teacher_uid + student_uid、写 session_fee_audit_logs。
 * 挂在排课编辑接口上会出现三个问题：金额按整趟写 → 一位学生的数落到全车人头上；
 * 与逐学生格子并存 → 导出合计既算趟又算格；改钱不写审计。patchPair 现在对这两个键
 * 直接抛 400（FEES_NOT_ON_SCHEDULE_PATCH），不再静默接受。
 */
const PAIR_WRITE_WHITELIST = {
    admin: {
        // teacher_id / student_id / category 是 2026-09-08 补进来的：编辑弹窗里换老师、换学生、
        // 改类别（普通 ↔ 临时加课）三个入口此前前端根本没提交、服务端也不放行，
        // 于是「保存成功」的 toast 照弹，库里一行没动。
        // fee_status 不在此列：报销状态是**财务状态**，必须走费用接口
        // （/…/fee-status），那里才有状态机校验 validateFeeStatusTransition 与
        // session_fee_status_logs 审计。放进排课 patch 白名单 = 保存课表就能把
        // draft 直接写成 reimbursed，且只在 session_change_logs 留一条 PAIR_PATCH
        //（审查报告 P2-2）。
        teacher: ['teacher_id', 'category', 'type_id', 'teacher_rating', 'teacher_comment'],
        student: ['student_id', 'student_rating', 'student_comment', 'family_participants']
    },
    headteacher: { teacher: [], student: [] },
    teacher: { teacher: [], student: [] }
};

/**
 * 只能由费用接口写的键 —— 出现在 pair patch 里就是调用方用错了接口。
 */
const FEE_ONLY_KEYS = ['transport_fee', 'other_fee'];

/**
 * fee_status 只能由费用接口写 —— 但**只在更新路径**拦（见 patchPair）：
 * 它过去同时挂在 PAIR_WRITE_WHITELIST 里，于是「保存课表」能把 draft 直接写成
 * reimbursed，既不过状态机（validateFeeStatusTransition），也不写
 * session_fee_status_logs 财务审计（只在 session_change_logs 留一条 PAIR_PATCH）。
 * 新建 pair 允许带初始报销状态（那一趟还没有可流转的状态，updatePairsBatch 的
 * 既有语义也依赖这一点），所以不放进 FEE_ONLY_KEYS 以免一刀切到创建路径。
 * 见审查报告 P2-2。
 */
const PATCH_ONLY_FEE_KEYS = ['fee_status'];

/**
 * 排课编辑路径上碰钱的统一拦截点。放在这里而不是只靠白名单丢弃：丢弃等于「保存成功但钱没动」，
 * 正是这个仓库反复修过的那类静默失败。放行的接口（PATCH/PUT /schedules、/sessions 的 fees 之外那些）
 * 一律 400，调用方必须改用费用接口（…\/fees，带 teacher_uid + student_uid，并写审计）。
 */
function assertNoFeeFields(patch) {
    const hit = FEE_ONLY_KEYS.filter(k => patch && patch[k] !== undefined);
    if (hit.length) {
        const err = new SessionValidationError(
            `${hit.join('、')} 不能随排课修改提交：费用属于「这一趟的这位学生」那一格，`
            + '请改用费用接口（…/fees，需带 teacher_uid 与 student_uid）'
        );
        err.code = 'FEES_NOT_ON_SCHEDULE_PATCH';
        throw err;
    }
}

/** 编辑弹窗可直接改写的类别位；adjusted 是溯源属性，只有「作废+增补」流程能写 */
const EDITABLE_CATEGORIES = ['normal', 'temp'];

/**
 * 生成 jsonpath 谓词：按类别或生命周期筛课。
 * 必须枚举字面量才走 GIN(jsonb_path_ops) 索引 —— starts with / like_regex 拿不到索引，
 * 所以这两个生成器是唯一出口，禁止各处手拼（既容易漏一格，也是注入面）。
 */
function categoryPathPredicate(category) {
    if (!CATEGORIES.includes(category)) throw new SessionValidationError(`未知类别 ${category}`);
    return '$[*] ? (' + LIFECYCLES.map(l => `@.status == "${category}.${l}"`).join(' || ') + ')';
}

function lifecyclePathPredicate(lifecycle) {
    return statusPathPredicate(CATEGORIES.map(c => `${c}.${lifecycle}`), () => {
        if (!LIFECYCLES.includes(lifecycle)) throw new SessionValidationError(`未知生命周期 ${lifecycle}`);
    });
}

/**
 * 由若干完整状态码生成 jsonpath 谓词。多个生命周期/类别混合筛选时用它，
 * 不要在调用侧对 lifecyclePathPredicate 的返回值做字符串拼接（那样会拼出嵌套的坏 path）。
 * @param {string[]} codes 形如 ['normal.pending','temp.confirmed']
 */
function statusPathPredicate(codes, guard) {
    if (guard) guard();
    const list = [...new Set(codes)];
    for (const code of list) {
        const { category, lifecycle } = splitStatus(code);
        if (!CATEGORIES.includes(category) || !LIFECYCLES.includes(lifecycle)) {
            throw new SessionValidationError(`未知状态码 ${code}`);
        }
    }
    return '$[*] ? (' + list.map(c => `@.status == "${c}"`).join(' || ') + ')';
}

const isActive = (status) => !INACTIVE_LIFECYCLES.includes(splitStatus(status).lifecycle);

/** 「不活跃」的 SQL 字面量清单，与 isActive 共用同一份 INACTIVE_LIFECYCLES */
const INACTIVE_SQL = `(${INACTIVE_LIFECYCLES.map(l => `'${l}'`).join(', ')})`;

/**
 * 「在职 pair」的 SQL 谓词唯一出口，口径 = isActive()。
 * view 形态用于 `v_session_pairs`（该视图已把 status_code 拆成 status=生命周期位、status_category=类别位），
 * jsonb 形态用于直接展开 `course_sessions.teachers` / `.students`（status 还是 '类别.生命周期' 一个串）。
 * 两者必须由调用方选对：写错列名不会报错，只会静默把已取消的课算成在职。
 * @param {string|null} [alias] 表别名；传 null 取裸列名（单表 subselect 里用）
 */
const pairCol = (alias, name) => (alias ? `${alias}.${name}` : name);
const sqlActivePair = (alias = 'ca') => `${pairCol(alias, 'status')} NOT IN ${INACTIVE_SQL}`;
const sqlActivePairJsonb = (elem = 'e') => `split_part(${elem}->>'status', '.', 2) NOT IN ${INACTIVE_SQL}`;

/** 指定教师在本场里仍是职 pair（jsonb 形态，用于「这个人有没有课」） */
const sqlActiveTeacherPairJsonb = (teacherIdSql, elem = 'e') =>
    `(${elem}->>'teacher_id')::int = ${teacherIdSql} AND ${sqlActivePairJsonb(elem)}`;

/**
 * 统计/列表里的「隐藏被调走的原课程」口径 —— 与 sqlActivePair **不等价**，别混用：
 * 它只排除「normal 类别 + 生命周期 modified_away」这一批（作废后已有增补 pair 顶上，
 * 原记录不该再计一场课），而 cancelled 要留给调用方自己按需要的口径统计，
 * `adjusted.*` / `temp.*` 下的 modified_away 也要保留（那是增补 pair 自身，不是被调走的原课）。
 */
const sqlNotMovedAway = (alias = 'ca') =>
    `NOT (${pairCol(alias, 'status')} = 'modified_away' AND ${pairCol(alias, 'status_category')} = 'normal')`;

/**
 * 「本行学生 pair 确实改属过（跨学生调整）」—— v_session_pairs 形态，报销视图与 Excel
 * 计划列置空的判定共用这一份口径（以前同一段 EXISTS 手抄了 5 份，加一个条件就得记着改 5 处）。
 *
 * 匹配收紧到 uid + 当前 student_id 双条件：nextUid 取的是「未占用的最小序号」、removePair
 * 又是物理删元素，所以 uid 会被复用 —— 只按 uid 匹配的话，上一位学生的改属补丁会挂到后来
 * 复用同号的那位学生身上，计划列被静默整行抹掉（钱不算错，但报销单少一行）。
 * 号段重编写的是 user_id_migrated 而不是 pair_patch，天然不进这里。
 */
const sqlStudentSwapped = (alias = 'ca') => `EXISTS (
    SELECT 1 FROM session_change_logs sw
    WHERE sw.session_id = ${alias}.session_id
      AND sw.action = 'pair_patch' AND sw.pair_kind = 'student'
      AND sw.pair_uid = ${alias}.student_uid
      AND (sw.changes->'student_id'->>'to') = ${alias}.student_id::text
      AND (sw.changes->'student_id'->>'from') IS DISTINCT FROM (sw.changes->'student_id'->>'to')
)`;

/** 场次内下一个可用 uid：取当前数组里未占用的最小序号，避免复用刚删掉的编号 */
function nextUid(pairs, prefix) {
    const used = new Set((pairs || []).map(p => String(p.uid)));
    let i = 1;
    while (used.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
}

const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const intOrNull = (v) => {
    const n = numOrNull(v);
    return n === null ? null : Math.trunc(n);
};

/**
 * 引用完整性校验：JSONB 里的 id 拿不到外键，写入前一次性查库确认。
 * 三张表并发查（原来是循环里串行发，白等两次往返；远程库每条约 250ms）；
 * 报错顺序仍按「教师 → 学生 → 课程类型」，与串行时代一致。
 *
 * 顺手把「账号必须正常」也放在这里：status 与 id 在同一条 SELECT 里取回，**不多花一次往返**。
 * 守卫落在服务层而不是某个调用方，AI 批量创建、REST 新建、加参与者、调整课程都自动受保护 ——
 * 以前只有 adminCreateSchedule 查禁用，AI 那条路能把禁用教师写进课。
 */
async function assertReferences({ teacherIds = [], studentIds = [], typeIds = [] }, tx) {
    const q = tx || db.query;
    const checks = [
        { ids: teacherIds, table: 'teachers', label: '教师', mustBeActive: true },
        { ids: studentIds, table: 'students', label: '学生', mustBeActive: true },
        { ids: typeIds, table: 'schedule_types', label: '课程类型', mustBeActive: false }
    ].map(({ ids, table, label, mustBeActive }) => ({
        uniq: [...new Set(ids.map(Number).filter(Number.isFinite))],
        table, label, mustBeActive
    }));

    const results = await Promise.all(checks.map(c => (c.uniq.length === 0
        ? null
        : q(
            c.mustBeActive
                ? `SELECT id, name, status FROM ${c.table} WHERE id = ANY($1::int[])`
                : `SELECT id, name FROM ${c.table} WHERE id = ANY($1::int[])`,
            [c.uniq]
        ))));

    for (let i = 0; i < checks.length; i++) {
        const check = checks[i];
        if (!results[i]) continue;
        const rows = results[i].rows || [];
        const found = new Set(rows.map(x => Number(x.id)));
        const missing = check.uniq.filter(id => !found.has(id));
        if (missing.length) throw new SessionValidationError(`${check.label} ID 不存在: ${missing.join(', ')}`);
        if (check.mustBeActive) {
            const disabled = rows.filter(x => Number(x.status) !== 1);
            if (disabled.length) {
                throw new SessionValidationError(
                    `${check.label}已被禁用，无法参与排课: ${disabled.map(x => x.name).join('、')}`
                );
            }
        }
    }
}

/**
 * 审计归属列（created_by / updated_by）的唯一解析出口。
 *
 * 规则（业务裁定）：归属人只放行**管理员或班主任**，普通教师与学生一律写 NULL。
 * 号段互不相交且长度可辨（生产实测 administrators 100–102、teachers 2000–2014、
 * students 3000–3005），所以单凭 id 就能判定归属人出自哪张表，不需要再加 actor 列。
 *
 * 但生产库上 course_sessions.created_by/updated_by 至今仍挂着
 *   FOREIGN KEY … REFERENCES administrators(id)（2026-10-09 只读实测：两个约束还在，
 *   schema_migrations 里也还没有 legacy_migrations@v5）—— 班主任 id 写进去就是 23503，
 *   还会被上层翻译成误导性的 400。v5 去掉这两个外键，代码却可能先于迁移落到旧库上，
 *   所以非管理员归属 fail closed：启动时探测 v5 是否已应用，未知/未应用一律按 NULL。
 *
 * @param {{id?: number|string, actorType?: string}|null} actor
 * @returns {number|null}
 */
const AUDIT_ADMIN_ACTOR_TYPES = new Set(['admin']);
const AUDIT_NON_ADMIN_ACTOR_TYPES = new Set(['headteacher']);
const AUDIT_FK_DROP_KEY = 'legacy_migrations@v5';

/** 由 bootstrapDatabase() 在迁移之后置位；默认 false = 只认管理员 */
let nonAdminAttributionAllowed = false;

/**
 * 探测归属外键是否已去掉（legacy_migrations@v5 是否已应用）。
 * 失败/表不存在都按「未去掉」处理 —— 宁可少记归属，不可把写入打成 400。
 * @returns {Promise<boolean>}
 */
async function primeAuditAttributionCapability() {
    try {
        const r = await db.query(
            `SELECT 1 FROM public.schema_migrations WHERE key = $1`, [AUDIT_FK_DROP_KEY]
        );
        nonAdminAttributionAllowed = (r.rows || []).length > 0;
    } catch {
        nonAdminAttributionAllowed = false;   // 表不存在、连接失败、熔断打开都按「外键还在」处理
    }
    return nonAdminAttributionAllowed;
}

function resolveAuditActorId(actor) {
    if (!actor) return null;
    const actorType = String(actor.actorType || '');
    if (AUDIT_ADMIN_ACTOR_TYPES.has(actorType)) {
        // fallthrough：管理员 id 由外键保证存在
    } else if (AUDIT_NON_ADMIN_ACTOR_TYPES.has(actorType)) {
        if (!nonAdminAttributionAllowed) return null;
    } else {
        return null;   // teacher / student / 未知身份
    }
    const n = Number(actor.id);
    return Number.isInteger(n) && n > 0 ? n : null;
}

/** 服务端组装教师 pair：uid 与 created_by 由服务端决定，请求传入的同名键一律忽略 */
function buildTeacherPair(input, uid, actorId) {
    const category = CATEGORIES.includes(input.category) && input.category !== 'adjusted'
        ? input.category : 'normal';   // adjusted 只有作废+增补流程能写
    const lifecycle = LIFECYCLES.includes(input.lifecycle) ? input.lifecycle : 'pending';
    return {
        uid,
        teacher_id: intOrNull(input.teacher_id),
        type_id: intOrNull(input.type_id),
        status: `${category}.${lifecycle}`,
        auto_at: null,
        // 费用（交通费/其他）与评分/评价归财务页面处理，排课表单不携带这些字段
        teacher_rating: intOrNull(input.teacher_rating),
        teacher_comment: input.teacher_comment || null,
        transport_fee: numOrNull(input.transport_fee),
        other_fee: numOrNull(input.other_fee),
        fee_status: input.fee_status || 'draft',
        created_by: actorId
    };
}

function buildStudentPair(input, uid, actorId) {
    const fam = intOrNull(input.family_participants);
    return {
        uid,
        student_id: intOrNull(input.student_id),
        // 家属人数/学生评分/学生评价归财务页面处理，排课表单不携带这些字段
        student_rating: intOrNull(input.student_rating),
        student_comment: input.student_comment || null,
        family_participants: fam === null ? 4 : fam,
        created_by: actorId
    };
}

/**
 * 单一入口：按身份裁剪 pair patch。
 * @returns {{ patch: object, rejectedFields: string[] }}
 */
function applyPairPatch(kind, patch, actor) {
    const role = (actor && actor.actorType) || 'teacher';
    const allowed = (PAIR_WRITE_WHITELIST[role] || {})[kind] || [];
    const out = {};
    const rejected = [];
    for (const [k, v] of Object.entries(patch || {})) {
        if (allowed.includes(k)) out[k] = v;
        else rejected.push(k);
    }
    return { patch: out, rejectedFields: rejected };
}

/** 把裁剪后的 patch 归一成 pair 字段（保留 null 与 0 的语义差异） */
function normalizePairPatch(kind, patch) {
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
        if (k === 'type_id' || k === 'teacher_id' || k === 'student_id'
            || k === 'teacher_rating' || k === 'student_rating' || k === 'family_participants') {
            out[k] = intOrNull(v);
        } else if (k === 'transport_fee' || k === 'other_fee') {
            const n = numOrNull(v);
            if (n !== null && n < 0) throw new SessionValidationError(`${k} 不能为负数`);
            out[k] = n;
        } else {
            out[k] = v === '' ? null : v;
        }
    }
    return out;
}

const SESSION_COLUMNS = `id, class_date, start_time, end_time, location, notes,
    teachers, students, teacher_ids, student_ids, version,
    created_by, created_at, updated_by, updated_at`;

/** 读一场（场次形状）。写前读与编辑弹窗共用；找不到返回 null */
async function getSessionById(id, tx) {
    const q = tx || db.query;
    const r = await q(`SELECT ${SESSION_COLUMNS} FROM course_sessions WHERE id = $1`, [id]);
    return (r.rows || [])[0] || null;
}

const findPair = (arr, uid) => (arr || []).find(p => String(p.uid) === String(uid)) || null;

/**
 * 审计：状态流转，一次多行插入。表不存在时静默跳过，不影响主流程
 * （与旧 writeFeeStatusLog 同口径）。整场取消要给每个 pair 记一条，
 * 逐条发就是 N 次往返（远程库每条约 250ms），所以统一走批量。
 */
async function writeStatusLogs(tx, entries) {
    const rows = (entries || []).filter(Boolean);
    if (rows.length === 0) return;
    const params = [];
    const tuples = rows.map((e) => {
        params.push(e.sessionId, e.teacherUid, e.oldStatus || null, e.newStatus,
            e.operatorId || null, e.actorType || 'admin', e.note || null);
        const n = params.length;
        return `($${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    try {
        await pickQ(tx)(
            `INSERT INTO session_status_logs
             (session_id, teacher_uid, old_status, new_status, operator_id, actor_type, note)
             VALUES ${tuples.join(', ')}`,
            params
        );
    } catch (e) {
        // 独立调用（tx 为空）：审计失败只告警，不挡业务。
        // 事务内必须原样抛出：这张表的 session_id 有外键指向 course_sessions，而事务正锁着那一行，
        // 换一条连接补记会等自己的行锁（被等的一方 idle-in-transaction，死锁检测器看不见环）；
        // 且 PG 里语句一旦出错事务就进 aborted，吞掉只会让后面每条语句都报「current transaction is aborted」。
        if (tx) throw e;
        logger.warn('[course-session] 状态审计写入跳过:', e.message);
    }
}

const writeStatusLog = (tx, entry) => writeStatusLogs(tx, [entry]);

/**
 * session_change_logs.action 的取值。唯一源在 shared-utils（迁移里的 chk_scl_action CHECK 吃同一份），
 * 上面 import 进来后仍由本模块导出，消费者不必改导入路径。
 */

/**
 * 审计载荷里的取值归一。
 * DATE 列在 pg pool 路径下回来的是 Date 对象，**不能走 toISOString** ——
 * 存量迁移就是因为那一步的 UTC 偏移把 330 行整体早了一天，这里按本地时间分量取日期。
 */
function auditValue(v) {
    if (v === undefined) return null;
    if (v instanceof Date) {
        const p = (n) => String(n).padStart(2, '0');
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return v;
}

/** 记「提交了哪些字段、原值是什么」，不做相等过滤 —— 审计要如实反映请求，而不是推断出的最小差集 */
function fieldChanges(before, patch) {
    const out = {};
    for (const k of Object.keys(patch || {})) {
        out[k] = { from: auditValue(before ? before[k] : null), to: auditValue(patch[k]) };
    }
    return out;
}

/** pair 快照只留可识别的键，不把评价长文本抄进审计 */
const pairDigest = (p) => (p ? {
    uid: p.uid,
    teacher_id: p.teacher_id,
    student_id: p.student_id,
    type_id: p.type_id,
    status: p.status,
    fee_status: p.fee_status
} : null);

/**
 * 审计：结构与内容变更（状态流转在 session_status_logs、费用在 session_fee_* 两张）。
 * 一次多行插入，让批量清理路径只多付一次往返（Neon 每条语句约 300ms）。
 * 与 writeStatusLog 同口径：表不存在或写失败只告警，绝不阻断主流程。
 */
async function writeChangeLogs(tx, entries) {
    const rows = (entries || []).filter(Boolean);
    if (rows.length === 0) return;
    const params = [];
    const tuples = rows.map((e) => {
        params.push(
            e.sessionId, e.action, e.pairKind || null, e.pairUid || null,
            JSON.stringify(e.changes || {}), e.operatorId || null, e.actorType || 'admin', e.note || null
        );
        const n = params.length;
        return `($${n - 7}, $${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}::jsonb, $${n - 2}, $${n - 1}, $${n})`;
    });
    try {
        await pickQ(tx)(
            `INSERT INTO session_change_logs
             (session_id, action, pair_kind, pair_uid, changes, operator_id, actor_type, note)
             VALUES ${tuples.join(', ')}`,
            params
        );
    } catch (e) {
        // 与 writeStatusLogs 同一规则：事务内不吞错（吞了也拦不住已经 aborted 的事务），独立调用才只告警。
        if (tx) throw e;
        logger.warn('[course-session] 变更审计写入跳过:', e.message);
    }
}

const writeChangeLog = (tx, entry) => writeChangeLogs(tx, [entry]);


/**
 * 新建一场：多师多生一次成型。
 * 旧实现只取 studentIds[0] 插入、其余以 skipped_students 静默丢弃 —— 这里连同那个行为一起删掉。
 * 「临时加课」落在状态码的类别位上，不再经 is_temp / adjustment_type 两个名字来回错位
 * （旧路径新建时勾选不生效的那个 bug 随之消失）。
 */
/**
 * 写语句走哪个连接：tx 是事务里的查询函数（runInTransaction 交给 work 的那个 q），
 * 也可能是裸 client（.query）；不传就是 db.query 自提自交。
 * 事务内调用一定要传，否则语句在别的连接上先行提交 —— 外层回滚回滚不掉它，
 * 而且它会等自己外层持有的行锁（自我死锁）。
 */
const pickQ = (tx) => (typeof tx === 'function' ? tx : (tx ? tx.query.bind(tx) : db.query));

async function createSession(payload, actor, tx = null) {
    const actorId = actor && actor.id ? Number(actor.id) : null;
    const q = pickQ(tx);
    const teachersIn = Array.isArray(payload.teachers) ? payload.teachers : [];
    const studentsIn = Array.isArray(payload.students) ? payload.students : [];
    if (teachersIn.length === 0) throw new SessionValidationError('至少需要一位教师');
    if (studentsIn.length === 0) throw new SessionValidationError('至少需要一位学生');

    const teachers = teachersIn.map((t, i) => buildTeacherPair(t, `t${i + 1}`, actorId));
    const students = studentsIn.map((s, i) => buildStudentPair(s, `s${i + 1}`, actorId));

    await assertReferences({
        teacherIds: teachers.map(t => t.teacher_id),
        studentIds: students.map(s => s.student_id),
        typeIds: teachers.map(t => t.type_id)
    }, q);

    const r = await q(
        `INSERT INTO course_sessions
         (class_date, start_time, end_time, location, notes, teachers, students, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $8)
         RETURNING ${SESSION_COLUMNS}`,
        [payload.class_date, payload.start_time, payload.end_time,
            payload.location || null, payload.notes || null,
            JSON.stringify(teachers), JSON.stringify(students), actorId]
    );
    const created = r.rows[0];
    await writeChangeLog(tx, {
        sessionId: created.id,
        action: CHANGE_ACTIONS.CREATE,
        changes: {
            header: {
                class_date: auditValue(created.class_date),
                start_time: created.start_time,
                end_time: created.end_time,
                location: created.location,
                notes: created.notes
            },
            teachers: teachers.map(pairDigest),
            students: students.map(pairDigest)
        },
        operatorId: actorId,
        actorType: actor && actor.actorType
    });
    return created;
}

/**
 * 批量新建：AI 的「一次排一批」走这条。
 *
 * 往返固定 3 次（引用校验并发 1 次 + 一条多行 INSERT + 一条多行审计），不随场次数增长。
 * 逐个调 createSession 是 3N 次 —— 远程库每条约 250ms，10 个时段就是 7.5 秒。
 * uid 生成、pair 的 created_by、adjusted 不可指定这些规则与 createSession 完全一致
 * （复用同一对 buildTeacherPair / buildStudentPair）。
 * @param {object[]} payloads 与 createSession 的入参同形
 * @returns {object[]} 按入参顺序返回创建出的场次行
 */
async function createSessions(payloads, actor) {
    const list = Array.isArray(payloads) ? payloads : [];
    if (list.length === 0) return [];
    const actorId = actor && actor.id ? Number(actor.id) : null;

    const built = list.map((payload) => {
        const teachersIn = Array.isArray(payload.teachers) ? payload.teachers : [];
        const studentsIn = Array.isArray(payload.students) ? payload.students : [];
        if (teachersIn.length === 0) throw new SessionValidationError('至少需要一位教师');
        if (studentsIn.length === 0) throw new SessionValidationError('至少需要一位学生');
        return {
            payload,
            teachers: teachersIn.map((t, i) => buildTeacherPair(t, `t${i + 1}`, actorId)),
            students: studentsIn.map((st, i) => buildStudentPair(st, `s${i + 1}`, actorId))
        };
    });

    // 引用校验对整批做一次（去重后 id 集合通常很小）
    await assertReferences({
        teacherIds: built.flatMap(b => b.teachers.map(t => t.teacher_id)),
        studentIds: built.flatMap(b => b.students.map(st => st.student_id)),
        typeIds: built.flatMap(b => b.teachers.map(t => t.type_id))
    });

    const params = [actorId];
    const tuples = built.map(({ payload, teachers, students }) => {
        params.push(payload.class_date, payload.start_time, payload.end_time,
            payload.location || null, payload.notes || null,
            JSON.stringify(teachers), JSON.stringify(students));
        const n = params.length;
        return `($${n - 6}, $${n - 5}, $${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}::jsonb, $${n}::jsonb, $1, $1)`;
    });

    const r = await db.query(
        `INSERT INTO course_sessions
         (class_date, start_time, end_time, location, notes, teachers, students, created_by, updated_by)
         VALUES ${tuples.join(', ')}
         RETURNING ${SESSION_COLUMNS}`,
        params
    );
    // 多行 INSERT 的 RETURNING 顺序标准没有保证，SERIAL 又是按 VALUES 顺序取号的，
    // 所以按 id 升序排一次得到稳定顺序。审计**只从返回行自身**取 pair
    // （不用 built[i] 去对下标）—— 这样即便顺序与入参不一致，审计也不会挂错场次。
    const created = (r.rows || []).slice().sort((a, b) => Number(a.id) - Number(b.id));

    await writeChangeLogs(null, created.map((row) => ({
        sessionId: row.id,
        action: CHANGE_ACTIONS.CREATE,
        changes: {
            header: {
                class_date: auditValue(row.class_date),
                start_time: row.start_time,
                end_time: row.end_time,
                location: row.location,
                notes: row.notes
            },
            teachers: (row.teachers || []).map(pairDigest),
            students: (row.students || []).map(pairDigest)
        },
        operatorId: actorId,
        actorType: actor && actor.actorType
    })));

    return created;
}

/** 改头部：日期/时段/地点/备注，天然整场生效，不再需要「找同组其他行一起改」的补偿逻辑 */
async function updateSessionHeader(id, patch, actor, version, prev, tx = null) {
    const q = pickQ(tx);
    const sets = [];
    const params = [];
    for (const col of HEADER_COLUMNS) {
        if (patch[col] !== undefined) {
            params.push(patch[col] === '' ? null : patch[col]);
            sets.push(`${col} = $${params.length}`);
        }
    }
    if (sets.length === 0) throw new SessionValidationError('没有可更新的字段');
    // 审计要记原值。调用方（如 adminUpdateSchedule）通常刚读过这一场，
    // 传进来就能省一次往返；没传才自己读。写入安全仍由 version 乐观锁保证。
    const before = prev || await getSessionById(id, q);
    params.push(actor && actor.id ? Number(actor.id) : null);
    const byIdx = params.length;
    params.push(id);
    const idIdx = params.length;
    params.push(version);
    const r = await q(
        `UPDATE course_sessions
            SET ${sets.join(', ')}, version = version + 1,
                updated_at = CURRENT_TIMESTAMP, updated_by = $${byIdx}
          WHERE id = $${idIdx} AND version = $${params.length}
          RETURNING ${SESSION_COLUMNS}`,
        params
    );
    if (r.rowCount === 0) throw new VersionConflictError();
    await writeChangeLog(tx, {
        sessionId: id,
        action: CHANGE_ACTIONS.HEADER,
        changes: fieldChanges(before, patch),
        operatorId: actor && actor.id,
        actorType: actor && actor.actorType
    });
    return r.rows[0];
}

/**
 * 只改某个教师 pair 的生命周期位 —— 教师端、班主任端、管理员端共用这一个方法。
 *
 * 相关子查询原地重建：一条语句、无 version、无读回、按 uid 匹配、EXISTS 守卫、ORDER BY ord 保序。
 * split_part(...,'.',1) || '.' || $3 表示**只换后缀，类别前缀原样保留** ——
 * 类别是溯源属性，不该被状态切换顺手改掉（temp 的课取消后仍是 temp.cancelled）。
 */
async function setTeacherStatus(id, uid, lifecycle, actor, note, prev, tx = null) {
    if (!LIFECYCLES.includes(lifecycle)) throw new SessionValidationError(`未知生命周期 ${lifecycle}`);
    const q = pickQ(tx);
    // prev 只用于取审计的旧状态；真正的写是 SQL 内原地重建（读的是 cs.teachers 最新值），
    // 所以即使 prev 稍旧也不影响写入正确性。
    const before = prev || await getSessionById(id, q);
    if (!before) return { updated: false, notFound: true };
    const pair = findPair(before.teachers, uid);
    if (!pair) return { updated: false, notFound: true };

    const r = await q(
        `UPDATE course_sessions cs
            SET teachers = (
                  SELECT jsonb_agg(
                           CASE WHEN e->>'uid' = $2
                                THEN jsonb_set(e, '{status}',
                                       to_jsonb(split_part(e->>'status', '.', 1) || '.' || $3::text))
                                ELSE e END
                           ORDER BY ord)
                    FROM jsonb_array_elements(cs.teachers) WITH ORDINALITY AS a(e, ord)),
                updated_at = CURRENT_TIMESTAMP, updated_by = $4
          WHERE cs.id = $1
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(cs.teachers) x WHERE x->>'uid' = $2)
          RETURNING ${SESSION_COLUMNS}`,
        // updated_by FK 引用 administrators(id)：教师/班主任 actor 的 id 落在不相交的编号段，
        // 原样写入会触发 23503，因此非 admin 一律写 NULL。
        [id, String(uid), lifecycle, resolveAuditActorId(actor)]
    );
    if (r.rowCount === 0) return { updated: false, notFound: true };

    const after = findPair(r.rows[0].teachers, uid);
    await writeStatusLog(tx, {
        sessionId: id, teacherUid: uid, oldStatus: pair.status, newStatus: after.status,
        operatorId: actor && actor.id, actorType: actor && actor.actorType, note
    });
    return { updated: true, session: r.rows[0], status: after.status };
}

/** 整场取消：同形语句，全部 pair 换生命周期位为 cancelled，各自类别位保留。不需要 version */
async function cancelSession(id, actor) {
    const before = await getSessionById(id);
    if (!before) return { updated: false, notFound: true };

    const r = await db.query(
        `UPDATE course_sessions cs
            SET teachers = (
                  SELECT jsonb_agg(
                           jsonb_set(e, '{status}',
                             to_jsonb(split_part(e->>'status', '.', 1) || '.cancelled'))
                           ORDER BY ord)
                    FROM jsonb_array_elements(cs.teachers) WITH ORDINALITY AS a(e, ord)),
                updated_at = CURRENT_TIMESTAMP, updated_by = $2
          WHERE cs.id = $1
          RETURNING ${SESSION_COLUMNS}`,
        // 与 setTeacherStatus 同一条 FK 规则：updated_by 引用 administrators(id)，
        // 教师/班主任 id 号段不相交，原样写入会触发 23503。
        [id, resolveAuditActorId(actor)]
    );
    if (r.rowCount === 0) return { updated: false, notFound: true };
    await writeStatusLogs(null, (before.teachers || []).map(p => ({
        sessionId: id, teacherUid: p.uid, oldStatus: p.status,
        newStatus: `${splitStatus(p.status).category}.cancelled`,
        operatorId: actor && actor.id, actorType: actor && actor.actorType, note: '整场取消'
    })));
    return { updated: true, session: r.rows[0] };
}

/**
 * 管理员改 pair 内容（类型/评分/评价/家属人数/费用）：白名单裁剪后整列写回，带 version。
 * @returns {{ session, rejectedFields }}
 */
async function patchPair(id, kind, uid, rawPatch, actor, version, prev, tx = null) {
    const q = pickQ(tx);
    assertNoFeeFields(rawPatch);
    // 报销状态变更必须走费用接口：那里有状态机与 session_fee_status_logs 审计
    const feeStateHit = PATCH_ONLY_FEE_KEYS.filter(k => rawPatch && rawPatch[k] !== undefined);
    if (feeStateHit.length) {
        throw new SessionValidationError(
            `${feeStateHit.join('、')} 不能随排课修改提交：报销状态流转请改用费用接口` +
            '（…/fee-status，会校验合法流转并写审计）'
        );
    }
    const { patch, rejectedFields } = applyPairPatch(kind, rawPatch, actor);
    if (Object.keys(patch).length === 0) {
        throw new SessionValidationError('没有可更新的字段', rejectedFields);
    }
    const normalized = normalizePairPatch(kind, patch);
    // 调用方刚读过就直接用（省一次往返）；写回仍带 version，传了过期的 session 只会 409
    const session = prev || await getSessionById(id, q);
    if (!session) return { notFound: true, rejectedFields };

    const column = kind === 'teacher' ? 'teachers' : 'students';
    const arr = session[column] || [];
    const target = findPair(arr, uid);
    if (!target) return { notFound: true, rejectedFields };

    // 类别位不是独立列，而是 status 的前缀（"temp.confirmed"）。改类别 = 换前缀、生命周期后缀原样保留；
    // 走同样的「只换一段、另一段保留」规则，不另外引入 category 列，避免两处真值互相打架。
    if (normalized.category !== undefined) {
        if (!EDITABLE_CATEGORIES.includes(normalized.category)) {
            throw new SessionValidationError(`类别不能改成 ${normalized.category}`);
        }
        normalized.status = `${normalized.category}.${splitStatus(target.status).lifecycle}`;
        delete normalized.category;
    }

    // 换人必须验引用 + 查重：否则能把同一位老师写进同一场两次，或写进一个不存在的 id。
    // 查重排除自己（uid 不同才算冲突），且只算活跃 pair —— 已取消/已调走的不占名额。
    //
    // 只在「这一位真的换了人」时才查重：normalized.teacher_id 与 pair 当前值相等时是
    // 一次 no-op（编辑弹窗保存会把整个 teachers[] 原样回传，未改动的 pair 也带着原来的
    // teacher_id）。不跳过的话，一场被调整过的课（同时留有 normal.modified_away 原 pair 与
    // adjusted.* 增补 pair、两者 teacher_id 相同）在仅改时间/其他字段时，会把没动的原 pair
    // 拿去和活跃的增补 pair 比对 → 误报「这位老师已经在这一场课里了」。
    if (kind === 'teacher' && normalized.teacher_id !== undefined
        && Number(target.teacher_id) !== Number(normalized.teacher_id)) {
        if (arr.some(p => String(p.uid) !== String(uid)
            && Number(p.teacher_id) === Number(normalized.teacher_id) && isActive(p.status))) {
            throw new SessionValidationError('这位老师已经在这一场课里了');
        }
    }
    if (kind === 'student' && normalized.student_id !== undefined
        && Number(target.student_id) !== Number(normalized.student_id)) {
        if (arr.some(p => String(p.uid) !== String(uid)
            && Number(p.student_id) === Number(normalized.student_id))) {
            throw new SessionValidationError('这位学生已经在这一场课里了');
        }
    }

    const refs = {};
    if (normalized.type_id !== undefined) refs.typeIds = [normalized.type_id];
    if (normalized.teacher_id !== undefined) refs.teacherIds = [normalized.teacher_id];
    if (normalized.student_id !== undefined) refs.studentIds = [normalized.student_id];
    if (Object.keys(refs).length > 0) await assertReferences(refs, q);

    const next = arr.map(p => (String(p.uid) === String(uid) ? { ...p, ...normalized } : p));
    const r = await q(
        `UPDATE course_sessions
            SET ${column} = $1::jsonb, version = version + 1,
                updated_at = CURRENT_TIMESTAMP, updated_by = $2
          WHERE id = $3 AND version = $4
          RETURNING ${SESSION_COLUMNS}`,
        [JSON.stringify(next), actor && actor.id ? Number(actor.id) : null, id, version]
    );
    if (r.rowCount === 0) throw new VersionConflictError();
    await writeChangeLog(tx, {
        sessionId: id,
        action: CHANGE_ACTIONS.PAIR_PATCH,
        pairKind: kind,
        pairUid: uid,
        changes: fieldChanges(findPair(arr, uid), normalized),
        operatorId: actor && actor.id,
        actorType: actor && actor.actorType
    });
    return { session: r.rows[0], rejectedFields };
}

/** 加一位老师或学生：只写一列（不再有「两列键集合必须一致」的联动），带 version */
async function addPair(id, kind, payload, actor, version, tx = null, prev = null) {
    const q = pickQ(tx);
    // 调用方刚读过这一场就传进来（adminAddPair 与 updatePairsBatch 都是），省一次「写前读整场」
    const session = prev || await getSessionById(id, q);
    if (!session) return { notFound: true };
    const actorId = actor && actor.id ? Number(actor.id) : null;
    const column = kind === 'teacher' ? 'teachers' : 'students';
    const arr = session[column] || [];

    const pair = kind === 'teacher'
        ? buildTeacherPair(payload, nextUid(arr, 't'), actorId)
        : buildStudentPair(payload, nextUid(arr, 's'), actorId);

    // 重复校验前置到服务层：数据库的 validate_session_* 会兜底，但它抛出的是
    // `violates check constraint "chk_cs_students"` 这种对用户毫无意义的信息，
    // 所以同样的规则在这里先给一条能读懂的 400。
    if (kind === 'teacher') {
        const clash = arr.some(p => Number(p.teacher_id) === Number(pair.teacher_id) && isActive(p.status));
        if (clash) throw new SessionValidationError('这位老师已经在这一场课里了');
    } else {
        const clash = arr.some(p => Number(p.student_id) === Number(pair.student_id));
        if (clash) throw new SessionValidationError('这位学生已经在这一场课里了');
    }

    await assertReferences(kind === 'teacher'
        ? { teacherIds: [pair.teacher_id], typeIds: [pair.type_id] }
        : { studentIds: [pair.student_id] }, q);

    const r = await q(
        `UPDATE course_sessions
            SET ${column} = $1::jsonb, version = version + 1,
                updated_at = CURRENT_TIMESTAMP, updated_by = $2
          WHERE id = $3 AND version = $4
          RETURNING ${SESSION_COLUMNS}`,
        [JSON.stringify([...arr, pair]), actorId, id, version]
    );
    if (r.rowCount === 0) throw new VersionConflictError();
    await writeChangeLog(tx, {
        sessionId: id,
        action: CHANGE_ACTIONS.PAIR_ADD,
        pairKind: kind,
        pairUid: pair.uid,
        changes: { added: pairDigest(pair) },
        operatorId: actorId,
        actorType: actor && actor.actorType
    });
    return { session: r.rows[0], uid: pair.uid };
}

/**
 * 移除一位老师或学生。
 * 删到最后一个时拒绝 —— validate_session_* 要求两个数组都非空；
 * 「整场删除」是另一个动作（deleteSession），由调用方按提示改走那条路。
 */
async function removePair(id, kind, uid, actor, version, tx = null) {
    const q = pickQ(tx);
    const session = await getSessionById(id, q);
    if (!session) return { notFound: true };
    const column = kind === 'teacher' ? 'teachers' : 'students';
    const arr = session[column] || [];
    if (!findPair(arr, uid)) return { notFound: true };
    if (arr.length <= 1) {
        throw new SessionValidationError(
            kind === 'teacher' ? '这是本场最后一位教师，请改用「删除整场」' : '这是本场最后一位学生，请改用「删除整场」'
        );
    }
    const next = arr.filter(p => String(p.uid) !== String(uid));
    const r = await q(
        `UPDATE course_sessions
            SET ${column} = $1::jsonb, version = version + 1,
                updated_at = CURRENT_TIMESTAMP, updated_by = $2
          WHERE id = $3 AND version = $4
          RETURNING ${SESSION_COLUMNS}`,
        [JSON.stringify(next), actor && actor.id ? Number(actor.id) : null, id, version]
    );
    if (r.rowCount === 0) throw new VersionConflictError();
    // 移除后 pair 就不在表里了，这条审计是它存在过的唯一记录
    await writeChangeLog(tx, {
        sessionId: id,
        action: CHANGE_ACTIONS.PAIR_REMOVE,
        pairKind: kind,
        pairUid: uid,
        changes: { removed: pairDigest(findPair(arr, uid)) },
        operatorId: actor && actor.id,
        actorType: actor && actor.actorType
    });
    return { session: r.rows[0] };
}

/**
 * 整场编辑保存的一次性应用（管理员端 PATCH /admin/sessions/:id 提交整个表单时走这里）。
 *
 * 为什么值得：前端的旧路径是「每个 pair 各发一条 type PATCH + 一条 status PATCH，
 * 新增 pair 再各发一次 POST」，3 师 2 生的编辑要串行打 9 个 HTTP 请求（每次都是
 * 浏览器↔服务器一次往返 + 远程库一次往返）。收敛到本函数后，一次 HTTP 请求在服务端
 * 把整场 diff 应用完，网络往返降为 1。
 *
 * 写语句仍逐 pair 顺序执行：type/内容变更带 version 乐观锁（不可并行），状态变更的
 * 原地重建虽可并发（闸门 B 实测），但这里不额外追求——正确性优先于微调。
 *
 * 语义（与既有单 pair 端点完全一致）：
 * - 请求项带 uid → patchPair（内容）+ setTeacherStatus（若提供 lifecycle）；
 *      lifecycle 为 modified_away 且该 pair 尚未调走 → adjustTeacherPair（作废+增补）；
 * - 不带 uid → addPair（新增）；
 * - 库里已有但请求里没有的 pair：保留不动（删除走 removeSchedulePair 端点）；
 * - 白名单裁剪照旧（applyPairPatch / buildTeacherPair）。
 * 返回 { session, rejectedFields }；pair 定位失败抛 SessionValidationError。
 */
async function updatePairsBatch(id, body, actor, version, prev, tx = null) {
    const q = pickQ(tx);
    // 动手前先整体扫一遍钱键：下面逐 pair 发 UPDATE，非事务调用时没有「整批同生共死」，
    // 等走到第 N 个 pair 才让 patchPair 抛错的话，前 N-1 个已经写进库了。
    // 只扫带 uid 的项 —— 不带 uid 是新增 pair（新的一趟），那时还不存在逐学生格子，允许带一笔整趟费用。
    (Array.isArray(body && body.teachers) ? body.teachers : [])
        .filter(item => item && item.uid != null)
        .forEach(assertNoFeeFields);

    let session = prev || await getSessionById(id, q);
    if (!session) return { notFound: true };
    let cur = session;
    let curVersion = version !== undefined ? Number(version) : Number(session.version);
    const rejectedFields = [];

    const applyTeacher = async (item) => {
        const uid = item && item.uid != null ? String(item.uid) : null;
        if (uid) {
            const patch = {};
            // 换老师与改类别必须进 patch，否则编辑弹窗里改了这两项，请求里一个键都不带 →
            // 服务端「什么都没改」照返回 200，前端照弹成功提示（2026-09-08 修的那类静默失败）。
            // adjusted 不进 patch：它是溯源属性，只有作废+增补能写，普通编辑一律忽略。
            if (item.teacher_id !== undefined) patch.teacher_id = item.teacher_id;
            if (item.category !== undefined && EDITABLE_CATEGORIES.includes(item.category)) {
                patch.category = item.category;
            }
            if (item.type_id !== undefined) patch.type_id = item.type_id;
            if (item.teacher_rating !== undefined) patch.teacher_rating = item.teacher_rating;
            if (item.teacher_comment !== undefined) patch.teacher_comment = item.teacher_comment;
            // 费用键不在这里：改一趟里哪位学生的钱走费用接口（见文件头 PAIR_WRITE_WHITELIST）
            if (Object.keys(patch).length > 0) {
                const r = await patchPair(id, 'teacher', uid, patch, actor, curVersion, cur, q);
                if (r.notFound) throw new SessionValidationError('对不上库里的 teacher uid');
                rejectedFields.push(...(r.rejectedFields || []));
                cur = r.session;
                curVersion = Number(cur.version);
            }
            if (item.lifecycle) {
                const pair = cur.teachers.find(p => String(p.uid) === String(uid));
                const wasAdjusted = pair && pair.status.startsWith('adjusted.');
                if (item.lifecycle === 'modified_away' && pair && !pair.status.endsWith('.modified_away') && !wasAdjusted) {
                    const r = await adjustTeacherPair(id, uid, { type_id: item.type_id }, actor, curVersion, cur, { tx: q });
                    if (r.notFound) throw new SessionValidationError('对不上库里的 teacher uid');
                    cur = r.session;
                    curVersion = Number(cur.version);
                } else {
                    const r = await setTeacherStatus(id, uid, item.lifecycle, actor, null, cur, q);
                    if (!r.updated) throw new SessionValidationError('对不上库里的 teacher uid');
                    cur = r.session;
                    curVersion = Number(cur.version);
                }
            }
            return;
        }
        const r = await addPair(id, 'teacher', item, actor, curVersion, q, cur);
        if (r.notFound) throw new SessionValidationError('对不上场次');
        cur = r.session;
        curVersion = Number(cur.version);
    };

    const applyStudent = async (item) => {
        const uid = item && item.uid != null ? String(item.uid) : null;
        if (uid) {
            const patch = {};
            if (item.student_id !== undefined) patch.student_id = item.student_id;
            if (item.family_participants !== undefined) patch.family_participants = item.family_participants;
            if (item.student_rating !== undefined) patch.student_rating = item.student_rating;
            if (item.student_comment !== undefined) patch.student_comment = item.student_comment;
            if (Object.keys(patch).length > 0) {
                const r = await patchPair(id, 'student', uid, patch, actor, curVersion, cur, q);
                if (r.notFound) throw new SessionValidationError('对不上库里的 student uid');
                rejectedFields.push(...(r.rejectedFields || []));
                cur = r.session;
                curVersion = Number(cur.version);
            }
            return;
        }
        const r = await addPair(id, 'student', item, actor, curVersion, q, cur);
        if (r.notFound) throw new SessionValidationError('对不上场次');
        cur = r.session;
        curVersion = Number(cur.version);
    };

    for (const item of (body.teachers || [])) await applyTeacher(item);
    for (const item of (body.students || [])) await applyStudent(item);

    return { session: cur, rejectedFields };
}

/**
 * 硬删整场：前三张审计表随 ON DELETE CASCADE 清理。
 * session_change_logs 刻意没有外键，所以这条 delete 记录能留在删除之后 ——
 * 用 RETURNING 拿到整行做快照，不多付一次读。
 */
async function deleteSession(id, actor) {
    const r = await db.query(
        `DELETE FROM course_sessions WHERE id = $1 RETURNING ${SESSION_COLUMNS}`, [id]
    );
    const row = (r.rows || [])[0];
    if (!row) return { deleted: false };
    await writeChangeLog(null, deleteLogEntry(row, actor));
    return { deleted: true };
}

/** 批量硬删（AI 批量删除走这里）：一条 DELETE + 一条多行审计插入，往返数不随条数增长 */
async function deleteSessions(ids, actor) {
    const list = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
    if (list.length === 0) return { deleted: 0 };
    const r = await db.query(
        `DELETE FROM course_sessions WHERE id = ANY($1::int[]) RETURNING ${SESSION_COLUMNS}`, [list]
    );
    const rows = r.rows || [];
    await writeChangeLogs(null, rows.map(row => deleteLogEntry(row, actor)));
    return { deleted: rows.length };
}

/** 删除审计的载荷：整场快照（删掉之后这是唯一的记录） */
const deleteLogEntry = (row, actor) => ({
    sessionId: row.id,
    action: CHANGE_ACTIONS.DELETE,
    changes: {
        header: {
            class_date: auditValue(row.class_date),
            start_time: row.start_time,
            end_time: row.end_time,
            location: row.location,
            notes: row.notes
        },
        teachers: (row.teachers || []).map(pairDigest),
        students: (row.students || []).map(pairDigest)
    },
    operatorId: actor && actor.id,
    actorType: actor && actor.actorType
});

/**
 * 作废+增补：把原 uid 的生命周期换成 modified_away（类别位保留），同时追加一个
 * 同 teacher_id、新 uid、新 type_id、status = 'adjusted.pending' 的 pair。一条 UPDATE、带 version。
 *
 * adjusted 这个类别位**只有这条路径能写**，它替代旧表的 adjustment_type=2 溯源标记。
 * 追加后数组里出现同一 teacher_id 的两个 pair —— 合法，因为活跃唯一性只看活跃 pair，
 * 原 pair 已是 modified_away（现网那 4 组历史数据正是这个形状）。
 *
 * `detach: true` 时只归档、**不追加**：用于「只把某一位教师挪到另一个时段」——
 * 增补记录由调用方建到新场次，原场次里不再留一条活跃 pair，
 * 否则同一位教师会同时占着旧时段和新时段（日历两格、统计多算一场）。
 * 第二参数还可以带 `teacher_id`：调整时换人（增补 pair 记在新教师名下）。
 */
async function adjustTeacherPair(id, uid, { type_id, teacher_id }, actor, version, prev, { skipTypeAssert = false, detach = false, tx = null } = {}) {
    const q = pickQ(tx);
    const session = prev || await getSessionById(id, q);
    if (!session) return { notFound: true };
    const arr = session.teachers || [];
    const origin = findPair(arr, uid);
    if (!origin) return { notFound: true };
    const newTypeId = intOrNull(type_id) ?? origin.type_id;
    const newTeacherId = intOrNull(teacher_id) ?? origin.teacher_id;
    // 调用方已批量校验过存在性时可跳过（confirm_operation 循环内多次调用同一批 id）
    if (!skipTypeAssert) {
        // 只有真的换人才需要复查教师；单纯改课程类型不必把原教师再查一遍（少一次往返）
        await assertReferences(teacher_id != null
            ? { teacherIds: [newTeacherId], typeIds: [newTypeId] }
            : { typeIds: [newTypeId] }, q);
    }

    const actorId = actor && actor.id ? Number(actor.id) : null;
    const movedAway = `${splitStatus(origin.status).category}.modified_away`;
    const next = arr.map(p => (String(p.uid) === String(uid) ? { ...p, status: movedAway } : p));
    let added = null;
    if (!detach) {
        added = buildTeacherPair(
            { teacher_id: newTeacherId, type_id: newTypeId, lifecycle: 'pending' },
            nextUid(next, 't'), actorId
        );
        added.status = 'adjusted.pending';
        next.push(added);
    }

    const r = await q(
        `UPDATE course_sessions
            SET teachers = $1::jsonb, version = version + 1,
                updated_at = CURRENT_TIMESTAMP, updated_by = $2
          WHERE id = $3 AND version = $4
          RETURNING ${SESSION_COLUMNS}`,
        [JSON.stringify(next), actorId, id, version]
    );
    if (r.rowCount === 0) throw new VersionConflictError();

    await writeStatusLogs(tx, [
        {
            sessionId: id, teacherUid: uid, oldStatus: origin.status, newStatus: movedAway,
            operatorId: actorId, actorType: actor && actor.actorType,
            note: detach ? '作废+挪场：原课调走' : '作废+增补：原课调走'
        },
        ...(added ? [{
            sessionId: id, teacherUid: added.uid, oldStatus: null, newStatus: added.status,
            operatorId: actorId, actorType: actor && actor.actorType, note: '作废+增补：新增增补课'
        }] : [])
    ]);
    // 这条流程会往数组里加一个 pair，所以结构变更同样进 change_logs，
    // 让「这一场的 pair 是怎么变成今天这样的」在一张表里读得完整。
    // detach 时没有新增 pair，只留一条「这一对被归档」的痕迹（增补落在哪个新场次由那一场自己的审计记）。
    await writeChangeLog(tx, {
        sessionId: id,
        action: added ? CHANGE_ACTIONS.PAIR_ADD : CHANGE_ACTIONS.PAIR_PATCH,
        pairKind: 'teacher',
        pairUid: uid,
        changes: added
            ? { added: pairDigest(added), moved_away: pairDigest({ ...origin, status: movedAway }) }
            : { status: { from: origin.status, to: movedAway }, moved_to_new_session: true },
        operatorId: actorId,
        actorType: actor && actor.actorType,
        note: detach ? '作废+挪场' : '作废+增补'
    });
    return {
        session: r.rows[0],
        movedUid: uid,
        addedUid: added ? added.uid : null,
        // 挪场时调用方要用它建新场次（教师与类型都在这条 pair 上，只是换个时段上课）
        detached: detach ? { teacher_id: newTeacherId, type_id: newTypeId } : null
    };
}

/**
 * 删用户前的清理：把该用户从所有场次的 pair 里移除；移除后数组空了的场次整场删除。
 *
 * 语义相对旧表**有意改变**：旧实现是 `DELETE FROM course_arrangement WHERE teacher_id = $1`，
 * 在一场多师多生的新结构下「整场删掉」是错的 —— 同场其他老师和学生不该被牵连。
 * @param {'teacher'|'student'} kind
 * @returns {{ affectedSessions:number, deletedSessions:number }} 供删除确认弹窗如实提示 N/M
 */
async function removeUserFromAllSessions(userId, kind, actor, tx = null) {
    // 这个清理要在 user-service 的「删用户」事务里跑：读、批量 UPDATE、DELETE、审计四条语句必须
    // 落在同一个连接上，否则外层回滚时课程里的引用已经被清掉、用户却还在（原来就是这个洞）
    const q = pickQ(tx);
    const uid = Number(userId);
    const column = kind === 'teacher' ? 'teachers' : 'students';
    const idsColumn = kind === 'teacher' ? 'teacher_ids' : 'student_ids';
    const idKey = kind === 'teacher' ? 'teacher_id' : 'student_id';

    const r = await q(
        // FOR UPDATE + ORDER BY id：整列写是读-改-写，不锁住就会覆盖同时发生的另一位编辑
        // （审查报告 P1-13 的同族问题，P3-6）；固定加锁顺序避免两个清理互相死锁。
        `SELECT id, ${column} AS pairs FROM course_sessions WHERE ${idsColumn} @> ARRAY[$1::int] ORDER BY id FOR UPDATE`,
        [uid]
    );
    const rows = r.rows || [];
    const toDelete = [];
    const toUpdate = [];
    const logs = [];
    let affected = 0;

    for (const row of rows) {
        const next = (row.pairs || []).filter(p => Number(p[idKey]) !== uid);
        if (next.length === (row.pairs || []).length) continue;
        const removed = (row.pairs || []).filter(p => Number(p[idKey]) === uid).map(pairDigest);
        const whole = next.length === 0;
        if (whole) toDelete.push(row.id);
        else {
            toUpdate.push({ id: row.id, pairs: next });
            affected++;
        }
        logs.push({
            sessionId: row.id,
            action: CHANGE_ACTIONS.USER_CLEANUP,
            pairKind: kind,
            changes: { removed, whole_session_deleted: whole, user_id: uid },
            operatorId: actor && actor.id,
            actorType: (actor && actor.actorType) || 'admin',
            note: whole ? '删除用户：该场仅剩此人，整场删除' : '删除用户：从该场移除'
        });
    }
    // 一条 UPDATE ... FROM (VALUES ...) 写完全部改动场次（原来是每场一条，远程库每条约 250ms）
    if (toUpdate.length) {
        const params = [];
        const valueRows = toUpdate.map((u) => {
            params.push(u.id, JSON.stringify(u.pairs));
            const n = params.length;
            return `($${n - 1}::int, $${n}::jsonb)`;
        });
        await q(
            `UPDATE course_sessions cs
                SET ${column} = v.pairs, version = cs.version + 1, updated_at = CURRENT_TIMESTAMP
               FROM (VALUES ${valueRows.join(', ')}) AS v(id, pairs)
              WHERE cs.id = v.id`,
            params
        );
    }
    if (toDelete.length) {
        await q('DELETE FROM course_sessions WHERE id = ANY($1::int[])', [toDelete]);
    }
    // 一次多行插入：批量清理只多付一次往返，不随场次数线性增长
    await writeChangeLogs(tx, logs);
    return { affectedSessions: affected, deletedSessions: toDelete.length };
}

/** 统计删除影响面（只读），供确认弹窗提示「N 场课将移除该老师，其中 M 场将被整场删除」 */
async function countUserImpact(userId, kind) {
    const uid = Number(userId);
    const column = kind === 'teacher' ? 'teachers' : 'students';
    const idsColumn = kind === 'teacher' ? 'teacher_ids' : 'student_ids';
    const idKey = kind === 'teacher' ? 'teacher_id' : 'student_id';

    // 「整场会被删除」的判据必须与 removeUserFromAllSessions 的 `next.length === 0` 同源。
    // 以前这里写的是 `jsonb_array_length(column) = 1`（审查报告 P3-4）：同一场里同一个人
    // 出现两次（例如一位老师带两个不同类型 pair）时长度是 2，确认框说「只移除不删场」，
    // 实际删除时两个 pair 都被滤掉 → 整场消失。现在按「滤掉这个人的 pair 之后还剩几个」数。
    const r = await db.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE (
                    SELECT count(*) FROM jsonb_array_elements(${column}) e
                     WHERE (e->>'${idKey}')::int IS DISTINCT FROM $1
                ) = 0)::int AS whole
           FROM course_sessions WHERE ${idsColumn} @> ARRAY[$1::int]`,
        [uid]
    );
    const row = (r.rows || [])[0] || { total: 0, whole: 0 };
    return { affectedSessions: row.total, deletedSessions: row.whole };
}

/**
 * admin pair 内 created_by 的定位谓词。
 *
 * **不能用 ::text LIKE**：PG 的 jsonb `::text` 输出在冒号与逗号后都带空格
 * （`{"created_by": 7, ...}`），而 created_by 经 jsonb 规范化后可能排在对象任意位置、
 * 也可能是最后一个键（后跟 `}` 而非 `,`）—— 任何固定格式的模式都会漏，此前
 * `LIKE '%"created_by":7,%'`（无空格）就因此一次都匹配不到，改管理员 ID 时
 * pair 级 created_from 从未被同步过。
 * 改用 jsonb_path_exists：不依赖文本格式与键位置；vars 同时给 number 和 string
 * 两种形态（历史数据 jsonb_typeof 实测全是 number，string 分支是防御性的）。
 */
const ADMIN_CREATED_BY_PATH = '$[*].created_by ? (@ == $n || @ == $s)';

/**
 * 用户改主键（new_id）时同步 JSONB pair 引用 —— 这里的 teacher_id / student_id / created_by
 * 没有外键，表级 ON UPDATE CASCADE 够不到，必须在同一事务里手动改写。
 * kind: 'teacher' | 'student' | 'admin'（admin 只动 pair 内 created_by）。
 * tx 可选：由 user-service 的 runInTransaction 传入，保证与主表 UPDATE 原子。
 */
async function renameUserInAllSessions(userId, newId, kind, tx = null) {
    const uid = Number(userId);
    const nid = Number(newId);
    // tx 可能是裸 client（.query）或降级包装对象，统一取函数
    const q = typeof tx === 'function' ? tx : (tx ? tx.query.bind(tx) : db.query);

    // 找出所有可能引用旧 ID 的场次：teacher/student 走派生列（GIN 索引），
    // admin 的 created_by 藏在 pair JSON 里没有可用的 jsonb_path_ops 谓词索引，
    // 全表扫过滤（管理员数量少、改号极少，成本与旧实现持平）
    let rows;
    if (kind === 'admin') {
        const r = await q(
            `SELECT id, teachers, students FROM course_sessions
              WHERE jsonb_path_exists(teachers, $1, $2::jsonb)
                 OR jsonb_path_exists(students, $1, $2::jsonb)
              ORDER BY id FOR UPDATE`,
            [ADMIN_CREATED_BY_PATH, JSON.stringify({ n: uid, s: String(uid) })]
        );
        rows = r.rows || [];
    } else {
        const idsColumn = kind === 'teacher' ? 'teacher_ids' : 'student_ids';
        const r = await q(
            `SELECT id, teachers, students FROM course_sessions WHERE ${idsColumn} @> ARRAY[$1::int] ORDER BY id FOR UPDATE`,
            [uid]
        );
        rows = r.rows || [];
    }

    const idKey = kind === 'teacher' ? 'teacher_id' : 'student_id';
    const toUpdate = [];
    const logs = [];

    for (const row of rows) {
        let changed = false;
        const rewrite = (pairs) => (pairs || []).map(p => {
            const hit = kind === 'admin'
                ? Number(p.created_by) === uid
                : Number(p[idKey]) === uid;
            if (!hit) return p;
            changed = true;
            return kind === 'admin' ? { ...p, created_by: nid } : { ...p, [idKey]: nid };
        });
        const nextTeachers = rewrite(row.teachers);
        const nextStudents = rewrite(row.students);
        if (!changed) continue;
        toUpdate.push({ id: row.id, teachers: nextTeachers, students: nextStudents });
        logs.push({
            sessionId: row.id,
            action: CHANGE_ACTIONS.USER_ID_MIGRATED,
            pairKind: kind,
            changes: { [kind === 'admin' ? 'created_by' : idKey]: { from: uid, to: nid } },
            operatorId: nid,
            actorType: 'admin',
            note: '用户改ID：同步 pair 引用'
        });
    }

    if (toUpdate.length) {
        const params = [];
        const valueRows = toUpdate.map((u) => {
            params.push(u.id, JSON.stringify(u.teachers), JSON.stringify(u.students));
            const n = params.length;
            return `($${n - 2}::int, $${n - 1}::jsonb, $${n}::jsonb)`;
        });
        await q(
            `UPDATE course_sessions cs
                SET teachers = v.teachers, students = v.students,
                    version = cs.version + 1, updated_at = CURRENT_TIMESTAMP
               FROM (VALUES ${valueRows.join(', ')}) AS v(id, teachers, students)
              WHERE cs.id = v.id`,
            params
        );
    }
    await writeChangeLogs(tx, logs);
    return { affectedSessions: toUpdate.length };
}

module.exports = {
    VersionConflictError,
    SessionValidationError,
    LIFECYCLES,
    CATEGORIES,
    CHANGE_ACTIONS,
    SESSION_COLUMNS,          // 供调用方批量预读场次（避免逐条 getSessionById）
    // 谓词生成器（禁止各处手拼 jsonpath）
    categoryPathPredicate,
    lifecyclePathPredicate,
    statusPathPredicate,
    isActive,
    // SQL 片段生成器（禁止各处手写 status 谓词；两种口径不等价）
    sqlActivePair,
    sqlActivePairJsonb,
    sqlActiveTeacherPairJsonb,
    sqlNotMovedAway,
    sqlStudentSwapped,
    // 读
    getSessionById,
    countUserImpact,
    // 写
    createSession,
    createSessions,
    updateSessionHeader,
    updatePairsBatch,
    setTeacherStatus,
    cancelSession,
    patchPair,
    addPair,
    removePair,
    deleteSession,
    deleteSessions,
    adjustTeacherPair,
    removeUserFromAllSessions,
    renameUserInAllSessions,
    // 供单测与控制器复用
    assertNoFeeFields,
    resolveAuditActorId,
    primeAuditAttributionCapability,
    applyPairPatch,
    buildTeacherPair,
    buildStudentPair,
    nextUid,
    assertReferences
};
