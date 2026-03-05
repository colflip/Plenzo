/**
 * Utility for color standardization across all charts
 */
window.ColorUtils = {
    getLegendColor: function (name) {
        // Primary color mapping - matches admin dashboard exactly
        const LEGEND_COLOR_MAP = {
            // Core teaching types
            '入户': '#3366CC',           // Blue - primary teaching type
            '试教': '#FF9933',           // Orange - trial lessons
            '评审': '#7C4DFF',           // Purple - evaluations
            '评审记录': '#B39DDB',       // Light purple - evaluation records
            '心理咨询': '#33CC99',       // Teal - counseling
            '线上辅导': '#0099C6',       // Cyan - online tutoring
            '线下辅导': '#5C6BC0',       // Indigo - offline tutoring
            '集体活动': '#DC3912',       // Red - group activities
            '半次入户': '#4E79A7',       // Steel blue - half visit
            '家访': '#8E8CD8',           // Lavender - home visit

            // Extended types for comprehensive coverage
            '正式课': '#1976D2',         // Deep blue
            '体验课': '#FFA726',         // Amber
            '补课': '#66BB6A',           // Green
            '测评': '#AB47BC',           // Deep purple
            '家长会': '#EF5350',         // Light red
            '培训': '#26A69A',           // Teal green
            '观摩': '#5C6BC0',           // Blue grey
            '研讨': '#8D6E63',           // Brown
            '其他': '#78909C',           // Grey blue
            '未分类': '#9E9E9E'          // Grey - fallback
        };

        const key = String(name || '').trim();

        // Direct match
        if (key && LEGEND_COLOR_MAP[key]) {
            return LEGEND_COLOR_MAP[key];
        }

        // Partial match for flexibility (e.g., "入户课程" matches "入户")
        for (const [typeKey, color] of Object.entries(LEGEND_COLOR_MAP)) {
            if (key.includes(typeKey) || typeKey.includes(key)) {
                return color;
            }
        }

        // Fallback: generate consistent color from hash
        const hash = Array.from(key).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
        const fallbackPalette = [
            '#3366CC', '#FF9933', '#33CC99', '#DC3912', '#7C4DFF',
            '#0099C6', '#5C6BC0', '#66AA00', '#E91E63', '#00ACC1',
            '#8BC34A', '#FF5722', '#9C27B0', '#FF6F00', '#00897B'
        ];
        return fallbackPalette[hash % fallbackPalette.length];
    }
};
