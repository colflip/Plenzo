# Plenzo

[![version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=flat-square)](https://github.com/colflip/Plenzo) [![license](https://img.shields.io/badge/license-CC--BY--NC--4.0-green.svg?style=flat-square)](./LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org) [![express](https://img.shields.io/badge/express-4.18.x-000000.svg?style=flat-square)](https://expressjs.com) [![postgresql](https://img.shields.io/badge/postgresql-supported-336791.svg?style=flat-square)](https://www.postgresql.org)

Plenzo 是一套面向教育排课场景的多角色调度管理系统。它使用原生 JavaScript、静态 HTML、Express 和 PostgreSQL 构建，提供管理员、教师、学生三端工作台，并集成 AI 查询与操作辅助、排课冲突管理、空闲时段维护、统计和数据导出。

> 本仓库采用“生产可运行的最小文件集”策略。测试、详细文档、维护脚本、手工 SQL、覆盖率报告和本地归档保留在开发环境，不进入生产仓库。

## 功能概览

### 管理员端

- 教师和学生资料管理
- 排课创建、编辑、移动、删除和状态维护
- 课程类型、节假日、反馈及系统设置管理
- 教师/学生空闲时段代设
- 排课统计、费用信息和 Excel/CSV 导出
- AI 模型配置、连接检测和数据助手

### 教师端

- 个人资料和空闲时段维护
- 个人课表、统计及学生课表查看
- 排课状态确认和导出
- 支持按权限使用 AI 助手

### 学生端

- 个人资料和空闲时段维护
- 个人课表、概览和统计查看
- 权限过滤后的排课导出
- 支持按权限使用 AI 助手

### AI 能力

- 兼容 OpenAI Chat Completions 与 Anthropic Messages 两类协议
- 支持 OpenAI、DeepSeek、通义千问、Anthropic、Mistral 及自定义兼容网关
- 按管理员、教师、学生角色暴露不同的查询和操作工具
- 支持排课查询、统计、可用时段分析及带确认步骤的排课操作
- 模型支持时可上传图片；单次最多 5 张、每张不超过 5 MB
- 前端保留最近 30 条对话上下文

## 技术架构

| 模块 | 技术 |
| --- | --- |
| 前端 | Native JavaScript ES Modules + Static HTML + CSS |
| 服务端 | Node.js + Express |
| 数据库 | PostgreSQL；支持 Neon HTTP 与标准 `pg` Pool |
| 认证与权限 | JWT + Bcrypt + RBAC |
| AI | OpenAI-compatible / Anthropic Messages + Tool Calling |
| 导出 | ExcelJS；支持排课 Excel、信息 Excel/CSV 和前端图片导出 |
| 安全 | Helmet + CORS + Joi + Rate Limit |
| 定时任务 | node-cron |
| 测试 | Jest + BackstopJS（开发资产，不进入生产仓库） |

服务端按以下职责组织：

```text
Routes -> Controllers -> Services -> DB
```

前端统一使用：

- `public/js/core/api-client.js`：请求、令牌和错误处理
- `public/js/core/event-bus.js`：跨模块资源变更通知
- `public/js/core/sync-guards.js`：请求竞态保护和重复写入锁
- `public/js/core/schedule-types-store.js`：课程类型缓存

## 生产仓库结构

```text
plenzo/
├── api/
│   └── index.js                 # Vercel Serverless 入口
├── public/
│   ├── admin/
│   ├── teacher/
│   ├── student/
│   ├── css/
│   ├── js/
│   └── assets/
├── src/server/
│   ├── controllers/
│   ├── data/
│   ├── db/
│   │   ├── db.js
│   │   └── migrations.js        # 启动期运行迁移，不能删除
│   ├── jobs/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   ├── utils/
│   ├── validators/
│   └── app.js
├── package.json
├── package-lock.json
├── vercel.json
├── LICENSE
└── README.md
```

`src/server/data/ai-models.json` 和 `src/server/db/migrations.js` 均由运行时代码读取，属于生产文件。

## 环境要求

- Node.js `>= 18`
- npm `>= 8`
- PostgreSQL 数据库，或 Neon PostgreSQL

## 本地运行

```bash
npm ci
# 在项目根目录创建 .env，并按下方“必要环境变量”填写
npm run dev
```

默认地址：`http://localhost:3001`

生产方式启动：

```bash
NODE_ENV=production npm start
```

生产环境必须使用不少于 32 个字符的高强度 `JWT_SECRET`，不能使用示例值。

## 必要环境变量

最小配置：

```dotenv
DATABASE_URL=postgresql://user:password@host:5432/database
DB_CONNECTION_TYPE=auto
NODE_ENV=production
JWT_SECRET=replace-with-a-strong-random-secret
```

数据库连接模式：

- `auto`：开发环境默认 Neon HTTP；生产环境根据 `DB_DRIVER` 和连接地址判断
- `http` / `neon`：强制使用 Neon HTTP
- `pool` / `pg`：强制使用标准 PostgreSQL 连接池

启用 AI 时还需配置：

```dotenv
AI_ENABLED=true
AI_PROVIDER=mistral
AI_PROTOCOL=openai
AI_API_KEY=your-api-key
AI_BASE_URL=https://api.mistral.ai/v1
AI_MODEL=mistral-small-latest
```

其他可选变量包括 `PORT`、JWT 有效期、数据库重试与连接池参数、限流参数以及 AI 超时和最大 Token 数。不要提交真实 `.env` 或任何密钥。

## 常用命令

```bash
npm start                  # 启动生产服务
npm run dev                # 使用 nodemon 启动开发服务
npm test                   # 运行默认 Jest 测试
npm run test:integration   # 运行需要测试数据库的集成/性能测试
npm run test:coverage      # 生成覆盖率报告
```

生产部署建议只安装生产依赖：

```bash
npm ci --omit=dev
```

## 部署

### Vercel

仓库已提供：

- `api/index.js`：Serverless Express 入口
- `vercel.json`：API/静态资源重写与缓存、安全响应头配置

在 Vercel 项目环境变量中配置数据库、JWT 和可选 AI 参数后部署。不要上传本地 `.env`。

### Render、Railway 或传统 Node 宿主

- 安装命令：`npm ci --omit=dev`
- 启动命令：`npm start`
- 设置 `NODE_ENV=production`
- 由平台注入 `PORT`、`DATABASE_URL`、`JWT_SECRET` 等环境变量

非 Vercel 环境启动时，服务会预热数据库、执行幂等运行期迁移并初始化定时任务。数据库不可用不会返回伪造的业务数据；相关接口会明确报告错误状态。

## 健康检查

| 路径 | 用途 |
| --- | --- |
| `/api/health` | 综合健康状态和数据库延迟 |
| `/api/health/db` | 数据库连接检查 |
| `/api/health/live` | 存活检查 |
| `/api/health/ready` | 就绪检查 |

## 安全说明

- 生产环境拒绝弱或缺失的 `JWT_SECRET`
- 使用单层可信代理设置获取真实客户端 IP，供登录和 API 限流使用
- API 响应禁用缓存；静态资源采用版本参数和缓存策略
- JWT、数据库连接串、AI Key 等敏感信息必须通过部署平台环境变量管理

## License

本项目采用 [Creative Commons Attribution-NonCommercial 4.0 International](./LICENSE) 许可。

允许在署名并遵守许可证条款的前提下进行非商业使用；商业用途需另行获得授权。
