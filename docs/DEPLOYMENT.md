# 部署上线指南

Plenzo 同时支持两种生产部署方式，可任选其一：

- **Vercel**：Serverless 部署，由 `api/index.js` 作为函数入口。
- **Render**：常驻 Node 进程部署，运行 `npm start`。

数据库使用托管 PostgreSQL（如 Neon）。

## 一、Vercel 部署

项目已包含 `vercel.json`，路由规则为：

- `/api/*` → `api/index.js`（加载 `src/server/app.js`）
- 其余路径 → `public/` 静态资源

### 步骤

1. 在 Vercel 控制台导入 GitHub 仓库 `colflip/plenzo`。
2. 框架预设选择 “Other”，无需构建命令（纯静态 + Serverless 函数）。
3. 配置环境变量（见下方[环境变量](#三环境变量)），至少 `DATABASE_URL` 与 `JWT_SECRET`。
4. 部署。Vercel 会自动注入 `VERCEL=1`，`app.js` 据此以 Serverless 模式导出。

## 二、Render 部署

1. 在 Render 创建 Web Service，连接 GitHub 仓库。
2. 构建命令：`npm install`
3. 启动命令：`npm start`
4. 配置环境变量（至少 `DATABASE_URL`、`JWT_SECRET`、`NODE_ENV=production`）。
5. Render 注入 `RENDER=true`，服务以常驻进程监听 `PORT`。

## 三、环境变量

完整变量见根目录 `.env.example`。关键项：

| 变量 | 说明 | 必需 |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL 连接字符串 | 是 |
| `JWT_SECRET` | JWT 签名密钥（生产务必更换） | 是 |
| `NODE_ENV` | `production` / `development` | 建议 |
| `PORT` | 服务端口（默认 3001） | 否 |
| `DB_SSL` | 数据库 SSL（云端通常 true） | 否 |
| `DB_DRIVER` | 数据库驱动（如 `neon`） | 否 |
| `DB_POOL_MAX` | 连接池上限 | 否 |
| `JWT_EXPIRES_IN` / `JWT_REMEMBER_EXPIRES_IN` | 令牌有效期（默认 24h / 30d） | 否 |
| `REQUIRE_STRONG_PASSWORD` | 是否强制强密码 | 否 |
| `RATE_LIMIT_*` / `LOGIN_RATE_LIMIT_MAX` | 限流配置 | 否 |
| `OFFLINE_DEV` | 离线开发模式（不连数据库） | 否 |

> CORS 白名单在 `src/server/middleware/security.js` 中维护，生产环境会校验请求来源。新增线上域名时需同步更新该列表。

## 四、数据库初始化与迁移

- **全新初始化**：在目标数据库执行 `src/server/db/schema.sql` 建表。
- **结构迁移**：迁移是**应用启动时自动执行**的幂等操作（见 `src/server/db/migrations.js`），无需手动运行脚本。迁移先检测列/约束是否存在再决定变更，可重复执行；失败仅记录日志、不阻断启动。
- **一次性补充迁移**：如需手动执行个别变更，可参考 `scripts/migrate.js`（从 `.env` 的 `DATABASE_URL` 读取连接串）。

## 五、部署后验证

部署完成后访问健康检查端点确认状态：

```bash
curl https://<your-domain>/api/health      # 整体状态（含数据库）
curl https://<your-domain>/api/health/ready # 就绪探针
```

返回 `status: ok` 即表示服务与数据库正常。
