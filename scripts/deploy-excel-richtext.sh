#!/bin/bash

# Excel Rich Text 功能部署脚本
# 使用方法：bash deploy.sh

echo "=========================================="
echo "Excel Rich Text 功能部署"
echo "=========================================="
echo ""

# 检查 Node.js 和 npm
echo "1. 检查环境..."
if ! command -v node &> /dev/null; then
    echo "❌ 错误：未找到 Node.js，请先安装 Node.js"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "❌ 错误：未找到 npm，请先安装 npm"
    exit 1
fi

echo "✅ Node.js 版本: $(node -v)"
echo "✅ npm 版本: $(npm -v)"
echo ""

# 安装 ExcelJS
echo "2. 安装 ExcelJS 依赖..."
echo "   尝试方法 1: 使用默认源..."
if npm install exceljs; then
    echo "✅ ExcelJS 安装成功（默认源）"
else
    echo "⚠️  默认源失败，尝试方法 2: 使用淘宝镜像..."
    if npm install exceljs --registry=https://registry.npmmirror.com; then
        echo "✅ ExcelJS 安装成功（淘宝镜像）"
    else
        echo "❌ 安装失败，请手动安装："
        echo "   npm install exceljs"
        echo "   或"
        echo "   yarn add exceljs"
        exit 1
    fi
fi
echo ""

# 验证安装
echo "3. 验证安装..."
if node -e "require('exceljs')" 2>/dev/null; then
    echo "✅ ExcelJS 验证成功"
else
    echo "❌ ExcelJS 验证失败"
    exit 1
fi
echo ""

# 检查修改的文件
echo "4. 检查修改的文件..."
files=(
    "src/server/services/enhancedExcelService.js"
    "src/server/services/excelGeneratorService.js"
    "src/server/utils/teacherExportService.js"
    "src/server/utils/studentExportService.js"
    "src/server/utils/advancedExportService.js"
)

all_exist=true
for file in "${files[@]}"; do
    if [ -f "$file" ]; then
        echo "✅ $file"
    else
        echo "❌ $file (未找到)"
        all_exist=false
    fi
done

if [ "$all_exist" = false ]; then
    echo ""
    echo "⚠️  警告：部分文件未找到，请确认代码已正确更新"
fi
echo ""

# 提示重启服务
echo "=========================================="
echo "✅ 部署完成！"
echo "=========================================="
echo ""
echo "下一步操作："
echo "1. 重启服务："
echo "   npm restart"
echo "   或"
echo "   pm2 restart plannix"
echo ""
echo "2. 测试导出功能："
echo "   - 登录教师/学生/管理员账号"
echo "   - 导出数据并检查 Excel 文件"
echo "   - 验证 Rich Text 格式是否正确"
echo ""
echo "3. 查看详细文档："
echo "   - EXCEL_RICH_TEXT_UPGRADE.md"
echo "   - EXCEL_RICH_TEXT_IMPLEMENTATION_SUMMARY.md"
echo ""
echo "如有问题，请查看服务器日志或联系开发团队。"
echo ""
