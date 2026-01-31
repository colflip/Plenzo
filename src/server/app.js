/**
 * 应用入口文件
 * @description 初始化 Express 应用，配置中间件、路由和全局错误处理
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { errorHandler, notFoundHandler } = require('./middleware');
const initScheduler = require('./jobs/scheduler');

// 初始化应用
const app = express();

// ==========================================
// 1. 全局中间件配置
// ==========================================

// 允许跨域请求
app.use(cors());

// 解析 JSON 请求体
app.use(express.json());

// 解析 URL 编码请求体
app.use(express.urlencoded({ extended: true }));

// 静态文件服务
app.use(express.static(path.join(__dirname, '../../public')));

// ==========================================
// 2. 路由配置
// ==========================================

// API 路由
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/teacher', require('./routes/teacher'));
app.use('/api/student', require('./routes/student'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/users', require('./routes/users'));
app.use('/api/health', require('./routes/health'));

// 页面路由 (支持 HTML5 History Mode 或直接访问)
// 管理员仪表盘
app.get(['/admin/dashboard', '/admin/dashboard.html', '/admin/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/admin/dashboard.html'));
});

// 教师仪表盘
app.get(['/teacher/dashboard', '/teacher/dashboard.html', '/teacher/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/teacher/dashboard.html'));
});

// 学生仪表盘
app.get(['/student/dashboard', '/student/dashboard.html', '/student/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/student/dashboard.html'));
});

// ==========================================
// 3. 错误处理
// ==========================================

// 404 处理 (所有未匹配路由)
app.use(notFoundHandler);

// 全局错误处理
app.use(errorHandler);

// ==========================================
// 4. 服务器启动
// ==========================================

const PORT = process.env.PORT || 3001;

// 仅在非测试环境下启动监听
if (process.env.NODE_ENV !== 'test') {
    app.listen(PORT, () => {
        console.log(`=================================`);
        console.log(`🚀 服务器已启动`);
        console.log(`📂 环境: ${process.env.NODE_ENV || 'development'}`);
        console.log(`🔌 端口: ${PORT}`);
        console.log(`=================================`);

        // 初始化定时任务
        try {
            initScheduler();
            console.log('⏰ 定时任务调度器已运行');
        } catch (err) {
            console.error('❌ 定时任务启动失败:', err);
        }
    });
}

module.exports = app;
