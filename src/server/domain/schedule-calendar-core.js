/**
 * 服务端「每日排课明细 / 趟费聚合」入口 —— 只是再导出一份，实现不在这里。
 *
 * 实现物理位置：`public/js/utils/schedule-calendar-core.js`（UMD：服务端 Excel 导出与
 * 浏览器报销视图共用同一份行模型、趟费去重、周键与明细排序）。不可搬进服务端的原因同
 * `type-conversion.js`：浏览器取不到 `src/` 下的文件，而 `public/` 静态命中优先于改写。
 *
 * 这一份是**费用口径**的所在：手填金额原样读取、明细填在哪显示在哪、合计按 (场次, 教师 pair)
 * 计一次 —— 任何服务端调用方都从本模块取，别再直接指到 public/ 路径上。
 */

module.exports = require('../../../public/js/utils/schedule-calendar-core');
