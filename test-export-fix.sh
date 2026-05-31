#!/bin/bash

# 测试 Excel 导出功能修复
# 使用方法：bash test-export-fix.sh

echo "=========================================="
echo "测试 Excel 导出功能修复"
echo "=========================================="
echo ""

# 检查 ExcelJS 是否安装
echo "1. 检查 ExcelJS 安装..."
if node -e "require('exceljs')" 2>/dev/null; then
    echo "✅ ExcelJS 已安装"
else
    echo "❌ ExcelJS 未安装"
    echo "   请运行: npm install exceljs"
    exit 1
fi
echo ""

# 检查修改的文件
echo "2. 检查修复的文件..."
files=(
    "src/server/controllers/adminController.js"
    "src/server/controllers/teacherController.js"
    "src/server/services/excelGeneratorService.js"
)

for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        echo "✅ $file"
    else
        echo "❌ $file (未找到)"
    fi
done
echo ""

# 检查异步调用是否正确
echo "3. 验证异步调用修复..."
if grep -q "await excelGenerator.sendExcelResponse" src/server/controllers/adminController.js; then
    echo "✅ adminController.js - 异步调用已修复"
else
    echo "❌ adminController.js - 异步调用未修复"
fi

if grep -q "await excelGenerator.sendExcelResponse" src/server/controllers/teacherController.js; then
    echo "✅ teacherController.js - 异步调用已修复"
else
    echo "❌ teacherController.js - 异步调用未修复"
fi
echo ""

# 语法检查
echo "4. 语法检查..."
for file in "${files[@]}"; do
    if node -c "$file" 2>/dev/null; then
        echo "✅ $file - 语法正确"
    else
        echo "❌ $file - 语法错误"
        node -c "$file"
    fi
done
echo ""

echo "=========================================="
echo "✅ 测试完成"
echo "=========================================="
echo ""
echo "修复内容："
echo "1. ✅ adminController.js - 添加 await 到 sendExcelResponse"
echo "2. ✅ teacherController.js - 添加 await 到 sendExcelResponse"
echo ""
echo "下一步："
echo "1. 重启服务器："
echo "   npm restart"
echo ""
echo "2. 测试导出功能："
echo "   - 登录管理员账号"
echo "   - 选择'老师授课记录'导出类型"
echo "   - 选择日期范围"
echo "   - 点击'导出 Excel'"
echo "   - 验证文件是否成功下载"
echo ""
