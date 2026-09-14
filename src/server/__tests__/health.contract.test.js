jest.mock('../db/db', () => ({
    query: jest.fn()
}));

const db = require('../db/db');
const router = require('../routes/health');
const { mockRes } = require('./helpers/httpMocks');

function getHandler(path) {
    const layer = router.stack.find(item => item.route?.path === path);
    return layer.route.stack[0].handle;
}

describe('health probe contract', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test.each(['/', '/db', '/ready'])('%s returns only safe readiness fields when healthy', async path => {
        db.query.mockResolvedValue({ rows: [{ ok: 1 }] });
        const res = mockRes();

        await getHandler(path)({}, res);

        expect(res.statusCode).toBe(200);
        expect(Object.keys(res.body).sort()).toEqual(['checks', 'status', 'timestamp']);
        expect(res.body.checks).toEqual({ database: 'healthy' });
        expect(res.body).not.toHaveProperty('system');
        expect(res.body).not.toHaveProperty('dependencies');
        expect(res.body).not.toHaveProperty('uptime');
    });

    test.each(['/', '/db', '/ready'])('%s does not expose database errors when unhealthy', async path => {
        db.query.mockRejectedValue(Object.assign(new Error('secret database target'), {
            code: 'ECONNREFUSED'
        }));
        const res = mockRes();

        await getHandler(path)({}, res);

        expect(res.statusCode).toBe(503);
        expect(Object.keys(res.body).sort()).toEqual(['checks', 'status', 'timestamp']);
        expect(res.body.checks).toEqual({ database: 'unhealthy' });
        expect(JSON.stringify(res.body)).not.toContain('secret database target');
        expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    });

    test('/live does not query dependencies', () => {
        const res = mockRes();

        getHandler('/live')({}, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            status: 'alive',
            checks: { process: 'healthy' },
            timestamp: expect.any(String)
        });
        expect(db.query).not.toHaveBeenCalled();
    });
});
