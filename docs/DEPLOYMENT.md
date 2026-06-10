# 部署上线指南

## 部署方式

本项目支持多种部署方式：

1. **Netlify** (推荐用于前端静态资源)
2. **Docker** (容器化部署)
3. **传统 Node.js 部署**

## Netlify 部署

项目已配置 `netlify.toml`，可直接连接到 GitHub 仓库进行自动部署。

### 配置步骤

1. 在 Netlify 控制台创建新站点
2. 连接到项目的 GitHub 仓库
3. 构建设置：
   - 构建命令: `npm run build`
   - 发布目录: `public`
4. 设置环境变量：
   - `DATABASE_URL`: PostgreSQL 连接字符串
   - `JWT_SECRET`: JWT 密钥
   - `PORT`: 服务端口（默认3000）

## Docker 部署

项目包含 `Dockerfile`，可用于构建 Docker 镜像。

### 构建镜像

```bash
docker build -t plannix .
```

### 运行容器

```bash
docker run -d \
  --name plannix \
  -p 3000:3000 \
  -e DATABASE_URL=your_database_url \
  -e JWT_SECRET=your_jwt_secret \
  plannix
```

## 传统 Node.js 部署

### 环境要求

- Node.js >= 18
- PostgreSQL >= 12

### 部署步骤

1. 克隆代码库
2. 安装依赖：
   ```bash
   npm install
   ```
3. 配置环境变量（复制 `.env.example` 为 `.env` 并填写相应值）
4. 运行数据库迁移（如果需要）：
   ```bash
   ./run-migration.sh
   ```
5. 启动服务：
   ```bash
   npm start
   ```

## 环境变量说明

| 变量名 | 说明 | 必需 |
|--------|------|------|
| DATABASE_URL | PostgreSQL 连接字符串 | 是 |
| JWT_SECRET | JWT 密钥 | 是 |
| PORT | 服务端口 | 否（默认3000） |
| OFFLINE_DEV | 离线开发模式 | 否 |

## 数据库迁移

在部署新版本时，如果涉及数据库结构变更，需要运行相应的迁移脚本。

查看 `MIGRATION_GUIDE.md` 获取详细信息。