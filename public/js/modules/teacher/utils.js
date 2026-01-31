const TIME_ZONE = 'Asia/Shanghai';

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

export function setText(el, value) {
    const element = assertElement(el);
    element.textContent = value ?? '';
}

export function toISODate(dateLike) {
    const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (Number.isNaN(date.getTime())) return null;
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

export function formatDateDisplay(dateLike) {
    const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '--';
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}年${month}月${day}日`;
}

import { formatDateTimeDisplay as formatDateTimeDisplayCommon } from '../../utils/date-utils.js';

export function formatDateTimeDisplay(dateTimeLike) {
    return formatDateTimeDisplayCommon(dateTimeLike);
}

export function formatTimeDisplay(timeString) {
    if (!timeString) return '';
    return String(timeString).slice(0, 5);
}

export function formatTimeRange(start, end) {
    const safeStart = formatTimeDisplay(start);
    const safeEnd = formatTimeDisplay(end);
    if (!safeStart && !safeEnd) return '';
    if (!safeEnd) return safeStart;
    return `${safeStart} - ${safeEnd}`;
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

export function createElement(tag, className, props = {}) {
    const el = document.createElement(tag);
    if (className) el.className = className;

    const { dataset, classList: extraClasses, ...rest } = props || {};

    if (rest && Object.keys(rest).length > 0) {
        Object.assign(el, rest);
    }

    if (dataset && typeof dataset === 'object') {
        Object.entries(dataset).forEach(([key, value]) => {
            if (value === undefined || value === null) return;
            el.dataset[key] = String(value);
        });
    }

    if (extraClasses) {
        const values = Array.isArray(extraClasses)
            ? extraClasses
            : String(extraClasses).split(/\s+/);
        el.classList.add(...values.filter(Boolean));
    }

    return el;
}

export function clearChildren(el) {
    const element = assertElement(el);
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
}

export function showInlineFeedback(el, message, status) {
    const element = assertElement(el);
    element.textContent = message || '';
    element.classList.remove('success', 'error', 'info');
    if (status) {
        element.classList.add(status);
    }
}


/**
 * Show a mobile-friendly Action Sheet for selection
 * @param {string} title - Title of the sheet
 * @param {Array<{label: string, value: any, selected?: boolean}>} options - Options to display
 * @param {Function} onSelect - Callback when an option is selected (value) => void
 */
export function showActionSheet(title, options, onSelect) {
    // Remove existing sheet if any
    const existing = document.querySelector('.action-sheet-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'action-sheet-overlay';

    const sheet = document.createElement('div');
    sheet.className = 'action-sheet';

    if (title) {
        const header = document.createElement('div');
        header.className = 'action-sheet-header';
        header.textContent = title;
        sheet.appendChild(header);
    }

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'action-sheet-options';

    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = `action-sheet-option ${opt.selected ? 'selected' : ''}`;
        btn.textContent = opt.label;
        btn.onclick = (e) => {
            e.stopPropagation();
            closeSheet();
            onSelect(opt.value);
        };
        optionsContainer.appendChild(btn);
    });

    sheet.appendChild(optionsContainer);

    const cancelBtn = document.createElement('div');
    cancelBtn.className = 'action-sheet-cancel';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = (e) => {
        e.stopPropagation();
        closeSheet();
    };
    sheet.appendChild(cancelBtn);

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);

    // Trigger animation
    requestAnimationFrame(() => {
        overlay.classList.add('visible');
    });

    // Close on overlay click
    overlay.onclick = (e) => {
        if (e.target === overlay) {
            closeSheet();
        }
    };

    function closeSheet() {
        overlay.classList.remove('visible');
        setTimeout(() => {
            overlay.remove();
        }, 300);
    }
}
