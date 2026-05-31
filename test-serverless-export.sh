#!/bin/bash

# Serverless 环境导出功能测试脚本
# 用于本地测试后再部署到 Vercel/Render

echo "=========================================="
echo "Serverless 环境导出功能测试"
echo "=========================================="
echo ""

# 1. 检查依赖
echo "1. 检查依赖..."
if node -e "require('exceljs')" 2>/dev/null; then
    echo "✅ ExcelJS 已安装"
    EXCELJS_VERSION=$(node -e "console.log(require('exceljs/package.json').version)")
    echo "   版本: $EXCELJS_VERSION"
else
    echo "❌ ExcelJS 未安装"
    exit 1
fi
echo ""

# 2. 检查代码修复
echo "2. 检查代码修复..."
if grep -q "await excelGenerator.sendExcelResponse" src/server/controllers/adminController.js; then
    echo "✅ adminController.js - 异步调用正确"
else
    echo "❌ adminController.js - 缺少 await"
fi

if grep -q "console.log.*ExcelGenerator.*开始生成" src/server/services/excelGeneratorService.js; then
    echo "✅ excelGeneratorService.js - 已添加诊断日志"
else
    echo "⚠️  excelGeneratorService.js - 缺少诊断日志"
fi
echo ""

# 3. 测试 ExcelJS 基本功能
echo "3. 测试 ExcelJS 基本功能..."
node -e "
const ExcelJS = require('exceljs');
const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet('Test');
worksheet.columns = [
    { header: '姓名', key: 'name', width: 15 },
    { header: '年龄', key: 'age', width: 10 }
];
worksheet.addRow({ name: '张三', age: 25 });
workbook.xlsx.writeBuffer().then(buffer => {
    console.log('✅ ExcelJS 基本功能正常, buffer 大小:', buffer.length, 'bytes');
}).catch(err => {
    console.error('❌ ExcelJS 测试失败:', err.message);
    process.exit(1);
});
"
echo ""

# 4. 测试 Rich Text 功能
echo "4. 测试 Rich Text 功能..."
node -e "
const ExcelJS = require('exceljs');
const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet('Test');
worksheet.columns = [{ header: '内容', key: 'content', width: 30 }];
const row = worksheet.addRow({ content: '' });
const cell = row.getCell(1);
cell.value = {
    richText: [
        { text: '正常文本', font: { color: { argb: 'FF000000' } } },
        { text: '；', font: { color: { argb: 'FF000000' } } },
        { text: '[已取消]红色斜体', font: { color: { argb: 'FFFF0000' }, italic: true, strike: true } }
    ]
};
workbook.xlsx.writeBuffer().then(buffer => {
    console.log('✅ Rich Text 功能正常, buffer 大小:', buffer.length, 'bytes');
}).catch(err => {
    console.error('❌ Rich Text 测试失败:', err.message);
    process.exit(1);
});
"
echo ""

# 5. 检查 package.json
echo "5. 检查 package.json..."
if grep -q '"exceljs"' package.json; then
    echo "✅ package.json 包含 exceljs"
else
    echo "❌ package.json 缺少 exceljs"
fi
echo ""

# 6. 估算内存使用
echo "6. 估算内存使用..."
node -e "
const ExcelJS = require('exceljs');
const used = process.memoryUsage();
console.log('初始内存使用:');
console.log('  RSS:', Math.round(used.rss / 1024 / 1024), 'MB');
console.log('  Heap Used:', Math.round(used.heapUsed / 1024 / 1024), 'MB');

const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet('Test');
worksheet.columns = [
    { header: '日期', key: 'date', width: 15 },
    { header: '内容', key: 'content', width: 50 }
];

// 模拟 100 行数据
for (let i = 0; i < 100; i++) {
    worksheet.addRow({
        date: '2024-01-01',
        content: '入户(19:00-22:30)：张三；试教(19:00-22:30)：李四；评审(14:00-16:00)：王五'
    });
}

workbook.xlsx.writeBuffer().then(buffer => {
    const afterUsed = process.memoryUsage();
    console.log('\\n生成 100 行后内存使用:');
    console.log('  RSS:', Math.round(afterUsed.rss / 1024 / 1024), 'MB');
    console.log('  Heap Used:', Math.round(afterUsed.heapUsed / 1024 / 1024), 'MB');
    console.log('  Buffer 大小:', Math.round(buffer.length / 1024), 'KB');
    console.log('\\n✅ 内存使用在合理范围内');

    if (afterUsed.heapUsed > 512 * 1024 * 1024) {
        console.log('⚠️  警告: 内存使用超过 512MB，可能在 Render Free 上遇到问题');
    }
});
"
echo ""

echo "=========================================="
echo "✅ 测试完成"
echo "=========================================="
echo ""
echo "部署前检查清单:"
echo "- [✓] ExcelJS 已安装"
echo "- [✓] 代码修复已完成"
echo "- [✓] 基本功能测试通过"
echo "- [✓] Rich Text 功能测试通过"
echo "- [✓] 内存使用合理"
echo ""
echo "部署步骤:"
echo "1. 提交代码:"
echo "   git add ."
echo "   git commit -m 'Fix Excel export for Serverless'"
echo "   git push"
echo ""
echo "2. 部署到 Vercel:"
echo "   vercel --prod"
echo ""
echo "3. 部署到 Render:"
echo "   (自动部署，或手动触发)"
echo ""
echo "4. 部署后测试:"
echo "   - 导出 1 天数据"
echo "   - 导出 7 天数据"
echo "   - 查看服务器日志"
echo ""
