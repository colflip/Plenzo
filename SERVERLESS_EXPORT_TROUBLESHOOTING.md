# Serverless 环境（Vercel/Render）导出问题诊断指南

## 问题现象

在 Vercel 或 Render 部署后，导出功能报错：
```
导出失败: 导出 API 返回为空
```

## Serverless 环境特殊性

### 1. 内存限制
- **Vercel Free**: 1024 MB
- **Render Free**: 512 MB
- **问题**: ExcelJS 生成大文件时可能超出内存限制

### 2. 执行时间限制
- **Vercel Free**: 10 秒
- **Render Free**: 无限制（但有 CPU 限制）
- **问题**: 生成大量数据的 Excel 可能超时

### 3. 冷启动
- **问题**: 首次请求需要加载 ExcelJS 库，可能超时

## 已添加的诊断日志

### 服务器端日志

现在会输出详细日志，帮助诊断问题：

```javascript
[AdminController] 准备发送多Sheet Excel文件: xxx.xlsx
[AdminController] 数据sheets: ['课程安排（按时间段）', '总览表', '明细信息表']
[ExcelGenerator] 开始生成 Excel 文件: xxx.xlsx
[ExcelGenerator] 数据类型: object
[ExcelGenerator] 生成多Sheet Excel, sheets: [...]
[ExcelGenerator] Buffer 生成成功, 大小: 12345 bytes
[ExcelGenerator] 响应头已设置，开始发送文件
[ExcelGenerator] 文件发送完成
[AdminController] Excel文件发送成功
```

### 如何查看日志

#### Vercel
```bash
# 实时日志
vercel logs --follow

# 或在 Vercel Dashboard
# 项目 -> Deployments -> 点击部署 -> Functions -> 查看日志
```

#### Render
```bash
# 在 Render Dashboard
# 服务 -> Logs 标签页
```

## 诊断步骤

### 步骤 1: 检查 ExcelJS 是否正确安装

在 `package.json` 中确认：
```json
{
  "dependencies": {
    "exceljs": "^4.4.0"
  }
}
```

### 步骤 2: 检查部署日志

查看部署时是否成功安装 ExcelJS：
```
Installing dependencies...
✓ exceljs@4.4.0
```

### 步骤 3: 测试小数据量导出

先测试导出少量数据（如 1-7 天的记录），看是否成功。

### 步骤 4: 查看运行时日志

导出时查看服务器日志，找到具体错误信息。

## 常见问题和解决方案

### 问题 1: 内存不足

**症状:**
```
[ExcelGenerator] 生成 Excel 失败: JavaScript heap out of memory
```

**解决方案:**
1. 限制导出数据量（最多 30 天）
2. 升级到付费计划（更大内存）
3. 使用流式导出（需要重构代码）

### 问题 2: 执行超时

**症状:**
```
Error: Function execution timed out after 10s
```

**解决方案 (Vercel):**
1. 升级到 Pro 计划（60秒超时）
2. 减少导出数据量
3. 优化 Excel 生成逻辑

### 问题 3: ExcelJS 未安装

**症状:**
```
Error: Cannot find module 'exceljs'
```

**解决方案:**
```bash
# 确保 package.json 中有 exceljs
npm install exceljs --save

# 提交并重新部署
git add package.json package-lock.json
git commit -m "Add exceljs dependency"
git push
```

### 问题 4: 响应为空

**症状:**
- 前端收到空响应
- 服务器日志显示成功

**可能原因:**
- 响应在发送前被中断
- Serverless 函数提前终止

**解决方案:**
检查是否正确使用 `await`：
```javascript
// ✅ 正确
return await excelGenerator.sendExcelResponse(res, data, filename);

// ❌ 错误
return excelGenerator.sendExcelResponse(res, data, filename);
```

## 优化建议

### 1. 添加数据量限制

```javascript
// 在 advancedExportService.js 中
validateDateRange(startDate, endDate) {
    // Serverless 环境限制为 30 天
    const MAX_DAYS = process.env.VERCEL ? 30 : 365;
    
    const daysDiff = Math.floor((end - start) / (1000 * 60 * 60 * 24));
    if (daysDiff > MAX_DAYS) {
        throw new Error(`日期范围不能超过 ${MAX_DAYS} 天`);
    }
}
```

### 2. 添加超时提示

在前端添加提示：
```javascript
// 如果是 Serverless 环境，显示警告
if (isServerless) {
    showWarning('Serverless 环境下，建议导出时间范围不超过 30 天');
}
```

### 3. 考虑异步导出

对于大数据量：
1. 后台生成文件
2. 上传到云存储（S3/OSS）
3. 返回下载链接

## 测试清单

部署到 Vercel/Render 后，按以下顺序测试：

- [ ] 测试 1: 导出 1 天数据
- [ ] 测试 2: 导出 7 天数据
- [ ] 测试 3: 导出 30 天数据
- [ ] 测试 4: 查看服务器日志
- [ ] 测试 5: 检查文件大小和格式
- [ ] 测试 6: 验证 Rich Text 格式

## 临时回退方案

如果 ExcelJS 在 Serverless 环境中无法正常工作，可以临时回退到 `xlsx`：

1. 恢复 `enhancedExcelService.js` 到旧版本
2. 移除 Rich Text 功能
3. 使用简单的文本标记（如 [已取消]）

## 联系支持

如果问题持续存在，请提供：
1. 部署平台（Vercel/Render）
2. 完整的服务器日志
3. 导出的数据量（日期范围、记录数）
4. 浏览器控制台错误信息

---

**更新日期:** 2026-05-31  
**适用环境:** Vercel, Render, AWS Lambda, Google Cloud Functions
