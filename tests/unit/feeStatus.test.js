const {
    FEE_STATUSES,
    validateFeeStatusTransition,
    normalizeStatus,
    parseStudentIds,
    resolveActor,
} = require('../../src/server/utils/fee-status');

describe('费用报销状态流转校验', () => {
    test('枚举完整且合法', () => {
        expect(FEE_STATUSES).toEqual(['draft', 'teacher_submitted', 'admin_submitted', 'reimbursed', 'returned', 'reimbursement_returned']);
    });

    test('normalizeStatus：未知/空值回落 draft', () => {
        expect(normalizeStatus(null)).toBe('draft');
        expect(normalizeStatus('')).toBe('draft');
        expect(normalizeStatus('bogus')).toBe('draft');
        expect(normalizeStatus('reimbursed')).toBe('reimbursed');
    });

    test('管理员任意非相同流转均合法', () => {
        expect(validateFeeStatusTransition('admin', 'draft', 'teacher_submitted').ok).toBe(true);
        expect(validateFeeStatusTransition('admin', 'teacher_submitted', 'admin_submitted').ok).toBe(true);
        expect(validateFeeStatusTransition('admin', 'admin_submitted', 'reimbursed').ok).toBe(true);
        // 撤回纠错
        expect(validateFeeStatusTransition('admin', 'reimbursed', 'admin_submitted').ok).toBe(true);
        // 退回
        expect(validateFeeStatusTransition('admin', 'teacher_submitted', 'returned').ok).toBe(true);
    });

    test('班主任等同管理员（任意非相同流转）', () => {
        expect(validateFeeStatusTransition('headteacher', 'draft', 'admin_submitted').ok).toBe(true);
        expect(validateFeeStatusTransition('headteacher', 'returned', 'teacher_submitted').ok).toBe(true);
    });

    test('退回报销：已报销可退回，退回后可再审核报销', () => {
        // 完成报销后撤销（管理员/班主任）
        expect(validateFeeStatusTransition('admin', 'reimbursed', 'reimbursement_returned').ok).toBe(true);
        expect(validateFeeStatusTransition('headteacher', 'reimbursed', 'reimbursement_returned').ok).toBe(true);
        // 退回报销后重新进入审核流程，可再次报销
        expect(validateFeeStatusTransition('admin', 'reimbursement_returned', 'admin_submitted').ok).toBe(true);
        expect(validateFeeStatusTransition('admin', 'reimbursement_returned', 'reimbursed').ok).toBe(true);
        // 普通教师不可触及退回报销（无权）
        expect(validateFeeStatusTransition('teacher', 'reimbursed', 'reimbursement_returned').ok).toBe(false);
        expect(validateFeeStatusTransition('teacher', 'draft', 'reimbursement_returned').ok).toBe(false);
    });

    test('普通教师仅允许 draft/returned → teacher_submitted', () => {
        expect(validateFeeStatusTransition('teacher', 'draft', 'teacher_submitted').ok).toBe(true);
        expect(validateFeeStatusTransition('teacher', 'returned', 'teacher_submitted').ok).toBe(true);
        // 不允许跳过审核直接到已审核/已报销，也不允许退回/撤回
        expect(validateFeeStatusTransition('teacher', 'draft', 'admin_submitted').ok).toBe(false);
        expect(validateFeeStatusTransition('teacher', 'teacher_submitted', 'reimbursed').ok).toBe(false);
        expect(validateFeeStatusTransition('teacher', 'teacher_submitted', 'returned').ok).toBe(false);
    });

    test('相同状态不视为合法流转', () => {
        expect(validateFeeStatusTransition('admin', 'draft', 'draft').ok).toBe(false);
        expect(validateFeeStatusTransition('admin', 'reimbursed', 'reimbursed').ok).toBe(false);
    });

    test('非法目标状态被拒绝', () => {
        expect(validateFeeStatusTransition('admin', 'draft', 'nope').ok).toBe(false);
    });

    test('parseStudentIds 解析逗号分隔整数', () => {
        expect(parseStudentIds('1,2, 3')).toEqual([1, 2, 3]);
        expect(parseStudentIds('')).toEqual([]);
        expect(parseStudentIds(null)).toEqual([]);
        expect(parseStudentIds('a,2,x')).toEqual([2]);
    });

    test('resolveActor：有绑定学生为 headteacher，否则 teacher', async () => {
        const head = await resolveActor({ query: async () => ({ rows: [{ student_ids: '1,2' }] }) }, 5);
        expect(head.actorType).toBe('headteacher');
        expect(head.studentIds).toEqual([1, 2]);

        const normal = await resolveActor({ query: async () => ({ rows: [{ student_ids: null }] }) }, 6);
        expect(normal.actorType).toBe('teacher');
        expect(normal.studentIds).toEqual([]);
    });
});
