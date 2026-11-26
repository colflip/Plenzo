/**
 * AI 助手会话领域层
 * @description
 *   控制器只负责 HTTP 封装，本层负责：会话/消息的领域校验、token 用量归一化、
 *   反馈写入、过期清理。存储细节交给 ai-chat-store（write-through + 内存降级）。
 *   业务错误抛 AppError，由 controller 统一封装 HTTP 响应。
 * @module services/ai-chat-service
 */

const { AppError } = require('../middleware/error');
const chatStore = require('./ai-chat-store');

const VALID_ROLES = new Set(['user', 'assistant']);

/**
 * 取/建当前用户的会话
 */
async function getOrCreateSession(userType, userId) {
    if (!userType || !userId) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少用户身份' });
    }
    return chatStore.getOrCreateSession(userType, userId);
}

/**
 * 追加一条消息，带领域校验。
 * @param {object} payload
 */
async function appendMessage(payload) {
    const p = payload || {};
    if (!p.sessionId) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少会话 ID' });
    if (!p.userType || !p.userId) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少用户身份' });
    if (!VALID_ROLES.has(p.role)) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '非法消息角色' });

    return chatStore.appendMessage({
        sessionId: p.sessionId,
        role: p.role,
        content: p.content,
        toolsUsed: p.toolsUsed,
        model: p.model,
        promptTokens: p.promptTokens,
        completionTokens: p.completionTokens,
        userType: p.userType,
        userId: p.userId
    });
}

/**
 * 把上游 LLM 的 usage 归一化成 {promptTokens, completionTokens}。
 * OpenAI 协议返回 prompt_tokens / completion_tokens；Anthropic 经 ai-service
 * 的 fromAnthropicResponse 透传 input_tokens / output_tokens —— 两种都要读。
 * 未知形状返回 null，不猜。
 * @param {object} usage - llmResp.usage
 */
function normalizeTokenUsage(usage) {
    if (!usage || typeof usage !== 'object') return { promptTokens: null, completionTokens: null };
    const prompt = usage.prompt_tokens ?? usage.input_tokens ?? null;
    const completion = usage.completion_tokens ?? usage.output_tokens ?? null;
    return {
        promptTokens: Number.isFinite(Number(prompt)) && prompt != null ? Number(prompt) : null,
        completionTokens: Number.isFinite(Number(completion)) && completion != null ? Number(completion) : null
    };
}

/**
 * 列出某会话的消息（归属校验由 store 下推到 SQL）
 */
async function listMessages(sessionId, userType, userId, limit) {
    if (!sessionId) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少会话 ID' });
    if (!userType || !userId) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少用户身份' });
    return chatStore.listMessages(sessionId, userType, userId, limit);
}

/**
 * 列出我的会话
 */
async function listSessions(userType, userId, limit) {
    if (!userType || !userId) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少用户身份' });
    return chatStore.listSessions(userType, userId, limit);
}

/**
 * 标记「没用」。只认本人的消息；重复标记幂等。
 */
async function markUnhelpful(messageId, feedback, userType, userId) {
    if (!messageId) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少消息 ID' });
    if (feedback !== 'unhelpful') {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '不支持的反馈类型' });
    }
    if (!userType || !userId) throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '缺少用户身份' });
    const result = await chatStore.markUnhelpful(messageId, userType, userId);
    if (!result || !result.found) {
        // 消息不存在或不属于本人 —— 如实回 404，不能给前端一个假的成功标记。
        throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '消息不存在或无权操作' });
    }
    // DB 降级路径：内存已标记但未持久化，仍回成功（用户按钮状态由本地驱动），
    // 但标记 degraded 供监控使用。
    if (result.degraded) return { id: messageId, feedback: 'unhelpful', degraded: true };
    return result.row || { id: messageId, feedback: 'unhelpful' };
}

/**
 * 清空当前会话（前端「清空对话」）。失败不阻断：前端本地已经清了，
 * 这里失败最多是下次打开又拉回旧消息，不该弹错误给用户。
 */
async function clearSession(sessionId, userType, userId) {
    if (!sessionId) return { ok: true };
    try {
        return await chatStore.clearSession(sessionId, userType, userId);
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

/**
 * 清理过期会话（每日 cron 调用）
 */
async function sweepExpired() {
    return chatStore.sweepExpired();
}

module.exports = {
    getOrCreateSession,
    appendMessage,
    normalizeTokenUsage,
    listMessages,
    listSessions,
    markUnhelpful,
    clearSession,
    sweepExpired
};
