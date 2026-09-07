/**
 * 排课弹窗的 pair 行表单（多师多生）
 *
 * 一场课一行后，弹窗从「单选老师 + 单选学生 + 单选类型」改成两个可增删的 pair 列表。
 * 这里只管表单的渲染与读取；提交、校验、接口调用仍在 schedule-manager.js。
 *
 * 两个约定：
 * - **选项来源复用模板控件**：`#scheduleTeacher` / `#scheduleTypeSelect` / `#scheduleStudent`
 *   仍由 `loadScheduleFormOptions()` 填充（含「限制教师置顶 + 分隔线」逻辑），这里按行克隆，
 *   不重写数据源。
 * - **`uid` 与 `created_by` 一律不提交**：前者由服务端生成，后者从 actor.id 填。
 *   编辑态把已有 uid 放在 `data-uid` 上，仅用于定位，不进 payload。
 */

// 生命周期标签与 shared-utils.LIFECYCLE_MAP 一致（前端没有 CommonJS，这里保留一份字面量）
const LIFECYCLE_LABELS = {
    pending: '待确认',
    confirmed: '已确认',
    completed: '已完成',
    cancelled: '已取消',
    modified_away: '已调整'
};

// 类别位：adjusted 不可手选（只有「作废+增补」流程能写），本就是增补课的行以只读文本显示
const SELECTABLE_CATEGORIES = { normal: '普通', temp: '临时加课' };
const CATEGORY_LABELS = { normal: '普通', temp: '临时加课', adjusted: '调整增补' };

const $ = (id) => document.getElementById(id);

/**
 * 把 select 的宽度收到「当前选中项」的文字宽度。
 *
 * 不能靠 CSS：select 的固有宽度取自**最长的那个 option**，而教师列表里有
 * '──────────' 分隔线和「（暂停）(时间冲突)」后缀，最长项能到 ~200px，
 * 于是每个下拉框都是一片空白。`field-sizing: content` 正好解决这件事，但只有
 * Chrome 123+ 支持，Safari / Firefox 上完全无效，所以这里用量文字宽度的方式做，
 * 与 ui-helper.js 的 adjustSelectMinWidth 同一套探针手法（那个是按最长项撑开，
 * 用途相反，不能直接复用）。
 */
const SELECT_ARROW_WIDTH = 20;
let widthProbe = null;

function fitSelectWidth(sel) {
    if (!sel) return;
    const opt = sel.options[sel.selectedIndex];
    const text = opt ? opt.text : '';
    const cs = getComputedStyle(sel);

    if (!widthProbe) {
        widthProbe = document.createElement('span');
        widthProbe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;top:-9999px;left:-9999px';
        document.body.appendChild(widthProbe);
    }
    widthProbe.style.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    widthProbe.textContent = text;

    const chrome = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight)
        + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
        + SELECT_ARROW_WIDTH;
    sel.style.width = `${Math.ceil(widthProbe.getBoundingClientRect().width + chrome)}px`;
}

/** 选完以后内容变了，宽度要跟着重量一次 */
function autoFitSelect(sel) {
    if (!sel) return sel;
    sel.addEventListener('change', () => fitSelectWidth(sel));
    fitSelectWidth(sel);
    return sel;
}

function cloneOptions(templateId) {
    const tpl = $(templateId);
    const sel = document.createElement('select');
    if (tpl) sel.innerHTML = tpl.innerHTML;
    return sel;
}

function makeSelect(entries, value) {
    const sel = document.createElement('select');
    Object.entries(entries).forEach(([v, label]) => {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        if (v === value) o.selected = true;
        sel.appendChild(o);
    });
    return sel;
}

function removeButton(container) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pair-remove';
    btn.textContent = '删除';
    btn.title = '从这一场里移除';
    btn.addEventListener('click', () => {
        btn.closest('.pair-row').remove();
        refreshRemoveButtons(container);
    });
    return btn;
}

/** 创建人只显示 id 号；悬浮才给出全称，避免行内塞长文本把一行挤散 */
function createdByTag(pair) {
    if (pair.created_by_id == null) return null;
    const el = document.createElement('span');
    el.className = 'pair-added-by';
    el.textContent = String(pair.created_by_id);
    el.title = pair.created_by_name ? `创建人：${pair.created_by_name}（ID ${pair.created_by_id}）` : `创建人 ID：${pair.created_by_id}`;
    return el;
}

/** 只剩一行时禁用删除（与数据库 validate_session_* 的「数组非空」对齐，前端先拦一次） */
function refreshRemoveButtons(container) {
    const rows = container.querySelectorAll('.pair-row');
    rows.forEach(r => {
        const btn = r.querySelector('.pair-remove');
        if (btn) btn.disabled = rows.length <= 1;
    });
}

/**
 * 添加一行教师 pair。
 * @param {object} pair 已有 pair（编辑态回填）或 {}（新增行）
 */
export function addTeacherRow(pair = {}) {
    const container = $('scheduleTeacherRows');
    if (!container) return null;

    const row = document.createElement('div');
    row.className = 'pair-row';
    row.dataset.kind = 'teacher';
    if (pair.uid) row.dataset.uid = pair.uid;

    const teacherSel = cloneOptions('scheduleTeacher');
    teacherSel.className = 'pair-teacher';
    teacherSel.value = pair.teacher_id != null ? String(pair.teacher_id) : '';

    const typeSel = cloneOptions('scheduleTypeSelect');
    typeSel.className = 'pair-type';
    // 新增行默认沿用上一行的类型（连排同类型课是最常见的情形）
    const prevType = container.querySelector('.pair-row:last-child .pair-type');
    typeSel.value = pair.type_id != null ? String(pair.type_id)
        : (prevType && prevType.value ? prevType.value : '');

    const status = String(pair.status || '');
    const dot = status.indexOf('.');
    const category = dot < 0 ? 'normal' : status.slice(0, dot);
    const lifecycle = dot < 0 ? 'confirmed' : status.slice(dot + 1);

    row.appendChild(teacherSel);
    row.appendChild(typeSel);

    if (category === 'adjusted') {
        // 增补课的类别位是溯源属性，只读显示、不可改回普通
        const badge = document.createElement('span');
        badge.className = 'pair-category-readonly';
        badge.textContent = CATEGORY_LABELS.adjusted;
        badge.dataset.category = 'adjusted';
        row.appendChild(badge);
    } else {
        const catSel = makeSelect(SELECTABLE_CATEGORIES, category);
        catSel.className = 'pair-category';
        row.appendChild(catSel);
    }

    const lifeSel = makeSelect(LIFECYCLE_LABELS, lifecycle);
    lifeSel.className = 'pair-lifecycle';
    row.appendChild(lifeSel);

    // 费用（交通费/其他）与教师评分/评价归财务页面处理，这里不提供编辑入口；
    // 提交时不携带这些键，已有值不会被清空。
    const who = createdByTag(pair);
    if (who) row.appendChild(who);

    row.appendChild(removeButton(container));
    container.appendChild(row);
    // 入 DOM 后再量：getComputedStyle 要拿到 .pair-row select 的字号与内边距
    row.querySelectorAll('select').forEach(autoFitSelect);
    refreshRemoveButtons(container);
    return row;
}
/** 添加一行学生 pair */
export function addStudentRow(pair = {}) {
    const container = $('scheduleStudentRows');
    if (!container) return null;

    const row = document.createElement('div');
    row.className = 'pair-row';
    row.dataset.kind = 'student';
    if (pair.uid) row.dataset.uid = pair.uid;

    const studentSel = cloneOptions('scheduleStudent');
    studentSel.className = 'pair-student';
    studentSel.value = pair.student_id != null ? String(pair.student_id) : '';
    row.appendChild(studentSel);

    // 家属人数/学生评分/学生评价归财务页面处理，这里不提供编辑入口
    const who = createdByTag(pair);
    if (who) row.appendChild(who);

    row.appendChild(removeButton(container));
    container.appendChild(row);
    autoFitSelect(studentSel);
    refreshRemoveButtons(container);
    return row;
}

/**
 * 重量所有 pair select 的宽度。
 * schedule-manager.js 在建行之后还会直接改 `.value` / `.selectedIndex`（默认选第一位
 * 老师、预置点开的那位学生等），那种赋值不触发 change 事件，所以弹窗显示前要再调一次。
 */
export function refitPairSelects() {
    document.querySelectorAll('#scheduleTeacherRows select, #scheduleStudentRows select')
        .forEach(fitSelectWidth);
}

/** 绑定「+ 添加老师 / + 添加学生」按钮（幂等，重复调用不会叠加监听） */
export function initPairForm() {
    const tBtn = $('addTeacherRowBtn');
    const sBtn = $('addStudentRowBtn');
    if (tBtn && !tBtn.dataset.bound) {
        tBtn.dataset.bound = '1';
        tBtn.addEventListener('click', () => addTeacherRow());
    }
    if (sBtn && !sBtn.dataset.bound) {
        sBtn.dataset.bound = '1';
        sBtn.addEventListener('click', () => addStudentRow());
    }
}

/** 新建态：清空并各留一行空行 */
export function resetPairRows() {
    const t = $('scheduleTeacherRows');
    const s = $('scheduleStudentRows');
    if (t) t.innerHTML = '';
    if (s) s.innerHTML = '';
    addTeacherRow();
    addStudentRow();
    const audit = $('scheduleAuditInfo');
    if (audit) { audit.style.display = 'none'; audit.textContent = ''; }
}

/** 编辑态：按场次的 pair 数组回填 */
export function fillPairRows(session) {
    const t = $('scheduleTeacherRows');
    const s = $('scheduleStudentRows');
    if (t) t.innerHTML = '';
    if (s) s.innerHTML = '';
    const teachers = (session && session.teachers) || [];
    const students = (session && session.students) || [];
    if (teachers.length) teachers.forEach(addTeacherRow); else addTeacherRow();
    if (students.length) students.forEach(addStudentRow); else addStudentRow();
    renderAuditInfo(session);
}

/** 编辑态展示创建人 / 创建时间 / 最后修改人 / 最后修改时间（只读，原表只有时间没有人） */
export function renderAuditInfo(session) {
    const box = $('scheduleAuditInfo');
    if (!box) return;
    if (!session || !session.id) {
        box.style.display = 'none';
        box.textContent = '';
        return;
    }
    const fmt = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '—');
    // 两行：「创建人 · 创建时间」一行，「最后修改人 · 最后修改时间」一行。
    // 拼成一长排会在窄弹窗里折成四段、读不出归属，所以这里用 \n 断行，
    // 由 .pair-audit 的 white-space: pre-line 负责渲染成两行。
    box.textContent = [
        `创建人：${session.created_by_name || '—'}　·　创建时间：${fmt(session.created_at)}`,
        `最后修改人：${session.updated_by_name || '—'}　·　最后修改时间：${fmt(session.updated_at)}`
    ].join('\n');
    box.style.display = 'block';
}

const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

/**
 * 读取表单里的 pair 数组。
 * @returns {{teachers: object[], students: object[], error: string|null}}
 */
export function collectPairs() {
    const teachers = [];
    const students = [];

    document.querySelectorAll('#scheduleTeacherRows .pair-row').forEach(row => {
        const teacherId = numOrNull(row.querySelector('.pair-teacher')?.value);
        const typeId = numOrNull(row.querySelector('.pair-type')?.value);
        if (teacherId === null || typeId === null) return;   // 未选完的行忽略
        const catEl = row.querySelector('.pair-category');
        const catRo = row.querySelector('.pair-category-readonly');
        teachers.push({
            uid: row.dataset.uid || undefined,
            teacher_id: teacherId,
            type_id: typeId,
            // adjusted 只读回传，服务端会忽略请求里的 adjusted 并降级为 normal，
            // 真正保住类别位的是「状态切换只换后缀」这条规则
            category: catRo ? 'adjusted' : (catEl ? catEl.value : 'normal'),
            lifecycle: row.querySelector('.pair-lifecycle')?.value || 'pending'
        });
    });

    document.querySelectorAll('#scheduleStudentRows .pair-row').forEach(row => {
        const studentId = numOrNull(row.querySelector('.pair-student')?.value);
        if (studentId === null) return;
        students.push({
            uid: row.dataset.uid || undefined,
            student_id: studentId
        });
    });

    // 前端先拦一次（数据库的 validate_session_teachers 会兜底）：
    // 活跃 pair 内 teacher_id 不得重复；学生不得重复。
    const activeTeacherIds = teachers
        .filter(t => !['cancelled', 'modified_away'].includes(t.lifecycle))
        .map(t => t.teacher_id);
    let error = null;
    if (teachers.length === 0) error = '至少需要一位教师（并选好课程类型）';
    else if (students.length === 0) error = '至少需要一位学生';
    else if (new Set(activeTeacherIds).size !== activeTeacherIds.length) error = '同一场课里同一位老师只能出现一次';
    else if (new Set(students.map(s => s.student_id)).size !== students.length) error = '同一场课里同一位学生只能出现一次';

    return { teachers, students, error };
}

export { LIFECYCLE_LABELS, CATEGORY_LABELS };
