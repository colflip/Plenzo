const http = require('http');
const jwt = require('jsonwebtoken');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-at-least-32-characters';

const { getTokenEpoch } = require('../middleware/auth');
const db = require('../db/db');
const rewardCalc = require('../services/reward-calc');
const app = require('../app');

function request(server, path, options = {}) {
    const address = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: address.port,
            path,
            method: options.method || 'GET',
            headers: options.headers || {}
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8');
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body,
                    json: body ? JSON.parse(body) : null
                });
            });
        });
        req.on('error', reject);
        if (options.body) req.write(options.body);
        req.end();
    });
}

describe('Express app contract', () => {
    let server;

    beforeAll(async () => {
        server = http.createServer(app);
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
    });

    afterAll(async () => {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    });

    test('health live probe keeps its documented minimal protocol', async () => {
        const response = await request(server, '/api/health/live');

        expect(response.status).toBe(200);
        expect(response.json).toEqual({
            status: 'alive',
            checks: { process: 'healthy' },
            timestamp: expect.any(String)
        });
        expect(response.json).not.toHaveProperty('ok');
    });

    test('unknown API route returns canonical error and request ID header', async () => {
        const response = await request(server, '/api/does-not-exist', {
            headers: { 'X-Request-Id': 'app-contract-404' }
        });

        expect(response.status).toBe(404);
        expect(response.headers['x-request-id']).toBe('app-contract-404');
        expect(response.json).toMatchObject({
            ok: false,
            data: null,
            error: {
                code: 'ROUTE_NOT_FOUND',
                details: [],
                retryable: false,
                retryAfterSeconds: null
            },
            meta: { requestId: 'app-contract-404' }
        });
    });

    test('malformed JSON uses the canonical safe parser error', async () => {
        const response = await request(server, '/api/auth/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': '1',
                'X-Request-Id': 'app-contract-json'
            },
            body: '{'
        });

        expect(response.status).toBe(400);
        expect(response.json).toMatchObject({
            ok: false,
            data: null,
            error: {
                code: 'BAD_REQUEST',
                message: '请求内容不是有效的 JSON'
            },
            meta: { requestId: 'app-contract-json' }
        });
        expect(response.body).not.toContain('SyntaxError');
    });

    test('protected route failure is canonical rather than a legacy message', async () => {
        const response = await request(server, '/api/student/profile', {
            headers: { 'X-Request-Id': 'app-contract-auth' }
        });

        expect(response.status).toBe(401);
        expect(response.json).toMatchObject({
            ok: false,
            error: { code: 'AUTH_REQUIRED' },
            meta: { requestId: 'app-contract-auth' }
        });
        expect(response.json).not.toHaveProperty('message');
        expect(response.json).not.toHaveProperty('success');
    });

    test('hidden reward route rejects unauthenticated navigation instead of returning zero data', async () => {
        const response = await request(server, '/teacher/dashboard/teaching-display/goodluck', {
            headers: { 'X-Request-Id': 'reward-auth-required' }
        });

        expect(response.status).toBe(401);
        expect(response.json).toMatchObject({
            ok: false,
            data: null,
            error: { code: 'AUTH_REQUIRED' },
            meta: { requestId: 'reward-auth-required' }
        });
        expect(response.json).not.toHaveProperty('aggregated');
        expect(response.json).not.toHaveProperty('total');
    });

    test('hidden reward route rejects non-teachers instead of returning zero data', async () => {
        const token = jwt.sign(
            { id: 1, userType: 'student', tv: getTokenEpoch() },
            process.env.JWT_SECRET,
            { algorithm: 'HS256' }
        );
        const response = await request(server, '/teacher/dashboard/teaching-display/goodluck', {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Request-Id': 'reward-forbidden'
            }
        });

        expect(response.status).toBe(403);
        expect(response.json).toMatchObject({
            ok: false,
            data: null,
            error: { code: 'FORBIDDEN' },
            meta: { requestId: 'reward-forbidden' }
        });
        expect(response.json).not.toHaveProperty('aggregated');
    });

    test('hidden reward route propagates data failures instead of returning zero data', async () => {
        const token = jwt.sign(
            { id: 7, userType: 'teacher', tv: getTokenEpoch() },
            process.env.JWT_SECRET,
            { algorithm: 'HS256' }
        );
        const dbError = Object.assign(new Error('database unavailable'), { code: '08006' });
        const dbSpy = jest.spyOn(db, 'query').mockRejectedValueOnce(dbError);
        const rewardSpy = jest.spyOn(rewardCalc, 'getRewardPayload').mockResolvedValueOnce({
            basic_info: { name: '' },
            aggregated: {},
            type_stats: {},
            breakdown: [],
            total: 0
        });

        const response = await request(server, '/teacher/dashboard/teaching-display/goodluck', {
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Request-Id': 'reward-db-failure'
            }
        });

        expect(response.status).toBe(503);
        expect(response.json).toMatchObject({
            ok: false,
            data: null,
            error: { code: 'DB_UNAVAILABLE', retryable: true },
            meta: { requestId: 'reward-db-failure' }
        });
        expect(response.json).not.toHaveProperty('aggregated');
        dbSpy.mockRestore();
        rewardSpy.mockRestore();
    });
});
