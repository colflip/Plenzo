// D1-5：fee-service 单测（金额归一 / 范围授权 / 费用更新 / 状态流转）
const SchemaHelper = require('../../utils/schema-helper');
const FeeService = require('../../services/fee-service');

jest.mock('../../utils/schema-helper', () => ({
    hasTable: jest.fn().mockResolvedValue(true),
    hasColumn: jest.fn().mockResolvedValue(true),
}));

// 按 id 路由的只读查询模拟
function txWithRows(byId, selectRe) {
    return jest.fn(async (text, params) => {
        if (selectRe.test(text)) return { rows: [byId[params[0]]] };
        return { rows: [] };
    });
}

// 批量查询（id = ANY($1)）模拟：一次性返回全部记录
function txWithAnyRows(rows) {
    return jest.fn(async (text) => {
        if (/select id, fee_status/i.test(text)) return { rows };
        return { rows: [] };
    });
}

describe('fee-service.parseFeeAmount', () => {
    test('空/未传/非法 → null（保留 null 与 0 差异）', () => {
        expect(FeeService.parseFeeAmount('')).toBeNull();
        expect(FeeService.parseFeeAmount(null)).toBeNull();
        expect(FeeService.parseFeeAmount(undefined)).toBeNull();
        expect(FeeService.parseFeeAmount('abc')).toBeNull();
    });
    test('数字与 0 保留', () => {
        expect(FeeService.parseFeeAmount('12.5')).toBe(12.5);
        expect(FeeService.parseFeeAmount(0)).toBe(0);
        expect(FeeService.parseFeeAmount('0')).toBe(0);
    });
});

describe('fee-service.hasFilledFee', () => {
    test('任一非 null 即视为填写（0 算填写）', () => {
        expect(FeeService.hasFilledFee(10, null)).toBe(true);
        expect(FeeService.hasFilledFee(null, 0)).toBe(true);
        expect(FeeService.hasFilledFee(0, 0)).toBe(true);
    });
    test('全部 null（留空 / 清除）→ 未填写', () => {
        expect(FeeService.hasFilledFee(null, null)).toBe(false);
    });
});

// ---- 以下针对「一场一行 + 教师 pair」的新契约：定位从裸 id 变成 (session_id, teacher_uid) ----

const tPair = (over = {}) => ({
    uid: 't1', teacher_id: 5, type_id: 2, status: 'normal.completed',
    transport_fee: null, other_fee: null, fee_status: 'draft', created_by: 1, ...over
});
const sPair = (over = {}) => ({ uid: 's1', student_id: 10, family_participants: 4, ...over });
const sess = (over = {}) => ({
    id: 1, version: 1, teachers: [tPair()], students: [sPair()], ...over
});

/** 批量读场次的 tx 模拟：只对 SELECT ... FROM course_sessions 返回行 */
function txWithSessions(rows) {
    return jest.fn(async (text) => {
        if (/FROM course_sessions/i.test(text) && /^\s*SELECT/i.test(text)) return { rows };
        return { rows: [] };
    });
}

describe('fee-service.checkScheduleScope（pair 级）', () => {
    const admin = { actorType: 'admin', studentIds: [] };
    const head = { actorType: 'headteacher', studentIds: [10, 11] };
    const teacher = { actorType: 'teacher', id: 5, studentIds: [] };

    test('admin 放行', () => {
        expect(FeeService.checkScheduleScope(admin, { session: sess(), teacher: tPair({ teacher_id: 99 }) }, 1)).toBeNull();
    });
    test('班主任：场次里任一学生在名下即通过', () => {
        expect(FeeService.checkScheduleScope(head, { session: sess(), teacher: tPair() }, 1)).toBeNull();
        expect(FeeService.checkScheduleScope(head,
            { session: sess({ students: [sPair({ student_id: 99 })] }), teacher: tPair() }, 2)).toMatch(/班级范围内/);
    });
    test('普通教师：只能碰自己那个 pair', () => {
        expect(FeeService.checkScheduleScope(teacher, { session: sess(), teacher: tPair({ teacher_id: 5 }) }, 1)).toBeNull();
        expect(FeeService.checkScheduleScope(teacher, { session: sess(), teacher: tPair({ teacher_id: 9 }) }, 2)).toMatch(/不属于您/);
    });
    test('无 actor → 放行', () => {
        expect(FeeService.checkScheduleScope(null, { session: sess(), teacher: tPair({ teacher_id: 9 }) }, 1)).toBeNull();
    });
});

describe('fee-service.locateTeacherPair', () => {
    test('给了 uid 就按 uid 找', () => {
        const s = { teachers: [tPair(), tPair({ uid: 't2', teacher_id: 6 })] };
        expect(FeeService.locateTeacherPair(s, 't2').teacher_id).toBe(6);
        expect(FeeService.locateTeacherPair(s, 't9')).toBeNull();
    });
    test('没给 uid：只有一位教师时用那一位，多位时拒绝猜', () => {
        expect(FeeService.locateTeacherPair({ teachers: [tPair()] }, null).uid).toBe('t1');
        expect(FeeService.locateTeacherPair({ teachers: [tPair(), tPair({ uid: 't2' })] }, null)).toBeNull();
    });
});

describe('fee-service.buildPairPatchSql', () => {
    test('只改指定键、按 uid 匹配、带 EXISTS 守卫与 ORDER BY ord', () => {
        const sql = FeeService.buildPairPatchSql(['transport_fee', 'other_fee']);
        expect(sql).toMatch(/jsonb_set\(jsonb_set\(e, '\{transport_fee\}', \$3::jsonb\), '\{other_fee\}', \$4::jsonb\)/);
        expect(sql).toMatch(/WITH ORDINALITY/);
        expect(sql).toMatch(/ORDER BY ord/);
        expect(sql).toMatch(/EXISTS \(SELECT 1 FROM jsonb_array_elements/);
        expect(sql).toMatch(/e->>'uid' = \$2/);
    });
});

describe('fee-service.updateScheduleFeesInTx', () => {
    test('原地重建 pair 的两个费用键 + 按 (session_id, teacher_uid) 落审计', async () => {
        const tx = jest.fn(async () => ({ rows: [] }));
        const r = await FeeService.updateScheduleFeesInTx(tx, { sessionId: 7, teacherUid: 't1' }, {
            tFee: 10, oFee: 0, oldTFee: null, oldOFee: null, operatorId: 1, operatorRole: 'teacher'
        });
        expect(r.updated).toBe(true);
        const updateCall = tx.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        expect(updateCall[1]).toEqual([7, 't1', '10', '0']);
        const auditCall = tx.mock.calls.find(c => /INSERT INTO session_fee_audit_logs/i.test(String(c[0])));
        expect(auditCall[1]).toEqual([7, 't1', 1, 'teacher', null, 10, null, 0]);
    });
});

describe('fee-service.transitionFeeStatus', () => {
    test('普通教师 draft→teacher_submitted 成功（只改 fee_status 一个键）', async () => {
        const tx = jest.fn(async () => ({ rows: [] }));
        const r = await FeeService.transitionFeeStatus(tx, {
            sessionId: 1, teacherUid: 't1', from: 'draft', target: 'teacher_submitted',
            note: 'x', operatorId: 5, actorType: 'teacher'
        });
        expect(r.ok).toBe(true);
        const updateCall = tx.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        expect(updateCall[0]).toMatch(/'\{fee_status\}'/);
        expect(updateCall[1]).toEqual([1, 't1', '"teacher_submitted"']);
    });
    test('非法流转（教师 reimbursed→draft）→ ok:false', async () => {
        const tx = jest.fn(async () => ({ rows: [] }));
        const r = await FeeService.transitionFeeStatus(tx, {
            sessionId: 1, teacherUid: 't1', from: 'reimbursed', target: 'draft', operatorId: 5, actorType: 'teacher'
        });
        expect(r.ok).toBe(false);
        expect(r.error).toBeTruthy();
    });
});

describe('fee-service.batchTransitionFeeStatus', () => {
    test('批量：3 次往返（批量读 → 批量写 → 批量审计），skipStatus 跳过', async () => {
        const tx = txWithSessions([
            sess({ id: 1, teachers: [tPair({ fee_status: 'draft' })] }),
            sess({ id: 2, teachers: [tPair({ fee_status: 'reimbursed' })] })
        ]);
        const updated = await FeeService.batchTransitionFeeStatus(tx, {
            targets: [{ session_id: 1, teacher_uid: 't1' }, { session_id: 2, teacher_uid: 't1' }],
            target: 'teacher_submitted', operatorId: 1, actorType: 'admin', skipStatus: 'reimbursed'
        });
        expect(updated).toBe(1);   // 第 2 场因 skipStatus 跳过
        expect(tx).toHaveBeenCalledTimes(3);
        const updateCall = tx.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        expect(updateCall[0]).toMatch(/FROM \(VALUES/);
        expect(JSON.parse(updateCall[1][2])[0].fee_status).toBe('teacher_submitted');
        const insertCall = tx.mock.calls.find(c => /INSERT INTO session_fee_status_logs/i.test(String(c[0])));
        expect(insertCall[1]).toEqual([1, 't1', 'draft', 'teacher_submitted', 1, 'admin', null]);
    });

    test('teacher 越权的 pair 跳过（不计入更新，也不写审计）', async () => {
        const tx = txWithSessions([sess({ id: 1, teachers: [tPair({ teacher_id: 99 })] })]);
        const updated = await FeeService.batchTransitionFeeStatus(tx, {
            targets: [{ session_id: 1, teacher_uid: 't1' }],
            target: 'teacher_submitted', operatorId: 5, actorType: 'teacher',
            actor: { actorType: 'teacher', id: 5 }
        });
        expect(updated).toBe(0);
        expect(tx.mock.calls.some(c => /UPDATE course_sessions/i.test(String(c[0])))).toBe(false);
    });

    test('不传 uid → 覆盖本场全部教师 pair（与旧的按行改整条最接近）', async () => {
        const tx = txWithSessions([sess({
            id: 1, teachers: [tPair(), tPair({ uid: 't2', teacher_id: 6 })]
        })]);
        const updated = await FeeService.batchTransitionFeeStatus(tx, {
            targetIds: [1], target: 'teacher_submitted', operatorId: 1, actorType: 'admin'
        });
        expect(updated).toBe(2);
        const updateCall = tx.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        expect(JSON.parse(updateCall[1][2]).map(t => t.fee_status)).toEqual(['teacher_submitted', 'teacher_submitted']);
    });
});

describe('fee-service.batchUpdateScheduleFeesInTx', () => {
    const admin = { actorType: 'admin' };

    test('越权（非本人 pair）→ 抛错', async () => {
        const tx = txWithSessions([sess({ teachers: [tPair({ teacher_id: 99 })] })]);
        await expect(FeeService.batchUpdateScheduleFeesInTx(tx,
            [{ session_id: 1, teacher_uid: 't1', transport_fee: 10 }],
            { actor: { actorType: 'teacher', id: 5 }, operatorId: 5 }
        )).rejects.toThrow(/不属于您/);
    });

    test('负数费用 → 抛错，且不发任何查询', async () => {
        const tx = jest.fn(async () => ({ rows: [] }));
        await expect(FeeService.batchUpdateScheduleFeesInTx(tx,
            [{ session_id: 1, teacher_uid: 't1', transport_fee: -1 }], { actor: admin, operatorId: 1 }
        )).rejects.toThrow(/负数费用/);
        expect(tx).not.toHaveBeenCalled();
    });

    test('无变化跳过、有变化写入并计数', async () => {
        const tx = txWithSessions([
            sess({ id: 1, teachers: [tPair({ transport_fee: 10, other_fee: null })] }),
            sess({ id: 2, teachers: [tPair({ transport_fee: null, other_fee: null })] })
        ]);
        const r = await FeeService.batchUpdateScheduleFeesInTx(tx, [
            { session_id: 1, teacher_uid: 't1', transport_fee: 10, other_fee: '' },   // 无变化
            { session_id: 2, teacher_uid: 't1', transport_fee: 30, other_fee: '' }    // 有变化
        ], { actor: admin, operatorId: 1 });
        expect(r).toEqual({ changed: 1, submitted: 0 });
        const updateCall = tx.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        expect(updateCall[1][1]).toBe(2);   // 只写第 2 场
    });

    test('autoSubmit：只提交本次填写了费用的 pair，留空的不动状态', async () => {
        const tx = txWithSessions([
            sess({ id: 1, teachers: [tPair({ fee_status: 'draft' })] }),
            sess({ id: 2, teachers: [tPair({ fee_status: 'draft' })] })
        ]);
        const r = await FeeService.batchUpdateScheduleFeesInTx(tx, [
            { session_id: 1, teacher_uid: 't1', transport_fee: 30 },                   // 填写了 → 提交
            { session_id: 2, teacher_uid: 't1', transport_fee: '', other_fee: '' }      // 留空 → 不提交
        ], { actor: admin, operatorId: 9, autoSubmitActorType: 'teacher' });
        expect(r.submitted).toBe(1);
        const updateCall = tx.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        expect(JSON.parse(updateCall[1][2])[0].fee_status).toBe('teacher_submitted');
    });

    test('清除费用（全部置 null）→ 只改金额，不改任何状态', async () => {
        const tx = txWithSessions([sess({ teachers: [tPair({ transport_fee: 30, fee_status: 'draft' })] })]);
        const r = await FeeService.batchUpdateScheduleFeesInTx(tx,
            [{ session_id: 1, teacher_uid: 't1', transport_fee: '', other_fee: '' }],
            { actor: admin, operatorId: 9, autoSubmitActorType: 'teacher' }
        );
        expect(r).toEqual({ changed: 1, submitted: 0 });
        const updateCall = tx.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        const written = JSON.parse(updateCall[1][2])[0];
        expect(written.transport_fee).toBeNull();
        expect(written.fee_status).toBe('draft');
    });
});
