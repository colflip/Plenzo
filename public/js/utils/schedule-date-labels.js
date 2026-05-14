(function () {
    const HOLIDAY_RANGES_BY_YEAR = {
        2025: [
            { start: '2025-01-01', end: '2025-01-01', label: '元旦假期' },
            { start: '2025-01-28', end: '2025-02-04', label: '春节假期' },
            { start: '2025-04-04', end: '2025-04-06', label: '清明节假期' },
            { start: '2025-05-01', end: '2025-05-05', label: '劳动节假期' },
            { start: '2025-05-31', end: '2025-06-02', label: '端午节假期' },
            { start: '2025-10-01', end: '2025-10-08', label: '国庆节假期' },
            { start: '2025-10-01', end: '2025-10-08', label: '中秋节假期' }
        ],
        2026: [
            { start: '2026-01-01', end: '2026-01-03', label: '元旦假期' },
            { start: '2026-02-15', end: '2026-02-23', label: '春节假期' },
            { start: '2026-04-04', end: '2026-04-06', label: '清明节假期' },
            { start: '2026-05-01', end: '2026-05-05', label: '劳动节假期' },
            { start: '2026-06-19', end: '2026-06-21', label: '端午节假期' },
            { start: '2026-09-25', end: '2026-09-27', label: '中秋节假期' },
            { start: '2026-10-01', end: '2026-10-07', label: '国庆节假期' }
        ]
    };

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function parseISODate(dateString) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
        if (!match) return null;
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    }

    function toISODate(dateLike) {
        if (!dateLike) return '';
        const date = typeof dateLike === 'string' ? (parseISODate(dateLike) || new Date(dateLike)) : new Date(dateLike);
        if (Number.isNaN(date.getTime())) return '';
        return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getLunarLabel(dateLike) {
        try {
            const date = typeof dateLike === 'string' ? (parseISODate(dateLike) || new Date(dateLike)) : new Date(dateLike);
            if (Number.isNaN(date.getTime())) return '';
            const lunarStr = new Intl.DateTimeFormat('zh-u-ca-chinese', { dateStyle: 'full' }).format(date);
            const match = lunarStr.match(/(正月|腊月)(.*?)(?=星期)/);
            return match ? match[0] : '';
        } catch (e) {
            return '';
        }
    }

    function getHolidayLabels(dateLike) {
        const iso = toISODate(dateLike);
        if (!iso) return [];
        const year = Number(iso.slice(0, 4));
        const ranges = HOLIDAY_RANGES_BY_YEAR[year] || [];
        return ranges
            .filter(item => iso >= item.start && iso <= item.end)
            .map(item => item.label);
    }

    function getHeaderMetaParts(dateLike) {
        const parts = [];
        const lunarLabel = getLunarLabel(dateLike);
        if (lunarLabel) {
            parts.push({ type: 'lunar', text: `(${lunarLabel})` });
        }
        getHolidayLabels(dateLike).forEach(label => {
            parts.push({ type: 'holiday', text: label });
        });
        return parts;
    }

    function getHeaderMetaText(dateLike) {
        return getHeaderMetaParts(dateLike).map(part => part.text).join('，');
    }

    function getHeaderMetaHtml(dateLike) {
        const parts = getHeaderMetaParts(dateLike);
        if (parts.length === 0) return '';
        const html = parts
            .map((part, index) => {
                const delimiter = index > 0 ? '<span class="date-meta-separator">，</span>' : '';
                return `${delimiter}<span class="${part.type === 'holiday' ? 'holiday-label' : 'lunar-label'}">${escapeHtml(part.text)}</span>`;
            })
            .join('');
        return `<span class="schedule-date-meta">${html}</span>`;
    }

    function createHeaderMetaElement(dateLike) {
        const parts = getHeaderMetaParts(dateLike);
        if (parts.length === 0) return null;

        const container = document.createElement('span');
        container.className = 'schedule-date-meta';

        parts.forEach((part, index) => {
            if (index > 0) {
                const separator = document.createElement('span');
                separator.className = 'date-meta-separator';
                separator.textContent = '，';
                container.appendChild(separator);
            }

            const span = document.createElement('span');
            span.className = part.type === 'holiday' ? 'holiday-label' : 'lunar-label';
            span.textContent = part.text;
            container.appendChild(span);
        });

        return container;
    }

    window.ScheduleDateLabels = {
        getHolidayLabels,
        getHeaderMetaParts,
        getHeaderMetaText,
        getHeaderMetaHtml,
        createHeaderMetaElement
    };
})();
