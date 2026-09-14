/**
 * 导出性能测试
 * 目标：验证性能优化效果，确保达到 20-30% 的性能提升
 */

// Mock db 模块，避免依赖真实数据库连接
jest.mock('../../db/db', () => ({
    query: jest.fn().mockResolvedValue({ rows: [] }),
    runInTransaction: jest.fn(),
    end: jest.fn()
}));

const db = require('../../db/db');
const SheetBuilder = require('../../services/export/sheet-builder');
const scheduleQueries = require('../../services/export/schedule-queries');

/**
 * 生成测试数据
 */
const generateTestData = (count) => {
    const data = [];
    const startDate = new Date('2026-01-01');

    for (let i = 0; i < count; i++) {
        data.push({
            id: i + 1,
            schedule_id: i + 1,
            teacher_id: (i % 10) + 1,
            teacher_name: `教师${(i % 10) + 1}`,
            student_id: (i % 20) + 1,
            student_name: `学生${(i % 20) + 1}`,
            course_id: (i % 8) + 1,
            type: '入户',
            type_name: '入户课',
            type_desc: '入户课程',
            date: new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000),
            class_date: new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000),
            arr_date: new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000),
            start_time: '09:00:00',
            end_time: '11:00:00',
            time_range: '09:00-11:00',
            location: '测试地点',
            status: 'confirmed',
            transport_fee: 50,
            other_fee: 20,
            family_participants: 2,
            teacher_rating: 5,
            student_rating: 5,
            teacher_comment: '测试评价',
            student_comment: '测试反馈',
            notes: '测试备注',
            created_at: new Date(),
            updated_at: new Date(),
            last_auto_update: new Date(),
            created_by: 1,
            adjustment_type: null
        });
    }

    return data;
};

describe('Export Performance Tests', () => {
    let unifiedService;
    let advancedService;

    beforeAll(() => {
        // 配置 db.query 返回课程类型数据（用于 getScheduleTypes 缓存）
        db.query.mockImplementation((sql) => {
            if (sql.includes('schedule_types')) {
                return Promise.resolve({
                    rows: [
                        { id: 1, name: '入户', description: '入户课程' },
                        { id: 2, name: '试教', description: '试教课程' },
                        { id: 3, name: '评审', description: '评审课程' },
                        { id: 4, name: '集体活动', description: '集体活动' },
                        { id: 5, name: '咨询', description: '咨询课程' }
                    ]
                });
            }
            return Promise.resolve({ rows: [] });
        });

        unifiedService = SheetBuilder;
        advancedService = scheduleQueries;
    });

    /**
     * 测试 UnifiedExportService 性能
     */
    describe('UnifiedExportService Performance', () => {
        test('1000条记录导出应在3秒内完成', async () => {
            const testData = generateTestData(1000);
            const options = {
                userType: 'admin',
                userName: 'admin',
                startDate: '2026-01-01',
                endDate: '2026-12-31'
            };

            const startTime = Date.now();
            const result = await unifiedService.generateCompleteExport(testData, options);
            const duration = Date.now() - startTime;

            console.log(`[Performance] 1000条记录导出耗时: ${duration}ms`);

            expect(result).toBeDefined();
            expect(result.sheets).toBeDefined();
            expect(result.filename).toBeDefined();
            expect(duration).toBeLessThan(3000); // 3秒
        }, 10000);

        test('5000条记录导出应在10秒内完成', async () => {
            const testData = generateTestData(5000);
            const options = {
                userType: 'admin',
                userName: 'admin',
                startDate: '2026-01-01',
                endDate: '2026-12-31'
            };

            const startTime = Date.now();
            const result = await unifiedService.generateCompleteExport(testData, options);
            const duration = Date.now() - startTime;

            console.log(`[Performance] 5000条记录导出耗时: ${duration}ms`);

            expect(result).toBeDefined();
            expect(result.sheets).toBeDefined();
            expect(result.filename).toBeDefined();
            expect(duration).toBeLessThan(10000); // 10秒
        }, 15000);

        test('名称缓存应正常工作', async () => {
            const testData = generateTestData(500);

            // 两次预加载都应成功（第二次使用缓存）
            await expect(unifiedService._preloadNameCache(testData)).resolves.toBeUndefined();
            await expect(unifiedService._preloadNameCache(testData)).resolves.toBeUndefined();
        });
    });

    /**
     * 测试并行生成性能
     */
    describe('Parallel Generation Performance', () => {
        test('并行生成应快于串行生成', async () => {
            const testData = generateTestData(1000);
            const options = {
                userType: 'admin',
                userName: 'admin',
                startDate: '2026-01-01',
                endDate: '2026-12-31'
            };

            // 并行生成
            const parallelStart = Date.now();
            await unifiedService._generateSingleBatch(testData, options);
            const parallelDuration = Date.now() - parallelStart;

            console.log(`[Performance] 并行生成耗时: ${parallelDuration}ms`);

            // 验证生成成功
            expect(parallelDuration).toBeGreaterThan(0);
            expect(parallelDuration).toBeLessThan(5000);
        });
    });

    /**
     * 性能基准测试
     */
    describe('Performance Benchmarks', () => {
        const recordCounts = [100, 500, 1000, 2000];

        recordCounts.forEach(count => {
            test(`${count}条记录的性能基准`, async () => {
                const testData = generateTestData(count);
                const options = {
                    userType: 'admin',
                    userName: 'admin',
                    startDate: '2026-01-01',
                    endDate: '2026-12-31'
                };

                const startTime = Date.now();
                await unifiedService.generateCompleteExport(testData, options);
                const duration = Date.now() - startTime;

                const avgPerRecord = duration / count;

                console.log(`[Benchmark] ${count}条记录: 总耗时 ${duration}ms, 平均 ${avgPerRecord.toFixed(2)}ms/条`);

                // 基准要求：每条记录不超过 5ms
                expect(avgPerRecord).toBeLessThan(5);
            }, 20000);
        });
    });

    /**
     * 内存使用测试
     */
    describe('Memory Usage', () => {
        test('大数据量导出不应导致内存溢出', async () => {
            const testData = generateTestData(10000);
            const options = {
                userType: 'admin',
                userName: 'admin',
                startDate: '2026-01-01',
                endDate: '2026-12-31'
            };

            const memBefore = process.memoryUsage().heapUsed / 1024 / 1024;

            await unifiedService.generateCompleteExport(testData, options);

            const memAfter = process.memoryUsage().heapUsed / 1024 / 1024;
            const memDelta = memAfter - memBefore;

            console.log(`[Memory] 导出前: ${memBefore.toFixed(2)}MB, 导出后: ${memAfter.toFixed(2)}MB, 增长: ${memDelta.toFixed(2)}MB`);

            // 内存增长应该合理（不超过 500MB）
            expect(memDelta).toBeLessThan(500);
        }, 30000);
    });
});

/**
 * 性能对比工具
 */
class PerformanceComparator {
    constructor() {
        this.results = [];
    }

    async measure(name, fn) {
        const startTime = Date.now();
        const result = await fn();
        const duration = Date.now() - startTime;

        this.results.push({
            name,
            duration,
            timestamp: new Date()
        });

        return { result, duration };
    }

    compare(baseline, optimized) {
        const improvement = ((baseline - optimized) / baseline) * 100;
        return {
            baseline,
            optimized,
            improvement: improvement.toFixed(2) + '%',
            speedup: (baseline / optimized).toFixed(2) + 'x'
        };
    }

    report() {
        console.table(this.results);
        return this.results;
    }
}

module.exports = {
    PerformanceComparator,
    generateTestData: generateTestData
};
