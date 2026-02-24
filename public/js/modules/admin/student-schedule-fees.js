/**
 * 学生排课费用管理模块
 * @description 在管理员"学生空闲时段"区域下方提供：
 *   - 日期选择器（指定查询日期）
 *   - 关联学生的当日排课数据表（含学生姓名列）
 *   - 每条排课记录下方的"添加费用"按钮，点击后弹出费用录入弹窗
 */

(function () {
    'use strict';

    // ─── 状态 ───────────────────────────────────────────────
    const state = {
        selectedDate: todayISO(),
        schedules: [],
        initialized: false,
    };

    // ─── 工具函数 ────────────────────────────────────────────
    function todayISO() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function formatDateLabel(iso) {
        if (!iso) return '';
        const [y, m, d] = iso.split('-');
        return `${y}年${m}月${d}日`;
    }

    function statusText(s) {
        return { pending: '待确认', confirmed: '已确认', completed: '已完成', cancelled: '已取消' }[s] || s;
    }

    function statusClass(s) {
        return `sstatus-${s || 'pending'}`;
    }

    // ─── 初始化入口（供外部调用）──────────────────────────────
    window.initStudentScheduleFees = function () {
        if (state.initialized) {
            loadAndRender();
            return;
        }

        const datePicker = document.getElementById('ssfDatePicker');
        if (datePicker) {
            datePicker.value = state.selectedDate;
            datePicker.addEventListener('change', (e) => {
                state.selectedDate = e.target.value;
                loadAndRender();
            });
        }

        // 费用弹窗关闭按钮
        const closeBtn = document.getElementById('ssfModalClose');
        if (closeBtn) closeBtn.addEventListener('click', closeModal);

        // 弹窗背景点击关闭
        const overlay = document.getElementById('ssfModalOverlay');
        if (overlay) overlay.addEventListener('click', closeModal);

        // 费用表单提交
        const form = document.getElementById('ssfFeeForm');
        if (form) form.addEventListener('submit', handleFeeSubmit);

        state.initialized = true;
        loadAndRender();
    };

    // 暴露给排课管理卡片使用
    window.openAdminFeeModal = openModal;
    window.closeAdminFeeModal = closeModal;

    // ─── 数据加载 ─────────────────────────────────────────────
    async function loadAndRender() {
        const tbody = document.getElementById('ssfTableBody');
        const dateLabel = document.getElementById('ssfDateLabel');

        if (!tbody) return;

        if (dateLabel) dateLabel.textContent = formatDateLabel(state.selectedDate);

        // 显示加载状态
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:#64748b;">
            <div class="loading-spinner" style="margin:0 auto 10px;"></div>加载中...
        </td></tr>`;

        try {
            const data = await window.apiUtils.get('/admin/schedules', {
                startDate: state.selectedDate,
                endDate: state.selectedDate,
            });

            state.schedules = Array.isArray(data) ? data : [];
            renderTable(state.schedules);
        } catch (err) {
            console.error('[StudentScheduleFees] 加载失败:', err);
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:#ef4444;">
                加载失败，请重试
            </td></tr>`;
        }
    }

    // ─── 表格渲染 ─────────────────────────────────────────────
    function renderTable(schedules) {
        const tbody = document.getElementById('ssfTableBody');
        if (!tbody) return;

        if (!schedules.length) {
            tbody.innerHTML = `<tr><td colspan="6" class="no-data" style="text-align:center;padding:32px;color:#94a3b8;">
                暂无排课记录
            </td></tr>`;
            return;
        }

        tbody.innerHTML = '';
        schedules.forEach(rec => {
            const tr = document.createElement('tr');
            tr.className = 'ssf-row';

            const tFee = parseFloat(rec.transport_fee) || 0;
            const oFee = parseFloat(rec.other_fee) || 0;
            const hasFee = tFee > 0 || oFee > 0;

            tr.innerHTML = `
                <td class="ssf-cell ssf-name">${rec.student_name || '-'}</td>
                <td class="ssf-cell">${rec.teacher_name || '-'}</td>
                <td class="ssf-cell">${rec.start_time ? rec.start_time.substring(0, 5) : '-'} - ${rec.end_time ? rec.end_time.substring(0, 5) : '-'}</td>
                <td class="ssf-cell">${rec.schedule_type_cn || rec.schedule_type || '-'}</td>
                <td class="ssf-cell"><span class="ssf-status ${statusClass(rec.status)}">${statusText(rec.status)}</span></td>
                <td class="ssf-cell ssf-action-cell">
                    <div class="ssf-fee-info${hasFee ? ' has-fee' : ''}">
                        ${hasFee ? `<span class="ssf-fee-badge">交通费:¥${tFee.toFixed(2)} / 其他:¥${oFee.toFixed(2)}</span>` : ''}
                    </div>
                    <button class="ssf-add-fee-btn${hasFee ? ' has-fee' : ''}" data-id="${rec.id}" data-transport="${tFee}" data-other="${oFee}" data-name="${rec.student_name || ''}">
                        <span class="material-icons-round" style="font-size:15px;vertical-align:middle;">payments</span>
                        ${hasFee ? '修改费用' : '添加费用'}
                    </button>
                </td>
            `;

            tbody.appendChild(tr);
        });

        // 绑定添加费用按钮事件
        tbody.querySelectorAll('.ssf-add-fee-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const id = e.currentTarget.dataset.id;
                const rec = state.schedules.find(r => String(r.id) === String(id));
                if (rec) {
                    openModal([rec], rec.student_name);
                }
            });
        });
    }

    let activeScheduleGroup = null;

    // ─── 费用弹窗 ─────────────────────────────────────────────
    function openModal(group, studentName) {
        activeScheduleGroup = Array.isArray(group) ? group : [group];
        const modal = document.getElementById('adminFeeManagementModal');
        if (!modal) return;

        const defaultTrans = document.getElementById('adminFeeTransportGroup');
        const defaultOther = document.getElementById('adminFeeOtherGroup');
        const container = document.getElementById('adminDynamicFeeInputsContainer');

        const titleEl = document.getElementById('adminFeeModalTitle');
        if (titleEl) titleEl.textContent = studentName ? `${studentName} — 费用录入` : '费用录入';

        if (activeScheduleGroup.length === 1) {
            if (container) container.style.display = 'none';
            if (defaultTrans) defaultTrans.style.display = '';
            if (defaultOther) defaultOther.style.display = '';

            const schedule = activeScheduleGroup[0];
            const tInput = document.getElementById('adminFeeTransportInput');
            const oInput = document.getElementById('adminFeeOtherInput');

            if (tInput) tInput.value = schedule.transport_fee || schedule.transportFee || '';
            if (oInput) oInput.value = schedule.other_fee || schedule.otherFee || '';

            const updateTotalSing = () => {
                const t = parseFloat(tInput?.value) || 0;
                const o = parseFloat(oInput?.value) || 0;
                document.getElementById('adminFeeTotalDisplay').textContent = (t + o).toFixed(2);
            };
            if (tInput) {
                tInput.removeEventListener('input', tInput._updHandler);
                tInput._updHandler = updateTotalSing;
                tInput.addEventListener('input', updateTotalSing);
            }
            if (oInput) {
                oInput.removeEventListener('input', oInput._updHandler);
                oInput._updHandler = updateTotalSing;
                oInput.addEventListener('input', updateTotalSing);
            }
            updateTotalSing();

            // 自动聚焦交通费
            if (tInput) setTimeout(() => tInput.focus(), 50);
        } else {
            if (defaultTrans) defaultTrans.style.display = 'none';
            if (defaultOther) defaultOther.style.display = 'none';
            if (container) {
                container.style.display = 'block';
                container.innerHTML = '';

                activeScheduleGroup.forEach(schedule => {
                    const row = document.createElement('div');
                    row.style.cssText = 'padding: 10px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; margin-bottom: 12px;';
                    let typeText = schedule.schedule_type_cn || schedule.schedule_types || schedule.schedule_type || '课程';
                    row.innerHTML = `
                        <div style="font-weight: bold; margin-bottom: 8px; color: #1e293b;">${schedule.teacher_name || '老师'} - ${typeText} ${schedule.start_time ? '(' + schedule.start_time.substring(0, 5) + ')' : ''}</div>
                        <div style="display: flex; gap: 10px;">
                            <div class="form-group" style="flex: 1; margin-bottom: 0;">
                                <label style="font-size: 12px;">交通费 (元)</label>
                                <input type="number" class="dyn-trans-input" data-id="${schedule.id}" step="0.01" min="0" value="${schedule.transport_fee || schedule.transportFee || ''}" placeholder="0.00" style="padding: 6px; height: 32px; font-size: 14px;">
                            </div>
                            <div class="form-group" style="flex: 1; margin-bottom: 0;">
                                <label style="font-size: 12px;">其他费用 (元)</label>
                                <input type="number" class="dyn-other-input" data-id="${schedule.id}" step="0.01" min="0" value="${schedule.other_fee || schedule.otherFee || ''}" placeholder="0.00" style="padding: 6px; height: 32px; font-size: 14px;">
                            </div>
                        </div>
                    `;
                    container.appendChild(row);
                });

                const updateTotalMulti = () => {
                    let t = 0;
                    container.querySelectorAll('.dyn-trans-input').forEach(inp => t += parseFloat(inp.value) || 0);
                    container.querySelectorAll('.dyn-other-input').forEach(inp => t += parseFloat(inp.value) || 0);
                    document.getElementById('adminFeeTotalDisplay').textContent = t.toFixed(2);
                };
                container.querySelectorAll('input').forEach(inp => inp.addEventListener('input', updateTotalMulti));
                updateTotalMulti();
            }
        }

        modal.style.display = 'flex';
        const overlay = document.getElementById('adminFeeModalOverlay');
        if (overlay) overlay.style.display = 'block';

        // Setup initial closers
        const closeBtn = document.getElementById('closeAdminFeeModal');
        const cancelBtn = document.getElementById('cancelAdminFeeBtn');
        const form = document.getElementById('adminFeeManagementForm');

        if (closeBtn) closeBtn.onclick = closeModal;
        if (cancelBtn) cancelBtn.onclick = closeModal;
        if (overlay) overlay.onclick = closeModal;
        if (form) {
            form.onsubmit = handleFeeSubmit;
        }
    }

    function closeModal() {
        const modal = document.getElementById('adminFeeManagementModal');
        const overlay = document.getElementById('adminFeeModalOverlay');
        if (modal) modal.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        activeScheduleGroup = null;
    }

    async function handleFeeSubmit(e) {
        e.preventDefault();
        if (!activeScheduleGroup || activeScheduleGroup.length === 0) return;

        const saveBtn = document.getElementById('saveAdminFeeBtn');
        if (saveBtn) {
            saveBtn.textContent = '保存中...';
            saveBtn.disabled = true;
        }

        const updates = [];
        if (activeScheduleGroup.length === 1) {
            const tFee = parseFloat(document.getElementById('adminFeeTransportInput').value) || 0;
            const oFee = parseFloat(document.getElementById('adminFeeOtherInput').value) || 0;
            updates.push({
                id: activeScheduleGroup[0].id,
                transport_fee: tFee,
                other_fee: oFee
            });
        } else {
            const container = document.getElementById('adminDynamicFeeInputsContainer');
            if (container) {
                activeScheduleGroup.forEach(schedule => {
                    const tInp = container.querySelector(`.dyn-trans-input[data-id="${schedule.id}"]`);
                    const oInp = container.querySelector(`.dyn-other-input[data-id="${schedule.id}"]`);
                    updates.push({
                        id: schedule.id,
                        transport_fee: parseFloat(tInp?.value) || 0,
                        other_fee: parseFloat(oInp?.value) || 0
                    });
                });
            }
        }

        // --- 乐观更新前奏：备份原始数据 ---
        const backups = [];
        updates.forEach(upd => {
            const rec = state.schedules.find(r => String(r.id) === String(upd.id));
            if (rec) {
                backups.push({
                    id: rec.id,
                    transport_fee: rec.transport_fee,
                    other_fee: rec.other_fee
                });

                // --- 立即将新值应用到本地数据 ---
                rec.transport_fee = upd.transport_fee;
                rec.other_fee = upd.other_fee;
            }
        });

        // 乐观地在网络响应前刷新费用明细表和周表统览
        renderTable(state.schedules);
        if (window.ScheduleManager && typeof window.ScheduleManager.renderCache === 'function') {
            window.ScheduleManager.renderCache();
        } else if (window.ScheduleManager && typeof window.ScheduleManager.loadSchedules === 'function') {
            window.ScheduleManager.loadSchedules();
        }

        try {
            // Admin端同样可以复用原有的对各别schedule 的 patch 机制，利用 Promise.all 齐发
            await Promise.all(updates.map(upd =>
                window.apiUtils.patch(`/admin/schedules/${upd.id}/fees`, {
                    transport_fee: upd.transport_fee,
                    other_fee: upd.other_fee,
                })
            ));

            window.apiUtils.showToast('费用保存成功', 'success');
            closeModal();
        } catch (err) {
            console.error('[StudentScheduleFees] 保存费用失败，回滚操作:', err);
            window.apiUtils.showToast('保存失败：' + (err.message || '未知错误'), 'error');

            // --- 悲观回滚：网络故障导致未存储成功，逆向还原状态 ---
            backups.forEach(backup => {
                const b_rec = state.schedules.find(r => String(r.id) === String(backup.id));
                if (b_rec) {
                    b_rec.transport_fee = backup.transport_fee;
                    b_rec.other_fee = backup.other_fee;
                }
            });
            // 回滚更新视图
            renderTable(state.schedules);
            if (window.ScheduleManager && typeof window.ScheduleManager.renderCache === 'function') {
                window.ScheduleManager.renderCache();
            } else if (window.ScheduleManager && typeof window.ScheduleManager.loadSchedules === 'function') {
                window.ScheduleManager.loadSchedules();
            }
        } finally {
            if (saveBtn) {
                saveBtn.textContent = '保存';
                saveBtn.disabled = false;
            }
        }
    }

})();
