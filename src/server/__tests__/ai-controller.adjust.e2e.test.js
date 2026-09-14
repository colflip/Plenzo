/**
 * 「调整课程」端到端冒烟（HTTP 处理器级）
 *
 * 驱动真实的 ai-controller.query HTTP 处理器，而非仅 executeDataTool：
 *   1) 第一轮：模拟 AI 返回 preview_schedule_update 工具调用 → 经由真实 AI 工具循环
 *      → executeDataTool('preview_schedule_update') → 生成「调整预览」+ 写入 pendingOperationStore
 *   2) 第二轮：前端确认 action { type:'confirm_operation', operationId } → 真实 action 分支
 *      → executeDataTool('confirm_operation') → 标记原记录为已调整 + 插入 adj=2 新课程
 *
 * 仅 mock 三层外部依赖：aiService（无真实 AI）、db（无真实 PG）、scheduleService（冲突检测）。
 *
 * 注意：asyncHandler 不回传内部 Promise，query() 调用后立即返回 undefined，
 * 因此不能直接 `await query()` 等待处理完成；这里改为等待 res.json/res.end/next 触发的 finished。
 *
 * 真实环境 prerequisites（见文件末尾注释）：
 *   - DATABASE_URL 指向可达 PostgreSQL
 *   - 服务端 AI_API_KEY + AI_ENABLED=true
 *   - npm run dev 启动，前端在 AI 对话框触发/确认
 */

jest.mock('../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn(),
    end: jest.fn()
}));

jest.mock('../services/schedule-service', () => ({
    checkConflicts: jest.fn()
}));

jest.mock('../services/ai-service', () => ({
    isAvailable: jest.fn(() => true),
    getAIConfig: jest.fn(() => ({ model: 'mock-model', channel: 'mock' })),
    chat: jest.fn(),
    extractToolCalls: jest.fn((resp) => resp && resp.__toolCalls ? resp.__toolCalls : []),
    extractText: jest.fn((resp) => (resp && resp.choices && resp.choices[0] && resp.choices[0].message.content) || '')
}));

const db = require('../db/db');
const scheduleService = require('../services/schedule-service');
const courseSessionService = require('../services/course-session-service');
const aiService = require('../services/ai-service');
const aiController = require('../controllers/ai-controller');
const aiOperationStore = require('../services/ai-operation-store');

// db mock 后，operation-store 的 db.query 仍指向真 db；测试用内存兜底层校验。
const pendingOperationStore = aiOperationStore._mem.memOperations;
const schedulePreviewStore = aiOperationStore._mem.memPreviews;

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

let originalStatus = 'confirmed';
let newCourseSeq = 5001;

// 新结构下的场次行
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
    // 一场一行：写前读 / 行锁读都返回场次形状（头部 + 教师/学生 pair 数组）
    if (/^\s*SELECT/i.test(s) && s.includes('FROM course_sessions')) {
        return Promise.resolve({ rows: [sessionRow()] });
    }
    if (s.includes('UPDATE course_sessions')) {
        return Promise.resolve({ rows: [sessionRow('normal.modified_away')], rowCount: 1 });
    }
    if (s.includes('INSERT INTO course_sessions')) {
        return Promise.resolve({ rows: [{ ...sessionRow(), id: newCourseSeq++ }] });
    }
    if (s.includes('INSERT INTO session_status_logs')) return Promise.resolve({ rows: [] });
    if (/SELECT id FROM (teachers|students|schedule_types) WHERE id = ANY/.test(s)) {
        const ids = Array.isArray(params[0]) ? params[0] : [];
        return Promise.resolve({ rows: ids.map(id => ({ id })) });
    }
    if (s.includes('FROM v_session_pairs ca')) return Promise.resolve({ rows: [ORIGINAL] });
    if (s.includes('FROM teachers WHERE id=$1')) return Promise.resolve({ rows: [{ id: params[0], name: '新老师', status: 1 }] });
    if (s.includes('FROM students WHERE id=$1')) return Promise.resolve({ rows: [{ id: params[0], name: '新学生', status: 1 }] });
    if (s.includes('FROM schedule_types WHERE name=$1')) return Promise.resolve({ rows: [{ id: 99, name: params[0], description: '新课程类型' }] });
    return Promise.resolve({ rows: [] });
}

// 模拟 AI 在第一轮返回 preview_schedule_update 工具调用
const PREVIEW_TOOL_CALL = {
    id: 'call_preview_1',
    type: 'function',
    function: {
        name: 'preview_schedule_update',
        arguments: JSON.stringify({
            scheduleIds: [1001],
            fields: { classDate: '2026-08-21', status: 'modified_away' }
        })
    }
};

function makeRes() {
    const res = {};
    res._json = null;
    res._status = null;
    let doneResolve;
    res.finished = new Promise((r) => { doneResolve = r; });
    res._doneResolve = doneResolve;
    res.json = (p) => { res._json = p; res._status = res._status || 200; doneResolve(); return res; };
    res.status = (c) => { res._status = c; return res; };
    res.write = () => {};
    res.writeHead = () => {};
    res.end = () => { doneResolve(); return res; };
    return res;
}

// asyncHandler 不回传内部 Promise，这里用 finished 等待真实处理完成
async function drive(req, res) {
    let err = null;
    await aiController.query(req, res, (e) => { err = e; res._doneResolve(); });
    await res.finished;
    return err;
}

const adminReq = (body) => ({ user: { id: 1, userType: 'admin' }, body });

beforeEach(() => {
    originalStatus = 'confirmed';
    newCourseSeq = 5001;
    db.query.mockReset();
    db.query.mockImplementation(defaultQueryImpl);
    db.runInTransaction.mockImplementation(async (workFn) => workFn(db, true));
    scheduleService.checkConflicts.mockReset();
    scheduleService.checkConflicts.mockResolvedValue({ hasConflicts: false });
    aiService.chat.mockReset();
    // 第一轮：返回工具调用；后续轮次（整理结果）返回无工具调用的空响应
    aiService.chat.mockImplementationOnce(() => Promise.resolve({
        choices: [{ message: { content: '', tool_calls: [PREVIEW_TOOL_CALL] } }],
        __toolCalls: [PREVIEW_TOOL_CALL]
    }));
    aiService.chat.mockResolvedValue({
        choices: [{ message: { content: '已为您完成调整课程。', tool_calls: [] } }],
        __toolCalls: []
    });
    pendingOperationStore.clear();
    schedulePreviewStore.clear();
});

describe('调整课程 · 端到端（真实 query 处理器）', () => {
    it('AI 工具循环预览 → 前端 action 确认，全程经真实 HTTP 处理器', async () => {
        // ---- 第一轮：用户提问，AI 返回 preview_schedule_update 工具调用 ----
        const req1 = adminReq({ question: '把排课 1001 调整到 8月21日', stream: false });
        const res1 = makeRes();
        const err1 = await drive(req1, res1);

        expect(err1).toBeNull();
        expect(res1._json).not.toBeNull();
        expect(res1._json.ok).toBe(true);

        const previewPayload = res1._json.data;
        expect(previewPayload.type).toBe('schedule_operation_preview');
        expect(previewPayload.toolsUsed).toContain('preview_schedule_update');

        const op = previewPayload.structuredData;
        expect(op.operationType).toBe('adjust');
        expect(Array.isArray(op.newSchedules)).toBe(true);
        expect(op.newSchedules).toHaveLength(1);
        expect(op.newSchedules[0].classDate).toBe('2026-08-21');
        expect(op.newSchedules[0].adjustmentType).toBe(2);
        expect(op.operationId).toBeDefined();
        // 预览写入待确认存储
        expect(pendingOperationStore.has(op.operationId)).toBe(true);

        // ---- 第二轮：前端发送确认 action ----
        const req2 = adminReq({ action: { type: 'confirm_operation', operationId: op.operationId }, stream: false });
        const res2 = makeRes();
        const err2 = await drive(req2, res2);

        expect(err2).toBeNull();
        expect(res2._json).not.toBeNull();
        expect(res2._json.ok).toBe(true);
        expect(res2._json.data.toolsUsed).toContain('confirm_operation');

        const confirmPayload = res2._json.data.structuredData;
        expect(confirmPayload.originalIds).toEqual([1001]);
        expect(confirmPayload.newIds).toHaveLength(1);

        // 确认后操作从待确认存储中移除
        expect(pendingOperationStore.has(op.operationId)).toBe(false);

        // 后端确实执行了「原 pair 标调走 + 追加增补 pair」，日期变了则另起一场新课
        const markCall = db.query.mock.calls.find(c => /UPDATE course_sessions/i.test(String(c[0])));
        const insertCall = db.query.mock.calls.find(c => /INSERT INTO course_sessions/i.test(String(c[0])));
        expect(markCall).toBeDefined();
        const pairs = JSON.parse(markCall[1][0]);
        expect(pairs[0].status).toBe('normal.modified_away');
        expect(pairs[1].status).toBe('adjusted.pending');
        expect(insertCall).toBeDefined();
        expect(insertCall[1][0]).toBe('2026-08-21');
    });

    it('SSE 头发送后的错误使用结构化 error 事件', async () => {
        aiService.chat.mockReset();
        aiService.chat.mockRejectedValueOnce(new Error('provider secret should stay server-side'));
        const req = {
            ...adminReq({ question: '查询课程', stream: true }),
            requestId: 'req-sse-error'
        };
        const res = makeRes();
        const chunks = [];
        res.headersSent = false;
        res.writeHead = () => { res.headersSent = true; };
        res.write = (chunk) => { chunks.push(chunk); };

        const err = await drive(req, res);

        expect(err).toBeNull();
        const output = chunks.join('');
        expect(output).toContain('event: error');
        const errorBlock = output.split('\n\n').find(block => block.startsWith('event: error'));
        const dataLine = errorBlock.split('\n').find(line => line.startsWith('data: '));
        const payload = JSON.parse(dataLine.slice(6));
        expect(payload).toMatchObject({
            error: {
                code: 'INTERNAL_ERROR',
                details: [],
                retryable: false,
                retryAfterSeconds: null
            },
            meta: { requestId: 'req-sse-error' }
        });
        expect(payload.error.message).not.toContain('provider secret');
    });

    it('工具参数不是合法 JSON 时返回上游坏响应且不执行工具', async () => {
        aiService.chat.mockReset();
        const invalidCall = {
            id: 'bad-call',
            function: { name: 'query_schedules', arguments: '{"bad"' }
        };
        aiService.chat.mockResolvedValueOnce({
            choices: [{ message: { content: '', tool_calls: [invalidCall] } }],
            __toolCalls: [invalidCall]
        });
        const err = await drive(adminReq({ question: '查询排课', stream: false }), makeRes());

        expect(err).toMatchObject({ code: 'AI_UPSTREAM_BAD_RESPONSE', statusCode: 502 });
        expect(aiService.chat).toHaveBeenCalledTimes(1);
    });

    it('工具执行失败会终止请求而不是交给模型包装成成功答案', async () => {
        aiService.chat.mockReset();
        const call = {
            id: 'failed-call',
            function: { name: 'query_students', arguments: '{}' }
        };
        aiService.chat.mockResolvedValueOnce({
            choices: [{ message: { content: '', tool_calls: [call] } }],
            __toolCalls: [call]
        });
        const dbError = Object.assign(new Error('database unavailable'), { code: '08006' });
        let queryToolCalls = 0;
        db.query.mockImplementation((sql) => {
            const statement = String(sql);
            if (statement.includes('schedule_types') || statement.includes('FROM teachers WHERE status=1')) {
                return Promise.resolve({ rows: [] });
            }
            if (statement.includes('SELECT id, name, nickname, profession, status FROM students')) {
                queryToolCalls++;
                return Promise.reject(dbError);
            }
            return Promise.resolve({ rows: [] });
        });

        const err = await drive(adminReq({ question: '查询排课', stream: false }), makeRes());

        expect(err).toBe(dbError);
        expect(queryToolCalls).toBe(1);
        expect(aiService.chat).toHaveBeenCalledTimes(1);
    });

    it('批量确认全部失败时向统一错误出口传播', async () => {
        schedulePreviewStore.set('bad-1', { groups: [] });
        schedulePreviewStore.set('bad-2', { groups: [] });
        const failure = new Error('create failed');
        const spy = jest.spyOn(courseSessionService, 'createSessions').mockRejectedValue(failure);

        const err = await drive(adminReq({
            action: { type: 'confirm_create', previewId: 'bad-1,bad-2' },
            stream: false
        }), makeRes());

        expect(err).toBe(failure);
        expect(spy).toHaveBeenCalledTimes(2);
        spy.mockRestore();
    });

    it('批量确认部分失败时明确返回 partial 与失败预览 ID', async () => {
        schedulePreviewStore.set('bad', { groups: [] });
        schedulePreviewStore.set('ok', { groups: [] });
        const spy = jest.spyOn(courseSessionService, 'createSessions')
            .mockRejectedValueOnce(new Error('create failed'))
            .mockResolvedValueOnce([{ id: 701 }]);
        const res = makeRes();

        const err = await drive(adminReq({
            action: { type: 'confirm_create', previewId: 'bad,ok' },
            stream: false
        }), res);

        expect(err).toBeNull();
        expect(res._json.data.structuredData).toMatchObject({
            status: 'partial',
            scheduleIds: [701],
            failedPreviewIds: ['bad']
        });
        expect(res._json.data.answer).toContain('部分排课创建成功');
        spy.mockRestore();
    });

    it('未配置 AI 时返回 503（isAvailable=false）', async () => {
        aiService.isAvailable.mockReturnValueOnce(false);
        const req = adminReq({ question: '调整课程', stream: false });
        const res = makeRes();
        const err = await drive(req, res);

        expect(err).not.toBeNull();
        expect(err.statusCode).toBe(503);
    });
});

/*
 * 真实环境端到端 prerequisites（本冒烟用 mock 替代，无法在 CI 无密钥环境跑真实链路）：
 *   1) 环境变量 DATABASE_URL 指向可达 PostgreSQL（含 course_arrangement / teachers / students / schedule_types 表）
 *   2) 服务端 AI_API_KEY 已配置且 AI_ENABLED=true（aiService.isAvailable() 为 true）
 *   3) 启动后端：npm run dev（监听约定端口）
 *   4) 浏览器以管理员登录，进入 AI 对话框，输入「把排课 1001 调整到 8月21日」
 *      → 后端 AI 工具循环返回「调整预览」→ 前端渲染 🔄 调整预览（原排课 + 新建课程两张表）
 *      → 点击「✓ 确认调整」→ action:{type:'confirm_operation'} → 后端标记原记录 modified_away + 插入 adj=2 新课程
 *   5) 校验数据库：SELECT id, status, adjustment_type FROM course_arrangement WHERE id IN (1001, <新id>);
 *      → 1001 应为 status='modified_away', adjustment_type=0；新行应为 status='confirmed', adjustment_type=2
 */
