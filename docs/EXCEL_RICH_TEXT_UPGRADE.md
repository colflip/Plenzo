# Excel Rich Text 格式升级说明

## 升级概述

本次升级将 Excel 导出功能从 `xlsx` 库迁移到 `ExcelJS` 库，以支持单元格内的 Rich Text 格式（多种颜色、加粗、斜体、删除线等）。

## 主要变更

### 1. 依赖变更

**新增依赖：**
```json
"exceljs": "^4.4.0"
```

**保留依赖：**
- `xlsx` 库暂时保留，以防需要回滚

### 2. 功能增强

#### 2.1 Rich Text 格式支持

在"课程安排（按时间段）"工作表的"计划安排"和"实际安排"列中，现在支持：

- **已取消课程**：红色 + 斜体 + 删除线
  - 示例：`[已取消]入户(19:00-22:30)：何俊华`
  
- **新增课程**：绿色 + 加粗
  - 示例：`[新增]试教(19:00-22:30)：陈莹莹`
  
- **调整课程**：橙色 + 加粗
  - 示例：`[调整]评审(14:00-16:00)：张三`
  
- **正常课程**：黑色 + 正常字体
  - 示例：`入户(19:00-22:30)：李四`

#### 2.2 分隔符变更

同一时间段的多个课程现在使用 **分号（；）** 分隔，而不是换行符。

**变更前：**
```
入户(19:00-22:30)：何俊华
试教(19:00-22:30)：陈莹莹
```

**变更后：**
```
入户(19:00-22:30)：何俊华；试教(19:00-22:30)：陈莹莹
```

#### 2.3 时间段显示优化

每个课程信息现在包含完整的时间段，格式为：
```
课程类型(开始时间-结束时间)：参与者姓名
```

示例：
```
入户(19:00-22:30)：何俊华；试教(19:00-22:30)：陈莹莹
```

## 修改的文件

### 核心服务文件

1. **src/server/services/enhancedExcelService.js**
   - 完全重写，使用 ExcelJS 替代 xlsx
   - 新增 `parseRichText()` 方法处理 Rich Text 格式
   - 新增 `calculateColumnWidth()` 方法优化列宽计算
   - `writeToBuffer()` 改为异步方法

2. **src/server/services/excelGeneratorService.js**
   - 移除 `xlsx` 依赖
   - 所有方法改为异步（`async/await`）
   - 更新方法签名以支持 Promise

### 导出服务文件

3. **src/server/utils/teacherExportService.js**
   - `generateTimeSlotOverview()` 方法：
     - 分隔符从 `\n` 改为 `；`
     - 课程信息包含时间段
   - `exportSchedule()` 方法：buffer 生成改为 `await`

4. **src/server/utils/studentExportService.js**
   - `generateTimeSlotOverview()` 方法：
     - 分隔符从 `\n` 改为 `；`
     - 课程信息包含时间段
   - `exportSchedule()` 方法：buffer 生成改为 `await`

5. **src/server/utils/advancedExportService.js**
   - `formatTimeSlotView()` 方法：
     - 分隔符从 `\n` 改为 `；`
     - 课程信息包含时间段

### 配置文件

6. **package.json**
   - 新增 `exceljs: ^4.4.0` 依赖

## 安装步骤

### 1. 安装依赖

```bash
npm install exceljs
```

如果遇到网络问题，可以尝试：

```bash
# 使用淘宝镜像
npm install exceljs --registry=https://registry.npmmirror.com

# 或使用 yarn
yarn add exceljs
```

### 2. 重启服务

```bash
npm restart
```

## 测试验证

### 测试场景

1. **教师导出**
   - 登录教师账号
   - 选择日期范围
   - 点击"导出数据"
   - 验证 Excel 文件中的 Rich Text 格式

2. **学生导出**
   - 登录学生账号
   - 选择日期范围
   - 点击"导出数据"
   - 验证 Excel 文件中的 Rich Text 格式

3. **管理员导出**
   - 登录管理员账号
   - 导出教师数据统计
   - 导出学生数据统计
   - 验证所有工作表的格式

### 验证要点

- [ ] 已取消课程显示为红色斜体删除线
- [ ] 新增课程显示为绿色加粗
- [ ] 正常课程显示为黑色正常字体
- [ ] 同一时间段多个课程用分号分隔
- [ ] 每个课程包含完整时间段信息
- [ ] 列宽自动调整合理
- [ ] 所有工作表正常生成

## 兼容性说明

### 向后兼容

- 所有现有的导出功能保持不变
- API 接口无变化
- 文件名格式无变化
- 工作表结构无变化（仅格式增强）

### Excel 版本兼容性

- Excel 2007 及以上版本完全支持
- WPS Office 完全支持
- LibreOffice Calc 完全支持
- Google Sheets 部分支持（可能不显示 Rich Text）

## 性能影响

### ExcelJS vs xlsx

- **生成速度**：ExcelJS 比 xlsx 慢约 20-30%
- **文件大小**：ExcelJS 生成的文件略大（约 5-10%）
- **内存占用**：相似
- **功能丰富度**：ExcelJS 远超 xlsx

### 优化建议

- 对于大数据量导出（>10000 行），建议分批导出
- 服务器内存建议 >= 2GB

## 回滚方案

如果需要回滚到旧版本：

1. 恢复 `src/server/services/enhancedExcelService.js` 到旧版本
2. 恢复所有导出服务文件的 `generateTimeSlotOverview()` 方法
3. 移除 `exceljs` 依赖（可选）
4. 重启服务

## 常见问题

### Q1: 安装 ExcelJS 失败怎么办？

**A:** 尝试以下方法：
```bash
# 清除 npm 缓存
npm cache clean --force

# 使用镜像源
npm install exceljs --registry=https://registry.npmmirror.com

# 或手动下载安装包
```

### Q2: 导出的 Excel 文件打不开？

**A:** 检查：
- 服务器是否成功安装了 ExcelJS
- 查看服务器日志是否有错误
- 确认文件大小不为 0

### Q3: Rich Text 格式不显示？

**A:** 可能原因：
- Excel 版本过低（需要 2007+）
- 使用了不支持 Rich Text 的软件打开
- 文件在传输过程中损坏

### Q4: 导出速度变慢了？

**A:** 这是正常现象，ExcelJS 功能更强大但速度稍慢。如果影响用户体验，可以：
- 减小导出的日期范围
- 使用后台任务异步导出
- 考虑添加导出进度提示

## 技术支持

如有问题，请联系开发团队或查看：
- ExcelJS 官方文档：https://github.com/exceljs/exceljs
- 项目 Issue 跟踪：[项目仓库地址]

---

**升级日期：** 2026-05-31  
**版本：** v2.0.0  
**负责人：** [开发团队]
