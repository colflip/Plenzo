/**
 * course-session-service 单测：一场一行 + 教师/学生双 pair 数组的写入路径。
 *
 * 重点覆盖三条设计纪律（它们是整套方案的承重墙）：
 * 1. 状态类写入走「相关子查询原地重建」—— 只改 status 一个键、只匹配一个 uid、不带 version；
 * 2. 整列写（改 pair 内容 / 增删 pair）必须带 version，rowCount = 0 → 409；
 * 3. 类别位是溯源属性 —— 状态切换只替换生命周期后缀，temp / adjusted 不会掉回 normal。
 */
const db = require('../../db/db');
const svc = require('../../services/course-session-service');

jest.mock('../../db/db');
jest.mock('../../utils/logger', () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ADMIN = { id: 7, actorType: 'admin' };
const TEACHER = { id: 1120, actorType: 'teacher' };

const teacherPair = (over = {}) => ({
    uid: 't1', teacher_id: 1120, type_id: 2, status: 'normal.confirmed', auto_at: null,
    teacher_rating: null, teacher_comment: null, transport_fee: null, other_fee: null,
    fee_status: 'draft', created_by: 7, ...over
});
const studentPair = (over = {}) => ({
    uid: 's1', student_id: 2001, student_rating: null, student_comment: null,
    family_participants: 4, created_by: 7, ...over
});
const session = (over = {}) => ({
    id: 10, class_date: '2026-09-01', start_time: '19:00:00', end_time: '22:00:00',
    location: '张三家', notes: null, version: 3,
    teachers: [teacherPair()], students: [studentPair()],
    teacher_ids: [1120], student_ids: [2001], ...over
});

const okRows = (rows) => ({ rows, rowCount: rows.length });

beforeEach(() => {
    jest.clearAllMocks();
    // 兜底实现：每个写方法尾部都会追加一条 session_change_logs 审计插入，
    // 各用例的 mockResolvedValueOnce 链只覆盖主流程语句，审计那一条落到这里。
    db.query.mockResolvedValue(okRows([]));
});

describe('纯函数与谓词生成器', () => {
    test('categoryPathPredicate 枚举全部 5 个生命周期字面量（否则拿不到 GIN 索引）', () => {
        const p = svc.categoryPathPredicate('temp');
        expect(p).toContain('@.status == "temp.pending"');
        expect(p).toContain('@.status == "temp.modified_away"');
        expect(p.match(/@\.status ==/g)).toHaveLength(5);
    });

    test('lifecyclePathPredicate 枚举全部 3 个类别', () => {
        const p = svc.lifecyclePathPredicate('confirmed');
        expect(p.match(/@\.status ==/g)).toHaveLength(3);
        expect(p).toContain('adjusted.confirmed');
    });

    test('未知取值直接抛错，不生成谓词', () => {
        expect(() => svc.categoryPathPredicate('weird')).toThrow(svc.SessionValidationError);
        expect(() => svc.lifecyclePathPredicate('done')).toThrow(svc.SessionValidationError);
    });

    test('isActive：cancelled / modified_away 不活跃，其余活跃', () => {
        expect(svc.isActive('temp.cancelled')).toBe(false);
        expect(svc.isActive('normal.modified_away')).toBe(false);
        expect(svc.isActive('adjusted.pending')).toBe(true);
    });

    test('nextUid 取未占用的最小序号，不复用刚删掉的编号', () => {
        expect(svc.nextUid([{ uid: 't1' }, { uid: 't3' }], 't')).toBe('t2');
        expect(svc.nextUid([], 's')).toBe('s1');
    });
});

describe('createSession：多师多生一次成型', () => {
    test('生成 t1..tn / s1..sn，pair 的 created_by 来自 actor，请求传入的同名键被忽略', async () => {
        db.query
            .mockResolvedValueOnce(okRows([{ id: 1120 }, { id: 1131 }]))   // teachers 引用校验
            .mockResolvedValueOnce(okRows([{ id: 2001 }, { id: 2002 }]))   // students 引用校验
            .mockResolvedValueOnce(okRows([{ id: 2 }, { id: 4 }]))         // schedule_types 引用校验
            .mockResolvedValueOnce(okRows([session()]));                   // INSERT

        await svc.createSession({
            class_date: '2026-09-01', start_time: '19:00', end_time: '22:00', location: '张三家',
            teachers: [
                { teacher_id: 1120, type_id: 2, category: 'normal', lifecycle: 'confirmed', created_by: 999, uid: 'hack' },
                { teacher_id: 1131, type_id: 4, category: 'temp' }
            ],
            students: [{ student_id: 2001 }, { student_id: 2002, family_participants: 2 }]
        }, ADMIN);

        const insert = db.query.mock.calls[3];
        const teachers = JSON.parse(insert[1][5]);
        const students = JSON.parse(insert[1][6]);
        expect(teachers.map(t => t.uid)).toEqual(['t1', 't2']);
        expect(students.map(s => s.uid)).toEqual(['s1', 's2']);
        expect(teachers[0].created_by).toBe(7);
        expect(teachers[1].status).toBe('temp.pending');   // 类别位来自请求、生命周期缺省 pending
        expect(students[1].family_participants).toBe(2);
        expect(students[0].family_participants).toBe(4);   // 缺省 4
        // 派生列不出现在写入列清单里（GENERATED ALWAYS，写它数据库会报错）；RETURNING 里读它是允许的
        expect(insert[0].slice(0, insert[0].indexOf('VALUES'))).not.toMatch(/teacher_ids|student_ids/);
    });

    test('类别 adjusted 不接受请求指定，降级为 normal（只有作废+增补流程能写）', async () => {
        db.query
            .mockResolvedValueOnce(okRows([{ id: 1120 }]))
            .mockResolvedValueOnce(okRows([{ id: 2001 }]))
            .mockResolvedValueOnce(okRows([{ id: 2 }]))
            .mockResolvedValueOnce(okRows([session()]));
        await svc.createSession({
            class_date: '2026-09-01', start_time: '19:00', end_time: '22:00',
            teachers: [{ teacher_id: 1120, type_id: 2, category: 'adjusted', lifecycle: 'completed' }],
            students: [{ student_id: 2001 }]
        }, ADMIN);
        expect(JSON.parse(db.query.mock.calls[3][1][5])[0].status).toBe('normal.completed');
    });

    test('引用完整性：不存在的教师 id 直接拒绝，不发 INSERT', async () => {
        db.query.mockResolvedValueOnce(okRows([{ id: 1120 }]));   // 1131 缺失
        await expect(svc.createSession({
            class_date: '2026-09-01', start_time: '19:00', end_time: '22:00',
            teachers: [{ teacher_id: 1120, type_id: 2 }, { teacher_id: 1131, type_id: 2 }],
            students: [{ student_id: 2001 }]
        }, ADMIN)).rejects.toThrow(/教师 ID 不存在: 1131/);
        // 三张表的引用校验是并发发出的（省两次往返），所以这里是 3 条查询而不是 1 条；
        // 关键断言是**没有** INSERT —— 校验不通过就不该写库。
        expect(db.query.mock.calls.every(c => !/INSERT INTO course_sessions/.test(String(c[0])))).toBe(true);
    });

    test('教师或学生为空直接拒绝（与 validate_session_* 的数组非空一致）', async () => {
        await expect(svc.createSession({ teachers: [], students: [{ student_id: 1 }] }, ADMIN))
            .rejects.toThrow('至少需要一位教师');
        await expect(svc.createSession({ teachers: [{ teacher_id: 1, type_id: 1 }], students: [] }, ADMIN))
            .rejects.toThrow('至少需要一位学生');
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('setTeacherStatus：相关子查询原地重建', () => {
    test('语句只改 status 一个键、只匹配一个 uid、带 EXISTS 守卫与 ORDER BY ord，且不带 version', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))                                        // 写前读
            .mockResolvedValueOnce(okRows([session({ teachers: [teacherPair({ status: 'normal.completed' })] })]))
            .mockResolvedValueOnce(okRows([]));                                                // 审计
        const r = await svc.setTeacherStatus(10, 't1', 'completed', TEACHER);

        const sql = db.query.mock.calls[1][0];
        expect(sql).toMatch(/jsonb_agg/);
        expect(sql).toMatch(/WITH ORDINALITY/);
        expect(sql).toMatch(/ORDER BY ord/);
        expect(sql).toMatch(/EXISTS \(SELECT 1 FROM jsonb_array_elements/);
        expect(sql).toMatch(/jsonb_set\(e, '\{status\}'/);
        // 状态路径不用乐观锁：SET / WHERE 里都不出现 version（RETURNING 里读它是允许的）
        expect(sql.slice(0, sql.indexOf('RETURNING'))).not.toMatch(/version/);
        expect(sql).toMatch(/split_part\(e->>'status', '\.', 1\)/);  // 类别位原样保留
        expect(r.updated).toBe(true);
        expect(r.status).toBe('normal.completed');
    });

    test('审计记完整旧码 → 完整新码（比旧表只记 confirmed→completed 多留类别信息）', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session({ teachers: [teacherPair({ status: 'temp.confirmed' })] })]))
            .mockResolvedValueOnce(okRows([session({ teachers: [teacherPair({ status: 'temp.completed' })] })]))
            .mockResolvedValueOnce(okRows([]));
        await svc.setTeacherStatus(10, 't1', 'completed', ADMIN);
        const audit = db.query.mock.calls[2][1];
        expect(audit[2]).toBe('temp.confirmed');
        expect(audit[3]).toBe('temp.completed');   // 类别位没掉回 normal
    });

    test('uid 不存在 → notFound，不发 UPDATE', async () => {
        db.query.mockResolvedValueOnce(okRows([session()]));
        const r = await svc.setTeacherStatus(10, 't9', 'completed', ADMIN);
        expect(r).toEqual({ updated: false, notFound: true });
        expect(db.query).toHaveBeenCalledTimes(1);
    });

    test('非法生命周期直接抛错', async () => {
        await expect(svc.setTeacherStatus(10, 't1', 'done', ADMIN)).rejects.toThrow(/未知生命周期/);
        expect(db.query).not.toHaveBeenCalled();
    });
});

describe('取消：整场与单个 pair', () => {
    test('整场取消一条语句改全部 pair，各自类别位保留，审计一条多行插入', async () => {
        const before = session({ teachers: [teacherPair(), teacherPair({ uid: 't2', teacher_id: 1131, status: 'temp.confirmed' })] });
        db.query
            .mockResolvedValueOnce(okRows([before]))
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([]));
        const r = await svc.cancelSession(10, ADMIN);
        expect(r.updated).toBe(true);
        const sql = db.query.mock.calls[1][0];
        expect(sql).toMatch(/\|\| '\.cancelled'/);
        expect(sql.slice(0, sql.indexOf('RETURNING'))).not.toMatch(/version/);
        // 审计是一条多行 INSERT（每 pair 7 个参数），不是逐 pair 发 —— 远程库每条约 250ms
        const [auditSql, auditParams] = db.query.mock.calls[2];
        expect(auditSql).toMatch(/INSERT INTO session_status_logs/);
        expect(auditParams).toHaveLength(14);
        expect(auditParams[3]).toBe('normal.cancelled');
        expect(auditParams[10]).toBe('temp.cancelled');
    });
});

describe('applyPairPatch 字段白名单', () => {
    test('管理员可改类型与评分', () => {
        const r = svc.applyPairPatch('teacher', { type_id: 5, teacher_rating: 4 }, ADMIN);
        expect(r.patch).toEqual({ type_id: 5, teacher_rating: 4 });
        expect(r.rejectedFields).toEqual([]);
    });

    test('教师改类型/评分被丢弃并计数，只留费用键', () => {
        const r = svc.applyPairPatch('teacher', { type_id: 5, teacher_rating: 4, transport_fee: 30 }, TEACHER);
        expect(r.patch).toEqual({ transport_fee: 30 });
        expect(r.rejectedFields.sort()).toEqual(['teacher_rating', 'type_id']);
    });

    test('教师对学生 pair 一个键都改不了', () => {
        const r = svc.applyPairPatch('student', { family_participants: 2 }, TEACHER);
        expect(r.patch).toEqual({});
        expect(r.rejectedFields).toEqual(['family_participants']);
    });

    test('created_by / uid 任何身份都改不了（服务端决定）', () => {
        const r = svc.applyPairPatch('teacher', { created_by: 99, uid: 't9' }, ADMIN);
        expect(r.patch).toEqual({});
        expect(r.rejectedFields.sort()).toEqual(['created_by', 'uid']);
    });

    // 2026-09-08：编辑弹窗里换老师 / 换学生 / 改类别三个入口静默失败（提示成功、库里没动）。
    // 根因是这三个键既没被前端提交、也不在白名单里，下面这几条把放行的口子钉死。
    test('管理员可改 teacher_id / category，学生侧可改 student_id', () => {
        expect(svc.applyPairPatch('teacher', { teacher_id: 1150, category: 'temp' }, ADMIN).patch)
            .toEqual({ teacher_id: 1150, category: 'temp' });
        expect(svc.applyPairPatch('student', { student_id: 2002 }, ADMIN).patch)
            .toEqual({ student_id: 2002 });
    });

    test('教师身份依旧换不了老师（换人是管理员专属）', () => {
        const r = svc.applyPairPatch('teacher', { teacher_id: 1150 }, TEACHER);
        expect(r.patch).toEqual({});
        expect(r.rejectedFields).toEqual(['teacher_id']);
    });
});

describe('换人 / 改类别（编辑弹窗三个此前静默失败的入口）', () => {
    test('patchPair 换老师：teacher_id 落进写回的列，并先校验引用存在', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([{ id: 1150 }]))      // teacher 引用校验
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        await svc.patchPair(10, 'teacher', 't1', { teacher_id: 1150 }, ADMIN, 3);
        const written = JSON.parse(db.query.mock.calls[2][1][0]);
        expect(written[0].teacher_id).toBe(1150);
        expect(db.query.mock.calls[1][0]).toContain('FROM teachers');
    });

    test('换成同一场里已有的活跃老师 → 400（不写库）', async () => {
        const cur = session({
            teachers: [teacherPair(), teacherPair({ uid: 't2', teacher_id: 1131 })]
        });
        db.query.mockResolvedValueOnce(okRows([cur]));
        await expect(svc.patchPair(10, 'teacher', 't1', { teacher_id: 1131 }, ADMIN, 3))
            .rejects.toMatchObject({ status: 400 });
    });

    test('已取消的那位不占名额，可以换成他', async () => {
        const cur = session({
            teachers: [teacherPair(), teacherPair({ uid: 't2', teacher_id: 1131, status: 'normal.cancelled' })]
        });
        db.query
            .mockResolvedValueOnce(okRows([cur]))
            .mockResolvedValueOnce(okRows([{ id: 1131 }]))
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        const r = await svc.patchPair(10, 'teacher', 't1', { teacher_id: 1131 }, ADMIN, 3);
        expect(JSON.parse(db.query.mock.calls[2][1][0])[0].teacher_id).toBe(1131);
        expect(r.rejectedFields).toEqual([]);
    });

    test('改类别：status 前缀换成 temp，生命周期后缀原样保留', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        await svc.patchPair(10, 'teacher', 't1', { category: 'temp' }, ADMIN, 3);
        expect(JSON.parse(db.query.mock.calls[1][1][0])[0].status).toBe('temp.confirmed');
    });

    test('类别改成 adjusted → 400（溯源属性只有作废+增补能写）', async () => {
        db.query.mockResolvedValueOnce(okRows([session()]));
        await expect(svc.patchPair(10, 'teacher', 't1', { category: 'adjusted' }, ADMIN, 3))
            .rejects.toMatchObject({ status: 400 });
    });

    test('patchPair 换学生：student_id 落进 students 列', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([{ id: 2002 }]))      // student 引用校验
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        await svc.patchPair(10, 'student', 's1', { student_id: 2002 }, ADMIN, 3);
        expect(JSON.parse(db.query.mock.calls[2][1][0])[0].student_id).toBe(2002);
    });

    test('换成同一场里已有的学生 → 400', async () => {
        const cur = session({
            students: [studentPair(), studentPair({ uid: 's2', student_id: 2002 })]
        });
        db.query.mockResolvedValueOnce(okRows([cur]));
        await expect(svc.patchPair(10, 'student', 's1', { student_id: 2002 }, ADMIN, 3))
            .rejects.toMatchObject({ status: 400 });
    });
});

describe('整列写必须带 version', () => {
    test('patchPair 版本不匹配 → 409 VersionConflictError', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([{ id: 5 }]))          // type_id 引用校验
            .mockResolvedValueOnce({ rows: [], rowCount: 0 });   // 版本不匹配
        await expect(svc.patchPair(10, 'teacher', 't1', { type_id: 5 }, ADMIN, 3))
            .rejects.toMatchObject({ name: 'VersionConflictError', status: 409 });
    });

    test('patchPair 成功时 SET 里带 version = version + 1，WHERE 里带 version = $n', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([{ id: 5 }]))
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        const r = await svc.patchPair(10, 'teacher', 't1', { type_id: 5, teacher_rating: 4 }, ADMIN, 3);
        const sql = db.query.mock.calls[2][0];
        expect(sql).toMatch(/version = version \+ 1/);
        expect(sql).toMatch(/AND version = \$4/);
        expect(JSON.parse(db.query.mock.calls[2][1][0])[0].type_id).toBe(5);
        expect(r.rejectedFields).toEqual([]);
    });

    test('负数费用被拒（数据库 CHECK 之外再拦一层）', async () => {
        await expect(svc.patchPair(10, 'teacher', 't1', { transport_fee: -1 }, ADMIN, 3))
            .rejects.toThrow(/不能为负数/);
    });

    test('教师提交只含被拒键的 patch → 400 并带 rejectedFields', async () => {
        await expect(svc.patchPair(10, 'teacher', 't1', { type_id: 9 }, TEACHER, 3))
            .rejects.toMatchObject({ status: 400, rejectedFields: ['type_id'] });
    });
});

describe('增删 pair', () => {
    test('addPair 只写一列，新 uid 取未占用的最小序号，created_by 来自 actor', async () => {
        const cur = session({ teachers: [teacherPair(), teacherPair({ uid: 't3', teacher_id: 1131 })] });
        db.query
            .mockResolvedValueOnce(okRows([cur]))
            .mockResolvedValueOnce(okRows([{ id: 1150 }]))     // teacher 引用
            .mockResolvedValueOnce(okRows([{ id: 3 }]))        // type 引用
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        const r = await svc.addPair(10, 'teacher', { teacher_id: 1150, type_id: 3 }, ADMIN, 3);
        expect(r.uid).toBe('t2');
        const sql = db.query.mock.calls[3][0];
        expect(sql).toMatch(/SET teachers = \$1::jsonb/);
        expect(sql).not.toMatch(/students =/);                 // 只写一列
        const written = JSON.parse(db.query.mock.calls[3][1][0]);
        expect(written).toHaveLength(3);
        expect(written[2]).toMatchObject({ uid: 't2', created_by: 7, status: 'normal.pending' });
    });

    test('重复学生 / 重复活跃教师被服务层拦下（给可读的 400，不是 CHECK 报错）', async () => {
        db.query.mockResolvedValueOnce(okRows([session()]));
        await expect(svc.addPair(10, 'student', { student_id: 2001 }, ADMIN, 3))
            .rejects.toThrow('这位学生已经在这一场课里了');

        db.query.mockResolvedValueOnce(okRows([session()]));
        await expect(svc.addPair(10, 'teacher', { teacher_id: 1120, type_id: 2 }, ADMIN, 3))
            .rejects.toThrow('这位老师已经在这一场课里了');
    });

    test('同一位老师若原 pair 已 modified_away，可以再加一次（作废+增补的形状）', async () => {
        const cur = session({ teachers: [teacherPair({ status: 'normal.modified_away' })] });
        db.query
            .mockResolvedValueOnce(okRows([cur]))
            .mockResolvedValueOnce(okRows([{ id: 1120 }]))
            .mockResolvedValueOnce(okRows([{ id: 2 }]))
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        const r = await svc.addPair(10, 'teacher', { teacher_id: 1120, type_id: 2 }, ADMIN, 3);
        expect(r.uid).toBe('t2');
    });

    test('removePair 删到最后一个时拒绝，提示改走整场删除', async () => {
        db.query.mockResolvedValueOnce(okRows([session()]));
        await expect(svc.removePair(10, 'teacher', 't1', ADMIN, 3))
            .rejects.toThrow(/最后一位教师/);
    });

    test('removePair 正常移除其中一位', async () => {
        const cur = session({ teachers: [teacherPair(), teacherPair({ uid: 't2', teacher_id: 1131 })] });
        db.query
            .mockResolvedValueOnce(okRows([cur]))
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        await svc.removePair(10, 'teacher', 't2', ADMIN, 3);
        expect(JSON.parse(db.query.mock.calls[1][1][0]).map(p => p.uid)).toEqual(['t1']);
    });
});

describe('作废+增补', () => {
    test('原 uid → *.modified_away（类别位保留），同一条 UPDATE 追加 adjusted.pending 新 pair', async () => {
        const cur = session({ teachers: [teacherPair({ status: 'temp.completed' })] });
        db.query
            .mockResolvedValueOnce(okRows([cur]))
            .mockResolvedValueOnce(okRows([{ id: 7 }]))                  // type 引用
            .mockResolvedValueOnce(okRows([session({ version: 4 })]))
            .mockResolvedValueOnce(okRows([]))                           // 两条状态审计合成一条多行 INSERT
            .mockResolvedValueOnce(okRows([]));                          // 结构变更审计
        const r = await svc.adjustTeacherPair(10, 't1', { type_id: 7 }, ADMIN, 3);
        const written = JSON.parse(db.query.mock.calls[2][1][0]);
        expect(written[0].status).toBe('temp.modified_away');            // 类别位保留
        expect(written[1]).toMatchObject({ uid: 't2', teacher_id: 1120, type_id: 7, status: 'adjusted.pending' });
        expect(r.addedUid).toBe('t2');
        // 只写 teachers 一列
        expect(db.query.mock.calls[2][0]).not.toMatch(/students =/);
    });
});

/**
 * renameUserInAllSessions：改主键时同步 pair 内的 teacher_id / student_id / created_by。
 * 回归重点：admin 分支曾用 `::text LIKE '%"created_by":7,%'` 定位场次，而 PG 的 jsonb
 * 文本输出冒号后带空格、且 created_by 可能是最后一个键（后跟 }）—— 该模式一次都匹配
 * 不到，改管理员 ID 时 pair 级 created_by 从未被同步。现改用 jsonb_path_exists。
 */
describe('renameUserInAllSessions：改号同步 pair 引用', () => {
    /** 取最后一条 change_logs 插入的 params */
    const lastChangeLogParams = () => {
        const call = [...db.query.mock.calls].reverse()
            .find(c => /INSERT INTO session_change_logs/.test(String(c[0])));
        expect(call).toBeDefined();
        return call[1];
    };

    test('admin：用 jsonb_path_exists 定位（禁止 ::text LIKE），同写 teachers 与 students 两侧 created_by', async () => {
        db.query
            .mockResolvedValueOnce(okRows([
                session({
                    id: 21,
                    teachers: [teacherPair({ created_by: 7 }), teacherPair({ uid: 't2', teacher_id: 1131, created_by: 8 })],
                    students: [studentPair({ created_by: '7' })],   // 历史数据可能存成字符串
                }),
            ]))
            .mockResolvedValueOnce(okRows([]))   // UPDATE
            .mockResolvedValueOnce(okRows([]));  // change_logs

        const r = await svc.renameUserInAllSessions(7, 9, 'admin');

        const [sql, params] = db.query.mock.calls[0];
        // 谓词必须是不依赖文本格式的 jsonb_path_exists —— 任何 LIKE '"created_by"' 都会漏
        expect(sql).toContain('jsonb_path_exists(teachers, $1, $2::jsonb)');
        expect(sql).toContain('jsonb_path_exists(students, $1, $2::jsonb)');
        expect(sql).not.toMatch(/LIKE '%?"?created_by"?/);
        expect(sql).not.toContain('::text LIKE');
        // vars 同时带 number 与 string 两种形态
        const vars = JSON.parse(params[1]);
        expect(vars).toEqual({ n: 7, s: '7' });

        // 只重写命中的 pair；number 与 string 两种存储都要命中
        const updSql = db.query.mock.calls[1][0];
        const [sid, tJson, sJson] = db.query.mock.calls[1][1];
        expect(updSql).toMatch(/UPDATE course_sessions cs[\s\S]*FROM \(VALUES/);
        expect(sid).toBe(21);
        const nextTeachers = JSON.parse(tJson);
        const nextStudents = JSON.parse(sJson);
        expect(nextTeachers.map(p => p.created_by)).toEqual([9, 8]);
        expect(nextTeachers[1].teacher_id).toBe(1131);          // 未命中 pair 原样保留
        expect(nextStudents.map(p => Number(p.created_by))).toEqual([9]);

        const logParams = lastChangeLogParams();
        expect(logParams[0]).toBe(21);
        expect(logParams[1]).toBe('user_id_migrated');
        expect(logParams[2]).toBe('admin');
        expect(JSON.parse(logParams[4])).toEqual({ created_by: { from: 7, to: 9 } });
        expect(r).toEqual({ affectedSessions: 1 });
    });

    test('teacher：仍走派生列 GIN 谓词，只重写 teacher_id', async () => {
        db.query
            .mockResolvedValueOnce(okRows([
                session({ teachers: [teacherPair({ teacher_id: 1120 }), teacherPair({ uid: 't2', teacher_id: 1131 })] }),
            ]))
            .mockResolvedValueOnce(okRows([]))   // UPDATE
            .mockResolvedValueOnce(okRows([]));  // change_logs

        const r = await svc.renameUserInAllSessions(1120, 2009, 'teacher');

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('teacher_ids @> ARRAY[$1::int]');
        const [, tJson, sJson] = db.query.mock.calls[1][1];
        const nextTeachers = JSON.parse(tJson);
        expect(nextTeachers.map(p => p.teacher_id)).toEqual([2009, 1131]);
        // 教师改号不动 created_by
        expect(nextTeachers[0].created_by).toBe(7);
        expect(JSON.parse(sJson)[0].student_id).toBe(2001);
        const logParams = lastChangeLogParams();
        expect(logParams[2]).toBe('teacher');
        expect(JSON.parse(logParams[4])).toEqual({ teacher_id: { from: 1120, to: 2009 } });
        expect(r).toEqual({ affectedSessions: 1 });
    });

    test('student：走 student_ids 派生列，只重写 student_id', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([]))
            .mockResolvedValueOnce(okRows([]));

        await svc.renameUserInAllSessions(2001, 3003, 'student');

        const [sql] = db.query.mock.calls[0];
        expect(sql).toContain('student_ids @> ARRAY[$1::int]');
        const [, tJson, sJson] = db.query.mock.calls[1][1];
        expect(JSON.parse(sJson)[0].student_id).toBe(3003);
        expect(JSON.parse(sJson)[0].created_by).toBe(7);   // 学生改号不动 created_by
        expect(JSON.parse(tJson)[0].teacher_id).toBe(1120);
        const logParams = lastChangeLogParams();
        expect(JSON.parse(logParams[4])).toEqual({ student_id: { from: 2001, to: 3003 } });
    });

    test('候选场次里没有真正命中的 pair → 不产生 UPDATE 与留痕', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session({
                teachers: [teacherPair({ created_by: 8 })],
                students: [studentPair({ created_by: 8 })],
            })]));
        // 只有一条候选查询（admin 分支）；候选后无改动 → 无 UPDATE 也无留痕

        const r = await svc.renameUserInAllSessions(7, 9, 'admin');
        expect(r).toEqual({ affectedSessions: 0 });
        expect(db.query.mock.calls.filter(c => /UPDATE course_sessions/.test(String(c[0])))).toHaveLength(0);
        expect(db.query.mock.calls.filter(c => /INSERT INTO session_change_logs/.test(String(c[0])))).toHaveLength(0);
    });
});


describe('删用户时的 pair 清理（语义相对旧表有意改变）', () => {
    test('同场还有别的老师 → 只移除该 pair；独教一场 → 整场删除', async () => {
        db.query
            .mockResolvedValueOnce(okRows([
                { id: 10, pairs: [teacherPair(), teacherPair({ uid: 't2', teacher_id: 1131 })] },
                { id: 11, pairs: [teacherPair()] }
            ]))
            .mockResolvedValueOnce(okRows([]))    // UPDATE 场次 10
            .mockResolvedValueOnce(okRows([]));   // DELETE 场次 11
        const r = await svc.removeUserFromAllSessions(1120, 'teacher');
        expect(r).toEqual({ affectedSessions: 1, deletedSessions: 1 });
        // 改动场次走一条 UPDATE ... FROM (VALUES ...)：参数是 (id, pairs) 成对
        const [updSql, updParams] = db.query.mock.calls[1];
        expect(updSql).toMatch(/UPDATE course_sessions cs[\s\S]*FROM \(VALUES/);
        expect(updParams[0]).toBe(10);
        expect(JSON.parse(updParams[1]).map(p => p.uid)).toEqual(['t2']);
        expect(db.query.mock.calls[2][0]).toMatch(/DELETE FROM course_sessions WHERE id = ANY/);
    });

    test('countUserImpact 走派生列索引谓词，供确认弹窗提示 N/M', async () => {
        db.query.mockResolvedValueOnce(okRows([{ total: 3, whole: 1 }]));
        const r = await svc.countUserImpact(1120, 'teacher');
        expect(r).toEqual({ affectedSessions: 3, deletedSessions: 1 });
        expect(db.query.mock.calls[0][0]).toMatch(/teacher_ids @> ARRAY/);
    });
});

/**
 * 审计覆盖：状态流转在 session_status_logs，费用在 session_fee_*，
 * 其余「结构与内容」的变更都要落到 session_change_logs —— 这一组就是逐个动作验收它。
 */
describe('session_change_logs 审计覆盖', () => {
    /** 取最后一条 change_logs 插入的 [sql, params] */
    const lastChangeLog = () => {
        const call = [...db.query.mock.calls].reverse()
            .find(c => /INSERT INTO session_change_logs/.test(String(c[0])));
        expect(call).toBeDefined();
        const [, p] = call;
        return { sql: String(call[0]), params: p, entry: {
            sessionId: p[0], action: p[1], pairKind: p[2], pairUid: p[3],
            changes: JSON.parse(p[4]), operatorId: p[5], actorType: p[6], note: p[7]
        } };
    };

    test('createSession 记 create：头部快照 + 两侧 pair 摘要', async () => {
        db.query
            .mockResolvedValueOnce(okRows([{ id: 1120 }]))
            .mockResolvedValueOnce(okRows([{ id: 2001 }]))
            .mockResolvedValueOnce(okRows([{ id: 2 }]))
            .mockResolvedValueOnce(okRows([session()]));
        await svc.createSession({
            class_date: '2026-09-01', start_time: '19:00', end_time: '22:00',
            teachers: [{ teacher_id: 1120, type_id: 2 }], students: [{ student_id: 2001 }]
        }, ADMIN);

        const { entry } = lastChangeLog();
        expect(entry.action).toBe('create');
        expect(entry.sessionId).toBe(10);
        expect(entry.operatorId).toBe(7);
        expect(entry.actorType).toBe('admin');
        expect(entry.changes.header.class_date).toBe('2026-09-01');
        expect(entry.changes.teachers).toEqual([expect.objectContaining({ uid: 't1', teacher_id: 1120, type_id: 2 })]);
        expect(entry.changes.students).toEqual([expect.objectContaining({ uid: 's1', student_id: 2001 })]);
    });

    test('updateSessionHeader 记 header：每个提交字段都带 from / to', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))                    // 写前读（取原值）
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));     // UPDATE
        await svc.updateSessionHeader(10, { location: '李四家', notes: '改到李四家' }, ADMIN, 3);

        const { entry } = lastChangeLog();
        expect(entry.action).toBe('header');
        expect(entry.changes).toEqual({
            location: { from: '张三家', to: '李四家' },
            notes: { from: null, to: '改到李四家' }
        });
    });

    test('patchPair 记 pair_patch，带 kind 与 uid', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([{ id: 5 }]))                    // type 引用校验
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        await svc.patchPair(10, 'teacher', 't1', { type_id: 5 }, ADMIN, 3);

        const { entry } = lastChangeLog();
        expect(entry.action).toBe('pair_patch');
        expect(entry.pairKind).toBe('teacher');
        expect(entry.pairUid).toBe('t1');
        expect(entry.changes).toEqual({ type_id: { from: 2, to: 5 } });
    });

    test('addPair 记 pair_add；removePair 记 pair_remove 并保留被移除 pair 的摘要', async () => {
        db.query
            .mockResolvedValueOnce(okRows([session()]))
            .mockResolvedValueOnce(okRows([{ id: 1150 }]))
            .mockResolvedValueOnce(okRows([{ id: 3 }]))
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        await svc.addPair(10, 'teacher', { teacher_id: 1150, type_id: 3 }, ADMIN, 3);
        expect(lastChangeLog().entry).toMatchObject({
            action: 'pair_add', pairKind: 'teacher', pairUid: 't2',
            changes: { added: expect.objectContaining({ teacher_id: 1150, type_id: 3 }) }
        });

        jest.clearAllMocks();
        db.query.mockResolvedValue(okRows([]));
        const cur = session({ teachers: [teacherPair(), teacherPair({ uid: 't2', teacher_id: 1131 })] });
        db.query
            .mockResolvedValueOnce(okRows([cur]))
            .mockResolvedValueOnce(okRows([session({ version: 4 })]));
        await svc.removePair(10, 'teacher', 't2', ADMIN, 3);
        expect(lastChangeLog().entry).toMatchObject({
            action: 'pair_remove', pairUid: 't2',
            changes: { removed: expect.objectContaining({ uid: 't2', teacher_id: 1131 }) }
        });
    });

    test('deleteSession 用 RETURNING 拿整场快照；不存在时不写审计', async () => {
        db.query.mockResolvedValueOnce(okRows([session()]));
        const r = await svc.deleteSession(10, ADMIN);
        expect(r).toEqual({ deleted: true });
        expect(db.query.mock.calls[0][0]).toMatch(/DELETE FROM course_sessions WHERE id = \$1 RETURNING/);
        const { entry } = lastChangeLog();
        expect(entry.action).toBe('delete');
        expect(entry.changes.header.location).toBe('张三家');
        expect(entry.changes.teachers).toHaveLength(1);

        jest.clearAllMocks();
        db.query.mockResolvedValue(okRows([]));
        expect(await svc.deleteSession(99, ADMIN)).toEqual({ deleted: false });
        expect(db.query.mock.calls.some(c => /session_change_logs/.test(String(c[0])))).toBe(false);
    });

    test('deleteSessions 批量：一条 DELETE + 一条多行审计插入', async () => {
        db.query.mockResolvedValueOnce(okRows([session(), session({ id: 11 })]));
        const r = await svc.deleteSessions([10, 11, 10], ADMIN);
        expect(r).toEqual({ deleted: 2 });
        expect(db.query.mock.calls[0][1]).toEqual([[10, 11]]);   // 去重
        const { sql, params } = lastChangeLog();
        expect(sql.match(/\(\$/g)).toHaveLength(2);              // 两行 VALUES 元组
        expect(params).toHaveLength(16);                         // 2 行 × 8 列
    });

    test('removeUserFromAllSessions 记 user_cleanup：整场删除的那条标 whole_session_deleted', async () => {
        db.query
            .mockResolvedValueOnce(okRows([
                { id: 10, pairs: [teacherPair(), teacherPair({ uid: 't2', teacher_id: 1131 })] },
                { id: 11, pairs: [teacherPair()] }
            ]))
            .mockResolvedValueOnce(okRows([]))    // UPDATE 场次 10
            .mockResolvedValueOnce(okRows([]));   // DELETE 场次 11
        await svc.removeUserFromAllSessions(1120, 'teacher', ADMIN);

        const { params } = lastChangeLog();
        expect(params).toHaveLength(16);                          // 两场各一行，一次插入
        expect(params[1]).toBe('user_cleanup');
        expect(JSON.parse(params[4]).whole_session_deleted).toBe(false);   // 场次 10 只移除 pair
        expect(JSON.parse(params[12]).whole_session_deleted).toBe(true);   // 场次 11 整场删除
    });
});

