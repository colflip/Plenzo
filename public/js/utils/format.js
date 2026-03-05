window.formatUtils = {
    TIME_ZONE: 'Asia/Shanghai',
    formatDate: function (date) {
        return new Date(date).toLocaleDateString('zh-CN', { timeZone: this.TIME_ZONE });
    },
    formatTime: function (time) {
        if (!time || typeof time !== 'string') return '';
        return time.slice(0, 5);
    },
    formatDateTimeDisplay: function (dateLike) {
        if (!dateLike) return '--';
        const date = new Date(dateLike);
        if (Number.isNaN(date.getTime())) return '--';

        const formatter = new Intl.DateTimeFormat('en-CA', {
            timeZone: this.TIME_ZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        return formatter.format(date).replace(', ', ' ');
    }
};

// Expose globally for backward compatibility
window.formatDate = window.formatUtils.formatDate;
window.formatTime = window.formatUtils.formatTime;
window.formatDateTimeDisplay = window.formatUtils.formatDateTimeDisplay;
