/**
 * 学生端 / 教师端统计页共享的小工具（两处逐字相同）。
 */

/** 统计页日期输入框用的 YYYY-MM-DD（本地时区，配合 <input type="date">） */
export function formatDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/** 日期范围选择器默认填本月 1 号到月末（两端输入框 id 一致：teachingStartDate/EndDate） */
export function setupDateRangePickers() {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);

    const startDateInput = document.getElementById('teachingStartDate');
    const endDateInput = document.getElementById('teachingEndDate');

    if (startDateInput) {
        startDateInput.value = formatDate(firstDay);
    }
    if (endDateInput) {
        endDateInput.value = formatDate(lastDay);
    }
}

/**
 * 确保 Chart.js 已就绪后返回可 await 的 promise（图表库由 /js/utils/load-chart.js 按需加载）。
 *
 * 背景：6a7c232 把阻塞首屏的 Chart.js <script> 换成按需加载器后，教师/学生统计模块
 * 没有任何调用点触发 loader，`Chart` 一直是 undefined，渲染图表时同步抛错并被
 * 「授课统计/每日授课统计加载失败」错误态吞掉。此处统一预热 + 渲染前 await，
 * 图表库与接口请求并行下载，不增加可感知延迟。
 *
 * 与 admin/legacy-adapter.js 的同名实现共用 window.__chartReadyPromise，避免重复下载。
 */
export function ensureChartReady() {
    if (typeof window.Chart !== 'undefined') return Promise.resolve();
    if (typeof window.loadChart !== 'function') {
        return Promise.reject(new Error('图表组件加载失败'));
    }
    if (!window.__chartReadyPromise) {
        window.__chartReadyPromise = window.loadChart().catch(error => {
            window.__chartReadyPromise = null;
            throw error;
        });
    }
    return window.__chartReadyPromise.then(() => {
        if (typeof window.Chart === 'undefined') throw new Error('图表组件加载失败');
    });
}

/**
 * 课程类型图例配色：优先 window.ColorUtils（三端 dashboard.html 都加载），
 * 未加载时用固定调色板兜底，保证图例颜色稳定可读。
 */
export function getLegendColor(name) {
    if (window.ColorUtils && window.ColorUtils.getLegendColor) {
        return window.ColorUtils.getLegendColor(name);
    }
    // Fallback if not loaded
    const hash = Array.from(String(name || '')).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
    const fallbackPalette = ['#3366CC', '#FF9933', '#33CC99', '#DC3912', '#7C4DFF'];
    return fallbackPalette[hash % fallbackPalette.length];
}
