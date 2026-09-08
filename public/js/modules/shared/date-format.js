/**
 * 跨端共享的日期键格式化。
 *
 * 只收编「各端实现逐字等价」的两个函数；formatDateDisplay / formatWeekRangeText
 * 在 student 与 teacher 的 utils.js 里实现不同（展示口径不同），刻意**不**合并。
 * toISODate 采用更防御的 student 版（falsy / NaN 一律返回 null）。
 *
 * 统一折算到北京时区（Asia/Shanghai），避免 UTC 偏移把日期挪一天；
 * "en-CA" locale 的 format 结果就是 YYYY-MM-DD。
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
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(date);
}

/** 任意日期形态 → YYYY-MM-DD 键（无效输入返回 null），周视图分组用它对齐 */
export function normalizeDateKey(dateLike) {
    const iso = toISODate(dateLike);
    return iso || null;
}

/**
 * 中文长日期展示（2026年09月07日）。
 * ISO 字符串直接拆组件避免时区偏移；Date / 其它形态经 Intl 折算到北京时区。
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

/** 周范围标签：「2026年09月07日 - 2026年09月13日」 */
export function formatWeekRangeText(startDate, endDate) {
    return `${formatDateDisplay(startDate)} - ${formatDateDisplay(endDate)}`;
}
