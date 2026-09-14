/**
 * 「调整课程」preview_schedule_update / confirm_operation 集成测试
 *
 * 通过 jest.mock 模拟 db（query / runInTransaction）与 scheduleService.checkConflicts，
 * 直接驱动 ai-controller 的 executeDataTool（即 HTTP 路由实际调用的函数），
 * 覆盖「调整课程」完整链路：预览 → 确认 → 标记原记录为已调整 + 插入新课程。
 *
 * 不依赖真实数据库 / AI。
 */

jest.mock('../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    end: jest.fn()
}));

jest.mock('../services/schedule-service', () => ({
    checkConflicts: jest.fn()
}));

const db = require('../db/db');
const scheduleService = require('../services/schedule-service');
const aiOperationStore = require('../services/ai-operation-store');
const { executeDataTool } = require('../controllers/ai-controller')._test;
const pendingOperationStore = aiOperationStore._mem.memOperations;

// 原始排课记录（预览查询返回）
const ORIGINAL = {
    id: 1001,
    class_date: '2026-08-20',
    start_time: '19:00:00',
    end_time: '21:00:00',
    status: 'confirmed',
    location: '学生家中',
    family_participants: 4,
    transport_fee: 0,
    other_fee: 0,
    teacher_name: '王老师', teacher_id: 10,
    student_name: '浩浩', student_id: 20,
    course_type: '入户', course_type_cn: '入户课程'
};

// 可变的原记录状态（供"已调整"场景切换）
let originalStatus = 'confirmed';
let newCourseSeq = 5001;

// 新结构下的场次行：头部 + 一个教师 pair + 一个学生 pair
function sessionRow(statusCode) {
    return {
        id: 1001, version: 1, created_by: 1,
        class_date: '2026-08-20', start_time: '19:00:00', end_time: '21:00:00',
        location: '学生家中', notes: null,
        teachers: [{
            uid: 't1', teacher_id: 10, type_id: 5,
            status: statusCode || `normal.${originalStatus}`,
            transport_fee: 0, other_fee: 0, fee_status: 'draft', created_by: 1
        }],
        students: [{ uid: 's1', student_id: 20, family_participants: 4, created_by: 1 }]
    };
}

function defaultQueryImpl(sql, params) {
    const s = String(sql);
    // 权限落地（Phase 1.5）：归属核验计数 —— 按 ids 数量返回（视为全部可操作）
    if (s.includes('COUNT(*)::int AS count') && s.includes('id = ANY($1)')) {
        const n = Array.isArray(params[0]) ? params[0].length : 1;
        return Promise.resolve({ rows: [{ count: n }] });
    }
    // confirm: 行锁读取原场次（一场一行 + 教师/学生 pair 数组）
    if (s.includes('FOR UPDATE')) {
        return Promise.resolve({ rows: [sessionRow()] });
    }
    // 服务层的写前读（getSessionById）与归属计数
    if (/^\s*SELECT/i.test(s) && s.includes('FROM course_sessions')) {
        if (s.includes('COUNT(*)')) {
            const n = Array.isArray(params[0]) ? params[0].length : 1;
            return Promise.resolve({ rows: [{ count: n }] });
        }
        return Promise.resolve({ rows: [sessionRow()] });
    }
    // confirm: 作废+增补 / 新建都走 course_sessions 的整列写
    if (s.includes('UPDATE course_sessions')) {
        return Promise.resolve({ rows: [sessionRow('normal.modified_away')], rowCount: 1 });
    }
    if (s.includes('INSERT INTO course_sessions')) {
        return Promise.resolve({ rows: [{ ...sessionRow(), id: newCourseSeq++ }] });
    }
    if (s.includes('INSERT INTO session_status_logs')) {
        return Promise.resolve({ rows: [] });
    }
    // 引用完整性批量校验（createSession 写入前）
    if (/SELECT id FROM (teachers|students|schedule_types) WHERE id = ANY/.test(s)) {
        const ids = Array.isArray(params[0]) ? params[0] : [];
        return Promise.resolve({ rows: ids.map(id => ({ id })) });
    }
    // preview: 读取原排课详情（走 pair 展开视图）
    if (s.includes('FROM v_session_pairs ca')) {
        return Promise.resolve({ rows: [ORIGINAL] });
    }
    // 教师 / 学生 / 课程类型 校验
    if (s.includes('FROM teachers WHERE id=$1')) {
        return Promise.resolve({ rows: [{ id: params[0], name: '新老师', status: 1 }] });
    }
    if (s.includes('FROM students WHERE id=$1')) {
        return Promise.resolve({ rows: [{ id: params[0], name: '新学生', status: 1 }] });
    }
    if (s.includes('FROM schedule_types WHERE name=$1')) {
        return Promise.resolve({ rows: [{ id: 99, name: params[0], description: '新课程类型' }] });
    }
    return Promise.resolve({ rows: [] });
}

const adminReq = () => ({ user: { id: 1, userType: 'admin' } });

beforeEach(() => {
    originalStatus = 'confirmed';
    newCourseSeq = 5001;
    db.query.mockReset();
    db.query.mockImplementation(defaultQueryImpl);
    // usePool=true：事务内查询走 db.query（同一 mock）
    db.runInTransaction.mockImplementation(async (workFn) => workFn(db, true));
    scheduleService.checkConflicts.mockReset();
    scheduleService.checkConflicts.mockResolvedValue({ hasConflicts: false });
    pendingOperationStore.clear();
});

describe('调整课程 · 预览', () => {
    it('preview_schedule_update(status=modified_away) 返回调整预览与新建课程（含师生姓名）', async () => {
        const res = await executeDataTool('preview_schedule_update', {
            scheduleIds: [1001],
            fields: { classDate: '2026-08-21', status: 'modified_away' }
        }, adminReq());

        expect(res.type).toBe('schedule_operation_preview');
        expect(res.data.operationType).toBe('adjust');
        expect(res.title).toBe('调整预览');
        expect(Array.isArray(res.data.newSchedules)).toBe(true);
        expect(res.data.newSchedules).toHaveLength(1);

        const ns = res.data.newSchedules[0];
        expect(ns.classDate).toBe('2026-08-21');      // 新条件覆盖
        expect(ns.teacherName).toBe('王老师');        // 沿用原记录
        expect(ns.studentName).toBe('浩浩');          // 沿用原记录
        expect(ns.courseTypeCn).toBe('入户课程');     // 沿用原记录
        expect(ns.status).toBe('confirmed');
        expect(ns.adjustmentType).toBe(2);
        expect(res.data.operationId).toBeDefined();
    });

    it('调整课程换教师时 newSchedules 携带新教师姓名', async () => {
        const res = await executeDataTool('preview_schedule_update', {
            scheduleIds: [1001],
            fields: { teacherId: 999, status: 'modified_away' }
        }, adminReq());

        const ns = res.data.newSchedules[0];
        expect(ns.teacherId).toBe(999);
        expect(ns.teacherName).toBe('新老师');        // 取新教师名
        expect(ns.studentName).toBe('浩浩');          // 学生沿用
    });

    it('非管理员调用预览抛 403', async () => {
        const req = { user: { id: 2, userType: 'teacher' } };
        await expect(executeDataTool('preview_schedule_update', {
            scheduleIds: [1001], fields: { status: 'modified_away' }
        }, req)).rejects.toThrow(/管理员/);
    });
});

describe('调整课程 · 确认', () => {
    it('确认成功：标记原记录为已调整 + 插入 adj=2 新课程', async () => {
        const preview = await executeDataTool('preview_schedule_update', {
            scheduleIds: [1001], fields: { classDate: '2026-08-21', status: 'modified_away' }
        }, adminReq());
        const opId = preview.data.operationId;

        const res = await executeDataTool('confirm_operation', { operationId: opId }, adminReq());

        expect(res.title).toBe('调整成功');
        expect(res.data.originalIds).toEqual([1001]);
        expect(res.data.newIds).toHaveLength(1);

        // 1) 原 pair 标成 *.modified_away，同一条 UPDATE 追加 adjusted.pending 新 pair
        const markCall = db.query.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        expect(markCall).toBeDefined();
        const writtenPairs = JSON.parse(markCall[1][0]);
        expect(writtenPairs[0].status).toBe('normal.modified_away');
        expect(writtenPairs[1]).toMatchObject({ teacher_id: 10, type_id: 5, status: 'adjusted.pending' });

        // 2) 日期变了 → 另起一场新课承载（头部字段是整场共享的）
        const insertCall = db.query.mock.calls.find(c => /INSERT INTO course_sessions/i.test(String(c[0])));
        expect(insertCall).toBeDefined();
        expect(insertCall[1][0]).toBe('2026-08-21');   // 新日期
        expect(JSON.parse(insertCall[1][5])[0].type_id).toBe(5);   // 沿用原类型

        // 3) 冲突检测被调用，且传入新条件
        expect(scheduleService.checkConflicts).toHaveBeenCalledWith(
            10, 20, '2026-08-21', null, '19:00:00', '21:00:00', null
        );

        // 4) 确认后操作从待确认存储中移除
        expect(pendingOperationStore.has(opId)).toBe(false);
    });

    it('确认成功换教师：冲突检测使用新教师 ID', async () => {
        const preview = await executeDataTool('preview_schedule_update', {
            scheduleIds: [1001], fields: { teacherId: 999, status: 'modified_away' }
        }, adminReq());
        const res = await executeDataTool('confirm_operation', { operationId: preview.data.operationId }, adminReq());

        expect(res.data.newIds).toHaveLength(1);
        expect(scheduleService.checkConflicts).toHaveBeenCalledWith(
            999, 20, '2026-08-20', null, '19:00:00', '21:00:00', null
        );
    });

    it('冲突时抛 409 且插入不发生（回滚）', async () => {
        scheduleService.checkConflicts.mockResolvedValue({
            hasConflicts: true, type: 'overlap_teacher', message: '教师时间段重叠'
        });
        const preview = await executeDataTool('preview_schedule_update', {
            scheduleIds: [1001], fields: { classDate: '2026-08-21', status: 'modified_away' }
        }, adminReq());
        const opId = preview.data.operationId;

        await expect(executeDataTool('confirm_operation', { operationId: opId }, adminReq()))
            .rejects.toThrow(/冲突/);

        // 冲突在建新场次前检测 → 不新建
        const insertCall = db.query.mock.calls.find(c => /INSERT INTO course_sessions/i.test(String(c[0])));
        expect(insertCall).toBeUndefined();
        expect(scheduleService.checkConflicts).toHaveBeenCalled();
    });

    it('原记录已为已调整时拒绝（409）', async () => {
        originalStatus = 'modified_away';
        const preview = await executeDataTool('preview_schedule_update', {
            scheduleIds: [1001], fields: { classDate: '2026-08-21', status: 'modified_away' }
        }, adminReq());
        const opId = preview.data.operationId;

        await expect(executeDataTool('confirm_operation', { operationId: opId }, adminReq()))
            .rejects.toThrow(/已被调整过/);
    });
});

describe('普通改课回归', () => {
    it('不带 status 走直接 UPDATE 分支，不触发冲突检测', async () => {
        const preview = await executeDataTool('preview_schedule_update', {
            scheduleIds: [1001], fields: { classDate: '2026-08-25' }
        }, adminReq());
        expect(preview.data.operationType).toBe('update');
        expect(preview.title).toBe('修改预览');
        expect(preview.data.newSchedules).toBeNull();

        const res = await executeDataTool('confirm_operation', { operationId: preview.data.operationId }, adminReq());
        expect(res.title).toBe('修改成功');

        // 普通改课：头部字段走 updateSessionHeader（带 version 的整场写）
        const upd = db.query.mock.calls.find(
            c => /UPDATE course_sessions/i.test(String(c[0])) && /class_date = \$/.test(String(c[0]))
        );
        expect(upd).toBeDefined();
        expect(scheduleService.checkConflicts).not.toHaveBeenCalled();
    });
});
