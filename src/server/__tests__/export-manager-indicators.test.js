const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadExportManager() {
    const policyPath = path.resolve(__dirname, '../../../public/js/utils/schedule-marker-policy.js');
    const tcPath = path.resolve(__dirname, '../../../public/js/utils/type-conversion.js');
    const sourcePath = path.resolve(__dirname, '../../../public/js/components/export-manager.js');
    const policySource = fs.readFileSync(policyPath, 'utf8');
    const tcSource = fs.readFileSync(tcPath, 'utf8');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const window = { currentUser: { userType: 'admin' } };
    const context = {
        window,
        globalThis: window,
        console,
        Date,
        Map,
        Set
    };

    // 按生产页面加载顺序：先 type-conversion.js（export-manager 颜色/折算的唯一实现依赖它）
    vm.runInNewContext(policySource, context, { filename: policyPath });
    vm.runInNewContext(tcSource, context, { filename: tcPath });
    vm.runInNewContext(source, context, { filename: sourcePath });

    return window.ExportManager;
}

describe('ExportManager 当前视图图片标识', () => {
    const ExportManager = loadExportManager();

    const schedule = overrides => ({
        date: '2026-08-01',
        start_time: '13:00:00',
        end_time: '15:00:00',
        student_id: 1,
        student_name: '宋林浩',
        status: 'completed',
        location: '教室',
        type: 'review',
        ...overrides
    });

    const actualText = schedules => {
        const rows = ExportManager.transformToCalendarData(
            schedules,
            new Date(2026, 7, 1),
            new Date(2026, 7, 1),
            '1',
            false
        );
        return rows[0]['实际安排'];
    };

    test('多人课程全员调整时标识放在课程名前', () => {
        expect(actualText([
            schedule({ teacher_id: 2, teacher_name: '金博', status_category: 'adjusted' }),
            schedule({ teacher_id: 3, teacher_name: '侯老师', status_category: 'adjusted' })
        ])).toBe('~评审(13:00-15:00)：金博，侯老师');
    });

    test('多人课程全员临时加课时标识放在课程名前', () => {
        expect(actualText([
            schedule({ teacher_id: 2, teacher_name: '金博', status_category: 'temp' }),
            schedule({ teacher_id: 3, teacher_name: '侯老师', status_category: 'temp' })
        ])).toBe('⁺评审(13:00-15:00)：金博，侯老师');
    });

    test('混合标识中调整占多数时，~ 提升且少数 + 跟老师', () => {
        expect(actualText([
            schedule({ teacher_id: 2, teacher_name: '金博', status_category: 'adjusted' }),
            schedule({ teacher_id: 3, teacher_name: '侯老师', status_category: 'adjusted' }),
            schedule({ teacher_id: 4, teacher_name: '高渊', status_category: 'temp' })
        ])).toBe('~评审(13:00-15:00)：金博，侯老师，⁺高渊');
    });

    test('混合标识中临时加课占多数时，+ 提升且少数 ~ 跟老师', () => {
        expect(actualText([
            schedule({ teacher_id: 2, teacher_name: '金博', status_category: 'temp' }),
            schedule({ teacher_id: 3, teacher_name: '侯老师', status_category: 'temp' }),
            schedule({ teacher_id: 4, teacher_name: '高渊', status_category: 'adjusted' })
        ])).toBe('⁺评审(13:00-15:00)：金博，侯老师，~高渊');
    });

    test('混合标识人数并列时，~ 优先提升且 + 跟老师', () => {
        expect(actualText([
            schedule({ teacher_id: 2, teacher_name: '金博', status_category: 'adjusted' }),
            schedule({ teacher_id: 3, teacher_name: '侯老师', status_category: 'temp' })
        ])).toBe('~评审(13:00-15:00)：金博，⁺侯老师');
    });

    test('多人课程存在无标识人员时，已有标识全部跟老师', () => {
        expect(actualText([
            schedule({ teacher_id: 2, teacher_name: '金博', status_category: 'adjusted' }),
            schedule({ teacher_id: 3, teacher_name: '侯老师', status_category: 'temp' }),
            schedule({ teacher_id: 4, teacher_name: '高渊', status_category: 'normal' })
        ])).toBe('评审(13:00-15:00)：~金博，⁺侯老师，高渊');
    });

    test('单人临时加课标识放在课程名前', () => {
        expect(actualText([
            schedule({ teacher_id: 2, teacher_name: '金博', type: 'visit', status_category: 'temp' })
        ])).toBe('⁺入户(13:00-15:00)：金博');
    });

    test('单人调整标识放在课程名前', () => {
        expect(actualText([
            schedule({ teacher_id: 2, teacher_name: '金博', type: 'visit', status_category: 'adjusted' })
        ])).toBe('~入户(13:00-15:00)：金博');
    });

    test('完全重复的老师记录不重复显示或参与多数统计', () => {
        const duplicated = schedule({ teacher_id: 2, teacher_name: '金博', status_category: 'adjusted' });
        expect(actualText([
            duplicated,
            { ...duplicated },
            schedule({ teacher_id: 3, teacher_name: '侯老师', status_category: 'temp' })
        ])).toBe('~评审(13:00-15:00)：金博，⁺侯老师');
    });
});
