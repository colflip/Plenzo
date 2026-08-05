# Plenzo

[![version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=flat-square)](https://github.com/colflip/Plenzo) [![license](https://img.shields.io/badge/license-CC--BY--NC--4.0-green.svg?style=flat-square)](https://github.com/colflip/Plenzo/blob/master/LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org) [![express](https://img.shields.io/badge/express-4.18.x-000000.svg?style=flat-square)](https://expressjs.com) [![postgresql](https://img.shields.io/badge/postgresql-supported-336791.svg?style=flat-square)](https://www.postgresql.org)

一款面向复杂资源配置的 **AI-Native** 决策与调度引擎，基于 `PostgreSQL` 与 `JWT` 无状态认证构建，采用 *RBAC* 多角色权限控制。

系统采用前后端分离架构：服务端基于 `Express.js` 提供 RESTful 接口，遵循 **Routes → Controllers → Services → DB** 四层分层设计；客户端以原生 JavaScript ES Modules 构建 SPA，并采用 *Glassmorphism* 拟态设计语言。系统面向*管理员*、*教师*和*学生*提供差异化功能：教师端支持可用时段管理、工时统计、课程处理与学生调度；学生端支持可用时段管理、课表查看、概览与统计查询；管理员端涵盖人员与课程类型管理、调度管理、冲突检测、批量编排、费用审计及数据导出。认证采用 `JWT + Bcrypt`，安全层集成 `Helmet`、`CORS`、`Joi` 校验与请求限流。

**✨ AI 功能**：系统采用 **LLM Tool Calling** 架构集成 AI 能力。服务层通过统一的 LLM 适配器与*协议翻译层*，为上层提供一致的请求和响应结构，并支持多模型供应商及自定义兼容网关。AI 控制器内置 **15+ 工具函数**，覆盖调度、查询、统计与管理等场景；涉及数据写入时，采用“预览与确认”机制，在执行前向用户确认变更。前端助手支持模型能力检测、多模态输入（Vision API）、`30` 轮上下文，以及会话持久化与历史回溯。

数据模型遵循 `3NF`，以 `teachers`、`students`、`course_arrangement` 为核心实体，通过*外键约束*维护*引用完整性*。时段数据采用时间区间建模，审计表通过 `Provenance Tracking` 保障操作可追溯性。数据库层基于 `SchemaHelper` 进行动态结构检测，并结合 `JSONB` 支持灵活扩展；连接层采用标准 PostgreSQL `pg` 连接池。

```
plenzo/
├── api/
│   └── index.js
├── public/
│   ├── admin/
│   ├── student/
│   ├── teacher/
│   ├── assets/
│   ├── css/
│   │   ├── components/
│   │   ├── core/
│   │   └── modules/
│   ├── js/
│   │   ├── components/
│   │   ├── core/
│   │   ├── libs/
│   │   ├── modules/
│   │   │   ├── admin/
│   │   │   ├── shared/
│   │   │   ├── student/
│   │   │   └── teacher/
│   │   └── utils/
│   ├── 404.html
│   └── index.html
├── src/server/
│   ├── controllers/
│   ├── data/
│   ├── db/
│   │   ├── db.js
│   │   └── migrations.js
│   ├── jobs/
│   ├── middleware/
│   ├── routes/
│   ├── services/
│   │   └── export/
│   ├── utils/
│   ├── validators/
│   └── app.js
├── .gitignore
├── LICENSE
├── README.md
├── package.json
├── package-lock.json
└── vercel.json
```

## 技术栈

| 模块 | 技术栈 |
| :--- | :--- |
| 前端 | Native JavaScript ES Modules + Static HTML SPA + CSS3 Glassmorphism |
| 服务端 | Node.js + Express.js + RESTful API |
| 数据库 | PostgreSQL + `pg` Pool + JSONB + SchemaHelper |
| 认证与权限 | JWT + Bcrypt + RBAC |
| AI | OpenAI-compatible / Anthropic Messages + Tool Calling + Vision API |
| 数据导出 | ExcelJS + CSV + html2canvas + Clipboard API |
| 数据同步 | API Client + Event Bus + Request Guards + Client-side Cache |
| 定时任务 | node-cron |
| 安全 | Helmet + CORS + Joi + express-rate-limit |
| 测试 | Jest + BackstopJS |

本项目基于 [CC BY-NC 4.0](./LICENSE) 开源。

---

An **AI-Native** decision-making and scheduling engine for complex resource allocation, built on `PostgreSQL` with `JWT`-based stateless authentication and *RBAC* multi-role access control.

The system uses a decoupled front-end/back-end architecture: the server, built with `Express.js`, exposes RESTful APIs through a four-layer **Routes → Controllers → Services → DB** design; the client is built as an SPA with native JavaScript ES Modules and adopts the *Glassmorphism* design language. It provides differentiated capabilities for *Administrators*, *Teachers*, and *Students*: teachers manage availability, working-hour statistics, course workflows, and student scheduling; students manage availability and access schedules, overviews, and statistics; administrators handle user and schedule-type management, scheduling operations, conflict detection, batch scheduling, fee auditing, and data exports. Authentication uses `JWT + Bcrypt`, while the security layer integrates `Helmet`, `CORS`, `Joi` validation, and request rate limiting.

**✨ AI Features**: The system integrates AI through an **LLM Tool Calling** architecture. A unified LLM adapter and *Protocol Translation Layer* provide upper layers with consistent request and response structures while supporting multiple model providers and custom-compatible gateways. The AI controller includes **15+ tool functions** spanning scheduling, queries, statistics, and management. Data-modifying operations follow a preview-and-confirmation workflow, allowing users to verify changes before execution. The frontend assistant supports model capability detection, multimodal input via the Vision API, a `30`-turn context window, conversation persistence, and history retrieval.

The data model follows `3NF`, with `teachers`, `students`, and `course_arrangement` as its core entities and *foreign key constraints* preserving *referential integrity*. Scheduling data uses temporal interval modeling, while audit tables implement `Provenance Tracking` to ensure operational traceability. The database layer combines `SchemaHelper`-based dynamic structural detection with `JSONB` extensibility, and the connection layer uses the standard PostgreSQL `pg` connection pool.

Released under [CC BY-NC 4.0](./LICENSE).

---

![Traffic Stats](https://raw.githubusercontent.com/colflip/github-profile-repo-analytics/output/generated/traffic_chart.svg)
