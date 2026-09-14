/**
 * 分批处理性能测试
 * 测试不同数据量的导出性能和内存占用
 */

const UnifiedExportService = require('../../services/export/sheet-builder');

describe('Batch Processing - Performance Tests', () => {
    let service;

    beforeEach(() => {
        service = UnifiedExportService;
        // Mock getScheduleTypes
        service.getScheduleTypes = jest.fn().mockResolvedValue([
            { id: 1, name: 'trial', description: '试教' },
            { id: 2, name: 'visit', description: '入户' },
            { id: 3, name: 'review', description: '评审' },
            { id: 4, name: 'consultation', description: '咨询' },
            { id: 5, name: 'group_activity', description: '集体活动' }
        ]);
    });

    // generateTestData 由 __tests__/fixtures/generate-test-data.js 提供（两套件原各存一份逐字相同副本）
    const { generateTestData } = require('../fixtures/generate-test-data.js');

    /**
     * 测量性能
     */
    async function measurePerformance(dataSize, description) {
        const data = generateTestData(dataSize);
        const options = {
            startDate: '2024-01-01',
            endDate: '2024-12-31',
            userType: 'admin',
            userName: 'admin'
        };

        // 获取初始内存使用
        global.gc && global.gc(); // 触发垃圾回收（如果可用）
        const memBefore = process.memoryUsage();

        // 开始计时
        const startTime = Date.now();

        // 执行导出
        const result = await service.generateCompleteExport(data, options);

        // 结束计时
        const duration = Date.now() - startTime;

        // 获取导出后内存使用
        const memAfter = process.memoryUsage();

        // 计算内存增长
        const heapUsedDiff = (memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024;

        return {
            dataSize,
            description,
            duration,
            memoryUsed: heapUsedDiff.toFixed(2),
            sheetsGenerated: Object.keys(result.sheets).filter(k => !k.startsWith('_')).length
        };
    }

    // 注意：这些测试可能运行较慢，仅在需要性能分析时运行
    describe('性能基准测试', () => {
        // 增加超时时间
        jest.setTimeout(120000);

        test('1000 条记录 - 单批处理', async () => {
            const result = await measurePerformance(1000, '单批处理');

            console.log('\n性能测试结果 - 1000 条记录:');
            console.log(`  耗时: ${result.duration}ms`);
            console.log(`  内存增长: ${result.memoryUsed}MB`);
            console.log(`  生成工作表数: ${result.sheetsGenerated}`);

            expect(result.duration).toBeLessThan(10000); // 应在 10 秒内完成
            expect(result.sheetsGenerated).toBe(6);
        });

        test('5000 条记录 - 单批处理', async () => {
            const result = await measurePerformance(5000, '单批处理');

            console.log('\n性能测试结果 - 5000 条记录:');
            console.log(`  耗时: ${result.duration}ms`);
            console.log(`  内存增长: ${result.memoryUsed}MB`);
            console.log(`  生成工作表数: ${result.sheetsGenerated}`);

            expect(result.duration).toBeLessThan(20000); // 应在 20 秒内完成
            expect(result.sheetsGenerated).toBe(6);
        });

        test('10000 条记录 - 分批处理', async () => {
            const result = await measurePerformance(10000, '分批处理');

            console.log('\n性能测试结果 - 10000 条记录:');
            console.log(`  耗时: ${result.duration}ms`);
            console.log(`  内存增长: ${result.memoryUsed}MB`);
            console.log(`  生成工作表数: ${result.sheetsGenerated}`);

            expect(result.duration).toBeLessThan(40000); // 应在 40 秒内完成
            expect(result.sheetsGenerated).toBe(6);
        });

        test('20000 条记录 - 分批处理', async () => {
            const result = await measurePerformance(20000, '分批处理');

            console.log('\n性能测试结果 - 20000 条记录:');
            console.log(`  耗时: ${result.duration}ms`);
            console.log(`  内存增长: ${result.memoryUsed}MB`);
            console.log(`  生成工作表数: ${result.sheetsGenerated}`);

            expect(result.duration).toBeLessThan(80000); // 应在 80 秒内完成
            expect(result.sheetsGenerated).toBe(6);
        });
    });

    describe('性能对比测试', () => {
        jest.setTimeout(120000);

        test('对比不同数据量的处理时间', async () => {
            const sizes = [1000, 5000, 10000, 15000, 20000];
            const results = [];

            console.log('\n=== 性能对比测试 ===\n');

            for (const size of sizes) {
                const result = await measurePerformance(size, size > 5000 ? '分批' : '单批');
                results.push(result);

                console.log(`${size} 条记录 (${result.description}):`);
                console.log(`  耗时: ${result.duration}ms`);
                console.log(`  内存: ${result.memoryUsed}MB`);
                console.log('');
            }

            // 验证随着数据量增加，处理时间应该线性增长（不是指数增长）
            const ratio1 = results[1].duration / results[0].duration;
            const ratio2 = results[2].duration / results[1].duration;
            const ratio3 = results[3].duration / results[2].duration;

            console.log('时间增长比例:');
            console.log(`  1000->5000: ${ratio1.toFixed(2)}x`);
            console.log(`  5000->10000: ${ratio2.toFixed(2)}x`);
            console.log(`  10000->15000: ${ratio3.toFixed(2)}x`);

            // 增长比例不应过大（说明算法效率稳定）
            expect(ratio1).toBeLessThan(10);
            expect(ratio2).toBeLessThan(5);
            expect(ratio3).toBeLessThan(3);
        });
    });
});
