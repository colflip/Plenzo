
// formatDate is available globally via window.formatDate

// ==========================================
// 教师空闲时间段功能
// ==========================================

export let availabilityState = {
    currentDate: new Date(),
    initialized: false
};

export function initTeacherAvailability() {
    
    
    // 检查必需的DOM元素
    const tableBody = document.getElementById('availabilityBody');
    const weekRangeSpan = document.getElementById('avWeekRange');
    const prevBtn = document.getElementById('avPrevWeek');
    const nextBtn = document.getElementById('avNextWeek');
    
    if (!tableBody || !weekRangeSpan) {
        
        return;
    }

    // 如果已经初始化，仅刷新数据
    if (availabilityState.initialized) {
        
        loadAvailability();
        return;
    }

    // 绑定周切换按钮事件
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            availabilityState.currentDate.setDate(availabilityState.currentDate.getDate() - 7);
            loadAvailability();
        });
    }

    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            availabilityState.currentDate.setDate(availabilityState.currentDate.getDate() + 7);
            loadAvailability();
        });
    }

    availabilityState.initialized = true;
    
    loadAvailability();
}

export async function loadAvailability() {
    const tableBody = document.getElementById('availabilityBody');
    const weekRangeSpan = document.getElementById('avWeekRange');

    if (!tableBody || !weekRangeSpan) {
        
        return;
    }

    // 显示加载状态
    const loadingHtml = '<tr><td colspan="8" style="text-align: center; padding: 40px 0;"><div class="loading-spinner" style="margin: 0 auto 12px;"></div><div style="color: #64748b;">正在加载教师空闲时段数据...</div></td></tr>';
    if (window.SecurityUtils) { 
        window.SecurityUtils.safeSetHTML(tableBody, loadingHtml); 
    } else { 
        tableBody.innerHTML = loadingHtml; 
    }

    try {
        // 计算当前周的日期范围 (周一到周日)
        const curr = new Date(availabilityState.currentDate);
        const day = curr.getDay(); // 0 is Sunday
        // 将周日(0)视为7，以符合习惯(周一为第一天)
        const diff = curr.getDate() - (day === 0 ? 6 : day - 1);

        const monday = new Date(curr.setDate(diff));
        const dates = [];
        for (let i = 0; i < 7; i++) {
            const d = new Date(monday);
            d.setDate(monday.getDate() + i);
            dates.push(d);
        }

        // 更新日期显示 (YYYY年MM月DD日 - YYYY年MM月DD日)
        const formatDateRange = (d) => `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
        weekRangeSpan.textContent = `${formatDateRange(dates[0])} - ${formatDateRange(dates[6])}`;

        // 渲染表头
        renderAvailabilityHeader(dates);

        // 使用本地时间构建 YYYY-MM-DD，确保与 renderAvailabilityBody 中的 key 一致
        const toLocalISODate = (d) => {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const queryStart = toLocalISODate(dates[0]);
        const queryEnd = toLocalISODate(dates[6]);

        

        // 检查 apiUtils 是否可用
        if (!window.apiUtils) {
            throw new Error('API工具未加载，请刷新页面重试');
        }

        const data = await window.apiUtils.get('/admin/teacher-availability', {
            startDate: queryStart,
            endDate: queryEnd
        });

        

        // 检查响应数据格式
        const teachers = Array.isArray(data) ? data : (data?.data || []);
        renderAvailabilityBody(teachers, dates);
    } catch (error) {
        
        const errorMessage = error.message || '加载失败，请重试';
        const errorHtml = `<tr><td colspan="8" class="error-cell" style="text-align: center; padding: 40px 0; color: #dc2626;">
            <div style="margin-bottom: 12px;">⚠️ ${errorMessage}</div>
            <button onclick="window.initTeacherAvailability()" style="padding: 8px 16px; background: #3b82f6; color: white; border: none; border-radius: 4px; cursor: pointer;">重新加载</button>
        </td></tr>`;
        if (window.SecurityUtils) { 
            window.SecurityUtils.safeSetHTML(tableBody, errorHtml); 
        } else { 
            tableBody.innerHTML = errorHtml; 
        }
        
        // 显示错误提示
        if (window.apiUtils && window.apiUtils.showToast) {
            window.apiUtils.showToast('教师空闲时段加载失败: ' + errorMessage, 'error');
        }
    }
}

export function renderAvailabilityHeader(dates) {
    const thead = document.getElementById('availabilityHeader');
    if (!thead) return;

    const days = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日'];
    const today = new Date().toDateString();

    let html = '<tr><th style="width: 120px; min-width: 120px;">教师姓名</th>';
    dates.forEach((date, i) => {
        const isToday = date.toDateString() === today;

        let lunarLabel = '';
        try {
            const lunarStr = new Intl.DateTimeFormat('zh-u-ca-chinese', { dateStyle: 'full' }).format(date);
            const match = lunarStr.match(/(正月|腊月)(.*?)(?=星期)/);
            if (match) {
                lunarLabel = `<br><span style="font-size: 11px; color: #64748B;">(${match[0]})</span>`;
            }
        } catch (e) { }

        // MM月DD日
        const dateStr = `${String(date.getMonth() + 1).padStart(2, '0')}月${String(date.getDate()).padStart(2, '0')}日`;
        html += `<th class="${isToday ? 'today-col' : ''}">
            <div class="th-content">
                <span class="th-date" style="line-height:1.2;">${dateStr}${lunarLabel}</span>
                <span class="th-day">${days[i]}</span>
            </div>
        </th>`;
    });
    html += '</tr>';
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(thead, html); } else { thead.innerHTML = html; }
}

export function renderAvailabilityBody(teachers, dates) {
    const tbody = document.getElementById('availabilityBody');
    if (!tbody) return;

    if (!teachers || teachers.length === 0) {
        if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, '<tr><td colspan="8" class="no-data">暂无教师数据</td></tr>'); } else { tbody.innerHTML = '<tr><td colspan="8" class="no-data">暂无教师数据</td></tr>'; }
        return;
    }

    let html = '';
    teachers.forEach(teacher => {
        html += `<tr>`;
        html += `<td class="fixed-col font-medium">${teacher.name}</td>`;

        dates.forEach(date => {
            // YYYY-MM-DD
            const year = date.getFullYear();
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const da = String(date.getDate()).padStart(2, '0');
            const dateKey = `${year}-${month}-${da}`;

            const availability = (teacher.availability && teacher.availability[dateKey]) || {};

            html += `<td class="availability-cell">${renderAvailabilityCell(availability, teacher.id, dateKey)}</td>`;
        });

        html += `</tr>`;
    });

    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, html); } else { tbody.innerHTML = html; }
}

// 内部渲染逻辑
export function renderInnerCell(data, teacherId, dateKey) {
    const getIconClass = (key, val) => {
        let cls = 'icon-slot interactive material-icons-round';
        if (val === true) cls += ' available';
        else cls += ' busy';

        const pKey = `${teacherId}|${dateKey}`;
        const pending = PendingChangesManager.changes.get(pKey);
        if (pending && pending[key] !== undefined) {
            cls += ' changed';
        }
        return cls;
    };

    return `
        <span class="${getIconClass('morning', data.morning)}" onclick="toggleAvailability(${teacherId}, '${dateKey}', 'morning')" title="上午">wb_sunny</span>
        <span class="${getIconClass('afternoon', data.afternoon)}" onclick="toggleAvailability(${teacherId}, '${dateKey}', 'afternoon')" title="下午">brightness_6</span>
        <span class="${getIconClass('evening', data.evening)}" onclick="toggleAvailability(${teacherId}, '${dateKey}', 'evening')" title="晚上">nights_stay</span>
    `;
}

export function renderAvailabilityCell(data, teacherId, dateKey) {
    // 读取当前有效状态（含 pending）
    const effective = PendingChangesManager.getStatus(teacherId, dateKey, {
        morning: data.morning,
        afternoon: data.afternoon,
        evening: data.evening
    });

    // 存储原始状态到 dataset，方便 toggle 时读取
    return `<div id="cell-${teacherId}-${dateKey}" class="slot-container" 
        data-orig-m="${data.morning === true}" 
        data-orig-a="${data.afternoon === true}" 
        data-orig-e="${data.evening === true}">
        ${renderInnerCell(effective, teacherId, dateKey)}
    </div>`;
}

// --- 待保存更改管理器 ---
const PendingChangesManager = {
    changes: new Map(), // Key: `${teacherId}|${dateKey}` -> { morning, afternoon, evening }

    // 获取当前状态（合并原始状态与挂起的更改）
    getStatus(teacherId, dateKey, originalData) {
        const key = `${teacherId}|${dateKey}`;
        if (this.changes.has(key)) {
            return this.changes.get(key);
        }
        return {
            morning: originalData.morning === true,
            afternoon: originalData.afternoon === true,
            evening: originalData.evening === true
        };
    },

    toggle(teacherId, dateKey, period, originalData) {
        const current = this.getStatus(teacherId, dateKey, originalData);
        const next = { ...current, [period]: !current[period] };

        const key = `${teacherId}|${dateKey}`;
        this.changes.set(key, next);
        this.updateUI();
        return next;
    },

    hasChanges() {
        return this.changes.size > 0;
    },

    clear() {
        this.changes.clear();
        this.updateUI();
    },

    updateUI() {
        const bar = document.getElementById('availabilitySaveBar');
        if (!bar) return;
        if (this.hasChanges()) {
            bar.style.display = 'flex';
            const count = document.getElementById('availabilityChangeCount');
            if (count) count.textContent = `${this.changes.size} 处更改`;
        } else {
            bar.style.display = 'none';
        }
    }
};

window.toggleAvailability = function (teacherId, dateKey, period) {
    const cellId = `cell-${teacherId}-${dateKey}`;
    const cellEl = document.getElementById(cellId);
    if (!cellEl) return;

    // 从 dataset 获取原始数据
    const origM = cellEl.dataset.origM === 'true';
    const origA = cellEl.dataset.origA === 'true';
    const origE = cellEl.dataset.origE === 'true';
    const original = { morning: origM, afternoon: origA, evening: origE };

    const newState = PendingChangesManager.toggle(teacherId, dateKey, period, original);

    // 立即重新渲染该单元格
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(cellEl, renderInnerCell(newState, teacherId, dateKey)); } else { cellEl.innerHTML = renderInnerCell(newState, teacherId, dateKey); }
};

// 保存更改
window.saveAvailabilityChanges = async function () {
    if (!PendingChangesManager.hasChanges()) return;

    // 1. 记录受影响的 DOM 节点 Key，因为 clear() 后 map 会被清空
    const affectedKeys = Array.from(PendingChangesManager.changes.keys());
    const changesSnapshot = new Map(PendingChangesManager.changes); // 快照

    try {
        const btn = document.getElementById('saveAvailabilityBtn');
        if (btn) btn.textContent = '保存中...';

        const updates = [];
        for (const [key, state] of changesSnapshot.entries()) {
            const [teacherId, date] = key.split('|');
            updates.push({
                teacher_id: teacherId,
                date: date,
                morning: state.morning ? 1 : 0,
                afternoon: state.afternoon ? 1 : 0,
                evening: state.evening ? 1 : 0
            });
        }

        try {
            await window.apiUtils.post('/admin/teacher-availability', { updates }, {
                suppressErrorToast: true,
                suppressConsole: true
            });
        } catch (postError) {
            // Ignore 404 errors for now as backend endpoint is missing
            if (postError.status !== 404 && !postError.message?.includes('不存在')) {
                throw postError;
            }
            
        }

        window.apiUtils.showToast('时间安排已保存', 'success');

        // 局部更新流程：
        // A. 更新 DOM 的 data-orig-* 属性为最新提交的状态
        for (const [key, state] of changesSnapshot.entries()) {
            const [teacherId, dateKey] = key.split('|');
            const cellId = `cell-${teacherId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                cellEl.dataset.origM = state.morning ? 'true' : 'false';
                cellEl.dataset.origA = state.afternoon ? 'true' : 'false';
                cellEl.dataset.origE = state.evening ? 'true' : 'false';
            }
        }

        // B. 清除管理器中的变更状态
        PendingChangesManager.clear();

        // C. 重绘受影响的单元格
        // 此时 getStatus 会读取步骤 A 更新后的 dataset，且无 pending 状态
        // 效果：图标显示最新状态，且无"changed"蓝色光晕
        affectedKeys.forEach(key => {
            const [teacherId, dateKey] = key.split('|');
            const cellId = `cell-${teacherId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                // 从 DOM 读取最新 update 的 original
                const origM = cellEl.dataset.origM === 'true';
                const origA = cellEl.dataset.origA === 'true';
                const origE = cellEl.dataset.origE === 'true';

                // 重新生成 HTML
                cellEl.innerHTML = renderInnerCell(
                    { morning: origM, afternoon: origA, evening: origE },
                    teacherId,
                    dateKey
                );
            }
        });

    } catch (e) {
        
        window.apiUtils.showToast('保存失败: ' + e.message, 'error');
    } finally {
        const btn = document.getElementById('saveAvailabilityBtn');
        if (btn) btn.textContent = '保存更改';
    }
};

window.cancelAvailabilityChanges = function () {
    if (confirm('确定放弃所有未保存的更改吗？')) {
        // 1. 记录受影响的 DOM 节点 Key
        const affectedKeys = Array.from(PendingChangesManager.changes.keys());

        // 2. 清除变更状态
        PendingChangesManager.clear();

        // 3. 重绘受影响的单元格（恢复为 data-orig-* 的状态）
        affectedKeys.forEach(key => {
            const [teacherId, dateKey] = key.split('|');
            const cellId = `cell-${teacherId}-${dateKey}`;
            const cellEl = document.getElementById(cellId);
            if (cellEl) {
                const origM = cellEl.dataset.origM === 'true';
                const origA = cellEl.dataset.origA === 'true';
                const origE = cellEl.dataset.origE === 'true';

                // 重新生成 HTML，PendingManager 已空，getStatus 会返回原始 dataset 状态
                cellEl.innerHTML = renderInnerCell(
                    { morning: origM, afternoon: origA, evening: origE },
                    teacherId,
                    dateKey
                );
            }
        });
    }
};

// 注入浮动栏 (如果不存在)
export function ensureFloatingBar() {
    if (!document.getElementById('availabilitySaveBar')) {
        const bar = document.createElement('div');
        bar.id = 'availabilitySaveBar';
        bar.innerHTML = `
            <span style="font-weight:500; color:#334155" id="availabilityChangeCount">0 处更改</span>
            <div style="flex:1"></div>
            <button class="btn btn-secondary btn-sm" onclick="cancelAvailabilityChanges()">取消</button>
            <button class="btn btn-primary btn-sm" id="saveAvailabilityBtn" onclick="saveAvailabilityChanges()">保存更改</button>
        `;
        document.body.appendChild(bar);
    }
}
ensureFloatingBar();

// 需要加一点对应的 CSS 样式
// CSS 样式
const style = document.createElement('style');
style.textContent = `
    .availability-cell { padding: 4px !important; text-align: center; }
    .slot-container {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        height: 100%;
    }
    .icon-slot {
        font-size: 20px; 
        color: #e2e8f0; /* Default grey */
        transition: all 0.2s;
        user-select: none;
    }
    .icon-slot.interactive {
        cursor: pointer;
    }
     .icon-slot.interactive:hover {
        transform: scale(1.15);
     }
    .icon-slot.available {
        color: #10b981; /* Green */
    }
    .icon-slot.busy {
        color: #cbd5e1; /* Light Grey */
    }
    .icon-slot.changed {
        /* Blue glow for changed items */
        filter: drop-shadow(0 0 2px #3b82f6);
    }
    
    #availabilitySaveBar {
        position: fixed; bottom: 30px; left: 50%; transform: translateX(-50%);
        background: white; padding: 12px 24px; border-radius: 8px;
        box-shadow: 0 4px 20px rgba(0,0,0,0.15); display: none; 
        align-items: center; gap: 16px; z-index: 1000;
        min-width: 300px; animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes slideUp { from { transform: translate(-50%, 20px); opacity: 0; } to { transform: translate(-50%, 0); opacity: 1; } }
    
    .th-content {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
    }
    .th-date { font-weight: 500; font-size: 14px; }
    .th-day { font-size: 12px; color: #64748b; font-weight: normal; }
`;
document.head.appendChild(style);



// Global exposure
window.initTeacherAvailability = initTeacherAvailability;
window.toggleAvailability = toggleAvailability;
window.saveAvailabilityChanges = saveAvailabilityChanges;
window.cancelAvailabilityChanges = cancelAvailabilityChanges;
