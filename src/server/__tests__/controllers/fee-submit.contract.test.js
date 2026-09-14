// 「保存并提交」费用后的自动状态流转契约测试（mock-db，无真实 DB 依赖）
// 覆盖：教师端（/teacher/dashboard/fees 单条 + /sd-fees 批量）→ 待审核；管理员端 → 已审核。
const db = require('../../db/db');
const teacherController = require('../../controllers/teacher-controller');
const adminController = require('../../controllers/admin-controller');
const FeeService = require('../../services/fee-service');
const { mockRes, mockReq } = require('../helpers/httpMocks');

// 场次读取自 SESSION_COLUMNS 的列清单，跨控制器共享 —— 集中统一定义，
// 避免这里与 course-session-service 各维护一份列名。
const SESSION_COLUMNS = `id, class_date, start_time, end_time, location, notes,
    teachers, students, teacher_ids, student_ids, version,
    created_by, created_at, updated_by, updated_at`;

function mockSessionRow(over = {}) {
    // mysql 的 SHOW COLUMNS / 直接 result-set 以数组顺序返回；这里模拟 pg 的
    // 字段-值 object，键名取 SESSION_COLUMNS 展开后的列名。
    const base = {
        id: over.id ?? 1,
        class_date: over.class_date ?? '2026-09-05',
        start_time: '09:00:00',
        end_time: '10:00:00',
        location: null,
        notes: null,
        teachers: over.teachers ?? null,
        students: over.students ?? null,
        teacher_ids: [],
        student_ids: [],
        version: 1,
        created_by: over.created_by ?? null,
        created_at: null,
        updated_by: null,
        updated_at: null
    };
    return base;
}

jest.mock('../../services/schedule-service', () => ({}));

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    getClient: jest.fn(),
    warmup: jest.fn()
}));

jest.mock('../../utils/schema-helper', () => ({
    hasTable: jest.fn().mockResolvedValue(true),
    hasColumn: jest.fn().mockResolvedValue(true),
    getDateExpr: jest.fn().mockResolvedValue('ca.class_date')
}));

jest.mock('../../middleware/audit', () => ({
    recordAudit: jest.fn().mockResolvedValue(undefined)
}));

// 事务内的查询调用（工作函数使用 client.query）
let txCalls;
// 当前测试预置的场次行与教师行（由 mockTeacherQueries / mockAdminSchedule 设置）。
// setupTx 的 db.query 统一 handler 同时处理这两个源 —— 谁后 mockImplementation 谁覆盖，
// 所以 mock 函数只写状态、不重设 handler。
let currentSessions = [];
let currentTeacherRow = null;

function setupTx() {
    txCalls = [];
    // 单条费用更新已不再开启事务（金额 + 状态一条 UPDATE 完成，审计为旁路），
    // 所以这里把 db.query 也收进 txCalls：断言用的「哪些记录被提交」不受实现细节影响。
    db.query.mockImplementation(async (text, params) => {
        txCalls.push([text, params]);
        // 场次查询：命中「预置场次」则返回（单条路径靠 SESSION_COLUMNS 的 SELECT 喂 getSessionById）
        if (/SELECT [\s\S]*FROM course_sessions/i.test(text) && currentSessions.length) {
            return { rows: currentSessions };
        }
        if (/FROM teachers/i.test(text) && currentTeacherRow) {
            return { rows: [currentTeacherRow] };
        }
        return { rows: [] };
    });
    db.runInTransaction.mockImplementation(async (workFn) => {
        const client = {
            query: jest.fn(async (text, params) => {
                txCalls.push([text, params]);
                return { rows: [] };
            })
        };
        return workFn(client, false);
    });
}

// 事务内被设置的目标状态：一条 UPDATE 内金额 + 状态一次成型，params 形如
// [sessionId, teacherUid, tFee, oFee, '"targetStatus"']（金额恒在、状态视 targetStatus
// 是否存在）。状态键总是参数组的最后一个。
function statusWrites() {
    return txCalls
        .filter(([text]) => /'\{fee_status\}'/.test(text))
        .map(([, params]) => [JSON.parse(params[params.length - 1]), params[0]]);
}

// 断言某次调用把 pair 的金额键置成给定值：buildPairPatchSql 的格式是
// "UPDATE course_sessions cs SET teachers = ( SELECT jsonb_agg(CASE WHEN e->>'uid' = $2
//   THEN jsonb_set(jsonb_set(e,'{transport_fee}',$3::jsonb),'{other_fee}',$4::jsonb)
//   ELSE e END …)"，所以 transport_fee 是 $3、other_fee 是 $4（$1 场次、$2 uid）。
function amountWriteForSession(sid) {
    return txCalls.find(([text, params]) =>
        /'\{fee_status\}'/.test(text) && Number(params[0]) === Number(sid)) || null;
}

// 把旧的「平铺课时行」造成新的场次形状：一位教师 pair + 一位学生 pair
function sessionOf(row, over = {}) {
    if (!row) return null;
    return mockSessionRow({
        id: over.id ?? 1,
        created_by: over.created_by ?? null,
        teachers: [{
            uid: 't1',
            teacher_id: row.teacher_id ?? 5,
            type_id: 2,
            status: 'normal.completed',
            transport_fee: row.transport_fee ?? null,
            other_fee: row.other_fee ?? null,
            fee_status: row.fee_status ?? 'draft',
            created_by: 1
        }],
        students: [{ uid: 's1', student_id: row.student_id ?? 20, family_participants: 4 }]
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    currentSessions = [];
    currentTeacherRow = null;
    setupTx();
});

describe('教师端单条「保存并提交」（PATCH /teacher/schedules/:id/fees）', () => {
    // schedule: 课时行；teacherRow: teachers.student_ids（决定普通教师 / 班主任身份）
    function mockTeacherQueries(schedule, teacherRow) {
        currentSessions = schedule ? [sessionOf(schedule)] : [];
        currentTeacherRow = teacherRow || null;
    }

    test('普通教师本人课时 待提交 → 待审核', async () => {
        mockTeacherQueries(
            { transport_fee: null, other_fee: null, student_id: 20, teacher_id: 5, fee_status: 'draft' },
            { student_ids: null }
        );
        const req = mockReq({
            params: { id: '7' },
            body: { transport_fee: 12.5 },
            user: { id: 5, role: 'teacher' },
            requestId: 'req-teacher-fee'
        });
        const res = mockRes();

        await teacherController.updateScheduleFees(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            data: {
                transport_fee: 12.5,
                other_fee: null,
                fee_status: 'teacher_submitted'
            },
            error: null,
            meta: { requestId: 'req-teacher-fee' }
        });
        expect(res.body).not.toHaveProperty('message');
        expect(statusWrites()).toEqual([['teacher_submitted', '7']]);
    });

    test('班主任关联学生课时 已退回 → 待审核', async () => {
        mockTeacherQueries(
            { transport_fee: 5, other_fee: null, student_id: 20, teacher_id: 9, fee_status: 'returned' },
            { student_ids: '20,21' }
        );
        const req = mockReq({ params: { id: '8' }, body: { transport_fee: 6 }, user: { id: 5, role: 'teacher' } });
        const res = mockRes();

        await teacherController.updateScheduleFees(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.data.fee_status).toBe('teacher_submitted');
    });

    test('已报销课时：金额可改，状态不回退', async () => {
        mockTeacherQueries(
            { transport_fee: 5, other_fee: null, student_id: 20, teacher_id: 5, fee_status: 'reimbursed' },
            { student_ids: null }
        );
        const req = mockReq({ params: { id: '9' }, body: { transport_fee: 7 }, user: { id: 5, role: 'teacher' } });
        const res = mockRes();

        await teacherController.updateScheduleFees(req, res);

        expect(res.body.data.fee_status).toBe('reimbursed');
        expect(statusWrites()).toEqual([]);
    });

    test('越权（非本人课时且非关联学生）→ 403 且不写库', async () => {
        mockTeacherQueries(
            { transport_fee: null, other_fee: null, student_id: 99, teacher_id: 9, fee_status: 'draft' },
            { student_ids: null }
        );
        const req = mockReq({ params: { id: '10' }, body: { transport_fee: 1 }, user: { id: 5, role: 'teacher' } });
        const res = mockRes();

        await expect(teacherController.updateScheduleFees(req, res)).rejects.toMatchObject({
            code: 'FORBIDDEN',
            statusCode: 403
        });
        expect(res.json).not.toHaveBeenCalled();
        expect(db.runInTransaction).not.toHaveBeenCalled();
    });

    test('清除 / 留空费用（置 null）→ 只改金额，状态保持待提交', async () => {
        mockTeacherQueries(
            { transport_fee: 12, other_fee: null, student_id: 20, teacher_id: 5, fee_status: 'draft' },
            { student_ids: null }
        );
        const req = mockReq({
            params: { id: '14' },
            body: { transport_fee: null, other_fee: null },
            user: { id: 5, role: 'teacher' }
        });
        const res = mockRes();

        await teacherController.updateScheduleFees(req, res);

        expect(res.body.data.fee_status).toBe('draft');
        expect(statusWrites()).toEqual([]);
        // 金额仍然写入（置 NULL）
        expect(txCalls.some(([text, params]) =>
            /'\{transport_fee\}'/.test(text) && params[2] === 'null' && params[3] === 'null')).toBe(true);
    });

    test('填 0 视为已填写 → 待审核', async () => {
        mockTeacherQueries(
            { transport_fee: null, other_fee: null, student_id: 20, teacher_id: 5, fee_status: 'draft' },
            { student_ids: null }
        );
        const req = mockReq({ params: { id: '15' }, body: { transport_fee: 0 }, user: { id: 5, role: 'teacher' } });
        const res = mockRes();

        await teacherController.updateScheduleFees(req, res);

        expect(res.body.data.fee_status).toBe('teacher_submitted');
    });
});

describe('教师端批量「保存并提交」（POST /teacher/batch-fees，班主任 sd-fees 页）', () => {
    test('仅本次填写的记录提交为待审核，同弹窗内留空的课时状态不动', async () => {
        // 三个 pair 分布在三场课里（费用挂在教师 pair 上，一趟一笔）
        const sessions = [
            mockSessionRow({ id: 1, students: [{ uid: 's1', student_id: 20 }],
              teachers: [{ uid: 't1', teacher_id: 9, type_id: 2, status: 'normal.completed',
                           transport_fee: 10, other_fee: 0, fee_status: 'draft' }] }),
            mockSessionRow({ id: 2, students: [{ uid: 's1', student_id: 21 }],
              teachers: [{ uid: 't1', teacher_id: 9, type_id: 2, status: 'normal.completed',
                           transport_fee: null, other_fee: null, fee_status: 'draft' }] }),
            mockSessionRow({ id: 3, students: [{ uid: 's1', student_id: 21 }],
              teachers: [{ uid: 't1', teacher_id: 9, type_id: 2, status: 'normal.completed',
                           transport_fee: null, other_fee: null, fee_status: 'draft' }] })
        ];
        db.query.mockImplementation(async (sql) => {
            if (/FROM teachers/i.test(sql)) return { rows: [{ student_ids: '20,21' }] };
            return { rows: [] };
        });
        db.runInTransaction.mockImplementation(async (workFn) => {
            const client = {
                query: jest.fn(async (text, params) => {
                    txCalls.push([text, params]);
                    // 批量读场次：SESSION_COLUMNS 无 WHERE id = $1 级联，直接按整列清单匹配
                    if (/SELECT [\s\S]*course_sessions/i.test(text) && /^\s*SELECT/i.test(text)) {
                        return { rows: sessions };
                    }
                    return { rows: [] };
                })
            };
            return workFn(client, false);
        });

        const req = mockReq({
            body: {
                updates: [
                    { session_id: 1, teacher_uid: 't1', transport_fee: 10, other_fee: 0 },   // 已填写、金额未变
                    { session_id: 2, teacher_uid: 't1', transport_fee: 30 },                 // 本次填写
                    { session_id: 3, teacher_uid: 't1', transport_fee: null, other_fee: null } // 弹窗内留空
                ]
            },
            user: { id: 5, role: 'teacher' }
        });
        const res = mockRes();

        await teacherController.batchUpdateScheduleFees(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            data: { changed: 1, submitted: 2 },
            error: null
        });
        expect(res.body).not.toHaveProperty('message');
        // 批量路径把状态改动折进那一条 UPDATE ... FROM (VALUES ...)（固定往返数是硬约束），
        // 所以「哪些 pair 被提交」看审计写入：场次 1、2 本次填了费用 → 提交；场次 3 留空 → 不动。
        // 审计本身也是一条多值 INSERT（每行 7 个参数），所以按 7 切开逐行读。
        const submittedAudits = txCalls
            .filter(([text]) => /INSERT INTO session_fee_status_logs/i.test(text))
            .flatMap(([, params]) => {
                const rows = [];
                for (let i = 0; i * 7 < params.length; i++) {
                    rows.push([params[i * 7 + 3], params[i * 7], params[i * 7 + 1]]);
                }
                return rows;
            });
        expect(submittedAudits).toEqual([
            ['teacher_submitted', 1, 't1'],
            ['teacher_submitted', 2, 't1']
        ]);
        // 场次 3 完全没有出现在写回里
        const batchUpdate = txCalls.find(([text]) => /UPDATE course_sessions/i.test(text));
        expect(batchUpdate[1]).not.toContain(3);
    });
    test('已知业务错误映射为 canonical AppError，未知错误原样传播', async () => {
        currentTeacherRow = { student_ids: null };
        const cases = [
            [new Error('排课 ID 4 包含负数费用'), 'BAD_REQUEST', 400],
            [new Error('排课 ID 4 不属于您'), 'FORBIDDEN', 403],
            [new Error('排课 ID 4 不在您管理的班级范围内'), 'FORBIDDEN', 403],
            [new Error('未能定位到任何有效的排课记录，请确认 teacher_uid 已正确传递'), 'RESOURCE_NOT_FOUND', 404]
        ];

        for (const [error, code, statusCode] of cases) {
            db.runInTransaction.mockRejectedValueOnce(error);
            await expect(teacherController.batchUpdateScheduleFees(
                mockReq({
                    body: { updates: [{ session_id: 4, teacher_uid: 't1', transport_fee: 1 }] },
                    user: { id: 5, role: 'teacher' }
                }),
                mockRes()
            )).rejects.toMatchObject({ code, statusCode, message: error.message });
        }

        const dbError = new Error('connection reset');
        db.runInTransaction.mockRejectedValueOnce(dbError);
        await expect(teacherController.batchUpdateScheduleFees(
            mockReq({
                body: { updates: [{ session_id: 4, teacher_uid: 't1', transport_fee: 1 }] },
                user: { id: 5, role: 'teacher' }
            }),
            mockRes()
        )).rejects.toBe(dbError);
    });
});

describe.each([
    ['教师端', teacherController, { id: 5, role: 'teacher' }, 'teacher_submitted'],
    ['管理员端', adminController, { id: 1, role: 'admin', permissionLevel: 1 }, 'admin_submitted']
])('%s费用状态 contract', (_label, controller, user, target) => {
    test('单条成功返回 canonical data，缺状态抛 BAD_REQUEST', async () => {
        const session = sessionOf({ teacher_id: 5, fee_status: 'draft' });
        currentSessions = [session];
        currentTeacherRow = { student_ids: null };
        db.runInTransaction.mockImplementationOnce(async (workFn) => workFn({
            query: jest.fn(async (text, params) => {
                txCalls.push([text, params]);
                return { rows: [] };
            })
        }, false));
        const req = mockReq({
            params: { id: '21', uid: 't1' },
            body: { fee_status: target },
            user,
            requestId: `req-${target}`
        });
        const res = mockRes();

        await controller.updateScheduleFeeStatus(req, res);

        expect(res.body).toMatchObject({
            ok: true,
            data: { fee_status: target },
            error: null,
            meta: { requestId: `req-${target}` }
        });
        expect(res.body).not.toHaveProperty('message');
        await expect(controller.updateScheduleFeeStatus(
            mockReq({ params: { id: '21' }, body: {}, user }),
            mockRes()
        )).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
    });

    test('批量成功保留 updated，事务错误原样传播', async () => {
        currentTeacherRow = { student_ids: null };
        db.runInTransaction.mockResolvedValueOnce(2);
        const req = mockReq({
            body: { ids: [{ session_id: 1, teacher_uid: 't1' }], fee_status: target },
            user,
            requestId: 'req-batch-status'
        });
        const res = mockRes();

        await controller.batchUpdateScheduleFeeStatus(req, res);

        expect(res.body).toMatchObject({
            ok: true,
            data: { updated: 2 },
            error: null,
            meta: { requestId: 'req-batch-status' }
        });
        const dbError = new Error('batch db failed');
        db.runInTransaction.mockRejectedValueOnce(dbError);
        await expect(controller.batchUpdateScheduleFeeStatus(
            mockReq({
                body: { ids: [{ session_id: 1, teacher_uid: 't1' }], fee_status: target },
                user
            }),
            mockRes()
        )).rejects.toBe(dbError);
    });
});

describe('管理员费用权限 contract', () => {
    test('L3 单条越权按不存在处理，批量显式 IDs 越权整批 403', async () => {
        currentSessions = [mockSessionRow({
            id: 31,
            created_by: 99,
            teachers: [{
                uid: 't1', teacher_id: 5, type_id: 2, status: 'normal.completed',
                transport_fee: null, other_fee: null, fee_status: 'draft'
            }],
            students: [{ uid: 's1', student_id: 20 }]
        })];
        const user = { id: 7, role: 'admin', userType: 'admin', permissionLevel: 3, permission_level: 3 };

        await expect(adminController.updateScheduleFees(
            mockReq({ params: { id: '31' }, body: { transport_fee: 1 }, user }),
            mockRes()
        )).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });

        db.query.mockResolvedValueOnce({ rows: [{ id: 31 }] });
        await expect(adminController.batchUpdateScheduleFeeStatus(
            mockReq({ body: { ids: [31, 32], fee_status: 'admin_submitted' }, user }),
            mockRes()
        )).rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
        expect(db.runInTransaction).not.toHaveBeenCalled();
    });
});

describe('费用控制器未知错误传播', () => {
    test.each([
        ['teacher', teacherController, { id: 5, role: 'teacher' }],
        ['admin', adminController, { id: 1, role: 'admin', permissionLevel: 1 }]
    ])('%s 单条费用 DB 错误保留对象身份', async (_name, controller, user) => {
        currentSessions = [sessionOf({ teacher_id: 5, fee_status: 'draft' })];
        currentTeacherRow = { student_ids: null };
        const error = new Error('write failed');
        const spy = jest.spyOn(FeeService, 'updateScheduleFeesInTx').mockRejectedValueOnce(error);

        await expect(controller.updateScheduleFees(
            mockReq({ params: { id: '41', uid: 't1' }, body: { transport_fee: 0 }, user }),
            mockRes()
        )).rejects.toBe(error);
        spy.mockRestore();
    });
});

describe('管理员端单条「保存并提交」（PATCH /admin/schedules/:id/fees）', () => {
    function mockAdminSchedule(row) {
        currentSessions = row ? [sessionOf(row)] : [];
        currentTeacherRow = null;
    }

    test('管理员成功响应使用 canonical envelope 并保留 null/0', async () => {
        mockAdminSchedule({ transport_fee: null, other_fee: null, fee_status: 'draft' });
        const req = mockReq({
            params: { id: '11' },
            body: { transport_fee: 20, other_fee: 0 },
            requestId: 'req-admin-fee'
        });
        const res = mockRes();

        await adminController.updateScheduleFees(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            data: {
                transport_fee: 20,
                other_fee: 0,
                fee_status: 'admin_submitted'
            },
            error: null,
            meta: { requestId: 'req-admin-fee' }
        });
        expect(res.body).not.toHaveProperty('message');
        expect(statusWrites()).toEqual([['admin_submitted', '11']]);
    });

    test('教师已提交的待审核记录 → 已审核', async () => {
        mockAdminSchedule({ transport_fee: 8, other_fee: null, fee_status: 'teacher_submitted' });
        const req = mockReq({ params: { id: '12' }, body: { transport_fee: 9 } });
        const res = mockRes();

        await adminController.updateScheduleFees(req, res);

        expect(res.body.data.fee_status).toBe('admin_submitted');
    });

    test('已报销记录：金额可改，状态不回退', async () => {
        mockAdminSchedule({ transport_fee: 8, other_fee: null, fee_status: 'reimbursed' });
        const req = mockReq({ params: { id: '13' }, body: { transport_fee: 9 } });
        const res = mockRes();

        await adminController.updateScheduleFees(req, res);

        expect(res.body.data.fee_status).toBe('reimbursed');
        expect(statusWrites()).toEqual([]);
    });

    test('清除 / 留空费用（置 null）→ 只改金额，状态保持待提交', async () => {
        mockAdminSchedule({ transport_fee: 20, other_fee: 5, fee_status: 'draft' });
        const req = mockReq({ params: { id: '16' }, body: { transport_fee: null, other_fee: null } });
        const res = mockRes();

        await adminController.updateScheduleFees(req, res);

        expect(res.body.data.fee_status).toBe('draft');
        expect(statusWrites()).toEqual([]);
        // 金额本身仍写入（置 NULL）：buildPairPatchSql 的格式里金额在 $3/$4
        expect(txCalls.some(([text, params]) =>
            /'\{transport_fee\}'/.test(text) && params[2] === 'null' && params[3] === 'null')).toBe(true);
    });
});
