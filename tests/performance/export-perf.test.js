/**
 * 性能基准测试
 * 测试不同数据量级别的导出性能
 */

const { performance } = require('perf_hooks');
const UnifiedExportService = require('../../src/server/services/export/sheet-builder');
const {
    seedScheduleTypes,
    createTestTeacher,
    createTestStudent,
    createBatchSchedules,
    cleanupTestData
} = require('../helpers/test-data');

describe('导出性能基准测试', () => {
    let service;

    beforeAll(async () => {
        service = UnifiedExportService;
        // 播种基础课程类型（courseId 外键依赖 id 1~5）
        await seedScheduleTypes();
    });

    afterAll(async () => {
        await cleanupTestData();
    });

    /**
     * 性能基准测试辅助函数
     */
    async function benchmarkExport(recordCount, label) {
        console.log(`\n📊 测试 ${label} (${recordCount}条记录)`);

        // 创建测试数据
        const t1 = await createTestTeacher();
        const t2 = await createTestTeacher();
        const s1 = await createTestStudent();
        const s2 = await createTestStudent();

        const scheduleIds = await createBatchSchedules(recordCount, {
            teacherIds: [t1.id, t2.id],
            studentIds: [s1.id, s2.id],
            startDate: '2026-06-01'
        });

        expect(scheduleIds).toHaveLength(recordCount);

        // 查询数据
        const db = require('../../src/server/db/db');
        const result = await db.query(
            `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                    st.id as course_id, st.name as type_name, st.description as type_desc
             FROM course_arrangement ca
             LEFT JOIN teachers t ON ca.teacher_id = t.id
             LEFT JOIN students s ON ca.student_id = s.id
             LEFT JOIN schedule_types st ON ca.course_id = st.id
             WHERE ca.created_by = 1
             ORDER BY ca.class_date, ca.start_time`
        );

        const rawData = result.rows;

        // 测量内存和时间
        const memBefore = process.memoryUsage().heapUsed;
        const startTime = performance.now();

        const exportResult = await service.generateCompleteExport(rawData, {
            startDate: '2026-06-01',
            endDate: '2026-06-30',
            userType: 'admin',
            userId: 1,
            studentId: null,
            teacherId: null,
            studentName: '全部学生'
        });

        const endTime = performance.now();
        const memAfter = process.memoryUsage().heapUsed;

        const duration = endTime - startTime;
        const memUsed = (memAfter - memBefore) / 1024 / 1024; // MB

        // 验证结果
        expect(exportResult).toHaveProperty('sheets');
        expect(exportResult).toHaveProperty('filename');

        console.log(`   ⏱️  耗时: ${duration.toFixed(0)}ms`);
        console.log(`   💾 内存: ${memUsed.toFixed(2)}MB`);
        console.log(`   📄 每日排课明细: ${exportResult.sheets['每日排课明细'].length} 行`);

        // 清理测试数据
        await cleanupTestData();

        return {
            recordCount,
            duration,
            memUsed,
            label
        };
    }

    test('100条记录 - 应在2秒内完成', async () => {
        const result = await benchmarkExport(100, '小数据量');

        expect(result.duration).toBeLessThan(2000);
        expect(result.memUsed).toBeLessThan(100);

        console.log(`   ✅ 性能达标: ${result.duration.toFixed(0)}ms < 2000ms`);
    }, 30000);

    test('500条记录 - 应在5秒内完成', async () => {
        const result = await benchmarkExport(500, '中等数据量');

        expect(result.duration).toBeLessThan(5000);
        expect(result.memUsed).toBeLessThan(200);

        console.log(`   ✅ 性能达标: ${result.duration.toFixed(0)}ms < 5000ms`);
    }, 30000);

    test('1000条记录 - 应在10秒内完成', async () => {
        const result = await benchmarkExport(1000, '大数据量');

        expect(result.duration).toBeLessThan(10000);
        expect(result.memUsed).toBeLessThan(300);

        console.log(`   ✅ 性能达标: ${result.duration.toFixed(0)}ms < 10000ms`);
    }, 30000);

    test('内存使用监控', async () => {
        const t = await createTestTeacher();
        const s = await createTestStudent();

        await createBatchSchedules(1000, {
            teacherIds: [t.id],
            studentIds: [s.id],
            startDate: '2026-06-01'
        });

        const db = require('../../src/server/db/db');
        const result = await db.query(
            `SELECT ca.*, t.name as teacher_name, s.name as student_name,
                    st.id as course_id, st.name as type_name
             FROM course_arrangement ca
             LEFT JOIN teachers t ON ca.teacher_id = t.id
             LEFT JOIN students s ON ca.student_id = s.id
             LEFT JOIN schedule_types st ON ca.course_id = st.id
             WHERE ca.created_by = 1
             LIMIT 1000`
        );

        const memBefore = process.memoryUsage().heapUsed;

        await service.generateCompleteExport(result.rows, {
            startDate: '2026-06-01',
            endDate: '2026-06-30',
            userType: 'admin',
            userId: 1,
            studentName: '全部学生'
        });

        const memAfter = process.memoryUsage().heapUsed;
        const memUsed = (memAfter - memBefore) / 1024 / 1024;

        console.log(`\n💾 内存使用: ${memUsed.toFixed(2)}MB`);
        expect(memUsed).toBeLessThan(500);

        await cleanupTestData();
    }, 30000);
});
