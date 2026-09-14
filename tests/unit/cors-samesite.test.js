/**
 * corsOptions 的来源放行规则。
 *
 * 历史背景：早期生产/开发共用一套白名单，浏览器加载同站 ES module 时会带 Origin 头，
 * 运行端口（如 127.0.0.1:PORT）不在白名单被拦成 500，entry.js 无法加载、仪表盘不初始化。
 * 修复方式是加入「同站动态放行」，但该放行**只在非生产环境生效**：
 * corsOptions.credentials 为 true，生产环境放行任意 localhost 源等于允许本机任意页面/
 * 浏览器扩展发起带凭证的跨域请求。生产环境额外来源一律走 ALLOWED_ORIGINS。
 */
describe('corsOptions origin allowance', () => {
    const ORIGINAL_ENV = { ...process.env };

    function loadCorsOptions(nodeEnv) {
        jest.resetModules();
        process.env.NODE_ENV = nodeEnv;
        process.env.HOST = 'localhost';
        process.env.PORT = '3017';
        delete process.env.ALLOWED_ORIGINS;
        delete process.env.RAILWAY_STATIC_URL;
        const { corsOptions } = require('../../src/server/middleware/security');
        return corsOptions;
    }

    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
    });

    function callOrigin(corsOptions, origin) {
        return new Promise((resolve, reject) => {
            corsOptions.origin(origin, (err, allow) => {
                if (err) return reject(err);
                resolve(allow);
            });
        });
    }

    describe('production', () => {
        test('拒绝同站 127.0.0.1 + 运行端口（带凭证的本机来源不再放行）', async () => {
            const corsOptions = loadCorsOptions('production');
            await expect(callOrigin(corsOptions, 'http://127.0.0.1:3017'))
                .rejects.toThrow(/不允许的CORS请求/);
        });

        test('拒绝硬编码的本地开发端口（生产环境已收紧）', async () => {
            const corsOptions = loadCorsOptions('production');
            await expect(callOrigin(corsOptions, 'http://localhost:5173'))
                .rejects.toThrow(/不允许的CORS请求/);
        });

        test('放行内置生产域名', async () => {
            const corsOptions = loadCorsOptions('production');
            await expect(callOrigin(corsOptions, 'https://plenzo.vercel.app')).resolves.toBe(true);
        });

        test('放行 ALLOWED_ORIGINS 显式配置的来源', async () => {
            const corsOptions = loadCorsOptions('production');
            process.env.ALLOWED_ORIGINS = 'https://plenzo.example.com, http://127.0.0.1:3017';
            await expect(callOrigin(corsOptions, 'https://plenzo.example.com')).resolves.toBe(true);
            await expect(callOrigin(corsOptions, 'http://127.0.0.1:3017')).resolves.toBe(true);
        });

        test('无 Origin（同源导航/Postman）放行', async () => {
            const corsOptions = loadCorsOptions('production');
            await expect(callOrigin(corsOptions, undefined)).resolves.toBe(true);
        });

        test('跨域未知域名仍拒绝', async () => {
            const corsOptions = loadCorsOptions('production');
            await expect(callOrigin(corsOptions, 'https://evil.example.com'))
                .rejects.toThrow(/不允许的CORS请求/);
        });
    });

    describe('non-production', () => {
        test('放行同站 127.0.0.1 + 运行端口（修复前为 500 的根因）', async () => {
            const corsOptions = loadCorsOptions('test');
            await expect(callOrigin(corsOptions, 'http://127.0.0.1:3017')).resolves.toBe(true);
        });

        test('放行 localhost 任意端口（开发/本地预览常见）', async () => {
            const corsOptions = loadCorsOptions('test');
            await expect(callOrigin(corsOptions, 'http://localhost:5173')).resolves.toBe(true);
        });

        test('跨域未知域名仍拒绝', async () => {
            const corsOptions = loadCorsOptions('test');
            await expect(callOrigin(corsOptions, 'https://evil.example.com'))
                .rejects.toThrow(/不允许的CORS请求/);
        });
    });
});
