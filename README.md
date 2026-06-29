# Plenzo

[![version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=flat-square)](https://github.com/colflip/plenzo) [![license](https://img.shields.io/badge/license-CC%20BY-NC%204.0-green.svg?style=flat-square)](./LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org) [![express](https://img.shields.io/badge/express-4.18.2-000000.svg?style=flat-square)](https://expressjs.com) [![postgresql](https://img.shields.io/badge/pg-8.x-336791.svg?style=flat-square)](https://www.postgresql.org)

一款 AI-Native 智能调度引擎，基于 PostgreSQL 与 JWT 无状态认证构建，采用 RBAC 权限模型实现细粒度访问控制。

系统采用前后端分离架构，服务端基于 Express.js 提供 RESTful 接口，遵循 Routes → Controllers → Services → DB 四层分层设计；客户端以原生 JavaScript（ES6+）构建 SPA 应用，无构建工具依赖，界面层采用 Glassmorphism 拟态设计语言。实现教师、学生与管理端的差异化信息交互与协同编排：教师端包含普通教师与班主任两种角色，提供可用时段配置、教学工时统计、课程确认及关联学生调度管理；学生端支持多视图课表阅览与学习轨迹追踪；管理员端涵盖调度引擎、实时冲突检测、批量编排、人员管控、费用审计与结构化数据导出。认证层采用 JWT 无状态令牌机制，配合 Bcrypt 密码哈希；安全中间件链集成 Helmet HTTP 头加固、CORS 跨域控制、Joi 输入校验及滑动窗口限流策略。

**✨ AI 功能**：系统采用 LLM Tool Calling 架构集成 AI 能力。服务层设计统一 LLM 适配器，通过内部协议翻译层对上层交互一致响应。支持多模型供应商及自定义网关，可通过环境变量热切换。AI 控制器注册 15+ 工具函数，覆盖调度、查询、统计、人员管理等场景，LLM 通过 Function Calling 自主调用工具完成结构化交互。前端助手支持多模态输入（Vision API），对话状态维护 30 轮上下文窗口，支持会话持久化与历史回溯。

数据模型遵循第三范式（3NF），以 `teachers`、`students`、`course_arrangement` 为核心实体，外键约束维护 referential integrity。`teacher_daily_availability` 与 `student_daily_availability` 时段表采用时间区间建模，支撑冲突检测算法；审计表实现 Provenance Tracking，保障可追溯性与合规性。数据库层通过 SchemaHelper 动态列检测，结合 JSONB 支持灵活扩展。

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
| :-------- | :------------------------------------ |
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

An AI-Native intelligent scheduling engine built on PostgreSQL and JWT stateless authentication, employing an RBAC permission model for fine-grained access control.

The system adopts a front-end and back-end separation architecture: the server is built on Express.js providing RESTful APIs, following a four-layer design pattern of Routes → Controllers → Services → DB; the client is built as a single-page application (SPA) using native JavaScript (ES6+) with zero build-tool dependencies, and the interface layer employs a Glassmorphism design language. It enables differentiated information exchange and collaborative orchestration across three roles: **Teachers** (regular teachers and head teachers) provide availability scheduling, teaching hour statistics, course confirmation, and associated student schedule management; **Students** support multi-view timetable browsing and learning trajectory tracking; **Administrators** cover the scheduling engine, real-time conflict detection, batch orchestration, personnel lifecycle management, fee auditing, and structured data export. The authentication layer utilizes JWT stateless token mechanism paired with Bcrypt password hashing; the security middleware chain integrates Helmet HTTP header hardening, CORS cross-origin control, Joi input validation, and sliding-window rate limiting.

**✨ AI Features**: The system integrates AI capabilities via an LLM Tool Calling architecture. The service layer defines a unified LLM adapter that abstracts OpenAI and Anthropic protocols, exposing a consistent response shape to upper layers through an internal Protocol Translation Layer. It supports multiple model providers and custom gateways, switchable via environment variables. The AI controller registers 15+ tool functions covering scheduling, statistics, and user management; the LLM autonomously invokes tools via Function Calling for structured data exchange. The frontend assistant supports multi-modal input (Vision API); conversation state maintains a 30-turn context window with session persistence and history retrieval.

The data model adheres to Third Normal Form (3NF), centering on `teachers`, `students`, and `course_arrangement` entities with foreign key constraints maintaining referential integrity. The availability tables employ temporal interval modeling for conflict detection; audit tables implement provenance tracking for traceability and compliance. The database layer utilizes SchemaHelper for dynamic column detection with JSONB for flexible extensibility.

Released under [CC BY-NC 4.0](./LICENSE).
