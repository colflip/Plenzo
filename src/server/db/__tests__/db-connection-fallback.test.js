const mockPoolQuery = jest.fn();
const mockPoolConnect = jest.fn();
const mockPoolEnd = jest.fn();
const mockPoolOn = jest.fn();
const mockPoolConstructor = jest.fn(() => ({
  query: mockPoolQuery,
  connect: mockPoolConnect,
  end: mockPoolEnd,
  on: mockPoolOn
}));

const mockNeonQuery = jest.fn();
const mockNeonSql = jest.fn();
mockNeonSql.query = mockNeonQuery;
const mockNeonFactory = jest.fn(() => mockNeonSql);

jest.mock('pg', () => ({ Pool: mockPoolConstructor }));
jest.mock('@neondatabase/serverless', () => ({ neon: mockNeonFactory }));

describe('database connection fallback', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://user:password@example.neon.tech/neondb?sslmode=require';
    process.env.NODE_ENV = 'test';
    process.env.DB_CONNECTION_TYPE = 'auto';
    process.env.DB_NEON_FALLBACK = 'true';
    process.env.DB_MAX_RETRIES = '1';
    mockPoolEnd.mockResolvedValue(undefined);
    mockNeonSql.mockResolvedValue([]);
    mockNeonQuery.mockResolvedValue({ rows: [{ source: 'http' }], rowCount: 1 });
  });

  afterEach(() => {
    delete process.env.DB_CONNECTION_TYPE;
    delete process.env.DB_NEON_FALLBACK;
    delete process.env.DB_MAX_RETRIES;
  });

  test('all environments default to pg Pool', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ source: 'pool' }], rowCount: 1 });
    const db = require('../db');

    await expect(db.query('SELECT 1')).resolves.toEqual({
      rows: [{ source: 'pool' }],
      rowCount: 1
    });
    expect(mockPoolConstructor).toHaveBeenCalledTimes(1);
    expect(mockNeonFactory).not.toHaveBeenCalled();
  });

  test('connection errors switch once to Neon HTTP and retry the query', async () => {
    const connectionError = Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' });
    mockPoolQuery.mockRejectedValue(connectionError);
    const db = require('../db');

    await expect(db.query('SELECT 1')).resolves.toEqual({
      rows: [{ source: 'http' }],
      rowCount: 1
    });
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
    expect(mockNeonFactory).toHaveBeenCalledTimes(1);
    expect(mockNeonQuery).toHaveBeenCalledWith('SELECT 1', []);
  });

  test('SQL errors do not trigger a driver switch', async () => {
    const sqlError = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockPoolQuery.mockRejectedValue(sqlError);
    const db = require('../db');

    await expect(db.query('INSERT INTO users VALUES (1)')).rejects.toBe(sqlError);
    expect(mockNeonFactory).not.toHaveBeenCalled();
    expect(mockPoolEnd).not.toHaveBeenCalled();
  });

  test('explicit Neon HTTP mode bypasses pg Pool', async () => {
    process.env.DB_CONNECTION_TYPE = 'http';
    const db = require('../db');

    await expect(db.query('SELECT 1')).resolves.toEqual({
      rows: [{ source: 'http' }],
      rowCount: 1
    });
    expect(mockPoolConstructor).not.toHaveBeenCalled();
    expect(mockNeonFactory).toHaveBeenCalledTimes(1);
  });

  test('interactive transactions fail safely after fallback', async () => {
    const connectionError = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
    mockPoolConnect.mockRejectedValue(connectionError);
    const db = require('../db');

    await expect(db.runInTransaction(async () => {})).rejects.toThrow(
      '交互式事务无法在 HTTP 驱动上安全执行'
    );
    expect(mockNeonFactory).toHaveBeenCalledTimes(1);
    expect(mockPoolEnd).toHaveBeenCalledTimes(1);
  });
});
