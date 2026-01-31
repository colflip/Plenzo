/**
 * Student Dashboard Utility Functions
 */

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
 */
export function formatDateDisplay(dateStr) {
    const date = new Date(dateStr);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return `${year}年${month}月${day}日`;
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
    // Simple toast implementation
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 12px 24px;
        background: ${type === 'success' ? '#4CAF50' : type === 'error' ? '#f44336' : '#2196F3'};
        color: white;
        border-radius: 4px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
        z-index: 10000;
        animation: slideIn 0.3s ease-out;
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

/**
 * Handle API errors
 */
export function handleApiError(error, defaultMessage = '操作失败') {
    console.error('API Error:', error);
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
        else if (key === 'innerHTML') el.innerHTML = value;
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
    if (!dateLike) return '';
    const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '';
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

export function startOfWeek(dateLike) {
    const date = dateLike instanceof Date ? new Date(dateLike) : new Date(dateLike);
    if (Number.isNaN(date.getTime())) return null;
    const day = date.getDay() || 7; // Sunday -> 7
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (day - 1));
    return date;
}

export function getWeekDates(baseDateLike) {
    const start = startOfWeek(baseDateLike) || new Date();
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
