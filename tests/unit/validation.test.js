const { passwordChangeValidation } = require('../../src/server/middleware/validation');

// 与 middleware/validation.js 的 validate 中间件保持一致的校验选项
const opts = { abortEarly: false, allowUnknown: false, stripUnknown: true };

describe('passwordChangeValidation (M5: 教师/学生改密码)', () => {
    test('缺少 currentPassword 被拒', () => {
        const { error } = passwordChangeValidation.validate(
            { newPassword: 'secret123' },
            opts
        );
        expect(error).toBeTruthy();
        expect(error.details.some(d => d.path.join('.') === 'currentPassword')).toBe(true);
    });

    test('缺少 newPassword 被拒', () => {
        const { error } = passwordChangeValidation.validate(
            { currentPassword: 'oldpass' },
            opts
        );
        expect(error).toBeTruthy();
        expect(error.details.some(d => d.path.join('.') === 'newPassword')).toBe(true);
    });

    test('newPassword 少于 6 位被拒', () => {
        const { error } = passwordChangeValidation.validate(
            { currentPassword: 'oldpass', newPassword: '123' },
            opts
        );
        expect(error).toBeTruthy();
    });

    test('合法请求通过且未知字段被剥离', () => {
        const { error, value } = passwordChangeValidation.validate(
            { currentPassword: 'oldpass', newPassword: 'secret123', extra: 'ignored' },
            opts
        );
        expect(error).toBeFalsy();
        expect(value).toEqual({ currentPassword: 'oldpass', newPassword: 'secret123' });
    });
});

const { teacherProfileValidation, studentProfileValidation, feeUpdateValidation, feeStatusUpdateValidation, feeStatusBatchValidation, feeBatchValidation, scheduleTypeValidation, holidayValidation, holidayBatchValidation, holidaySyncValidation, feedbackCreateValidation, feedbackUpdateValidation, adminConfirmValidation, teacherConfirmValidation, teacherStatusUpdateValidation, aiConfigUpdateValidation, aiConfigTestValidation, teacherAvailabilitySetValidation, teacherAvailabilityDeleteValidation, teacherAvailabilityReplaceValidation, adminTeacherAvailabilityValidation, adminStudentAvailabilityValidation, studentAvailabilitySetValidation, studentAvailabilityDeleteValidation } = require('../../src/server/middleware/validation');

describe('teacherProfileValidation (M5: 教师资料更新)', () => {
    const full = { name: '张三', nickname: '', profession: '', contact: '', work_location: '', home_address: '', status: 1 };

    test('全量合法请求通过', () => {
        const { error } = teacherProfileValidation.validate(full, opts);
        expect(error).toBeFalsy();
    });

    test('缺少 name 被拒', () => {
        const { error } = teacherProfileValidation.validate({ ...full, name: '' }, opts);
        expect(error).toBeTruthy();
        expect(error.details.some(d => d.path.join('.') === 'name')).toBe(true);
    });

    test('非法 status 被拒', () => {
        const { error } = teacherProfileValidation.validate({ ...full, status: 5 }, opts);
        expect(error).toBeTruthy();
        expect(error.details.some(d => d.path.join('.') === 'status')).toBe(true);
    });

    test('未知字段被剥离且必填字段保留', () => {
        const { error, value } = teacherProfileValidation.validate({ ...full, foo: 'bar' }, opts);
        expect(error).toBeFalsy();
        expect(value.foo).toBeUndefined();
        expect(value.name).toBe('张三');
    });
});

describe('studentProfileValidation (M5: 学生资料更新)', () => {
    const full = { name: '李四', nickname: '', profession: '', contact: '', visit_location: '', home_address: '' };

    test('全量合法请求通过', () => {
        const { error } = studentProfileValidation.validate(full, opts);
        expect(error).toBeFalsy();
    });

    test('缺少 name 被拒', () => {
        const { error } = studentProfileValidation.validate({ ...full, name: '' }, opts);
        expect(error).toBeTruthy();
        expect(error.details.some(d => d.path.join('.') === 'name')).toBe(true);
    });

    test('未知字段(含非契约 status)被剥离且必填字段保留', () => {
        const { error, value } = studentProfileValidation.validate({ ...full, status: 1, foo: 'bar' }, opts);
        expect(error).toBeFalsy();
        expect(value.status).toBeUndefined();
        expect(value.foo).toBeUndefined();
        expect(value.name).toBe('李四');
    });
});

describe('fees 集群校验 (M5: 费用写路由)', () => {
    test('feeUpdateValidation: 金额数字/数字串/null/空均通过', () => {
        const cases = [
            { transport_fee: 100, other_fee: 20 },
            { transport_fee: '100', other_fee: '20.5' },
            { transport_fee: null, other_fee: '' },
            {}
        ];
        for (const body of cases) {
            const { error } = feeUpdateValidation.validate(body, opts);
            expect(error).toBeFalsy();
        }
    });

    test('feeUpdateValidation: 非数字金额被拒', () => {
        const { error } = feeUpdateValidation.validate({ transport_fee: 'abc' }, opts);
        expect(error).toBeTruthy();
    });

    test('feeStatusUpdateValidation: 合法 fee_status 通过，非法被拒', () => {
        expect(feeStatusUpdateValidation.validate({ fee_status: 'reimbursed' }, opts).error).toBeFalsy();
        const { error } = feeStatusUpdateValidation.validate({ fee_status: 'bogus' }, opts);
        expect(error).toBeTruthy();
        expect(error.details.some(d => d.path.join('.') === 'fee_status')).toBe(true);
    });

    test('feeStatusUpdateValidation: 缺 fee_status 被拒', () => {
        const { error } = feeStatusUpdateValidation.validate({ note: 'x' }, opts);
        expect(error).toBeTruthy();
    });

    test('feeStatusBatchValidation: ids 数组或 scope 对象均通过', () => {
        expect(feeStatusBatchValidation.validate({ fee_status: 'reimbursed', ids: [1, 2, 3] }, opts).error).toBeFalsy();
        expect(feeStatusBatchValidation.validate({ fee_status: 'returned', scope: { startDate: '2026-01-01', endDate: '2026-01-31' } }, opts).error).toBeFalsy();
    });

    test('feeStatusBatchValidation: scope 缺日期被拒 / 非法 fee_status 被拒', () => {
        const { error: e1 } = feeStatusBatchValidation.validate({ fee_status: 'reimbursed', scope: { startDate: 'x' } }, opts);
        expect(e1).toBeTruthy();
        const { error: e2 } = feeStatusBatchValidation.validate({ fee_status: 'nope' }, opts);
        expect(e2).toBeTruthy();
    });

    test('feeBatchValidation: 合法 updates 通过', () => {
        const { error } = feeBatchValidation.validate({ updates: [{ id: 1, transport_fee: 10, other_fee: 5 }] }, opts);
        expect(error).toBeFalsy();
    });

    test('feeBatchValidation: 缺 updates / 空数组 / 项缺 id 均被拒', () => {
        expect(feeBatchValidation.validate({}, opts).error).toBeTruthy();
        expect(feeBatchValidation.validate({ updates: [] }, opts).error).toBeTruthy();
        expect(feeBatchValidation.validate({ updates: [{ transport_fee: 1 }] }, opts).error).toBeTruthy();
    });
});

describe('scheduleTypeValidation (M5: 课程类型)', () => {
    test('合法请求通过（含可选 description）', () => {
        expect(scheduleTypeValidation.validate({ name: '一对一', description: '备注' }, opts).error).toBeFalsy();
        expect(scheduleTypeValidation.validate({ name: '班课' }, opts).error).toBeFalsy();
    });

    test('缺 name 被拒', () => {
        const { error } = scheduleTypeValidation.validate({ description: 'x' }, opts);
        expect(error).toBeTruthy();
        expect(error.details.some(d => d.path.join('.') === 'name')).toBe(true);
    });

    test('name 超长被拒', () => {
        const { error } = scheduleTypeValidation.validate({ name: 'x'.repeat(51) }, opts);
        expect(error).toBeTruthy();
    });
});

describe('holidayValidation / holidayBatchValidation / holidaySyncValidation (M5: 节假日写路由)', () => {
    const full = { year: 2026, type: 'public', label: '春节', start_date: '2026-02-17', end_date: '2026-02-24' };

    test('holidayValidation: 全量合法请求通过', () => {
        expect(holidayValidation.validate(full, opts).error).toBeFalsy();
    });

    test('holidayValidation: 缺必填字段被拒', () => {
        for (const key of ['year', 'type', 'label', 'start_date', 'end_date']) {
            const { error } = holidayValidation.validate({ ...full, [key]: undefined }, opts);
            expect(error).toBeTruthy();
            expect(error.details.some(d => d.path.join('.') === key)).toBe(true);
        }
    });

    test('holidayValidation: 非法日期格式 / 越界年份被拒', () => {
        expect(holidayValidation.validate({ ...full, start_date: '2026/02/17' }, opts).error).toBeTruthy();
        expect(holidayValidation.validate({ ...full, year: 1999 }, opts).error).toBeTruthy();
        expect(holidayValidation.validate({ ...full, year: 2101 }, opts).error).toBeTruthy();
    });

    test('holidayBatchValidation: 合法 items 通过', () => {
        expect(holidayBatchValidation.validate({ items: [full, { ...full, label: '清明' }] }, opts).error).toBeFalsy();
    });

    test('holidayBatchValidation: 缺 items / 空数组 / 项残缺被拒', () => {
        expect(holidayBatchValidation.validate({}, opts).error).toBeTruthy();
        expect(holidayBatchValidation.validate({ items: [] }, opts).error).toBeTruthy();
        expect(holidayBatchValidation.validate({ items: [{ year: 2026 }] }, opts).error).toBeTruthy();
    });

    test('holidaySyncValidation: years 可选且对未知字段放行', () => {
        expect(holidaySyncValidation.validate({}, opts).error).toBeFalsy();
        expect(holidaySyncValidation.validate({ years: [2026, 2027] }, opts).error).toBeFalsy();
        expect(holidaySyncValidation.validate({ years: [2026], extra: 'ok' }, opts).error).toBeFalsy();
        expect(holidaySyncValidation.validate({ years: ['x'] }, opts).error).toBeTruthy();
    });
});

describe('feedback 校验 (M5: 反馈写路由)', () => {
    test('feedbackCreateValidation: 合法请求通过', () => {
        expect(feedbackCreateValidation.validate({ type: 'bug', description: '崩溃' }, opts).error).toBeFalsy();
        expect(feedbackCreateValidation.validate({ type: 'feature', priority: 'high', title: 't', description: 'd' }, opts).error).toBeFalsy();
    });

    test('feedbackCreateValidation: 缺 type / 缺 description / 非法 type / 非法 priority 被拒', () => {
        expect(feedbackCreateValidation.validate({ description: 'x' }, opts).error).toBeTruthy();
        expect(feedbackCreateValidation.validate({ type: 'bug' }, opts).error).toBeTruthy();
        expect(feedbackCreateValidation.validate({ type: 'nope', description: 'x' }, opts).error).toBeTruthy();
        expect(feedbackCreateValidation.validate({ type: 'bug', priority: 'urgent', description: 'x' }, opts).error).toBeTruthy();
    });

    test('feedbackUpdateValidation: 全可选，合法通过；非法枚举被拒', () => {
        expect(feedbackUpdateValidation.validate({}, opts).error).toBeFalsy();
        expect(feedbackUpdateValidation.validate({ status: 'done', type: 'bug' }, opts).error).toBeFalsy();
        expect(feedbackUpdateValidation.validate({ status: 'closed' }, opts).error).toBeTruthy();
        expect(feedbackUpdateValidation.validate({ type: 'bad' }, opts).error).toBeTruthy();
    });
});

describe('confirm / status 校验 (M5: 确认与状态写路由)', () => {
    test('adminConfirmValidation: adminConfirmed 布尔可选', () => {
        expect(adminConfirmValidation.validate({}, opts).error).toBeFalsy();
        expect(adminConfirmValidation.validate({ adminConfirmed: true }, opts).error).toBeFalsy();
        expect(adminConfirmValidation.validate({ adminConfirmed: 'x' }, opts).error).toBeTruthy();
    });

    test('teacherConfirmValidation: 合法通过；notes 超长被拒', () => {
        expect(teacherConfirmValidation.validate({ teacherConfirmed: true, notes: 'ok' }, opts).error).toBeFalsy();
        expect(teacherConfirmValidation.validate({ notes: 'x'.repeat(501) }, opts).error).toBeTruthy();
    });

    test('teacherStatusUpdateValidation: 合法通过；缺 status / 非法 status 被拒', () => {
        expect(teacherStatusUpdateValidation.validate({ status: 'completed' }, opts).error).toBeFalsy();
        expect(teacherStatusUpdateValidation.validate({}, opts).error).toBeTruthy();
        expect(teacherStatusUpdateValidation.validate({ status: 'bogus' }, opts).error).toBeTruthy();
    });
});

describe('aiConfig 校验 (M5: AI 配置写路由)', () => {
    test('aiConfigUpdateValidation: 合法（apiKey 直接给）通过', () => {
        expect(aiConfigUpdateValidation.validate({ provider: 'openai', baseUrl: 'https://x', model: 'gpt', apiKey: 'sk' }, opts).error).toBeFalsy();
    });

    test('aiConfigUpdateValidation: 缺 provider/baseUrl/model 被拒；apiKey 可空由控制器兜底', () => {
        expect(aiConfigUpdateValidation.validate({ baseUrl: 'https://x', model: 'gpt', apiKey: 'sk' }, opts).error).toBeTruthy();
        expect(aiConfigUpdateValidation.validate({ provider: 'openai', model: 'gpt', apiKey: 'sk' }, opts).error).toBeTruthy();
        expect(aiConfigUpdateValidation.validate({ provider: 'openai', baseUrl: 'https://x', apiKey: 'sk' }, opts).error).toBeTruthy();
        // 缺 apiKey 且无 presetId 不在此处 400（控制器校验 apiKey‖presetId 并抛错），schema 放行以避免过度收紧
        expect(aiConfigUpdateValidation.validate({ provider: 'openai', baseUrl: 'https://x', model: 'gpt' }, opts).error).toBeFalsy();
    });

    test('aiConfigUpdateValidation: presetId 存在时同样通过', () => {
        expect(aiConfigUpdateValidation.validate({ provider: 'openai', baseUrl: 'https://x', model: 'gpt', presetId: 'p1' }, opts).error).toBeFalsy();
    });

    test('aiConfigTestValidation: provider 可选；缺 baseUrl 被拒', () => {
        expect(aiConfigTestValidation.validate({ baseUrl: 'https://x', model: 'gpt', apiKey: 'sk' }, opts).error).toBeFalsy();
        expect(aiConfigTestValidation.validate({ baseUrl: 'https://x', model: 'gpt', presetId: 'p1' }, opts).error).toBeFalsy();
        expect(aiConfigTestValidation.validate({ model: 'gpt', apiKey: 'sk' }, opts).error).toBeTruthy();
    });
});

describe('availability 校验 (M5: 空闲时段写路由)', () => {
    test('teacherAvailabilitySetValidation: 多态 slots 通过且未知字段保留', () => {
        const ok1 = teacherAvailabilitySetValidation.validate({
            availabilityList: [{ date: '2026-01-01', slots: { morning: 1, evening: 0 } }]
        }, opts);
        expect(ok1.error).toBeFalsy();
        const ok2 = teacherAvailabilitySetValidation.validate({
            availabilityList: [{ date: '2026-01-01', timeSlot: 'morning', isAvailable: true, extra: 'keep' }]
        }, opts);
        expect(ok2.error).toBeFalsy();
        expect(ok2.value.availabilityList[0].extra).toBe('keep');
    });

    test('teacherAvailabilitySetValidation: 缺 availabilityList / 项缺 date 被拒', () => {
        expect(teacherAvailabilitySetValidation.validate({}, opts).error).toBeTruthy();
        expect(teacherAvailabilitySetValidation.validate({ availabilityList: [{ timeSlot: 'morning' }] }, opts).error).toBeTruthy();
    });

    test('teacherAvailabilityDeleteValidation: 全可选，合法通过', () => {
        expect(teacherAvailabilityDeleteValidation.validate({}, opts).error).toBeFalsy();
        expect(teacherAvailabilityDeleteValidation.validate({ date: '2026-01-01', timeSlots: ['morning'] }, opts).error).toBeFalsy();
    });

    test('teacherAvailabilityReplaceValidation: updates / removals 均通过', () => {
        expect(teacherAvailabilityReplaceValidation.validate({ updates: [{ date: '2026-01-01', slots: { morning: 1 } }] }, opts).error).toBeFalsy();
        expect(teacherAvailabilityReplaceValidation.validate({ removals: [{ date: '2026-01-01', removeAll: true }] }, opts).error).toBeFalsy();
    });

    test('adminTeacherAvailabilityValidation: 合法通过；缺 teacher_id/date / 空 updates 被拒', () => {
        expect(adminTeacherAvailabilityValidation.validate({ updates: [{ teacher_id: 1, date: '2026-01-01' }] }, opts).error).toBeFalsy();
        expect(adminTeacherAvailabilityValidation.validate({ updates: [{ date: '2026-01-01' }] }, opts).error).toBeTruthy();
        expect(adminTeacherAvailabilityValidation.validate({ updates: [{ teacher_id: 1 }] }, opts).error).toBeTruthy();
        expect(adminTeacherAvailabilityValidation.validate({ updates: [] }, opts).error).toBeTruthy();
    });

    test('adminStudentAvailabilityValidation: 合法通过；缺 student_id 被拒', () => {
        expect(adminStudentAvailabilityValidation.validate({ updates: [{ student_id: 2, date: '2026-01-01' }] }, opts).error).toBeFalsy();
        expect(adminStudentAvailabilityValidation.validate({ updates: [{ date: '2026-01-01' }] }, opts).error).toBeTruthy();
    });

    test('studentAvailabilitySetValidation: 合法通过；缺 timeSlot / 缺 date 被拒', () => {
        expect(studentAvailabilitySetValidation.validate({ availabilityList: [{ date: '2026-01-01', timeSlot: 'morning', isAvailable: false }] }, opts).error).toBeFalsy();
        expect(studentAvailabilitySetValidation.validate({ availabilityList: [{ date: '2026-01-01' }] }, opts).error).toBeTruthy();
        expect(studentAvailabilitySetValidation.validate({ availabilityList: [{ timeSlot: 'morning' }] }, opts).error).toBeTruthy();
    });

    test('studentAvailabilityDeleteValidation: 合法通过', () => {
        expect(studentAvailabilityDeleteValidation.validate({ startDate: '2026-01-01', endDate: '2026-01-31', timeSlots: ['morning'] }, opts).error).toBeFalsy();
        expect(studentAvailabilityDeleteValidation.validate({}, opts).error).toBeFalsy();
    });
});
