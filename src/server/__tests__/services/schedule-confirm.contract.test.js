const courseSessionService = require('../../services/course-session-service');
const scheduleService = require('../../services/schedule-service');

jest.mock('../../services/course-session-service', () => ({
    getSessionById: jest.fn(),
    setTeacherStatus: jest.fn()
}));

jest.mock('../../db/db', () => ({
    query: jest.fn(),
    runInTransaction: jest.fn()
}));

jest.mock('../../utils/schema-helper', () => ({}));

jest.mock('../../utils/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn()
}));

describe('scheduleService.confirmSchedule', () => {
    const session = {
        id: 7,
        teachers: [{ uid: 'teacher-pair-1', teacher_id: 3, status: 'normal.pending' }]
    };

    beforeEach(() => {
        jest.clearAllMocks();
        courseSessionService.getSessionById.mockResolvedValue(session);
        courseSessionService.setTeacherStatus.mockResolvedValue({
            updated: true,
            status: 'normal.confirmed'
        });
    });

    test('returns domain data without a transport success flag', async () => {
        const result = await scheduleService.confirmSchedule('7', 'teacher-pair-1', 3, false);

        expect(result).toEqual({ status: 'normal.confirmed' });
        expect(result).not.toHaveProperty('success');
        expect(courseSessionService.setTeacherStatus).toHaveBeenCalledWith(
            '7',
            'teacher-pair-1',
            'confirmed',
            { id: 3, actorType: 'teacher' },
            undefined,
            session
        );
    });

    test.each([
        [null, 'RESOURCE_NOT_FOUND'],
        [{ ...session, teachers: [] }, 'RESOURCE_NOT_FOUND']
    ])('rejects a missing session or pair with a structured error', async (loadedSession, code) => {
        courseSessionService.getSessionById.mockResolvedValue(loadedSession);

        await expect(scheduleService.confirmSchedule('7', 'teacher-pair-1', 3, false))
            .rejects.toMatchObject({ name: 'AppError', code, statusCode: 404 });
    });

    test('rejects a different teacher with FORBIDDEN', async () => {
        await expect(scheduleService.confirmSchedule('7', 'teacher-pair-1', 8, false))
            .rejects.toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });

    test('propagates database failures unchanged', async () => {
        const dbError = new Error('connection failed');
        courseSessionService.getSessionById.mockRejectedValue(dbError);

        await expect(scheduleService.confirmSchedule('7', 'teacher-pair-1', 3, false))
            .rejects.toBe(dbError);
    });
});
