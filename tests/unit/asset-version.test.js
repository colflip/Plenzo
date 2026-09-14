/**
 * 静态资源版本化纯函数测试（node 环境，无外部依赖）。
 * 覆盖：本地引用加版本、外链跳过、已带版本幂等替换、空版本原样返回。
 */
const { injectAssetVersion } = require('../../src/server/utils/asset-version');

describe('injectAssetVersion', () => {
    test('为本地 /js、/css 引用注入 ?v= 版本参数', () => {
        const html = [
            '<script src="/js/core/event-bus.js"></script>',
            '<link rel="stylesheet" href="/css/dashboard.css">',
            '<script type="module" src="/js/modules/admin/index.js"></script>'
        ].join('\n');

        const out = injectAssetVersion(html, 'abc1234');

        expect(out).toContain('src="/js/core/event-bus.js?v=abc1234"');
        expect(out).toContain('href="/css/dashboard.css?v=abc1234"');
        expect(out).toContain('src="/js/modules/admin/index.js?v=abc1234"');
    });

    test('跳过协议绝对路径与外链 CDN', () => {
        const html = [
            '<script src="https://cdn.example.com/lib.js"></script>',
            '<link rel="stylesheet" href="//cdn.example.com/a.css">',
            '<script src="/js/app.js"></script>'
        ].join('\n');

        const out = injectAssetVersion(html, 'v9');

        expect(out).toContain('src="https://cdn.example.com/lib.js"');
        expect(out).toContain('href="//cdn.example.com/a.css"');
        expect(out).toContain('src="/js/app.js?v=v9"');
    });

    test('已带 ?v= 的引用幂等替换为新版本（不叠加）', () => {
        const html = '<script src="/js/app.js?v=old1"></script>';
        const out = injectAssetVersion(html, 'new2');
        expect(out).toBe('<script src="/js/app.js?v=new2"></script>');
        expect(out).not.toContain('old1');
        expect((out.match(/v=/g) || []).length).toBe(1);
    });

    test('已带其他查询参数时追加 &v=', () => {
        const html = '<script src="/js/app.js?t=1"></script>';
        const out = injectAssetVersion(html, 'v3');
        expect(out).toBe('<script src="/js/app.js?t=1&v=v3"></script>');
    });

    test('空版本号原样返回，不做注入', () => {
        const html = '<script src="/js/app.js"></script>';
        expect(injectAssetVersion(html, '')).toBe(html);
        expect(injectAssetVersion(html, null)).toBe(html);
    });

    test('含 /assets/ 引用也注入版本', () => {
        const html = '<img src="/assets/logo.png">';
        const out = injectAssetVersion(html, 'x1');
        expect(out).toContain('src="/assets/logo.png?v=x1"');
    });

    test('教师和学生周视图子模块使用版本 URL，避免命中旧 ESM 缓存', () => {
        const fs = require('fs');
        const path = require('path');
        const teacherSource = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/modules/teacher/entry.js'),
            'utf8'
        );
        const studentSource = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/modules/student/entry.js'),
            'utf8'
        );

        expect(teacherSource).toMatch(/from ['"]\.\/availability\.js\?v=[^'"]+['"]/);
        expect(teacherSource).toMatch(/from ['"]\.\/schedules\.js\?v=[^'"]+['"]/);
        expect(teacherSource).toMatch(/from ['"]\.\/student-schedules\.js\?v=[^'"]+['"]/);
        expect(studentSource).toMatch(/from ['"]\.\/availability\.js\?v=[^'"]+['"]/);
        expect(studentSource).toMatch(/from ['"]\.\/schedules\.js\?v=[^'"]+['"]/);
    });

    test('服务端要求 HTML/CSS/JS 使用 ETag 重验证而不是一天强缓存', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../src/server/app.js'),
            'utf8'
        );

        expect(source).toMatch(/if \(\/\\\.\(\?:html\|css\|js\)\$\/i\.test\(filePath\)\)/);
        expect(source).toContain("res.setHeader('Cache-Control', 'no-cache')");
    });
});

