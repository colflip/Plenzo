const headTeacherService = require('../../services/head-teacher-service');
const teacherController = require('../../controllers/teacher-controller');
const { mockReq, mockRes } = require('../helpers/httpMocks');

jest.mock('../../services/head-teacher-service', () => ({
    getAssociatedStudents: jest.fn(),
    getAssociatedStudentsDetail: jest.fn(),
    updateAssociatedStudent: jest.fn(),
    getAllTeachers: jest.fn()
}));

function expectCanonicalSuccess(res, data) {
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
        ok: true,
        data,
        error: null,
        meta: {
            requestId: 'req-head-teacher',
            timestamp: expect.any(String)
        }
    });
    expect(res.body).not.toHaveProperty('success');
    expect(res.body).not.toHaveProperty('message');
}

beforeEach(() => {
    jest.clearAllMocks();
});

// service 层（D1）只返回领域数据，控制器负责包成对外信封；mock 直接给领域数据。
describe('teacherController head-teacher endpoints', () => {
    test.each([
        ['getAssociatedStudents', 'getAssociatedStudents', [{ id: 1, name: 'A' }]],
        ['getAssociatedStudentsDetail', 'getAssociatedStudentsDetail', [{ id: 1, name: 'A', status: 1 }]],
        ['updateAssociatedStudent', 'updateAssociatedStudent', { id: 1, name: 'A' }],
        ['getAllTeachers', 'getAllTeachers', [{ id: 7, name: 'T' }]]
    ])('%s 返回 canonical success envelope', async (handlerName, serviceName, data) => {
        headTeacherService[serviceName].mockResolvedValue(data);
        const req = mockReq({ requestId: 'req-head-teacher' });
        const res = mockRes();

        await teacherController[handlerName](req, res);

        expectCanonicalSuccess(res, data);
    });

    test('service rejection 由 controller 原样传播', async () => {
        const error = new Error('db failed');
        headTeacherService.getAssociatedStudents.mockRejectedValue(error);

        await expect(teacherController.getAssociatedStudents(
            mockReq({ requestId: 'req-head-teacher' }),
            mockRes()
        )).rejects.toBe(error);
    });
});
