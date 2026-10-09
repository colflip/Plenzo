/**
 * 服务端「课程类型折算」入口 —— 只是再导出一份，实现不在这里。
 *
 * 实现物理位置：`public/js/utils/type-conversion.js`（UMD，浏览器 `<script>` 与服务端
 * `require` 共用同一份，全系统唯一）。为什么不能把它搬进 `src/server/domain/`：
 * 浏览器只能取到 `public/` 下的静态文件，而 Vercel 的 `public/` 命中优先级在函数改写
 * 之前（`vercel.json` 的 rewrites 对已存在的静态文件不生效）。真搬走就得为这一个 .js
 * 开一条函数路由，让登录页的 `<script src>` 去等 serverless 冷启动，换来的只是目录好看。
 *
 * 所以这里给服务端一个**按领域命名**的依赖点：调用方写 `require('../../domain/type-conversion')`
 * 而不是 `require('../../../../public/js/utils/type-conversion')`，「折算与颜色规则属于领域层」
 * 这件事在依赖方向上读得出来；真要搬家时，只有这个文件需要改。
 *
 * （审查报告 P2-9；本仓库里「钱的规则」的另一半 —— 每日明细行模型与趟费聚合 —— 同理，
 * 见同目录的 `schedule-calendar-core.js`。）
 */

module.exports = require('../../../public/js/utils/type-conversion');
