module.exports = {
    testEnvironment: 'node',
    // 性能套件故意命名为 *.perf.js 而不是 *.test.js：它们断言的是墙钟耗时和单次采样的
    // 增长比（batch.perf.js 里 1000 条的基线只有几十毫秒），并行跑时一次 GC 或调度抖动
    // 就能把比值翻倍 —— 同一份代码单跑全绿、并跑随机红。这种不确定性不适合做门禁，
    // 单独用 `npm run test:performance` 跑。tests/performance/ 下的 DB 型基准同理，
    // 走 `npm run test:integration`。
    testMatch: [
        '**/__tests__/**/*.test.js',
        '<rootDir>/tests/unit/**/*.test.js',
        '<rootDir>/tests/frontend/**/*.test.js'
    ],
    collectCoverageFrom: [
        'src/server/**/*.js',
        '!src/server/__tests__/**'
    ],
    coverageThreshold: {
        global: {
            branches: 50,
            functions: 60,
            lines: 60,
            statements: 60
        }
    },
    coverageDirectory: 'coverage',
    verbose: true
};
