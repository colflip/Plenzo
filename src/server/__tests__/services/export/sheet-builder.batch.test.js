/**
 * 统一导出服务 - 分批处理功能测试
 * 测试大数据量的分批处理逻辑
 */

const SheetBuilder = require('../../../services/export/sheet-builder');
const { ExportError } = require('../../../middleware/export-error-handler');

describe('UnifiedExportService - Batch Processing', () => {
    let sheetBuilder;

    beforeEach(() => {
        sheetBuilder = SheetBuilder;
        // Mock getScheduleTypes
        sheetBuilder.getScheduleTypes = jest.fn().mockResolvedValue([
            { id: 1, name: 'trial', description: '试教' },
            { id: 2, name: 'visit', description: '入户' },
            { id: 3, name: 'review', description: '评审' },
            { id: 4, name: 'consultation', description: '咨询' },
            { id: 5, name: 'group_activity', description: '集体活动' }
        ]);
    });

    // generateTestData 由 __tests__/fixtures/generate-test-data.js 提供（两套件原各存一份逐字相同副本）
    const { generateTestData } = require('../../fixtures/generate-test-data.js');

    describe('数据量限制测试', () => {
        test('应拒绝超过 20000 条的数据', async () => {
            const data = generateTestData(20001);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin'
            };

            await expect(sheetBuilder.generateCompleteExport(data, options))
                .rejects
                .toThrow('导出记录数量超过限制（最大20000条），请缩小日期范围');
        });

        test('应接受 20000 条数据', async () => {
            const data = generateTestData(20000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const result = await sheetBuilder.generateCompleteExport(data, options);
            expect(result).toBeDefined();
            expect(result.sheets).toBeDefined();
        });

        test('应拒绝空数据', async () => {
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin'
            };

            await expect(sheetBuilder.generateCompleteExport([], options))
                .rejects
                .toThrow('该时间段内无可导出的数据');
        });
    });

    describe('单批处理 vs 分批处理', () => {
        test('小于 5000 条应使用单批处理', async () => {
            const data = generateTestData(4999);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const spy = jest.spyOn(sheetBuilder, '_generateSingleBatch');
            await sheetBuilder.generateCompleteExport(data, options);
            expect(spy).toHaveBeenCalled();
        });

        test('等于 5000 条应使用单批处理', async () => {
            const data = generateTestData(5000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const spy = jest.spyOn(sheetBuilder, '_generateSingleBatch');
            await sheetBuilder.generateCompleteExport(data, options);
            expect(spy).toHaveBeenCalled();
        });

        test('大于 5000 条应使用分批处理', async () => {
            const data = generateTestData(5001);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const spy = jest.spyOn(sheetBuilder, '_generateMultiBatch');
            await sheetBuilder.generateCompleteExport(data, options);
            expect(spy).toHaveBeenCalled();
        });

        test('10000 条应使用分批处理', async () => {
            const data = generateTestData(10000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const spy = jest.spyOn(sheetBuilder, '_generateMultiBatch');
            const result = await sheetBuilder.generateCompleteExport(data, options);
            expect(spy).toHaveBeenCalled();
            expect(result.sheets).toBeDefined();
        });
    });

    describe('分批处理数据完整性', () => {
        test('分批处理应生成所有工作表', async () => {
            const data = generateTestData(6000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const result = await sheetBuilder.generateCompleteExport(data, options);

            expect(result.sheets['每日排课明细']).toBeDefined();
            expect(result.sheets['教师授课汇总']).toBeDefined();
            expect(result.sheets['学生上课汇总']).toBeDefined();
            expect(result.sheets['教师授课统计']).toBeDefined();
            expect(result.sheets['学生上课统计']).toBeDefined();
            expect(result.sheets['排课原始记录']).toBeDefined();
        });

        test('原始记录工作表应包含所有数据', async () => {
            const data = generateTestData(6000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const result = await sheetBuilder.generateCompleteExport(data, options);
            const rawRecords = result.sheets['排课原始记录'];

            expect(rawRecords).toHaveLength(6000);
        });

        test('教师汇总应正确统计数量', async () => {
            const data = generateTestData(6000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const result = await sheetBuilder.generateCompleteExport(data, options);
            const teacherSummary = result.sheets['教师授课汇总'];

            // 应该有 5 个教师 + 1 个汇总行
            expect(teacherSummary.length).toBeGreaterThanOrEqual(5);

            // 检查最后一行是汇总行
            const summaryRow = teacherSummary[teacherSummary.length - 1];
            expect(summaryRow._isSummaryRow).toBe(true);
        });

        test('学生汇总应正确统计数量', async () => {
            const data = generateTestData(6000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const result = await sheetBuilder.generateCompleteExport(data, options);
            const studentSummary = result.sheets['学生上课汇总'];

            // 应该有 10 个学生 + 1 个汇总行
            expect(studentSummary.length).toBeGreaterThanOrEqual(10);

            // 检查最后一行是汇总行
            const summaryRow = studentSummary[studentSummary.length - 1];
            expect(summaryRow._isSummaryRow).toBe(true);
        });
    });

    describe('合并逻辑测试', () => {
        test('_mergeTeacherStats 应正确合并重复教师的统计', () => {
            const statsArray = [
                { '姓名': '教师1', '试教': 5, '入户': 10, '评审': 3, '咨询': 2, '集体活动': 1, '半次入户': 0, '评审记录': 0, '咨询记录': 0 },
                { '姓名': '教师1', '试教': 3, '入户': 5, '评审': 2, '咨询': 1, '集体活动': 0, '半次入户': 0, '评审记录': 0, '咨询记录': 0 },
                { '姓名': '教师2', '试教': 2, '入户': 4, '评审': 1, '咨询': 0, '集体活动': 0, '半次入户': 0, '评审记录': 0, '咨询记录': 0 }
            ];

            const merged = sheetBuilder._mergeTeacherStats(statsArray);

            expect(merged).toHaveLength(2);

            const teacher1 = merged.find(s => s['姓名'] === '教师1');
            expect(teacher1['试教']).toBe(8);
            expect(teacher1['入户']).toBe(15);
            expect(teacher1['评审']).toBe(5);
            expect(teacher1['咨询']).toBe(3);
            expect(teacher1['集体活动']).toBe(1);

            const teacher2 = merged.find(s => s['姓名'] === '教师2');
            expect(teacher2['试教']).toBe(2);
            expect(teacher2['入户']).toBe(4);
        });

        test('_mergeStudentStats 应正确合并重复学生的统计', () => {
            const statsArray = [
                { '姓名': '学生1', '试教': 3, '入户': 8, '评审': 2, '咨询': 1, '集体活动': 0, '半次入户': 0, '评审记录': 0, '咨询记录': 0 },
                { '姓名': '学生1', '试教': 2, '入户': 4, '评审': 1, '咨询': 0, '集体活动': 1, '半次入户': 0, '评审记录': 0, '咨询记录': 0 },
                { '姓名': '学生2', '试教': 1, '入户': 3, '评审': 0, '咨询': 0, '集体活动': 0, '半次入户': 0, '评审记录': 0, '咨询记录': 0 }
            ];

            const merged = sheetBuilder._mergeStudentStats(statsArray);

            expect(merged).toHaveLength(2);

            const student1 = merged.find(s => s['姓名'] === '学生1');
            expect(student1['试教']).toBe(5);
            expect(student1['入户']).toBe(12);
            expect(student1['评审']).toBe(3);
            expect(student1['咨询']).toBe(1);
            expect(student1['集体活动']).toBe(1);

            const student2 = merged.find(s => s['姓名'] === '学生2');
            expect(student2['试教']).toBe(1);
            expect(student2['入户']).toBe(3);
        });

        test('合并时应处理缺失的类型字段', () => {
            const statsArray = [
                { '姓名': '教师1', '试教': 5, '入户': 10 },
                { '姓名': '教师1', '评审': 2, '咨询': 1 }
            ];

            const merged = sheetBuilder._mergeTeacherStats(statsArray);

            expect(merged).toHaveLength(1);
            expect(merged[0]['试教']).toBe(5);
            expect(merged[0]['入户']).toBe(10);
            expect(merged[0]['评审']).toBe(2);
            expect(merged[0]['咨询']).toBe(1);
        });
    });

    describe('工作表选项配置', () => {
        test('单批处理应配置工作表选项', async () => {
            const data = generateTestData(1000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const result = await sheetBuilder.generateCompleteExport(data, options);

            expect(result.sheets._worksheetOptions).toBeDefined();
            expect(result.sheets._worksheetOptions['每日排课明细']).toBeDefined();
            expect(result.sheets._worksheetOptions['每日排课明细'].kind).toBe('detail');
        });

        test('分批处理应配置工作表选项', async () => {
            const data = generateTestData(6000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const result = await sheetBuilder.generateCompleteExport(data, options);

            expect(result.sheets._worksheetOptions).toBeDefined();
            expect(result.sheets._worksheetOptions['每日排课明细']).toBeDefined();
            expect(result.sheets._worksheetOptions['每日排课明细'].kind).toBe('detail');
        });
    });

    describe('文件名生成', () => {
        test('分批处理应生成正确的文件名', async () => {
            const data = generateTestData(6000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            const result = await sheetBuilder.generateCompleteExport(data, options);

            expect(result.filename).toBeDefined();
            expect(result.filename).toContain('20240101_20241231');
            expect(result.filename).toContain('.xlsx');
        });
    });

    describe('错误处理', () => {
        test('分批处理中的错误应被正确捕获', async () => {
            const data = generateTestData(6000);
            const options = {
                startDate: '2024-01-01',
                endDate: '2024-12-31',
                userType: 'admin',
                userName: 'admin'
            };

            // Mock 一个失败的方法
            sheetBuilder.getScheduleTypes = jest.fn().mockRejectedValue(new Error('Database error'));

            await expect(sheetBuilder.generateCompleteExport(data, options))
                .rejects
                .toThrow('Database error');
        });
    });
});
