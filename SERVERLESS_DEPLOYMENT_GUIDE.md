# Serverless 环境部署指南

## 🚀 快速部署

### 1. 提交代码
```bash
git add .
git commit -m "Fix: Excel export with ExcelJS and Rich Text support for Serverless"
git push
```

### 2. 部署到 Vercel
```bash
vercel --prod
```

### 3. 部署到 Render
Render 会自动检测 git push 并部署。

---

## 📋 部署后验证步骤

### 步骤 1: 查看部署日志

#### Vercel
```bash
vercel logs --follow
```
或访问: https://vercel.com/dashboard → 项目 → Deployments → 最新部署 → Functions

#### Render
访问: https://dashboard.render.com → 服务 → Logs

### 步骤 2: 测试导出功能

1. **登录管理员账号**
2. **选择"老师授课记录"**
3. **选择小范围日期**（建议先测试 1-7 天）
4. **点击"导出 Excel"**
5. **观察以下内容：**

#### 前端控制台应该看到：
```
正在导出...
正在生成文件...
文件生成完成，正在下载...
导出成功
```

#### 服务器日志应该看到：
```
[AdminController] 准备发送多Sheet Excel文件: [xxx]授课记录_[2024-01-01_2024-01-07]_xxx.xlsx
[AdminController] 数据sheets: [ '课程安排（按时间段）', '总览表', '明细信息表' ]
[ExcelGenerator] 开始生成 Excel 文件: [xxx]授课记录_[2024-01-01_2024-01-07]_xxx.xlsx
[ExcelGenerator] 数据类型: object
[ExcelGenerator] 生成多Sheet Excel, sheets: [ '课程安排（按时间段）', '总览表', '明细信息表' ]
[ExcelGenerator] Buffer 生成成功, 大小: 12345 bytes
[ExcelGenerator] 响应头已设置，开始发送文件
[ExcelGenerator] 文件发送完成
[AdminController] Excel文件发送成功
```

### 步骤 3: 验证文件内容

1. **打开下载的 Excel 文件**
2. **检查工作表：**
   - ✅ 课程安排（按时间段）
   - ✅ 总览表
   - ✅ 明细信息表

3. **检查 Rich Text 格式：**
   - ✅ [已取消] 显示为红色斜体删除线
   - ✅ [新增] 显示为绿色加粗
   - ✅ 正常课程显示为黑色
   - ✅ 多个课程用分号（；）分隔

---

## ⚠️ 常见问题排查

### 问题 1: 仍然报"导出 API 返回为空"

**检查清单：**
1. ✅ 确认代码已推送到 git
2. ✅ 确认 Vercel/Render 已完成部署
3. ✅ 清除浏览器缓存（Ctrl+Shift+R）
4. ✅ 查看服务器日志中的错误信息

**查看日志：**
```bash
# Vercel
vercel logs --follow

# Render
# 在 Dashboard 的 Logs 标签页查看
```

### 问题 2: 部署成功但导出失败

**可能原因：**
- ExcelJS 未正确安装
- 内存不足
- 执行超时

**解决方案：**

#### 检查 ExcelJS 是否安装
在部署日志中查找：
```
Installing dependencies...
✓ exceljs@4.4.0
```

如果没有，确保 `package.json` 包含：
```json
{
  "dependencies": {
    "exceljs": "^4.4.0"
  }
}
```

#### 检查内存使用
在服务器日志中查找：
```
JavaScript heap out of memory
```

如果出现，需要：
- 减少导出日期范围
- 升级到付费计划

#### 检查执行超时
在服务器日志中查找：
```
Function execution timed out
```

如果出现（Vercel Free 限制 10 秒），需要：
- 减少导出数据量
- 升级到 Pro 计划（60 秒）

### 问题 3: 文件下载但无法打开

**可能原因：**
- Buffer 生成不完整
- 响应被截断

**解决方案：**
查看服务器日志，确认：
```
[ExcelGenerator] Buffer 生成成功, 大小: xxx bytes
[ExcelGenerator] 文件发送完成
```

如果日志不完整，可能是响应被中断。

---

## 🔧 环境限制和建议

### Vercel Free 限制
- **内存**: 1024 MB
- **执行时间**: 10 秒
- **建议**: 导出数据不超过 30 天

### Render Free 限制
- **内存**: 512 MB
- **执行时间**: 无限制
- **建议**: 导出数据不超过 15 天

### 优化建议

#### 1. 添加前端提示
在导出对话框中添加：
```
⚠️ Serverless 环境下，建议导出时间范围不超过 30 天
```

#### 2. 限制日期范围
在服务器端添加验证：
```javascript
// 在 advancedExportService.js 中
const MAX_DATE_RANGE = process.env.VERCEL ? 30 : 365;
```

#### 3. 分批导出
对于大数据量，建议用户分多次导出：
- 第一次：1-15 日
- 第二次：16-30 日

---

## 📊 性能基准

### 测试数据（本地）
- **100 行数据**: ~7 KB, ~50ms
- **1000 行数据**: ~70 KB, ~500ms
- **内存使用**: ~12-20 MB

### Serverless 环境预估
- **1 天数据** (约 10-50 行): ✅ 正常
- **7 天数据** (约 70-350 行): ✅ 正常
- **30 天数据** (约 300-1500 行): ⚠️ 可能较慢
- **90 天数据** (约 900-4500 行): ❌ 可能超时/内存不足

---

## 🎯 成功标准

部署成功的标志：

1. ✅ 部署日志显示 ExcelJS 安装成功
2. ✅ 导出 1-7 天数据成功
3. ✅ Excel 文件可以正常打开
4. ✅ Rich Text 格式正确显示
5. ✅ 服务器日志无错误
6. ✅ 前端无"返回为空"错误

---

## 📞 获取帮助

如果问题仍未解决，请提供：

1. **部署平台**: Vercel 或 Render
2. **完整的服务器日志**（从开始导出到结束）
3. **浏览器控制台截图**
4. **导出参数**：
   - 导出类型
   - 日期范围
   - 预估记录数

---

**部署日期:** 2026-05-31  
**版本:** v2.1.0  
**状态:** 已添加 Serverless 支持和诊断日志
