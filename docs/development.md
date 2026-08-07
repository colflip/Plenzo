# 本地开发指南

## 环境要求

- Node.js >= 18
- PostgreSQL >= 12（或托管的 Neon 实例）
- npm

## 安装

```bash
git clone https://github.com/colflip/plenzo.git
cd plenzo
npm install
```

## 配置环境变量

复制示例文件并填写：

```bash
cp .env.example .env
```

至少需要配置 `DATABASE_URL` 与 `JWT_SECRET`。数据库在所有环境默认优先使用 pg Pool；当 `DATABASE_URL` 指向 Neon 且发生连接类错误时，会自动切换到 Neon HTTP。变量完整说明见 [deployment.md](./deployment.md#三环境变量)。

## 初始化数据库

在目标数据库执行建表脚本：

```bash
psql "$DATABASE_URL" -f src/server/db/schema.sql
```

后续结构变更由应用启动时自动迁移（见 [deployment.md](./deployment.md#四数据库初始化与迁移)），无需手动操作。

## 运行

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 开发模式（nodemon 热重载），默认端口 3001 |
| `npm start` | 生产模式启动 |

启动后访问：

- 登录页：`http://localhost:3001/`
- 管理员端：`/admin/dashboard`
- 教师端：`/teacher/dashboard`
- 学生端：`/student/dashboard`

## 测试

| 命令 | 说明 |
| :--- | :--- |
| `npm test` | 运行 Jest 单元测试 |
| `npm run test:unit` | 单元测试（无用例时不报错） |
| `npm run test:visual:chromium` | BackstopJS 视觉回归（Chromium） |
| `npm run test:visual:firefox` | 视觉回归（Firefox） |
| `npm run test:visual:webkit` | 视觉回归（WebKit） |
| `npm run approve:visual` | 接受视觉回归基准 |

测试文件位于 `src/server/**/__tests__/` 与 `*.test.js`。

## 脚本

`scripts/` 目录下的运维脚本（已被 `.gitignore` 忽略，仅本地使用）：

- `migrate.js`：一次性数据库迁移示例，从 `.env` 的 `DATABASE_URL` 读取连接串。
- `deploy-excel-richtext.sh`：导出功能相关部署辅助脚本。

## 代码规范

### 核心原则

1. **KISS**: 避免过度设计，代码应直观易读。
2. **中文优先**: 所有注释、文档、Git Commit Message 使用**简体中文**。
3. **单一职责**: 每个函数、类、模块只做一件事。

### 命名规范

| 类型 | 规范 | 示例 |
| :--- | :--- | :--- |
| 变量/函数 | `camelCase` | `currentUser`, `getUserData()` |
| 类/组件 | `PascalCase` | `ScheduleService`, `ModalComponent` |
| 常量 | `UPPER_SNAKE_CASE` | `MAX_RETRY_COUNT` |
| 后端文件 | `camelCase.js` | `admin-controller.js` |
| 前端文件 | `kebab-case.js` | `api-client.js` |
| 测试文件 | `*.test.js` | `auth-service.test.js` |

### JSDoc 注释

所有函数、类、复杂逻辑块**必须**包含 JSDoc 格式的中文注释：

```javascript
/**
 * 计算两个时间段的重叠时长
 * @description 用于检测课程安排是否冲突，返回重叠的分钟数。
 * @param {string} start1 - 时间段1开始时间 (HH:mm)
 * @param {string} end1   - 时间段1结束时间 (HH:mm)
 * @param {string} start2 - 时间段2开始时间 (HH:mm)
 * @param {string} end2   - 时间段2结束时间 (HH:mm)
 * @returns {number} 重叠的分钟数，如果没有重叠则返回 0
 */
function calculateOverlap(start1, end1, start2, end2) { ... }
```

### 后端分层 (MVC-S)

| 层 | 职责 | 禁忌 |
| :--- | :--- | :--- |
| **Routes** | URL 路由定义，仅分发 | 不含业务逻辑 |
| **Controllers** | HTTP 请求处理、参数解析、响应格式化 | 不含核心业务逻辑 |
| **Services** | 业务逻辑、数据库交互、算法 | 不依赖 HTTP 上下文 |
| **Validators** | Joi 验证 Schema | — |

### Git 提交规范

格式: `<type>(<scope>): <subject>`

Type: `feat` | `fix` | `docs` | `style` | `refactor` | `perf` | `test` | `chore`

完整规范见 [CLAUDE.md](../CLAUDE.md)。
