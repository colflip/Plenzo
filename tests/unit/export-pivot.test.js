/**
 * 透视统计表单元测试
 * 不依赖数据库，使用模拟数据测试 StatsAggregator 的静态方法。
 *
 * 注：原测试调用 UnifiedExportService.generateTeacherStatsSheet，
 * 该方法已迁移为 StatsAggregator 的静态方法，调用签名变为
 * (rawData, allTypes)。此处对齐新 API，并补全 allTypes 课程类型数组。
 * generateCompleteExport 整表导出依赖真实数据/DB，已归入集成测试层。
 */

const StatsAggregator = require('../../src/server/services/export/stats-aggregator');

// Mock数据库查询（DataTransformer 等依赖可能间接引用 db，保留 mock 以防模块加载报错）
jest.mock('../../src/server/db/db', () => ({
    query: jest.fn((sql) => {
        if (sql.includes('schedule_types')) {
            return Promise.resolve({
                rows: [
                    { id: 1, name: 'trial', description: '试教' },
                    { id: 2, name: 'visit', description: '入户' },
                    { id: 3, name: 'review', description: '评审' },
                    { id: 4, name: 'group_activity', description: '集体活动' },
                    { id: 5, name: 'consultation', description: '咨询' }
                ]
            });
        }
        return Promise.resolve({ rows: [] });
    })
}));

// 与统计方法签名一致的课程类型数组（决定透视表列头）
const allTypes = [
    { id: 1, name: 'trial', description: '试教' },
    { id: 2, name: 'visit', description: '入户' },
    { id: 3, name: 'review', description: '评审' },
    { id: 4, name: 'group_activity', description: '集体活动' },
    { id: 5, name: 'consultation', description: '咨询' }
];

describe('透视统计表功能测试', () => {
    const mockData = [
        {
            teacher_id: 101,
            teacher_name: '张老师',
            student_id: 201,
            student_name: '王小明',
            course_id: 1,
            type_name: '试教',
            status: 'confirmed',
            date: '2026-06-15'
        },
        {
            teacher_id: 101,
            teacher_name: '张老师',
            student_id: 201,
            student_name: '王小明',
            course_id: 2,
            type_name: '入户',
            status: 'confirmed',
            date: '2026-06-16'
        },
        {
            teacher_id: 102,
            teacher_name: '李老师',
            student_id: 201,
            student_name: '王小明',
            course_id: 3,
            type_name: '评审',
            status: 'confirmed',
            date: '2026-06-17'
        },
        {
            teacher_id: 101,
            teacher_name: '张老师',
            student_id: 201,
            student_name: '王小明',
            course_id: 1,
            type_name: '试教',
            status: 'cancelled',
            date: '2026-06-18'
        },
        {
            teacher_id: 101,
            teacher_name: '张老师',
            student_id: 201,
            student_name: '王小明',
            course_id: 2,
            type_name: '入户',
            status: 'confirmed',
            date: '2026-06-19'
        }
    ];

    describe('教师授课统计（透视表）', () => {
        test('应生成动态列', async () => {
            const result = StatsAggregator.generateTeacherStatsSheet(mockData, allTypes);

            expect(result.length).toBeGreaterThan(0);

            const firstRow = result[0];
            expect(firstRow).toHaveProperty('教师姓名');
            expect(firstRow).toHaveProperty('试教');
            expect(firstRow).toHaveProperty('入户');
            expect(firstRow).toHaveProperty('评审');
            expect(firstRow).toHaveProperty('汇总');

            console.log('✅ 教师统计表列结构正确');
        });

        test('应正确统计每种课程类型', async () => {
            const result = StatsAggregator.generateTeacherStatsSheet(mockData, allTypes);

            const zhangTeacher = result.find(row => row['教师姓名'] === '张老师');
            expect(zhangTeacher).toBeDefined();

            // 已取消的不计入
            expect(zhangTeacher['试教']).toBe(1); // 1次确认，1次取消
            expect(zhangTeacher['入户']).toBe(2); // 2次确认
            expect(zhangTeacher['评审']).toBe('/'); // 0次

            console.log('✅ 教师课程类型统计正确');
            console.log('   张老师:', zhangTeacher);
        });

        test('应生成正确的汇总文本', async () => {
            const result = StatsAggregator.generateTeacherStatsSheet(mockData, allTypes);

            const zhangTeacher = result.find(row => row['教师姓名'] === '张老师');
            expect(zhangTeacher['汇总']).toMatch(/1次试教/);
            expect(zhangTeacher['汇总']).toMatch(/2次入户/);

            console.log('✅ 汇总文本格式正确');
            console.log('   汇总:', zhangTeacher['汇总']);
        });

        test('0值应显示为 /', async () => {
            const result = StatsAggregator.generateTeacherStatsSheet(mockData, allTypes);

            const zhangTeacher = result.find(row => row['教师姓名'] === '张老师');
            expect(zhangTeacher['评审']).toBe('/');
            expect(zhangTeacher['集体活动']).toBe('/');
            expect(zhangTeacher['咨询']).toBe('/');

            console.log('✅ 0值正确显示为 /');
        });

        test('应包含汇总行', async () => {
            const result = StatsAggregator.generateTeacherStatsSheet(mockData, allTypes);

            const lastRow = result[result.length - 1];
            expect(lastRow._isSummaryRow).toBe(true);
            expect(lastRow['教师姓名']).toBe('/');

            console.log('✅ 包含汇总行');
        });
    });

    describe('学生上课统计（透视表）', () => {
        test('应生成动态列', async () => {
            const result = StatsAggregator.generateStudentStatsSheet(mockData, allTypes);

            expect(result.length).toBeGreaterThan(0);

            const firstRow = result[0];
            expect(firstRow).toHaveProperty('学生姓名');
            expect(firstRow).toHaveProperty('试教');
            expect(firstRow).toHaveProperty('入户');
            expect(firstRow).toHaveProperty('评审');
            expect(firstRow).toHaveProperty('汇总');

            console.log('✅ 学生统计表列结构正确');
        });

        test('应正确统计每种课程类型', async () => {
            const result = StatsAggregator.generateStudentStatsSheet(mockData, allTypes);

            const wangStudent = result.find(row => row['学生姓名'] === '王小明');
            expect(wangStudent).toBeDefined();

            // 已取消的不计入
            expect(wangStudent['试教']).toBe(1);
            expect(wangStudent['入户']).toBe(2);
            expect(wangStudent['评审']).toBe(1);

            console.log('✅ 学生课程类型统计正确');
            console.log('   王小明:', wangStudent);
        });

        test('应生成正确的汇总文本', async () => {
            const result = StatsAggregator.generateStudentStatsSheet(mockData, allTypes);

            const wangStudent = result.find(row => row['学生姓名'] === '王小明');
            expect(wangStudent['汇总']).toMatch(/1次试教/);
            expect(wangStudent['汇总']).toMatch(/2次入户/);
            expect(wangStudent['汇总']).toMatch(/1次评审/);

            console.log('✅ 学生汇总文本格式正确');
            console.log('   汇总:', wangStudent['汇总']);
        });
    });
});
