/**
 * Student Dashboard Utility Functions
 */
import { getWeekStart } from '../shared/schedule-helpers.js';

/**
 * Format date to YYYY-MM-DD
 */
export function formatDate(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Format date for display (YYYY年MM月DD日)
 * 使用 Asia/Shanghai 时区解析，避免 UTC 偏移问题
 */
export function formatDateDisplay(dateStr) {
    if (!dateStr) return '--';
    // 直接解析日期字符串组件，避免时区偏移
    const parts = String(dateStr).split('T')[0].split('-');
    if (parts.length === 3) {
        return `${parts[0]}年${parts[1]}月${parts[2]}日`;
    }
    // 降级：使用 Intl 格式化
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return '--';
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date).replace(/\//g, '年').replace(/\//g, '月') + '日';
}

import { formatDateTimeDisplay as formatDateTimeDisplayCommon } from '../../utils/date-utils.js';

export function formatDateTimeDisplay(dateTimeLike) {
    return formatDateTimeDisplayCommon(dateTimeLike);
}

/**
 * Format month for display (YYYY年MM月)
 */
export function formatMonthDisplay(year, month) {
    return `${year}年${month}月`;
}

/**
 * Get first day of month
 */
export function getFirstDayOfMonth(year, month) {
    return new Date(year, month - 1, 1);
}

/**
 * Get last day of month
 */
export function getLastDayOfMonth(year, month) {
    return new Date(year, month, 0);
}

/**
 * Get days in month
 */
export function getDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

/**
 * Check if date is today
 */
export function isToday(date) {
    const today = new Date();
    const checkDate = new Date(date);
    return checkDate.getDate() === today.getDate() &&
        checkDate.getMonth() === today.getMonth() &&
        checkDate.getFullYear() === today.getFullYear();
}

/**
 * Check if date is in the past
 */
export function isPast(date) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const checkDate = new Date(date);
    checkDate.setHours(0, 0, 0, 0);
    return checkDate < today;
}

/**
 * Show toast notification
 */
export function showToast(message, type = 'info') {
    if (window.Toast && typeof window.Toast.show === 'function') {
        window.Toast.show(message, { type });
    } else {
        // Fallback if Toast component not loaded
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.textContent = message;
        toast.style.cssText = `position:fixed;top:20px;right:20px;padding:12px 24px;background:${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#2196F3'};color:white;border-radius:4px;z-index:100002;`;
        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
}

/**
 * Handle API errors
 */
export function handleApiError(error, defaultMessage = '操作失败') {

    const message = error.message || defaultMessage;
    showToast(message, 'error');
}

/**
 * Helper to set text content safely
 */
export function setText(element, text) {
    if (element) {
        element.textContent = text;
    }
}

/**
 * Helper to create element with class and props
 */
export function createElement(tag, className, props = {}) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    Object.entries(props).forEach(([key, value]) => {
        if (key === 'textContent') el.textContent = value;
        else if (key === 'innerHTML') if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(el, value); } else { el.innerHTML = value; }
        else el.setAttribute(key, value);
    });
    return el;
}

/**
 * Helper to clear all children
 */
export function clearChildren(element) {
    if (element) {
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }
}

/**
 * Format time range
 */
export function formatTimeRange(start, end) {
    if (!start || !end) return '--';
    const format = (t) => t.length > 5 ? t.substring(0, 5) : t;
    return `${format(start)} - ${format(end)}`;
}

/**
 * Convert date to ISO string (YYYY-MM-DD)
 */
export function toISODate(dateLike) {
    if (!dateLike) return null;

    // Ensure we have a Date object
    let date;
    if (dateLike instanceof Date) {
        date = dateLike;
    } else {
        // Handle ISO strings by converting to Date object
        date = new Date(dateLike);
    }

    if (Number.isNaN(date.getTime())) return null;

    // Standardize to Beijing Time (Asia/Shanghai) to avoid UTC offset issues
    // format "en-CA" returns "YYYY-MM-DD"
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

export function assertElement(selectorOrElement) {
    if (typeof selectorOrElement === 'string') {
        const el = document.querySelector(selectorOrElement);
        if (!el) throw new Error(`Element not found: ${selectorOrElement}`);
        return el;
    }
    if (!(selectorOrElement instanceof Element)) {
        throw new Error('Expected a DOM element');
    }
    return selectorOrElement;
}

export function showInlineFeedback(el, message, status) {
    const element = assertElement(el);
    element.textContent = message || '';
    element.classList.remove('success', 'error', 'info');
    if (status) {
        element.classList.add(status);
    }
}

export { getWeekStart as startOfWeek } from '../shared/schedule-helpers.js';

export function getWeekDates(baseDateLike) {
    const start = getWeekStart(baseDateLike) || new Date();
    return Array.from({ length: 7 }, (_, idx) => {
        const date = new Date(start);
        date.setDate(start.getDate() + idx);
        return date;
    });
}

export function formatWeekRangeText(startDate, endDate) {
    return `${formatDateDisplay(startDate)} - ${formatDateDisplay(endDate)}`;
}

export function normalizeDateKey(dateLike) {
    const iso = toISODate(dateLike);
    return iso || null;
}

export function getTimeSlotId(timeStr) {
    if (!timeStr) return 'unspecified';
    const hour = parseInt(timeStr.split(':')[0], 10);
    if (isNaN(hour)) return 'unspecified';
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
}
