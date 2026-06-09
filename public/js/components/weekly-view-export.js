/* ==========================================================================
 * 导出当前视图（图片 → 剪贴板） —— 教师/管理员共用接口
 *
 * 严格遵循 export-manager.js 第 1 工作表的样式与数据处理逻辑：
 *   - 复用 window.ExportManager.transformExportData 生成的行数据
 *   - 字体、边框、表头、条件着色、合并单元格规则 1:1 对齐 Excel 输出
 *   - 截图采用 html2canvas + ClipboardItem Promise 模式（Safari 兼容）
 *
 * 调用方需先通过 registerWeeklyViewExportContext(role, context) 注册：
 *   {
 *     getWeekStart(): Date,                                 // 当前视图所在周的周一
 *     fetchSchedules(startISO, endISO): Promise<row[]>      // 返回完整周排课
 *   }
 * ========================================================================== */
(function () {
    'use strict';

    // ---- 角色上下文注册 -------------------------------------------------
    const contexts = (window.__weeklyViewExportContexts = window.__weeklyViewExportContexts || {});
    function registerWeeklyViewExportContext(role, ctx) {
        if (!role || !ctx) return;
        contexts[role] = ctx;
    }

    // ---- 日期辅助（与 student/utils.js 行为一致） -----------------------
    function toISODate(dateLike) {
        if (!dateLike) return '';
        const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
        if (Number.isNaN(date.getTime())) return '';
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(date);
    }
    function startOfWeek(dateLike) {
        const date = dateLike instanceof Date ? new Date(dateLike) : new Date(dateLike);
        if (Number.isNaN(date.getTime())) return null;
        const day = date.getDay() || 7;
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - (day - 1));
        return date;
    }
    function getWeekDates(baseDateLike) {
        const start = startOfWeek(baseDateLike) || new Date();
        return Array.from({ length: 7 }, (_, idx) => {
            const date = new Date(start);
            date.setDate(start.getDate() + idx);
            return date;
        });
    }
    function normalizeDateKey(dateLike) {
        return toISODate(dateLike) || null;
    }

    // ---- 水印文本（与教师端 getScheduleWatermarkText 一致） -------------
    function getAdjustmentType(rec) {
        const raw = rec && (rec.adjustment_type != null ? rec.adjustment_type : rec.is_temp);
        const num = Number(raw);
        return Number.isFinite(num) ? num : 0;
    }
    function getScheduleWatermarkText(group) {
        const hasTemp = group.some(rec => getAdjustmentType(rec) === 1);
        const hasAdjusted = group.some(rec => getAdjustmentType(rec) === 2);
        const hasOriginal = group.some(rec => (rec.status || '').toLowerCase() === 'modified_away' && getAdjustmentType(rec) === 0);
        const parts = [];
        if (hasAdjusted) parts.push('调');
        if (hasTemp) parts.push('加');
        if (parts.length > 0) return parts.join('/');
        if (hasOriginal && group.every(rec => (rec.status || '').toLowerCase() === 'modified_away' && getAdjustmentType(rec) === 0)) return '原';
        return '';
    }

    // ---- 表格视觉常量（与教师端 WEEKLY_VIEW_STYLE 1:1 对齐） ------------
    const WEEKLY_VIEW_STYLE = {
        columnPx: {
            '日期': 96, '星期': 60,
            '计划安排': 480, '实际安排': 480,
            '费用': 120, '周汇总': 110
        },
        cellPaddingY: 1, cellPaddingX: 8,
        lineHeight: 1.1, minRowHeight: 22,
        fontCJK: 'SimSun, "宋体", STSong, serif',
        fontASCII: '"Times New Roman", serif',
        fontPt: 11, headerFontPt: 11,
        border: '#D4D4D4',
        headerBg: '#F2F2F2',
        dateColBg: '#E2EFDA',
        sundayBg: '#DDEBF7',
        cancelledText: '#595959',
        modifiedAwayText: '#8C6239',
        reviewText: '#FF0000',
        defaultText: '#000000'
    };

    // ---- 依赖等待 -------------------------------------------------------
    async function waitForDependencies(maxWaitMs) {
        maxWaitMs = maxWaitMs || 10000;
        const start = Date.now();
        while (Date.now() - start < maxWaitMs) {
            if (window.html2canvas && window.ExportManager && typeof window.ExportManager.transformExportData === 'function') {
                return true;
            }
            await new Promise(r => setTimeout(r, 200));
        }
        return false;
    }

    // ---- 主入口 ---------------------------------------------------------
    async function exportWeeklyScheduleView(role) {
        role = role || 'teacher';
        const ctx = contexts[role];
        if (!ctx || typeof ctx.fetchSchedules !== 'function') {
            if (window.apiUtils) window.apiUtils.showToast('当前页面尚未注册导出上下文', 'error');
            return;
        }

        const depsReady = await waitForDependencies();
        if (!depsReady) {
            if (!window.html2canvas) {
                if (window.apiUtils) window.apiUtils.showToast('截图组件 html2canvas 加载失败，请刷新页面重试', 'error');
            } else if (!window.ExportManager) {
                if (window.apiUtils) window.apiUtils.showToast('导出组件 ExportManager 加载失败，请刷新页面重试', 'error');
            } else {
                if (window.apiUtils) window.apiUtils.showToast('导出组件加载中，请稍后再试', 'warning');
            }
            return;
        }

        const weekStart = (ctx.getWeekStart && ctx.getWeekStart()) || startOfWeek(new Date());
        const weekDates = getWeekDates(weekStart);
        const startISO = toISODate(weekDates[0]);
        const endISO = toISODate(weekDates[weekDates.length - 1]);

        // 1. 拉取完整周数据（show_plan=true 口径），与 Excel 第 1 工作表一致
        const prepToastId = window.apiUtils ? window.apiUtils.showToast('正在准备导出数据...', 'info', 0) : null;
        let fullSchedules;
        try {
            fullSchedules = await ctx.fetchSchedules(startISO, endISO);
        } catch (err) {
            if (prepToastId && window.apiUtils) window.apiUtils.hideToast(prepToastId);
            if (window.apiUtils) window.apiUtils.showToast('获取导出数据失败: ' + err.message, 'error');
            return;
        }
        if (prepToastId && window.apiUtils) window.apiUtils.hideToast(prepToastId);

        // 2. 仅保留本周实际有课程的学生
        const studentsWithSchedules = collectStudentsWithSchedules(fullSchedules);
        if (studentsWithSchedules.length === 0) {
            if (window.apiUtils) window.apiUtils.showToast('本周没有可导出的学生数据', 'warning');
            return;
        }

        // 3. 选学生
        let target;
        if (studentsWithSchedules.length === 1) {
            target = studentsWithSchedules[0];
        } else {
            try {
                target = await pickStudentForWeeklyView(studentsWithSchedules);
            } catch (_cancelled) {
                return;
            }
        }
        if (!target) return;

        // 4. 生成并复制
        await generateAndCopyWeeklyView(target, fullSchedules, weekDates, role);
    }

    function collectStudentsWithSchedules(schedules) {
        const seen = new Map();
        (schedules || []).forEach(s => {
            const id = s.student_id;
            if (id == null) return;
            if (!seen.has(id)) seen.set(id, { id: id, name: s.student_name || '未知学生' });
        });
        return Array.from(seen.values()).sort((a, b) => (a.id || 0) - (b.id || 0));
    }

    // ---- 学生选择弹窗（与教师端样式一致） ------------------------------
    function pickStudentForWeeklyView(students) {
        return new Promise((resolve, reject) => {
            const GREEN = '#2ECC71';
            const overlay = document.createElement('div');
            overlay.style.cssText = [
                'position: fixed', 'top: 0', 'left: 0', 'width: 100%', 'height: 100%',
                'background: rgba(15,23,42,0.45)', 'backdrop-filter: blur(4px)',
                'z-index: 100002', 'display: flex',
                'align-items: center', 'justify-content: center',
                'animation: wvFadeIn 0.18s ease'
            ].join(';');

            if (!document.getElementById('wvDialogAnim')) {
                const st = document.createElement('style');
                st.id = 'wvDialogAnim';
                st.textContent = '@keyframes wvFadeIn{from{opacity:0}to{opacity:1}}@keyframes wvScaleIn{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}';
                document.head.appendChild(st);
            }

            const box = document.createElement('div');
            box.style.cssText = [
                'background: #ffffff', 'width: 380px', 'max-height: 78vh',
                'border-radius: 16px', 'box-shadow: 0 20px 48px -12px rgba(0,0,0,0.28)',
                'display: flex', 'flex-direction: column', 'overflow: hidden',
                'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
                'animation: wvScaleIn 0.22s cubic-bezier(0.16,1,0.3,1)'
            ].join(';');

            const header = document.createElement('div');
            header.style.cssText = 'padding: 18px 22px; border-bottom: 1px solid #eef2f6; font-weight: 600; font-size: 16px; color: #1e293b; display: flex; justify-content: space-between; align-items: center;';
            const title = document.createElement('span');
            title.textContent = '选择要导出的学生';
            header.appendChild(title);
            const closeBtn = document.createElement('span');
            closeBtn.className = 'material-icons-round';
            closeBtn.style.cssText = 'cursor: pointer; color: #94a3b8; font-size: 22px; line-height: 1; transition: color 0.15s;';
            closeBtn.textContent = 'close';
            closeBtn.onmouseover = () => closeBtn.style.color = '#475569';
            closeBtn.onmouseout = () => closeBtn.style.color = '#94a3b8';
            header.appendChild(closeBtn);
            box.appendChild(header);

            const list = document.createElement('div');
            list.style.cssText = 'flex: 1; overflow-y: auto; padding: 12px;';
            let selectedId = students[0].id;
            const rowEls = [];

            const paint = () => {
                rowEls.forEach(({ el, indicator, id }) => {
                    const active = String(id) === String(selectedId);
                    el.style.background = active ? 'rgba(46,204,113,0.10)' : '#ffffff';
                    el.style.borderColor = active ? GREEN : '#e7ecf1';
                    indicator.style.borderColor = active ? GREEN : '#cbd5e1';
                    indicator.style.background = active ? GREEN : '#ffffff';
                    indicator.firstChild.style.opacity = active ? '1' : '0';
                });
            };

            students.forEach(stu => {
                const row = document.createElement('div');
                row.style.cssText = [
                    'display: flex', 'align-items: center', 'gap: 12px',
                    'padding: 12px 14px', 'margin-bottom: 8px', 'cursor: pointer',
                    'border: 1.5px solid #e7ecf1', 'border-radius: 10px',
                    'transition: background 0.15s, border-color 0.15s'
                ].join(';');

                const indicator = document.createElement('span');
                indicator.style.cssText = 'flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #cbd5e1; background: #fff; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s;';
                const dot = document.createElement('span');
                dot.style.cssText = 'width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: 0; transition: opacity 0.15s;';
                indicator.appendChild(dot);

                const nameSpan = document.createElement('span');
                nameSpan.textContent = stu.name;
                nameSpan.style.cssText = 'color: #1e293b; font-size: 14.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

                row.appendChild(indicator);
                row.appendChild(nameSpan);
                row.addEventListener('click', () => { selectedId = stu.id; paint(); });
                list.appendChild(row);
                rowEls.push({ el: row, indicator, id: stu.id });
            });
            box.appendChild(list);
            paint();

            const footer = document.createElement('div');
            footer.style.cssText = 'padding: 14px 22px; border-top: 1px solid #eef2f6; display: flex; justify-content: flex-end; gap: 12px;';
            const cancel = document.createElement('button');
            cancel.textContent = '取消';
            cancel.style.cssText = 'padding: 8px 20px; border-radius: 10px; border: 1px solid #e2e8f0; background: white; color: #475569; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.15s;';
            cancel.onmouseover = () => cancel.style.background = '#f1f5f9';
            cancel.onmouseout = () => cancel.style.background = 'white';
            const confirm = document.createElement('button');
            confirm.textContent = '确认';
            confirm.style.cssText = 'padding: 8px 22px; border-radius: 10px; border: none; background: ' + GREEN + '; color: white; cursor: pointer; font-size: 14px; font-weight: 600; box-shadow: 0 2px 4px rgba(46,204,113,0.3); transition: background 0.15s;';
            confirm.onmouseover = () => confirm.style.background = '#27AE60';
            confirm.onmouseout = () => confirm.style.background = GREEN;
            footer.appendChild(cancel);
            footer.appendChild(confirm);
            box.appendChild(footer);

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            const cleanup = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
            const onCancel = () => { cleanup(); reject(new Error('cancelled')); };
            const onConfirm = () => {
                const target = students.find(s => String(s.id) === String(selectedId)) || students[0];
                cleanup();
                resolve(target);
            };

            closeBtn.addEventListener('click', onCancel);
            cancel.addEventListener('click', onCancel);
            confirm.addEventListener('click', onConfirm);
            overlay.addEventListener('click', e => { if (e.target === overlay) onCancel(); });
        });
    }

    // ---- 主流程：转换 → 渲染 → 截图 → 剪贴板 --------------------------
    async function generateAndCopyWeeklyView(targetStudent, sourceSchedules, weekDates, role) {
        const toastId = window.apiUtils ? window.apiUtils.showToast('正在生成本周视图...', 'info', 0) : null;

        const startDateObj = weekDates[0];
        const endDateObj = weekDates[weekDates.length - 1];

        // 1. 过滤出本周 + 该学生的排课
        const baseSchedules = Array.isArray(sourceSchedules) ? sourceSchedules : [];
        const adaptedRows = baseSchedules
            .filter(s => String(s.student_id) === String(targetStudent.id))
            .map(s => ({
                id: s.id,
                date: s.date,
                start_time: s.start_time,
                end_time: s.end_time,
                status: s.status,
                student_id: s.student_id,
                student_name: s.student_name || targetStudent.name,
                teacher_id: s.teacher_id,
                teacher_name: s.teacher_name,
                transport_fee: s.transport_fee,
                other_fee: s.other_fee,
                // 类型字段统一映射，确保 transformToCalendarData 能产出"入户(19:00-22:30)：老师"前缀并对评审/咨询标红
                type: s.schedule_type_cn || s.schedule_type_name || s.type_name || s.schedule_types || s.schedule_type || '',
                schedule_type: s.schedule_type,
                schedule_type_cn: s.schedule_type_cn,
                course_id: s.course_id,
                is_temp: (s.adjustment_type != null ? s.adjustment_type : s.is_temp),
                adjustment_type: s.adjustment_type,
                location: s.location
            }));

        // 2. 复用 ExportManager.transformExportData：
        //    - teacher 角色：对齐"班主任导出数据"按钮（type=teacher_schedule + head_teacher_students）
        //    - admin 角色：admin 上下文同样产出"每日排课明细" Sheet
        const userType = (role === 'admin') ? 'admin' : 'teacher';
        const state = {
            startDate: startDateObj,
            endDate: endDateObj,
            selectedType: 'teacher_schedule',
            exportContext: (userType === 'teacher') ? 'head_teacher_students' : null
        };
        const exportTypes = { TEACHER_SCHEDULE: 'teacher_schedule', STUDENT_SCHEDULE: 'student_schedule' };
        let rows;
        try {
            rows = window.ExportManager.transformExportData(
                adaptedRows,
                String(targetStudent.id),
                targetStudent.name,
                userType,
                state,
                exportTypes
            );
        } catch (err) {
            if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
            if (window.apiUtils) window.apiUtils.showToast('数据转换失败: ' + err.message, 'error');
            return;
        }

        if (!Array.isArray(rows)) {
            rows = rows['每日排课明细'] || rows[Object.keys(rows)[0]] || [];
        }

        // 3. 渲染 DOM 表格
        const wrapper = buildWeeklyViewWrapper(rows, weekDates, targetStudent, adaptedRows);
        document.body.appendChild(wrapper);

        // 4. html2canvas + 剪贴板（Safari 兼容 Promise 模式）
        try {
            const makeImagePromise = new Promise(async (resolve, reject) => {
                try {
                    const canvas = await html2canvas(wrapper, {
                        scale: 2,
                        backgroundColor: '#ffffff',
                        logging: false,
                        useCORS: true,
                        width: wrapper.offsetWidth,
                        height: wrapper.offsetHeight
                    });
                    canvas.toBlob(blob => {
                        if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
                        if (!blob) { reject(new Error('生成图片为空')); return; }
                        resolve(blob);
                    }, 'image/png');
                } catch (err) {
                    reject(err);
                } finally {
                    if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
                }
            });

            const item = new ClipboardItem({ 'image/png': makeImagePromise });
            await navigator.clipboard.write([item]);

            if (window.apiUtils) window.apiUtils.showSuccessToast('已导出本周安排视图到粘贴板');
        } catch (err) {
            if (toastId && window.apiUtils) window.apiUtils.hideToast(toastId);
            if (window.apiUtils) window.apiUtils.showToast('导出失败: ' + err.message, 'error');
            if (document.body.contains(wrapper)) document.body.removeChild(wrapper);
        }
    }

    // ---- 离屏表格构造（与教师端 buildWeeklyViewWrapper 1:1） -----------
    function buildWeeklyViewWrapper(rows, weekDates, targetStudent, adaptedRows) {
        const HEADERS = ['日期', '星期', '计划安排', '实际安排', '费用', '周汇总'];
        const totalWidth = HEADERS.reduce((sum, h) => sum + (WEEKLY_VIEW_STYLE.columnPx[h] || 0), 0);

        const watermarkByDate = {};
        if (Array.isArray(adaptedRows)) {
            const byDate = {};
            adaptedRows.forEach(r => {
                const dk = normalizeDateKey(r.date);
                if (!byDate[dk]) byDate[dk] = [];
                byDate[dk].push(r);
            });
            Object.keys(byDate).forEach(dk => {
                const text = getScheduleWatermarkText(byDate[dk]);
                if (text) watermarkByDate[dk] = text;
            });
        }

        const wrapper = document.createElement('div');
        wrapper.style.cssText = [
            'position: absolute', 'top: -99999px', 'left: 0',
            'z-index: -1', 'background: #ffffff', 'padding: 16px',
            'width: ' + (totalWidth + 32) + 'px',
            'font-family: ' + WEEKLY_VIEW_STYLE.fontCJK
        ].join(';');

        const table = document.createElement('table');
        table.style.cssText = [
            'border-collapse: collapse', 'background: #ffffff',
            'font-family: ' + WEEKLY_VIEW_STYLE.fontCJK,
            'color: #000000', 'table-layout: fixed',
            'width: ' + totalWidth + 'px'
        ].join(';');

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        HEADERS.forEach(h => {
            const th = document.createElement('th');
            th.textContent = h;
            th.style.cssText = buildCellStyle({ isHeader: true, widthPx: WEEKLY_VIEW_STYLE.columnPx[h] });
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');

        let renderRows = rows;
        if (!renderRows || renderRows.length === 0) {
            const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
            renderRows = weekDates.map(d => ({
                '日期': toISODate(d),
                '星期': days[d.getDay()],
                '计划安排': '', '实际安排': '', '费用': '', '周汇总': '',
                _isSunday: d.getDay() === 0,
                _weekNumber: getISOWeekStub(d)
            }));
        }

        const rowspans = computeRowspans(renderRows);

        renderRows.forEach((r, i) => {
            const tr = document.createElement('tr');
            HEADERS.forEach(h => {
                if (['日期', '星期', '费用'].includes(h) && !rowspans.dateFirst[i]) return;
                if (h === '周汇总' && !rowspans.weekFirst[i]) return;

                const td = document.createElement('td');
                const value = r[h] != null ? String(r[h]) : '';

                if (['日期', '星期', '费用'].includes(h) && rowspans.dateSpan[i] > 1) {
                    td.rowSpan = rowspans.dateSpan[i];
                }
                if (h === '周汇总' && rowspans.weekSpan[i] > 1) {
                    td.rowSpan = rowspans.weekSpan[i];
                }

                if ((h === '计划安排' || h === '实际安排')) {
                    const parts = h === '计划安排' ? r._planTextParts : r._actualTextParts;
                    if (Array.isArray(parts) && parts.length > 0) {
                        renderTextParts(td, parts);
                    } else {
                        renderMultiline(td, value);
                    }
                } else {
                    renderMultiline(td, value);
                }

                td.style.cssText = buildCellStyle({
                    isHeader: false,
                    widthPx: WEEKLY_VIEW_STYLE.columnPx[h],
                    column: h,
                    value: value,
                    row: r
                });

                if (h === '日期' && rowspans.dateFirst[i]) {
                    const wmText = watermarkByDate[normalizeDateKey(r['日期'])];
                    if (wmText) {
                        td.style.cssText += ';position:relative;overflow:hidden;';
                        const wm = document.createElement('span');
                        wm.setAttribute('aria-hidden', 'true');
                        const wmSize = wmText.length > 1 ? '28px' : '36px';
                        wm.style.cssText = [
                            'position: absolute', 'bottom: -4px', 'right: 2px',
                            'font-size: ' + wmSize,
                            'font-family: "Ma Shan Zheng","Kaiti SC","STXingkai","KaiTi",cursive,serif',
                            'color: rgba(0,102,204,0.18)', 'pointer-events: none',
                            'z-index: 0', 'transform: rotate(-15deg)', 'line-height: 1',
                            'user-select: none', 'font-weight: bold'
                        ].join(';');
                        wm.textContent = wmText;
                        td.appendChild(wm);
                    }
                }

                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        table.appendChild(tbody);
        wrapper.appendChild(table);
        return wrapper;
    }

    function renderMultiline(td, value) {
        if (value == null || value === '') return;
        const lines = String(value).split(/\n|<br\s*\/?>/i);
        lines.forEach((line, idx) => {
            if (idx > 0) td.appendChild(document.createElement('br'));
            td.appendChild(document.createTextNode(line));
        });
    }

    function renderTextParts(td, parts) {
        const S = WEEKLY_VIEW_STYLE;
        td.style.color = S.defaultText;
        td.style.fontStyle = 'normal';
        parts.forEach((p, idx) => {
            if (idx > 0) {
                const sep = document.createElement('span');
                sep.textContent = '；';
                td.appendChild(sep);
            }
            const span = document.createElement('span');
            let color = S.defaultText;
            let italic = false;
            if (p.isCancelled) { color = S.cancelledText; italic = true; }
            else if (p.isModifiedAway) { color = S.modifiedAwayText; italic = true; }
            else if (p.isPlanDimmed) { italic = true; color = p.isRed ? '#FF8080' : S.cancelledText; }
            else if (p.isRed) { color = S.reviewText; }
            span.style.color = color;
            if (italic) span.style.fontStyle = 'italic';
            span.textContent = p.text;
            td.appendChild(span);
        });
    }

    function computeRowspans(rows) {
        const n = rows.length;
        const dateFirst = new Array(n).fill(false);
        const dateSpan = new Array(n).fill(1);
        const weekFirst = new Array(n).fill(false);
        const weekSpan = new Array(n).fill(1);

        let i = 0;
        while (i < n) {
            let j = i;
            while (j < n && rows[j]['日期'] === rows[i]['日期']) j++;
            dateFirst[i] = true;
            dateSpan[i] = j - i;
            i = j;
        }
        i = 0;
        while (i < n) {
            let j = i;
            const wk = rows[i]._weekNumber;
            while (j < n && rows[j]._weekNumber === wk) j++;
            weekFirst[i] = true;
            weekSpan[i] = j - i;
            i = j;
        }
        return { dateFirst, dateSpan, weekFirst, weekSpan };
    }

    function buildCellStyle(opts) {
        const isHeader = opts.isHeader;
        const widthPx = opts.widthPx;
        const column = opts.column;
        const value = opts.value;
        const row = opts.row;
        const S = WEEKLY_VIEW_STYLE;
        const parts = [
            'border: 1px solid ' + S.border,
            'padding: ' + S.cellPaddingY + 'px ' + S.cellPaddingX + 'px',
            'line-height: ' + S.lineHeight,
            'height: ' + S.minRowHeight + 'px',
            'vertical-align: middle',
            'color: ' + S.defaultText,
            'width: ' + widthPx + 'px',
            'min-width: ' + widthPx + 'px',
            'max-width: ' + widthPx + 'px',
            'word-break: break-word',
            'white-space: normal'
        ];

        const strValue = String(value || '');

        if (isHeader) {
            parts.push('background: ' + S.headerBg);
            parts.push('font-family: ' + S.fontCJK);
            parts.push('font-size: ' + S.headerFontPt + 'pt');
            parts.push('font-weight: bold');
            parts.push('text-align: center');
            return parts.join(';');
        }

        const isFinanceCol = column === '费用' || column === '周汇总';
        let fontFamily;
        if (isFinanceCol) {
            const hasChinese = /[一-龥]/.test(strValue);
            const hasDigit = /\d/.test(strValue);
            if (hasChinese && hasDigit) {
                fontFamily = S.fontCJK;
            } else {
                const isEnglishOrNum = /^[a-zA-Z0-9\s]*$/.test(strValue);
                fontFamily = (isEnglishOrNum && strValue.length > 0) ? S.fontASCII : S.fontCJK;
            }
        } else {
            const isEnglishOrNum = /^[a-zA-Z0-9\s]*$/.test(strValue);
            fontFamily = (isEnglishOrNum && strValue.length > 0) ? S.fontASCII : S.fontCJK;
        }
        parts.push('font-family: ' + fontFamily);
        parts.push('font-size: ' + S.fontPt + 'pt');
        parts.push('font-weight: normal');
        parts.push('vertical-align: middle');

        const isSunday = !!(row && row._isSunday);
        const isCancelledRow = !!(row && (
            (row['实际安排'] && String(row['实际安排']).includes('已取消')) ||
            (row['计划安排'] && String(row['计划安排']).includes('已取消'))
        ));
        const isModifiedDate = !!(row && row._isModifiedDate);

        if (column === '日期') {
            parts.push('background: ' + S.dateColBg);
        } else if (isSunday) {
            parts.push('background: ' + S.sundayBg);
        }

        let italic = false;
        if (isCancelledRow && !isFinanceCol) italic = true;
        if (isModifiedDate && (column === '日期' || column === '星期')) italic = true;

        if (column === '计划安排' || column === '实际安排') {
            const isPlan = column === '计划安排';
            const isRed = row && (isPlan ? row._planIsRed : row._actualIsRed);
            const isCancelGrey = row && (isPlan ? row._planIsCancelledGrey : row._actualIsCancelledGrey);
            const isModifiedGrey = row && (isPlan ? row._planIsModifiedAwayGrey : row._actualIsModifiedAwayGrey);

            if (isRed) {
                parts.push('color: ' + S.reviewText);
            } else if (isCancelGrey) {
                parts.push('color: ' + S.cancelledText);
                italic = true;
            } else if (isModifiedGrey) {
                parts.push('color: ' + S.modifiedAwayText);
                italic = true;
            }
        }

        if (italic) parts.push('font-style: italic');

        if (column === '日期' || column === '星期') {
            parts.push('text-align: center');
        } else if (isFinanceCol) {
            parts.push('text-align: right');
            parts.push('vertical-align: bottom');
            parts.push('font-style: normal');
            if (strValue && !strValue.includes('\n') && strValue !== '/') {
                parts.push('padding-right: 16px');
            }
        } else if (strValue === '/') {
            parts.push('text-align: left');
        } else if (strValue.length > 10) {
            parts.push('text-align: left');
        } else {
            parts.push('text-align: center');
        }

        return parts.join(';');
    }

    function getISOWeekStub(date) {
        const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
        const dayNum = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() + 4 - dayNum);
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    }

    // ---- 暴露统一接口 ---------------------------------------------------
    window.exportWeeklyScheduleView = exportWeeklyScheduleView;
    window.registerWeeklyViewExportContext = registerWeeklyViewExportContext;
})();
