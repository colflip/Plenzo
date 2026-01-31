/**
 * Date Utility Functions
 * Standardizes time handling across the application.
 */

const TIME_ZONE = 'Asia/Shanghai';

/**
 * Format date to YYYY-MM-DD HH:MM:SS in Beijing Time (UTC+8)
 * @param {string|Date|number} dateLike - Date to format
 * @returns {string} Formatted date string or '--' if invalid
 */
export function formatDateTimeDisplay(dateLike) {
    if (!dateLike) return '--';
    const date = new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '--';

    // Use Intl.DateTimeFormat for consistent Beijing Time (UTC+8)
    // en-CA locale gives YYYY-MM-DD format
    // hour12: false gives 24-hour format
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });

    // en-CA output: "YYYY-MM-DD, HH:mm:ss"
    // We want: "YYYY-MM-DD HH:mm:ss"
    return formatter.format(date).replace(', ', ' ');
}

/**
 * Format date to YYYY-MM-DD in Beijing Time (UTC+8)
 * @param {string|Date|number} dateLike - Date to format
 * @returns {string} Formatted date string or '--' if invalid
 */
export function formatDateDisplay(dateLike) {
    if (!dateLike) return '--';
    const date = new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '--';

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });

    return formatter.format(date);
}
