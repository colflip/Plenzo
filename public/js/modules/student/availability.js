/**
 * 学生端空闲时段（availability）
 * @description 渲染 / 状态 / 反馈逻辑在 shared/availability-view.js；本文件只保留
 *              学生端差异：端点、payload 形状（逐时段 availabilityList）与容器选择器。
 */

import { API_ENDPOINTS } from './constants.js';
import { TIME_SLOT_CONFIG } from './constants.js';
import { createAvailabilityView } from '../shared/availability-view.js';

let view = null;

function getView() {
    if (!view) {
        view = createAvailabilityView({
            role: 'student',
            fetchWeek: async ({ startDate, endDate }) => {
                const endpoint = String(API_ENDPOINTS.AVAILABILITY).replace(/^\/api/, '');
                return window.apiUtils.get(endpoint, { startDate, endDate });
            },
            // 学生接口只返回 0/1 数字列，直接真值化
            parseAvailability: (value) => !!value,
            resolveMobileContainer: () => {
                // 尝试多种选择器，优先使用.schedule-unified-card
                return document.querySelector('#availability .schedule-unified-card')
                    || document.querySelector('.schedule-unified-card')
                    || document.querySelector('#availability .table-container')
                    || document.querySelector('.table-container');
            },
            saveChanges: async (ctx) => saveAvailability(ctx)
        });
    }
    return view;
}

/** 学生端 payload：逐 (日期, 时段) 一条，只提交相对基线变化的项 */
async function saveAvailability(ctx) {
    const { changedDates, state, originalState, elements, showTimedFeedback, updateUnsavedFeedback, reload } = ctx;
    const actionButton = elements.saveBtn();

    // Prepare payload for Student API
    const availabilityList = [];
    changedDates.forEach(date => {
        const slots = state.get(date);
        const originalSlots = originalState.get(date) || { morning: false, afternoon: false, evening: false };

        TIME_SLOT_CONFIG.forEach(slot => {
            // Only send if the status has changed compared to originalState
            const currentVal = !!slots[slot.id];
            const originalVal = !!originalSlots[slot.id];

            if (currentVal !== originalVal) {
                availabilityList.push({
                    date: date,
                    timeSlot: slot.id,
                    isAvailable: currentVal
                });
            }
        });
    });

    try {
        if (actionButton) {
            actionButton.disabled = true;
            actionButton.textContent = '保存中...';
        }

        const endpoint = String(API_ENDPOINTS.AVAILABILITY).replace(/^\/api/, '');
        await window.apiUtils.post(endpoint, { availabilityList });
        // Rebuild the baseline from the server instead of trusting the edited client state.
        await reload();
        window.eventBus?.emit(window.EVENTS?.AVAILABILITY_UPDATED || 'availability:updated', {
            role: 'student',
            weekStart: ctx.toISODate(ctx.currentWeekStart())
        });
        showTimedFeedback('时间安排已保存', 'success');
    } catch (error) {
        let errorMsg = '保存失败，请稍后重试';
        if (error.message) {
            errorMsg = `保存失败: ${error.message}`;
        }
        showTimedFeedback(errorMsg, 'error');
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
