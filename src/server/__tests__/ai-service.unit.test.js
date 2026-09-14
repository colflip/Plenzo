/**
 * aiService 协议翻译单元测试
 * 重点覆盖阶段4 新增的多模态（数组型 content）翻译，以及既有的 tool/assistant 翻译不回归。
 */

const {
    toAnthropicMessages,
    toAnthropicTools,
    fromAnthropicResponse,
    normalizeLLMError
} = require('../services/ai-service');

describe('normalizeLLMError', () => {
    test.each([
        [{ code: 'ETIMEDOUT' }, undefined, 'AI_UPSTREAM_TIMEOUT', 504, true],
        [{ response: { status: 429, headers: { 'retry-after': '12' } } }, 429, 'AI_UPSTREAM_RATE_LIMITED', 429, true],
        [{ response: { status: 401 } }, 401, 'AI_UPSTREAM_AUTH_FAILED', 502, false],
        [{ response: { status: 404 } }, 404, 'AI_UPSTREAM_BAD_RESPONSE', 502, false],
        [{ code: 'ENOTFOUND' }, undefined, 'AI_UPSTREAM_UNAVAILABLE', 503, true],
        [{ response: { status: 503 } }, 503, 'AI_UPSTREAM_UNAVAILABLE', 503, true]
    ])('将上游错误归一为稳定 machine code', (error, status, code, statusCode, retryable) => {
        const normalized = normalizeLLMError(error, status);
        expect(normalized).toMatchObject({ code, statusCode, retryable });
    });

    test('保留上游 Retry-After 秒数', () => {
        expect(normalizeLLMError({
            response: { status: 429, headers: { 'retry-after': '12' } }
        }, 429).retryAfterSeconds).toBe(12);
    });

    test('不向客户端回显未知异常正文', () => {
        const normalized = normalizeLLMError(new Error('provider secret response'), 400);
        expect(normalized.code).toBe('AI_UPSTREAM_BAD_RESPONSE');
        expect(normalized.message).toBe('AI 服务返回了无效响应');
    });
});


describe('toAnthropicMessages', () => {
    it('system 角色提取为顶层 system 字符串', () => {
        const { system, messages } = toAnthropicMessages([
            { role: 'system', content: '你是助手' },
            { role: 'user', content: '你好' }
        ]);
        expect(system).toBe('你是助手');
        expect(messages).toEqual([{ role: 'user', content: '你好' }]);
    });

    it('多模态 user content：image_url(base64) → Anthropic image 块', () => {
        const { messages } = toAnthropicMessages([
            {
                role: 'user',
                content: [
                    { type: 'text', text: '这是什么' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } }
                ]
            }
        ]);
        expect(messages[0].role).toBe('user');
        expect(Array.isArray(messages[0].content)).toBe(true);
        expect(messages[0].content[0]).toEqual({ type: 'text', text: '这是什么' });
        expect(messages[0].content[1]).toEqual({
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAB' }
        });
    });

    it('多模态 user content：http(s) 图片 URL → Anthropic url 图片块', () => {
        const { messages } = toAnthropicMessages([
            {
                role: 'user',
                content: [
                    { type: 'text', text: '看图' },
                    { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }
                ]
            }
        ]);
        expect(messages[0].content[1]).toEqual({
            type: 'image',
            source: { type: 'url', url: 'https://example.com/a.jpg' }
        });
    });

    it('tool 结果 → user 的 tool_result 块，连续 tool 合并', () => {
        const { messages } = toAnthropicMessages([
            { role: 'assistant', content: '', tool_calls: [
                { id: 'c1', function: { name: 'query_x', arguments: '{}' } },
                { id: 'c2', function: { name: 'query_y', arguments: '{}' } }
            ] },
            { role: 'tool', tool_call_id: 'c1', content: 'r1' },
            { role: 'tool', tool_call_id: 'c2', content: 'r2' }
        ]);
        // 最后一条 user 消息应包含两个 tool_result 块
        const toolMsg = messages[messages.length - 1];
        expect(toolMsg.role).toBe('user');
        expect(toolMsg.content).toEqual([
            { type: 'tool_result', tool_use_id: 'c1', content: 'r1' },
            { type: 'tool_result', tool_use_id: 'c2', content: 'r2' }
        ]);
    });

    it('assistant 含 tool_calls → tool_use 块', () => {
        const { messages } = toAnthropicMessages([
            { role: 'assistant', content: '好的', tool_calls: [
                { id: 'c1', function: { name: 'query_x', arguments: '{"a":1}' } }
            ] }
        ]);
        const a = messages[0];
        expect(a.role).toBe('assistant');
        expect(a.content).toEqual([
            { type: 'text', text: '好的' },
            { type: 'tool_use', id: 'c1', name: 'query_x', input: { a: 1 } }
        ]);
    });

    it('assistant 工具参数不是合法 JSON 时拒绝伪造空参数', () => {
        expect(() => toAnthropicMessages([
            { role: 'assistant', content: '', tool_calls: [
                { id: 'c1', function: { name: 'query_x', arguments: '{"bad"' } }
            ] }
        ])).toThrow(expect.objectContaining({
            code: 'AI_UPSTREAM_BAD_RESPONSE',
            statusCode: 502
        }));
    });
});

describe('toAnthropicTools', () => {
    it('OpenAI function 定义 → Anthropic input_schema', () => {
        const out = toAnthropicTools([
            { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: {} } } }
        ]);
        expect(out).toEqual([{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }]);
    });
    it('空/无工具返回 undefined', () => {
        expect(toAnthropicTools([])).toBeUndefined();
        expect(toAnthropicTools(null)).toBeUndefined();
    });
});

describe('fromAnthropicResponse', () => {
    it('拆分 text + tool_use，并保留 _anthropicContent', () => {
        const data = { content: [
            { type: 'text', text: '结果' },
            { type: 'tool_use', id: 'c1', name: 'f', input: { a: 1 } }
        ], stop_reason: 'tool_use' };
        const out = fromAnthropicResponse(data);
        const msg = out.choices[0].message;
        expect(msg.content).toBe('结果');
        expect(msg.tool_calls).toEqual([
            { id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }
        ]);
        expect(msg._anthropicContent).toBe(data.content);
    });
});
