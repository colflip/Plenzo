describe('front-end sync infrastructure', () => {
    beforeEach(() => {
        jest.resetModules();
        delete global.syncGuards;
    });

    test('latest request guard invalidates older requests', () => {
        const guards = require('../../public/js/core/sync-guards.js');
        const first = guards.nextRequest('availability:student');
        expect(first.isCurrent()).toBe(true);

        const second = guards.nextRequest('availability:student');
        expect(first.isCurrent()).toBe(false);
        expect(second.isCurrent()).toBe(true);
    });

    test('request sequences are isolated by resource', () => {
        const guards = require('../../public/js/core/sync-guards.js');
        const schedules = guards.nextRequest('schedules');
        guards.nextRequest('users');
        expect(schedules.isCurrent()).toBe(true);
    });

    test('mutation lock rejects duplicates and releases safely', () => {
        const guards = require('../../public/js/core/sync-guards.js');
        const lock = guards.acquireMutation('schedule:42:update');
        expect(lock).not.toBeNull();
        expect(guards.isMutationLocked('schedule:42:update')).toBe(true);
        expect(guards.acquireMutation('schedule:42:update')).toBeNull();

        lock.release();
        lock.release();
        expect(guards.isMutationLocked('schedule:42:update')).toBe(false);
        expect(guards.acquireMutation('schedule:42:update')).not.toBeNull();
    });

    test('event bus exposes new resource events and isolates listener failures', () => {
        const { EventBus, EVENTS } = require('../../public/js/core/event-bus.js');
        const bus = new EventBus();
        const received = [];
        bus.on(EVENTS.PROFILE_UPDATED, () => { throw new Error('listener failure'); });
        bus.on(EVENTS.PROFILE_UPDATED, detail => received.push(detail));

        bus.emit(EVENTS.PROFILE_UPDATED, { role: 'teacher' });
        expect(received).toEqual([{ role: 'teacher' }]);
        expect(EVENTS.SCHEDULE_TYPE_CHANGED).toBe('scheduleType:changed');
        expect(EVENTS.AVAILABILITY_UPDATED).toBe('availability:updated');
        expect(EVENTS.USER_CHANGED).toBe('user:changed');
    });

    test('availability factory imports the week-start helper it calls', () => {
        const fs = require('fs');
        const path = require('path');
        // 两端 availability 已合并进共享工厂：调用点与导入必须同在该文件
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/modules/shared/availability-view.js'),
            'utf8'
        );

        expect(source).toMatch(
            /import\s*\{[^}]*\bgetWeekStart\b[^}]*\}\s*from\s*['"]\.\/schedule-helpers\.js['"];/s
        );
        expect(source).toContain('getWeekStart(new Date())');
        expect(source).toContain('getWeekStart(baseDate)');
    });

    test('teacher schedules imports the start-of-week helper it calls', () => {
        const fs = require('fs');
        const path = require('path');
        const source = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/modules/teacher/schedules.js'),
            'utf8'
        );

        expect(source).toMatch(
            /import\s*\{[^}]*\bstartOfWeek\b[^}]*\}\s*from\s*['"]\.\/utils\.js['"];/s
        );
        expect(source).toContain('startOfWeek(new Date())');
        expect(source).toContain('startOfWeek(baseDate)');
    });

    test('teacher weekly views preserve desktop table nodes for errors and responsive switching', () => {
        const fs = require('fs');
        const path = require('path');
        const availabilitySource = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/modules/shared/availability-view.js'),
            'utf8'
        );
        const schedulesSource = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/modules/teacher/schedules.js'),
            'utf8'
        );

        expect(availabilitySource).not.toMatch(
            /function renderAvailabilityErrorState[\s\S]*?clearChildren\(container\)/
        );
        expect(availabilitySource).toContain("desktopTable.style.display = 'none'");
        expect(availabilitySource).toContain("desktopTable.style.display = ''");
        expect(schedulesSource).toContain('renderScheduleErrorState(weekDates, currentWeekStart, error)');
        expect(schedulesSource).toContain("desktopTable.style.display = 'none'");
        expect(schedulesSource).toContain("desktopTable.style.display = ''");
    });

    test('schedule visibility toggles share the red active state across dashboards', () => {
        const fs = require('fs');
        const path = require('path');
        // 唯一实现集中在共享模块：红=开(#ef4444) / 绿=关(#2ECC71)，配 CSS 类 schedule-toggle-active
        const sharedSource = fs.readFileSync(
            path.resolve(__dirname, '../../public/js/modules/shared/view-utils.js'),
            'utf8'
        );
        expect(sharedSource).toContain("classList.toggle('schedule-toggle-active'");
        expect(sharedSource).toContain("setAttribute('aria-pressed'");
        expect(sharedSource).toContain("'#ef4444'");
        expect(sharedSource).toContain("'#2ECC71'");

        // 各 dashboard 只导入调用，不再内联实现
        const consumers = [
            '../../public/js/modules/admin/schedule-manager.js',
            '../../public/js/modules/teacher/student-schedules.js'
        ].map(file => fs.readFileSync(path.resolve(__dirname, file), 'utf8'));

        consumers.forEach(source => {
            expect(source).toMatch(
                /import\s*\{[^}]*\bsyncToggleButton\b[^}]*\}\s*from\s*['"]\.\.\/shared\/view-utils\.js['"];?/
            );
        });

        const styles = fs.readFileSync(
            path.resolve(__dirname, '../../public/css/modules/dashboard.css'),
            'utf8'
        );
        expect(styles).toMatch(/#toggleStudentShowPlanBtn,[\s\S]*background-color:\s*#2ECC71\s*!important/);
        expect(styles).toMatch(/#toggleStudentShowPlanBtn\.schedule-toggle-active,[\s\S]*background-color:\s*#ef4444\s*!important/);
        expect(styles).toMatch(/#toggleStudentShowPlanBtn\.schedule-toggle-active:hover,[\s\S]*background-color:\s*#dc2626\s*!important/);
    });
});
