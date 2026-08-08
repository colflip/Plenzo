/**
 * 教师端"数据统计"隐藏酬劳计算浮层（彩蛋）
 * 触发：统计区块标题连续点击 5 次（间隔 >1.5s 重置）
 * 计算：复用已拉取/实时统计，按当前日期段计算酬劳；系数公式生成且可手改
 * 风格：调试台/终端"看似有 bug"视觉，但数据真实正确
 */

// 类型中文 → 英文键（含线上/半次/记录变体）
const TYPE_EN = {
    '试教': 'trial',
    '入户': 'visit',
    '半次入户': 'half_visit',
    '（线上）入户': 'online_visit',
    '(线上)入户': 'online_visit',
    '线上入户': 'online_visit',
    '评审': 'review',
    '评审记录': 'review_record',
    '（线上）评审': 'online_review',
    '(线上)评审': 'online_review',
    '线上评审': 'online_review',
    '集体活动': 'group_activity',
    '咨询': 'consultation',
    '咨询记录': 'consultation_record',
    '（线上）咨询': 'online_consultation',
    '(线上)咨询': 'online_consultation',
    '线上咨询': 'online_consultation',
    '（线上）评审记录': 'online_review_record',
    '(线上)评审记录': 'online_review_record',
    '线上评审记录': 'online_review_record',
    '（线上）咨询记录': 'online_consultation_record',
    '(线上)咨询记录': 'online_consultation_record',
    '线上咨询记录': 'online_consultation_record'
};

// 允许带 online 前缀的英文键（其余忽略前缀）
const ONLINE_CAPABLE = new Set(['visit', 'review', 'consultation', 'review_record', 'consultation_record']);

function toEnKey(cn) {
    const isOnline = cn.includes('（线上）') || cn.includes('(线上)') || cn.startsWith('线上');
    const base = cn.replace(/[（(]线上[)）]/g, '').replace(/^线上/, '');
    let en = TYPE_EN[cn] || TYPE_EN[base] || base;
    if (isOnline && ONLINE_CAPABLE.has(en)) en = 'online_' + en;
    return en;
}

// 将原始 typeStats 映射（中文键）聚合为英文键 + 5 项汇总
function aggregate(rawMap) {
    const enMap = {};
    for (const [cn, cntRaw] of Object.entries(rawMap || {})) {
        const c = Number(cntRaw) || 0;
        if (c <= 0) continue;
        const en = toEnKey(cn);
        enMap[en] = (enMap[en] || 0) + c;
    }
    const g = (k) => Number(enMap[k] || 0);
    const visit = g('visit') + g('online_visit');
    const half = g('half_visit');
    const review = g('review') + g('online_review');
    const reviewRec = g('review_record') + g('online_review_record');
    const consult = g('consultation') + g('online_consultation');
    const consultRec = g('consultation_record') + g('online_consultation_record');
    const trial = g('trial');
    const group = g('group_activity');

    // 折算（沿用 StatsAggregator 规则）
    const visitAgg = visit + half * 0.5 + reviewRec * 0.5 + consultRec * 0.5;
    const reviewAgg = review + reviewRec;
    const consultAgg = consult + consultRec;
    return { enMap, visitAgg, reviewAgg, consultAgg, trial, group };
}

// 系数公式：默认 1.0，入户每满 5 个 +0.1（floor 整段计）
function computeCoefficient(visit) {
    return 1.0 + Math.floor(visit / 5) * 0.1;
}

function round2(x) {
    return Math.round((x + Number.EPSILON) * 100) / 100;
}

function fmt(v) {
    if (typeof v !== 'number') return String(v);
    return Number.isInteger(v) ? String(v) : (Math.round(v * 100) / 100).toString();
}

// 费用 = 入户×200×系数 + 评审×100 + 试教×100 + 集体活动×100 + 咨询×100
function computeFee(agg, coeff) {
    const visitSub = round2(agg.visitAgg * 200 * coeff);
    const reviewSub = round2(agg.reviewAgg * 100);
    const trialSub = round2(agg.trial * 100);
    const groupSub = round2(agg.group * 100);
    const consultSub = round2(agg.consultAgg * 100);
    const total = round2(visitSub + reviewSub + trialSub + groupSub + consultSub);
    return {
        breakdown: [
            { item: 'visit', count: agg.visitAgg, unit_price: 200, coefficient: coeff, subtotal: visitSub },
            { item: 'review', count: agg.reviewAgg, unit_price: 100, coefficient: 1.0, subtotal: reviewSub },
            { item: 'trial', count: agg.trial, unit_price: 100, coefficient: 1.0, subtotal: trialSub },
            { item: 'group_activity', count: agg.group, unit_price: 100, coefficient: 1.0, subtotal: groupSub },
            { item: 'consultation', count: agg.consultAgg, unit_price: 100, coefficient: 1.0, subtotal: consultSub }
        ],
        total
    };
}

function buildPayload(name, start, end, coeff, agg, fee) {
    const typeStats = {};
    for (const [k, v] of Object.entries(agg.enMap)) {
        if (v > 0) typeStats[k] = v;
    }
    return {
        basic_info: {
            name,
            date_range: { start, end },
            coefficient: round2(coeff)
        },
        aggregated: {
            visit: round2(agg.visitAgg),
            review: round2(agg.reviewAgg),
            trial: round2(agg.trial),
            group_activity: round2(agg.group),
            consultation: round2(agg.consultAgg)
        },
        type_stats: typeStats,
        breakdown: fee.breakdown,
        total: fee.total
    };
}

function getTeacherName() {
    try {
        const u = JSON.parse(localStorage.getItem('userData') || '{}');
        return u.name || u.nickname || '未知';
    } catch {
        return '未知';
    }
}

async function loadTypeStats(start, end) {
    const cached = window.getTeacherTypeStats ? window.getTeacherTypeStats() : null;
    if (cached && Object.keys(cached).length) return cached;
    if (!start || !end) return {};
    try {
        const token = localStorage.getItem('token');
        const res = await fetch(
            `/api/teacher/statistics?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}`,
            { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (!res.ok) return {};
        const data = await res.json();
        const map = {};
        (Array.isArray(data.typeStats) ? data.typeStats : []).forEach(r => {
            map[r.type || r.name] = r.count;
        });
        return map;
    } catch {
        return {};
    }
}

// ---- 状态 + 渲染 ----
let overlayState = null;

const OVERLAY_HTML = `
  <div class="reward-backdrop"></div>
  <div class="reward-panel">
    <div class="reward-errbar">DEBUG // raw payload (unstable) — do not trust</div>
    <div class="reward-head"><span class="reward-glyph">&#9612;</span> reward_calc :: teacher
      <button id="rewardClose" class="reward-close">[x]</button>
    </div>
    <div class="reward-body">
      <div class="reward-section">
        <div class="reward-h">Basic Info</div>
        <div class="reward-kv"><span>name</span><b id="rName"></b></div>
        <div class="reward-kv"><span>date_range</span><b id="rRange"></b></div>
        <div class="reward-kv"><span>coefficient</span><input id="rCoeff" type="number" step="0.1" class="reward-input"></div>
      </div>
      <div class="reward-section">
        <div class="reward-h">Aggregated Stats</div>
        <div id="rAgg"></div>
      </div>
      <div class="reward-section">
        <div class="reward-h">Teaching Type Stats</div>
        <div id="rTypes"></div>
      </div>
      <div class="reward-section">
        <div class="reward-h">breakdown / total</div>
        <div id="rBreak"></div>
        <div class="reward-total">total = <b id="rTotal"></b></div>
      </div>
      <div class="reward-section">
        <div class="reward-h">raw // json</div>
        <pre id="rJson" class="reward-json"></pre>
      </div>
    </div>
  </div>
`;

const OVERLAY_CSS = `
.reward-trigger-title{font-size:20px;font-weight:700;color:#1e293b;margin:0 0 16px;cursor:pointer;user-select:none;}
.reward-trigger-title:hover{color:#2563eb;}
.reward-overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
.reward-overlay.hidden{display:none;}
.reward-backdrop{position:absolute;inset:0;background:rgba(2,6,12,0.78);backdrop-filter:blur(2px);}
.reward-panel{position:relative;width:min(680px,92vw);max-height:88vh;overflow:auto;background:#0b0f14;border:1px solid #1f2a37;border-radius:10px;color:#9fe6c4;box-shadow:0 0 0 1px #0f1720,0 18px 60px rgba(0,0,0,.6);animation:rewardGlitch 2.4s infinite steps(1);}
@keyframes rewardGlitch{0%,97%{transform:translate(0,0);}98%{transform:translate(-1px,1px);}99%{transform:translate(1px,-1px);}100%{transform:translate(0,0);}}
.reward-errbar{background:#3b1212;color:#ff9a9a;font-size:12px;padding:6px 12px;letter-spacing:.5px;border-bottom:1px solid #5a1d1d;animation:rewardFlicker 3s infinite;}
@keyframes rewardFlicker{0%,92%,100%{opacity:1;}93%{opacity:.35;}94%{opacity:1;}96%{opacity:.6;}}
.reward-head{display:flex;align-items:center;gap:8px;padding:8px 12px;color:#7fb3ff;border-bottom:1px solid #16202b;font-size:13px;}
.reward-close{margin-left:auto;background:none;border:1px solid #2a3a4a;color:#9fe6c4;border-radius:6px;cursor:pointer;padding:2px 8px;font-family:inherit;}
.reward-close:hover{background:#13202b;}
.reward-body{padding:12px;font-size:13px;line-height:1.6;}
.reward-section{margin-bottom:14px;}
.reward-h{color:#ffd479;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;border-left:3px solid #ffd479;padding-left:8px;}
.reward-kv{display:flex;gap:10px;}
.reward-kv>span{color:#6b7c8c;min-width:120px;display:inline-block;}
.reward-kv>b{color:#e6f0ea;font-weight:600;}
.reward-input{background:#0e1620;color:#9fe6c4;border:1px solid #2a3a4a;border-radius:6px;padding:2px 6px;width:90px;font-family:inherit;}
.reward-json{background:#070b0f;border:1px solid #16202b;border-radius:8px;padding:10px;color:#8ab4f8;white-space:pre-wrap;word-break:break-word;font-size:12px;}
.reward-total{margin-top:8px;color:#ffd479;font-size:14px;}
.reward-total b{color:#fff;}
`;

function injectStyle() {
    if (document.getElementById('rewardEasterEggStyle')) return;
    const s = document.createElement('style');
    s.id = 'rewardEasterEggStyle';
    s.textContent = OVERLAY_CSS;
    document.head.appendChild(s);
}

function ensureOverlay() {
    if (document.getElementById('rewardOverlay')) return;
    const wrap = document.createElement('div');
    wrap.id = 'rewardOverlay';
    wrap.className = 'reward-overlay hidden';
    wrap.innerHTML = OVERLAY_HTML;
    document.body.appendChild(wrap);
    wrap.querySelector('.reward-backdrop').addEventListener('click', () => showOverlay(false));
    document.getElementById('rewardClose').addEventListener('click', () => showOverlay(false));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') showOverlay(false);
    });
}

function showOverlay(show) {
    const el = document.getElementById('rewardOverlay');
    if (el) el.classList.toggle('hidden', !show);
}

function renderAgg(agg) {
    const el = document.getElementById('rAgg');
    const rows = [
        ['visit', agg.visitAgg],
        ['review', agg.reviewAgg],
        ['trial', agg.trial],
        ['group_activity', agg.group],
        ['consultation', agg.consultAgg]
    ];
    el.innerHTML = rows.map(([k, v]) => `<div class="reward-kv"><span>${k}</span><b>${fmt(v)}</b></div>`).join('');
}

function renderTypes(agg) {
    const el = document.getElementById('rTypes');
    const entries = Object.entries(agg.enMap).filter(([, v]) => v > 0);
    if (!entries.length) {
        el.innerHTML = '<div class="reward-kv"><span>—</span><b>无授课记录</b></div>';
        return;
    }
    el.innerHTML = entries.map(([k, v]) => `<div class="reward-kv"><span>${k}</span><b>${fmt(v)}</b></div>`).join('');
}

function recompute() {
    const { name, start, end, agg, coeff } = overlayState;
    const fee = computeFee(agg, coeff);
    const payload = buildPayload(name, start, end, coeff, agg, fee);
    document.getElementById('rBreak').innerHTML = fee.breakdown.map(b =>
        `<div class="reward-kv"><span>${b.item}</span><b>${fmt(b.count)} × ${b.unit_price} × ${fmt(b.coefficient)} = ${fmt(b.subtotal)}</b></div>`
    ).join('');
    document.getElementById('rTotal').textContent = fmt(fee.total);
    document.getElementById('rJson').textContent = JSON.stringify(payload, null, 2);
}

function bindCoeff() {
    const input = document.getElementById('rCoeff');
    input.oninput = () => {
        let v = parseFloat(input.value);
        if (!isFinite(v) || v < 0) v = 0;
        overlayState.coeff = v;
        recompute();
    };
}

function renderAll(name, start, end, coeff, agg) {
    overlayState = { name, start, end, agg, coeff };
    document.getElementById('rName').textContent = name;
    document.getElementById('rRange').textContent = `${start} ~ ${end}`;
    document.getElementById('rCoeff').value = round2(coeff);
    renderAgg(agg);
    renderTypes(agg);
    bindCoeff();
    recompute();
}

async function openOverlay() {
    ensureOverlay();
    const start = document.getElementById('teachingStartDate')?.value || '';
    const end = document.getElementById('teachingEndDate')?.value || '';
    const name = getTeacherName();
    const rawMap = await loadTypeStats(start, end);
    const agg = aggregate(rawMap);
    const coeff = computeCoefficient(agg.visitAgg);
    renderAll(name, start, end, coeff, agg);
    showOverlay(true);
}

export function initRewardEasterEgg() {
    injectStyle();
    const title = document.getElementById('rewardTriggerTitle');
    if (!title || title.__rewardBound) return;
    title.__rewardBound = true;
    title.title = title.title || '连续点击 5 次查看隐藏面板';

    let clickCount = 0;
    let lastClick = 0;
    const RESET_MS = 1500;

    title.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastClick > RESET_MS) clickCount = 0;
        lastClick = now;
        clickCount++;
        if (clickCount >= 5) {
            clickCount = 0;
            openOverlay();
        }
    });
}
