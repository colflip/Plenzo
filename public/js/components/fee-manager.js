/* ==========================================================================
 * 统一费用管理组件（FeeManager）
 *
 * 管理端与教师端共用，通过 config 参数适配不同角色与接口，避免重复代码。
 * - 日期范围选择（开始/结束日期）+ 学生视图聚合表格：
 *   一个学生一行（行首 sticky 学生列），表头列与逐条明细记录一一对应：
 *   学生 / 日期时间 / 老师 / 课程类型 / 上课地点 / 状态 / 交通 / 其他 / 总计 / 操作；
 *   学生行默认展开其下逐条课时明细（每条记录一行，字段与表头对齐），点学生姓名可收起；
 *   教师多教以「/」连接，状态以「完成4 待2」迷你拆解，合计为该生范围内求和（与顶部选择器严格对应）。
 * - 自带费用弹窗（DOM 由本组件动态注入，id 前缀 fm-，不与现有
 *   adminFeeManagementModal / feeManagementModal 冲突）
 * - 单条 PATCH 或 批量 POST 保存（由 saveMode 决定）
 * - “清除费用” = 置 null（未填写）后提交：汇总行清空该生范围内全部课时费用；明细行编辑浮窗清空当前单条课时费用。
 * - "导出报销单" = 注册周导出上下文并复用 window.exportWeeklyScheduleView（即报送报销用）
 *
 * 所有请求统一走 window.apiUtils（baseURL=/api），组件内只写相对路径。
 * ========================================================================== */
(function () {
    'use strict';

    const FeeManager = {};
    const stateMap = Object.create(null); // mountSelector -> { startDate, endDate, schedules }
    let modalReady = false;
    let activeModal = null; // { config, mode, schedules }

    // ---- 日期辅助 -------------------------------------------------------
    function pad(n) { return String(n).padStart(2, '0'); }
    function shortDate(iso) {
        if (!iso) return '-';
        const d = new Date(iso + 'T00:00:00');
        if (Number.isNaN(d.getTime())) return '-';
        return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function toISODate(d) {
        if (!d) return '';
        const date = d instanceof Date ? d : new Date(d);
        if (Number.isNaN(date.getTime())) return '';
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }
    function todayISO() { return toISODate(new Date()); }
    function startOfWeek(d) {
        const date = d instanceof Date ? new Date(d) : new Date(d);
        const day = date.getDay() || 7;
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - (day - 1));
        return date;
    }
    function addDays(iso, delta) {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + delta);
        return toISODate(d);
    }
    function formatChineseDate(iso) {
        if (!iso) return '';
        const d = new Date(iso + 'T00:00:00');
        if (Number.isNaN(d.getTime())) return iso;
        return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`;
    }
    function listDates(start, end) {
        const out = [];
        if (!start) return out;
        let cur = start;
        let guard = 0;
        while (cur <= (end || start) && guard < 400) {
            out.push(cur);
            cur = addDays(cur, 1);
            guard++;
        }
        return out;
    }

    function defaultRange() {
        const start = toISODate(startOfWeek(todayISO()));
        return { startDate: start, endDate: addDays(start, 6) };
    }

    // 后端 date 字段可能是 YYYY-MM-DD、ISO 时间串或 Date 对象；统一归一化为本地 YYYY-MM-DD
    function normalizeDate(value) {
        if (value == null || value === '') return '';
        if (typeof value === 'string') {
            if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
            const d = new Date(value);
            if (!Number.isNaN(d.getTime())) return toISODate(d);
            return value.split('T')[0] || '';
        }
        if (value instanceof Date) return toISODate(value);
        return String(value).split('T')[0] || '';
    }

    // ---- 数据规范化 -----------------------------------------------------
    function normalizeList(data) {
        let arr;
        if (Array.isArray(data)) arr = data;
        else if (data && Array.isArray(data.schedules)) arr = data.schedules;
        else if (data && Array.isArray(data.data)) arr = data.data;
        else if (data && Array.isArray(data.rows)) arr = data.rows;
        else arr = [];
        return arr.map(r => {
            if (!r) return r;
            // 后端实际字段名可能是 date / class_date / arr_date 等
            const raw = r.date != null ? r.date : (r.class_date || r.arr_date || r.schedule_date || r.course_date || '');
            r.date = normalizeDate(raw);
            return r;
        });
    }

    function statusText(s) {
        return { pending: '待确认', confirmed: '已确认', completed: '已完成', cancelled: '已取消' }[s] || s || '-';
    }
    function statusClass(s) { return `sstatus-${s || 'pending'}`; }
    function money(n) {
        const v = parseFloat(n) || 0;
        return v.toFixed(2);
    }
    // 费用字段「未填写」判定：后端 NULL / 空字符串 / 前端 NaN 均视为未填写
    function isUnfilled(v) {
        return v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
    }
    // 单条费用显示：未填写 → 灰色「—」；0 → ¥0.00（已填0）；正数 → ¥X.XX
    function feeDisplay(v) {
        if (isUnfilled(v)) return { text: '—', cls: 'fm-fee-empty' };
        const n = parseFloat(v) || 0;
        return { text: '¥' + money(n), cls: n === 0 ? 'fm-fee-zero' : 'fm-fee-set' };
    }
    // 学生汇总：统计某列是否全部未填写 + 求和（未填写按 0 计入金额）
    function summarizeFees(list, key) {
        let sum = 0, allEmpty = true;
        list.forEach(r => {
            const v = r[key];
            if (isUnfilled(v)) return;       // 未填写不参与求和，但保留全空标记
            allEmpty = false;                // 只要有一格填了（含 0）即算非空
            sum += parseFloat(v) || 0;
        });
        return { allEmpty, sum };
    }

    // ---- 主入口 ---------------------------------------------------------
    function mount(config) {
        const sel = config.mountSelector;
        if (!sel) return;
        const mountEl = document.querySelector(sel);
        if (!mountEl) return;

        // 已构建过：仅刷新数据与导出上下文（区块再次激活时调用）
        if (mountEl.dataset.fmBuilt === '1') {
            ensureExportContext(config);
            loadData(config, mountEl);
            return;
        }
        mountEl.dataset.fmBuilt = '1';

        // 窗口尺寸变化时重排汇总行字号 / 省略（防抖，仅绑定一次）
        if (!mountEl.dataset.fmResizeBound) {
            mountEl.dataset.fmResizeBound = '1';
            let rt;
            window.addEventListener('resize', () => {
                clearTimeout(rt);
                rt = setTimeout(() => fitSummaryRows(mountEl), 150);
            });
        }

        stateMap[sel] = { ...defaultRange(), schedules: [] };

        // 顶部工具栏直接复用排课管理页的 .header-toolbar.schedule-controls 组件结构，
        // 不额外写 inline style，避免内部组件与边缘的上下间距不一致。
        mountEl.innerHTML = `
            <div class="header-toolbar schedule-controls" style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
                <div class="sch-controls-left" style="display:flex; gap:16px; align-items:center;">
                    <div class="week-navigation">
                        <button class="nav-btn" data-fm="prev">
                            <span class="material-icons-round">chevron_left</span>
                        </button>
                        <span class="fm-range-label" data-fm="rangeLabel" title="点击修改日期范围"></span>
                        <div class="fm-range-inputs" data-fm="rangeInputs" style="display:none;">
                            <input type="date" data-fm="startDate">
                            <span>—</span>
                            <input type="date" data-fm="endDate">
                        </div>
                        <button class="nav-btn" data-fm="next">
                            <span class="material-icons-round">chevron_right</span>
                        </button>
                    </div>
                    ${(config.canExport !== false && (!window.permissionUtils || window.permissionUtils.atLeast(2))) ? `
                    <button class="add-btn" data-fm="export" title="导出报销单">
                        <span class="material-icons-round">image</span>
                        <span>导出报销单</span>
                    </button>` : ''}
                </div>
                <div class="fm-toolbar-right">
                    ${config.feeStatusFilter ? `
                    <select class="fm-fee-filter" data-fm="feeStatusFilter" title="按费用状态筛选">
                        <option value="">全部状态</option>
                        ${FEE_STATUSES.map(code => `<option value="${code}">${FEE_STATUS[code].label}</option>`).join('')}
                    </select>` : ''}
                    ${config.enableBatchFeeStatus ? `
                    <div class="fm-action-group">
                        <button class="fm-action-btn" data-fm="batchPanel" title="批量设置费用状态">
                            <span class="material-icons-round">playlist_add_check</span>
                            <span>批量设置状态</span>
                        </button>
                        <button class="fm-action-btn act-success" data-fm="completeReimburse" title="将本周范围内未报销的标记为已报销">
                            <span class="material-icons-round">check</span>
                            <span>完成报销</span>
                        </button>
                        <button class="fm-action-btn act-danger" data-fm="returnReimburse" title="将本周范围内已报销的退回（撤销报销）">
                            <span class="material-icons-round">reply</span>
                            <span>退回报销</span>
                        </button>
                    </div>` : ''}
                </div>
            </div>
            <div class="fm-batch-bar" data-fm="batchBar" style="display:none;"></div>
            <div class="weekly-table-container fm-table-card">
                <table class="weekly-schedule-table">
                    <thead data-fm="thead"></thead>
                    <tbody data-fm="tbody"></tbody>
                    <tfoot data-fm="summary"></tfoot>
                </table>
            </div>
            <div class="feedback" data-fm="feedback" style="display:none; margin-top:12px;"></div>
        `;

        ensureModal();
        wireToolbar(config, mountEl);
        ensureExportContext(config);
        loadData(config, mountEl);
    }

    function wireToolbar(config, mountEl) {
        const sel = config.mountSelector;
        const rangeLabel = mountEl.querySelector('[data-fm="rangeLabel"]');
        const rangeInputs = mountEl.querySelector('[data-fm="rangeInputs"]');
        const startInput = mountEl.querySelector('[data-fm="startDate"]');
        const endInput = mountEl.querySelector('[data-fm="endDate"]');

        const updateDisplay = () => {
            const st = stateMap[sel];
            rangeLabel.textContent = `${formatChineseDate(st.startDate)} - ${formatChineseDate(st.endDate)}`;
            startInput.value = st.startDate;
            endInput.value = st.endDate;
        };

        const applyRange = () => {
            let start = startInput.value || todayISO();
            let end = endInput.value || todayISO();
            if (start > end) end = start;
            stateMap[sel].startDate = start;
            stateMap[sel].endDate = end;
            updateDisplay();
            rangeLabel.style.display = '';
            rangeInputs.style.display = 'none';
            loadData(config, mountEl);
        };

        const shiftRange = (deltaDays) => {
            const st = stateMap[sel];
            st.startDate = addDays(st.startDate, deltaDays);
            st.endDate = addDays(st.endDate, deltaDays);
            updateDisplay();
            loadData(config, mountEl);
        };

        updateDisplay();

        rangeLabel.addEventListener('click', () => {
            rangeLabel.style.display = 'none';
            rangeInputs.style.display = 'flex';
            startInput.focus();
        });
        startInput.addEventListener('change', applyRange);
        endInput.addEventListener('change', applyRange);

        mountEl.querySelector('[data-fm="prev"]').addEventListener('click', () => shiftRange(-7));
        mountEl.querySelector('[data-fm="next"]').addEventListener('click', () => shiftRange(7));
        // 权限落地（Phase 3）：L3 不渲染导出按钮（按钮可能不存在，需判空）
        const exportBtn = mountEl.querySelector('[data-fm="export"]');
        if (exportBtn) exportBtn.addEventListener('click', () => doExport(config));

        // 费用状态筛选
        const filterSel = mountEl.querySelector('[data-fm="feeStatusFilter"]');
        if (filterSel) {
            filterSel.addEventListener('change', () => {
                stateMap[sel].feeStatusFilter = filterSel.value;
                loadData(config, mountEl);
            });
        }
        // 批量设置状态面板
        const batchBtn = mountEl.querySelector('[data-fm="batchPanel"]');
        if (batchBtn) {
            batchBtn.addEventListener('click', () => toggleBatchBar(config, mountEl));
        }
        // 完成报销（本周一键标记已报销，跳过已报销）
        const completeBtn = mountEl.querySelector('[data-fm="completeReimburse"]');
        if (completeBtn) {
            completeBtn.addEventListener('click', () => doCompleteReimburse(config, mountEl));
        }
        // 退回报销（本周已报销的撤销报销，仅作用于已报销状态）
        const returnBtn = mountEl.querySelector('[data-fm="returnReimburse"]');
        if (returnBtn) {
            returnBtn.addEventListener('click', () => doReturnReimburse(config, mountEl));
        }
    }

    // 批量面板：范围（本周全部 / 当前筛选结果）+ 目标状态 + 备注
    function toggleBatchBar(config, mountEl) {
        const bar = mountEl.querySelector('[data-fm="batchBar"]');
        if (!bar) return;
        if (bar.style.display !== 'none' && bar.dataset.fmBatchOpen === '1') {
            bar.style.display = 'none';
            bar.dataset.fmBatchOpen = '0';
            return;
        }
        const filterOpt = config.feeStatusFilter
            ? `<label>仅含状态<select data-fm="batchScopeStatus"><option value="">不限</option>${FEE_STATUSES.map(c => `<option value="${c}">${FEE_STATUS[c].label}</option>`).join('')}</select></label>`
            : '';
        bar.innerHTML = `
            <div class="fm-batch-field">
                <span class="fm-batch-label">范围</span>
                <select data-fm="batchRange">
                    <option value="week">本周全部</option>
                    <option value="filtered">当前筛选结果</option>
                </select>
            </div>
            ${config.feeStatusFilter ? `
            <div class="fm-batch-field">
                <span class="fm-batch-label">仅含状态</span>
                <select data-fm="batchScopeStatus"><option value="">不限</option>${FEE_STATUSES.map(c => `<option value="${c}">${FEE_STATUS[c].label}</option>`).join('')}</select>
            </div>` : ''}
            <div class="fm-batch-field">
                <span class="fm-batch-label">目标状态</span>
                <select data-fm="batchTarget">${FEE_STATUSES.map(c => `<option value="${c}">${FEE_STATUS[c].label}</option>`).join('')}</select>
            </div>
            <div class="fm-batch-field">
                <span class="fm-batch-label">备注</span>
                <input type="text" data-fm="batchNote" placeholder="可选">
            </div>
            <button class="fm-batch-apply" data-fm="batchApply">应用</button>
            <span data-fm="batchMsg" class="fm-batch-msg"></span>
        `;
        bar.style.display = 'flex';
        bar.dataset.fmBatchOpen = '1';
        bar.querySelector('[data-fm="batchApply"]').addEventListener('click', () => applyBatchFeeStatus(config, mountEl, bar));
    }

    // 批量提交费用状态
    async function applyBatchFeeStatus(config, mountEl, bar) {
        if (!config.feeStatusBase) return;
        const range = bar.querySelector('[data-fm="batchRange"]').value;
        const target = bar.querySelector('[data-fm="batchTarget"]').value;
        const note = bar.querySelector('[data-fm="batchNote"]').value || '';
        const scopeStatus = bar.querySelector('[data-fm="batchScopeStatus"]')
            ? bar.querySelector('[data-fm="batchScopeStatus"]').value : '';
        const st = stateMap[config.mountSelector];
        let payload;
        if (range === 'week') {
            payload = { scope: { startDate: st.startDate, endDate: st.endDate, fee_status: scopeStatus || undefined }, fee_status: target, note };
        } else {
            // 当前筛选结果：取已加载且（若设了筛选）匹配的记录 id
            const ids = st.schedules
                .filter(r => !scopeStatus || (r.fee_status || 'draft') === scopeStatus)
                .map(r => r.id);
            if (!ids.length) {
                bar.querySelector('[data-fm="batchMsg"]').textContent = '没有符合条件的排课';
                return;
            }
            payload = { ids, fee_status: target, note };
        }
        const msg = bar.querySelector('[data-fm="batchMsg"]');
        const applyBtn = bar.querySelector('[data-fm="batchApply"]');
        if (applyBtn) { applyBtn.disabled = true; applyBtn.style.opacity = '0.6'; }
        msg.textContent = '处理中...';
        try {
            const r = await window.apiUtils.post(`${config.feeStatusBase}/batch-fee-status`, payload);
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast(r.message || '批量更新成功', 'success');
            else if (window.showToast) window.showToast(r.message || '批量更新成功', 'success');
            loadData(config, mountEl);
        } catch (err) {
            msg.textContent = '失败：' + (err.message || '未知错误');
        } finally {
            if (applyBtn) { applyBtn.disabled = false; applyBtn.style.opacity = ''; }
        }
    }

    // 完成报销：本周范围内未报销的标记为已报销（跳过已报销，避免重复审计）
    async function doCompleteReimburse(config, mountEl) {
        if (!config.feeStatusBase) return;
        const st = stateMap[config.mountSelector];
        const ok = await fmConfirm({
            title: '完成报销',
            message: `将把本周（${formatChineseDate(st.startDate)} 至 ${formatChineseDate(st.endDate)}）范围内尚未报销的排课标记为「已报销」。已报销的将自动跳过。`,
            confirmText: '确认报销',
        });
        if (!ok) return;
        const btn = mountEl.querySelector('[data-fm="completeReimburse"]');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
        try {
            const r = await window.apiUtils.post(`${config.feeStatusBase}/batch-fee-status`, {
                scope: { startDate: st.startDate, endDate: st.endDate },
                fee_status: 'reimbursed',
                skipStatus: 'reimbursed',
                note: '完成报销',
            });
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast(r.message || '已完成报销', 'success');
            else if (window.showToast) window.showToast(r.message || '已完成报销', 'success');
            loadData(config, mountEl);
        } catch (err) {
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('操作失败：' + (err.message || '未知错误'), 'error');
            else if (window.showToast) window.showToast('操作失败：' + (err.message || '未知错误'), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        }
    }

    // 退回报销：本周范围内「已报销」的撤销报销（仅作用于已报销状态，避免误退未报销项），跳过已退回
    async function doReturnReimburse(config, mountEl) {
        if (!config.feeStatusBase) return;
        const st = stateMap[config.mountSelector];
        const ok = await fmConfirm({
            title: '退回报销',
            message: `将把本周（${formatChineseDate(st.startDate)} 至 ${formatChineseDate(st.endDate)}）范围内「已报销」的排课标记为「退回报销」（撤销报销）。非已报销状态的将自动跳过。此操作可经审计追溯。`,
            confirmText: '确认退回',
        });
        if (!ok) return;
        const btn = mountEl.querySelector('[data-fm="returnReimburse"]');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
        try {
            const r = await window.apiUtils.post(`${config.feeStatusBase}/batch-fee-status`, {
                scope: { startDate: st.startDate, endDate: st.endDate, fee_status: 'reimbursed' },
                fee_status: 'reimbursement_returned',
                skipStatus: 'reimbursement_returned',
                note: '退回报销',
            });
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast(r.message || '已退回报销', 'success');
            else if (window.showToast) window.showToast(r.message || '已退回报销', 'success');
            loadData(config, mountEl);
        } catch (err) {
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('操作失败：' + (err.message || '未知错误'), 'error');
            else if (window.showToast) window.showToast('操作失败：' + (err.message || '未知错误'), 'error');
        } finally {
            if (btn) { btn.disabled = false; btn.style.opacity = ''; }
        }
    }

    // ---- 数据加载与渲染（学生视图：一个学生一行，默认展开明细） -------
    // 列数 = 表头列数（学生 / 日期时间 / 老师 / 课程类型 / 上课地点 / 状态 / 交通 / 其他 / 总计 / 操作）
    const STUDENT_COLS = 10;
    const STATUS_SHORT = { completed: '完成', pending: '待', confirmed: '确认', cancelled: '取消' };

    // 费用报销状态（与后端 validateFeeStatusTransition / feeStatus.js 保持一致）
    const FEE_STATUSES = ['draft', 'teacher_submitted', 'admin_submitted', 'reimbursed', 'returned', 'reimbursement_returned'];
    const FEE_STATUS = {
        draft:             { label: '待提交', cls: 'fm-fee-draft' },
        teacher_submitted: { label: '待审核', cls: 'fm-fee-submitted' },
        admin_submitted:   { label: '已审核', cls: 'fm-fee-reviewed' },
        reimbursed:        { label: '已报销', cls: 'fm-fee-reimbursed' },
        returned:          { label: '已退回', cls: 'fm-fee-returned' },
        reimbursement_returned: { label: '退回报销', cls: 'fm-fee-reimbursement-returned' },
    };
    function feeStatusInfo(s) { return FEE_STATUS[s] || FEE_STATUS.draft; }

    // 汇总行高度固定 60px。不同列采用不同适配策略：
    //  · 日期时间 / 上课地点（列索引 1/4）：【自适应】——
    //    字号随内容收缩（最小 13px）；单行放下则单行；放不下→双行截断（最多 2 行 + 省略）。不做跑马灯。
    //  · 老师（列索引 2）：保持 14px 不缩字号；单行放下则单行，放不下→双行截断（14px + 省略）。
    //  · 排课及状态（列索引 3）：自定义双行（类型一行 + 状态一行），固定 14px 不缩字号（fitMergedCell）。
    //  · 费用状态（列索引 5）：固定 14px，任何情况下强制「最多两行 + 剩余省略」（fitFeeStatusCell）。
    //  · 学生 / 交通 / 其他 / 总计：沿用原【按列统一】压缩（最小 12px），保持汇总行格式统一。
    // 列宽基准仍由【明细行】决定（colgroup 已设基础宽度），汇总行长文本只被动省略，不撑宽列。
    // 所有被省略/裁切的汇总单元格统一由 applySummaryTitles() 悬浮显示全量信息。

    // 自适应单元格（列索引 1~5）：字号收缩 → 单行 → 双行截断
    function fitAdaptiveCell(td, idx) {
        // 全站字号下限已统一为 14px（PC 端），这里不再向下收缩字号，
        // 直接进入单行 → 双行截断的降级路径，靠 -webkit-line-clamp 控制高度。
        const BASE = 14;
        const MIN = 14;
        if (td._fmOrig === undefined) td._fmOrig = td.innerHTML;
        else td.innerHTML = td._fmOrig;   // resize 重排时从原始内容重新判定

        const setFont = (s) => {
            td.style.fontSize = s + 'px';
            td.querySelectorAll('*').forEach(el => { el.style.fontSize = s + 'px'; });
        };
        const clamp = td.querySelector('.fm-cell-clamp');

        // 日期时间列（idx=1）与地点列：单行优先，放不下再缩字号（最小 13px），
        // 仍放不下才双行截断。列宽由明细行决定，汇总区间 MM-DD~MM-DD 短于明细日期，单行可放下。
        // 老师列（idx=2）：单行放下则 14px 单行；放不下直接双行截断（14px + 省略），不缩字号。

        // 阶段 1：单行，字号逐步压缩到下限
        const oneLine = () => {
            td.style.whiteSpace = 'nowrap';
            td.style.overflow = 'hidden';
            td.style.textOverflow = '';
            if (clamp) {
                clamp.style.display = 'inline';
                clamp.style.webkitLineClamp = 'unset';
                clamp.style.whiteSpace = 'nowrap';
                clamp.style.overflow = 'visible';
            }
        };
        oneLine();
        let size = BASE;
        setFont(size);
        while (size > MIN && td.scrollWidth > td.clientWidth + 1) { size--; setFont(size); }
        if (td.scrollWidth <= td.clientWidth + 1) return; // 单行放下

        // 阶段 2：双行截断（最多 2 行 + 省略），不进跑马灯
        if (clamp) {
            clamp.style.display = '';
            clamp.style.webkitLineClamp = '2';
            clamp.style.whiteSpace = 'normal';
            clamp.style.overflow = 'hidden';
        }
        td.style.whiteSpace = 'normal';
        td.style.overflow = 'hidden';
        setFont(MIN);
    }

    // 汇总行「排课及状态」双行（类型一行 + 状态一行）
    function fitMergedCell(td) {
        // 原先字号从 14px 递减到 12px 以塞进固定 60px 行高。PC 端字号下限已统一为 14px，
        // 这里改为固定 14px：行高不够时由 dashboard.css 的 -webkit-line-clamp 截断，
        // 而不是把中文缩到 12px 以下。
        const MIN = 14;
        const lines = td.querySelectorAll('.fm-ms-line');
        const setFont = (s) => {
            td.style.fontSize = s + 'px';
            lines.forEach(l => {
                l.style.fontSize = s + 'px';
                l.querySelectorAll('*').forEach(el => { el.style.fontSize = s + 'px'; });
            });
        };
        let size = 14;
        setFont(size);
        while (size > MIN && td.scrollHeight > td.clientHeight + 1) { size--; setFont(size); }
    }

    // 汇总行「费用状态」列：不做字号自适应——任何情况下强制「最多两行 + 省略」，
    // 两行放不下的内容以省略号收起；行高保持固定 60px 不变。
    // 钳制样式（display/-webkit-line-clamp/overflow/white-space）由 dashboard.css 的
    // !important 规则统一保证，这里仅清空历史内联残留；悬浮全量提示由 applySummaryTitles() 处理。
    function fitFeeStatusCell(td) {
        td.style.fontSize = '';
        td.querySelectorAll('*').forEach(el => { el.style.fontSize = ''; });
        const clamp = td.querySelector('.fm-cell-clamp');
        if (!clamp) return;
        ['display', 'webkitLineClamp', 'whiteSpace', 'overflow'].forEach(p => { clamp.style[p] = ''; });
    }

    function fitSummaryRows(mountEl) {
        const tbody = mountEl.querySelector('[data-fm="tbody"]');
        if (!tbody) return;
        const ADAPTIVE = new Set([1, 2, 4]); // 日期时间 / 老师 / 上课地点（费用状态与排课及状态单独处理）

        // 按列收集汇总行单元格（排除操作列）
        const colCells = {};
        tbody.querySelectorAll('tr.fm-stu-row').forEach(row => {
            const tds = Array.from(row.querySelectorAll('td:not(.fm-ops)'));
            tds.forEach((td, i) => {
                (colCells[i] = colCells[i] || []).push(td);
            });
        });

        Object.keys(colCells).forEach(ci => {
            const cells = colCells[ci];
            const idx = parseInt(ci, 10);
            if (idx === 3) {
                // 排课及状态：汇总行自定义双行（类型一行 + 状态一行），字号收缩适配
                cells.forEach(td => fitMergedCell(td));
                return;
            }
            if (idx === 5) {
                // 费用状态：固定 14px，任何情况下最多两行，放不下→剩余省略（行高恒定 60px）
                cells.forEach(td => fitFeeStatusCell(td));
                return;
            }
            if (ADAPTIVE.has(idx)) {
                cells.forEach(td => fitAdaptiveCell(td, idx));
                return;
            }
            // 其余列（学生 / 交通 / 其他 / 总计）：原先按列统一压缩到最小 12px。
            // PC 端字号下限已统一为 14px，且这个循环以 getComputedStyle 为起点——
            // 若仍允许下探，任何 CSS 侧的字号上调都会被它缩回去、只多出省略号。
            const MIN = 14;
            cells.forEach(td => {
                td.style.whiteSpace = 'nowrap';
                td.style.overflow = 'hidden';
                td.style.textOverflow = 'ellipsis';
                td.style.fontSize = '';
                td.querySelectorAll('*').forEach(el => { el.style.fontSize = ''; });
            });
            const bases = cells.map(td => {
                let b = parseFloat(window.getComputedStyle(td).fontSize) || 14;
                td.querySelectorAll('*').forEach(el => {
                    const c = parseFloat(window.getComputedStyle(el).fontSize);
                    if (c > b) b = c;
                });
                return b;
            });
            const apply = (s) => cells.forEach(td => {
                td.style.fontSize = s + 'px';
                td.querySelectorAll('*').forEach(el => { el.style.fontSize = s + 'px'; });
            });
            let size = Math.max.apply(null, bases);
            apply(size);
            const allFit = () => cells.every(td => td.scrollWidth <= td.clientWidth + 1);
            while (size > MIN && !allFit()) {
                size -= 1;
                apply(size);
            }
        });

        // 适配完成后统一检测截断并挂悬浮提示（title 显示全量信息）
        applySummaryTitles(mountEl);
    }

    // 汇总行悬浮提示：任何被省略/裁切的汇总单元格，鼠标悬浮时经 title 默认显示该字段全量信息
    function applySummaryTitles(mountEl) {
        const tbody = mountEl.querySelector('[data-fm="tbody"]');
        if (!tbody) return;
        tbody.querySelectorAll('tr.fm-stu-row').forEach(row => {
            row.querySelectorAll('td:not(.fm-ops)').forEach(td => {
                const info = summaryCellTitleInfo(td);
                if (info.truncated && info.text) td.setAttribute('title', info.text);
                else td.removeAttribute('title');
            });
        });
    }

    // 单个汇总单元格的截断判定与全量文本
    function summaryCellTitleInfo(td) {
        const msLines = td.querySelectorAll('.fm-ms-line');
        if (msLines.length) { // 排课及状态：两行各自省略
            const lines = Array.from(msLines);
            return {
                truncated: lines.some(l => l.scrollWidth > l.clientWidth + 1),
                text: lines.map(l => l.textContent.trim()).filter(Boolean).join('\n')
            };
        }
        const nameSpan = td.querySelector('.fm-stu-name');
        if (nameSpan) { // 学生名（span 自身省略）
            return { truncated: nameSpan.scrollWidth > nameSpan.clientWidth + 1, text: nameSpan.textContent.trim() };
        }
        const clamp = td.querySelector('.fm-cell-clamp');
        if (clamp) {
            // 多值 token 单元格：分隔符是 CSS ::before 生成，不在 textContent 里，需按 token 拼接
            const tokens = Array.from(clamp.querySelectorAll('.fm-token')).map(t => t.textContent.trim());
            const text = tokens.length ? tokens.join(' ') : (clamp.textContent || '').replace(/\s+/g, ' ').trim();
            return {
                truncated: clampOverflowed(clamp) || td.scrollWidth > td.clientWidth + 1,
                text
            };
        }
        return {
            truncated: td.scrollWidth > td.clientWidth + 1,
            text: (td.textContent || '').replace(/\s+/g, ' ').trim()
        };
    }

    // 判定 -webkit-line-clamp 是否截断：临时放大允许行数测自然高度，与钳制后实际高度比较。
    // 注意：dashboard.css 对费用状态列钳制使用了 !important，普通内联覆盖无效，
    // 必须以内联 !important 临时改写（内联 important 优先级高于样式表 important）。
    function clampOverflowed(clamp) {
        if (!clamp) return false;
        const prev = clamp.style.webkitLineClamp;
        clamp.style.setProperty('-webkit-line-clamp', '99', 'important');
        const naturalH = clamp.scrollHeight;
        if (prev) clamp.style.webkitLineClamp = prev;
        else clamp.style.removeProperty('-webkit-line-clamp');
        return naturalH > clamp.clientHeight + 2;
    }

    async function loadData(config, mountEl) {
        const sel = config.mountSelector;
        const tbody = mountEl.querySelector('[data-fm="tbody"]');
        const container = mountEl.querySelector('.fm-table-card');
        const feedback = mountEl.querySelector('[data-fm="feedback"]');
        const st = stateMap[sel];
        if (!tbody) return;

        // 先渲染表头，便于加载遮罩探测表头实际高度（与排课管理一致）
        renderHeader(mountEl);

        // 清空数据区，改用与排课管理统一的加载过渡遮罩
        if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(tbody, '');
        else tbody.innerHTML = '';
        if (feedback) feedback.style.display = 'none';
        if (window.showTableLoading && container) {
            window.showTableLoading(container, '正在加载费用数据...', '[data-fm="thead"]');
        }

        try {
            const params = { startDate: st.startDate, endDate: st.endDate };
            if (config.feeStatusFilter && st.feeStatusFilter) params.fee_status = st.feeStatusFilter;
            const data = await window.apiUtils.get(config.listEndpoint, params);
            // 后端已按 startDate/endDate 用 BETWEEN 过滤；此处再做客户端兜底，
            // 确保表格严格只显示所选日期选择器范围内的记录（防御端点差异/边界）。
            const all = normalizeList(data);
            st.schedules = all.filter(r => {
                const d = r.date || '';
                return d >= st.startDate && d <= st.endDate;
            });
            renderRows(config, mountEl, st.schedules);
            updateSummary(mountEl, st);
            // 汇总行高度固定 60px：渲染完成后按列宽压缩字号 / 省略（等布局稳定）
            if (window.requestAnimationFrame) window.requestAnimationFrame(() => fitSummaryRows(mountEl));
            else fitSummaryRows(mountEl);
        } catch (err) {
            const errHtml = `<tr><td colspan="${STUDENT_COLS}" style="text-align:center; padding:32px; color:#ef4444;">加载失败，请重试</td></tr>`;
            tbody.innerHTML = errHtml;
            updateSummary(mountEl, { schedules: [], startDate: st.startDate, endDate: st.endDate });
        } finally {
            // 无论成功或失败，均淡出隐藏加载遮罩
            if (window.hideTableLoading && container) {
                window.hideTableLoading(container);
            }
        }
    }

    function renderHeader(mountEl) {
        const thead = mountEl.querySelector('[data-fm="thead"]');
        if (!thead) return;
        // 表头列名/位置与下方明细记录（逐条课时）的字段一一对应：
        // 学生 / 日期时间 / 老师 / 排课及状态 / 上课地点 / 费用状态 / 交通 / 其他 / 总计 / 操作
        // （原「课程类型」与「状态」合并为「排课及状态」：汇总行各占一行、明细行同行显示）
        const cols = ['学生', '日期时间', '老师', '排课及状态', '上课地点', '费用状态', '交通', '其他', '总计', '操作'];
        // 每列基础宽度（px，作为 table-layout:auto 下的列宽下限）：
        // 列宽基准是【明细行】每条课时记录（单老师名/单课程类型等短内容），而非汇总行的聚合长文本。
        // 排课及状态（合并）需更宽以容纳「类型，状态」；费用状态独立列。
        const colWidths = ['80px', '155px', '120px', '150px', '95px', '90px', '70px', '70px', '80px', '90px'];
        if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(thead, '');
        else thead.innerHTML = '';

        // 插入 colgroup 控制列宽分布（table-layout:auto 下作为最小宽度建议）
        const table = thead.closest('table');
        if (table) {
            const existingColgroup = table.querySelector('colgroup');
            if (existingColgroup) existingColgroup.remove();
            const colgroup = document.createElement('colgroup');
            colWidths.forEach((w, i) => {
                const col = document.createElement('col');
                if (w) col.style.width = w;
                // 老师(i=2)/课程类型(i=3) 不设宽度 → 自动分配剩余空间
                colgroup.appendChild(col);
            });
            table.insertBefore(colgroup, thead);
        }

        const tr = document.createElement('tr');
        cols.forEach((c, i) => {
            const th = document.createElement('th');
            th.textContent = c;
            if (i === 0) th.className = 'sticky-col student-cell';
            tr.appendChild(th);
        });
        thead.appendChild(tr);
    }

    // 按学生聚合（保序 + 按姓名排序）
    function aggregateByStudent(schedules) {
        const groups = new Map();
        const order = [];
        schedules.forEach(rec => {
            const key = rec.student_id != null ? String(rec.student_id)
                : ('__' + (rec.student_name || '未分配'));
            if (!groups.has(key)) { groups.set(key, []); order.push(key); }
            groups.get(key).push(rec);
        });
        order.sort((a, b) => {
            const na = groups.get(a)[0].student_name || '';
            const nb = groups.get(b)[0].student_name || '';
            return na.localeCompare(nb, 'zh');
        });
        return { groups, order };
    }

    function statusMini(list) {
        const cnt = {};
        list.forEach(r => {
            const s = r.status || 'pending';
            cnt[s] = (cnt[s] || 0) + 1;
        });
        return Object.keys(cnt).map(s => `${STATUS_SHORT[s] || s}${cnt[s]}`);
    }

    // 汇总行费用状态迷你计数：返回 { code, text }，code 用于按状态分色（fm-fee-*）
    function feeStatusMini(list) {
        const cnt = {};
        list.forEach(r => {
            const s = r.fee_status || 'draft';
            cnt[s] = (cnt[s] || 0) + 1;
        });
        return Object.keys(cnt).map(s => ({ code: s, text: `${FEE_STATUS[s].label}${cnt[s]}` }));
    }

    // 将多个值渲染为独立 token 包入 .fm-cell-clamp 内层 span：汇总行「老师/课程类型/上课地点/状态」列
    // 双行显示 + 省略；单元格内每个值之间的间距由 CSS 变量 --fm-token-gap 统一调控（自定义），
    // 分隔符由 --fm-token-sep 调控。直接给 td 设 display:-webkit-box 会破坏表格布局，故用内层 span 承载 clamp。
    function setClampTokens(td, values) {
        const span = document.createElement('span');
        span.className = 'fm-cell-clamp';
        values.forEach(v => {
            const t = document.createElement('span');
            t.className = 'fm-token';
            t.textContent = v;
            span.appendChild(t);
        });
        td.textContent = '';
        td.appendChild(span);
    }

    // 折叠明细行：逐条课时（日期/时间/类型/状态/交通/其他/改）；默认展开
    // 明细记录：每条课时记录渲染为一行，字段与表头列一一对应（学生列留白不显示内容）
    function buildDetailRows(config, key, list) {
        const frag = document.createDocumentFragment();
        let prevDt = null; // 追踪上一行日期时间，相同则留空（表示复用上方）
        list.slice().sort((a, b) =>
            (a.date || '').localeCompare(b.date || '') ||
            (a.start_time || '').localeCompare(b.start_time || '')
        ).forEach(r => {
            const tr = document.createElement('tr');
            tr.className = 'fm-detail';
            tr.dataset.stuDetail = key;

            const blankTd = document.createElement('td');
            blankTd.className = 'fm-detail-blank';
            tr.appendChild(blankTd);

            const teacher = r.teacher_name || '未分配';
            const typeStr = r.schedule_type_cn || r.schedule_type || r.schedule_types || '课程';
            const locationText = r.location || r.address || '-';
            const start = r.start_time ? r.start_time.substring(0, 5) : '--';
            const end = r.end_time ? r.end_time.substring(0, 5) : '--';
            const days = ['日', '一', '二', '三', '四', '五', '六'];
            const dt = new Date((r.date || '') + 'T00:00:00');
            const dtText = r.date
                ? `周${days[dt.getDay()]}（${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}，${start} - ${end}）`
                : '-';
            // 日期时间与上一行相同时留空（复用上行），并标记该行为「重复行」(去掉下方分割线)
            const isDup = (prevDt !== null && dtText === prevDt);
            if (!isDup) prevDt = dtText;
            else tr.classList.add('fm-dup-row');
            // 已取消课程：整行斜体显示（反馈）
            if (String(r.status || '').toLowerCase() === 'cancelled') tr.classList.add('fm-cancelled');

            const tFee = parseFloat(r.transport_fee) || 0;
            const oFee = parseFloat(r.other_fee) || 0;
            const total = tFee + oFee;

            const addCell = (cls, html, extra) => {
                const td = document.createElement('td');
                td.className = 'fm-detail-td fm-d-' + cls + (extra ? ' ' + extra : '');
                if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(td, html);
                else td.innerHTML = html;
                tr.appendChild(td);
            };
            // 费用列显示规则（空数据统一显示灰色「—」，不再混用「-」/「—」/「0」）：
            //   费用管理页每行均为「有课」记录；
            //   显式 fee_status='draft'（待提交）→ 金额未提交不展示，三列均显示灰色「—」；
            //   已提交 → 交通/其他按 feeDisplay 显示（未填写→「—」，显式填 0→¥0.00，正数→¥X.XX）；
            //   总计：交通与其他均未填写 → 「—」（无合计可展示）；任一项有值 → ¥合计（合计 0 即显式 0 → ¥0.00）。
            const isDraft = r.fee_status === 'draft';
            let tDisp, oDisp, totalDisp;
            if (isDraft) {
                const dash = { text: '—', cls: 'fm-fee-empty' };
                tDisp = dash; oDisp = dash; totalDisp = dash;
            } else {
                tDisp = feeDisplay(r.transport_fee);
                oDisp = feeDisplay(r.other_fee);
                totalDisp = (isUnfilled(r.transport_fee) && isUnfilled(r.other_fee))
                    ? { text: '—', cls: 'fm-fee-empty' }
                    : { text: '¥' + money(total), cls: total === 0 ? 'fm-fee-zero' : 'fm-fee-set' };
            }
            // 顺序与表头对齐：日期时间 / 老师 / 排课及状态 / 上课地点 / 费用状态 / 交通 / 其他 / 总计 / 操作
            addCell('datetime', isDup ? '' : dtText);
            addCell('teacher', teacher);
            addCell('merged', `${esc(typeStr)}，${esc(statusText(r.status))}`);
            addCell('location', locationText);
            // 费用状态：管理员/班主任可编辑（下拉）；普通教师只读 pill
            // 下拉与只读 pill 统一用 fs.cls（fm-fee-*）分色：原始状态码（teacher_submitted 等）
            // 与 CSS 类名（fm-fee-submitted 等）不一致，直接拼接会导致可编辑态无颜色
            const fs = feeStatusInfo(r.fee_status);
            const feeStatusHtml = config.canEditFeeStatus
                ? `<select class="status-select ${fs.cls}" data-fm-fs-id="${r.id}">`
                    + FEE_STATUSES.map(code => `<option value="${code}"${code === (r.fee_status || 'draft') ? ' selected' : ''}>${FEE_STATUS[code].label}</option>`).join('')
                    + `</select>`
                : `<span class="status-select ${fs.cls}">${fs.label}</span>`;
            addCell('feestatus', feeStatusHtml, 'fm-center');
            addCell('fee', tDisp.text, 'fm-num ' + tDisp.cls);
            addCell('fee', oDisp.text, 'fm-num ' + oDisp.cls);
            addCell('summary', totalDisp.text, 'fm-num ' + totalDisp.cls);
            const opTd = document.createElement('td');
            opTd.className = 'fm-detail-td fm-d-op fm-ops';
            if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(opTd, `<button class="fm-edit-one" data-fm="edit-one" data-id="${r.id}">编辑</button>`);
            else opTd.innerHTML = `<button class="fm-edit-one" data-fm="edit-one" data-id="${r.id}">编辑</button>`;
            tr.appendChild(opTd);

            frag.appendChild(tr);
        });
        return frag;
    }

    function renderRows(config, mountEl, schedules) {
        const tbody = mountEl.querySelector('[data-fm="tbody"]');
        if (!tbody) return;
        if (!schedules.length) {
            tbody.innerHTML = `<tr><td colspan="${STUDENT_COLS}" style="text-align:center; padding:32px; color:#94a3b8;">暂无排课记录</td></tr>`;
            return;
        }

        if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(tbody, '');
        else tbody.innerHTML = '';

        const { groups, order } = aggregateByStudent(schedules);

        order.forEach(key => {
            const list = groups.get(key);
            const name = list[0].student_name || '未分配';
            const tAgg = summarizeFees(list, 'transport_fee');
            const oAgg = summarizeFees(list, 'other_fee');

            const tr = document.createElement('tr');
            tr.className = 'fm-stu-row';
            tr.dataset.stu = key;

            const nameTd = document.createElement('td');
            nameTd.className = 'sticky-col student-cell fm-stu-name-cell';
            // 明细默认展开，箭头初始为收起方向（▾）
            if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(nameTd, `<span class="fm-expand-toggle" data-fm="toggle" title="展开/收起明细">▾</span><span class="fm-stu-name" data-fm="toggle">${name}</span>`);
            else nameTd.innerHTML = `<span class="fm-expand-toggle" data-fm="toggle" title="展开/收起明细">▾</span><span class="fm-stu-name" data-fm="toggle">${name}</span>`;
            tr.appendChild(nameTd);

            // 日期范围（MM-DD~MM-DD）：与表头「日期时间」列对应（汇总为区间）
            const dates = list.map(r => r.date).filter(Boolean).sort();
            const dateRange = dates.length
                ? (dates[0] === dates[dates.length - 1] ? shortDate(dates[0]) : `${shortDate(dates[0])}~${shortDate(dates[dates.length - 1])}`)
                : '-';
            const tdDate = document.createElement('td');
            const dateClamp = document.createElement('span');
            dateClamp.className = 'fm-cell-clamp';
            // 日期范围同行显示（MM-DD~MM-DD）；列宽由明细行（周X（MM-DD，HH:MM - HH:MM））决定，区间短于明细日期，单行可放下
            dateClamp.textContent = dateRange;
            tdDate.appendChild(dateClamp);
            tr.appendChild(tdDate);

            // 老师（去重）：每个值作为独立 token，单元格内间距由 CSS --fm-token-gap 统一调控
            const teachers = [...new Set(list.map(r => r.teacher_name).filter(Boolean))];
            const tdTeacher = document.createElement('td');
            setClampTokens(tdTeacher, teachers.length ? teachers : ['未分配']);
            tr.appendChild(tdTeacher);

            // 排课及状态（合并列）：第一行=课程类型（去重），第二行=排课状态迷你计数
            const types = [...new Set(list.map(r => r.schedule_type_cn || r.schedule_type || r.schedule_types).filter(Boolean))];
            const tdType = document.createElement('td');
            tdType.className = 'fm-center';
            const merged = document.createElement('div');
            merged.className = 'fm-merged-summary';
            const typeLine = document.createElement('div');
            typeLine.className = 'fm-ms-line fm-ms-type';
            typeLine.textContent = types.length ? types.join(' / ') : '-';
            const statusLine = document.createElement('div');
            statusLine.className = 'fm-ms-line fm-ms-status';
            statusLine.textContent = statusMini(list).join('  ') || '-';
            merged.appendChild(typeLine);
            merged.appendChild(statusLine);
            tdType.appendChild(merged);
            tr.appendChild(tdType);

            // 上课地点（去重）
            const locs = [...new Set(list.map(r => r.location || r.address).filter(Boolean))];
            const tdLoc = document.createElement('td');
            setClampTokens(tdLoc, locs.length ? locs : ['-']);
            tr.appendChild(tdLoc);

            // 费用状态（汇总：各状态独立分色胶囊，颜色与明细行 .fm-fee-* 一致）
            const tdFeeStatus = document.createElement('td');
            tdFeeStatus.className = 'fm-center';
            const fsClamp = document.createElement('span');
            fsClamp.className = 'fm-cell-clamp fm-center';
            feeStatusMini(list).forEach(({ code, text }) => {
                const tk = document.createElement('span');
                tk.className = 'fm-token fm-fee-pill ' + feeStatusInfo(code).cls;
                tk.textContent = text;
                fsClamp.appendChild(tk);
            });
            tdFeeStatus.appendChild(fsClamp);
            tr.appendChild(tdFeeStatus);

            // 交通：全部未填写显示灰色「—」，否则 ¥合计（含全 0 情形 = ¥0.00）
            const tEmpty = tAgg.allEmpty;
            const tText = tEmpty ? '—' : '¥' + money(tAgg.sum);
            const tCls = tEmpty ? 'fm-fee-empty' : (tAgg.sum === 0 ? 'fm-fee-zero' : 'fm-fee-set');
            const oEmpty = oAgg.allEmpty;
            const oText = oEmpty ? '—' : '¥' + money(oAgg.sum);
            const oCls = oEmpty ? 'fm-fee-empty' : (oAgg.sum === 0 ? 'fm-fee-zero' : 'fm-fee-set');
            const totalEmpty = tEmpty && oEmpty;
            const totalText = totalEmpty ? '—' : '¥' + money(tAgg.sum + oAgg.sum);
            const totalCls = totalEmpty ? 'fm-fee-empty' : 'fm-fee-set';

            const tdT = document.createElement('td');
            tdT.className = 'fm-num ' + tCls;
            tdT.textContent = tText;
            tr.appendChild(tdT);

            const tdO = document.createElement('td');
            tdO.className = 'fm-num ' + oCls;
            tdO.textContent = oText;
            tr.appendChild(tdO);

            const tdTotal = document.createElement('td');
            tdTotal.className = 'fm-num ' + totalCls;
            tdTotal.textContent = totalText;
            tr.appendChild(tdTotal);

            const tdOps = document.createElement('td');
            tdOps.className = 'fm-ops';
            if (window.SecurityUtils) {
                window.SecurityUtils.safeSetHTML(tdOps, `
                    <button class="fm-btn fm-btn-edit" data-fm="edit-stu">编辑</button>
                    <button class="fm-btn fm-btn-clear" data-fm="clear-stu">清除</button>
                `);
            } else {
                tdOps.innerHTML = `
                    <button class="fm-btn fm-btn-edit" data-fm="edit-stu">编辑</button>
                    <button class="fm-btn fm-btn-clear" data-fm="clear-stu">清除</button>
                `;
            }
            tr.appendChild(tdOps);

            tbody.appendChild(tr);
            tbody.appendChild(buildDetailRows(config, key, list));
        });

        // 事件绑定
        const toggleDetail = (row) => {
            const key = row.dataset.stu;
            const details = Array.from(tbody.querySelectorAll('tr.fm-detail')).filter(d => d.dataset.stuDetail === key);
            if (!details.length) return;
            const willOpen = details[0].style.display !== 'table-row';
            details.forEach(d => { d.style.display = willOpen ? 'table-row' : 'none'; });
            const arrow = row.querySelector('.fm-expand-toggle');
            if (arrow) arrow.textContent = willOpen ? '▾' : '▸';
            // 明细行是列宽基准，展开/收起会改变列宽：重新执行汇总行字号适配与悬浮提示
            if (window.requestAnimationFrame) window.requestAnimationFrame(() => fitSummaryRows(mountEl));
        };
        // 整行点击（按钮除外）展开/收起该学生的明细记录
        tbody.querySelectorAll('tr.fm-stu-row').forEach(row => {
            row.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                toggleDetail(row);
            });
        });
        tbody.querySelectorAll('[data-fm="edit-stu"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const row = btn.closest('tr.fm-stu-row');
                const list = groups.get(row.dataset.stu) || [];
                if (list.length) openModal(config, 'multi', list);
            });
        });
        tbody.querySelectorAll('[data-fm="clear-stu"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const row = btn.closest('tr.fm-stu-row');
                const list = groups.get(row.dataset.stu) || [];
                if (!list.length) return;
                const nameEl = row.querySelector('.fm-stu-name');
                const name = nameEl ? nameEl.textContent.trim() : '该学生';
                const ok = await fmConfirm({
                    title: '确认清除费用',
                    message: `将清除「${name}」范围内 ${list.length} 条课时的交通 / 其他费用（置空/未填写），此操作不可撤销。`,
                    confirmText: '确认清除',
                    danger: true,
                });
                if (ok) batchClear(config, mountEl, list);
            });
        });
        tbody.querySelectorAll('[data-fm="edit-one"]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.id;
                const rec = schedules.find(r => String(r.id) === String(id));
                if (rec) openModal(config, 'single', [rec]);
            });
        });
        // 费用状态下拉（管理员/班主任可编辑）：选择即提交流转
        if (config.canEditFeeStatus) {
            tbody.querySelectorAll('select.status-select[data-fm-fs-id]').forEach(sel => {
                sel.addEventListener('change', (e) => {
                    e.stopPropagation();
                    patchFeeStatus(config, mountEl, sel.dataset.fmFsId, sel.value);
                });
                sel.addEventListener('click', (e) => e.stopPropagation());
            });
        }
    }

    // 单条费用状态流转（PATCH /{base}/:id/fee-status）
    async function patchFeeStatus(config, mountEl, id, target, note) {
        if (!config.feeStatusBase) return;
        try {
            await window.apiUtils.patch(`${config.feeStatusBase}/${id}/fee-status`, { fee_status: target, note: note || '' });
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('费用状态已更新', 'success');
            else if (window.showToast) window.showToast('费用状态已更新', 'success');
            loadData(config, mountEl);
        } catch (err) {
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('更新失败：' + (err.message || '未知错误'), 'error');
            else if (window.showToast) window.showToast('更新失败：' + (err.message || '未知错误'), 'error');
            loadData(config, mountEl); // 失败回刷，恢复下拉原值
        }
    }

    function updateSummary(mountEl, st) {
        const tfoot = mountEl.querySelector('[data-fm="summary"]');
        if (!tfoot) return;
        const schedules = st.schedules || [];
        let t = 0, o = 0;
        schedules.forEach(s => { t += parseFloat(s.transport_fee) || 0; o += parseFloat(s.other_fee) || 0; });
        const studentCount = new Set(
            schedules.map(s => s.student_id != null ? String(s.student_id) : ('__' + (s.student_name || '未分配')))
        ).size;
        const rangeText = (st.startDate && st.endDate)
            ? `${formatChineseDate(st.startDate)} 至 ${formatChineseDate(st.endDate)}`
            : '';
        if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(tfoot, '');
        else tfoot.innerHTML = '';
        const tr = document.createElement('tr');
        // 汇总行靠右显示，数字加粗（与学生数/课时/金额对应）
        tr.innerHTML = `<td colspan="${STUDENT_COLS}" style="padding:12px 16px; text-align:right; background:#ffffff; font-weight:500; color:#475569; border-top:2px solid #e5e7eb; white-space:nowrap;">
            共 <strong>${studentCount}</strong> 名学生 / <strong>${schedules.length}</strong> 课时（${rangeText}）｜
            交通 <strong>¥${money(t)}</strong> / 其他 <strong>¥${money(o)}</strong> / 总计 <strong>¥${money(t + o)}</strong>
        </td>`;
        tfoot.appendChild(tr);
    }

    // 一键清除某生范围内全部课时费用（置 null/未填写 后提交，不弹窗）
    async function batchClear(config, mountEl, list) {
        const updates = list.map(s => ({ id: s.id, teacher_uid: s.teacher_uid, transport_fee: null, other_fee: null }));
        try {
            await persist(config, updates);
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('费用已清除', 'success');
            else if (window.showToast) window.showToast('费用已清除', 'success');
            loadData(config, mountEl);
        } catch (err) {
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('清除失败：' + (err.message || '未知错误'), 'error');
            else if (window.showToast) window.showToast('清除失败：' + (err.message || '未知错误'), 'error');
        }
    }

    // HTML 转义，避免学生/教师/类型等字段中的特殊字符破坏结构或造成 XSS
    function esc(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
            .replace(/`/g, '&#96;').replace(/=/g, '&#x3D;').replace(/\//g, '&#x2F;');
    }

    // 轻量确认弹窗（视觉风格与 .modal / .modal-content 一致），返回 Promise<boolean>。
    // danger=true 时确认按钮为红色，且默认聚焦「取消」，避免危险操作被误触。
    function fmConfirm({ title = '确认操作', message = '', confirmText = '确定', cancelText = '取消', danger = false } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);backdrop-filter:blur(var(--overlay-blur, 4px));-webkit-backdrop-filter:blur(var(--overlay-blur, 4px));z-index:100003;display:flex;align-items:center;justify-content:center;';
            const box = document.createElement('div');
            box.style.cssText = 'background:#fff;border-radius:12px;padding:22px 24px;max-width:380px;width:90%;box-shadow:0 10px 40px rgba(0,0,0,.2);font-family:inherit;';
            const confirmColor = danger ? '#E74C3C' : '#2ECC71';
            box.innerHTML = `
                <div style="font-size: var(--fs-400);font-weight:600;color:#1e293b;margin-bottom:8px;">${esc(title)}</div>
                ${message ? `<div style="font-size: var(--fs-300);color:#64748b;margin-bottom:18px;line-height:1.5;">${esc(message)}</div>` : '<div style="height:6px;"></div>'}
                <div style="display:flex;gap:10px;justify-content:flex-end;">
                    <button id="fmConfirmCancel" style="padding:8px 18px;border:1px solid #e2e8f0;background:#fff;border-radius:6px;cursor:pointer;font-size: var(--fs-300);color:#475569;">${esc(cancelText)}</button>
                    <button id="fmConfirmOk" style="padding:8px 18px;border:none;background:${confirmColor};color:#fff;border-radius:6px;cursor:pointer;font-size: var(--fs-300);">${esc(confirmText)}</button>
                </div>
            `;
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const cleanup = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };
            const finish = (val) => { cleanup(); resolve(val); };
            box.querySelector('#fmConfirmOk').addEventListener('click', () => finish(true));
            box.querySelector('#fmConfirmCancel').addEventListener('click', () => finish(false));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
            box.querySelector('#fmConfirmCancel').focus();
        });
    }

    // ---- 费用弹窗（动态注入，仅一次） ----------------------------------
    function ensureModal() {
        if (modalReady) return;
        if (document.getElementById('fmFeeModal')) { modalReady = true; return; }
        const modal = document.createElement('div');
        modal.id = 'fmFeeModal';
        modal.className = 'modal';
        modal.style.display = 'none';
        // 遮罩与过渡动画统一由 .modal / .modal-content 提供（与排课管理 #scheduleModal 一致），
        // 不再内嵌 .modal-overlay，避免双重遮罩使背景过暗。
        modal.innerHTML = `
            <div class="modal-content" style="width: 480px; max-width: 95vw;">
                <div class="modal-header">
                    <h3 id="fmFeeModalTitle">费用管理</h3>
                    <button class="modal-close" id="fmCloseBtn"><span class="material-icons-round">close</span></button>
                </div>
                <div class="modal-body">
                    <form id="fmFeeForm">
                        <div id="fmDynamicFeeInputsContainer" style="display:none; width:100%;"></div>
                        <div class="form-group" id="fmDefaultGroup">
                            <label>交通费 (元)</label>
                            <input type="number" id="fmTransportInput" placeholder="0.00" step="0.5" min="0" max="999999.99">
                        </div>
                        <div class="form-group" id="fmDefaultOtherGroup">
                            <label>其他费用 (元)</label>
                            <input type="number" id="fmOtherInput" placeholder="0.00" step="0.5" min="0" max="999999.99">
                        </div>
                        <div class="form-group">
                            <label><strong>总计费用 (元)</strong></label>
                            <div id="fmTotalDisplay" style="font-size: var(--fs-500); font-weight:bold; color:#27AE60; margin-top:8px;">0.00</div>
                        </div>
                        <div class="modal-footer" style="margin-top:24px; display:flex; gap:10px; justify-content:flex-end;">
                            <button type="button" class="btn btn-secondary" id="fmClearBtn" style="background:#9ca3af;">清除费用</button>
                            <button type="button" class="btn btn-secondary" id="fmCancelBtn" style="background:#9ca3af;">取消</button>
                            <button type="submit" class="btn btn-primary" id="fmSaveBtn">保存并提交</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // 点击遮罩（弹窗自身空白处）关闭，与排课管理弹窗行为一致
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        modal.querySelector('#fmCloseBtn').addEventListener('click', closeModal);
        modal.querySelector('#fmCancelBtn').addEventListener('click', closeModal);
        modal.querySelector('#fmFeeForm').addEventListener('submit', onModalSubmit);
        modal.querySelector('#fmClearBtn').addEventListener('click', onClear);

        // 交通费/其他费用输入时实时合计
        const tInput = modal.querySelector('#fmTransportInput');
        const oInput = modal.querySelector('#fmOtherInput');
        const updTotal = () => {
            const t = parseFloat(tInput.value) || 0;
            const o = parseFloat(oInput.value) || 0;
            modal.querySelector('#fmTotalDisplay').textContent = money(t + o);
        };
        tInput.addEventListener('input', updTotal);
        oInput.addEventListener('input', updTotal);

        modalReady = true;
    }

    function openModal(config, mode, schedules) {
        activeModal = { config, mode, schedules };
        const modal = document.getElementById('fmFeeModal');
        if (!modal) return;
        const defaultGroup = modal.querySelector('#fmDefaultGroup');
        const defaultOther = modal.querySelector('#fmDefaultOtherGroup');
        const container = modal.querySelector('#fmDynamicFeeInputsContainer');
        const tInput = modal.querySelector('#fmTransportInput');
        const oInput = modal.querySelector('#fmOtherInput');

        const title = modal.querySelector('#fmFeeModalTitle');
        title.textContent = mode === 'multi' ? '批量编辑费用' : '费用录入';

        // 批量模式加宽浮窗以容纳按日期分组的条目；单条模式恢复默认宽度
        const content = modal.querySelector('.modal-content');
        if (mode === 'multi') {
            defaultGroup.style.display = 'none';
            defaultOther.style.display = 'none';
            container.style.display = 'block';
            content.style.width = 'min(680px, 92vw)';
            if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(container, '');
            else container.innerHTML = '';

            // 按日期分组：每天一个区块（日期标题占一行），区块内条目用 flex 自动换行，
            // 自适应浮窗宽度（窄屏单列、宽屏多列）。
            const byDate = new Map();
            schedules.forEach(s => {
                const d = s.date || '未排日期';
                if (!byDate.has(d)) byDate.set(d, []);
                byDate.get(d).push(s);
            });
            const dates = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
            const weekDays = ['日', '一', '二', '三', '四', '五', '六'];

            dates.forEach(date => {
                const group = document.createElement('div');
                group.className = 'fm-day-group';
                const header = document.createElement('div');
                header.className = 'fm-day-header';
                let label = date;
                if (date !== '未排日期') {
                    const dt = new Date(date + 'T00:00:00');
                    label = `${date}（周${weekDays[dt.getDay()]}）`;
                }
                header.textContent = label;
                group.appendChild(header);

                const items = document.createElement('div');
                items.className = 'fm-day-items';
                byDate.get(date).forEach(s => {
                    const item = document.createElement('div');
                    item.className = 'fm-day-item';
                    const typeText = s.schedule_type_cn || s.schedule_type || '课程';
                    const timeText = s.start_time ? ' ' + s.start_time.substring(0, 5) : '';
                    const itemHtml = `
                        <div class="fm-day-item-title">${esc(s.student_name || '学生')} · ${esc(s.teacher_name || '老师')} · ${esc(typeText)}${esc(timeText)}</div>
                        <div class="fm-day-item-inputs">
                            <div class="form-group" style="flex:1; min-width:0; margin-bottom:0;">
                                <label style="font-size: var(--fs-300);">交通费</label>
                                <input type="number" class="fm-dyn-trans" data-id="${esc(s.id)}" step="0.5" min="0" value="${isUnfilled(s.transport_fee) ? '' : esc(String(s.transport_fee))}" placeholder="0.00">
                            </div>
                            <div class="form-group" style="flex:1; min-width:0; margin-bottom:0;">
                                <label style="font-size: var(--fs-300);">其他</label>
                                <input type="number" class="fm-dyn-other" data-id="${esc(s.id)}" step="0.5" min="0" value="${isUnfilled(s.other_fee) ? '' : esc(String(s.other_fee))}" placeholder="0.00">
                            </div>
                        </div>
                    `;
                    if (window.SecurityUtils) {
                        window.SecurityUtils.safeSetHTML(item, itemHtml);
                    } else {
                        item.innerHTML = itemHtml;
                    }
                    items.appendChild(item);
                });
                group.appendChild(items);
                container.appendChild(group);
            });

            const updMulti = () => {
                let sum = 0;
                container.querySelectorAll('.fm-dyn-trans').forEach(i => sum += parseFloat(i.value) || 0);
                container.querySelectorAll('.fm-dyn-other').forEach(i => sum += parseFloat(i.value) || 0);
                modal.querySelector('#fmTotalDisplay').textContent = money(sum);
            };
            container.querySelectorAll('input').forEach(i => i.addEventListener('input', updMulti));
            updMulti();
        } else {
            defaultGroup.style.display = '';
            defaultOther.style.display = '';
            container.style.display = 'none';
            content.style.width = '480px';
            if (window.SecurityUtils) window.SecurityUtils.safeSetHTML(container, '');
            const rec = schedules[0] || {};
            // 未填写(null)→输入框留空；0 或正数→原值。留空保存即写回 NULL（未填写），与「清除费用」置 null 一致。
            tInput.value = isUnfilled(rec.transport_fee) ? '' : String(rec.transport_fee);
            oInput.value = isUnfilled(rec.other_fee) ? '' : String(rec.other_fee);
            modal.querySelector('#fmTotalDisplay').textContent = money(
                (isUnfilled(rec.transport_fee) ? 0 : parseFloat(rec.transport_fee)) +
                (isUnfilled(rec.other_fee) ? 0 : parseFloat(rec.other_fee))
            );
        }

        // 与排课管理弹窗一致的显示方式：.modal 全屏遮罩（rgba(0,0,0,.5)+backdrop blur），
        // .modal-content 播放 modalSlideIn 过渡动画
        modal.style.display = 'block';
    }

    function closeModal() {
        const modal = document.getElementById('fmFeeModal');
        if (modal) modal.style.display = 'none';
        activeModal = null;
    }

    // 输入框 → 费用值：留空/未传 → null（未填写）；0 或正数 → 数值。与「清除费用」显式置 null 一致。
    function parseInputFee(val) {
        if (val === '' || val === null || val === undefined) return null;
        const n = parseFloat(val);
        return Number.isNaN(n) ? null : n;
    }

    function collectUpdates() {
        const modal = document.getElementById('fmFeeModal');
        const mode = activeModal ? activeModal.mode : 'single';
        if (mode === 'multi') {
            const container = modal.querySelector('#fmDynamicFeeInputsContainer');
            // teacher_uid 随 pair 不同而不同，需从 schedule 记录里查找
            const scheduleMap = new Map((activeModal.schedules || []).map(s => [String(s.id), s]));
            const updates = [];
            container.querySelectorAll('.fm-dyn-trans').forEach(tInp => {
                const id = tInp.dataset.id;
                const oInp = container.querySelector(`.fm-dyn-other[data-id="${id}"]`);
                const rec = scheduleMap.get(String(id));
                updates.push({
                    id,
                    teacher_uid: rec ? rec.teacher_uid : null,
                    transport_fee: parseInputFee(tInp.value),
                    other_fee: parseInputFee(oInp ? oInp.value : null),
                });
            });
            return updates;
        }
        const rec = activeModal.schedules[0] || {};
        return [{
            id: rec.id,
            teacher_uid: rec.teacher_uid,
            transport_fee: parseInputFee(modal.querySelector('#fmTransportInput').value),
            other_fee: parseInputFee(modal.querySelector('#fmOtherInput').value),
        }];
    }

    async function persist(config, updates) {
        if (config.saveMode === 'batch' && config.batchEndpoint) {
            return window.apiUtils.post(config.batchEndpoint, { updates });
        }
        // 单条模式：逐条 PATCH（批量选择时也逐条提交，保证各端点兼容）
        // teacher_uid 用于后端定位教师 pair（费用挂在 pair 上）
        await Promise.all(updates.map(u =>
            window.apiUtils.patch(config.feeEndpoint(u.id), {
                transport_fee: u.transport_fee,
                other_fee: u.other_fee,
                teacher_uid: u.teacher_uid,
            })
        ));
    }

    async function onModalSubmit(e) {
        e.preventDefault();
        if (!activeModal) return;
        const { config } = activeModal;
        const updates = collectUpdates();
        if (!updates.length) return;

        const saveBtn = document.getElementById('fmSaveBtn');
        saveBtn.disabled = true;
        saveBtn.textContent = '保存中...';
        try {
            await persist(config, updates);
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('费用保存成功', 'success');
            else if (window.showToast) window.showToast('费用保存成功', 'success');
            closeModal();
            const mountEl = document.querySelector(config.mountSelector);
            if (mountEl) loadData(config, mountEl);
        } catch (err) {
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('保存失败：' + (err.message || '未知错误'), 'error');
            else if (window.showToast) window.showToast('保存失败：' + (err.message || '未知错误'), 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存并提交';
        }
    }

    async function onClear() {
        if (!activeModal) return;
        const { config, mode, schedules } = activeModal;
        const ok = await fmConfirm({
            title: '确认清除费用',
            message: `将清除当前 ${schedules.length} 条课时的交通 / 其他费用（置空/未填写），此操作不可撤销。`,
            confirmText: '确认清除',
            danger: true,
        });
        if (!ok) return;
        const updates = (mode === 'multi' ? schedules : [schedules[0]]).map(s => ({
            id: s.id, teacher_uid: s.teacher_uid, transport_fee: null, other_fee: null,
        }));
        const saveBtn = document.getElementById('fmSaveBtn');
        saveBtn.disabled = true;
        saveBtn.textContent = '清除中...';
        try {
            await persist(config, updates);
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('费用已清除', 'success');
            closeModal();
            const mountEl = document.querySelector(config.mountSelector);
            if (mountEl) loadData(config, mountEl);
        } catch (err) {
            if (window.apiUtils && window.apiUtils.showToast) window.apiUtils.showToast('清除失败：' + (err.message || '未知错误'), 'error');
        } finally {
            saveBtn.disabled = false;
            saveBtn.textContent = '保存并提交';
        }
    }

    // ---- 导出报销单 ---------------------------------------------------
    function ensureExportContext(config) {
        if (!config.exportContextKey || !config.fetchWeekSchedules) return;
        if (typeof window.registerWeeklyViewExportContext !== 'function') return;
        const sel = config.mountSelector;
        window.registerWeeklyViewExportContext(config.exportContextKey, {
            getWeekStart() {
                const d = (stateMap[sel] && stateMap[sel].startDate) || todayISO();
                return startOfWeek(d);
            },
            async fetchSchedules(start, end) {
                try {
                    return normalizeList(await config.fetchWeekSchedules(start, end));
                } catch (_) {
                    return [];
                }
            },
        });
    }

    function doExport(config) {
        const key = config.exportContextKey || config.exportRole;
        if (!key) return;
        if (typeof window.exportWeeklyScheduleView !== 'function') {
            if (window.apiUtils) window.apiUtils.showToast('导出组件未加载', 'error');
            return;
        }
        window.exportWeeklyScheduleView(key).catch(err => {
            if (window.apiUtils) window.apiUtils.showToast('导出失败: ' + err.message, 'error');
        });
    }

    FeeManager.mount = mount;
    FeeManager.refresh = function (config) {
        const mountEl = document.querySelector(config.mountSelector);
        if (mountEl && mountEl.dataset.fmBuilt === '1') loadData(config, mountEl);
    };
    window.FeeManager = FeeManager;
})();
