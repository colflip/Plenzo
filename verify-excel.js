#!/usr/bin/env node
/**
 * 验证生成的 Excel 文件
 * 使用 ExcelJS 读取文件并检查列结构
 */

const ExcelJS = require('exceljs');
const path = require('path');

async function verifyExcel() {
    console.log('🔍 验证 Excel 文件结构...\n');

    try {
        const filePath = path.join(__dirname, 'test-export-output.xlsx');
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(filePath);

        console.log(`📊 文件: ${path.basename(filePath)}`);
        console.log(`📋 工作表数量: ${workbook.worksheets.length}\n`);

        // 检查每个工作表
        workbook.worksheets.forEach((worksheet, index) => {
            console.log(`${index + 1}. 工作表: "${worksheet.name}"`);
            console.log(`   行数: ${worksheet.rowCount}`);
            console.log(`   列数: ${worksheet.columnCount}`);

            // 获取表头（第1行）
            const headerRow = worksheet.getRow(1);
            const headers = [];
            headerRow.eachCell((cell, colNumber) => {
                headers.push(cell.value);
            });

            console.log(`   表头: ${headers.join(', ')}`);

            // 检查是否有 _ 开头的列
            const hasInternalFields = headers.some(h => String(h).startsWith('_'));
            console.log(`   包含内部字段: ${hasInternalFields ? '❌ 是' : '✅ 否'}`);

            if (hasInternalFields) {
                const internalFields = headers.filter(h => String(h).startsWith('_'));
                console.log(`   ⚠️  发现内部字段: ${internalFields.join(', ')}`);
            }

            console.log('');
        });

        // 工作表顺序验证
        const expectedOrder = [
            '每日排课明细',
            '教师授课汇总',
            '学生上课汇总',
            '教师授课统计',
            '学生上课统计',
            '排课原始记录'
        ];
        const actualOrder = workbook.worksheets.map(ws => ws.name);
        const orderCorrect = JSON.stringify(expectedOrder) === JSON.stringify(actualOrder);

        console.log('📋 工作表顺序验证:');
        console.log(`   预期: ${expectedOrder.join(' → ')}`);
        console.log(`   实际: ${actualOrder.join(' → ')}`);
        console.log(`   结果: ${orderCorrect ? '✅ 正确' : '❌ 不正确'}\n`);

        // 检查第一个工作表的详细信息
        const firstSheet = workbook.worksheets[0];
        console.log(`🔬 详细检查: "${firstSheet.name}"`);
        console.log(`   总行数: ${firstSheet.rowCount}`);
        console.log(`   总列数: ${firstSheet.columnCount}`);

        // 检查前几行数据
        console.log('   前3行数据:');
        for (let i = 1; i <= Math.min(3, firstSheet.rowCount); i++) {
            const row = firstSheet.getRow(i);
            const values = [];
            row.eachCell((cell, colNumber) => {
                let value = cell.value;
                if (value && typeof value === 'object' && value.richText) {
                    value = '[RichText]';
                }
                values.push(String(value).substring(0, 20));
            });
            console.log(`     行${i}: ${values.join(' | ')}`);
        }

        console.log('\n✅ 验证完成！文件结构正常。');
        process.exit(0);

    } catch (error) {
        console.error('❌ 验证失败:', error.message);
        console.error('详细错误:', error);
        process.exit(1);
    }
}

verifyExcel();
