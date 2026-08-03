# Plenzo

[![version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=flat-square)](https://github.com/colflip/plenzo) [![license](https://img.shields.io/badge/license-CC--BY--NC--4.0-green.svg?style=flat-square)](https://github.com/colflip/plenzo/blob/master/LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org) [![express](https://img.shields.io/badge/express-4.18.2-000000.svg?style=flat-square)](https://expressjs.com) [![postgresql](https://img.shields.io/badge/pg-8.x-336791.svg?style=flat-square)](https://www.postgresql.org)

一款 **AI-Native** 智能调度引擎，基于 `PostgreSQL` 与 `JWT` 无状态认证构建，采用 *RBAC* 多角色权限控制。

系统采用前后端分离架构，服务端基于 `Express.js` 提供 RESTful 接口，遵循 **Routes → Controllers → Services → DB** 四层分层设计；客户端以原生 JavaScript（ES6+）构建 SPA 应用，界面层采用 *Glassmorphism* 拟态设计语言。支持*教师*、*学生*与*管理*端的差异化交互：教师端提供可用时段配置、工时统计、课程确认及学生调度管理；学生端支持多视图课表与学习轨迹追踪；管理员端涵盖调度引擎、冲突检测、批量编排、人员管控、费用审计与数据导出。认证层采用 `JWT + Bcrypt`；安全中间件集成 `Helmet`、`CORS`、`Joi` 校验及滑动窗口限流。

**✨ AI 功能**：采用 **LLM Tool Calling** 架构集成 AI 能力。服务层设计统一 LLM 适配器，通过*协议翻译层*对上层提供一致响应。支持多模型供应商及自定义网关热切换。AI 控制器注册 **15+ 工具函数**，覆盖调度、查询、统计、管理等场景，LLM 通过 **Function Calling** 自主调用工具。前端助手支持*多模态输入*（Vision API），维护 `30 ` 轮上下文窗口，且支持*持久化与回溯*。

数据模型遵循 `3NF`，以 `teachers`、`students`、`course_arrangement` 为核心实体，通过*外键约束*维护*引用完整性*。时段表采用*时间区间建模*支撑冲突检测；审计表实现 `Provenance Tracking`，保障可追溯性。数据库层通过 `SchemaHelper` 动态列检测，结合 `JSONB` 支持灵活扩展。

```
plenzo/
├── src/server/
│   ├── controllers/
│   ├── services/
│   │   └── export/
│   ├── middleware/
│   ├── db/
│   ├── routes/
│   ├── validators/
│   ├── jobs/
│   └── utils/
├── public/
│   ├── admin/
│   ├── teacher/
│   ├── student/
│   ├── css/modules/
│   └── js/
│       ├── core/
│       ├── components/
│       ├── modules/
│       │   ├── admin/
│       │   ├── teacher/
│       │   ├── student/
│       │   └── shared/
│       └── utils/
└── tests/
```

## 技术栈


| Module    | Tech Stack                            |
| :---------- | :-------------------------------------- |
| BE        | Node.js + Express + PostgreSQL        |
| Auth      | JWT + Bcrypt                          |
| FE        | Native JS (ES6+) + CSS3 Glassmorphism |
| AI        | OpenAI/Anthropic API + Multi-Modal    |
| Export    | ExcelJS + Streaming Write             |
| Scheduler | node-cron                             |
| Security  | Helmet + Joi + Rate Limit             |
| Testing   | Jest + BackstopJS                     |

本项目基于 [CC BY-NC 4.0](./LICENSE) 开源。

---

An **AI-Native** intelligent scheduling engine built on `PostgreSQL` and `JWT` stateless authentication, with an *RBAC* multi-role permission model.

The system adopts a front-end and back-end separation architecture: the server is built on `Express.js` providing RESTful APIs, following a four-layer design of **Routes → Controllers → Services → DB**; the client is built as an SPA using native JavaScript (ES6+) with *Glassmorphism* design language. It enables differentiated interaction across three roles: *Teachers* provide availability scheduling, hour statistics, course confirmation, and student schedule management; *Students* support multi-view timetable and learning trajectory tracking; *Administrators* cover the scheduling engine, conflict detection, batch orchestration, personnel management, fee auditing, and data export. Authentication uses `JWT + Bcrypt`; security middleware integrates `Helmet`, `CORS`, `Joi` validation, and sliding-window rate limiting.

**✨ AI Features**: The system integrates AI via an **LLM Tool Calling** architecture. The service layer defines a unified LLM adapter with a *Protocol Translation Layer* for consistent response shape. It supports multiple model providers and custom gateways, switchable via environment variables. The AI controller registers **15+ tool functions** covering scheduling, queries, statistics, and management scenarios; the LLM autonomously invokes tools via **Function Calling**. The frontend assistant supports *multi-modal input* (Vision API) with a `30` -turn context window, supporting *persistence and retrieval*.

The data model adheres to `3NF`, centering on `teachers`, `students`, and `course_arrangement` entities with *foreign key constraints* maintaining *referential integrity*. The availability tables employ *temporal interval modeling* for conflict detection; audit tables implement `Provenance Tracking`, ensuring traceability. The database layer utilizes `SchemaHelper` for dynamic column detection with `JSONB` for flexible extensibility.

Released under [CC BY-NC 4.0](./LICENSE).

---

![Traffic Stats](https://raw.githubusercontent.com/colflip/github-profile-repo-analytics/output/generated/traffic_chart.svg)
