/**
 * 入口 Worker 的回退行为测试（node --test，不进主仓 jest 的用例集）
 *
 * 为什么要专门测它：Workers 的 fetch() 在源站 DNS 解析失败时**不抛异常**，而是返回一个
 * 边缘合成的 530。只看 catch 就会把它当「主源有响应」原样透传，回退分支永远走不到。
 * 这条是实测踩出来的，也是 NOT_DELIVERED_STATUS 存在的全部理由 —— 没测试钉着就会被改回去。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

/** 记录每次被请求的 host，并按脚本返回状态或抛错 */
function stubFetch(script) {
    const calls = [];
    globalThis.fetch = async (request, init) => {
        const url = new URL(request.url);
        const entry = { host: url.hostname, method: request.method, url: url.href };
        // 带 body 的方法把 body 读出来：重放时 body 是否还在，只有这里能证实
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            entry.body = await request.clone().text();
        }
        calls.push(entry);
        const behavior = script[url.hostname];
        if (!behavior) throw new Error(`测试没规定 ${url.hostname} 的行为`);
        if (behavior.throw) throw new Error('连接失败');
        // 204 这类状态不能带 body（undici 直接抛），所以 undefined 一律传 null
        return new Response(behavior.body ?? null, {
            status: behavior.status,
            headers: behavior.headers ?? {}
        });
    };
    return calls;
}

const ENV = { PRIMARY_ORIGIN: 'primary.test', FALLBACK_ORIGIN: 'fallback.test' };
const hit = (path = '/api/health', method = 'GET', body) =>
    new Request(`https://plenzo.cc.cd${path}`, { method, body, headers: { 'X-Marker': '1' } });

test('主源正常响应：原样透传，不打备源，也不贴 X-Served-By', async () => {
    const calls = stubFetch({ 'primary.test': { status: 200, body: 'ok', headers: { 'Set-Cookie': 'a=1' } } });
    const res = await worker.fetch(hit(), ENV);

    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.equal(res.headers.get('X-Served-By'), null);
    assert.deepEqual(calls.map(c => c.host), ['primary.test']);
});

test('主源返回应用自己的 5xx：不回退（请求已送达，重放可能重复写入）', async () => {
    const calls = stubFetch({ 'primary.test': { status: 500, body: '{"error":"boom"}' } });
    const res = await worker.fetch(hit('/api/schedules', 'POST', '{}'), ENV);

    assert.equal(res.status, 500);
    assert.equal(await res.text(), '{"error":"boom"}');
    assert.deepEqual(calls.map(c => c.host), ['primary.test'], '500 绝不能触发第二次转发');
});

test('主源 DNS 失败（边缘合成 530，不抛异常）：仍然回退并标记来源', async () => {
    const calls = stubFetch({
        'primary.test': { status: 530, body: 'origin down' },
        'fallback.test': { status: 200, body: 'served by vercel' }
    });
    const res = await worker.fetch(hit(), ENV);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Served-By'), 'vercel-fallback');
    assert.deepEqual(calls.map(c => c.host), ['primary.test', 'fallback.test']);
});

test('写请求回退时 body 必须完整重放（双 clone 的真实风险点）', async () => {
    const calls = stubFetch({
        'primary.test': { status: 522, body: '' },
        'fallback.test': { status: 200, body: 'created' }
    });
    const payload = JSON.stringify({ scheduleIds: [1001], fields: { location: '新课堂' } });
    const res = await worker.fetch(hit('/api/ai/query', 'POST', payload), ENV);

    assert.equal(await res.text(), 'created');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body, payload, '主源那次带 body');
    assert.equal(calls[1].body, payload, '备源重放的 body 不能是空 —— clone 用错就是这里');
});

test('主源连不上抛异常：同样回退', async () => {
    const calls = stubFetch({
        'primary.test': { throw: true },
        'fallback.test': { status: 204 }
    });
    const res = await worker.fetch(hit(), ENV);

    assert.equal(res.status, 204);
    assert.equal(res.headers.get('X-Served-By'), 'vercel-fallback');
});

test('两源都没送达：502 + Retry-After，不带上游信封', async () => {
    stubFetch({ 'primary.test': { throw: true }, 'fallback.test': { status: 530 } });
    const res = await worker.fetch(hit(), ENV);

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('X-Served-By'), 'none');
    assert.equal(res.headers.get('Retry-After'), '30');
});

test('origin 变量误填成带协议/路径的写法也能用', async () => {
    const calls = stubFetch({ 'primary.test': { status: 200, body: 'ok' } });
    const res = await worker.fetch(hit(), {
        PRIMARY_ORIGIN: 'https://primary.test/some/path',
        FALLBACK_ORIGIN: 'http://fallback.test'
    });

    assert.equal(res.status, 200);
    assert.equal(calls[0].url, 'https://primary.test/api/health');
});

test('520 / 524 这类可能已送达的状态不回退（刻意排除）', async () => {
    for (const status of [520, 524, 527]) {
        const calls = stubFetch({ 'primary.test': { status, body: 'maybe delivered' } });
        const res = await worker.fetch(hit('/api/ai/query', 'POST', '{}'), ENV);

        assert.equal(res.status, status, `${status} 应原样透传`);
        assert.deepEqual(calls.map(c => c.host), ['primary.test'], `${status} 触发回退就是重复写入风险`);
    }
});

// 超时用例已可注入：见下方 ROUTER_TIMEOUT_MS（P0-3 修复后 TIMEOUT_MS 不再是不可测的模块常量）

/**
 * 超时分类行为（审查报告 P0-3）。
 *
 * 修复前：catch 不区分错误类型，超时（AbortError）也返回 null → 走回退 → 写请求被
 * 重放到备源，而两源连的是同一个库、全站没有幂等键。Render 冷启动 + Neon 唤醒 +
 * 大跨度导出（实测仅工作簿生成 10000/20000 条就要 21s/29s）都能自然超过 10s。
 *
 * 这里的 hang 分支用真实 signal 触发 AbortError，测的是 setTimeout→abort→分类 的完整链路。
 */
function stubHosts(scripts) {
    const calls = [];
    globalThis.fetch = (request, init) => {
        const url = new URL(request.url);
        const host = url.hostname;
        const entry = { host, method: request.method };
        calls.push(entry);
        const behavior = scripts[host];
        if (!behavior) throw new Error(`测试没规定 ${host} 的行为`);

        if (behavior.hang) {
            return new Promise((_resolve, reject) => {
                const signal = init && init.signal;
                const abort = () => {
                    const err = new Error('This operation was aborted');
                    err.name = 'AbortError';
                    reject(err);
                };
                if (signal) {
                    if (signal.aborted) abort();
                    else signal.addEventListener('abort', abort);
                }
                // 永不 resolve：只能被超时中断
            });
        }
        if (behavior.throw) throw new Error('连接失败');
        return Promise.resolve(new Response(behavior.body ?? null, {
            status: behavior.status,
            headers: behavior.headers ?? {}
        }));
    };
    return calls;
}

const ENV_FAST_TIMEOUT = { ...ENV, ROUTER_TIMEOUT_MS: '5' };

test('写请求超时 → 504，绝不重放到备源', async () => {
    const calls = stubHosts({ 'primary.test': { hang: true }, 'fallback.test': { status: 200, body: 'replayed' } });
    const res = await worker.fetch(hit('/api/schedule', 'POST', '{"a":1}'), ENV_FAST_TIMEOUT);

    assert.equal(res.status, 504);
    assert.equal(res.headers.get('X-Served-By'), 'origin-timeout');
    const payload = await res.json();
    assert.equal(payload.error.code, 'UPSTREAM_TIMEOUT');
    assert.equal(payload.ok, false);
    assert.deepEqual(calls.map(c => c.host), ['primary.test'], '超时后出现备源调用就是重复写入');
});

test('PUT/PATCH/DELETE 超时同样不重放', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const calls = stubHosts({ 'primary.test': { hang: true }, 'fallback.test': { status: 200, body: 'x' } });
        const res = await worker.fetch(hit('/api/schedule/1', method, '{}'), ENV_FAST_TIMEOUT);
        assert.equal(res.status, 504, `${method} 超时应 504`);
        assert.equal(calls.length, 1, `${method} 超时不得二次转发`);
    }
});

test('GET 超时仍然回退：重复执行无害，可用性优先', async () => {
    const calls = stubHosts({ 'primary.test': { hang: true }, 'fallback.test': { status: 200, body: 'from vercel' } });
    const res = await worker.fetch(hit('/api/health'), ENV_FAST_TIMEOUT);

    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'from vercel');
    assert.equal(res.headers.get('X-Served-By'), 'vercel-fallback');
    assert.deepEqual(calls.map(c => c.host), ['primary.test', 'fallback.test']);
});

test('ROUTER_TIMEOUT_MS 非法值回落到默认 10s（不会立刻中断正常请求）', async () => {
    const calls = stubHosts({ 'primary.test': { status: 200, body: 'ok' } });
    const res = await worker.fetch(hit(), { ...ENV, ROUTER_TIMEOUT_MS: 'abc' });

    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
    assert.deepEqual(calls.map(c => c.host), ['primary.test']);
});

test('连接层失败（非超时）的写请求仍按原策略回退，且 body 完整', async () => {
    const calls = stubHosts({ 'primary.test': { status: 522, body: '' }, 'fallback.test': { status: 200, body: 'created' } });
    const payload = JSON.stringify({ location: '新课堂' });
    const res = await worker.fetch(hit('/api/schedule', 'POST', payload), ENV);

    assert.equal(await res.text(), 'created');
    assert.equal(calls.length, 2);
});
