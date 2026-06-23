# Plenzo

[![version](https://img.shields.io/badge/version-1.0.0-blue.svg?style=flat-square)](https://github.com/colflip/plenzo) [![license](https://img.shields.io/badge/license-CC%20BY-NC%204.0-green.svg?style=flat-square)](./LICENSE) [![node](https://img.shields.io/badge/node-%3E%3D16.0.0-brightgreen.svg?style=flat-square)](https://nodejs.org) [![express](https://img.shields.io/badge/express-4.18.2-000000.svg?style=flat-square)](https://expressjs.com) [![postgresql](https://img.shields.io/badge/pg-8.x-336791.svg?style=flat-square)](https://www.postgresql.org)

一款基于关系型数据库与无状态令牌认证的排课管理系统，集成 **AI 助手**，支持 RBAC 多角色权限模型。

系统采用前后端分离架构，服务端提供 RESTful 接口，客户端以原生 JavaScript 构建 SPA 应用，界面层采用拟态设计语言。实现教师、学生与管理端的差异化信息交互与协同编排：教师端包含普通教师与班主任两种角色，提供可用时段配置、教学工时统计、课程确认及关联学生排课管理；学生端支持多视图课表阅览与学习轨迹追踪；管理员端涵盖排课引擎、实时冲突检测、批量调度、人员管控、费用审计与结构化数据导出。

**✨ AI 功能**：集成多模型 AI 助手，支持自然语言数据查询、智能排课、多模态交互（图片理解）、连续对话等功能。支持 Mistral、Agnes AI、OpenModel、SenseNova 等多个 AI 服务商。

底层数据模型以 `teachers`、`students` 与 `course_arrangement` 为核心实体，结合 `teacher_daily_availability` 与 `student_daily_availability` 时段表支撑冲突校验，`operation_logs` 审计表保障操作可追溯。

```
plenzo/
├── api/  
├── docs/   
├── public/   
│   ├── admin/  
│   ├── teacher/   
│   ├── student/  
│   ├── css/  
│   └── js/   
├── src/server/   
│   ├── controllers/   
│   ├── routes/   
│   ├── services/   
│   ├── middleware/   
│   └── db/  
```

## 技术栈

| Module    | Tech Stack                            |
| :-------- | :------------------------------------ |
| BE        | Node.js + Express + PostgreSQL        |
| Auth      | JWT + Bcrypt                          |
| FE        | Native JS (ES6+) + CSS3 Glassmorphism |
| AI        | OpenAI/Anthropic API + Multi-Modal    |
| Val & Sec | Joi + Helmet + Rate Limit             |

本项目基于 [CC BY-NC 4.0](./LICENSE) 开源。

---

A scheduling management system built on a relational database and stateless token-based authentication, with integrated **AI Assistant**, supporting an RBAC multi-role permission model.

The system adopts a front-end and back-end separation architecture: the server provides RESTful APIs, the client is built as a single-page application (SPA) using native JavaScript, and the interface layer employs a glassmorphism design language. It enables differentiated information exchange and collaborative orchestration across three roles: **Teachers** (regular teachers and head teachers) provide availability scheduling, teaching hour statistics, course confirmation, and associated student schedule management; **Students** support multi-view timetable browsing and learning trajectory tracking; **Administrators** cover the scheduling engine, real-time conflict detection, batch scheduling, personnel lifecycle management, fee auditing, and structured data export.

**✨ AI Features**: Integrated multi-model AI assistant with natural language querying, intelligent scheduling, multi-modal interaction (image understanding), continuous conversation, and more. Supports Mistral, Agnes AI, OpenModel (Claude/DeepSeek), SenseNova, etc.

The underlying data model centers on the `teachers`, `students`, and `course_arrangement` entities, leverages the `teacher_daily_availability` and `student_daily_availability` tables for conflict validation, and uses `operation_logs` for audit trail.

Released under [CC BY-NC 4.0](./LICENSE).
