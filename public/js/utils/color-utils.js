/**
 * Utility for color standardization across all charts
 *
 * 调色板设计（蓝主绿辅，与页面主题一致）：
 * - 每个业务族共用一个色相，深浅区分子类型
 * - 线上类型与线下业务等同 → 使用接近主色的中档
 * - 记录/半次类使用最浅档
 * - 类型源头是 schedule_types 表（admin 可动态增删），
 *   新增类型未命中映射时从扩展色池按 hash 取色
 */
window.ColorUtils = {
    LEGEND_COLOR_MAP: {
        // 评审族（业务主体 → 主蓝锚点）
        '评审': '#2563EB',
        '(线上)评审': '#60A5FA',
        '评审记录': '#93C5FD',

        // 入户族（品牌绿锚点）
        '入户': '#10B981',
        '(线上)入户': '#34D399',
        '半次入户': '#6EE7B7',

        // 咨询族（紫）
        '咨询': '#8B5CF6',
        '(线上)咨询': '#A78BFA',
        '咨询记录': '#C4B5FD',

        // 独立类型
        '试教': '#06B6D4',
        '集体活动': '#F59E0B',

        // 兜底
        '未分类': '#94A3B8'
    },

    // admin 动态新增类型的扩展色池
    EXTENDED_PALETTE: [
        '#F472B6', // 粉
        '#FB923C', // 橘
        '#6366F1', // 靛
        '#14B8A6', // 蓝绿
        '#FACC15', // 黄
        '#A3E635'  // 黄绿
    ],

    getLegendColor: function (name) {
        const key = String(name || '').trim();
        const map = this.LEGEND_COLOR_MAP;

        // Direct match
        if (key && map[key]) {
            return map[key];
        }

        // Partial match for flexibility (e.g., "入户课程" matches "入户").
        // Longest keys first so "(线上)入户" wins over "入户".
        const sortedKeys = Object.keys(map).sort((a, b) => b.length - a.length);
        for (const typeKey of sortedKeys) {
            if (key.includes(typeKey) || typeKey.includes(key)) {
                return map[typeKey];
            }
        }

        // Fallback: consistent color from hash over extended palette
        const hash = Array.from(key).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        return this.EXTENDED_PALETTE[hash % this.EXTENDED_PALETTE.length];
    }
};
