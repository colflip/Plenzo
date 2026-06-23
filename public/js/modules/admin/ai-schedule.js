/**
 * 智能排课 AI 集成 (AI Schedule Integration)
 * @description 在管理端排课页面集成三种 AI 能力：
 *              1. AI 推荐时间（一键，基于已选师生课程日期）
 *              2. 自然语言录入（一句话生成排课）
 *              3. 批量排课（一批需求自动生成方案）
 * @module modules/admin/ai-schedule
 *
 * 依赖: window.apiUtils (POST /ai/schedule-suggest, /ai/parse-schedule, /ai/batch-schedule)
 *       现有 schedule-manager.js 的表单元素 (#scheduleForm 等)
 */

/**
 * AI 按钮条样式（动态注入，仅一次）
 */
function injectStyles() {
    if (document.getElementById('ai-schedule-styles')) return;
    const style = document.createElement('style');
    style.id = 'ai-schedule-styles';
    style.textContent = `
    /* AI 按钮通用样式 */
    .ai-btn {
        display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
        padding: 6px 12px; border-radius: 8px; font-size: 13px; font-family: inherit;
        background: linear-gradient(135deg, rgba(99,102,241,0.18), rgba(139,92,246,0.18));
        border: 1px solid rgba(139,92,246,0.4); color: #c7d2fe; transition: all .2s;
    }
    .ai-btn:hover { background: linear-gradient(135deg, rgba(99,102,241,0.35), rgba(139,92,246,0.35)); color: #fff; }
    .ai-btn:disabled { opacity: .4; cursor: not-allowed; }

    /* AI 推荐卡片 */
    .ai-suggest-card {
        border: 1px solid rgba(139,92,246,0.4); border-radius: 10px; padding: 12px;
        margin: 8px 0; cursor: pointer; transition: all .2s;
        background: rgba(99,102,241,0.08);
    }
    .ai-suggest-card:hover { background: rgba(99,102,241,0.18); transform: translateY(-1px); }
    .ai-suggest-card .time { font-size: 16px; font-weight: 600; color: #c7d2fe; }
    .ai-suggest-card .score { font-size: 11px; color: #4ade80; margin-left: 8px; }
    .ai-suggest-card .reasons { font-size: 12px; color: rgba(255,255,255,0.6); margin-top: 4px; }

    /* AI 弹窗（复用 modalOverlay 风格） */
    .ai-modal {
        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
        background: rgba(20, 25, 40, 0.92); backdrop-filter: blur(24px);
        border: 1px solid rgba(255,255,255,0.12); border-radius: 16px;
        padding: 24px; z-index: 100003; min-width: 420px; max-width: 600px; max-height: 80vh;
        overflow-y: auto; color: #fff; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    }
    .ai-modal h3 { margin: 0 0 16px; font-size: 18px; display: flex; align-items: center; gap: 8px; }
    .ai-modal-close {
        position: absolute; top: 16px; right: 16px; background: rgba(255,255,255,0.1);
        border: none; color: #fff; cursor: pointer; width: 30px; height: 30px; border-radius: 50%; font-size: 18px;
    }
    .ai-modal-close:hover { background: rgba(255,255,255,0.2); }
    .ai-modal textarea, .ai-modal input, .ai-modal select {
        width: 100%; background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 8px; padding: 10px; color: #fff; font-family: inherit; font-size: 14px; outline: none;
    }
    .ai-modal textarea:focus, .ai-modal input:focus { border-color: rgba(139,92,246,0.6); }
    .ai-modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
    .ai-modal-actions button {
        padding: 8px 16px; border-radius: 8px; cursor: pointer; font-family: inherit; font-size: 14px; border: none;
    }
    .ai-modal-actions .btn-cancel { background: rgba(255,255,255,0.1); color: #fff; }
    .ai-modal-actions .btn-primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; }

    /* 批量排课表格 */
    .ai-batch-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
    .ai-batch-table th, .ai-batch-table td { padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); text-align: left; }
    .ai-batch-table th { color: rgba(255,255,255,0.5); font-weight: 500; }
    .ai-batch-table input[type=checkbox] { cursor: pointer; }

    .ai-parse-result {
        background: rgba(99,102,241,0.08); border: 1px solid rgba(139,92,246,0.3);
        border-radius: 10px; padding: 14px; margin-top: 12px;
    }
    .ai-parse-result .field { display: flex; justify-content: space-between; padding: 4px 0; font-size: 13px; }
    .ai-parse-result .field .label { color: rgba(255,255,255,0.5); }
    .ai-parse-result .field .value { color: #fff; }

    .ai-loading { text-align: center; padding: 30px; color: rgba(255,255,255,0.6); }
    .ai-loading .spinner { display: inline-block; width: 24px; height: 24px; border: 3px solid rgba(255,255,255,0.2);
        border-top-color: #8b5cf6; border-radius: 50%; animation: ai-spin 0.8s linear infinite; }
    @keyframes ai-spin { to { transform: rotate(360deg); } }

    .ai-empty-result { text-align: center; padding: 20px; color: rgba(255,255,255,0.5); font-size: 14px; }

    @media (max-width: 600px) { .ai-modal { min-width: 90vw; } }
    `;
    document.head.appendChild(style);
}

/* ============================================================
 * 工具函数
 * ============================================================ */

/** 创建遮罩 */
function createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'ai-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:100002;';
    return overlay;
}

/** 创建弹窗 */
function createModal(title, contentHTML) {
    const overlay = createOverlay();
    const modal = document.createElement('div');
    modal.className = 'ai-modal';
    modal.innerHTML = `
        <button class="ai-modal-close" title="关闭">×</button>
        <h3>${title}</h3>
        <div class="ai-modal-content">${contentHTML}</div>
    `;
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    modal.querySelector('.ai-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    return { overlay, modal, close };
}

/** 转义 HTML */
function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ============================================================
 * 1. AI 推荐时间（一键）
 * ============================================================ */

/**
 * 在排课表单 header 注入 "✨ AI 推荐时间" 按钮
 */
function injectSuggestButton() {
    const header = document.querySelector('#scheduleFormContainer .form-header > div:first-child');
    if (!header || document.getElementById('ai-suggest-time-btn')) return;

    const btn = document.createElement('button');
    btn.id = 'ai-suggest-time-btn';
    btn.type = 'button';
    btn.className = 'ai-btn';
    btn.innerHTML = '✨ AI 推荐时间';
    btn.style.marginLeft = '8px';
    btn.addEventListener('click', openSuggestModal);
    header.appendChild(btn);
}

async function openSuggestModal() {
    // 读取表单当前值
    const teacherId = document.getElementById('scheduleTeacher')?.value;
    const studentId = document.getElementById('scheduleStudent')?.value;
    const date = document.getElementById('scheduleDate')?.value;
    const courseId = document.getElementById('scheduleTypeSelect')?.value;

    if (!teacherId || !studentId || !date) {
        window.Toast?.warning?.('请先选择教师、学生和日期，再使用 AI 推荐') ||
            window.apiUtils?.showToast?.('请先选择教师、学生和日期', 'warning');
        return;
    }

    const { modal, close } = createModal('✨ AI 时间推荐', `
        <div class="ai-loading"><span class="spinner"></span><p style="margin-top:12px">正在分析可用时段和历史偏好...</p></div>
    `);

    try {
        const resp = await window.apiUtils.post('/ai/schedule-suggest', {
            teacherId: Number(teacherId),
            studentIds: [Number(studentId)],
            courseId: courseId ? Number(courseId) : undefined,
            date,
            durationMin: 120
        });
        const data = resp.data || resp;
        renderSuggestResults(modal, data, close);
    } catch (err) {
        modal.querySelector('.ai-modal-content').innerHTML =
            `<div class="ai-empty-result">❌ ${escapeHtml(err.message || '推荐失败，请稍后重试')}</div>`;
    }
}

function renderSuggestResults(modal, data, close) {
    const content = modal.querySelector('.ai-modal-content');
    const suggestions = data.suggestions || [];

    if (suggestions.length === 0) {
        content.innerHTML = `<div class="ai-empty-result">${escapeHtml(data.message || '未找到可用时段，请尝试其他日期。')}</div>`;
        return;
    }

    const slotLabel = { morning: '上午', afternoon: '下午', evening: '晚上' };
    let html = `<p style="color:rgba(255,255,255,0.6);font-size:13px;margin:0 0 8px">
        共找到 ${data.totalCandidates || suggestions.length} 个可用时段，推荐前 ${suggestions.length} 个，点击即可填入表单：</p>`;
    suggestions.forEach(s => {
        const reasons = (s.reasons || []).map(r => `<div>• ${escapeHtml(r)}</div>`).join('');
        html += `
        <div class="ai-suggest-card" data-start="${s.startTime}" data-end="${s.endTime}">
            <div><span class="time">${s.startTime} - ${s.endTime}</span><span class="score">评分 ${s.score}</span>
                 <span style="font-size:11px;color:rgba(255,255,255,0.4);margin-left:8px">${slotLabel[s.slot] || s.slot}</span></div>
            <div class="reasons">${reasons}</div>
        </div>`;
    });
    content.innerHTML = html;

    // 点击填入表单
    content.querySelectorAll('.ai-suggest-card').forEach(card => {
        card.addEventListener('click', () => {
            const startEl = document.getElementById('scheduleStartTime');
            const endEl = document.getElementById('scheduleEndTime');
            if (startEl) startEl.value = card.dataset.start;
            if (endEl) endEl.value = card.dataset.end;
            window.Toast?.success?.('已填入推荐时间') || window.apiUtils?.showSuccessToast?.('已填入推荐时间');
            close();
        });
    });
}

/* ============================================================
 * 2. 自然语言录入
 * ============================================================ */

let parseTriggerBtn = null;

function injectParseButton() {
    const section = document.getElementById('schedule');
    if (!section || document.getElementById('ai-parse-btn')) return;

    // 创建一个工具条，放在排课区顶部
    const toolbar = document.createElement('div');
    toolbar.style.cssText = 'display:flex;gap:8px;padding:8px 0;flex-wrap:wrap;';
    toolbar.innerHTML = `
        <button id="ai-parse-btn" class="ai-btn">💬 自然语言录入</button>
        <button id="ai-batch-btn" class="ai-btn">📥 批量排课</button>
    `;
    // 插到 section 的第一个子元素前
    section.insertBefore(toolbar, section.firstChild);

    document.getElementById('ai-parse-btn').addEventListener('click', openParseModal);
    document.getElementById('ai-batch-btn').addEventListener('click', openBatchModal);
}

async function openParseModal() {
    const { modal, close } = createModal('💬 自然语言录入排课', `
        <p style="color:rgba(255,255,255,0.6);font-size:13px;margin:0 0 10px">
            用一句话描述排课需求，AI 会自动解析并填入表单。</p>
        <textarea id="ai-parse-input" rows="3" placeholder="例如：下周三晚上 7 点给张老师和李同学排一节钢琴课，地点在朝阳校区"></textarea>
        <div class="ai-modal-actions">
            <button class="btn-cancel">取消</button>
            <button class="btn-primary" id="ai-parse-go">解析并填入</button>
        </div>
        <div id="ai-parse-result-area"></div>
    `);

    modal.querySelector('.btn-cancel').addEventListener('click', close);
    modal.querySelector('#ai-parse-go').addEventListener('click', async () => {
        const text = modal.querySelector('#ai-parse-input').value.trim();
        if (!text) return;
        const resultArea = modal.querySelector('#ai-parse-result-area');
        resultArea.innerHTML = `<div class="ai-loading"><span class="spinner"></span></div>`;

        try {
            const resp = await window.apiUtils.post('/ai/parse-schedule', { text });
            const data = resp.data || resp;
            renderParseResult(resultArea, data, modal, close);
        } catch (err) {
            resultArea.innerHTML = `<div class="ai-empty-result">❌ ${escapeHtml(err.message || '解析失败')}</div>`;
        }
    });
}

function renderParseResult(container, data, modal, close) {
    const p = data.parsed || {};
    const tCands = p.teacherCandidates || [];
    const sCands = p.studentCandidates || [];
    const cCands = p.courseCandidates || [];

    const fieldHtml = (label, value, candidates) => `
        <div class="field">
            <span class="label">${label}</span>
            <span class="value">${escapeHtml(value || '—')}${candidates && candidates.length > 1 ? ` <span style="color:#fbbf24">(找到 ${candidates.length} 个匹配，请确认)</span>` : ''}</span>
        </div>`;

    let html = `<div class="ai-parse-result">
        ${fieldHtml('教师', p.teacherName || p.teacherId, tCands)}
        ${fieldHtml('学生', p.studentName || p.studentId, sCands)}
        ${fieldHtml('课程', p.courseName || p.courseId, cCands)}
        ${fieldHtml('日期', p.date)}
        ${fieldHtml('时间', p.startTime && p.endTime ? `${p.startTime} - ${p.endTime}` : (p.startTime || '—'))}
        ${fieldHtml('地点', p.location)}
        ${fieldHtml('置信度', Math.round((data.confidence || 0) * 100) + '%')}
    </div>`;

    if (data.needsConfirm) {
        // 多匹配：提供选择器
        html += buildCandidateSelectors(p);
        html += `<div class="ai-modal-actions"><button class="btn-primary" id="ai-parse-fill">填入表单</button></div>`;
    } else {
        html += `<div class="ai-modal-actions"><button class="btn-primary" id="ai-parse-fill">填入表单</button></div>`;
    }

    container.innerHTML = html;

    container.querySelector('#ai-parse-fill').addEventListener('click', () => {
        applyParseToForm(p, container);
        close();
    });
}

function buildCandidateSelectors(p) {
    let html = '';
    if ((p.teacherCandidates || []).length > 1) {
        html += `<div style="margin-top:10px"><label style="font-size:12px;color:rgba(255,255,255,0.5)">确认教师:</label>
            <select id="ai-cand-teacher">${p.teacherCandidates.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (#${c.id})</option>`).join('')}</select></div>`;
    }
    if ((p.studentCandidates || []).length > 1) {
        html += `<div style="margin-top:10px"><label style="font-size:12px;color:rgba(255,255,255,0.5)">确认学生:</label>
            <select id="ai-cand-student">${p.studentCandidates.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (#${c.id})</option>`).join('')}</select></div>`;
    }
    if ((p.courseCandidates || []).length > 1) {
        html += `<div style="margin-top:10px"><label style="font-size:12px;color:rgba(255,255,255,0.5)">确认课程:</label>
            <select id="ai-cand-course">${p.courseCandidates.map(c => `<option value="${c.id}">${escapeHtml(c.description || c.name)}</option>`).join('')}</select></div>`;
    }
    return html;
}

function applyParseToForm(p, container) {
    const teacherSel = document.getElementById('scheduleTeacher');
    const studentSel = document.getElementById('scheduleStudent');
    const typeSel = document.getElementById('scheduleTypeSelect');
    const dateInput = document.getElementById('scheduleDate');
    const startInput = document.getElementById('scheduleStartTime');
    const endInput = document.getElementById('scheduleEndTime');
    const locInput = document.getElementById('scheduleLocation');

    // 优先用候选选择器的值（用户二次确认的），否则用解析的唯一 ID
    const teacherId = container.querySelector('#ai-cand-teacher')?.value || p.teacherId;
    const studentId = container.querySelector('#ai-cand-student')?.value || p.studentId;
    const courseId = container.querySelector('#ai-cand-course')?.value || p.courseId;

    if (teacherId && teacherSel) teacherSel.value = teacherId;
    if (studentId && studentSel) studentSel.value = studentId;
    if (courseId && typeSel) typeSel.value = courseId;
    if (p.date && dateInput) dateInput.value = p.date;
    if (p.startTime && startInput) startInput.value = p.startTime;
    if (p.endTime && endInput) endInput.value = p.endTime;
    if (p.location && locInput) locInput.value = p.location;

    window.Toast?.success?.('已填入解析结果，请核对后保存') || window.apiUtils?.showSuccessToast?.('已填入解析结果');
}

/* ============================================================
 * 3. 批量排课
 * ============================================================ */

async function openBatchModal() {
    const today = new Date().toISOString().split('T')[0];
    const weekLater = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0];

    const { modal, close } = createModal('📥 批量排课', `
        <p style="color:rgba(255,255,255,0.6);font-size:13px;margin:0 0 10px">
            录入一批排课需求，AI 会自动匹配教师和时段生成方案。生成的方案需勾选确认后才会创建。</p>
        <div style="display:flex;gap:8px;margin-bottom:10px">
            <div style="flex:1"><label style="font-size:12px;color:rgba(255,255,255,0.5)">开始日期</label><input type="date" id="ai-batch-start" value="${today}"></div>
            <div style="flex:1"><label style="font-size:12px;color:rgba(255,255,255,0.5)">结束日期</label><input type="date" id="ai-batch-end" value="${weekLater}"></div>
        </div>
        <label style="font-size:12px;color:rgba(255,255,255,0.5)">偏好时段</label>
        <select id="ai-batch-slot" style="margin-bottom:10px">
            <option value="">不限</option>
            <option value="morning">上午</option>
            <option value="afternoon" selected>下午</option>
            <option value="evening">晚上</option>
        </select>
        <label style="font-size:12px;color:rgba(255,255,255,0.5)">需求列表（每行一条，格式：学生ID, 课程ID, [指定教师ID]）</label>
        <textarea id="ai-batch-input" rows="5" placeholder="12, 3&#10;15, 3&#10;18, 5, 7"></textarea>
        <div class="ai-modal-actions">
            <button class="btn-cancel">取消</button>
            <button class="btn-primary" id="ai-batch-go">生成方案</button>
        </div>
        <div id="ai-batch-result-area"></div>
    `);

    modal.querySelector('.btn-cancel').addEventListener('click', close);
    modal.querySelector('#ai-batch-go').addEventListener('click', () => generateBatch(modal, close));
}

async function generateBatch(modal, close) {
    const startDate = modal.querySelector('#ai-batch-start').value;
    const endDate = modal.querySelector('#ai-batch-end').value;
    const slotPreference = modal.querySelector('#ai-batch-slot').value || undefined;
    const raw = modal.querySelector('#ai-batch-input').value.trim();

    if (!raw || !startDate || !endDate) {
        window.Toast?.warning?.('请填写日期范围和需求列表');
        return;
    }

    // 解析需求
    const requests = raw.split('\n').map(line => {
        const parts = line.split(',').map(s => s.trim()).filter(Boolean).map(Number);
        if (parts.length >= 2 && parts.every(n => !isNaN(n))) {
            return { studentId: parts[0], courseId: parts[1], preferredTeacherId: parts[2] || undefined };
        }
        return null;
    }).filter(Boolean);

    if (requests.length === 0) {
        window.Toast?.warning?.('需求格式不正确，每行应为：学生ID, 课程ID[, 教师ID]');
        return;
    }

    const resultArea = modal.querySelector('#ai-batch-result-area');
    resultArea.innerHTML = `<div class="ai-loading"><span class="spinner"></span><p style="margin-top:12px">正在生成排课方案...</p></div>`;

    try {
        const resp = await window.apiUtils.post('/ai/batch-schedule', {
            requests, dateRange: [startDate, endDate], slotPreference
        });
        renderBatchResult(resultArea, resp.data || resp, close);
    } catch (err) {
        resultArea.innerHTML = `<div class="ai-empty-result">❌ ${escapeHtml(err.message || '生成失败')}</div>`;
    }
}

function renderBatchResult(container, data, close) {
    const solutions = data.solutions || [];
    const skipped = data.skipped || [];
    const summary = data.summary || {};

    let html = `<div style="margin:12px 0;padding:10px;background:rgba(74,222,128,0.1);border-radius:8px;font-size:13px">
        ✅ 已安排 ${summary.placed || solutions.length} 节，${summary.skipped || 0} 节无法安排</div>`;

    if (solutions.length > 0) {
        html += `<table class="ai-batch-table">
            <thead><tr><th></th><th>学生</th><th>教师</th><th>课程</th><th>日期</th><th>时间</th><th>备注</th></tr></thead><tbody>`;
        solutions.forEach((s, i) => {
            html += `<tr>
                <td><input type="checkbox" checked data-idx="${i}"></td>
                <td>${s.studentId}</td><td>${s.teacherId}</td><td>${s.courseId}</td>
                <td>${s.date}</td><td>${s.startTime}-${s.endTime}</td>
                <td style="font-size:11px;color:rgba(255,255,255,0.5)">${escapeHtml(s.notes || '')}</td>
            </tr>`;
        });
        html += `</tbody></table>`;
        html += `<div class="ai-modal-actions"><button class="btn-primary" id="ai-batch-create">创建勾选的排课</button></div>`;
    }

    if (skipped.length > 0) {
        html += `<p style="color:#f87171;font-size:12px;margin-top:12px">无法安排：</p><ul style="font-size:12px;color:rgba(255,255,255,0.6)">`;
        skipped.forEach(s => { html += `<li>学生 ${s.studentId}（课程 ${s.courseId}）：${escapeHtml(s.reason || '')}</li>`; });
        html += `</ul>`;
    }

    container.innerHTML = html;

    const createBtn = container.querySelector('#ai-batch-create');
    if (createBtn) {
        createBtn.addEventListener('click', async () => {
            createBtn.disabled = true;
            createBtn.textContent = '创建中...';
            const checked = [...container.querySelectorAll('input[type=checkbox]:checked')];
            let ok = 0, fail = 0;
            for (const cb of checked) {
                const idx = Number(cb.dataset.idx);
                const s = solutions[idx];
                try {
                    // 复用现有 POST /admin/schedules 创建（保证审计一致）
                    await window.apiUtils.post('/admin/schedules', {
                        teacher_id: s.teacherId,
                        student_ids: [s.studentId],
                        date: s.date,
                        start_time: s.startTime,
                        end_time: s.endTime,
                        type_ids: [s.courseId],
                        resolve_strategy: 'override',
                        adjustment_type: 0
                    });
                    ok++;
                } catch (err) {
                    console.error('批量创建失败', s, err);
                    fail++;
                }
            }
            window.Toast?.success?.(`成功创建 ${ok} 节${fail ? `，失败 ${fail} 节` : ''}`);
            // 刷新排课表
            if (window.WeeklyDataStore?.invalidateSchedules) window.WeeklyDataStore.invalidateSchedules();
            if (typeof window.loadSchedules === 'function') window.loadSchedules(true);
            close();
        });
    }
}

/* ============================================================
 * 初始化
 * ============================================================ */

let initialized = false;

/**
 * 初始化排课 AI 集成。幂等，重复调用安全。
 * 因排课 section 是动态渲染的，需要等 DOM 就绪后再注入。
 */
export function init() {
    injectStyles();
    // 尝试立即注入，失败则用 MutationObserver 监听
    tryInject();
    if (!initialized) {
        initialized = true;
        const observer = new MutationObserver(() => tryInject());
        observer.observe(document.body, { childList: true, subtree: true });
        // 30 秒后停止观察（避免长期监听）
        setTimeout(() => observer.disconnect(), 30000);
    }
}

function tryInject() {
    injectSuggestButton();
    injectParseButton();
}

export default { init };
