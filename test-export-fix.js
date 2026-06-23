#!/usr/bin/env node
/**
 * 测试导出修复
 * 验证生成的 Excel 文件是否正常
 */

const UnifiedExportService = require('./src/server/services/unifiedExportService');
const excelGeneratorService = require('./src/server/services/excelGeneratorService');
const fs = require('fs');
const path = require('path');

// 生成测试数据
function generateTestData(count = 10) {
    const data = [];
    const startDate = new Date('2026-05-01');

    for (let i = 0; i < count; i++) {
        const date = new Date(startDate);
        date.setDate(startDate.getDate() + Math.floor(i / 2));

        data.push({
            id: i + 1,
            schedule_id: i + 1,
            teacher_id: (i % 3) + 1,
            teacher_name: `教师${(i % 3) + 1}`,
            student_id: (i % 5) + 1,
            student_name: `学生${(i % 5) + 1}`,
            course_id: (i % 2) + 1,
            date: date.toISOString().split('T')[0],
            class_date: date.toISOString().split('T')[0],
            start_time: '09:00:00',
            end_time: '10:00:00',
            time_range: '09:00-10:00',
            status: i % 10 === 0 ? 'cancelled' : 'completed',
            type: ['入户', '评审', '试教', '咨询'][i % 4],
            type_name: ['入户', '评审', '试教', '咨询'][i % 4],
            type_desc: ['入户', '评审', '试教', '咨询'][i % 4],
            location: '测试地址',
            transport_fee: 20,
            other_fee: 50,
            teacher_comment: '测试备注',
            student_comment: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            created_by: 1,
            family_participants: 0,
            teacher_rating: null,
            student_rating: null
        });
    }

    return data;
}

async function testExport() {
    console.log('🧪 测试导出功能...\n');

    try {
        // 1. 生成测试数据
        console.log('📊 生成测试数据...');
        const testData = generateTestData(20);
        console.log(`   ✓ 生成 ${testData.length} 条测试记录\n`);

        // 2. 使用统一导出服务生成数据
        console.log('🔧 调用 UnifiedExportService...');
        const service = new UnifiedExportService();
        const exportResult = await service.generateCompleteExport(testData, {
            startDate: '2026-05-01',
            endDate: '2026-05-31',
            userType: 'admin',
            userId: 1,
            studentName: '测试学生',
            userName: '测试管理员'
        });

        console.log(`   ✓ 生成 ${Object.keys(exportResult.sheets).filter(k => k !== '_worksheetOptions').length} 个工作表`);
        console.log(`   ✓ 文件名: ${exportResult.filename}\n`);

        // 3. 检查数据结构
        console.log('🔍 检查数据结构...');
        const sheetNames = Object.keys(exportResult.sheets).filter(k => k !== '_worksheetOptions');
        sheetNames.forEach(name => {
            const sheet = exportResult.sheets[name];
            if (sheet && sheet.length > 0) {
                const keys = Object.keys(sheet[0]);
                const hasInternalFields = keys.some(k => k.startsWith('_'));
                console.log(`   ${name}:`);
                console.log(`     - 行数: ${sheet.length}`);
                console.log(`     - 列数: ${keys.length}`);
                console.log(`     - 包含内部字段: ${hasInternalFields ? '❌ 是' : '✅ 否'}`);
                if (hasInternalFields) {
                    const internalFields = keys.filter(k => k.startsWith('_'));
                    console.log(`       内部字段: ${internalFields.join(', ')}`);
                }
            }
        });
        console.log('');

        // 4. 生成 Excel 文件
        console.log('📁 生成 Excel 文件...');
        const excelResult = await excelGeneratorService.generateMultiSheetExcel(
            exportResult.sheets,
            exportResult.filename
        );

        console.log(`   ✓ 生成成功`);
        console.log(`   ✓ 文件大小: ${(excelResult.buffer.length / 1024).toFixed(2)} KB\n`);

        // 5. 保存测试文件
        const testFilePath = path.join(__dirname, 'test-export-output.xlsx');
        fs.writeFileSync(testFilePath, excelResult.buffer);
        console.log(`✅ 测试文件已保存: ${testFilePath}`);
        console.log('   请用 Excel 打开该文件验证是否正常\n');

        // 6. 验证工作表顺序
        console.log('📋 工作表顺序验证:');
        const expectedOrder = [
            '每日排课明细',
            '教师授课汇总',
            '学生上课汇总',
            '教师授课统计',
            '学生上课统计',
            '排课原始记录'
        ];
        const actualOrder = sheetNames;
        const orderCorrect = JSON.stringify(expectedOrder) === JSON.stringify(actualOrder);
        console.log(`   预期顺序: ${expectedOrder.join(' → ')}`);
        console.log(`   实际顺序: ${actualOrder.join(' → ')}`);
        console.log(`   顺序正确: ${orderCorrect ? '✅ 是' : '❌ 否'}\n`);

        console.log('🎉 测试完成！');
        process.exit(0);

    } catch (error) {
        console.error('❌ 测试失败:', error.message);
        console.error('详细错误:', error);
        process.exit(1);
    }
}

// 运行测试
testExport();
