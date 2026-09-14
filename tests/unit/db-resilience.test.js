/**
 * 数据库连接层韧性：错误归因与熔断。
 *
 * 背景：DB 不可达时启动日志曾刷出上百行 "TypeError: fetch failed"，既看不出根因，
 * 也会把首个真实错误挤到看不见。这两个能力是那次修复的核心，必须锁住行为。
 */
const path = require('path');

const DB_PATH = path.join(__dirname, '../../src/server/db/db.js');

describe('db 连接层：错误归因', () => {
    let describeError;

    beforeAll(() => {
        describeError = require(DB_PATH).describeError;
    });

    test('展开 undici 的 cause 链（fetch failed → ECONNRESET）', () => {
        const root = new Error('Client network socket disconnected before secure TLS connection was established');
        root.code = 'ECONNRESET';
        const fetchErr = new TypeError('fetch failed');
        fetchErr.cause = root;

        const text = describeError(fetchErr);
        expect(text).toContain('fetch failed');
        expect(text).toContain('ECONNRESET');
    });

    test('展开 Neon 的 sourceError（真实原因不在 message 里）', () => {
        const root = new Error('fetch failed');
        root.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
        const neonErr = new Error('Error connecting to database: TypeError: fetch failed');
        neonErr.sourceError = root;

        const text = describeError(neonErr);
        expect(text).toContain('Error connecting to database');
        expect(text).toContain('ENOTFOUND');
    });

    test('无 cause 时只返回 message，不产生空串或 undefined', () => {
        expect(describeError(new Error('boom'))).toBe('boom');
        expect(describeError(null)).toBe('未知错误');
    });

    test('循环 cause 不会死循环', () => {
        const a = new Error('a');
        const b = new Error('b');
        a.cause = b;
        b.cause = a;
        expect(() => describeError(a)).not.toThrow();
    });
});

describe('db 连接层：熔断', () => {
    test('导出 ping / getStatus 供启动门控使用', () => {
        const db = require(DB_PATH);
        expect(typeof db.ping).toBe('function');
        expect(typeof db.getStatus).toBe('function');
        const status = db.getStatus();
        expect(status).toHaveProperty('driver');
        expect(status).toHaveProperty('host');
        expect(status).toHaveProperty('breakerOpen');
    });

    test('启动探测失败可主动开路（forceOpenBreaker）', () => {
        const db = require(DB_PATH);
        const { noteConnectionSuccess, shouldFastFail } = db.__testables;

        jest.useFakeTimers();
        try {
            jest.setSystemTime(100000);
            noteConnectionSuccess();
            expect(shouldFastFail()).toBe(false);

            db.forceOpenBreaker(new Error('fetch failed'));
            expect(shouldFastFail()).toBe(true);
            expect(db.getStatus().breakerOpen).toBe(true);

            noteConnectionSuccess();
            expect(shouldFastFail()).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('连续 3 次连接错误后快速失败，半开期放行一条探测，冷却结束恢复', () => {
        const { noteConnectionFailure, noteConnectionSuccess, shouldFastFail } = require(DB_PATH).__testables;
        const connErr = () => new Error('fetch failed');

        jest.useFakeTimers();
        try {
            jest.setSystemTime(0);
            noteConnectionSuccess();

            noteConnectionFailure(connErr());
            noteConnectionFailure(connErr());
            expect(shouldFastFail()).toBe(false);

            noteConnectionFailure(connErr());
            expect(shouldFastFail()).toBe(true);

            // 半开：5s 后放行一条探测，但同一时刻只放行一条
            jest.setSystemTime(6000);
            expect(shouldFastFail()).toBe(false);
            expect(shouldFastFail()).toBe(true);

            // 冷却结束（15s）：熔断关闭，请求全部放行
            jest.setSystemTime(16000);
            expect(shouldFastFail()).toBe(false);
            expect(shouldFastFail()).toBe(false);

            noteConnectionSuccess();
        } finally {
            jest.useRealTimers();
        }
    });
});
