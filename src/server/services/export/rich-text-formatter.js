/**
 * Rich Text 格式化器 —— 兼容外壳
 *
 * 规则本体已收敛到全系统唯一实现 public/js/utils/schedule-calendar-core.js
 * （服务端 Excel 与浏览器报销视图共用同一份行模型 / 课程文本 / 费用口径）。
 * 本文件只做两件事：
 *   1. 原样再导出核心的 RichText，保证既有服务端调用方与测试的 require 路径不变；
 *   2. 补上 Excel 专属的 getTextColor（ARGB 色值只有导出文件需要，浏览器渲染用 CSS 色）。
 *
 * part 模型（每条 run 可独立着色，同一行可多段不同颜色）：
 *   { text, colorType, dim, isSuperscript, startsLine }
 *   - startsLine: true → 渲染器在本 run 前插入换行（第一 run 跳过）
 */

const { RICH_TEXT_COLORS } = require('./export-constants');
const Core = require('../../../../public/js/utils/schedule-calendar-core.js');

const RichTextFormatter = Object.assign({}, Core.RichText);

/**
 * 获取文本片段的颜色（优先读 dim，向下兼容 isCancelled/isAdjusted）
 * @param {Object} part - 文本片段
 * @returns {string} 颜色代码
 */
RichTextFormatter.getTextColor = function (part) {
    const isDim = part.dim || part.isCancelled || part.isAdjusted;
    switch (part.colorType) {
        case 'red':
            return isDim ? RICH_TEXT_COLORS.RED_LIGHT : RICH_TEXT_COLORS.RED;
        case 'blue':
            return isDim ? RICH_TEXT_COLORS.BLUE_LIGHT : RICH_TEXT_COLORS.BLUE;
        default:
            return isDim ? RICH_TEXT_COLORS.BLACK_LIGHT : RICH_TEXT_COLORS.BLACK;
    }
};

module.exports = RichTextFormatter;
