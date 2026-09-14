// 可复用的 HTTP 请求/响应 mock（用于控制器契约测试）
function mockRes() {
    const res = {};
    res.statusCode = 200;
    res.status = jest.fn((code) => {
        res.statusCode = code;
        return res;
    });
    res.json = jest.fn((payload) => {
        res.body = payload;
        return res;
    });
    res.send = jest.fn((payload) => {
        res.body = payload;
        return res;
    });
    res.headersSent = false;
    res.setHeader = jest.fn();
    res.end = jest.fn((payload) => {
        res.body = payload;
        return res;
    });
    res.set = jest.fn().mockReturnValue(res);
    res.type = jest.fn().mockReturnValue(res);
    res.attachment = jest.fn().mockReturnValue(res);
    res.sendFile = jest.fn().mockReturnValue(res);
    return res;
}

function mockReq(overrides = {}) {
    return {
        body: {},
        params: {},
        query: {},
        user: { id: 1, role: 'admin' },
        ...overrides
    };
}

module.exports = { mockRes, mockReq };
