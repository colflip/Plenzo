/**
 * 排课视图截图（图片 → 剪贴板）
 *
 * 从管理员端「双击学生姓名导出课表图片」那条路原样抽出，供三端复用：
 *   - 管理员：captureStudentRowToClipboard(student, tr) —— 一行一个学生，截单行
 *   - 教师 / 学生：captureWeekTableToClipboard() —— 视图本身是单行 7 天网格，截整表
 *
 * 截的是页面上已经渲染好的真实 DOM，因此导出结果与屏幕所见一致：
 * 周切换、「显示全部安排」开关、卡片水印、状态胶囊都直接继承当前视图状态。
 */

function scrollWidthWithBuffer(el) {
    return Math.max(el.scrollWidth, 1200) + 50;
}

/**
 * 克隆容器要落在哪一份 CSS 作用域里。
 * dashboard.css 的周视图规则是按区块 id 写的：admin 是 #schedule，教师/学生是 #schedules，
 * 班主任是学生课表那个 #student-schedules（8627 起）。以前一律硬写成 #schedule：
 * 教师/学生端页面自己注入的样式（在 #schedules 作用域下）在克隆体上全部失效，
 * 而 #schedule 那批 !important 反而生效 → 截图与屏幕不一致。
 */
function captureScopeIdOf(originalTable) {
    const host = originalTable.closest('#schedule, #schedules, #student-schedules');
    return (host && host.id) || 'schedule';
}

/**
 * 创建离屏截图容器 + 复制原表格外观的空 <table>（含表头边框/圆角）。
 * 供单行截图与整表截图复用。
 */
function buildCaptureWrapper(originalTable) {
    const wrapper = document.createElement('div');
    // 复用作用域 id 是有意的：dashboard.css 的周视图规则按 #schedule / #schedules /
    // #student-schedules 写，克隆体拿不到同一个 id 就会截出与屏幕不一致的样式。
    // 代价是捕获期间文档里有两个同名 id，所以有两条硬约束（审查报告 P2-22）：
    //   1) 必须 append 到 body **末尾**（见 captureWrapperToClipboard），这样
    //      document.querySelector('#schedule') 仍然先命中屏幕上的原件；
    //   2) 克隆体标记 aria-hidden + data-capture-clone，任何按 id 扫描页面状态的代码
    //      都可以显式排除它，而不是依赖插入顺序的侥幸。
    wrapper.id = captureScopeIdOf(originalTable);
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.dataset.captureClone = 'true';
    wrapper.style.position = 'absolute';
    wrapper.style.top = '-9999px';
    wrapper.style.left = '0';
    wrapper.style.zIndex = '-1';
    wrapper.style.background = '#ffffff';
    wrapper.style.padding = '20px'; // Add white padding
    // Force width to match scrolling width of original table to prevent wrap
    wrapper.style.width = scrollWidthWithBuffer(originalTable) + 'px';

    const tableClone = document.createElement('table');
    tableClone.className = originalTable.className; // Copy classes: 'weekly-schedule-table'
    tableClone.style.cssText = originalTable.style.cssText;
    tableClone.style.backgroundColor = '#ffffff';
    tableClone.style.width = '100%';
    // 恢复外扩边框线及大圆角
    tableClone.style.borderTop = '1px solid #E2E8F0';
    tableClone.style.borderLeft = '1px solid #E2E8F0';
    tableClone.style.borderRight = '1px solid #E2E8F0';
    tableClone.style.borderRadius = '8px';
    tableClone.style.overflow = 'hidden';

    wrapper.appendChild(tableClone);
    return { wrapper, tableClone };
}

/**
 * 克隆表头行并保留列宽 / 去除 sticky 定位 / 补回边框。
 */
function buildCapturedHeader(originalHeaderTr) {
    const thead = document.createElement('thead');
    const headerRowClone = originalHeaderTr.cloneNode(true);

    const origThs = originalHeaderTr.querySelectorAll('th');
    const cloneThs = headerRowClone.querySelectorAll('th');

    origThs.forEach((th, index) => {
        if (cloneThs[index]) {
            const computed = getComputedStyle(th);
            cloneThs[index].style.width = computed.width;
            cloneThs[index].style.minWidth = computed.minWidth;
            cloneThs[index].style.maxWidth = computed.maxWidth;
            // Important: Handle sticky positioning for screenshot
            cloneThs[index].style.position = 'static';
            cloneThs[index].style.transform = 'none';
            // 修复表头边框线丢失
            cloneThs[index].style.borderRight = '1px solid #E2E8F0';
            cloneThs[index].style.borderBottom = '1px solid #E2E8F0';
        }
    });

    thead.appendChild(headerRowClone);
    return thead;
}

/**
 * 克隆一行学生排课并修复 cloneNode 引起的塌陷：
 *   - 同步列宽、去 sticky、补回单元格边框与底色
 *   - 重筑课程卡片圆角/边框/顶部彩条
 *   - 将 <select> 状态下拉替换为居中 <span>（html2canvas 无法正确渲染下拉对齐）
 */
function buildCapturedRow(originalTr) {
    const rowClone = originalTr.cloneNode(true);

    // Sync widths for cells (redundant but safe) and remove sticky
    const origTds = originalTr.querySelectorAll('td');
    const cloneTds = rowClone.querySelectorAll('td');

    origTds.forEach((td, index) => {
        if (cloneTds[index]) {
            const computed = getComputedStyle(td);
            cloneTds[index].style.width = computed.width;
            cloneTds[index].style.minWidth = computed.minWidth;
            // Handle sticky
            cloneTds[index].style.position = 'static';
            cloneTds[index].style.left = 'auto'; // Reset left offset

            // Ensure background is opaque white/gray, not transparent
            // Dashboard.css uses #FAFAFA for sticky cols
            // 姓名列有两种写法：管理员 .sticky-col / 班主任 .student-name-cell。
            // 不能用「第一列」判断 —— 教师与学生的周视图没有姓名列，首列是星期。
            if (td.classList.contains('sticky-col') || td.classList.contains('student-name-cell')) {
                cloneTds[index].style.backgroundColor = '#FAFAFA';
            } else {
                cloneTds[index].style.backgroundColor = '#FFFFFF';
            }

            // 修复表格内网格线丢失
            cloneTds[index].style.borderRight = '1px solid #E2E8F0';
            cloneTds[index].style.borderBottom = '1px solid #E2E8F0';
        }
    });

    // --- 重点：修复 cloneNode 导致的排版塌陷和状态错位 ---
    // 1. 修复课程卡片及底部附着层(费用区)的圆角与边界重叠
    const cloneCards = rowClone.querySelectorAll('.schedule-card, .unified-schedule-card, .schedule-card-group');
    cloneCards.forEach(card => {
        // 重筑大圆角、白底、大阴影以及彩色顶框，彻底克隆真实 dashboard.css 高优桌面样式以抗衡画布吞盖
        card.style.borderRadius = '12px';
        card.style.overflow = 'hidden';
        card.style.backgroundColor = '#FFFFFF';
        card.style.border = '1px solid #E2E8F0';
        card.style.boxShadow = '0 1px 2px rgba(0, 0, 0, 0.05)';

        if (card.classList.contains('slot-morning')) {
            card.style.borderTop = '4px solid #3B82F6';
        } else if (card.classList.contains('slot-afternoon')) {
            card.style.borderTop = '4px solid #F59E0B';
        } else if (card.classList.contains('slot-evening')) {
            card.style.borderTop = '4px solid #8B5CF6';
        }

        // 如果卡片底层存在附加的费用包裹块，原卡片的 overflow 可能被覆盖失效，需强制指定子元素底角
        const feeWrap = card.querySelector('.fee-bottom-wrap');
        if (feeWrap) {
            feeWrap.style.borderBottomLeftRadius = '11px';
            feeWrap.style.borderBottomRightRadius = '11px';
        }
    });
    // html2canvas 无法正确渲染 <select>（文字垂直对齐画错），克隆体里统一替换成只读 <span>。
    // 类名原样保留 —— 视觉几何完全由全局 CSS 驱动（span.status-select 的 inline-flex 居中 +
    // .schedule-card-group .status-select 的「行高=内容盒高度」），与页面上的胶囊同一套规则，
    // 不要再打内联样式补丁：line-height 等内联值会被样式表 !important 压掉，等于死代码。
    // 注意：cloneNode 不保留 <select> 的运行时 selectedIndex，需要从原始 DOM 读取。
    const origSelects = originalTr.querySelectorAll('select.status-select');
    const cloneSelects = rowClone.querySelectorAll('select.status-select');
    origSelects.forEach((origSel, idx) => {
        const cloneSel = cloneSelects[idx];
        if (!cloneSel) return;
        const opt = origSel.options[origSel.selectedIndex] || origSel.options[0];
        const text = opt ? opt.text : origSel.value || '';
        const span = document.createElement('span');
        span.className = origSel.className; // 保留 status-select + 状态颜色类
        span.textContent = text;
        cloneSel.parentNode.replaceChild(span, cloneSel);
    });

    return rowClone;
}

/**
 * 把离屏 wrapper 截图并写入剪贴板。
 *
 * Safari 兼容性靠的是「同步用 pending Promise 构造 ClipboardItem」，所以渲染必须在
 * write() 之前不被 await 掉；但这不等于要用 `new Promise(async (resolve) => …)` ——
 * 那种写法里 async 函数抛出的错会被吞成一个永不 settle 的外层 Promise（审查报告 P2-21），
 * 这里改成把纯 async 函数的返回 Promise 直接交给 ClipboardItem。
 * toast 与离屏容器一律在 finally 里收尾：以前只在 toBlob 回调和 catch 里 dismiss，
 * 中途任何一条中止路径都会让「正在生成图片…」永远挂在屏幕上。
 */
async function renderWrapperToPngBlob(wrapper) {
    try {
        // 等字体落地再截：Material Icons 现在是本地自托管且 font-display: block，
        // 抢在字体就绪前 html2canvas 会把 ligature 画成空白或原样文字（person / download）
        if (document.fonts && document.fonts.ready) await document.fonts.ready;
        const canvas = await html2canvas(wrapper, {
            scale: 2,
            backgroundColor: '#ffffff',
            logging: false,
            useCORS: true,
            width: wrapper.offsetWidth,
            height: wrapper.offsetHeight
        });
        return await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (!blob) { reject(new Error('生成图片为空')); return; }
                resolve(blob);
            }, 'image/png');
        });
    } finally {
        if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
    }
}

/** 剪贴板的 DOMException 常常 message 为空串，直接用会得到「失败: 」这种半句话 */
function describeCaptureError(err) {
    const message = String((err && err.message) || '').trim();
    if (message) return message;
    if (err && err.name === 'NotAllowedError') return '需要页面处于焦点，请点击课表区域后再试';
    return '剪贴板不可用，请聚焦页面后重试';
}

async function captureWrapperToClipboard(wrapper, toastId, successMsg) {
    // 必须是 body 末尾（P2-22 的约束 1）：换进 section 内部会改变 querySelector 的命中顺序
    document.body.appendChild(wrapper);
    try {
        const item = new ClipboardItem({ 'image/png': renderWrapperToPngBlob(wrapper) });
        await navigator.clipboard.write([item]);
        if (window.apiUtils) window.apiUtils.showSuccessToast(successMsg);
    } catch (err) {
        if (window.apiUtils) {
            window.apiUtils.showToast(`生成或复制图片失败: ${describeCaptureError(err)}`, 'error');
        }
    } finally {
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
        if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
    }
}

function requireHtml2canvas() {
    if (window.html2canvas) return true;
    if (window.apiUtils) window.apiUtils.showToast('组件未加载 (html2canvas missing)', 'error');
    return false;
}

/**
 * 管理员端：截「一个学生的一行」并复制。双击学生姓名走这里。
 * 班主任那块表格用的是 #ssWeekly* 一套 id，所以选择器可传。
 */
export async function captureStudentRowToClipboard(student, originalTr, {
    headerSelector = '#weeklyHeader',
    bodySelector = '#weeklyBody'
} = {}) {
    if (!requireHtml2canvas()) return;

    const toastId = window.apiUtils ? window.apiUtils.showToast('正在生成图片...', 'info', 0) : null;

    try {
        const originalHeaderTr = document.querySelector(`${headerSelector} tr`);
        const originalTable = document.querySelector(bodySelector)?.closest('table');
        // 与整表路径同一口径：窄屏那张桌面表还在 DOM 里但被 CSS 隐藏，截隐藏节点得到零宽画布，
        // 所以按可见性判定，不是按元素存在性
        if (!originalHeaderTr || !originalTable || !originalTable.offsetParent) {
            if (window.apiUtils) window.apiUtils.showToast('当前视图不是周课表，请在桌面端导出', 'warning');
            return;
        }

        const { wrapper, tableClone } = buildCaptureWrapper(originalTable);
        tableClone.appendChild(buildCapturedHeader(originalHeaderTr));

        const tbody = document.createElement('tbody');
        tbody.appendChild(buildCapturedRow(originalTr));
        tableClone.appendChild(tbody);

        await captureWrapperToClipboard(wrapper, toastId, `已复制 ${student.name} 的课表图片`);
    } finally {
        // 兜底：上面任何一条路径（含 buildCaptureWrapper 抛错）都不该把
        // 「正在生成图片…」留在屏幕上
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
    }
}

/**
 * 管理员 / 班主任：一行一个学生的网格，按钮触发时按学生数决定行为 ——
 * 只有一人有课直接截，多人有课先弹学生选择（弹窗复用报销单那套
 * weekly-view-export.js#pickStudentForWeeklyView，通过 window.pickWeeklyViewStudent 暴露），
 * 取消则什么都不做。
 */
export async function captureStudentRowWithPicker({
    headerSelector = '#weeklyHeader',
    bodySelector = '#weeklyBody',
    nameCellSelector = '.sticky-col.student-cell, .student-name-cell',
    noScheduleToast = '本周没有排课'
} = {}) {
    if (!requireHtml2canvas()) return;

    const tbody = document.querySelector(bodySelector);
    if (!tbody || !document.querySelector(`${headerSelector} tr`)) {
        if (window.apiUtils) window.apiUtils.showToast('当前视图不是学生排课表，请在桌面端导出', 'warning');
        return;
    }
    if (tbody.querySelector('.table-loading-row')) {
        if (window.apiUtils) window.apiUtils.showToast('数据加载中，请稍后再试', 'warning');
        return;
    }

    const rows = Array.from(tbody.querySelectorAll(':scope > tr'))
        .filter(tr => tr.querySelector('.schedule-card-group'))
        .map(tr => {
            const name = (tr.querySelector(nameCellSelector)?.textContent || '').trim() || '未知学生';
            return { id: tr.dataset.studentId || name, name, tr };
        });

    if (rows.length === 0) {
        if (window.apiUtils) window.apiUtils.showToast(noScheduleToast, 'warning');
        return;
    }
    if (rows.length === 1) {
        return captureStudentRowToClipboard(rows[0], rows[0].tr, { headerSelector, bodySelector });
    }

    if (typeof window.pickWeeklyViewStudent !== 'function') {
        if (window.apiUtils) window.apiUtils.showToast('学生选择组件未加载', 'error');
        return;
    }

    let chosen;
    try {
        chosen = await window.pickWeeklyViewStudent(rows.map(({ tr, ...target }) => target));
    } catch (_cancelled) {
        return;
    }
    const row = rows.find(r => String(r.id) === String(chosen.id)) || rows[0];
    await captureStudentRowToClipboard(row, row.tr, { headerSelector, bodySelector });
}

/**
 * 教师端 / 学生端：截「当前这一周的整张视图」并复制。
 *
 * 教师与学生的课程安排是单行 7 天网格（一天一格、格内多张课程卡片），
 * 整表就是完整的一周，不需要按行拆。
 */
export async function captureWeekTableToClipboard({
    headerSelector = '#weeklyHeader',
    bodySelector = '#weeklyBody',
    label = '本周课表'
} = {}) {
    if (!requireHtml2canvas()) return;

    const tbody = document.querySelector(bodySelector);
    const originalHeaderTr = document.querySelector(`${headerSelector} tr`);
    const originalTable = tbody ? tbody.closest('table') : null;

    // 窄屏走 renderMobileScheduleTable：桌面那张表还在 DOM 里但被隐藏，
    // 截隐藏节点会得到零宽画布，所以按可见性判定而不是按元素存在性
    if (!tbody || !originalHeaderTr || !originalTable || !originalTable.offsetParent) {
        if (window.apiUtils) window.apiUtils.showToast('当前视图不是周课表，请在桌面端导出', 'warning');
        return;
    }

    const toastId = window.apiUtils ? window.apiUtils.showToast('正在生成图片...', 'info', 0) : null;
    const fail = (msg, type = 'warning') => {
        if (window.apiUtils) window.apiUtils.showToast(msg, type);
    };

    try {
        // 骨架屏不是数据，截出来是一张假表
        if (tbody.querySelector('.table-loading-row')) {
            return fail('数据加载中，请稍后再试');
        }

        const rows = Array.from(tbody.querySelectorAll(':scope > tr'));
        if (rows.length === 0) return fail('本周没有排课');

        // 三端渲染器都只在真有课程时产出 .schedule-card-group；全空即本周无课
        if (!rows.some(tr => tr.querySelector('.schedule-card-group'))) {
            return fail('本周没有排课');
        }

        const { wrapper, tableClone } = buildCaptureWrapper(originalTable);
        tableClone.appendChild(buildCapturedHeader(originalHeaderTr));

        const cloneBody = document.createElement('tbody');
        rows.forEach(tr => cloneBody.appendChild(buildCapturedRow(tr)));
        tableClone.appendChild(cloneBody);

        await captureWrapperToClipboard(wrapper, toastId, `已复制${label}图片`);
    } finally {
        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
    }
}
