/**
 * Schedule Utils Module
 * 包含排课相关的通用工具函数，如格式化、获取数据、合并渲染等
 */

/**
 * 统排课单行数据标准化
 */
export function normalizeScheduleRows(rows) {
    return (rows || []).map(r => {
        // 兼容不同后端字段名：arr_date / class_date / class-date / date
        const rawDate = (r && (r.date ?? r.class_date ?? r['class-date'] ?? r.arr_date));
        let dateISO;
        if (typeof rawDate === 'string') {
            const t = rawDate.trim();
            if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
                dateISO = t;
            } else {
                const d = new Date(t);
                dateISO = Number.isNaN(d.getTime()) ? '' : (window.dateUtils ? window.dateUtils.toISODate(d) : d.toISOString().split('T')[0]);
            }
        } else if (rawDate instanceof Date) {
            dateISO = window.dateUtils ? window.dateUtils.toISODate(rawDate) : rawDate.toISOString().split('T')[0];
        } else if (typeof rawDate === 'number') {
            const d = new Date(rawDate);
            dateISO = Number.isNaN(d.getTime()) ? '' : (window.dateUtils ? window.dateUtils.toISODate(d) : d.toISOString().split('T')[0]);
        } else {
            // 若缺失，保持空字符串（后续渲染会忽略无法匹配的记录）
            dateISO = '';
        }

        // 兼容后端不同键名：start_time / startTime / start-time / start- time / start time
        const startRaw = (typeof r.start_time === 'string') ? r.start_time
            : (typeof r.startTime === 'string') ? r.startTime
                : (typeof r['start-time'] === 'string') ? r['start-time']
                    : (typeof r['start- time'] === 'string') ? r['start- time']
                        : (typeof r['start time'] === 'string') ? r['start time']
                            : null;
        const endRaw = (typeof r.end_time === 'string') ? r.end_time
            : (typeof r.endTime === 'string') ? r.endTime
                : (typeof r['end-time'] === 'string') ? r['end-time']
                    : (typeof r['end- time'] === 'string') ? r['end- time']
                        : (typeof r['end time'] === 'string') ? r['end time']
                            : null;
        // 统一时间格式
        const start = sanitizeTimeString(startRaw);
        const end = sanitizeTimeString(endRaw);
        const location = (r.location || '').trim();
        const teacherName = r.teacher_name || r.teacherName || '';
        // 类型映射：优先通过 course_id/type_id/schedule_type_id 映射到描述
        const typeId = (r.course_id ?? r.type_id ?? r.schedule_type_id);
        // 优先使用后端传回的中文名 schedule_type_cn
        let typeText = r.schedule_type_cn || r.schedule_types || r.schedule_type || r.type_name || '';
        try {
            if (typeId != null && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
                const info = window.ScheduleTypesStore.getById(typeId);
                // 如果后端没返回中文名，或者Store里有更准确的
                if (info && !r.schedule_type_cn) {
                    typeText = (info.description || info.name || typeText || '未分类');
                }
            }
        } catch (_) { }
        const valid = (typeof r.valid === 'boolean') ? r.valid : true;
        return {
            id: r.id,
            student_id: r.student_id,
            student_name: r.student_name,
            teacher_id: r.teacher_id,
            teacher_name: teacherName,
            course_id: (typeId != null ? Number(typeId) : undefined),
            schedule_types: typeText,
            schedule_type_cn: r.schedule_type_cn, // 显式传递
            date: dateISO,
            start_time: start,
            end_time: end,
            location,
            status: r.status,
            valid
        };
    });
}

// 分组/聚类/渲染辅助函数
export function sanitizeTimeString(t) {
    if (t == null) return null;
    let s = String(t).trim();
    // 全角冒号替换为半角
    s = s.replace(/：/g, ':');
    // 允许包含秒：HH:mm 或 HH:mm:ss
    const m = /^([0-2]?\d):([0-5]\d)(?::([0-5]\d))?$/.exec(s);
    if (m) {
        const hh = String(m[1]).padStart(2, '0');
        const mm = String(m[2]).padStart(2, '0');
        return `${hh}:${mm}`;
    }
    // 兼容“H点M分/时分”
    const m2 = /^([0-2]?\d)\s*[时点]\s*([0-5]?\d)\s*[分]?$/.exec(s);
    if (m2) {
        const hh = String(m2[1]).padStart(2, '0');
        const mm = String(m2[2]).padStart(2, '0');
        return `${hh}:${mm}`;
    }
    return null;
}

export function hhmmToMinutes(t) {
    const norm = sanitizeTimeString(t);
    const m = /^([0-2]?\d):([0-5]\d)$/.exec(String(norm || ''));
    return m ? (Number(m[1]) * 60 + Number(m[2])) : NaN;
}

export function minutesToHHMM(min) {
    if (!Number.isFinite(min)) return '';
    const pad2 = (n) => String(n).padStart(2, '0');
    return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;
}

export function computeSlotByStartMin(startMin) {
    // <12:00 上午；12:00–18:29 下午；>=18:30 晚上；无法解析 -> unspecified
    if (!Number.isFinite(startMin)) return 'unspecified';
    if (startMin < 12 * 60) return 'morning';
    if (startMin < (18 * 60 + 30)) return 'afternoon';
    return 'evening';
}

export function clusterByOverlap(records) {
    const sorted = records.slice().sort((a, b) => (a.startMin - b.startMin));
    const clusters = [];
    let cur = null;
    for (const r of sorted) {
        if (!Number.isFinite(r.startMin) || !Number.isFinite(r.endMin)) {
            clusters.push({ records: [r], minStart: r.startMin, maxEnd: r.endMin });
            continue;
        }
        if (!cur) {
            cur = { records: [r], minStart: r.startMin, maxEnd: r.endMin };
        } else if (r.startMin <= cur.maxEnd) {
            cur.records.push(r);
            cur.minStart = Math.min(cur.minStart, r.startMin);
            cur.maxEnd = Math.max(cur.maxEnd, r.endMin);
        } else {
            clusters.push(cur);
            cur = { records: [r], minStart: r.startMin, maxEnd: r.endMin };
        }
    }
    if (cur) clusters.push(cur);
    return clusters;
}

export function buildMergedRowText(group) {
    const peopleText = group.records.map(r => {
        const teacher = r.teacher_name || '待分配';
        const typeText = r.schedule_types || r.schedule_type || '未分类';
        // 状态不在主文本中显示（使用内部中文chip显示状态），避免英文状态残留
        return `${teacher}（${typeText}）`;
    }).join('，');

    const timeText = (Number.isFinite(group.minStart) && Number.isFinite(group.maxEnd))
        ? `${minutesToHHMM(group.minStart)}-${minutesToHHMM(group.maxEnd)}`
        : '时间待定';

    const locations = Array.from(new Set(group.records.map(r => (r.location || '').trim()).filter(Boolean)));
    const locationText = locations.join(' / ') || '地点待定';
    return `${peopleText}，${timeText}，${locationText}`;
}

// 辅助函数：更新排课状态
export async function updateScheduleStatus(id, newStatus) {
    if (!id || !newStatus) return;
    try {
        if (!window.apiUtils || typeof window.apiUtils.put !== 'function') {
            
            return;
        }
        // 调用更新接口
        await window.apiUtils.put(`/admin/schedules/${id}`, { status: newStatus });

        // 成功后刷新视图
        if (window.apiUtils.showToast) window.apiUtils.showToast('状态更新成功', 'success');

        // 智能刷新：如果是周视图且 WeeklyDataStore 存在，更新本地缓存以保持数据一致性，但不刷新整个视图
        const activeSection = document.querySelector('.dashboard-section.active');
        if (activeSection && activeSection.id === 'schedule') {
            // 手动更新缓存中的状态，避免全量刷新
            if (window.WeeklyDataStore && window.WeeklyDataStore.schedules) {
                for (const entry of window.WeeklyDataStore.schedules.values()) {
                    if (entry && Array.isArray(entry.rows)) {
                        const target = entry.rows.find(r => String(r.id) === String(id));
                        if (target) {
                            target.status = newStatus;
                            // 还可以更新 schedule_type_cn 等其他可能受影响的字段（如果需要）
                        }
                    }
                }
            }
        } else {
            // 非周视图（如今日排课）也刷新
            if (typeof window.loadSchedules === 'function') window.loadSchedules();
            if (typeof window.loadTodaySchedules === 'function') window.loadTodaySchedules();
        }
    } catch (error) {
        
        if (window.apiUtils.showToast) window.apiUtils.showToast('状态更新失败', 'error');
        // 可选：如果失败，刷新页面以恢复原状
        if (typeof window.loadSchedules === 'function') window.loadSchedules();
    }
}

export function renderWeeklyLoading() {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, '<tr><td class="sticky-col">加载中...</td><td colspan="7">请稍候</td></tr>'); } else { tbody.innerHTML = '<tr><td class="sticky-col">加载中...</td><td colspan="7">请稍候</td></tr>'; }
}

export function renderWeeklyError(message) {
    const tbody = document.getElementById('weeklyBody');
    if (!tbody) return;
    const msg = (message && message.toString) ? message.toString() : '加载失败';
    if (window.SecurityUtils) { window.SecurityUtils.safeSetHTML(tbody, `<tr><td class="sticky-col">错误</td><td colspan="7">${msg}</td></tr>`); } else { tbody.innerHTML = `<tr><td class="sticky-col">错误</td><td colspan="7">${msg}</td></tr>`; }
}
