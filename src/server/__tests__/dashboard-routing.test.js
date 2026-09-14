const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '../../..');

function readVercelConfig() {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'vercel.json'), 'utf8'));
}

describe('仪表盘深链接部署路由', () => {
    const roles = ['admin', 'teacher', 'student'];

    test.each(roles)('%s 的基础路径和菜单深链接优先交给 Express', role => {
        const rewrites = readVercelConfig().rewrites;
        const staticFallbackIndex = rewrites.findIndex(rule => rule.destination === '/public/$1');
        const expectedSources = [
            `/${role}/dashboard`,
            `/${role}/dashboard.html`,
            `/${role}/dashboard/:section`,
            `/${role}/dashboard.html/:section`
        ];

        expectedSources.forEach(source => {
            const routeIndex = rewrites.findIndex(rule => (
                rule.source === source && rule.destination === '/api/index.js'
            ));
            expect(routeIndex).toBeGreaterThan(-1);
            expect(routeIndex).toBeLessThan(staticFallbackIndex);
        });
    });

    test('静态资源通配重写保持为最后兜底', () => {
        const rewrites = readVercelConfig().rewrites;
        expect(rewrites.at(-1)).toEqual({
            source: '/((?!api/).*)',
            destination: '/public/$1'
        });
    });

    test('Express 对三端菜单 section 使用白名单，未知路径继续进入 404', () => {
        const source = fs.readFileSync(path.join(rootDir, 'src/server/app.js'), 'utf8');

        // 白名单改为：从 HTML data-section 动态解析，回退到内置 DASHBOARD_SECTIONS_FALLBACK（数组形式，非 new Set）
        expect(source).toContain("admin: ['overview', 'users', 'availability-mgmt', 'schedule', 'finance', 'statistics', 'system-settings']");
        expect(source).toContain("teacher: ['overview', 'profile', 'availability', 'schedules', 'teaching-display', 'fees', 'sd-fees', 'student-schedules']");
        expect(source).toContain("student: ['overview', 'profile', 'availability', 'schedules', 'teaching-display']");
        expect(source).toContain('if (!dashboardSections[role].has(req.params.section)) return next()');
    });
});
