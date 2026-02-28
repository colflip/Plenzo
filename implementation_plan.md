# 优化班主任端学生排课管理及导出功能

对班主任角色的“学生课程安排”页面进行重命名、样式统一、权限修复及导出逻辑优化。

## 待解决的问题

1. **页面名称不统一**：侧边栏及页面标题需从“学生课程安排”改为“学生排课管理”。
2. **导出权限报错**：班主任导出数据时提示需要管理员权限。
3. **按钮样式不符**：导出按钮需参照同一行的“显示费用”按钮进行绿色背景重设计。
4. **导出弹窗冗余**：
    * 仅保留“老师排课记录”类型。
    * 学生筛选列表仅显示关联学生。
    * 若仅关联一个学生，则隐藏“全部学生”选项。

## 提请用户注意

> [!IMPORTANT]
> 导出逻辑调整：根据需求，将导出类型固定为“老师排课记录”（TEACHER_SCHEDULE），但在班主任端，该操作将映射到 `exportHeadTeacherStudentData` 接口，以导出其负责学生的排课记录。

## 拟定变更

### 前端 UI 调整

#### [MODIFY] [dashboard.html](file:///Users/zcolflip/code/schedule-widget/schedule-widget/public/teacher/dashboard.html)

- 修改侧边栏（Line 665 附近）及相关标题文本。
* 更新 `#exportTeacherStudentsBtn` 样式，移除 `btn-outline-primary`，应用与 `#toggleTeacherStudentFeeBtn` 一致的绿色背景（`#10b981`）及悬停效果。

#### [MODIFY] [student-schedules.js](file:///Users/zcolflip/code/schedule-widget/schedule-widget/public/js/modules/teacher/student-schedules.js)

- 修改 `exportTeacherStudents` 函数，将传参 `type: 'student_schedule'` 更改为 `type: 'teacher_schedule'` 以匹配需求中的“第三个”类型。

### 导出组件逻辑优化

#### [MODIFY] [export-dialog.js](file:///Users/zcolflip/code/schedule-widget/schedule-widget/public/js/components/export-dialog.js)

- **类型过滤**：在 `open` 方法或初始化逻辑中，若从班主任学生管理页面打开，则过滤 `EXPORT_TYPE_CONFIG` 仅保留 `TEACHER_SCHEDULE`。
* **学生列表优化**：修改 `loadStudentList` 内部的 `renderList`，增加逻辑：当 `list.length <= 1` 时不显示“全部学生”选项。
* **权限路由修复**：修改 `performExport` 中的 API 路由逻辑。确保当 `userType === 'teacher'` 且类型为 `TEACHER_SCHEDULE` 时，正确指向 `/api/teacher/student-schedules/export`（此前可能误指向了管理员接口或个人排课接口）。

## 验证计划

### 自动化测试

- 本项目暂无针对 UI 组件的自动化测试，将主要依靠手动验证。

### 手动验证

1. **角色登录**：以班主任角色登录系统。
2. **标题检查**：确认侧边栏显示“学生排课管理”。
3. **样式检查**：确认导出按钮为绿色背景，且与“显示费用”按钮对齐。
4. **弹窗检查**：
    * 点击导出，确认弹窗内仅有“老师排课记录”。
    * 检查学生下拉框，核实仅显示关联学生。
    * 若该老师仅有1名学生，确认无“全部学生”选项。
5. **功能检查**：执行导出，确认能成功下载 Excel 文件而不再提示管理员权限错误。
