const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../../src/server/db/db');
const { AppError } = require('../../src/server/middleware/error');

/**
 * 单元测试样例：AuthService
 * 
 * 测试金字塔 (Testing Pyramid) 说明：
 * 
 * 1. Unit Tests (单元测试) - 金字塔底层，数量最多，运行最快。
 *    测试隔离的函数和类方法（例如此处的 AuthService.login），外部依赖（如 DB, JWT, Bcrypt）被 Mock 掉。
 *    目的：验证单一职责模块的逻辑是否正确（边际条件、报错提示等）。
 * 
 * 2. Integration Tests (集成测试) - 金字塔中层，数量居中。
 *    测试多个模块之间的协作或与真实数据库/外部 API 的联调。
 *    目的：确保模块拼装后能按预期工作（例如真实连接测试数据库进行路由级验证）。
 * 
 * 3. E2E Tests (端到端测试) - 金字塔顶层，数量最少，运行最慢。
 *    模拟真实用户在浏览器中的交互（如 Playwright / Cypress / Backstop）。
 *    目的：保证产品的核心使用链路（登录 -> 预约 -> 导出）畅通无阻。
 * 
 * 本用例展示了标准单元测试的编写规范（AAA原则：Arrange / Act / Assert）。
 */

const authService = require('../../src/server/services/auth-service');

jest.mock('bcrypt');
jest.mock('jsonwebtoken');
jest.mock('../../src/server/db/db');

describe('AuthService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('login', () => {
        it('should throw an error if the user is not found', async () => {
            db.query.mockResolvedValue({ rows: [] });

            await expect(authService.login('testuser', 'password123', 'admin'))
                .rejects.toThrow(AppError);

            expect(db.query).toHaveBeenCalledWith(
                expect.stringContaining('SELECT * FROM administrators WHERE username = $1'),
                ['testuser']
            );
        });

        it('should return user and token if credentials are correct', async () => {
            const mockUser = {
                id: 1,
                username: 'testuser',
                password_hash: '$2b$10$somemockedhash',
                status: 1
            };

            db.query.mockResolvedValue({ rows: [mockUser] });
            bcrypt.compare.mockResolvedValue(true);
            jwt.sign.mockReturnValue('mocked-jwt-token');

            const result = await authService.login('testuser', 'password123', 'admin');

            expect(result).toHaveProperty('user');
            expect(result.user.username).toBe('testuser');
            expect(result).toHaveProperty('token', 'mocked-jwt-token');
            expect(bcrypt.compare).toHaveBeenCalledWith('password123', mockUser.password_hash);
        });

        it('should return safe tokens only after last_login is persisted', async () => {
            const mockUser = {
                id: 1,
                username: 'testuser',
                name: 'Test User',
                password_hash: '$2b$10$somemockedhash',
                password: 'legacy-secret',
                passwordHash: 'legacy-hash',
                pwd: 'legacy-pwd',
                status: 1
            };

            db.query
                .mockResolvedValueOnce({ rows: [mockUser] })
                .mockResolvedValueOnce({ rows: [] });
            bcrypt.compare.mockResolvedValue(true);
            jwt.sign
                .mockReturnValueOnce('access-token')
                .mockReturnValueOnce('refresh-token');

            const result = await authService.login('  testuser  ', 'password123', 'admin', true);

            expect(db.query).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('SELECT * FROM administrators WHERE username = $1'),
                ['testuser']
            );
            expect(db.query).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('UPDATE administrators SET last_login = NOW()'),
                [1]
            );
            expect(jwt.sign).toHaveBeenCalledTimes(2);
            expect(jwt.sign.mock.calls[0][2]).toEqual({ expiresIn: '30d' });
            expect(jwt.sign.mock.calls[1][2]).toEqual({ expiresIn: '30d' });
            expect(result).toMatchObject({
                token: 'access-token',
                refreshToken: 'refresh-token',
                expiresIn: '30d',
                rememberMe: true
            });
            expect(result.user).not.toHaveProperty('password');
            expect(result.user).not.toHaveProperty('password_hash');
            expect(result.user).not.toHaveProperty('passwordHash');
            expect(result.user).not.toHaveProperty('pwd');
        });

        it('should not sign tokens when last_login update fails', async () => {
            const dbError = Object.assign(new Error('database unavailable'), { code: '08006' });
            db.query
                .mockResolvedValueOnce({
                    rows: [{
                        id: 1,
                        username: 'testuser',
                        password_hash: '$2b$10$somemockedhash',
                        status: 1
                    }]
                })
                .mockRejectedValueOnce(dbError);
            bcrypt.compare.mockResolvedValue(true);

            await expect(authService.login('testuser', 'password123', 'admin'))
                .rejects.toBe(dbError);
            expect(jwt.sign).not.toHaveBeenCalled();
        });

        it('should expose stable error codes for invalid credentials and user types', async () => {
            db.query.mockResolvedValueOnce({ rows: [] });

            await expect(authService.login('missing', 'password123', 'admin'))
                .rejects.toMatchObject({ code: 'AUTH_INVALID', statusCode: 401 });
            await expect(authService.login('user', 'password123', 'unknown'))
                .rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
        });

        it('should throw an error if the password is wrong', async () => {
            const mockUser = {
                id: 1,
                username: 'testuser',
                password_hash: '$2b$10$somemockedhash',
                status: 1
            };

            db.query.mockResolvedValue({ rows: [mockUser] });
            bcrypt.compare.mockResolvedValue(false); // Wrong password

            await expect(authService.login('testuser', 'wrongpass', 'admin'))
                .rejects.toThrow(AppError);
        });

        it('should throw an error if the user account is disabled/deleted', async () => {
            const mockUser = {
                id: 1,
                username: 'testuser',
                password_hash: '$2b$10$somemockedhash',
                status: -1 // 已删除/禁用（实现仅对 -1 拒绝登录）
            };

            db.query.mockResolvedValue({ rows: [mockUser] });
            bcrypt.compare.mockResolvedValue(true);

            // authService 应拒绝已删除/禁用账户，与密码是否正确无关
            await expect(authService.login('testuser', 'password', 'admin'))
                .rejects.toThrow();
        });
    });
});
