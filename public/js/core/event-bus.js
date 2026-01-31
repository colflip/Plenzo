/**
 * 事件总线
 * @description 组件间通信的发布订阅模式实现
 * @module core/event-bus
 */

/**
 * 事件总线类
 */
class EventBus {
    constructor() {
        this.events = new Map();
    }

    /**
     * 订阅事件
     * @param {string} event - 事件名称
     * @param {Function} callback - 回调函数
     * @returns {Function} 取消订阅的函数
     */
    on(event, callback) {
        if (!this.events.has(event)) {
            this.events.set(event, new Set());
        }
        this.events.get(event).add(callback);

        // 返回取消订阅函数
        return () => this.off(event, callback);
    }

    /**
     * 订阅一次性事件
     * @param {string} event - 事件名称
     * @param {Function} callback - 回调函数
     */
    once(event, callback) {
        const wrapper = (...args) => {
            callback(...args);
            this.off(event, wrapper);
        };
        this.on(event, wrapper);
    }

    /**
     * 取消订阅
     * @param {string} event - 事件名称
     * @param {Function} callback - 回调函数
     */
    off(event, callback) {
        const callbacks = this.events.get(event);
        if (callbacks) {
            callbacks.delete(callback);
            if (callbacks.size === 0) {
                this.events.delete(event);
            }
        }
    }

    /**
     * 发布事件
     * @param {string} event - 事件名称
     * @param {...any} args - 事件参数
     */
    emit(event, ...args) {
        const callbacks = this.events.get(event);
        if (callbacks) {
            callbacks.forEach(callback => {
                try {
                    callback(...args);
                } catch (error) {
                    console.error(`事件 ${event} 处理出错:`, error);
                }
            });
        }
    }

    /**
     * 清除某个事件的所有订阅
     * @param {string} event - 事件名称
     */
    clear(event) {
        this.events.delete(event);
    }

    /**
     * 清除所有订阅
     */
    clearAll() {
        this.events.clear();
    }
}

// 预定义常用事件名
const EVENTS = {
    // 认证相关
    AUTH_LOGIN: 'auth:login',
    AUTH_LOGOUT: 'auth:logout',

    // 排课相关
    SCHEDULE_CREATED: 'schedule:created',
    SCHEDULE_UPDATED: 'schedule:updated',
    SCHEDULE_DELETED: 'schedule:deleted',
    SCHEDULE_STATUS_CHANGED: 'schedule:statusChanged',

    // 用户相关
    USER_CREATED: 'user:created',
    USER_UPDATED: 'user:updated',
    USER_DELETED: 'user:deleted',

    // UI相关
    MODAL_OPEN: 'modal:open',
    MODAL_CLOSE: 'modal:close',
    TOAST_SHOW: 'toast:show',

    // 数据刷新
    DATA_REFRESH: 'data:refresh',

    // 表格相关
    TABLE_ROW_SELECT: 'table:rowSelect',
    TABLE_PAGE_CHANGE: 'table:pageChange'
};

// 创建全局实例
const eventBus = new EventBus();

// 挂载到全局
if (typeof window !== 'undefined') {
    window.eventBus = eventBus;
    window.EVENTS = EVENTS;
}
