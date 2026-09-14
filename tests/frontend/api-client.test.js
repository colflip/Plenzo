const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadApiClient() {
    const source = fs.readFileSync(
        path.join(__dirname, '../../public/js/core/api-client.js'),
        'utf8'
    );
    const context = {
        window: {
            location: { pathname: '/admin/dashboard', href: '' },
            Toast: { show: jest.fn() }
        },
        localStorage: { removeItem: jest.fn() },
        sessionStorage: { removeItem: jest.fn() },
        navigator: { onLine: true },
        fetch: jest.fn(),
        Blob,
        FormData,
        URLSearchParams,
        AbortController,
        clearTimeout,
        console,
        setTimeout
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return context;
}

function response(body, options = {}) {
    const headers = new Map(Object.entries(options.headers || {}));
    return {
        ok: options.ok !== false,
        status: options.status || 200,
        url: options.url || '/api/test',
        headers: { get: key => headers.get(key) || null },
        text: jest.fn().mockResolvedValue(body === null ? '' : JSON.stringify(body)),
        blob: jest.fn().mockResolvedValue(options.blob || new Blob(['file']))
    };
}

describe('ApiUtils envelope client', () => {
    test('成功响应只读取一次并返回 data', async () => {
        const context = loadApiClient();
        const res = response({
            ok: true,
            data: { id: 1 },
            error: null,
            meta: { requestId: 'req-1', timestamp: 'now' }
        });
        context.fetch.mockResolvedValue(res);

        await expect(context.window.apiUtils.get('/users')).resolves.toEqual({ id: 1 });
        expect(res.text).toHaveBeenCalledTimes(1);
        expect(context.fetch).toHaveBeenCalledWith('/api/users', expect.objectContaining({
            method: 'GET',
            credentials: 'include'
        }));
    });

    test('失败 envelope 转换为完整 ApiError', async () => {
        const context = loadApiClient();
        context.fetch.mockResolvedValue(response({
            ok: false,
            data: null,
            error: {
                code: 'RATE_LIMITED',
                message: '请求过于频繁',
                details: [{ path: 'body.name', message: '名称无效' }],
                retryable: true,
                retryAfterSeconds: 12
            },
            meta: { requestId: 'req-rate', timestamp: 'now' }
        }, { ok: false, status: 429 }));

        await expect(context.window.apiUtils.getSilent('/limited')).rejects.toMatchObject({
            name: 'ApiError',
            code: 'RATE_LIMITED',
            status: 429,
            retryable: true,
            retryAfterSeconds: 12,
            requestId: 'req-rate',
            endpoint: '/api/limited'
        });
    });

    test('非法响应和网络错误使用稳定分类', async () => {
        const context = loadApiClient();
        const invalid = response(null, { status: 200 });
        context.fetch.mockResolvedValueOnce(invalid);
        await expect(context.window.apiUtils.getSilent('/invalid')).rejects.toMatchObject({
            code: 'INVALID_RESPONSE',
            status: 200
        });

        context.fetch.mockResolvedValueOnce(response({
            ok: false,
            data: null,
            error: {
                code: 'INTERNAL_ERROR',
                message: '服务暂时不可用'
            },
            meta: { requestId: 'req-invalid', timestamp: 'now' }
        }, { ok: false, status: 500 }));
        await expect(context.window.apiUtils.getSilent('/malformed-envelope')).rejects.toMatchObject({
            code: 'INVALID_RESPONSE',
            status: 500
        });

        context.fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        await expect(context.window.apiUtils.getSilent('/offline')).rejects.toMatchObject({
            code: 'NETWORK_ERROR',
            status: 0,
            retryable: true
        });
    });

    test('下载成功返回 Blob 和文件名，失败解析统一 envelope', async () => {
        const context = loadApiClient();
        const fileResponse = response(null, {
            headers: {
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'Content-Disposition': "attachment; filename*=UTF-8''%E8%AF%BE%E7%A8%8B.xlsx"
            }
        });
        context.fetch.mockResolvedValueOnce(fileResponse);

        await expect(context.window.apiUtils.requestDownload('/export', {
            method: 'POST',
            body: { type: 'schedule' },
            suppressErrorToast: true
        })).resolves.toMatchObject({
            filename: '课程.xlsx'
        });
        expect(fileResponse.blob).toHaveBeenCalledTimes(1);

        context.fetch.mockResolvedValueOnce(response({
            ok: false,
            data: null,
            error: {
                code: 'DB_UNAVAILABLE',
                message: '数据库暂时不可用',
                details: [],
                retryable: true,
                retryAfterSeconds: null
            },
            meta: { requestId: 'req-download', timestamp: 'now' }
        }, {
            ok: false,
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        }));

        await expect(context.window.apiUtils.requestDownload('/export', {
            suppressErrorToast: true
        })).rejects.toMatchObject({
            code: 'DB_UNAVAILABLE',
            requestId: 'req-download',
            status: 503
        });
    });

    test('请求超时转换为可重试的 ApiError', async () => {
        const context = loadApiClient();
        context.fetch.mockImplementationOnce((_, config) => new Promise((resolve, reject) => {
            config.signal.addEventListener('abort', () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
            });
        }));

        await expect(context.window.apiUtils.request('/slow', {
            timeoutMs: 1,
            suppressErrorToast: true
        })).rejects.toMatchObject({
            code: 'REQUEST_TIMEOUT',
            status: 0,
            retryable: true,
            endpoint: '/api/slow'
        });
    });

    test('只有认证错误码触发仪表盘重新登录', async () => {
        const context = loadApiClient();
        context.fetch.mockResolvedValueOnce(response({
            ok: false,
            data: null,
            error: {
                code: 'AUTH_EXPIRED',
                message: '登录状态已过期',
                details: [],
                retryable: false,
                retryAfterSeconds: null
            },
            meta: { requestId: 'req-auth', timestamp: 'now' }
        }, { ok: false, status: 401 }));

        await expect(context.window.apiUtils.getSilent('/profile')).rejects.toMatchObject({
            code: 'AUTH_EXPIRED'
        });
        expect(context.window.location.href).toBe('/index.html');
        expect(context.localStorage.removeItem).toHaveBeenCalledWith('authed');
    });
});
