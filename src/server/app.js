/**
 * 应用入口文件
 * @description 初始化 Express 应用，配置中间件、路由和全局错误处理
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const morgan = require('morgan');

const {
    errorHandler,
    notFoundHandler,
    loginLimiter,
    apiLimiter,
    securityHeaders,
    additionalSecurityHeaders,
    corsOptions
} = require('./middleware');

const initScheduler = require('./jobs/scheduler');

const app = express();

const isProduction = process.env.NODE_ENV === 'production';
const isDevelopment = process.env.NODE_ENV === 'development';

app.use(securityHeaders);
app.use(additionalSecurityHeaders);

if (isProduction) {
    app.use(cors(corsOptions));
} else {
    app.use(cors());
}

if (process.env.NODE_ENV !== 'test') {
    const morganFormat = isProduction ? 'combined' : 'dev';
    app.use(morgan(morganFormat, {
        skip: (req, res) => {
            return req.path === '/api/health' && res.statusCode === 200;
        }
    }));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(path.join(__dirname, '../../public'), {
    maxAge: isProduction ? '1d' : '0',
    etag: true
}));

app.use('/api/auth/login', loginLimiter);

app.use('/api', apiLimiter);

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/teacher', require('./routes/teacher'));
app.use('/api/student', require('./routes/student'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/users', require('./routes/users'));
app.use('/api/health', require('./routes/health'));

app.get(['/admin/dashboard', '/admin/dashboard.html', '/admin/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/admin/dashboard.html'));
});

app.get(['/teacher/dashboard', '/teacher/dashboard.html', '/teacher/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/teacher/dashboard.html'));
});

app.get(['/student/dashboard', '/student/dashboard.html', '/student/'], (req, res) => {
    res.sendFile(path.join(__dirname, '../../public/student/dashboard.html'));
});

app.use(notFoundHandler);

app.use(errorHandler);

const PORT = process.env.PORT || 3001;

if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
    module.exports = app;
} else {
    app.listen(PORT, () => {
        console.log(`=================================`);
        console.log(`🚀 服务器已启动`);
        console.log(`📂 环境: ${process.env.NODE_ENV || 'development'}`);
        console.log(`🔌 端口: ${PORT}`);
        console.log(`🔒 安全中间件: 已启用`);
        console.log(`=================================`);

        try {
            initScheduler();
            console.log('⏰ 定时任务调度器已运行');
        } catch (err) {
            console.error('❌ 定时任务启动失败:', err);
        }
    });
    module.exports = app;
}

module.exports = app;
