const db = require('../../db/db');
const headTeacherService = require('../../services/head-teacher-service');
const { AppError } = require('../../middleware/error');

jest.mock('../../db/db', () => ({ query: jest.fn() }));

beforeEach(() => {
    jest.clearAllMocks();
    db.query.mockResolvedValue({ rows: [{ id: 1 }] });
});

describe('getAssociatedStudents', () => {
    test('有日期时返回本人授课的去重学生', async () => {
        const students = [{ id: 9, name: 'S9' }];
        db.query.mockResolvedValue({ rows: students });

        await expect(headTeacherService.getAssociatedStudents({
            user: { id: 7 },
            query: { startDate: '2026-01-01', endDate: '2026-02-01' }
        })).resolves.toEqual(students);
        expect(db.query.mock.calls[0][0]).toContain('cs.teacher_ids');
    });

    test('无日期时返回绑定学生', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ student_ids: '1,2' }] })
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'A' }] });

        await expect(headTeacherService.getAssociatedStudents({
            user: { id: 7 },
            query: {}
        })).resolves.toEqual([{ id: 1, name: 'A' }]);
    });

    test('教师不存在时抛 RESOURCE_NOT_FOUND', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await expect(headTeacherService.getAssociatedStudents({
            user: { id: 7 },
            query: {}
        })).rejects.toMatchObject({
            code: 'RESOURCE_NOT_FOUND',
            statusCode: 404
        });
    });

    test('无绑定时返回空数组', async () => {
        db.query.mockResolvedValue({ rows: [{ student_ids: '' }] });

        await expect(headTeacherService.getAssociatedStudents({
            user: { id: 7 },
            query: {}
        })).resolves.toEqual([]);
    });

    test('数据库异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);

        await expect(headTeacherService.getAssociatedStudents({
            user: { id: 7 },
            query: { startDate: '2026-01-01', endDate: '2026-02-01' }
        })).rejects.toBe(error);
    });
});

describe('getAssociatedStudents scope=homeroom', () => {
    test('按绑定学生与日期取交集，不按授课教师过滤', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ student_ids: '11,12' }] })
            .mockResolvedValueOnce({ rows: [{ id: 11, name: 'A' }] });

        const students = await headTeacherService.getAssociatedStudents({
            user: { id: 7 },
            query: {
                startDate: '2026-01-01',
                endDate: '2026-02-01',
                scope: 'homeroom'
            }
        });

        expect(students).toEqual([{ id: 11, name: 'A' }]);
        const [sql, params] = db.query.mock.calls[1];
        expect(sql).toContain('cs.student_ids && $1::int[]');
        expect(sql).not.toContain('teacher_ids');
        expect(params).toEqual([[11, 12], '2026-01-01', '2026-02-01']);
    });

    test('无日期时返回所有绑定学生', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ student_ids: '11,12' }] })
            .mockResolvedValueOnce({ rows: [{ id: 11, name: 'A' }] });

        await expect(headTeacherService.getAssociatedStudents({
            user: { id: 7 },
            query: { scope: 'homeroom' }
        })).resolves.toEqual([{ id: 11, name: 'A' }]);
    });

    test('无绑定时不再查询排课', async () => {
        db.query.mockResolvedValueOnce({ rows: [{ student_ids: '' }] });

        await expect(headTeacherService.getAssociatedStudents({
            user: { id: 7 },
            query: {
                startDate: '2026-01-01',
                endDate: '2026-02-01',
                scope: 'homeroom'
            }
        })).resolves.toEqual([]);
        expect(db.query).toHaveBeenCalledTimes(1);
    });
});

describe('getAssociatedStudentsDetail', () => {
    test('返回绑定学生详情', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ student_ids: '1,2' }] })
            .mockResolvedValueOnce({ rows: [{ id: 1, name: 'A' }] });

        await expect(headTeacherService.getAssociatedStudentsDetail({
            user: { id: 7 }
        })).resolves.toEqual([{ id: 1, name: 'A' }]);
    });

    test('教师不存在时抛 404', async () => {
        db.query.mockResolvedValue({ rows: [] });

        await expect(headTeacherService.getAssociatedStudentsDetail({
            user: { id: 7 }
        })).rejects.toBeInstanceOf(AppError);
    });

    test('无绑定时返回空数组', async () => {
        db.query.mockResolvedValue({ rows: [{ student_ids: '' }] });

        await expect(headTeacherService.getAssociatedStudentsDetail({
            user: { id: 7 }
        })).resolves.toEqual([]);
    });
});

describe('updateAssociatedStudent', () => {
    const request = (overrides = {}) => ({
        user: { id: 7 },
        params: { id: '5' },
        body: {},
        ...overrides
    });

    test.each([
        [request({ params: {} }), 'BAD_REQUEST', 400],
        [request({ body: { status: '5' } }), 'BAD_REQUEST', 400]
    ])('非法输入抛结构化错误', async (req, code, statusCode) => {
        if (req.params.id) {
            db.query.mockResolvedValueOnce({ rows: [{ student_ids: '5' }] });
        }
        await expect(headTeacherService.updateAssociatedStudent(req))
            .rejects.toMatchObject({ code, statusCode });
    });

    test('非绑定学生时抛 FORBIDDEN', async () => {
        db.query.mockResolvedValue({ rows: [{ student_ids: '7,8' }] });

        await expect(headTeacherService.updateAssociatedStudent(request()))
            .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });

    test('成功时返回更新后的学生', async () => {
        const student = { id: 5, name: 'A', status: 1 };
        db.query
            .mockResolvedValueOnce({ rows: [{ student_ids: '5' }] })
            .mockResolvedValueOnce({ rows: [student] });

        await expect(headTeacherService.updateAssociatedStudent(request({
            body: { name: 'A', profession: 'p', status: 1 }
        }))).resolves.toEqual(student);
    });

    test('更新目标不存在时抛 404', async () => {
        db.query
            .mockResolvedValueOnce({ rows: [{ student_ids: '5' }] })
            .mockResolvedValueOnce({ rows: [] });

        await expect(headTeacherService.updateAssociatedStudent(request()))
            .rejects.toMatchObject({
                code: 'RESOURCE_NOT_FOUND',
                statusCode: 404
            });
    });
});

describe('getAllTeachers', () => {
    test('返回未删除教师列表', async () => {
        const teachers = [{ id: 1, name: 'T1' }];
        db.query.mockResolvedValue({ rows: teachers });

        await expect(headTeacherService.getAllTeachers()).resolves.toEqual(teachers);
    });

    test('数据库异常原样传播', async () => {
        const error = new Error('boom');
        db.query.mockRejectedValue(error);

        await expect(headTeacherService.getAllTeachers()).rejects.toBe(error);
    });
});
