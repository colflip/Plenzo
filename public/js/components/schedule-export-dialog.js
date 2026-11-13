/**
 * 周视图图片导出：视图（+ 学生）选择弹窗
 *
 * 「导出本周视图」按钮点击后弹这个窗口，一次选完再截图：
 *   - 视图：移动端视图（默认，双列「日期 | 课程信息」表格）/ 桌面端视图（原网格）
 *   - 学生名单：当该视图需要按学生导出时出现（多人时不再分第二个窗口）
 *
 * 视觉与 weekly-view-export.js 的「选择要导出的学生」窗口一致：
 * 绿色 #2ECC71 主色、白色圆角卡片、自定义遮罩/头/尾、圆形单选指示器。
 *
 * onChoose(view, student)：
 *   - 第一个参数仍是视图字符串，只选视图的老调用点无需改动；
 *   - 第二个参数是选中的学生对象（原样回传，可能带 tr 等附加字段），不需要选学生时为 null。
 */

window.ScheduleExportDialog = (function () {
    const GREEN = '#2ECC71';

    // 默认移动端：放在第一位并预选。两个选项在弹窗里同行显示。
    const OPTIONS = [
        { value: 'mobile', text: '移动端视图' },
        { value: 'desktop', text: '桌面端视图' }
    ];

    function ensureAnimStyles() {
        if (document.getElementById('wvDialogAnim')) return;
        const st = document.createElement('style');
        st.id = 'wvDialogAnim';
        st.textContent = '@keyframes wvFadeIn{from{opacity:0}to{opacity:1}}@keyframes wvScaleIn{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}';
        document.head.appendChild(st);
    }

    /** 圆形单选指示器（与「选择要导出的学生」窗口一致） */
    function makeIndicator() {
        const indicator = document.createElement('span');
        indicator.style.cssText = 'flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #cbd5e1; background: #fff; display: inline-flex; align-items: center; justify-content: center; transition: all 0.15s;';
        const dot = document.createElement('span');
        dot.style.cssText = 'width: 7px; height: 7px; border-radius: 50%; background: #fff; opacity: 0; transition: opacity 0.15s;';
        indicator.appendChild(dot);
        return indicator;
    }

    function paintIndicator(indicator, active) {
        indicator.style.borderColor = active ? GREEN : '#cbd5e1';
        indicator.style.background = active ? GREEN : '#ffffff';
        indicator.firstChild.style.opacity = active ? '1' : '0';
    }

    /**
     * @param {Object} opts
     * @param {string} [opts.label] 窗口标题后缀
     * @param {Array} [opts.students] 学生名单 [{id, name, ...}]，可带 tr 等附加字段，原样回传
     * @param {(view:string)=>boolean} [opts.needsStudent] 该视图是否需要选学生
     * @param {string} [opts.preselectId] 预选中的学生 id（双击某个学生时用）
     * @param {(view:string, student:Object|null)=>void} opts.onChoose 确认回调
     */
    function openViewChoice({ onChoose, label = '本周课表', students = null, needsStudent = null, preselectId = null } = {}) {
        ensureAnimStyles();
        const list = Array.isArray(students) ? students : [];
        const shouldPick = typeof needsStudent === 'function'
            ? needsStudent
            : () => list.length > 0;

        const overlay = document.createElement('div');
        overlay.style.cssText = [
            'position: fixed', 'top: 0', 'left: 0', 'width: 100%', 'height: 100%',
            'background: rgba(15,23,42,0.45)',
            'backdrop-filter: blur(var(--overlay-blur, 4px))',
            '-webkit-backdrop-filter: blur(var(--overlay-blur, 4px))',
            'z-index: 100002', 'display: flex',
            'align-items: center', 'justify-content: center',
            'animation: wvFadeIn 0.18s ease'
        ].join(';');

        const box = document.createElement('div');
        box.style.cssText = [
            'background: #ffffff', 'width: 380px', 'max-height: 78vh',
            'border-radius: 16px', 'box-shadow: 0 20px 48px -12px rgba(0,0,0,0.28)',
            'display: flex', 'flex-direction: column', 'overflow: hidden',
            'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif',
            'animation: wvScaleIn 0.22s cubic-bezier(0.16,1,0.3,1)'
        ].join(';');

        // 头部（含关闭按钮）
        const header = document.createElement('div');
        header.style.cssText = 'padding: 18px 22px; border-bottom: 1px solid #eef2f6; font-weight: 600; font-size: var(--fs-500); color: #1e293b; display: flex; justify-content: space-between; align-items: center;';
        const title = document.createElement('span');
        title.textContent = `导出${label}`;
        header.appendChild(title);
        const closeBtn = document.createElement('span');
        closeBtn.className = 'material-icons-round';
        closeBtn.style.cssText = 'cursor: pointer; color: #94a3b8; font-size: 22px; line-height: 1; transition: color 0.15s;';
        closeBtn.textContent = 'close';
        closeBtn.onmouseover = () => closeBtn.style.color = '#475569';
        closeBtn.onmouseout = () => closeBtn.style.color = '#94a3b8';
        header.appendChild(closeBtn);
        box.appendChild(header);

        // 内容区（可滚动）：视图选项 + 学生名单
        const content = document.createElement('div');
        content.style.cssText = 'padding: 20px 22px 22px; overflow-y: auto;';

        const hint = document.createElement('p');
        hint.style.cssText = 'margin: 0 0 16px; font-size: var(--fs-300); color: #64748B; line-height: 1.6;';
        hint.textContent = '选择要复制成图片的版式（默认移动端，更适合手机浏览分享）';
        content.appendChild(hint);

        // ---- 视图选项（同行） ----
        const viewRow = document.createElement('div');
        viewRow.style.cssText = 'display: flex; gap: 12px;';
        viewRow.setAttribute('role', 'radiogroup');
        viewRow.setAttribute('aria-label', '导出视图版式');

        let selectedView = 'mobile';
        const viewEls = [];
        OPTIONS.forEach(opt => {
            const el = document.createElement('div');
            el.className = 'schedule-export-view-option';
            el.style.cssText = [
                'flex: 1', 'display: flex', 'align-items: center', 'gap: 10px',
                'padding: 12px 14px', 'cursor: pointer',
                'border: 1.5px solid #e7ecf1', 'border-radius: 10px',
                'transition: background 0.15s, border-color 0.15s'
            ].join(';');
            const indicator = makeIndicator();
            const text = document.createElement('span');
            text.textContent = opt.text;
            text.style.cssText = 'color: #1e293b; font-size: var(--fs-300); font-weight: 500; white-space: nowrap;';
            el.appendChild(indicator);
            el.appendChild(text);
            el.addEventListener('click', () => { selectedView = opt.value; paint(); });
            viewRow.appendChild(el);
            viewEls.push({ el, indicator, value: opt.value });
        });
        content.appendChild(viewRow);

        // ---- 学生名单（仅当该视图需要按学生导出时显示） ----
        const preset = preselectId != null
            ? list.findIndex(s => String(s.id) === String(preselectId))
            : -1;
        let selectedStudentIndex = preset >= 0 ? preset : 0;
        const studentEls = [];
        let studentSection = null;

        if (list.length > 0) {
            studentSection = document.createElement('div');
            studentSection.style.cssText = 'margin-top: 18px;';

            const stuTitle = document.createElement('div');
            stuTitle.style.cssText = 'font-size: var(--fs-300); font-weight: 600; color: #1e293b; margin-bottom: 10px;';
            stuTitle.textContent = '选择要导出的学生';
            studentSection.appendChild(stuTitle);

            const stuList = document.createElement('div');
            stuList.style.cssText = 'max-height: 240px; overflow-y: auto; padding-right: 2px;';
            stuList.setAttribute('role', 'radiogroup');
            stuList.setAttribute('aria-label', '导出学生');

            list.forEach((stu, idx) => {
                const row = document.createElement('div');
                row.style.cssText = [
                    'display: flex', 'align-items: center', 'gap: 12px',
                    'padding: 12px 14px', 'margin-bottom: 8px', 'cursor: pointer',
                    'border: 1.5px solid #e7ecf1', 'border-radius: 10px',
                    'transition: background 0.15s, border-color 0.15s'
                ].join(';');
                const indicator = makeIndicator();
                const nameSpan = document.createElement('span');
                nameSpan.textContent = stu.name;
                nameSpan.style.cssText = 'color: #1e293b; font-size: var(--fs-300); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
                row.appendChild(indicator);
                row.appendChild(nameSpan);
                row.addEventListener('click', () => { selectedStudentIndex = idx; paint(); });
                stuList.appendChild(row);
                studentEls.push({ el: row, indicator });
            });
            studentSection.appendChild(stuList);
            content.appendChild(studentSection);
        }

        box.appendChild(content);

        const paint = () => {
            viewEls.forEach(({ el, indicator, value }) => {
                const active = value === selectedView;
                el.style.background = active ? 'rgba(46,204,113,0.10)' : '#ffffff';
                // 选中态只靠浅绿背景 + 圆形指示器，边框始终一致，不加额外高亮边框
                el.style.borderColor = '#e7ecf1';
                paintIndicator(indicator, active);
            });
            // 名单区随视图显隐：不需要选学生的视图不显示，避免选了没用
            if (studentSection) studentSection.style.display = shouldPick(selectedView) ? '' : 'none';
            studentEls.forEach(({ el, indicator }, idx) => {
                const active = idx === selectedStudentIndex;
                el.style.background = active ? 'rgba(46,204,113,0.10)' : '#ffffff';
                el.style.borderColor = '#e7ecf1';
                paintIndicator(indicator, active);
            });
        };
        paint();

        // 尾部（取消 / 确认）
        const footer = document.createElement('div');
        footer.style.cssText = 'padding: 14px 22px; border-top: 1px solid #eef2f6; display: flex; justify-content: flex-end; gap: 12px;';
        const cancel = document.createElement('button');
        cancel.textContent = '取消';
        cancel.style.cssText = 'padding: 8px 20px; border-radius: 10px; border: 1px solid #e2e8f0; background: white; color: #475569; cursor: pointer; font-size: var(--fs-300); font-weight: 500; transition: background 0.15s;';
        cancel.onmouseover = () => cancel.style.background = '#f1f5f9';
        cancel.onmouseout = () => cancel.style.background = 'white';
        const confirm = document.createElement('button');
        confirm.textContent = '确认';
        confirm.style.cssText = 'padding: 8px 22px; border-radius: 10px; border: none; background: ' + GREEN + '; color: white; cursor: pointer; font-size: var(--fs-300); font-weight: 600; box-shadow: 0 2px 4px rgba(46,204,113,0.3); transition: background 0.15s;';
        confirm.onmouseover = () => confirm.style.background = '#27AE60';
        confirm.onmouseout = () => confirm.style.background = GREEN;
        footer.appendChild(cancel);
        footer.appendChild(confirm);
        box.appendChild(footer);

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const cleanup = () => { if (document.body.contains(overlay)) document.body.removeChild(overlay); };
        const onCancel = () => { cleanup(); };
        const onConfirm = () => {
            cleanup();
            const student = shouldPick(selectedView) && list.length > 0
                ? list[selectedStudentIndex]
                : null;
            onChoose && onChoose(selectedView, student);
        };
        closeBtn.addEventListener('click', onCancel);
        cancel.addEventListener('click', onCancel);
        confirm.addEventListener('click', onConfirm);
        overlay.addEventListener('click', e => { if (e.target === overlay) onCancel(); });
    }

    return { openViewChoice };
})();
