const { ExportError, handleExportError } = require('../../middleware/export-error-handler');
const logger = require('../../utils/logger');

describe('ExportError', () => {
    test('将状态码映射为稳定 machine code，并保留导出子码', () => {
        const error = new ExportError('没有可导出的数据', 404, 'EXPORT_NO_DATA');

        expect(error.message).toBe('没有可导出的数据');
        expect(error.statusCode).toBe(404);
        expect(error.code).toBe('RESOURCE_NOT_FOUND');
        expect(error.details).toEqual([{ exportCode: 'EXPORT_NO_DATA' }]);
        expect(error.exportCode).toBe('EXPORT_NO_DATA');
        expect(error.name).toBe('ExportError');
    });

    test('默认使用 500 INTERNAL_ERROR', () => {
        const error = new ExportError('导出失败');

        expect(error.statusCode).toBe(500);
        expect(error.code).toBe('INTERNAL_ERROR');
        expect(error.details).toEqual([{ exportCode: 'EXPORT_ERROR' }]);
        expect(error).toBeInstanceOf(Error);
    });
});

describe('handleExportError', () => {
    let req;
    let res;
    let loggerSpy;

    beforeEach(() => {
        req = {
            requestId: 'req-export-1',
            user: { id: 123, userType: 'teacher' },
            query: { startDate: '2024-06-01', endDate: '2024-06-30' }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
            set: jest.fn()
        };
        loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        loggerSpy.mockRestore();
    });

    test('ExportError 返回 canonical failure envelope', () => {
        const error = new ExportError('需要有效的日期范围', 400, 'EXPORT_INVALID_DATE');

        handleExportError(error, req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            ok: false,
            data: null,
            error: {
                code: 'BAD_REQUEST',
                message: '需要有效的日期范围',
                details: [{ exportCode: 'EXPORT_INVALID_DATE' }],
                retryable: false,
                retryAfterSeconds: null
            },
            meta: {
                requestId: 'req-export-1',
                timestamp: expect.any(String)
            }
        });
    });

    test('普通未知错误不再根据中文文案猜状态码', () => {
        handleExportError(new Error('查询无数据'), req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            ok: false,
            data: null,
            error: expect.objectContaining({
                code: 'INTERNAL_ERROR',
                message: '服务暂时不可用，请稍后重试'
            })
        }));
    });

    test('保留结构化 AppError 的状态和 retry 信息', () => {
        const error = new ExportError('导出服务暂不可用', 503, 'EXPORT_SERVICE_UNAVAILABLE');

        handleExportError(error, req, res);

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: expect.objectContaining({
                code: 'SERVICE_UNAVAILABLE',
                retryable: true
            })
        }));
    });

    test('日志包含身份、request ID 与 machine code', () => {
        const error = new ExportError('测试错误', 400, 'EXPORT_BAD_REQUEST');

        handleExportError(error, req, res);

        expect(loggerSpy).toHaveBeenCalledWith(
            '[Export Error] [teacher:123] 测试错误',
            expect.objectContaining({
                requestId: 'req-export-1',
                code: 'BAD_REQUEST',
                error: '测试错误',
                query: req.query,
                timestamp: expect.any(String)
            })
        );
    });

    test('缺少用户信息时安全记录 unknown', () => {
        req.user = undefined;

        handleExportError(new Error('测试错误'), req, res);

        expect(loggerSpy).toHaveBeenCalledWith(
            '[Export Error] [unknown:unknown] 测试错误',
            expect.any(Object)
        );
    });

    test('development 日志包含 stack，production 不包含', () => {
        const originalEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'development';
        handleExportError(new Error('开发错误'), req, res);
        expect(loggerSpy).toHaveBeenLastCalledWith(
            expect.any(String),
            expect.objectContaining({ stack: expect.any(String) })
        );

        process.env.NODE_ENV = 'production';
        handleExportError(new Error('生产错误'), req, res);
        expect(loggerSpy).toHaveBeenLastCalledWith(
            expect.any(String),
            expect.objectContaining({ stack: undefined })
        );
        process.env.NODE_ENV = originalEnv;
    });
});
