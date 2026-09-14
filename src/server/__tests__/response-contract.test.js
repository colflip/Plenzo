const Joi = require('joi');
const express = require('express');
const http = require('http');
const jwt = require('jsonwebtoken');
const { successResponse, errorResponse } = require('../utils/response');
const {
    AppError,
    errorHandler,
    notFoundHandler
} = require('../middleware/error');
const { validate } = require('../middleware/validation');
const { responseEnvelope } = require('../middleware/response-envelope');
const { requestContext } = require('../middleware/request-context');
const { authMiddleware, getTokenEpoch } = require('../middleware/auth');
const { requireOwnerOrAdmin, teacherOnly } = require('../middleware/role');
const { createRateLimitHandler } = require('../middleware/rate-limit');
const { mockRes } = require('./helpers/httpMocks');

describe('统一响应契约', () => {
    test('成功和失败响应保持相同顶层字段', () => {
        const success = successResponse({ id: 1 }, { requestId: 'req-1' });
        const failure = errorResponse({
            code: 'VALIDATION_FAILED',
            message: '输入有误',
            details: [],
            retryable: false,
            retryAfterSeconds: null
        }, { requestId: 'req-2' });

        expect(Object.keys(success)).toEqual(['ok', 'data', 'error', 'meta']);
        expect(Object.keys(failure)).toEqual(['ok', 'data', 'error', 'meta']);
        expect(success).toMatchObject({ ok: true, data: { id: 1 }, error: null });
        expect(failure).toMatchObject({
            ok: false,
            data: null,
            error: { code: 'VALIDATION_FAILED', details: [] }
        });
        expect(success.meta.requestId).toBe('req-1');
        expect(failure.meta.requestId).toBe('req-2');
        expect(success).not.toHaveProperty('success');
        expect(failure).not.toHaveProperty('message');
    });

    test('HTTP 护栏拒绝非统一响应对象', () => {
        const res = mockRes();
        responseEnvelope({ requestId: 'req-invalid' }, res, jest.fn());

        expect(() => res.json({ success: true, users: [] })).toThrow('普通 JSON API 必须返回统一响应 envelope');
        expect(res.body).toBeUndefined();
    });

    test('HTTP 护栏为未设置状态的失败响应补充非 2xx 状态', () => {
        const modernRes = mockRes();
        responseEnvelope({ requestId: 'req-modern' }, modernRes, jest.fn());
        modernRes.json(errorResponse({
            code: 'VALIDATION_FAILED',
            message: '输入有误',
            details: [],
            retryable: false,
            retryAfterSeconds: null
        }));
        expect(modernRes.statusCode).toBe(422);

        const invalidRes = mockRes();
        responseEnvelope({ requestId: 'req-invalid-status' }, invalidRes, jest.fn());
        expect(() => invalidRes.json({ success: false, message: '请求失败' }))
            .toThrow('普通 JSON API 必须返回统一响应 envelope');
    });
});

describe('横切中间件错误契约', () => {
    test('request ID 接受安全入站值并拒绝非法值', () => {
        const acceptedReq = { get: jest.fn(() => 'request.safe-1') };
        const acceptedRes = mockRes();
        const acceptedNext = jest.fn();
        requestContext(acceptedReq, acceptedRes, acceptedNext);
        expect(acceptedReq.requestId).toBe('request.safe-1');
        expect(acceptedRes.set).toHaveBeenCalledWith('X-Request-Id', 'request.safe-1');
        expect(acceptedNext).toHaveBeenCalledTimes(1);

        const rejectedReq = { get: jest.fn(() => 'bad request id') };
        requestContext(rejectedReq, mockRes(), jest.fn());
        expect(rejectedReq.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(rejectedReq.requestId).not.toBe('bad request id');
    });

    test('认证中间件区分缺少、过期和纪元失效的凭据', async () => {
        const noTokenNext = jest.fn();
        await authMiddleware({ headers: {} }, mockRes(), noTokenNext);
        expect(noTokenNext.mock.calls[0][0]).toMatchObject({ code: 'AUTH_REQUIRED', statusCode: 401 });

        const jwt = require('jsonwebtoken');
        const verifySpy = jest.spyOn(jwt, 'verify');
        verifySpy.mockImplementationOnce(() => {
            const error = new Error('expired');
            error.name = 'TokenExpiredError';
            throw error;
        });
        const expiredNext = jest.fn();
        await authMiddleware({ headers: { authorization: 'Bearer expired-token' } }, mockRes(), expiredNext);
        expect(expiredNext.mock.calls[0][0]).toMatchObject({ code: 'AUTH_EXPIRED', statusCode: 401 });

        verifySpy.mockReturnValueOnce({ id: 1, userType: 'admin', tv: getTokenEpoch() + 1 });
        const staleNext = jest.fn();
        await authMiddleware({ headers: { authorization: 'Bearer stale-token' } }, mockRes(), staleNext);
        expect(staleNext.mock.calls[0][0]).toMatchObject({ code: 'SESSION_EPOCH_MISMATCH', statusCode: 401 });
        verifySpy.mockRestore();
    });

    test('所有权查询异常继续传播而不是伪装为权限不足', async () => {
        const dbError = new Error('owner lookup failed');
        const middleware = requireOwnerOrAdmin(async () => { throw dbError; });
        const next = jest.fn();
        await middleware({ user: { id: 2, userType: 'teacher' } }, mockRes(), next);
        expect(next).toHaveBeenCalledWith(dbError);
    });

    test('非 API JSON 页也用明确认证错误而不是返回伪造零数据', async () => {
        const app = express();
        app.use(requestContext);
        app.get('/private-json', authMiddleware, teacherOnly, (req, res) => {
            res.json({ total: 0 });
        });
        app.use(errorHandler);
        const server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        try {
            const response = await new Promise((resolve, reject) => {
                const req = http.request({
                    host: '127.0.0.1',
                    port: server.address().port,
                    path: '/private-json',
                    headers: { 'X-Request-Id': 'private-json-auth' }
                }, res => {
                    const chunks = [];
                    res.on('data', chunk => chunks.push(chunk));
                    res.on('end', () => resolve({
                        statusCode: res.statusCode,
                        body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    }));
                });
                req.on('error', reject);
                req.end();
            });
            expect(response.statusCode).toBe(401);
            expect(response.body).toMatchObject({
                ok: false,
                data: null,
                error: { code: 'AUTH_REQUIRED' },
                meta: { requestId: 'private-json-auth' }
            });
            expect(response.body).not.toHaveProperty('total');
        } finally {
            await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        }
    });

    test('角色中间件拒绝有效的非教师令牌', async () => {
        const token = jwt.sign(
            { id: 1, userType: 'student', tv: getTokenEpoch() },
            process.env.JWT_SECRET,
            { algorithm: 'HS256' }
        );
        const req = { headers: { authorization: `Bearer ${token}` } };
        const authNext = jest.fn();
        await authMiddleware(req, mockRes(), authNext);
        expect(authNext).toHaveBeenCalledWith();

        const roleNext = jest.fn();
        teacherOnly(req, mockRes(), roleNext);
        expect(roleNext.mock.calls[0][0]).toMatchObject({ code: 'FORBIDDEN', statusCode: 403 });
    });

    test('限流响应包含统一 envelope 与 Retry-After', () => {
        const req = {
            requestId: 'req-rate',
            rateLimit: { resetTime: new Date(Date.now() + 5000) }
        };
        const res = mockRes();
        createRateLimitHandler(60)(req, res, jest.fn(), {
            statusCode: 429,
            message: '请求过于频繁'
        });
        expect(res.statusCode).toBe(429);
        expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
        expect(res.body).toMatchObject({
            ok: false,
            error: {
                code: 'RATE_LIMITED',
                retryable: true,
                retryAfterSeconds: expect.any(Number)
            },
            meta: { requestId: 'req-rate' }
        });
    });
});

describe('AppError 与全局错误出口', () => {
    test('支持对象参数并保留旧位置参数调用的语义', () => {
        const modern = new AppError({ code: 'DB_UNAVAILABLE' });
        const legacy = new AppError('没有权限', 403);
        expect(modern).toMatchObject({ code: 'DB_UNAVAILABLE', statusCode: 503, retryable: true });
        expect(legacy).toMatchObject({ code: 'FORBIDDEN', statusCode: 403, message: '没有权限' });
    });

    test('未知错误不向客户端泄露内部消息', () => {
        const req = { requestId: 'req-500' };
        const res = mockRes();
        errorHandler(new Error('SQL SELECT secret'), req, res, jest.fn());
        expect(res.statusCode).toBe(500);
        expect(res.body.error).toMatchObject({ code: 'INTERNAL_ERROR' });
        expect(JSON.stringify(res.body)).not.toContain('SQL SELECT secret');
        expect(res.body.meta.requestId).toBe('req-500');
    });

    test('数据库不可用映射为可重试 503', () => {
        const req = { requestId: 'req-db' };
        const res = mockRes();
        const error = Object.assign(new Error('connect failed'), { code: 'DB_UNAVAILABLE' });
        errorHandler(error, req, res, jest.fn());
        expect(res.statusCode).toBe(503);
        expect(res.body.error).toMatchObject({ code: 'DB_UNAVAILABLE', retryable: true });
    });

    test('请求体解析、体积和 SQLSTATE 错误映射为安全响应', () => {
        const malformedRes = mockRes();
        errorHandler(
            Object.assign(new SyntaxError('Unexpected token with raw body'), { type: 'entity.parse.failed' }),
            { requestId: 'req-json' },
            malformedRes,
            jest.fn()
        );
        expect(malformedRes.statusCode).toBe(400);
        expect(malformedRes.body.error).toMatchObject({
            code: 'BAD_REQUEST',
            message: '请求内容不是有效的 JSON'
        });

        const tooLargeRes = mockRes();
        errorHandler(
            Object.assign(new Error('request entity too large'), { type: 'entity.too.large' }),
            { requestId: 'req-large' },
            tooLargeRes,
            jest.fn()
        );
        expect(tooLargeRes.statusCode).toBe(413);
        expect(tooLargeRes.body.error.code).toBe('PAYLOAD_TOO_LARGE');

        const duplicateRes = mockRes();
        errorHandler(
            Object.assign(new Error('duplicate key detail'), { code: '23505' }),
            { requestId: 'req-sql' },
            duplicateRes,
            jest.fn()
        );
        expect(duplicateRes.statusCode).toBe(409);
        expect(duplicateRes.body.error).toMatchObject({ code: 'CONFLICT' });
        expect(JSON.stringify(duplicateRes.body)).not.toContain('duplicate key detail');
    });

    test('API 404 返回标准错误 envelope', () => {
        const req = { path: '/api/missing', requestId: 'req-404' };
        const res = mockRes();
        notFoundHandler(req, res, jest.fn());
        expect(res.statusCode).toBe(404);
        expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
        expect(res.body.meta.requestId).toBe('req-404');
    });
});

describe('验证中间件', () => {
    test('Joi 失败交给全局出口并提供带来源的字段路径', () => {
        const middleware = validate(Joi.object({ email: Joi.string().email().required() }));
        const req = { body: { email: 'bad' } };
        const next = jest.fn();
        middleware(req, mockRes(), next);
        expect(next).toHaveBeenCalledTimes(1);
        expect(next.mock.calls[0][0]).toMatchObject({
            code: 'VALIDATION_FAILED',
            statusCode: 422,
            details: [expect.objectContaining({ path: 'body.email' })]
        });
    });
});
