/**
 * 测试环境配置
 */

require('dotenv').config();

// 全局超时设置 - 增加到60秒以适应网络延迟
jest.setTimeout(60000);

// 测试环境变量
process.env.NODE_ENV = 'test';

// 全局 beforeAll
beforeAll(() => {
    console.log('🧪 测试环境初始化...');
    console.log('📦 数据库:', process.env.DATABASE_URL ? '已配置' : '未配置');
});

// 全局 afterAll
afterAll(() => {
    console.log('✅ 测试完成');
});
