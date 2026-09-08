/**
 * 教师端空闲时段（availability）
 * @description 渲染 / 状态 / 反馈逻辑在 shared/availability-view.js；本文件只保留
 *              教师端差异：端点、payload 形状（updates/removals 批量）与容器选择器。
 */

import { TIME_SLOT_CONFIG } from './constants.js';
import { createAvailabilityView } from '../shared/availability-view.js';

let view = null;

function getView() {
    if (!view) {
        view = createAvailabilityView({
            role: 'teacher',
            fetchWeek: async ({ startDate, endDate }) => {
                return window.apiUtils.get('/teacher/availability', { startDate, endDate });
            },
            // 教师接口可能返回 0/1 数字、布尔或 '1'/'true' 等字符串
            parseAvailability: convertToBoolean,
            resolveMobileContainer: () => {
                // 教师端使用 schedule-unified-card，其次退回周表格的父容器
                return document.querySelector('#availability .schedule-unified-card')
                    || document.querySelector('#availability .weekly-schedule-table')?.parentElement
                    || document.querySelector('.table-container');
            },
            saveChanges: async (ctx) => saveAvailability(ctx)
        });
    }
    return view;
}

function convertToBoolean(value) {
    if (typeof value === 'number') return value === 1;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        return ['1', 'true', 'available', 'yes'].includes(value.toLowerCase());
    }
    return false;
}

/** 教师端 payload：按日期聚合的 updates/removals（全部勾掉且原来有值 → removal） */
async function saveAvailability(ctx) {
    const { changedDates, state, originalState, elements, showTimedFeedback, updateUnsavedFeedback } = ctx;

    const payload = buildPersistencePayload(changedDates, ctx);
    if (!payload.updates.length && !payload.removals.length) {
        ctx.showInlineFeedback(elements.feedback(), '请勾选至少一个时间段后再保存', 'info');
        return;
    }

    try {
        await submitAvailabilityPayload(payload, ctx);
    } catch (_) {
        // 已在 submitAvailabilityPayload 中处理反馈
    }
}

function buildPersistencePayload(changedDates, { state, originalState }) {
    const updates = [];
    const removals = [];

    changedDates.forEach(date => {
        const slots = state.get(date) || {};
        const originalSlots = originalState.get(date) || { morning: false, afternoon: false, evening: false };
        const allOff = TIME_SLOT_CONFIG.every(slot => !slots[slot.id]);
        const originalHadAny = TIME_SLOT_CONFIG.some(slot => originalSlots[slot.id]);

        if (allOff && originalHadAny) {
            removals.push({ date, removeAll: true });
            return;
        }

        if (!allOff) {
            const payloadSlots = {};
            TIME_SLOT_CONFIG.forEach(slot => {
                payloadSlots[slot.id] = slots[slot.id] ? 1 : 0;
            });
            updates.push({
                date,
                slots: payloadSlots
            });
        }
    });

    return { updates, removals };
}

async function submitAvailabilityPayload(payload, ctx) {
    const { elements, showInlineFeedback, showTimedFeedback, updateUnsavedFeedback, reload } = ctx;
    const actionButton = elements.saveBtn();
    const updates = payload?.updates || [];
    const removals = payload?.removals || [];

    try {
        if (actionButton) {
            actionButton.disabled = true;
            actionButton.textContent = '保存中...';
        }

        if (!updates.length && !removals.length) {
            showInlineFeedback(elements.feedback(), '没有需要保存的更改', 'info');
            return;
        }

        // R2（选项 B）：单次原子 PUT，单事务内 upsert 提及项 + DELETE 提及项，未提及保留。
        await window.apiUtils.put('/teacher/availability', { updates, removals });

        await reload();
        window.eventBus?.emit(window.EVENTS?.AVAILABILITY_UPDATED || 'availability:updated', {
            role: 'teacher',
            weekStart: ctx.toISODate(ctx.currentWeekStart())
        });
        showTimedFeedback('时间安排已保存', 'success');
    } catch (error) {

        showInlineFeedback(elements.feedback(), '保存失败，请稍后重试', 'error');
        throw error;
    } finally {
        if (actionButton) {
            actionButton.disabled = false;
            actionButton.textContent = '保存时间安排';
        }
        updateUnsavedFeedback();
    }
}

export function initAvailabilitySection() {
    return getView().initAvailabilitySection();
}

export function loadAvailability(baseDate, showLoading = true) {
    return getView().loadAvailability(baseDate, showLoading);
}

export function refreshAvailability() {
    return getView().refreshAvailability();
}
