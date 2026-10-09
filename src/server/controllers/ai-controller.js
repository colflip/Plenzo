const logger = require('../utils/logger.js');
/**
 * AI 控制器 (AI Controller) - 全新重构版本
 * @description 处理 AI 相关请求：数据查询、智能排课
 * @module controllers/aiController
 */

const { successResponse, errorResponse } = require('../utils/response');
const { AppError, asyncHandler, normalizeError } = require('../middleware/error');
const aiService = require('../services/ai-service');
const db = require('../db/db');
const scheduleService = require('../services/schedule-service');
const aiConfigService = require('../services/ai-config-service');
const courseSessionService = require('../services/course-session-service');
const FeeService = require('../services/fee-service');
const { resolveAutoFeeStatus } = require('../utils/fee-status');
const fs = require('fs');
const path = require('path');

/**
 * AI 功能状态检查
 * GET /api/ai/status
 */
const getStatus = (req, res) => {
    // 暴露 LLM 护栏指标，便于线上判断「谁/哪个 provider 在吃配额、是否被限流」
    const metrics = aiService.llmMetrics ? aiService.llmMetrics.snapshot() : null;
    // lastError 只对管理员可见：里面是失败的上游状态码/错误码，属运维诊断而非用户信息，
    // 而本端点对所有登录角色开放（AI 助手用它做可用性判断）。
    const isAdmin = req.user && req.user.userType === 'admin';
    const safeMetrics = metrics && !isAdmin
        ? { ...metrics, lastError: null }
        : metrics;
    res.json(successResponse({
        enabled: aiService.isAvailable(),
        provider: aiService.getAIConfig().provider,
        role: req.user?.userType,
        llmMetrics: safeMetrics
    }, { requestId: req.requestId }));
};

/**
 * 状态的中英文映射（统一使用 sharedUtils.STATUS_MAP 作为权威来源）
 */
const { STATUS_MAP: STATUS_MAPPING, getStatusLabel: translateStatus, splitStatus,
    toDateKey, normTime, slotKeyOf } = require('../utils/shared-utils');
const { requiresOwnDataScope, canTouchRecord } = require('../utils/admin-permissions');
const aiOperationStore = require('../services/ai-operation-store');

/**
 * 课程类型映射缓存。缓存的是 **Promise** 而不是结果值 ——
 * 只缓存结果时，在 Promise.all 里并发调用会让每一行都看到空缓存，
 * 于是并发发出几十条完全一样的 `SELECT name, description FROM schedule_types`
 * （实测最多 50 条），在连接池小的环境下会把真正的业务查询挤掉。
 */
let courseTypePromise = null;

/**
 * 从数据库加载课程类型映射
 */
function loadCourseTypeMapping() {
    if (courseTypePromise) return courseTypePromise;
    courseTypePromise = db.query('SELECT name, description FROM schedule_types ORDER BY id;')
        .then(result => {
            const map = {};
            (result.rows || []).forEach(row => { map[row.name] = row.description; });
            return map;
        })
        .catch(error => {
            // 失败不固化结果，下次调用可以重新查询，但当前请求必须看到真实故障。
            courseTypePromise = null;
            throw error;
        });
    return courseTypePromise;
}

/**
 * 翻译课程类型（从数据库）
 */
async function translateCourseType(type) {
    const mapping = await loadCourseTypeMapping();
    return mapping[type] || type;
}

/**
 * 「记录」类课程（评审记录 / 咨询记录 及其线上变体）。
 * 判定同时看 slug 与中文名：库里有 slug 记作 review_record，也有记作中文名的历史行。
 */
function isRecordCourseType(type) {
    const name = String((type && type.name) || '');
    const desc = String((type && type.description) || '');
    return /(^|_)record(_|$)/.test(name) || desc.includes('记录');
}

/** 同一场课的教师合并成一段显示：普通教师在前，记录教师在后并标「（记录）」 */
function formatTeacherDisplay(teachers) {
    const regular = teachers.filter(t => !t.is_record).map(t => t.teacher_name);
    const record = teachers.filter(t => t.is_record).map(t => `${t.teacher_name}（记录）`);
    return [...regular, ...record].join('、');
}

/**
 * v_session_pairs 的交叉积（教师 pair × 学生 pair）折回「一场课一条」。
 * 一场课是一个整体：日期/时间/地点在头部，教师与学生各是带 uid 的名册，
 * 列表与预览都按这一条呈现，不再按教师或学生拆成多行。
 */
function collapsePairsToSessions(rows) {
    const byId = new Map();
    for (const r of rows || []) {
        const id = Number(r.session_id != null ? r.session_id : r.id);
        let session = byId.get(id);
        if (!session) {
            session = {
                id,
                class_date: r.class_date,
                start_time: r.start_time,
                end_time: r.end_time,
                location: r.location,
                notes: r.notes,
                created_by: r.created_by,
                transport_fee: r.transport_fee,
                other_fee: r.other_fee,
                teachers: [],
                students: []
            };
            byId.set(id, session);
        }
        const tUid = String(r.teacher_uid);
        if (!session.teachers.some(t => t.uid === tUid)) {
            session.teachers.push({
                uid: tUid,
                teacher_id: r.teacher_id,
                teacher_name: r.teacher_name,
                course_type: r.course_type,
                course_type_cn: r.course_type_cn,
                course_type_id: r.course_type_id,
                status: r.status,
                status_code: r.status_code,
                is_record: isRecordCourseType({ name: r.course_type, description: r.course_type_cn })
            });
        }
        const sUid = String(r.student_uid);
        if (!session.students.some(s => s.uid === sUid)) {
            session.students.push({
                uid: sUid,
                student_id: r.student_id,
                student_name: r.student_name,
                family_participants: r.family_participants
            });
        }
    }
    return [...byId.values()].map(session => ({
        ...session,
        teacher_uids: session.teachers.map(t => t.uid),
        teacher_display: formatTeacherDisplay(session.teachers),
        student_display: session.students.map(s => s.student_name).join('、'),
        course_type_cn: [...new Set(session.teachers.map(t => t.course_type_cn))].join('、'),
        active_teachers: session.teachers.filter(t => courseSessionService.isActive(t.status_code))
    }));
}

/**
 * 教师名册的生效值（预览与确认共用同一套口径）。
 * - 给了 fields.teachers：整场替换，uid 命中的沿用、没带 uid 的是新增、原名册里没出现的将被移出。
 * - 只给了 fields.courseType：改类型，命中 teacherUid 就改那一位，没命中就是本场全部在职教师。
 * - 两者都没给：名册原样。
 */
function effectiveTeacherRoster(session, fields, refs) {
    const current = session.teachers;
    const onlyUid = fields.teacherUid != null ? String(fields.teacherUid) : null;

    if (Array.isArray(fields.teachers)) {
        return fields.teachers.map(entry => {
            const keep = entry && entry.teacherUid != null
                ? current.find(t => String(t.uid) === String(entry.teacherUid)) : null;
            const typeName = (entry && entry.courseType) || (keep && keep.course_type);
            if (!typeName) {
                throw new AppError({ code: 'BAD_REQUEST', message: `新增教师 ${entry && entry.teacherId} 缺少课程类型` });
            }
            const type = refs.typeByName[typeName];
            if (!type) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `课程类型 ${typeName} 不存在` });
            const person = refs.teacherById[entry.teacherId] || (keep && { name: keep.teacher_name });
            if (!person) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `教师 ID ${entry.teacherId} 不存在` });
            return {
                uid: keep ? keep.uid : null,
                teacher_id: Number(entry.teacherId),
                teacher_name: person.name,
                course_type: type.name,
                course_type_id: type.id,
                course_type_cn: type.description || type.name,
                is_record: isRecordCourseType(type),
                status_code: keep ? keep.status_code : 'normal.confirmed'
            };
        });
    }

    if (fields.courseType) {
        const type = refs.typeByName[fields.courseType];
        if (!type) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `课程类型 ${fields.courseType} 不存在` });
        return current.map(t => {
            const hit = !onlyUid || (String(t.uid) === onlyUid && courseSessionService.isActive(t.status_code));
            return hit
                ? { ...t, course_type: type.name, course_type_id: type.id, course_type_cn: type.description || type.name, is_record: isRecordCourseType(type) }
                : t;
        });
    }

    return current;
}

/** 学生名册的生效值，规则与 effectiveTeacherRoster 一致（家长人数可整场或只改指名那位） */
function effectiveStudentRoster(session, fields, refs) {
    const current = session.students;
    const onlyUid = fields.studentUid != null ? String(fields.studentUid) : null;

    if (Array.isArray(fields.students)) {
        return fields.students.map(entry => {
            const keep = entry && entry.studentUid != null
                ? current.find(s => String(s.uid) === String(entry.studentUid)) : null;
            const person = refs.studentById[entry.studentId] || (keep && { name: keep.student_name });
            if (!person) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `学生 ID ${entry.studentId} 不存在` });
            const fam = entry.familyParticipants != null ? entry.familyParticipants
                : (keep ? keep.family_participants : null);
            return {
                uid: keep ? keep.uid : null,
                student_id: Number(entry.studentId),
                student_name: person.name,
                family_participants: fam != null ? Number(fam) : null
            };
        });
    }

    if (fields.familyParticipants !== undefined) {
        return current.map(s => {
            const hit = !onlyUid || String(s.uid) === onlyUid;
            return hit ? { ...s, family_participants: Number(fields.familyParticipants) } : s;
        });
    }

    return current;
}

/**
 * 一批预览内部的相互冲突（同一位教师或同一位学生在这批里被排进两个重叠时段）。
 * findConflictsBatch 只比对库里已有的场次，批内互撞要在这里单独抓 ——
 * 用户一口气写九行，两行如果解析成同一个时段，就该在这里被拦住。
 * 时段归一与键的算法复用 schedule-service 那一份，不在这里再写一遍。
 * @returns {Array<{keys:string[], text:string}>} keys 是涉及的时段键（shared-utils 的 slotKeyOf）
 */
function collectSelfConflicts(groups = []) {
    const flat = [];
    groups.forEach(g => (g.slots || []).forEach(slot => flat.push({
        key: slotKeyOf(slot.date, slot.startTime, slot.endTime),
        date: String(slot.date).slice(0, 10),
        startTime: normTime(slot.startTime),
        endTime: normTime(slot.endTime),
        teacherIds: (g.teachers || []).map(t => Number(t.teacher_id)),
        teacherNames: (g.teachers || []).map(t => t.teacher_name || t.teacher_id),
        studentIds: (g.students || []).map(s => Number(s.student_id)),
        studentNames: (g.students || []).map(s => s.student_name || s.student_id)
    })));

    const found = [];
    for (let a = 0; a < flat.length; a++) {
        for (let b = a + 1; b < flat.length; b++) {
            const A = flat[a], B = flat[b];
            if (A.date !== B.date) continue;
            if (!(A.startTime < B.endTime && B.startTime < A.endTime)) continue;
            const sharedTeacher = A.teacherIds.filter(id => B.teacherIds.includes(id))[0];
            const sharedStudent = A.studentIds.filter(id => B.studentIds.includes(id))[0];
            if (sharedTeacher != null) {
                const name = A.teacherNames[A.teacherIds.indexOf(sharedTeacher)];
                found.push({
                    keys: [A.key, B.key],
                    text: `本批内部：教师${name} 在 ${A.date} 被排进两个重叠时段（${A.startTime}-${A.endTime} 与 ${B.startTime}-${B.endTime}）`
                });
            }
            if (sharedStudent != null) {
                const name = A.studentNames[A.studentIds.indexOf(sharedStudent)];
                found.push({
                    keys: [A.key, B.key],
                    text: `本批内部：学生${name} 在 ${A.date} 被排进两个重叠时段（${A.startTime}-${A.endTime} 与 ${B.startTime}-${B.endTime}）`
                });
            }
        }
    }
    // 同一对时段可能既撞教师又撞学生，文案各留一条；但同一组 (keys,text) 重复出现要去掉
    const seen = new Set();
    return found.filter(f => {
        const sig = `${f.keys.join('+')}|${f.text}`;
        if (seen.has(sig)) return false;
        seen.add(sig);
        return true;
    });
}

/**
 * 时段冲突 → 标在预览行上（新建预览与编辑预览共用这一份文案与分组口径，不各写一套）。
 *
 * 只标不拦：同一位教师/学生出现在时间重叠的两节课里是合法业务，写入照过，
 * 这里负责让人（和模型）在点确认之前看见撞了谁、被哪一场占着。
 * @param {Array<Object>} rows 预览行，就地写入 row.conflicts
 * @param {Array} conflicts findConflictsBatch 的结果
 * @param {(kind:string,id:number)=>string} nameOf 人名解析
 * @param {Array<{keys:string[],text:string}>} [selfConflicts] 批内互撞
 * @param {(row:Object)=>string} [keyOf] 行 → 时段键；默认用行自己的 class_date/start_time/end_time，
 *        编辑预览要传「改完之后」的时段，否则标不到行上。
 * @returns {number} 去重后的冲突条数
 */
function markRowConflicts(rows, conflicts, nameOf, selfConflicts = [], keyOf = null) {
    const bySlot = new Map();
    const push = (key, text) => {
        if (!bySlot.has(key)) bySlot.set(key, []);
        bySlot.get(key).push(text);
    };
    for (const c of conflicts || []) {
        // 文案唯一实现在 schedule-service（describeConflicts 也走它），这里只提供内存里已有的名字
        push(slotKeyOf(c.date, c.startTime, c.endTime), scheduleService.formatConflictLine(c, nameOf));
    }
    for (const f of selfConflicts || []) f.keys.forEach(key => push(key, f.text));

    const rowKey = keyOf || ((row) => slotKeyOf(row.class_date, row.start_time, row.end_time));
    (rows || []).forEach(row => {
        row.conflicts = bySlot.get(rowKey(row)) || [];
    });
    return new Set((rows || []).flatMap(r => r.conflicts)).size;
}

/**
 * 预览/列表用的一行：一场课一条记录，教师与学生按整场名册合并显示。
 * 保留 teacher_name / student_name / course_type_cn 这些旧键名，前端表格因此不必改读取方式。
 */
function toMergedDisplayRow(session, teachers, students) {
    const active = teachers.filter(t => courseSessionService.isActive(t.status_code));
    const chosen = active.length ? active : teachers;
    const lifecycles = [...new Set(chosen.map(t => splitStatus(t.status_code || 'normal.pending').lifecycle))];
    // 一场课的状态就是这一场：各位教师状态一致就照实写，不一致时不替用户挑一位（那会显示成
    // 「已确认」而实际还有人待确认），如实标成多种状态。
    const status = lifecycles.length === 1 ? lifecycles[0] : (lifecycles.length > 1 ? 'mixed' : null);
    return {
        ...session,
        session_id: session.id,
        day_of_week: getDayOfWeek(session.class_date),
        teachers, students,
        teacher_ids: teachers.map(t => t.teacher_id),
        student_ids: students.map(s => s.student_id),
        teacher_name: formatTeacherDisplay(teachers),
        student_name: students.map(s => s.student_name).join('、'),
        course_type_cn: [...new Set(teachers.map(t => t.course_type_cn))].join('、'),
        status,
        status_cn: status ? (status === 'mixed' ? '多种状态' : translateStatus(status)) : ''
    };
}

/**
 * 获取日期对应的星期几（中文）
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} 周一~周日
 */
function getDayOfWeek(dateStr) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    // 用 UTC 分量做纯日历运算，避免进程时区（Vercel/Render 默认 UTC）把
    // "上海零点(+08:00)" 算回前一天而使星期整体 -1。
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return days[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * 时间计算辅助函数：给时间字符串加 N 小时
 * @param {string} timeStr - HH:MM:SS
 * @param {number} hours - 小时数
 * @returns {string} HH:MM:SS
 */
function addHours(timeStr, hours) {
    const [h, m, s] = timeStr.split(':').map(Number);
    const totalMinutes = h * 60 + m + hours * 60;
    const newH = Math.floor(totalMinutes / 60);
    const newM = totalMinutes % 60;
    return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}:${String(s || 0).padStart(2, '0')}`;
}

/**
 * 计算东八区的完整日期上下文（今天、本周/下周每天的具体日期映射）。
 * 抽为模块级函数，供 query 主流程与 resolve_datetime 工具共用，避免逻辑重复与漂移。
 * @returns {Object} { todayStr, currentWeekDay, currentDateTime, thisWeek, nextWeek, thisWeekDateMap, nextWeekDateMap }
 */
function computeDateContext() {
    const now = new Date();
    // 先取上海时区的“今天”字符串（正确的 YYYY-MM-DD），再基于它做纯日历运算。
    // 关键：不要 new Date(now.toLocaleString(...)) —— 那会把上海钟点数按进程本地时区
    // 二次解析，在 UTC 进程 + 上海晚上(>=16点)时整周日期会 +1 天。
    const todayStr = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const currentDateTime = now.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });

    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const cnDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    // 用 UTC 锚定当天，纯日历加减不受进程时区影响
    const [y, m, d] = todayStr.split('-').map(Number);
    const base = new Date(Date.UTC(y, m - 1, d));
    const dayOfWeek = base.getUTCDay(); // 0=周日, 1=周一
    const currentWeekDay = weekDays[dayOfWeek];

    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const thisMonday = new Date(base);
    thisMonday.setUTCDate(base.getUTCDate() + mondayOffset);
    const nextMonday = new Date(thisMonday);
    nextMonday.setUTCDate(thisMonday.getUTCDate() + 7);

    const buildWeek = (monday) => {
        const map = {};
        for (let i = 0; i < 7; i++) {
            const dd = new Date(monday);
            dd.setUTCDate(monday.getUTCDate() + i);
            map[cnDays[i]] = dd.toISOString().slice(0, 10);
        }
        return map;
    };

    const thisWeek = buildWeek(thisMonday);
    const nextWeek = buildWeek(nextMonday);
    const fmt = (m) => Object.entries(m).map(([k, v]) => `${k}=${v}`).join(' | ');

    return {
        todayStr, currentWeekDay, currentDateTime,
        thisWeek, nextWeek,
        thisWeekDateMap: fmt(thisWeek),
        nextWeekDateMap: fmt(nextWeek)
    };
}

/**
 * 默认时段（可覆盖）：晚上/下午/上午 → 起止时间
 */
const DEFAULT_PERIODS = {
    上午: { startTime: '09:00:00', endTime: '12:00:00' },
    下午: { startTime: '14:00:00', endTime: '17:00:00' },
    晚上: { startTime: '19:00:00', endTime: '21:30:00' }
};

/**
 * 把「几点」的中文/数字解析为 HH:MM:SS。支持 "19" / "19:30" / "7点" / "一点" / "一" / "14:00:00"。
 * @param {string|number} raw - 时间表述
 * @param {string} [period] - 时段上下文（'上午'/'下午'/'晚上'），用于 12 小时制归一化：
 *                            下午/晚上的 1~11 点补 +12（如"下午一点"→13:00），上午保持原样。
 * @returns {string|null}
 */
function parseClock(raw, period) {
    if (raw === null || raw === undefined) return null;
    let s = String(raw).trim();
    if (!s) return null;

    // 根据时段把 12 小时制的小时数归一到 24 小时制
    const applyPeriod = (h) => {
        if ((period === '下午' || period === '晚上') && h >= 1 && h <= 11) return h + 12;
        return h;
    };

    // 已是 HH:MM 或 HH:MM:SS（视为 24 小时制，不再归一）
    let m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (m) {
        const h = Math.min(23, parseInt(m[1], 10));
        return `${String(h).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
    }

    const cnNum = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
    // 中文数字 / 数字 + 可选「点」+ 可选「半」——「点」不再强制（支持区间里的裸数字"一""三"）
    m = s.match(/^([一二两三四五六七八九十]+|\d{1,2})\s*点?(半)?$/);
    if (m) {
        let h = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : cnNum[m[1]];
        if (h === undefined) return null;
        h = applyPeriod(h);
        h = Math.min(23, h);
        const min = m[2] ? '30' : '00';
        return `${String(h).padStart(2, '0')}:${min}:00`;
    }
    return null;
}

/**
 * 【确定性时间解析】把自然语言排课时间描述解析为精确的 date / startTime / endTime。
 * 由后端代码计算，模型不再自行推算日期（批量排课头号错误源）。
 *
 * @param {string} text - 如 "下周四晚上"、"周六下午一点到三点"、"周一晚上19-22"
 * @returns {Object} { date, startTime, endTime, dayOfWeek, matched, warnings }
 */
function resolveDateTime(text) {
    const ctx = computeDateContext();
    const warnings = [];
    const src = String(text || '').trim();

    // 1) 解析星期 + 本周/下周
    const dayMap = { 一: '周一', 二: '周二', 三: '周三', 四: '周四', 五: '周五', 六: '周六', 日: '周日', 天: '周日' };
    let targetWeek = ctx.thisWeek;
    let weekLabel = '本周';
    if (/下\s*周|下\s*个?\s*星期|下\s*礼拜/.test(src)) { targetWeek = ctx.nextWeek; weekLabel = '下周'; }
    else if (/本\s*周|这\s*周|这\s*个?\s*星期|本\s*礼拜/.test(src)) { targetWeek = ctx.thisWeek; weekLabel = '本周'; }

    let date = null;
    let dayCn = null;
    const dm = src.match(/(周|星期|礼拜)\s*([一二三四五六日天])/);
    if (dm) {
        dayCn = dayMap[dm[2]];
        date = targetWeek[dayCn] || null;
    } else if (/今天|今日/.test(src)) {
        date = ctx.todayStr; dayCn = ctx.currentWeekDay;
    } else if (/明天|明日/.test(src)) {
        // 今天 + 1
        const d = new Date(ctx.todayStr + 'T00:00:00+08:00');
        d.setDate(d.getDate() + 1);
        date = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        dayCn = getDayOfWeek(date);
    }
    if (!date) warnings.push('未能识别具体日期，请提供"周几"或"本周/下周"');

    // 2) 解析时段 + 具体时间
    let period = null;
    if (/晚上|晚间|夜里/.test(src)) period = '晚上';
    else if (/下午|午后/.test(src)) period = '下午';
    else if (/上午|早上|早晨/.test(src)) period = '上午';

    let startTime = null, endTime = null;
    // 显式区间："19-22" / "15-18点" / "一点到三点" / "一点-三点" / "14:30-15:30"
    // 传入 period 做 12→24 小时归一（"下午一点到三点"→13:00-15:00），24 小时制表述不受影响。
    // 分隔符前允许可选「点」，覆盖"一点-三点"/"一点到三点"等混合写法。
    const rangeMatch = src.match(/([0-9一二两三四五六七八九十]{1,3}(?::\d{2})?)\s*点?\s*(?:[-~]|到|至)\s*([0-9一二两三四五六七八九十]{1,3}(?::\d{2})?)\s*点?/);
    if (rangeMatch) {
        startTime = parseClock(rangeMatch[1], period);
        endTime = parseClock(rangeMatch[2], period);
    }
    if ((!startTime || !endTime) && period) {
        const p = DEFAULT_PERIODS[period];
        startTime = startTime || p.startTime;
        endTime = endTime || p.endTime;
    }
    if (!startTime || !endTime) {
        warnings.push('未能识别具体时间，请提供时段（上午/下午/晚上）或起止时间');
    }

    return {
        date,
        dayOfWeek: dayCn,
        weekLabel,
        period,
        startTime,
        endTime,
        matched: !!(date && startTime && endTime),
        warnings
    };
}

/**
 * 排课预览临时存储（内存）
 * 生产环境应使用 Redis
 */
const schedulePreviewStore = new Map();

/**
 * 敏感操作确认临时存储（内存）
 * 用于存储待确认的删除、修改操作
 * 生产环境应使用 Redis
 */
const pendingOperationStore = new Map();

/** Map 最大条目数，防止内存泄漏 */
const MAX_STORE_SIZE = 500;

/**
 * 清理过期条目并限制 Map 大小
 */
function pruneStore(store) {
    const now = Date.now();
    for (const [key, entry] of store) {
        if (entry && entry.expireAt && now > entry.expireAt) {
            store.delete(key);
        }
    }
    // 如果仍然超过上限，删除最早的条目
    while (store.size > MAX_STORE_SIZE) {
        const firstKey = store.keys().next().value;
        store.delete(firstKey);
    }
}

// 每 5 分钟清理一次
setInterval(() => {
    pruneStore(schedulePreviewStore);
    pruneStore(pendingOperationStore);
}, 5 * 60 * 1000).unref();

/* ============================================================
 * 数据查询工具集（全新设计）
 * ============================================================ */

/**
 * 工具定义（按角色分类）
 */
const DATA_TOOLS = {
    admin: [
        {
            type: 'function',
            function: {
                name: 'query_overview',
                description: '查询系统总览数据：教师总数、学生总数、本月排课数、待确认数',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_schedules',
                description: '查询排课列表，支持按教师、学生、日期范围、状态筛选。' +
                    '返回**一场课一行**：teachers[] / students[] 是本场全部参与者，每位带自己的 uid 与课程类型' +
                    '（一位教师一行记录 = 一个 pair，多位教师同上一场课时他们都在同一行的 teachers[] 里）。' +
                    '改课/删课要针对某一位参与者时，用 teachers[].uid / students[].uid 作为 teacherUid / studentUid 传入。',
                parameters: {
                    type: 'object',
                    properties: {
                        teacherId: { type: 'integer', description: '教师ID' },
                        studentId: { type: 'integer', description: '学生ID' },
                        startDate: { type: 'string', description: 'YYYY-MM-DD' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD' },
                        status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled'], description: '排课状态' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_teachers',
                description: '查询教师列表，返回 id, name, profession, status。可通过姓名模糊搜索教师。',
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'integer', enum: [0, 1], description: '0=禁用 1=启用' },
                        name: { type: 'string', description: '教师姓名（模糊匹配）' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_students',
                description: '查询学生列表，返回 id, name, nickname, profession, status。可通过姓名或昵称模糊搜索学生。',
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'integer', enum: [0, 1], description: '0=禁用 1=启用' },
                        name: { type: 'string', description: '学生姓名（模糊匹配）' },
                        nickname: { type: 'string', description: '学生昵称（模糊匹配）' }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_schedule_stats',
                description: '统计排课数据：按课程类型、教师、学生维度统计',
                parameters: {
                    type: 'object',
                    properties: {
                        dimension: { type: 'string', enum: ['type', 'teacher', 'student'], description: '统计维度' },
                        startDate: { type: 'string', description: 'YYYY-MM-DD' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD' }
                    },
                    required: ['dimension']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'resolve_datetime',
                description: '【排课第一步·强烈推荐】把自然语言时间描述精确解析为 date/startTime/endTime。' +
                    '例如 "下周四晚上"、"周六下午一点到三点"、"周一晚上19-22"。' +
                    '禁止自行推算日期，一律调用此工具获取精确日期时间，再传给 create_schedule_preview。',
                parameters: {
                    type: 'object',
                    properties: {
                        text: { type: 'string', description: '自然语言时间描述，如 "下周四晚上"、"周六下午一点到三点"' }
                    },
                    required: ['text']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'find_available_slots',
                description: '查找教师和学生在指定日期范围内的可用时段。返回可排课的日期和时间段。',
                parameters: {
                    type: 'object',
                    properties: {
                        teacherId: { type: 'integer', description: '教师ID' },
                        studentId: { type: 'integer', description: '学生ID' },
                        startDate: { type: 'string', description: 'YYYY-MM-DD，开始日期' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD，结束日期' },
                        preferredDays: { type: 'array', items: { type: 'integer' }, description: '偏好星期几，1-7（1=周一）' },
                        duration: { type: 'integer', description: '课程时长（小时），默认2' }
                    },
                    required: ['teacherId', 'studentId', 'startDate', 'endDate']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'create_schedule_preview',
                description: '生成排课预览。**一场课 = 一个 group = 一条记录**：group 的 teachers[] 与 students[] ' +
                    '就是这一场课的教师与学生，各 1..N 位都合法（只有一位也是同一个结构，没有单教师写法）。' +
                    '多位教师共同参加同一节课时必须写进同一个 group 的 teachers[]，绝不能按教师拆成多个 group。' +
                    '返回的预览行带 conflicts[]（与现有排课的时段冲突）与 conflictCount，有冲突要如实告知用户。',
                parameters: {
                    type: 'object',
                    properties: {
                        groups: {
                            type: 'array',
                            description: '批量排课分组，一行输入对应一个 group',
                            items: {
                                type: 'object',
                                properties: {
                                    teachers: {
                                        type: 'array',
                                        minItems: 1,
                                        description: '参加这节课的教师（1..N 位）。每位教师带自己的课程类型，' +
                                            '同一场课里可以不同（例如三位评审 + 一位评审记录），这仍是一场课',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                teacherId: { type: 'integer', description: '教师ID' },
                                                courseType: { type: 'string', description: '这位教师在本场课里的课程类型 name 字段' }
                                            },
                                            required: ['teacherId', 'courseType']
                                        }
                                    },
                                    students: {
                                        type: 'array',
                                        minItems: 1,
                                        description: '本场课的学生（1..N 位）',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                studentId: { type: 'integer', description: '学生ID' },
                                                familyParticipants: { type: 'integer', description: '家长参与人数，默认4' }
                                            },
                                            required: ['studentId']
                                        }
                                    },
                                    location: { type: 'string', description: '上课地点' },
                                    slots: {
                                        type: 'array',
                                        description: '同一 group 的多个时段，每个时段一条记录',
                                        items: {
                                            type: 'object',
                                            properties: {
                                                date: { type: 'string', description: 'YYYY-MM-DD' },
                                                startTime: { type: 'string', description: 'HH:MM:SS' },
                                                endTime: { type: 'string', description: 'HH:MM:SS' },
                                                status: { type: 'string', description: '状态：confirmed/pending' }
                                            },
                                            required: ['date', 'startTime', 'endTime']
                                        }
                                    }
                                },
                                required: ['teachers', 'students', 'slots']
                            }
                        }
                    },
                    required: ['groups']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'confirm_schedule_creation',
                description: '确认并批量创建排课。用户确认预览方案后调用此工具。',
                parameters: {
                    type: 'object',
                    properties: {
                        previewId: { type: 'string', description: '预览方案ID' }
                    },
                    required: ['previewId']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'preview_schedule_update',
                description: '【第1步】预览排课修改。一场课是一条记录，里面可以有 1..N 位教师与 1..N 位学生：' +
                    '整场改时间/地点用头部字段；改参与者用 teachers / students 名册（整场替换）；' +
                    '只改某一位教师的那一条用 teacherUid 指名，不指名就是本场全部在职教师。',
                parameters: {
                    type: 'object',
                    properties: {
                        scheduleIds: {
                            type: 'array',
                            items: { type: 'integer' },
                            description: '要修改的排课ID列表（可以是一个或多个）'
                        },
                        fields: {
                            type: 'object',
                            description: '要修改的字段（只需提供要修改的字段）',
                            properties: {
                                teacherUid: { type: 'string', description: '教师 pair 的 uid（形如 "t1"）：只改这一位教师；省略=本场全部在职教师' },
                                studentUid: { type: 'string', description: '学生 pair 的 uid（形如 "s1"）：只改这一位学生；省略=本场全部学生' },
                                teachers: {
                                    type: 'array',
                                    description: '整场教师名册（替换语义：带 teacherUid 的沿用并修改，不带的是新增教师，' +
                                        '名册里没有的现有教师将被移出本场）',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            teacherUid: { type: 'string', description: '现有教师 pair 的 uid；新增教师不要带' },
                                            teacherId: { type: 'integer', description: '教师ID' },
                                            courseType: { type: 'string', description: '这位教师在本场课里的课程类型 name 字段' }
                                        },
                                        required: ['teacherId']
                                    }
                                },
                                students: {
                                    type: 'array',
                                    description: '整场学生名册（替换语义，同 teachers）',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            studentUid: { type: 'string', description: '现有学生 pair 的 uid；新增学生不要带' },
                                            studentId: { type: 'integer', description: '学生ID' },
                                            familyParticipants: { type: 'integer', description: '家长参与人数' }
                                        },
                                        required: ['studentId']
                                    }
                                },
                                classDate: { type: 'string', description: '新日期 YYYY-MM-DD（整场生效）' },
                                startTime: { type: 'string', description: '新开始时间 HH:MM:SS（整场生效）' },
                                endTime: { type: 'string', description: '新结束时间 HH:MM:SS（整场生效）' },
                                status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled', 'completed', 'modified_away'], description: '新状态（作用于指定的 pair；未指名就是本场全部在职 pair）' },
                                courseType: { type: 'string', description: '新课程类型名称（schedule_types.name，如 visit/half_visit/review/review_record/advisory/advisory_record/trial/group_activity）' },
                                familyParticipants: { type: 'integer', description: '家长参与人数（整场或指名那位学生）' },
                                transportFee: { type: 'number', description: '交通费（这趟课只有一位学生时才能改；多位学生同上一趟课时金额要说得清属于谁，请让用户去费用报销页逐位填写）' },
                                otherFee: { type: 'number', description: '其他费用（同 transportFee：多学生场次不支持）' },
                                location: { type: 'string', description: '新地点（如：新课堂、老课堂等，整场生效）' }
                            }
                        }
                    },
                    required: ['scheduleIds', 'fields']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'preview_schedule_deletion',
                description: '【第1步】预览排课删除：查看要删除的排课详情，生成操作ID供确认。' +
                    '不给 teacherUids/studentUids 就是删除整场课；给了就是把这些教师/学生从本场移出（移出最后一位时整场消失）。',
                parameters: {
                    type: 'object',
                    properties: {
                        scheduleIds: {
                            type: 'array',
                            items: { type: 'integer' },
                            description: '要删除的排课ID列表（可以是一个或多个）'
                        },
                        teacherUids: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '只把这些教师 pair（形如 "t1"）移出本场；省略=删除整场'
                        },
                        studentUids: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '只把这些学生 pair（形如 "s1"）移出本场；省略=删除整场'
                        },
                        reason: { type: 'string', description: '删除原因（可选）' }
                    },
                    required: ['scheduleIds']
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'confirm_operation',
                description: '【第2步】确认执行操作：用户确认后，执行预览的修改或删除操作。',
                parameters: {
                    type: 'object',
                    properties: {
                        operationId: { type: 'string', description: '预览操作返回的操作ID' }
                    },
                    required: ['operationId']
                }
            }
        }
    ],
    teacher: [
        {
            type: 'function',
            function: {
                name: 'query_my_overview',
                description: '查询当前教师的总览数据：本周/本月/本年排课数、待处理/已完成/已取消',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_my_schedules',
                description: '查询当前教师的排课列表',
                parameters: {
                    type: 'object',
                    properties: {
                        startDate: { type: 'string', description: 'YYYY-MM-DD' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD' },
                        status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled'] }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_students',
                description: '查询学生列表，返回 id, name, nickname, profession, status。可通过姓名或昵称模糊搜索学生。',
                parameters: {
                    type: 'object',
                    properties: {
                        status: { type: 'integer', enum: [0, 1], description: '0=禁用 1=启用' },
                        name: { type: 'string', description: '学生姓名（模糊匹配）' },
                        nickname: { type: 'string', description: '学生昵称（模糊匹配）' }
                    }
                }
            }
        }
    ],
    student: [
        {
            type: 'function',
            function: {
                name: 'query_my_overview',
                description: '查询当前学生的总览数据：本周/本月/本年课程数、待确认/已完成/已取消',
                parameters: { type: 'object', properties: {} }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_my_schedules',
                description: '查询当前学生的课程列表，支持按日期范围和状态筛选',
                parameters: {
                    type: 'object',
                    properties: {
                        startDate: { type: 'string', description: 'YYYY-MM-DD' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD' },
                        status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled', 'completed'] }
                    }
                }
            }
        },
        {
            type: 'function',
            function: {
                name: 'query_my_statistics',
                description: '查询当前学生的学习统计数据：按课程类型统计、按月统计',
                parameters: {
                    type: 'object',
                    properties: {
                        startDate: { type: 'string', description: 'YYYY-MM-DD，开始日期' },
                        endDate: { type: 'string', description: 'YYYY-MM-DD，结束日期' }
                    }
                }
            }
        }
    ]
};

/**
 * 工具执行逻辑（全新实现）
 */
async function executeDataTool(toolName, args, req) {
    const userType = req.user.userType;


    const userId = req.user.id;

    // 权限落地（Phase 1.5）：L3 操作员的 AI 数据问答仅覆盖自己创建 + 无主存量的排课。
    // 冲突检测/找空闲时段类工具除外（功能上必须看到该师生全部占用，与已批准例外一致）。
    const selfScoped = requiresOwnDataScope(req.user);

    switch (toolName) {
        case 'query_overview': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '权限不足' });

            const scopeSql = selfScoped ? ' AND (created_by=$1 OR created_by IS NULL)' : '';
            const scopeParams = selfScoped ? [userId] : [];
            // 4 个计数压进同一条语句的 subselect：并发也要占 4 条连接，合成一条只花一次往返
            //（bounded 靠 course_sessions 行数限制；month/pending 用 v_session_pairs 展开后
            //   的状态字段，行数上限 = 教师×学生交叉积，库存量安全）
            const r = await db.query(`
                SELECT
                    (SELECT COUNT(*) FROM teachers WHERE status=1) AS teacher_count,
                    (SELECT COUNT(*) FROM students WHERE status=1) AS student_count,
                    (SELECT COUNT(*) FROM v_session_pairs
                      WHERE EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)
                        AND EXTRACT(MONTH FROM class_date)=EXTRACT(MONTH FROM CURRENT_DATE)${scopeSql}) AS month_schedules,
                    (SELECT COUNT(*) FROM v_session_pairs WHERE status='pending'${scopeSql}) AS pending_schedules
            `, scopeParams);
            const row = (r.rows || [])[0] || {};

            return {
                type: 'data_table',
                title: '系统总览',
                data: {
                    teacherCount: parseInt(row.teacher_count || 0),
                    studentCount: parseInt(row.student_count || 0),
                    monthSchedules: parseInt(row.month_schedules || 0),
                    pendingSchedules: parseInt(row.pending_schedules || 0)
                }
            };
        }

        case 'query_schedules': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '权限不足' });

            // 一场课一条记录：把 v_session_pairs 的交叉积折回场次，
            // 教师与学生各是带 uid 的名册 —— 改/删要用 uid 指名本场里的哪一位。
            const fromClause = 'FROM v_session_pairs ca ' +
                       'JOIN teachers t ON ca.teacher_id=t.id ' +
                       'JOIN students s ON ca.student_id=s.id ' +
                       'JOIN schedule_types st ON ca.type_id=st.id';
            let whereClause = ' WHERE 1=1';
            const params = [];
            let paramCount = 1;

            if (args.teacherId) {
                whereClause += ` AND ca.teacher_id=$${paramCount++}`;
                params.push(args.teacherId);
            }
            if (args.studentId) {
                whereClause += ` AND ca.student_id=$${paramCount++}`;
                params.push(args.studentId);
            }
            if (args.startDate) {
                whereClause += ` AND ca.class_date>=$${paramCount++}`;
                params.push(args.startDate);
            }
            if (args.endDate) {
                whereClause += ` AND ca.class_date<=$${paramCount++}`;
                params.push(args.endDate);
            }
            if (args.status) {
                whereClause += ` AND ca.status=$${paramCount++}`;
                params.push(args.status);
            }
            // 权限落地：L3 仅见自己创建 + 无主存量
            if (selfScoped) {
                whereClause += ` AND (ca.created_by=$${paramCount++} OR ca.created_by IS NULL)`;
                params.push(userId);
            }

            // 先按「场」分页取最多 50 个 session_id，再回取这些场的全部 pair。
            // 以前 LIMIT 直接挂在这条交叉积查询上：一场 4 位教师 × 1 位学生就占 4 行，
            // 50 行折完只剩约 12 场，模型据此判断「这门课不存在」—— 静默少返回。
            const pageRows = await db.query(
                `SELECT ca.session_id ${fromClause}${whereClause} ` +
                `GROUP BY ca.session_id ` +
                `ORDER BY max(ca.class_date) DESC, max(ca.start_time) DESC LIMIT 50`,
                params
            );
            const pageSessionIds = pageRows.rows.map(r => r.session_id);
            if (!pageSessionIds.length) {
                return { type: 'schedule_list', title: '排课列表', data: [] };
            }

            let query = 'SELECT ca.session_id, ca.class_date, ca.start_time, ca.end_time, ' +
                       'ca.location, ca.status, ca.status_code, ca.teacher_uid, ca.student_uid, ' +
                       'ca.teacher_id, ca.student_id, ca.type_id AS course_type_id, ' +
                       'ca.transport_fee, ca.other_fee, ca.fee_status, ca.family_participants, ' +
                       't.name as teacher_name, s.name as student_name, ' +
                       'st.name as course_type, st.description as course_type_cn ' +
                       `${fromClause}${whereClause}` +
                       ` AND ca.session_id = ANY($${paramCount++}::int[])` +
                       ' ORDER BY ca.class_date DESC, ca.start_time DESC';

            // 不把 id 清单 push 回 params：分页那条查询已经把同一个数组交出去了，
            // 事后追加会让这条查询多带一个参数（也让断言看到脏的调用记录）
            const result = await db.query(query, [...params, pageSessionIds]);
            const sessions = collapsePairsToSessions(result.rows);

            // 一场课一行：教师/学生名册原样带出（含 uid），状态取本场在职 pair
            return {
                type: 'schedule_list',
                title: '排课列表',
                data: sessions.map(session => {
                    const row = toMergedDisplayRow(session, session.teachers, session.students);
                    return {
                        id: row.id,
                        session_id: row.id,
                        class_date: row.class_date,
                        day_of_week: row.day_of_week,
                        start_time: row.start_time,
                        end_time: row.end_time,
                        location: row.location,
                        teacher_name: row.teacher_name,
                        student_name: row.student_name,
                        course_type_cn: row.course_type_cn,
                        status: row.status,
                        status_cn: row.status_cn,
                        teacher_uids: session.teachers.map(t => t.uid),
                        student_uids: session.students.map(s => s.uid),
                        teachers: session.teachers.map(t => ({
                            uid: t.uid, teacher_id: t.teacher_id, teacher_name: t.teacher_name,
                            course_type: t.course_type, course_type_cn: t.course_type_cn, status: t.status
                        })),
                        students: session.students.map(s => ({
                            uid: s.uid, student_id: s.student_id, student_name: s.student_name,
                            family_participants: s.family_participants
                        }))
                    };
                })
            };
        }

        case 'query_teachers': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '权限不足' });

            let query = 'SELECT id, name, profession, status FROM teachers';
            const params = [];
            const conditions = [];
            let paramCount = 1;

            if (args.status !== undefined) {
                conditions.push(`status=$${paramCount++}`);
                params.push(args.status);
            }

            if (args.name) {
                conditions.push(`name LIKE $${paramCount++}`);
                params.push(`%${args.name}%`);
            }

            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }

            query += ' ORDER BY id';
            const result = await db.query(query, params);

            return {
                type: 'data_table',
                title: '教师列表',
                data: result.rows
            };
        }

        case 'query_students': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '权限不足' });

            let query = 'SELECT id, name, nickname, profession, status FROM students';
            const params = [];
            const conditions = [];
            let paramCount = 1;

            if (args.status !== undefined) {
                conditions.push(`status=$${paramCount++}`);
                params.push(args.status);
            }

            if (args.name) {
                conditions.push(`name LIKE $${paramCount++}`);
                params.push(`%${args.name}%`);
            }

            if (args.nickname) {
                conditions.push(`nickname LIKE $${paramCount++}`);
                params.push(`%${args.nickname}%`);
            }

            if (conditions.length > 0) {
                query += ' WHERE ' + conditions.join(' AND ');
            }

            query += ' ORDER BY id';
            const result = await db.query(query, params);

            return {
                type: 'data_table',
                title: '学生列表',
                data: result.rows
            };
        }

        case 'query_schedule_stats': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '权限不足' });

            const { dimension, startDate, endDate } = args;
            let query, params = [];

            if (dimension === 'type') {
                query = `SELECT st.name as category, COUNT(*) as count
                        FROM v_session_pairs ca
                        JOIN schedule_types st ON ca.type_id=st.id
                        WHERE 1=1`;
            } else if (dimension === 'teacher') {
                query = `SELECT t.name as category, COUNT(*) as count
                        FROM v_session_pairs ca
                        JOIN teachers t ON ca.teacher_id=t.id
                        WHERE 1=1`;
            } else {
                query = `SELECT s.name as category, COUNT(*) as count
                        FROM v_session_pairs ca
                        JOIN students s ON ca.student_id=s.id
                        WHERE 1=1`;
            }

            let paramCount = 1;
            if (startDate) {
                query += ` AND ca.class_date>=$${paramCount++}`;
                params.push(startDate);
            }
            if (endDate) {
                query += ` AND ca.class_date<=$${paramCount++}`;
                params.push(endDate);
            }
            // 权限落地：L3 仅统计自己创建 + 无主存量
            if (selfScoped) {
                query += ` AND (ca.created_by=$${paramCount++} OR ca.created_by IS NULL)`;
                params.push(userId);
            }

            query += ' GROUP BY category ORDER BY count DESC LIMIT 20';
            const result = await db.query(query, params);

            return {
                type: 'chart_data',
                title: `按${dimension === 'type' ? '课程类型' : dimension === 'teacher' ? '教师' : '学生'}统计`,
                data: result.rows
            };
        }

        case 'query_my_overview': {
            if (userType !== 'teacher' && userType !== 'student') throw new AppError({ code: 'FORBIDDEN', message: '仅教师和学生可查询' });

            const idField = userType === 'teacher' ? 'teacher_id' : 'student_id';

            // 6 个计数用一条语句的条件聚合算完（原来是 6 条并发查询，占 6 条连接）
            const r = await db.query(`
                SELECT
                    COUNT(*) FILTER (WHERE class_date >= CURRENT_DATE - 7) AS week_count,
                    COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)
                                       AND EXTRACT(MONTH FROM class_date)=EXTRACT(MONTH FROM CURRENT_DATE)) AS month_count,
                    COUNT(*) FILTER (WHERE EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)) AS year_count,
                    COUNT(*) FILTER (WHERE status='pending') AS pending_count,
                    COUNT(*) FILTER (WHERE status='confirmed') AS confirmed_count,
                    COUNT(*) FILTER (WHERE status='cancelled') AS cancelled_count
                  FROM v_session_pairs WHERE ${idField}=$1
            `, [userId]);
            const row = (r.rows || [])[0] || {};

            return {
                type: 'data_table',
                title: '我的总览',
                data: {
                    weekSchedules: parseInt(row.week_count || 0),
                    monthSchedules: parseInt(row.month_count || 0),
                    yearSchedules: parseInt(row.year_count || 0),
                    pending: parseInt(row.pending_count || 0),
                    confirmed: parseInt(row.confirmed_count || 0),
                    cancelled: parseInt(row.cancelled_count || 0)
                }
            };
        }

        case 'query_my_schedules': {
            if (userType !== 'teacher' && userType !== 'student') throw new AppError({ code: 'FORBIDDEN', message: '仅教师和学生可查询' });

            const idField = userType === 'teacher' ? 'teacher_id' : 'student_id';
            const joinField = userType === 'teacher' ? 's.name as student_name' : 't.name as teacher_name';

            let query = `SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status,
                        ${joinField}, st.name as course_type
                        FROM v_session_pairs ca
                        JOIN teachers t ON ca.teacher_id=t.id
                        JOIN students s ON ca.student_id=s.id
                        JOIN schedule_types st ON ca.type_id=st.id
                        WHERE ca.${idField}=$1`;
            const params = [userId];
            let paramCount = 2;

            if (args.startDate) {
                query += ` AND ca.class_date>=$${paramCount++}`;
                params.push(args.startDate);
            }
            if (args.endDate) {
                query += ` AND ca.class_date<=$${paramCount++}`;
                params.push(args.endDate);
            }
            if (args.status) {
                query += ` AND ca.status=$${paramCount++}`;
                params.push(args.status);
            }

            query += ' ORDER BY ca.class_date DESC, ca.start_time DESC LIMIT 50';
            const result = await db.query(query, params);

            // 翻译课程类型和状态为中文
            const translatedData = await Promise.all(result.rows.map(async row => ({
                ...row,
                course_type_cn: await translateCourseType(row.course_type),
                status_cn: translateStatus(row.status)
            })));

            return {
                type: 'schedule_list',
                title: '我的课程',
                data: translatedData
            };
        }

        case 'query_my_statistics': {
            if (userType !== 'student') throw new AppError({ code: 'FORBIDDEN', message: '仅学生可查询学习统计' });

            // 默认查询最近3个月
            const startDate = args.startDate || new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString().split('T')[0];
            const endDate = args.endDate || new Date().toISOString().split('T')[0];

            const [typeStats, monthlyStats] = await Promise.all([
                db.query(`SELECT st.name as category, st.description as category_cn, COUNT(*) as count
                    FROM v_session_pairs ca
                    JOIN schedule_types st ON ca.type_id=st.id
                    WHERE ca.student_id=$1 AND ca.class_date>=$2 AND ca.class_date<=$3
                    GROUP BY st.name, st.description ORDER BY count DESC`, [userId, startDate, endDate]),
                db.query(`SELECT TO_CHAR(ca.class_date, 'YYYY-MM') as month, COUNT(*) as count
                    FROM v_session_pairs ca
                    WHERE ca.student_id=$1 AND ca.class_date>=$2 AND ca.class_date<=$3
                    GROUP BY month ORDER BY month`, [userId, startDate, endDate])
            ]);

            // 课程类型归一化：大评审 等同 评审（与管理端/教师端/学生端统计口径一致）
            const REVIEW_ALIASES = ['大评审', '大評審', 'big_review', 'bigreview'];
            const isReviewAlias = (l) => {
                const s = String(l == null ? '' : l).trim();
                return REVIEW_ALIASES.includes(s) || REVIEW_ALIASES.includes(s.toLowerCase());
            };
            const mergedTypeStats = [];
            const typeMap = new Map();
            (typeStats.rows || []).forEach(r => {
                const cn = r.category_cn || r.category || '未分类';
                const key = isReviewAlias(cn) ? '评审' : cn;
                if (!typeMap.has(key)) {
                    const entry = { category: key, category_cn: key, count: 0 };
                    typeMap.set(key, entry);
                    mergedTypeStats.push(entry);
                }
                typeMap.get(key).count += parseInt(r.count, 10) || 0;
            });

            return {
                type: 'chart_data',
                title: '学习统计',
                data: {
                    typeStats: mergedTypeStats,
                    monthlyStats: monthlyStats.rows,
                    period: { startDate, endDate }
                }
            };
        }

        case 'resolve_datetime': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '仅管理员可解析排课时间' });
            const parsed = resolveDateTime(args.text || '');
            const note = parsed.warnings && parsed.warnings.length > 0 ? parsed.warnings.join('；') : '';
            return {
                type: 'data_table',
                title: '时间解析',
                data: {
                    input: args.text || '',
                    resolved: parsed.matched,
                    date: parsed.date,
                    dayOfWeek: parsed.dayOfWeek,
                    weekLabel: parsed.weekLabel,
                    startTime: parsed.startTime,
                    endTime: parsed.endTime,
                    note: note || (parsed.matched ? '' : '解析不完整，请向用户确认缺失信息，不要臆造')
                }
            };
        }

        case 'find_available_slots': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '仅管理员可查找时段' });

            const { teacherId, studentId, startDate, endDate, preferredDays, duration = 2 } = args;

            // 三条都只依赖入参，一起发（已有排课的查询原来排在两个校验之后，白等一次往返）
            const [teacher, student, existingSchedules] = await Promise.all([
                db.query('SELECT id, name FROM teachers WHERE id=$1 AND status=1', [teacherId]),
                db.query('SELECT id, name FROM students WHERE id=$1 AND status=1', [studentId]),
                db.query(
                    `SELECT class_date, start_time, end_time
                     FROM v_session_pairs
                     WHERE (teacher_id=$1 OR student_id=$2)
                     AND class_date BETWEEN $3 AND $4
                     AND ${courseSessionService.sqlActivePair(null)}
                     ORDER BY class_date, start_time`,
                    [teacherId, studentId, startDate, endDate]
                )
            ]);

            if (teacher.rows.length === 0) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `教师 ID ${teacherId} 不存在或已禁用` });
            if (student.rows.length === 0) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `学生 ID ${studentId} 不存在或已禁用` });

            // 生成日期范围
            // 两端都按本地日历日构造与比较（ISO 日期字符串天然有序）。以前用 new Date('2026-10-11')
            // 会被当成 UTC 零点，在 +08:00 上与本地 getDay()/toISOString() 混用，星期和日期各错位一次。
            const dayCursor = new Date(`${startDate}T00:00:00`);
            const availableSlots = [];

            // 工作时间段定义（可配置）
            const workingHours = [
                { start: '09:00:00', end: '12:00:00' },
                { start: '14:00:00', end: '18:00:00' },
                { start: '19:00:00', end: '22:00:00' }
            ];

            for (let d = dayCursor; toDateKey(d) <= String(endDate).slice(0, 10); d.setDate(d.getDate() + 1)) {
                const dateStr = toDateKey(d);
                const dayOfWeek = d.getDay() === 0 ? 7 : d.getDay(); // 转换为 1-7

                // 如果指定了偏好星期，跳过非偏好日期
                if (preferredDays && preferredDays.length > 0 && !preferredDays.includes(dayOfWeek)) {
                    continue;
                }

                // 该日期的已有排课
                const daySchedules = existingSchedules.rows.filter(s =>
                    toDateKey(s.class_date) === dateStr
                );

                // 检查每个工作时间段
                for (const period of workingHours) {
                    const slotStart = period.start;
                    const slotEnd = addHours(period.start, duration);

                    // 检查时长是否超出工作时段
                    if (slotEnd > period.end) continue;

                    // 检查是否与已有排课冲突
                    const hasConflict = daySchedules.some(sch => {
                        return !(slotEnd <= sch.start_time || slotStart >= sch.end_time);
                    });

                    if (!hasConflict) {
                        availableSlots.push({
                            date: dateStr,
                            startTime: slotStart,
                            endTime: slotEnd,
                            dayOfWeek: dayOfWeek
                        });
                    }
                }
            }

            return {
                type: 'data_table',
                title: '可用时段',
                data: {
                    teacher: teacher.rows[0].name,
                    student: student.rows[0].name,
                    totalSlots: availableSlots.length,
                    slots: availableSlots.slice(0, 20)  // 最多返回20个
                }
            };
        }

        case 'create_schedule_preview': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '仅管理员可创建排课' });

            const { groups } = args;
            if (!Array.isArray(groups) || groups.length === 0) {
                throw new AppError({ code: 'BAD_REQUEST', message: '请提供 groups（一行输入对应一个 group）' });
            }

            // 一场课 = 一个 group = 一行：teachers/students 都是 pair 数组，1..N 位同一形状，
            // 只有一位教师或一位学生也走这个结构，没有单数写法。
            const normalizedGroups = groups.map(g => ({
                teachers: Array.isArray(g && g.teachers) ? g.teachers : [],
                students: Array.isArray(g && g.students) ? g.students : [],
                location: (g && g.location) || null,
                slots: (g && Array.isArray(g.slots)) ? g.slots : []
            }));

            // 收集所有唯一ID，批量预加载（避免 N+1 查询）
            const allTeacherIds = [...new Set(normalizedGroups.flatMap(g => g.teachers.map(t => t.teacherId)))];
            const allStudentIds = [...new Set(normalizedGroups.flatMap(g => g.students.map(s => s.studentId)))];
            const courseTypeNames = [...new Set(normalizedGroups.flatMap(g => g.teachers.map(t => t.courseType)))];

            const [teachersResult, studentsResult, courseTypesResult] = await Promise.all([
                allTeacherIds.length ? db.query('SELECT id, name FROM teachers WHERE id=ANY($1) AND status=1', [allTeacherIds]) : { rows: [] },
                allStudentIds.length ? db.query('SELECT id, name FROM students WHERE id=ANY($1) AND status=1', [allStudentIds]) : { rows: [] },
                courseTypeNames.length ? db.query('SELECT id, name, description FROM schedule_types WHERE name=ANY($1)', [courseTypeNames]) : { rows: [] }
            ]);

            const teacherMap = Object.fromEntries(teachersResult.rows.map(r => [r.id, r]));
            const studentMap = Object.fromEntries(studentsResult.rows.map(r => [r.id, r]));
            const courseTypeMap = Object.fromEntries(courseTypesResult.rows.map(r => [r.name, r]));

            // 验证并收集所有排课数据
            const allSchedules = [];
            const previewGroups = [];

            for (const [index, group] of normalizedGroups.entries()) {
                const { teachers: teacherIn, students: studentIn, location, slots } = group;
                // 漏一项就明确报错，不能静默跳过 —— 用户的每一行都必须有着落（R5 忠实执行）
                if (!teacherIn.length) {
                    throw new AppError({ code: 'BAD_REQUEST', message: `第 ${index + 1} 场课缺少 teachers（每位教师给 teacherId + courseType）` });
                }
                if (!studentIn.length) {
                    throw new AppError({ code: 'BAD_REQUEST', message: `第 ${index + 1} 场课缺少 students` });
                }
                if (!slots.length) {
                    throw new AppError({ code: 'BAD_REQUEST', message: `第 ${index + 1} 场课缺少 slots` });
                }

                for (const s of studentIn) {
                    if (!s || s.studentId == null) {
                        throw new AppError({ code: 'BAD_REQUEST', message: `第 ${index + 1} 场课的学生条目缺少 studentId` });
                    }
                    if (!studentMap[s.studentId]) {
                        throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `学生 ID ${s.studentId} 不存在或已禁用` });
                    }
                }
                for (const t of teacherIn) {
                    if (!t || t.teacherId == null || !t.courseType) {
                        throw new AppError({
                            code: 'BAD_REQUEST',
                            message: `第 ${index + 1} 场课的教师条目不完整（每位教师都要给 teacherId 与 courseType）`
                        });
                    }
                    if (!teacherMap[t.teacherId]) {
                        throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `教师 ID ${t.teacherId} 不存在或已禁用` });
                    }
                    if (!courseTypeMap[t.courseType]) {
                        throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `课程类型 ${t.courseType} 不存在` });
                    }
                }

                // 每位教师带自己的课程类型：一场课里「评审 + 评审记录」共存，仍然是一条记录
                const teachers = teacherIn.map(t => {
                    const type = courseTypeMap[t.courseType];
                    return {
                        teacher_id: t.teacherId,
                        teacher_name: teacherMap[t.teacherId].name,
                        course_type_id: type.id,
                        course_type_cn: type.description || type.name,
                        is_record: isRecordCourseType(type)
                    };
                });
                const students = studentIn.map(s => ({
                    student_id: s.studentId,
                    student_name: studentMap[s.studentId].name,
                    family_participants: s.familyParticipants != null ? s.familyParticipants : null
                }));

                previewGroups.push({ teachers, students, location, slots });

                // 一个 group+slot 一行预览：整场课的全部教师/学生合并显示
                for (const slot of slots) {
                    allSchedules.push({
                        class_date: slot.date,
                        day_of_week: getDayOfWeek(slot.date),
                        start_time: slot.startTime,
                        end_time: slot.endTime,
                        location: location || null,
                        teachers, students,
                        teacher_ids: teachers.map(t => t.teacher_id),
                        student_ids: students.map(s => s.student_id),
                        teacher_display: formatTeacherDisplay(teachers),
                        student_display: students.map(s => s.student_name).join('、'),
                        course_type_cn: [...new Set(teachers.map(t => t.course_type_cn))].join('、'),
                        status: slot.status || 'confirmed',
                        status_cn: slot.status === 'pending' ? '待确认' : '已确认'
                    });
                }
            }

            // 按日期和时间排序
            allSchedules.sort((a, b) => `${a.class_date} ${a.start_time}`.localeCompare(`${b.class_date} ${b.start_time}`));

            // 生成预览ID（持久化到 DB，跨 Serverless 实例共享）
            const previewId = `preview_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            await aiOperationStore.savePreview(previewId, { created_by: userId, groups: previewGroups });

            // 时段冲突一次查完（一条语句，不是逐「教师×学生」各发一条），标在预览行上：
            // 用户点确认前就看得见撞了谁，模型也能在同一份工具结果里读到并改时段。
            // per-slot 名单让「A 行的教师」只跟「A 行的时段」比，多行批量不会互相误报。
            const conflictList = await scheduleService.findConflictsBatch({
                slots: previewGroups.flatMap(g => (g.slots || []).map(slot => ({
                    date: slot.date, startTime: slot.startTime, endTime: slot.endTime,
                    teacherIds: g.teachers.map(t => t.teacher_id),
                    studentIds: g.students.map(s => s.student_id)
                })))
            });
            const personName = (kind, id) => (kind === 'teacher'
                ? (teacherMap[id] && teacherMap[id].name)
                : (studentMap[id] && studentMap[id].name)) || `ID ${id}`;
            const conflictCount = markRowConflicts(allSchedules, conflictList, personName,
                collectSelfConflicts(previewGroups));

            const uniqueTeachers = [...new Set(previewGroups.flatMap(g => g.teachers.map(t => t.teacher_name)))];
            const uniqueStudents = [...new Set(previewGroups.flatMap(g => g.students.map(s => s.student_name)))];
            const uniqueCourses = [...new Set(previewGroups.flatMap(g => g.teachers.map(t => t.course_type_cn)))];

            return {
                type: 'schedule_preview',
                title: '排课预览方案',
                data: {
                    previewId,
                    teacher: uniqueTeachers.join('、'),
                    student: uniqueStudents.join('、'),
                    courseType: uniqueCourses.join('、'),
                    totalCount: allSchedules.length,
                    conflictCount,
                    schedules: allSchedules
                }
            };
        }

        case 'confirm_schedule_creation': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '仅管理员可创建排课' });

            const { previewId } = args;

            // 从存储中获取预览数据（跨实例持久化）。
            // 带上 created_by：预览是「某人生成的待执行方案」，只该由本人确认；
            // 只按 id 取的话，同实例内任何管理员都能确认别人的排课（审查报告 P2-16）。
            const previewData = await aiOperationStore.getPreview(previewId, userId);
            if (!previewData) {
                throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: '预览方案不存在或已过期，请重新生成' });
            }

            const groups = previewData.groups || [];

            // 批量插入排课：一个 group 的一个时段 = 一行 course_sessions，
            // group 内的每位教师按自己的课程类型成为一个 pair，每位学生成为一个学生 pair。
            // uid 生成、pair 的 created_by、引用完整性校验、校验函数都在服务层统一处理。
            // 往返固定 3 次而不是 3 × 时段数 —— 逐个建 10 个时段要 30 条语句、约 7.5 秒。
            const payloads = groups.flatMap(({ teachers = [], students = [], location, slots = [] }) =>
                slots.map(slot => ({
                    class_date: slot.date,
                    start_time: slot.startTime,
                    end_time: slot.endTime,
                    location: location || null,
                    teachers: teachers.map(t => ({
                        teacher_id: t.teacher_id,
                        type_id: t.course_type_id,
                        lifecycle: slot.status || 'confirmed'
                    })),
                    students: students.map(s => ({
                        student_id: s.student_id,
                        family_participants: s.family_participants
                    }))
                })));
            const createdSessions = await courseSessionService.createSessions(payloads, { id: userId, actorType: 'admin' });
            const insertedIds = createdSessions.map(x => x.id);

            // 时段重叠不拦创建（业务上允许一位教师/学生出现在时间重叠的两节课里），
            // 但要把话讲清楚：预览行标过 ⚠，写完再在同一份文案里回提示，模型和用户都看得见。
            // 名字用预览里已有的那份，不再回库查（describeConflicts 那两条批量 SELECT 是白花往返）。
            const nameById = {
                teacher: Object.fromEntries(groups.flatMap(g => (g.teachers || [])
                    .map(t => [Number(t.teacher_id), t.teacher_name || `ID ${t.teacher_id}`]))),
                student: Object.fromEntries(groups.flatMap(g => (g.students || [])
                    .map(s => [Number(s.student_id), s.student_name || `ID ${s.student_id}`])))
            };
            const createdConflicts = await scheduleService.findConflictsBatch({
                slots: payloads.map(p => ({
                    date: p.class_date, startTime: p.start_time, endTime: p.end_time,
                    teacherIds: p.teachers.map(t => t.teacher_id),
                    studentIds: p.students.map(s => s.student_id)
                })),
                excludeSessionIds: insertedIds   // 刚写进去的自己不算冲突
            });
            const conflictWarnings = [
                ...createdConflicts.map(c => scheduleService.formatConflictLine(c,
                    (kind, id) => nameById[kind][Number(id)] || `ID ${id}`)),
                ...collectSelfConflicts(groups).map(f => f.text)
            ];

            // 删除预览数据
            await aiOperationStore.deletePreview(previewId);

            const uniqueTeachers = [...new Set(groups.flatMap(g => (g.teachers || []).map(t => t.teacher_name)))];
            const uniqueStudents = [...new Set(groups.flatMap(g => (g.students || []).map(s => s.student_name)))];
            const uniqueCourses = [...new Set(groups.flatMap(g => (g.teachers || []).map(t => t.course_type_cn)))];

            return {
                type: 'text',
                title: '排课创建成功',
                data: {
                    message: `成功创建 ${insertedIds.length} 条排课记录`
                        + (conflictWarnings.length
                            ? `（注意：${conflictWarnings.length} 处时段与现有排课重叠 —— ${conflictWarnings.join('；')}）`
                            : ''),
                    scheduleIds: insertedIds,
                    conflictWarnings,
                    teacher: uniqueTeachers.join('、'),
                    student: uniqueStudents.join('、'),
                    courseType: uniqueCourses.join('、')
                }
            };
        }

        case 'preview_schedule_update': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '仅管理员可修改排课' });

            const { scheduleIds, fields } = args;

            if (!scheduleIds || scheduleIds.length === 0) {
                throw new AppError({ code: 'BAD_REQUEST', message: '请提供要修改的排课ID' });
            }

            if (!fields || Object.keys(fields).length === 0) {
                throw new AppError({ code: 'BAD_REQUEST', message: '请提供要修改的字段' });
            }

            // 一场课一条记录：交叉积折回场次，教师/学生名册各带 uid 供指名
            const pairRows = await db.query(
                `SELECT ca.session_id, ca.class_date, ca.start_time, ca.end_time,
                        ca.location, ca.notes, ca.status_code, ca.family_participants,
                        ca.transport_fee, ca.other_fee, ca.created_by,
                        ca.teacher_uid, ca.student_uid, ca.teacher_id, ca.student_id,
                        ca.type_id AS course_type_id,
                        t.name as teacher_name, s.name as student_name,
                        st.name as course_type, st.description as course_type_cn
                 FROM v_session_pairs ca
                 JOIN teachers t ON ca.teacher_id = t.id
                 JOIN students s ON ca.student_id = s.id
                 JOIN schedule_types st ON ca.type_id = st.id
                 WHERE ca.session_id = ANY($1)`,
                [scheduleIds]
            );

            if (pairRows.rows.length === 0) {
                throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: '未找到指定的排课' });
            }
            const sessions = collapsePairsToSessions(pairRows.rows);
            const foundIds = sessions.map(s => s.id);
            const missingIds = scheduleIds.filter(id => !foundIds.includes(Number(id)));
            if (missingIds.length) {
                throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `排课 ID ${missingIds.join(', ')} 不存在` });
            }

            // 权限落地（Phase 1.5）：L3 只能修改自己创建或无主的排课，任一越权则整批拒绝
            if (sessions.some(s => !canTouchRecord(s.created_by, req.user))) {
                throw new AppError({ code: 'FORBIDDEN', message: '所选排课包含您无权操作的记录' });
            }

            // 指名的 pair 必须在这些场次里存在。不指名 = 整场（全部在职 pair），不再是「取第一位」
            const targetTeacherUid = fields.teacherUid != null ? String(fields.teacherUid) : null;
            const targetStudentUid = fields.studentUid != null ? String(fields.studentUid) : null;
            for (const s of sessions) {
                if (targetTeacherUid && !s.teachers.some(t => t.uid === targetTeacherUid)) {
                    throw new AppError({
                        code: 'BAD_REQUEST',
                        message: `排课 ${s.id} 没有 uid 为 ${targetTeacherUid} 的教师（本场教师 uid：${s.teacher_uids.join('、')}）`
                    });
                }
                if (targetStudentUid && !s.students.some(x => x.uid === targetStudentUid)) {
                    throw new AppError({
                        code: 'BAD_REQUEST',
                        message: `排课 ${s.id} 没有 uid 为 ${targetStudentUid} 的学生（本场学生 uid：${s.students.map(x => x.uid).join('、')}）`
                    });
                }
            }

            // 验证新值：名册里的教师/学生/涉及的课程类型各批量查一次（三条语句，不逐条往返）
            const rosterTeachers = Array.isArray(fields.teachers) ? fields.teachers : [];
            const rosterStudents = Array.isArray(fields.students) ? fields.students : [];
            const rosterTeacherIds = [...new Set(rosterTeachers.map(t => t && t.teacherId).filter(v => v != null))];
            const rosterStudentIds = [...new Set(rosterStudents.map(s => s && s.studentId).filter(v => v != null))];
            // 名册里「带 teacherUid 但不给类型」的条目沿用该 pair 原有类型（见 effectiveTeacherRoster
            // 的 keep.course_type 回退），所以那些类型名也必须进这一批查询 —— 漏了的话
            // refs.typeByName 里根本没有这个键，同一场课里别位教师恰好同名时才侥幸通过。
            const keepTypeNames = rosterTeachers
                .filter(t => t && t.teacherUid != null && !t.courseType)
                .flatMap(t => sessions.flatMap(s => (s.teachers || [])
                    .filter(p => String(p.uid) === String(t.teacherUid) && p.course_type)
                    .map(p => p.course_type)));
            const typeNames = [...new Set([
                ...rosterTeachers.map(t => t && t.courseType).filter(Boolean),
                ...keepTypeNames,
                ...(fields.courseType ? [fields.courseType] : [])
            ])];

            const [teacherRows, studentRows, typeRows] = await Promise.all([
                rosterTeacherIds.length ? db.query('SELECT id, name, status FROM teachers WHERE id=ANY($1)', [rosterTeacherIds]) : { rows: [] },
                rosterStudentIds.length ? db.query('SELECT id, name, status FROM students WHERE id=ANY($1)', [rosterStudentIds]) : { rows: [] },
                typeNames.length ? db.query('SELECT id, name, description FROM schedule_types WHERE name=ANY($1)', [typeNames]) : { rows: [] }
            ]);

            const refs = {
                teacherById: Object.fromEntries(teacherRows.rows.map(r => [r.id, r])),
                studentById: Object.fromEntries(studentRows.rows.map(r => [r.id, r])),
                typeByName: Object.fromEntries(typeRows.rows.map(r => [r.name, r]))
            };

            for (const t of rosterTeachers) {
                const person = refs.teacherById[t.teacherId];
                if (!person) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `教师 ID ${t.teacherId} 不存在` });
                if (person.status !== 1) throw new AppError({ code: 'BAD_REQUEST', message: `教师 ${person.name} 已被禁用` });
            }
            for (const s of rosterStudents) {
                const person = refs.studentById[s.studentId];
                if (!person) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `学生 ID ${s.studentId} 不存在` });
                if (person.status !== 1) throw new AppError({ code: 'BAD_REQUEST', message: `学生 ${person.name} 已被禁用` });
            }

            // 每场的生效名册只算一次，预览与确认存的是同一口径
            const resolved = sessions.map(session => ({
                session,
                teachers: effectiveTeacherRoster(session, fields, refs),
                students: effectiveStudentRoster(session, fields, refs)
            }));

            // 调整课程：status=modified_away → 本场在职教师全部归档 + 按新条件另起一场完整课
            const isAdjust = fields.status === 'modified_away';
            const newSchedulesPreview = isAdjust ? resolved.map(({ session, teachers, students }) => ({
                originalId: session.id,
                teachers, students,
                teacherName: formatTeacherDisplay(teachers),
                studentName: students.map(s => s.student_name).join('、'),
                courseTypeCn: [...new Set(teachers.map(t => t.course_type_cn))].join('、'),
                classDate: fields.classDate ?? session.class_date,
                startTime: fields.startTime ?? session.start_time,
                endTime: fields.endTime ?? session.end_time,
                location: fields.location !== undefined ? fields.location : session.location,
                status: 'confirmed',
                adjustmentType: 2
            })) : null;

            // 预览表格：一场课一行（教师/学生都是整场名册，记录教师带「（记录）」）
            const displayRows = resolved.map(({ session, teachers, students }) => toMergedDisplayRow(session, teachers, students));

            // 编辑也要提示时段重叠（与新建预览同一份文案、同样只提示不拦）：
            // 查的是「改完之后」的时段与名册，并排除被编辑的这些场次自己 —— 挪走不是撞车。
            // 没挪时间、没动名册就一条查询都不发。
            const slotTouched = fields.classDate || fields.startTime || fields.endTime;
            const rosterTouched = Array.isArray(fields.teachers) || Array.isArray(fields.students);
            let editConflictCount = 0;
            if (slotTouched || rosterTouched) {
                const found = await scheduleService.findConflictsBatch({
                    slots: resolved.map(({ session, teachers, students }) => ({
                        date: toDateKey(fields.classDate ?? session.class_date),
                        startTime: normTime(fields.startTime ?? session.start_time),
                        endTime: normTime(fields.endTime ?? session.end_time),
                        teacherIds: teachers.map(t => Number(t.teacher_id)),
                        studentIds: students.map(s => Number(s.student_id))
                    })),
                    excludeSessionIds: resolved.map(r => Number(r.session.id))
                });
                const nameOf = (kind, id) => (kind === 'teacher'
                    ? (refs.teacherById[id] && refs.teacherById[id].name)
                    : (refs.studentById[id] && refs.studentById[id].name)) || `ID ${id}`;
                editConflictCount = markRowConflicts(displayRows, found, nameOf, [],
                    (row) => slotKeyOf(
                        fields.classDate ?? row.class_date,
                        fields.startTime ?? row.start_time,
                        fields.endTime ?? row.end_time
                    ));
                // 调整预览另有「调整后新建」那张表：它才是新时段的承载行，不标就会出现
                // 「头部说 N 处重叠、表里一行都没有」的自相矛盾
                if (newSchedulesPreview) {
                    markRowConflicts(newSchedulesPreview, found, nameOf, [],
                        (row) => slotKeyOf(row.classDate, row.startTime, row.endTime));
                }
            }

            // 生成操作ID
            const operationId = `update_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

            // 构建变更对比：名册单独列出；uid 没指名就是整场生效，这一点要写在预览里
            const fieldNames = {
                classDate: '日期',
                startTime: '开始时间',
                endTime: '结束时间',
                status: '状态',
                courseType: '课程类型',
                location: '地点',
                familyParticipants: '家长参与人数',
                transportFee: '交通费',
                otherFee: '其他费用'
            };
            const scopeLabel = targetTeacherUid ? `（仅教师 pair ${targetTeacherUid}）`
                : (targetStudentUid ? `（仅学生 pair ${targetStudentUid}）` : '（整场）');

            const changes = [];
            if (Array.isArray(fields.teachers)) {
                changes.push({
                    field: '教师名册',
                    newValue: [...new Set(resolved.map(r => formatTeacherDisplay(r.teachers)))].join(' / ')
                });
            }
            if (Array.isArray(fields.students)) {
                changes.push({
                    field: '学生名册',
                    newValue: [...new Set(resolved.map(r => r.students.map(s => s.student_name).join('、')))].join(' / ')
                });
            }
            Object.keys(fields).forEach(key => {
                if (key === 'teachers' || key === 'students' || key === 'teacherUid' || key === 'studentUid') return;
                let newValue = fields[key];
                if (key === 'courseType') {
                    const type = refs.typeByName[fields.courseType];
                    // 查不到就是查不到：以前这里直接 type.description 取值 → TypeError → 500，
                    // 用户看到的是一句「服务器错误」而不是「这个课程类型不存在」
                    if (!type) {
                        throw new AppError({
                            code: 'RESOURCE_NOT_FOUND',
                            message: `课程类型 ${fields.courseType || '(空)'} 不存在`
                        });
                    }
                    newValue = `${type.description || type.name}（${fields.courseType}）${scopeLabel}`;
                } else if (key === 'status') {
                    newValue = translateStatus(fields[key]);
                } else if (key === 'familyParticipants') {
                    newValue = `${newValue}${scopeLabel}`;
                }
                changes.push({ field: fieldNames[key] || key, newValue });
            });

            // 调整课程：在变更对比里追加“原记录归档+新建”说明
            if (isAdjust) {
                const partial = targetTeacherUid
                    && resolved.some(r => r.session.active_teachers.length > 1);
                changes.push({ field: '原记录', newValue: '本场在职教师归档为已调整 (modified_away)' });
                changes.push({
                    field: '新课',
                    newValue: partial
                        ? '指名的教师另起一场新课；其余教师留在原时段（原场次不会跟着搬）'
                        : '整场调整就在这一行内增补：改了时段就把整场 header 搬过去、旧时段随即释放（不再另起一行）'
                });
            }

            // 存储待确认操作（跨实例持久化）：确认时按这份生效名册写库，不再回退到「取第一位」。
            // teacherUids / studentUids 是这一场要落 pair 级改动的清单 —— 不指名就是本场全部在职 pair，
            // 在执行时按当场读回的名册复核，避免预览与确认之间有人被改动过。
            await aiOperationStore.saveOperation(operationId, {
                // created_by 必须记：确认动作要按创建者校验（P2-16）。
                // 过去这里不写，ai_pending_operations.created_by 落库就是 NULL，
                // 于是「谁挂起的操作」在服务端根本没有事实来源。
                created_by: userId,
                type: 'update',
                scheduleIds,
                fields,
                targetTeacherUid,
                targetStudentUid,
                rosters: resolved.map(({ session, teachers, students }) => ({
                    sessionId: session.id,
                    teachers, students,
                    teacherUids: (targetTeacherUid ? [targetTeacherUid]
                        : session.teachers.filter(t => courseSessionService.isActive(t.status_code)).map(t => t.uid)),
                    studentUids: targetStudentUid ? [targetStudentUid] : students.map(s => s.uid)
                })),
                schedules: displayRows,
                changes,
                isAdjust,
                newSchedulesPreview,
                createdAt: Date.now()
            });

            return {
                type: 'schedule_operation_preview',
                title: isAdjust ? '调整预览' : '修改预览',
                data: {
                    operationId,
                    operationType: isAdjust ? 'adjust' : 'update',
                    affectedCount: sessions.length,
                    conflictCount: editConflictCount,
                    schedules: displayRows,
                    changes,
                    newSchedules: newSchedulesPreview,
                    message: isAdjust
                        ? `将调整 ${sessions.length} 场课（原记录归档为已调整，并按新条件新建课程）`
                        : `将修改 ${sessions.length} 场课的${changes.map(c => c.field).join('、')}`
                }
            };
        }

        case 'preview_schedule_deletion': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '仅管理员可删除排课' });

            const { scheduleIds, teacherUids, studentUids, reason } = args;

            if (!scheduleIds || scheduleIds.length === 0) {
                throw new AppError({ code: 'BAD_REQUEST', message: '请提供要删除的排课ID' });
            }

            // 不给 pair uid = 删除整场课；给了 = 只把这些教师/学生移出本场
            const isPairRemoval = (Array.isArray(teacherUids) && teacherUids.length > 0)
                || (Array.isArray(studentUids) && studentUids.length > 0);
            const wantedTeacherUids = (Array.isArray(teacherUids) ? teacherUids : []).map(String);
            const wantedStudentUids = (Array.isArray(studentUids) ? studentUids : []).map(String);

            const pairRows = await db.query(
                `SELECT ca.session_id, ca.class_date, ca.start_time, ca.end_time,
                        ca.location, ca.notes, ca.status_code, ca.family_participants,
                        ca.transport_fee, ca.other_fee, ca.created_by,
                        ca.teacher_uid, ca.student_uid, ca.teacher_id, ca.student_id,
                        ca.type_id AS course_type_id,
                        t.name as teacher_name, s.name as student_name,
                        st.name as course_type, st.description as course_type_cn
                 FROM v_session_pairs ca
                 JOIN teachers t ON ca.teacher_id = t.id
                 JOIN students s ON ca.student_id = s.id
                 JOIN schedule_types st ON ca.type_id = st.id
                 WHERE ca.session_id = ANY($1)`,
                [scheduleIds]
            );

            if (pairRows.rows.length === 0) {
                throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: '未找到指定的排课' });
            }
            const sessions = collapsePairsToSessions(pairRows.rows);
            const foundIds = sessions.map(s => s.id);
            const missingIds = scheduleIds.filter(id => !foundIds.includes(Number(id)));
            if (missingIds.length) {
                throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `排课 ID ${missingIds.join(', ')} 不存在` });
            }

            // 权限落地（Phase 1.5）：L3 只能删除自己创建或无主的排课，任一越权则整批拒绝
            if (sessions.some(s => !canTouchRecord(s.created_by, req.user))) {
                throw new AppError({ code: 'FORBIDDEN', message: '所选排课包含您无权操作的记录' });
            }

            let removals = null;
            if (isPairRemoval) {
                removals = [];
                for (const s of sessions) {
                    const hitTeacherUids = wantedTeacherUids.filter(uid => s.teachers.some(t => t.uid === uid));
                    const hitStudentUids = wantedStudentUids.filter(uid => s.students.some(x => x.uid === uid));
                    if (!hitTeacherUids.length && !hitStudentUids.length) continue;
                    // 清空一名参与者就等于删除整场，那是另一个动作，不该伪装成「移出」
                    if (hitTeacherUids.length === s.teachers.length || hitStudentUids.length === s.students.length) {
                        throw new AppError({
                            code: 'BAD_REQUEST',
                            message: `排课 ${s.id} 要移出的是本场全部${hitTeacherUids.length === s.teachers.length ? '教师' : '学生'}，请改用「删除整场」（不要传 teacherUids/studentUids）`
                        });
                    }
                    removals.push({ sessionId: s.id, teacherUids: hitTeacherUids, studentUids: hitStudentUids });
                }
                if (!removals.length) {
                    throw new AppError({ code: 'BAD_REQUEST', message: '指定的 teacherUids/studentUids 在这些排课里都不存在' });
                }
            }

            // 生成操作ID
            const operationId = `delete_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            const displayRows = sessions.map(s => toMergedDisplayRow(s, s.teachers, s.students));

            // 存储待确认操作（跨实例持久化）
            await aiOperationStore.saveOperation(operationId, {
                created_by: userId,   // 同上：确认时按创建者校验（P2-16）
                type: 'delete',
                scheduleIds,
                reason,
                removals,
                schedules: displayRows,
                createdAt: Date.now()
            });

            return {
                type: 'schedule_operation_preview',
                title: '删除预览',
                data: {
                    operationId,
                    operationType: 'delete',
                    affectedCount: sessions.length,
                    schedules: displayRows,
                    reason: reason || '未提供',
                    message: isPairRemoval
                        ? `即将把指定的教师/学生移出 ${removals.length} 场课（其余参与者保留）`
                        : `即将删除 ${sessions.length} 场课（含本场全部教师与学生）`
                }
            };
        }

        case 'confirm_operation': {
            if (userType !== 'admin') throw new AppError({ code: 'FORBIDDEN', message: '仅管理员可执行敏感操作' });

            const { operationId } = args;

            if (!operationId) {
                throw new AppError({ code: 'BAD_REQUEST', message: '请提供操作ID' });
            }

            // 同 confirm_schedule_creation：只认本人创建的待确认操作（P2-16）
            const operation = await aiOperationStore.getOperation(operationId, userId);

            if (!operation) {
                throw new AppError({ code: 'BAD_REQUEST', message: '操作ID无效或已过期（5分钟有效期），请重新预览' });
            }

            // 权限落地（Phase 1.5）：执行前再次核验归属（防止跨账号确认他人预览的操作）
            if ((operation.type === 'update' || operation.type === 'delete')
                && Array.isArray(operation.scheduleIds) && requiresOwnDataScope(req.user)) {
                const ownRes = await db.query(
                    'SELECT COUNT(*)::int AS count FROM course_sessions WHERE id = ANY($1) AND (created_by = $2 OR created_by IS NULL)',
                    [operation.scheduleIds, userId]
                );
                const ownedCount = ownRes.rows && ownRes.rows[0] ? Number(ownRes.rows[0].count) : 0;
                if (ownedCount !== operation.scheduleIds.length) {
                    throw new AppError({ code: 'FORBIDDEN', message: '所选排课包含您无权操作的记录，请重新发起' });
                }
            }

            // 根据操作类型执行相应逻辑
            if (operation.type === 'update') {
                // 执行修改操作
                const { scheduleIds, fields } = operation;

                // 调整课程：整场调整就在**同一行内**作废+增补，改了时段就把整场的 header 一起搬过去
                // —— 不再另起一行，否则旧时段还被归档的那条 pair 占着（日历两格、统计多算一场）。
                // 只调某几位教师又要换时段时，那几位 detach 出去新建一场，其余教师留在原时段。
                if (operation.isAdjust) {
                    const actor = { id: req.user.id, actorType: 'admin' };
                    const rosters = operation.rosters || [];
                    const typeIds = [...new Set(rosters.flatMap(r => (r.teachers || []).map(t => t.course_type_id)))];
                    // 涉及的课程类型在循环外一次校验，循环内 skipTypeAssert 跳过逐条查询
                    if (typeIds.length) await courseSessionService.assertReferences({ typeIds });

                    const activePair = (p) => {
                        const { category, lifecycle } = splitStatus(p.status);
                        return lifecycle !== 'modified_away' && category !== 'adjusted';
                    };

                    const result = await db.runInTransaction(async (client, usePool) => {
                        const q = usePool ? db.query.bind(db) : client.query.bind(client);
                        const sessionIds = [];
                        const newSessionIds = [];
                        const slotsToCheck = [];   // 改完之后的时段，事务提交后一次批量查冲突（只提示）

                        // 一次把本次要动的行全部锁回来（按 id 升序 → 并发会话拿行锁的顺序一致，
                        // 不会互夹死锁；行锁 + 后面的写都在同一个事务客户端上，中途报错整批回滚）
                        const sidList = rosters.map(r => Number(r.sessionId));
                        const locked = await q(
                            `SELECT id, class_date, start_time, end_time, location, notes,
                                    teachers, students, version, created_by
                               FROM course_sessions WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`,
                            [sidList]
                        );
                        const byId = new Map((locked.rows || []).map(r => [Number(r.id), r]));

                        for (const roster of rosters) {
                            const sid = Number(roster.sessionId);
                            const origin = byId.get(sid);
                            if (!origin) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `排课 ${sid} 不存在` });
                            let session = origin;
                            let version = Number(session.version);

                            const allActive = (origin.teachers || []).filter(activePair);
                            // 归档对象：teacherUid 指名的那一位，否则本场全部在职教师
                            const targets = operation.targetTeacherUid
                                ? allActive.filter(p => String(p.uid) === String(operation.targetTeacherUid))
                                : allActive;
                            if (!targets.length) {
                                throw new AppError({ code: 'CONFLICT', message: `排课 ${sid} 没有可调整的在职教师记录（可能已被调整过）` });
                            }

                            const effTeachers = roster.teachers || [];
                            const effStudents = roster.students || [];
                            const effDate = fields.classDate ?? origin.class_date;
                            const effStart = fields.startTime ?? origin.start_time;
                            const effEnd = fields.endTime ?? origin.end_time;
                            const effLocation = fields.location !== undefined ? (fields.location || null) : origin.location;
                            const headerMoved = toDateKey(effDate) !== toDateKey(origin.class_date)
                                || effStart !== origin.start_time || effEnd !== origin.end_time
                                || (effLocation || null) !== (origin.location || null);
                            // 只挪走部分教师 + 换了 header 字段（时段**或地点**都在 header 上，
                            // 一位教师改地点原行也放不下）→ 这几位得去另一行，原行的 header 不能跟着动
                            const partialMove = headerMoved && targets.length < allActive.length;

                            // 时段重叠只提示不拦，所以不必在事务里逐场查（那是每场 2 次往返、
                            // 还全程持锁）。这里只记下「改完之后」的时段与名单，事务提交后一次批量查完。
                            const teachersToCheck = partialMove
                                ? effTeachers.filter(t => targets.some(p => String(p.uid) === String(t.uid)))
                                : effTeachers;
                            slotsToCheck.push({
                                date: toDateKey(effDate),
                                startTime: effStart,
                                endTime: effEnd,
                                teacherIds: teachersToCheck.map(t => Number(t.teacher_id)),
                                studentIds: effStudents.map(s => Number(s.student_id))
                            });

                            // 2. 逐个 pair 作废+增补：换人/换类型写进增补 pair；
                            //    被移出本场的教师（名册里不再有他）与 partialMove 只归档不追加。
                            const movedOut = [];
                            for (const pair of targets) {
                                const eff = effTeachers.find(t => String(t.uid) === String(pair.uid))
                                    || effTeachers.find(t => Number(t.teacher_id) === Number(pair.teacher_id));
                                const dropped = Array.isArray(fields.teachers) && !eff;
                                const adjusted = await courseSessionService.adjustTeacherPair(
                                    sid, pair.uid,
                                    {
                                        teacher_id: eff ? eff.teacher_id : undefined,
                                        type_id: (eff && eff.course_type_id) ?? pair.type_id
                                    },
                                    actor, version, session,
                                    { skipTypeAssert: true, detach: dropped || partialMove, tx: q }
                                );
                                if (adjusted.notFound) throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `排课 ${sid} 不存在` });
                                session = adjusted.session;
                                version = Number(session.version);
                                if (adjusted.detached) movedOut.push(adjusted.detached);
                            }

                            if (partialMove) {
                                // 3a. 被挪走的教师另起一场（含本场全部学生），原行只留归档痕迹
                                const fresh = await courseSessionService.createSession({
                                    class_date: effDate, start_time: effStart, end_time: effEnd,
                                    location: effLocation, notes: origin.notes,
                                    teachers: movedOut.map(t => ({ teacher_id: t.teacher_id, type_id: t.type_id, lifecycle: 'confirmed' })),
                                    students: effStudents.map(s => ({ student_id: s.student_id, family_participants: s.family_participants }))
                                }, actor, q);
                                sessionIds.push(fresh.id);
                                newSessionIds.push(fresh.id);
                            } else {
                                // 3b. 名册里新增的教师补进本场（他不是"调整出来的增补"，就是新加一位参与者）
                                if (Array.isArray(fields.teachers)) {
                                    const present = new Set((session.teachers || []).filter(activePair).map(p => Number(p.teacher_id)));
                                    for (const t of effTeachers.filter(x => !x.uid)) {
                                        if (present.has(Number(t.teacher_id))) continue;
                                        const r = await courseSessionService.addPair(sid, 'teacher', {
                                            teacher_id: t.teacher_id, type_id: t.course_type_id, lifecycle: 'confirmed'
                                        }, actor, version, q);
                                        if (r.session) { session = r.session; version = Number(session.version); }
                                        present.add(Number(t.teacher_id));
                                    }
                                }

                                // 4. 学生名册有变就在本场做增删改（教师侧已由上面作废+增补承担）
                                if (Array.isArray(fields.students)) {
                                    const keepUids = new Set(effStudents.filter(s => s.uid).map(s => String(s.uid)));
                                    for (const s of effStudents) {
                                        if (s.uid) {
                                            const r = await courseSessionService.patchPair(sid, 'student', s.uid, {
                                                student_id: s.student_id, family_participants: s.family_participants
                                            }, actor, version, session, q);
                                            if (r.session) { session = r.session; version = Number(session.version); }
                                        } else {
                                            const r = await courseSessionService.addPair(sid, 'student', {
                                                student_id: s.student_id, family_participants: s.family_participants
                                            }, actor, version, q);
                                            if (r.session) { session = r.session; version = Number(session.version); }
                                        }
                                    }
                                    for (const pair of (session.students || []).filter(p => !keepUids.has(String(p.uid)))) {
                                        const r = await courseSessionService.removePair(sid, 'student', pair.uid, actor, version, q);
                                        if (r.session) { session = r.session; version = Number(session.version); }
                                    }
                                }

                                // 5. 整场换时段/换地点：直接在原行搬 header，旧时段就此释放
                                if (headerMoved) {
                                    const r = await courseSessionService.updateSessionHeader(sid, {
                                        class_date: effDate, start_time: effStart, end_time: effEnd, location: effLocation
                                    }, actor, version, session, q);
                                    if (r) { session = r; version = Number(session.version); }
                                }
                                sessionIds.push(sid);
                            }
                        }
                        return { sessionIds, newSessionIds, slotsToCheck };
                    });   // 不降级：整批 sid 的归档 + 增补/搬移必须同生共死，否则会留下「原记录已归档但新课没建」的空洞

                    // 提交之后再一次批量查重叠：一条语句覆盖全部新时段（原来是每场 2 次往返、还都在持锁期间），
                    // 报的是「改完之后确实和谁重叠」，只提示不拦
                    const adjustConflicts = result.slotsToCheck.length
                        ? await scheduleService.conflictLines({
                            slots: result.slotsToCheck,
                            excludeSessionIds: [...result.sessionIds, ...result.newSessionIds]
                        })
                        : [];

                    await aiOperationStore.deleteOperation(operationId);
                    return {
                        type: 'text',
                        title: '调整成功',
                        data: {
                            message: (result.newSessionIds.length
                                ? `已调整 ${result.sessionIds.length} 场课，其中换时段的教师另起了 ${result.newSessionIds.length} 场新课（原记录归档为已调整）`
                                : `已调整 ${result.sessionIds.length} 场课（原记录归档为已调整，新课时就在原场次上生效）`)
                                + (adjustConflicts.length
                                    ? `（注意：${adjustConflicts.length} 处时段与现有排课重叠 —— ${adjustConflicts.join('；')}）`
                                    : ''),
                            originalIds: scheduleIds,
                            newIds: result.sessionIds,
                            newSessionIds: result.newSessionIds,
                            conflictWarnings: adjustConflicts
                        }
                    };
                }

                // 普通改课：分头部字段与 pair 字段两路走服务层
                // （一条 UPDATE 拼所有列的写法在新结构下不成立：头部是整场共享的，
                //   类型/费用/评分挂在教师 pair 上，家属人数挂在学生 pair 上）
                const actor = { id: req.user.id, actorType: 'admin' };
                const rosterBySession = new Map(
                    (operation.rosters || []).map(r => [Number(r.sessionId), r])
                );

                // 循环外一次把涉及的场次全部读回来：原来每个 sid 先读一次，再让
                // updateSessionHeader / patchPair / setTeacherStatus 各自又读一次同一行
                // —— 一条排课 4 次「写前读整场」。远程库每条约 250ms，5 条排课就是 5 秒纯读。
                const sessionRows = await db.query(
                    `SELECT ${courseSessionService.SESSION_COLUMNS} FROM course_sessions WHERE id = ANY($1::int[])`,
                    [scheduleIds]
                );
                const sessionById = new Map((sessionRows.rows || []).map(r => [Number(r.id), r]));

                // 只改了某一位教师的课程类型（没给名册）时，把类型名换成 id
                let singleTypeId = null;
                if (fields.courseType && !Array.isArray(fields.teachers)) {
                    const r = await db.query('SELECT id FROM schedule_types WHERE name=$1', [fields.courseType]);
                    singleTypeId = r.rows[0] && r.rows[0].id;
                    if (!singleTypeId) {
                        throw new AppError({ code: 'RESOURCE_NOT_FOUND', message: `课程类型 ${fields.courseType} 不存在` });
                    }
                }

                // 钱不落在这条批量 patchPair 上：AI 的「改交通费」以前写进 teachers[0] 的整趟标量，
                // 同场别的学生也跟着拿到这个数，而且一行费用审计都没有。现在由费用那层写：
                // 只有一趟一位学生时能确定「钱属于哪一格」，多学生时必须去费用页逐位填。
                // 先扫再动手 —— 下面每个 sid 是各自独立的 UPDATE，中途抛错会留下半改状态。
                const wantsFee = fields.transportFee !== undefined || fields.otherFee !== undefined;
                if (wantsFee) {
                    const neg = [fields.transportFee, fields.otherFee]
                        .some(v => v !== undefined && v !== null && Number(v) < 0);
                    if (neg) {
                        throw new AppError({ code: 'AI_FEE_INVALID', statusCode: 400, message: '费用不能为负数' });
                    }
                    const shared = scheduleIds
                        .map(sid => sessionById.get(Number(sid)))
                        .filter(s => s && (s.students || []).length > 1);
                    if (shared.length) {
                        throw new AppError({
                            code: 'AI_FEE_NEEDS_STUDENT',
                            statusCode: 400,
                            message: `有 ${shared.length} 场课是多位学生同上一趟课，交通费/其他费用要按学生分别填写，请到费用报销页逐位学生录入。`
                        });
                    }
                    // 同一趟课里多位教师时，「这笔钱是谁的」也必须指名 —— 不能替用户猜
                    const multiTeacher = scheduleIds
                        .map(sid => sessionById.get(Number(sid)))
                        .filter(s => s && !operation.targetTeacherUid
                            && (s.teachers || []).filter(p => courseSessionService.isActive(p.status)).length > 1);
                    if (multiTeacher.length) {
                        throw new AppError({
                            code: 'AI_FEE_NEEDS_TEACHER',
                            statusCode: 400,
                            message: `有 ${multiTeacher.length} 场课是多位教师同上一趟课，交通费/其他费用挂在这位教师头上，请用 teacherUid 指明是哪一位。`
                        });
                    }
                }

                // 整批改课放进同一个事务（头部 + 名册 + 单 pair 状态 + 钱是几条彼此独立的
                // UPDATE）：中途报错整批回滚，不会出现「前 3 场改完了、第 4 场失败」的半截结果。
                // 注意这里**不取日期锁**，也没有 FOR UPDATE：两个会话把不同的课挪进同一格时
                // 仍可能都写成功，冲突只作为提交后的提示返回（本项目口径：时段重叠提示而不拦写）。
                const updateConflicts = [];
                const pendingConflictChecks = [];
                await db.runInTransaction(async (client, usePool) => {
                    const q = usePool ? db.query.bind(db) : client.query.bind(client);
                    for (const sid of scheduleIds) {
                        let current = sessionById.get(Number(sid));
                        if (!current) continue;
                        let version = Number(current.version);
                        const roster = rosterBySession.get(Number(sid));

                        const headerPatch = {};
                        if (fields.classDate) headerPatch.class_date = fields.classDate;
                        if (fields.startTime) headerPatch.start_time = fields.startTime;
                        if (fields.endTime) headerPatch.end_time = fields.endTime;
                        if (fields.location !== undefined) headerPatch.location = fields.location;
                        // 改期只提示不拦（排除被改的这场自己；只改地点/状态不必查）。
                        // 事务体内只记「提交后要查什么」，不发查询：conflictLines 不接 tx，
                        // 在这里执行等于再向池要一条连接（serverless 下 POOL_MAX=2），
                        // 事务等连接、连接等事务释放 —— 就是 course-session-service 里
                        // pickQ 注释警告过的同一类挂死。
                        if (headerPatch.class_date || headerPatch.start_time || headerPatch.end_time) {
                            pendingConflictChecks.push({
                                slots: [{
                                    date: headerPatch.class_date ?? current.class_date,
                                    startTime: headerPatch.start_time ?? current.start_time,
                                    endTime: headerPatch.end_time ?? current.end_time
                                }],
                                teacherIds: (roster?.teachers || current.teachers || [])
                                    .filter(p => courseSessionService.isActive(p.status ?? p.status_code))
                                    .map(t => Number(t.teacher_id)),
                                studentIds: (roster?.students || current.students || []).map(s => Number(s.student_id)),
                                excludeSessionIds: [Number(sid)]
                            });
                        }
                        if (Object.keys(headerPatch).length) {
                            current = await courseSessionService.updateSessionHeader(sid, headerPatch, actor, version, current, q);
                            version = Number(current.version);
                        }

                        // 教师名册整场替换：先补齐新增与修改，再移出没被点名的 —— 顺序反了会撞
                        // 「这是本场最后一位教师」（数组不允许为空）。
                        if (roster && Array.isArray(fields.teachers)) {
                            const keptUids = new Set();
                            for (const entry of roster.teachers) {
                                const payload = {
                                    teacher_id: entry.teacher_id,
                                    type_id: entry.course_type_id,
                                    lifecycle: 'confirmed'
                                };
                                if (entry.uid) {
                                    keptUids.add(String(entry.uid));
                                    const r = await courseSessionService.patchPair(
                                        sid, 'teacher', entry.uid,
                                        { teacher_id: payload.teacher_id, type_id: payload.type_id },
                                        actor, version, current, q
                                    );
                                    if (r.session) { current = r.session; version = Number(current.version); }
                                } else {
                                    const r = await courseSessionService.addPair(sid, 'teacher', payload, actor, version, q);
                                    if (r.session) {
                                        current = r.session;
                                        version = Number(current.version);
                                        keptUids.add(String(r.uid));
                                    }
                                }
                            }
                            const leaving = (current.teachers || [])
                                .filter(p => courseSessionService.isActive(p.status) && !keptUids.has(String(p.uid)));
                            for (const pair of leaving) {
                                const r = await courseSessionService.removePair(sid, 'teacher', pair.uid, actor, version, q);
                                if (r.session) { current = r.session; version = Number(current.version); }
                            }
                        } else {
                            // 不替换名册时，教师级改动落在预览时定下的 uid 清单上（不指名就是本场全部在职教师）；
                            // 预览与确认之间有人被移出本场，这里按当场读回的名册过滤掉，不会写到别人头上。
                            const activeUids = (current.teachers || [])
                                .filter(p => courseSessionService.isActive(p.status))
                                .map(p => String(p.uid));
                            // roster 可能整个缺席（发布前留下的 5 分钟内 pending 操作就没有 rosters）
                            const wantedUids = Array.isArray(roster?.teacherUids) && roster.teacherUids.length
                                ? roster.teacherUids.map(String) : activeUids;
                            const teacherUids = wantedUids.filter(uid => activeUids.includes(uid));

                            for (const uid of teacherUids) {
                                if (singleTypeId) {
                                    const r = await courseSessionService.patchPair(
                                        sid, 'teacher', uid, { type_id: singleTypeId }, actor, version, current, q
                                    );
                                    if (r.session) { current = r.session; version = Number(current.version); }
                                }
                                if (fields.status) {
                                    const r = await courseSessionService.setTeacherStatus(sid, uid, fields.status, actor, undefined, current, q);
                                    if (r.session) { current = r.session; version = Number(current.version); }
                                }
                            }
                        }

                        // 学生名册：与教师同一套替换语义；只改家长人数时落在指名学生或全场学生
                        if (roster && Array.isArray(fields.students)) {
                            const keptStudentUids = new Set();
                            for (const entry of roster.students) {
                                const payload = {
                                    student_id: entry.student_id,
                                    family_participants: entry.family_participants
                                };
                                if (entry.uid) {
                                    keptStudentUids.add(String(entry.uid));
                                    const r = await courseSessionService.patchPair(
                                        sid, 'student', entry.uid,
                                        { student_id: payload.student_id, family_participants: payload.family_participants },
                                        actor, version, current, q
                                    );
                                    if (r.session) { current = r.session; version = Number(current.version); }
                                } else {
                                    const r = await courseSessionService.addPair(sid, 'student', payload, actor, version, q);
                                    if (r.session) {
                                        current = r.session;
                                        version = Number(current.version);
                                        keptStudentUids.add(String(r.uid));
                                    }
                                }
                            }
                            const leaving = (current.students || [])
                                .filter(p => !keptStudentUids.has(String(p.uid)));
                            for (const pair of leaving) {
                                const r = await courseSessionService.removePair(sid, 'student', pair.uid, actor, version, q);
                                if (r.session) { current = r.session; version = Number(current.version); }
                            }
                        } else if (fields.familyParticipants !== undefined) {
                            const allStudentUids = (current.students || []).map(p => String(p.uid));
                            const wantedStudentUids = Array.isArray(roster?.studentUids) && roster.studentUids.length
                                ? roster.studentUids.map(String) : allStudentUids;
                            for (const uid of wantedStudentUids.filter(u => allStudentUids.includes(u))) {
                                const r = await courseSessionService.patchPair(
                                    sid, 'student', uid, { family_participants: Number(fields.familyParticipants) },
                                    actor, version, current, q
                                );
                                if (r.session) { current = r.session; version = Number(current.version); }
                            }
                        }

                        // 费用放在最后：上面几步会把 teachers / students 整列回写，先写钱会被抹掉。
                        if (wantsFee) {
                            // 走到这里要么是指名的那一位，要么本场只有一位在职教师（前面已拦下多位教师不指名的情况）
                            const uid = (Array.isArray(roster?.teacherUids) && roster.teacherUids.length
                                ? String(roster.teacherUids[0])
                                : ((current.teachers || []).find(p => courseSessionService.isActive(p.status)) || {}).uid);
                            if (uid) {
                                const pair = (current.teachers || []).find(p => String(p.uid) === String(uid)) || {};
                                const studentUid = ((current.students || [])[0] || {}).uid || null;
                                const before = FeeService.effectiveFeeOf(pair, studentUid);
                                // AI 一句话通常只提一项，另一项按原值回填：费用页是两项一起提交的，
                                // 这里把缺省那项当 null 写回去，等于顺手把别人的其他费用清了。
                                const tFee = fields.transportFee !== undefined
                                    ? FeeService.parseFeeAmount(fields.transportFee) : before.transport_fee;
                                const oFee = fields.otherFee !== undefined
                                    ? FeeService.parseFeeAmount(fields.otherFee) : before.other_fee;
                                const targetStatus = FeeService.hasFilledFee(tFee, oFee)
                                    ? resolveAutoFeeStatus('admin', pair.fee_status) : null;
                                await FeeService.updateScheduleFeesInTx(q, { sessionId: sid, teacherUid: uid }, {
                                    tFee, oFee, studentUid,
                                    oldTFee: before.transport_fee, oldOFee: before.other_fee,
                                    targetStatus, oldStatus: pair.fee_status,
                                    operatorId: req.user.id, operatorRole: 'admin'
                                });
                            }
                        }
                    }
                });

                // 提交之后再查冲突：不再持有事务连接，读到的也是已落库的新时段。
                // 逐场串行，峰值只占一条连接（POOL_MAX 在 serverless 下是 2）。
                for (const plan of pendingConflictChecks) {
                    updateConflicts.push(...await scheduleService.conflictLines(plan));
                }

                // 删除已执行的操作
                await aiOperationStore.deleteOperation(operationId);

                return {
                    type: 'text',
                    title: '修改成功',
                    data: {
                        message: `已成功修改 ${scheduleIds.length} 场课`
                            + (updateConflicts.length
                                ? `（注意：${updateConflicts.length} 处时段与现有排课重叠 —— ${updateConflicts.join('；')}）`
                                : ''),
                        scheduleIds,
                        conflictWarnings: updateConflicts,
                        changedFields: operation.changes.map(c => c.field).join('、')
                    }
                };

            } else if (operation.type === 'delete') {
                // 执行删除操作
                const { scheduleIds, reason } = operation;
                const isPairRemoval = Array.isArray(operation.removals) && operation.removals.length > 0;

                // removals 有值 = 只把指名的教师/学生移出本场，其余参与者保留；
                // 没有 = 删除整场（前三张审计表随 ON DELETE CASCADE 清理；
                // session_change_logs 无外键，会留下这次删除的整场快照）
                const removedSessions = [];
                if (Array.isArray(operation.removals) && operation.removals.length) {
                    const actor = { id: req.user.id, actorType: 'admin' };
                    for (const item of operation.removals) {
                        let current = await courseSessionService.getSessionById(item.sessionId);
                        if (!current) continue;
                        let version = Number(current.version);
                        const uidLists = [['teacher', item.teacherUids || []], ['student', item.studentUids || []]];
                        for (const [kind, uids] of uidLists) {
                            for (const uid of uids) {
                                const r = await courseSessionService.removePair(item.sessionId, kind, uid, actor, version);
                                if (r.session) { current = r.session; version = Number(current.version); }
                            }
                        }
                        removedSessions.push(item.sessionId);
                    }
                } else {
                    await courseSessionService.deleteSessions(scheduleIds, { id: req.user.id, actorType: 'admin' });
                }

                // 删除已执行的操作
                await aiOperationStore.deleteOperation(operationId);


                const deletedList = operation.schedules.map(row => {
                    return `${toDateKey(row.class_date)} ${row.start_time} ${row.teacher_name}-${row.student_name} ${row.course_type_cn}`;
                });

                return {
                    type: 'text',
                    title: isPairRemoval ? '移出成功' : '删除成功',
                    data: {
                        message: isPairRemoval
                            ? `已把指定教师/学生移出 ${removedSessions.length} 场课（其余参与者保留）`
                            : `已成功删除 ${scheduleIds.length} 场课（含本场全部教师与学生）`,
                        scheduleIds,
                        deletedSchedules: deletedList.slice(0, 5),
                        reason: reason || '未提供'
                    }
                };

            } else {
                throw new AppError({ code: 'BAD_REQUEST', message: '未知的操作类型' });
            }
        }

        default:
            throw new AppError({ code: 'BAD_REQUEST', message: `未知工具: ${toolName}` });
    }
}

/**
 * 读取「不限制」类整型环境变量。
 * @description 约定：**未配置 / 0 / 负数 一律表示不限制**，只有显式给出正整数才施加限制。
 *              这样默认行为就是「把模型的真实能力用满」，要收紧时再在 .env 里显式配。
 * @param {string} envKey
 * @param {number} fallback - 非法或缺失时的取值
 * @returns {number} 0 或负数表示不限制
 */
function limitFromEnv(envKey, fallback) {
    const raw = process.env[envKey];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * 将工具结果安全序列化为发给 LLM 的字符串。
 * 超长时不做字符硬截断（会破坏 JSON 且切断数据），改为按条数裁剪 + 明确标注省略数量，
 * 保证模型拿到的仍是合法可解析的 JSON，且知道数据被裁剪过。
 * @param {*} result
 * @param {number} maxLen - 最大字符数；<= 0 表示不限制（原样返回）。
 *                          默认取 AI_TOOL_RESULT_MAX_CHARS，未配置即不限制。
 */
function summarizeToolResult(result, maxLen = limitFromEnv('AI_TOOL_RESULT_MAX_CHARS', 0)) {
    let str = JSON.stringify(result);
    // 不限制：直接返回，不做任何裁剪
    if (!(maxLen > 0)) return str;
    if (str.length <= maxLen) return str;

    const cloned = JSON.parse(JSON.stringify(result));
    const data = cloned.data;

    // 找到结果中的数组字段（schedules / slots / 或 data 本身为数组），逐步裁剪条数
    const arrayHolders = [];
    if (Array.isArray(data)) {
        arrayHolders.push({ get: () => cloned.data, set: v => { cloned.data = v; } });
    } else if (data && typeof data === 'object') {
        for (const key of ['schedules', 'slots']) {
            if (Array.isArray(data[key])) {
                arrayHolders.push({ get: () => cloned.data[key], set: v => { cloned.data[key] = v; }, key });
            }
        }
    }

    for (const holder of arrayHolders) {
        const arr = holder.get();
        const original = arr.length;
        let kept = original;
        while (kept > 1) {
            kept = Math.floor(kept * 0.7);
            holder.set(arr.slice(0, kept));
            cloned._truncated = { field: holder.key || 'data', total: original, shown: kept, note: `共 ${original} 条，仅展示前 ${kept} 条，其余已省略` };
            str = JSON.stringify(cloned);
            if (str.length <= maxLen) return str;
        }
    }

    // 兜底：仍超长则整体标注（极少发生）
    return JSON.stringify({ type: cloned.type, title: cloned.title, _truncated: { note: '结果过大，已省略详情' } });
}

/** 模型能力缓存：{ mtimeMs, models } */
let _modelsCache = null;

/**
 * 解析「当前模型」的能力（vision / tools / reasoning）。
 * - 已知模型（ai-models.json 有记录）：返回其声明能力。
 * - 未知/自定义模型（无记录）：默认假设支持 tools（多数 OpenAI 兼容网关支持），
 *   vision/reasoning 保守为 false。真正的工具格式异常在调用处优雅降级。
 * @param {string} modelId
 * @returns {{vision:boolean, tools:boolean, reasoning:boolean, known:boolean}}
 */
/** 只取主机名用于日志；baseUrl 可能带路径，apiKey 一律不进日志 */
function safeHostOf(baseUrl) {
    try {
        return new URL(baseUrl).host;
    } catch (_) {
        return '(invalid)';
    }
}

function isWeakModel(modelId) {
    // 启发式：小型/flash/lite 类模型对复杂中文多步推理不稳定，批量排课需提示用户可切换更强模型。
    const id = String(modelId || '').toLowerCase();
    if (/large|medium|opus|sonnet|deepseek-v4/.test(id)) return false;
    return /small|flash|lite|mini|tiny|1\.5/.test(id);
}

function resolveModelCapabilities(modelId) {
    const fallback = { vision: false, tools: true, reasoning: false, _known: false, _weak: isWeakModel(modelId) };
    if (!modelId) return fallback;
    try {
        const modelsFilePath = path.join(__dirname, '../data/ai-models.json');
        const stat = fs.statSync(modelsFilePath);
        if (!_modelsCache || _modelsCache.mtimeMs !== stat.mtimeMs) {
            _modelsCache = { mtimeMs: stat.mtimeMs, models: JSON.parse(fs.readFileSync(modelsFilePath, 'utf8')) };
        }
        for (const models of Object.values(_modelsCache.models)) {
            const m = models.find(x => x.id === modelId);
            if (m && m.capabilities) {
                return {
                    vision: !!m.capabilities.vision,
                    tools: !!m.capabilities.tools,
                    reasoning: !!m.capabilities.reasoning,
                    _known: true,
                    _weak: isWeakModel(modelId)
                };
            }
        }
    } catch (_) { /* 读文件失败则走 fallback */ }
    return fallback;
}

/**
 * 工具名称 → 用户友好的进度消息
 */
function getToolProgressMessage(toolNames) {
    const messages = {
        query_teachers: '正在查询教师信息...',
        query_students: '正在查询学生信息...',
        query_schedules: '正在查询排课记录...',
        query_schedule_stats: '正在查询排课统计...',
        create_schedule_preview: '正在生成排课预览...',
        preview_schedule_update: '正在生成修改预览...',
        preview_schedule_deletion: '正在生成删除预览...',
        confirm_schedule_creation: '正在创建排课...',
        confirm_operation: '正在执行操作...',
    };
    const unique = [...new Set(toolNames)];
    const msgs = unique.map(n => messages[n]).filter(Boolean);
    return msgs.length > 0 ? msgs[0] : '正在处理数据...';
}

function writeSSEError(res, err, requestId) {
    const normalized = normalizeError(err);
    const payload = errorResponse(normalized, { requestId: requestId || null });
    res.write(`event: error\ndata: ${JSON.stringify({
        error: payload.error,
        meta: payload.meta
    })}\n\n`);
    return res.end();
}

/**
 * AI 数据查询主入口
 * POST /api/ai/query
 * body: { question: string, history?: array }
 */
const query = asyncHandler(async (req, res) => {
    if (!aiService.isAvailable()) {
        throw new AppError({ code: 'AI_NOT_CONFIGURED', message: 'AI 功能未启用，请联系管理员完成配置' });
    }

    const { question, history, action, images } = req.body;

    // action 为确认类敏感操作（创建/修改/删除排课的二次确认），走独立字段，不依赖自然语言文本
    const isAction = action && typeof action === 'object' && typeof action.type === 'string';

    if (!isAction && (!question || !question.trim())) {
        throw new AppError({ code: 'BAD_REQUEST', message: '请输入问题' });
    }

    // 输入长度验证（防止滥用 token 配额）
    if (question && question.length > 2000) {
        throw new AppError({ code: 'BAD_REQUEST', message: '问题长度不能超过 2000 个字符' });
    }
    if (history && Array.isArray(history) && history.length > 20) {
        throw new AppError({ code: 'BAD_REQUEST', message: '对话历史不能超过 20 条消息' });
    }

    // SSE 模式设置响应头
    const useStream = req.body.stream === true;

    const userType = req.user.userType;

    // 结构化日志：便于线上定位「没调工具/调错工具/截断/解析失败」哪一环
    const logPrefix = `[AI][${userType}#${req.user.id}]`;
    const log = (...args) => logger.log(logPrefix, ...args);
    log(isAction
        ? `action=${action.type}`
        : `question="${(question || '').slice(0, 120).replace(/\n/g, ' ')}" history=${Array.isArray(history) ? history.length : 0} images=${Array.isArray(images) ? images.length : 0}`);


    const tools = DATA_TOOLS[userType] || DATA_TOOLS.teacher;

    // 计算当前时间上下文（东八区）——统一走 computeDateContext，与 resolve_datetime 工具同源
    const {
        currentDateTime, currentWeekDay, todayStr,
        thisWeekDateMap, nextWeekDateMap
    } = computeDateContext();

    // 课程类型和教师名单决定后续工具参数是否合法；查询失败时不能让模型把故障误判为空数据。
    const [ctResult, tResult] = await Promise.all([
        db.query('SELECT name, description FROM schedule_types ORDER BY id'),
        db.query("SELECT name FROM teachers WHERE status=1 ORDER BY id")
    ]);
    const courseTypeListStr = ctResult.rows.map(r => `${r.name}（${r.description}）`).join(' | ');
    const teacherListStr = tResult.rows.map(r => r.name).join('、');

    const systemPrompt = userType === 'admin'
        ? `你是 Plenzo 课程管理系统的排课助手，全程用中文、简洁作答。你的职责是理解管理员的自然语言，调用工具完成查询与排课，绝不臆造数据。\n` +
          `\n============================\n` +
          `# 1. 当前时间（东八区 UTC+8，每周第一天是周一）\n` +
          `============================\n` +
          `现在：${currentDateTime}（${currentWeekDay}）\n` +
          `今日：${todayStr}\n` +
          `本周：${thisWeekDateMap}\n` +
          `下周：${nextWeekDateMap}\n` +
          `\n============================\n` +
          `# 2. 铁律（违反会导致错误，务必遵守）\n` +
          `============================\n` +
          `R1. 【日期时间】绝不自己心算日期。凡涉及"周几/下周/晚上/几点"等表述，一律调用 resolve_datetime(text:"原始表述") 让系统算出精确 date/startTime/endTime，再使用其返回值。\n` +
          `R2. 【人员ID】排课/改课前，必须先用 query_students / query_teachers 查到真实 ID。姓名以 # 4 名单为准：` +
          `输入里写成"周老师/侯老师"这类称呼时，先在名单里找同姓的实名再查，不要拿称呼原样去查（查不到就是不存在）。` +
          `查不到就停下来询问用户，禁止编造 ID 或姓名。\n` +
          `R3. 【课程类型】只能使用下方课程类型清单里的 name 字段，必须精确匹配，禁止臆造近似名（如清单里是"半次入户"，就不要写成"半程入户"）。\n` +
          `R4. 【写操作两步走】创建/修改/删除必须先生成预览，由用户点击确认按钮执行。你只负责生成预览；不要在文本里要求用户"回复确认"，确认由界面按钮完成。\n` +
          `R5. 【忠实执行】严格按用户输入排课，不擅自优化、增减、合并或跳过任何一条。信息缺失就询问，不猜测。\n` +
          `\n============================\n` +
          `# 3. 课程类型清单（name 字段，精确匹配）\n` +
          `============================\n` +
          (courseTypeListStr ? `${courseTypeListStr}\n` : '（暂无课程类型数据）\n') +
          `\n============================\n` +
          `# 4. 已有教师（精确匹配姓名，不存在则询问）\n` +
          `============================\n` +
          (teacherListStr ? `${teacherListStr}\n` : '（暂无教师数据）\n') +
          `\n============================\n` +
          `# 5. 工具清单\n` +
          `============================\n` +
          `查询类（直接调用，无需确认）：\n` +
          `· query_overview 总览 · query_schedules 排课列表 · query_teachers/query_students 教师/学生 · query_schedule_stats 统计\n` +
          `辅助类：\n` +
          `· resolve_datetime 把自然语言时间→精确日期时间（排课前必用）\n` +
          `· find_available_slots 查空闲时段\n` +
          `写操作类（生成预览，界面按钮确认）：\n` +
          `· create_schedule_preview 排课预览 · preview_schedule_update 改课预览 · preview_schedule_deletion 删课预览\n` +
          `\n============================\n` +
          `# 6. 排课流程（预览）\n` +
          `============================\n` +
          `输入格式A 单条："下周四，19-22，[地点]，[学生]，[教师]，[课程类型]"\n` +
          `输入格式B 批量（每行一条，括号内补充）："周一晚上 [学生]入户（[教师]，[地点]）"\n` +
          `括号里的内容顺序是任意的，按语义识别，不要按位置猜：\n` +
          `· 出现在 # 4 教师名单里的姓名 → 教师（一行里可以有几位，逗号/「和」/顿号分隔都算）\n` +
          `· 教师姓名后紧跟"记录"二字（如"周耀华记录"）→ 这位教师在本场课里的类型是评审记录/咨询记录\n` +
          `· 不在教师名单里的词（如"新课堂""老课堂"）→ 地点\n` +
          `· 形如"13-15点""一点到三点""14:00-17:00"→ 时间。调用 resolve_datetime 时把括号内外两处时间合在一起传（如"周日下午13-15点"），只传"周日下午"会得到系统默认的 14:00-17:00 而不是你要的时段\n` +
          `处理步骤：\n` +
          `(1) 逐条拆分输入：一行 = 一场课 = 一个 group，不合并不跳过。\n` +
          `(2) 对每条的时间表述调用 resolve_datetime 得到精确日期时间。\n` +
          `(3) 用 query_students / query_teachers 把昵称/姓名换成真实 ID。\n` +
          `(4) 组装 group：本场全部教师写进 teachers[]，每位教师一个 courseType；全部学生写进 students[]。\n` +
          `    多位教师共同参加同一节课 → 同一个 group 的 teachers[] 里的多个条目，**绝不按教师拆成多个 group**。\n` +
          `    "××记录"只改变那一位教师的 courseType，不新增一条课：评审与评审记录可以在同一场课里共存。\n` +
          `(5) 把所有条目组装成 groups 数组，一次性调用 create_schedule_preview(groups:[...])。\n` +
          `(6) 系统返回预览表格（一场课一行），交由用户点击"确认创建排课"按钮执行。\n` +
          `    预览结果里每行可能带 conflicts[]（与现有排课的时段冲突）与 conflictCount：有冲突就用一句话如实点出来` +
          `（谁、哪天几点到几点已被哪场课占着），提示用户可以改时段；**不要**自己替用户改时段、换教师或删掉那一条。\n` +
          `状态判定："待定/看情况/可能"→pending，其余→confirmed。\n` +
          `\n【正例】输入"周日下午 浩浩评审（新课堂，侯老师，高渊，金博，周耀华记录，13-15点）"：\n` +
          `  → resolve_datetime("周日下午13-15点") 得 date=周日, 13:00:00-15:00:00\n` +
          `  → query_students(nickname:"浩浩")；query_teachers 逐一取到 侯老师/高渊/金博/周耀华 的真实 ID\n` +
          `  → 一个 group、四位教师：create_schedule_preview(groups:[{teachers:[\n` +
          `      {teacherId:侯老师ID,courseType:"review"},{teacherId:高渊ID,courseType:"review"},\n` +
          `      {teacherId:金博ID,courseType:"review"},{teacherId:周耀华ID,courseType:"review_record"}],\n` +
          `      students:[{studentId:浩浩ID}], location:"新课堂", slots:[{date,startTime,endTime}]}])\n` +
          `  → 结果是「一场评审课、四位老师参加（其中周耀华是评审记录）」，不是四场课。\n` +
          `【正例·单师】输入"下周一晚上 浩浩入户（周耀华，新课堂）"：teachers 一个条目 courseType:"visit"。\n` +
          `【正例·同行两师】输入"下周一晚上 浩浩入户（图帕尔和周耀华，新课堂）"：\n` +
          `  → 同一个 group 的 teachers:[{teacherId:图帕尔ID,courseType:"visit"},{teacherId:周耀华ID,courseType:"visit"}]，仍是一场课。\n` +
          `【反例】不要直接写 create_schedule_preview 而跳过 resolve_datetime 或 query_students —— 会导致日期错、学生错。\n` +
          `【反例】不要因为某位教师是"记录"就为同一时段多开一场课；同一行的教师都属于同一场课。\n` +
          `\n============================\n` +
          `# 7. 一场课与 pair（增删改查共用同一套结构）\n` +
          `============================\n` +
          `一场课 = 一条记录 = 一个 group，里面有 1..N 位教师与 1..M 位学生；每位参与者是一个 pair，pair 有自己的 uid\n` +
          `（教师 t1、t2…；学生 s1、s2…），教师 pair 还各自带着自己的课程类型。\n` +
          `· 只有一位教师或一位学生也是这个结构，没有"单教师/单学生"的另一种写法。\n` +
          `· query_schedules 返回的就是这种合并行：teacher_name 是本场全部教师（记录教师标「（记录）」），\n` +
          `  teachers[] / students[] 里能取到每位参与者的 uid。\n` +
          `· 改课/删课要落到某一位参与者时，用它的 uid 传 teacherUid / studentUid（或删除时的 teacherUids / studentUids）；\n` +
          `  不传就是对整场课生效（本场全部在职 pair），系统不会替你猜某一位。\n` +
          `· 增删本场的参与者用 fields.teachers / fields.students 名册（替换语义：带 uid 的沿用、不带 uid 的新增、名册里没写的被移出）。\n` +
          `\n============================\n` +
          `# 8. 调整课程流程（改期/换教师/换地点，保留原记录归档）\n` +
          `============================\n` +
          `定义：「调整课程」= 将原课程记录标记为「已调整」状态(status=modified_away)，同时按新条件新建一门课程；原课程的教师、教室、学生、时间段等所有未被显式修改的属性保持不变，复制到新课程。\n` +
          `与普通改课的区别：普通改课（不带 status）直接覆盖原记录字段；调整课程（fields.status="modified_away"）` +
          `把本场在职教师逐个归档为 modified_away，并在**同一行内**追加 adjusted 增补 pair 承载新条件；` +
          `原记录不再占时段、不再计入统计，但可在「全部安排/报销单」视图回看。\n` +
          `后端处理逻辑（系统自动完成，你无需手写 SQL）：\n` +
          `1. 原 pair 类别位保留、生命周期位置为 modified_away；同一行追加 adjusted.pending；\n` +
          `2. 改了时段就把整场 header 搬到新时段（不另起一行，旧时段随即释放）；只有指名某一位教师且换时段，` +
          `那一位才另起新场次，其余教师留在原时段；\n` +
          `3. 归档、增补、搬移在同一个事务里，中途出错整批回滚，不会留下「原记录已归档但增补没写」的空洞；\n` +
          `4. 时段与其它课重叠**不会拦**：业务上允许一位教师/学生出现在重叠的两节课里，` +
          `预览行会标 ⚠，你如实提示用户即可，不要因为它而自行改时段或换教师。\n` +
          `何时使用（默认规则·关键）：只要对已有课程的【内容属性】做任何修改——改日期/改时间/换教师/换学生/换地点/换课程类型——一律走本「调整课程」，fields 必须带 status:"modified_away"。这是修改课程的默认方式，无需用户特意要求"保留痕迹"。\n` +
          `作用范围：调整默认对**整场课**生效 —— 本场全部在职教师归档，增补就在同一行内完成；` +
          `改了时段就把整场搬到新时段、旧时段随即释放（不会另起一条课，也不会两处都占着）。` +
          `只调某一位教师时传 teacherUid 指名那一位：时段也变的话，只有他另起新场次，其余教师留在原时段。\n` +
          `例外：仅当用户只修改【状态】本身（如 pending→confirmed、标记 completed/cancelled）且没有改任何内容属性时，才用 # 9 普通改课（不传 status，直接覆盖原记录）。\n` +
          `操作步骤：\n` +
          `(1) query_schedules 查到目标排课 ID。\n` +
          `(2) 涉及改时间时调用 resolve_datetime 得精确日期时间。\n` +
          `(3) preview_schedule_update(scheduleIds:[id], fields:{ 需修改的字段, status:"modified_away" }) 生成调整预览。\n` +
          `(4) 系统返回预览（原记录归档 + 新课程对比），交由用户点击确认按钮执行。\n` +
          `【正例】"把浩浩下周四 19-21 的入户调整到周五同一时段"：\n` +
          `  → query_schedules 找到该排课 id；resolve_datetime("下周五 19-21") 得 date=下周五, 19:00:00-21:30:00\n` +
          `  → preview_schedule_update(scheduleIds:[id], fields:{ classDate:"下周五", status:"modified_away" })\n` +
          `  → 确认后：原记录归档为已调整，新建一条下周五 19-21 的入户（教师/学生/地点等沿用原记录）。\n` +
          `【反例】不要用普通改课（不传 status）来"调整"——那会直接覆盖原记录，丢失原排课痕迹，且不会生成新课程。\n` +
          `\n============================\n` +
          `# 9. 改课 / 删课流程\n` +
          `============================\n` +
          `改课：query_schedules 查到目标 → preview_schedule_update(scheduleIds, fields) → 用户按钮确认。\n` +
          `  · 整场改（时间/地点/状态/全部教师的类型）不给 teacherUid；只改本场某一位教师时用 query_schedules 里该教师的 uid 传 teacherUid。\n` +
          `  · 加/减参与者用 fields.teachers / fields.students 名册（替换语义），不要把一个人的名册当成整场名册提交。\n` +
          `改费用：交通费/其他费用只有「这一趟只有一位学生」时才改得了；多位学生同上一趟课时一个数说不清属于谁，` +
          `请直接告诉用户去费用报销页逐位学生填写，不要重试。\n` +
          `  同场多位教师时也必须用 teacherUid 指明这笔钱记在哪位教师头上。\n` +
          `删课：query_schedules 查到目标 → preview_schedule_deletion(scheduleIds) → 用户按钮确认。\n` +
          `  · 只想把某一位教师或某一位学生从本场移出去（其余人保留）时，传 teacherUids / studentUids；不传就是删除整场课。\n` +
          `\n============================\n` +
          `# 10. 回复格式\n` +
          `============================\n` +
          `文本简短（1-2 句），不要长篇解释。表格数据由系统渲染，你无需在文本里重复罗列。\n` +
          `支持多轮上下文："他/那个"指代前文的教师/学生/课程；追问可补充信息（如先"取消浩浩周四的课"再"改成周五"=改期）。`
        : userType === 'student'
        ? `你是 Plenzo 课程管理系统 AI 助手，用中文简洁回答。\n` +
          `用户是学生 (id=${req.user.id})。\n` +
          `\n当前时间：${currentDateTime}（${currentWeekDay}），时区东八区(UTC+8)，每周第一天是周一。今日：${todayStr}\n` +
          `\n能力：\n` +
          `1. 回答系统一般性问题\n` +
          `2. 查询个人课程安排、学习统计等数据\n` +
          `\n可用工具：\n` +
          `- query_my_schedules：查询个人课表（支持按日期范围筛选）\n` +
          `- query_my_statistics：查询个人学习统计\n` +
          `- query_my_overview：查询个人总览\n` +
          `\n规则：数据查询务必调用工具，一般性对话可直接回答。工具失败说明原因。支持多轮上下文。`
        : `你是 Plenzo 课程管理系统 AI 助手，用中文简洁回答。\n` +
          `用户是教师 (id=${req.user.id})。\n` +
          `\n当前时间：${currentDateTime}（${currentWeekDay}），时区东八区(UTC+8)，每周第一天是周一。今日：${todayStr}\n` +
          `\n能力：\n` +
          `1. 回答系统一般性问题\n` +
          `2. 查询课程、学生等相关数据\n` +
          `\n可用工具：\n` +
          `- query_my_schedules：查询个人课表（支持按日期范围筛选）\n` +
          `- query_my_overview：查询个人总览\n` +
          `- query_students：查询学生列表（支持按姓名/昵称搜索）\n` +
          `\n规则：数据查询务必调用工具，一般性对话可直接回答。工具失败说明原因。支持多轮上下文。`;

    /* ============================================================
     * 确认类操作：独立 action 字段（不依赖 LLM，不再正则匹配自然语言）
     * 前端确认按钮发送 { action: { type, previewId | operationId } }
     * 兼容旧版：仍保留对 "确认创建排课 previewId: xxx" 文本的正则识别
     * ============================================================ */

    // 统一的确认创建处理
    const handleConfirmCreate = async (previewIdStr) => {
        const previewIds = String(previewIdStr).split(',').map(s => s.trim()).filter(Boolean);
        if (previewIds.length === 0) {
            throw new AppError({ code: 'BAD_REQUEST', message: '缺少排课预览 ID' });
        }

        const allInsertedIds = [];
        const failedPreviewIds = [];
        let firstError = null;
        for (const pid of previewIds) {
            try {
                const result = await executeDataTool('confirm_schedule_creation', { previewId: pid }, req);
                if (result.data && result.data.scheduleIds) {
                    allInsertedIds.push(...result.data.scheduleIds);
                }
            } catch (err) {
                if (!firstError) firstError = err;
                failedPreviewIds.push(pid);
                logger.warn('[AI][confirm_create] previewId 执行失败:', pid, err.message);
            }
        }
        if (allInsertedIds.length === 0 && firstError) throw firstError;

        const partial = failedPreviewIds.length > 0;
        const answerText = partial
            ? `部分排课创建成功：已创建 ${allInsertedIds.length} 条，${failedPreviewIds.length} 个预览创建失败`
            : `成功创建 ${allInsertedIds.length} 条排课记录`;
        return {
            type: 'text',
            answer: answerText,
            structuredData: {
                message: answerText,
                status: partial ? 'partial' : 'success',
                scheduleIds: allInsertedIds,
                failedPreviewIds
            },
            toolsUsed: ['confirm_schedule_creation']
        };
    };

    // 统一的确认操作（修改/删除）处理
    const handleConfirmOperation = async (operationId) => {
        const result = await executeDataTool('confirm_operation', { operationId }, req);
        const answerText = result.data.message || '操作执行成功';
        return {
            type: result.type || 'text',
            answer: answerText,
            structuredData: result.data,
            toolsUsed: ['confirm_operation']
        };
    };

    // 优先走结构化 action 字段
    if (action && action.type) {
        logger.log('[AI][query] action:', action.type, 'user:', req.user.id, req.user.userType);
        try {
            let responseData;
            if (action.type === 'confirm_create' && action.previewId) {
                responseData = await handleConfirmCreate(action.previewId);
            } else if (action.type === 'confirm_operation' && action.operationId) {
                responseData = await handleConfirmOperation(action.operationId);
            } else {
                throw new AppError({ code: 'BAD_REQUEST', message: '无效的确认操作参数' });
            }
            if (useStream) {
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no'
                });
                res.write(`data: ${JSON.stringify({ type: 'result', data: responseData })}\n\n`);
                return res.end();
            }
            return res.json(successResponse(responseData, { requestId: req.requestId }));
        } catch (err) {
            if (useStream && res.headersSent) {
                return writeSSEError(res, err, req.requestId);
            }
            throw err;
        }
    }

    // 兼容旧版：正则识别自然语言确认（question 为空的 action 请求不会走到这里）
    const confirmMatch = question && question.match(/确认创建排课.*previewId[:\s]+(\S+)/);
    if (confirmMatch) {
        const responseData = await handleConfirmCreate(confirmMatch[1]);
        if (useStream) {
            res.write(`data: ${JSON.stringify({ type: 'result', data: responseData })}\n\n`);
            return res.end();
        }
        return res.json(successResponse(responseData, { requestId: req.requestId }));
    }

    const confirmOpMatch = question && question.match(/确认执行操作.*operationId[:\s]+(\S+)/);
    if (confirmOpMatch) {
        const responseData = await handleConfirmOperation(confirmOpMatch[1]);
        if (useStream) {
            res.write(`data: ${JSON.stringify({ type: 'result', data: responseData })}\n\n`);
            return res.end();
        }
        return res.json(successResponse(responseData, { requestId: req.requestId }));
    }

    // 构建消息列表：系统提示 + 历史对话 + 当前问题
    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    // 添加历史对话（如果有）
    if (history && Array.isArray(history) && history.length > 0) {
        // AI_HISTORY_TURNS：只保留最近 N 轮；未配置 / <=0 表示不限制，全部保留。
        // 上下文窗口（agnes-3.0-flash 为 512K）足够大时，交给模型自己处理即可。
        const maxTurns = limitFromEnv('AI_HISTORY_TURNS', 0);
        const recentHistory = maxTurns > 0 ? history.slice(-maxTurns) : history;
        messages.push(...recentHistory);
    }

    // 浏览器本地新增的模型/端点（仅自己、不落库）：由客户端随请求带上，优先级最高。
    // 地址不安全时直接 400，不静默回退——否则用户会以为自己用的是本地配置。
    const customOverride = await aiConfigService.resolveCustomConfig(req.body.customConfig);
    if (customOverride) {
        // 只记来源与模型，绝不记 apiKey
        log(`customConfig model=${customOverride.model} base=${safeHostOf(customOverride.baseUrl)}`);
    }

    // 用户自选模型（仅本人会话生效）：未自选时为 null，后续全部走全局配置。
    // 必须在能力判定之前解析——否则会用全局模型的能力去决定是否发图/挂工具，
    // 与真正调用的模型不一致。
    const userOverride = customOverride
        ? null
        : await aiConfigService.resolveUserConfig(req.user?.userType, req.user?.id).catch(err => {
            log(`resolve user model FAILED, fallback to global: ${err.message}`);
            return null;
        });
    const effectiveOverride = customOverride || userOverride;
    const chatOptions = effectiveOverride ? { configOverride: effectiveOverride } : {};

    // 模型能力：提前计算，供多模态 content 构造与后续工具分流共用
    const currentModel = effectiveOverride ? effectiveOverride.model : aiService.getAIConfig().model;
    const caps = resolveModelCapabilities(currentModel);

    // 校验并规整当前轮图片（仅 data URL / http(s)），最多 5 张
    const rawImages = Array.isArray(images) ? images.filter(u => typeof u === 'string' && /^(data:image\/|https?:\/\/)/.test(u)).slice(0, 5) : [];
    const hasImages = rawImages.length > 0;

    // 添加当前问题（注入日期上下文，确保 AI 不会忽略系统提示中的日期映射）
    const dateContext = `[日期参考] 今日：${todayStr}（${currentWeekDay}）| 本周：${thisWeekDateMap} | 下周：${nextWeekDateMap}\n\n`;
    const questionText = dateContext + (question || '请分析这些图片');

    if (hasImages && caps.vision) {
        // 多模态：当前轮构造 OpenAI 形状的 content 块数组（aiService 内部会按协议翻译）
        messages.push({
            role: 'user',
            content: [
                { type: 'text', text: questionText },
                ...rawImages.map(url => ({ type: 'image_url', image_url: { url } }))
            ]
        });
    } else {
        if (hasImages && !caps.vision) {
            // 收到图片但模型不支持：明确告知，不静默丢弃
            messages[0].content += `\n\n【提示】用户上传了图片，但当前模型不支持图像理解，请说明需在系统设置切换到支持图像（vision）的模型。`;
        }
        messages.push({ role: 'user', content: questionText });
    }

    const toolsUsed = [];
    const toolResults = [];

    try {
    // SSE 模式设置响应头（在 try 块内，确保错误能被正确处理）
    if (useStream) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        });
    }

    // SSE 辅助函数
    const sendSSE = useStream ? (eventType, payload) => {
        res.write(`data: ${JSON.stringify({ type: eventType, ...payload })}\n\n`);
    } : () => {};

    // 模型能力自适应：不支持 function-calling 的模型不传 tools，走纯问答降级，
    // 避免给它发工具定义导致返回乱掉（用户可在前台自由切换模型，含无工具能力的弱模型）。
    // currentModel / caps 已在上方消息构造处计算。
    const toolsEnabled = caps.tools !== false;
    log(`model=${currentModel} toolsEnabled=${toolsEnabled} known=${caps._known} vision=${caps.vision} images=${rawImages.length}`);

    const chatTools = toolsEnabled ? tools : undefined;
    if (!toolsEnabled) {
        // 明确告知模型当前不具备工具能力，只做一般性问答，避免它假装能排课
        messages[0].content += `\n\n【降级提示】当前模型不支持工具调用，你只能进行一般性问答，无法查询数据或排课。若用户要求排课或查数据，请说明需在系统设置中切换到支持工具的模型（如 Mistral Large / DeepSeek V4）。`;
    }

    // 第一轮：让 LLM 决定调用哪些工具
    sendSSE('progress', { step: 'thinking', message: '正在分析您的问题...' });
    let llmResp = await aiService.chat(messages, chatTools ? { ...chatOptions, tools: chatTools, toolChoice: 'auto' } : chatOptions);
    let toolCalls = toolsEnabled ? aiService.extractToolCalls(llmResp) : [];

    // 循环执行工具调用（AI_MAX_TOOL_ROUNDS 轮，支持智能排课的多步操作；
    // 未配置 / <=0 表示不限制轮数，由模型自行决定何时停止调用工具）
    const maxToolRounds = limitFromEnv('AI_MAX_TOOL_ROUNDS', 0);
    let rounds = 0;
    while (toolsEnabled && toolCalls.length > 0 && (maxToolRounds <= 0 || rounds < maxToolRounds)) {
        rounds++;
        messages.push(llmResp.choices[0].message);

        // 发送工具执行进度
        const toolNames = toolCalls.map(t => t.function.name);
        sendSSE('progress', { step: 'executing', message: getToolProgressMessage(toolNames) });

        log(`round ${rounds} tools: ${toolNames.join(', ')}`);

        // 并行执行所有工具调用
        const toolCallResults = await Promise.all(toolCalls.map(async (call) => {
            const name = call.function.name;
            let args;
            try {
                args = JSON.parse(call.function.arguments || '{}');
            } catch (err) {
                throw new AppError({
                    code: 'AI_UPSTREAM_BAD_RESPONSE',
                    message: 'AI 返回的工具参数不是有效 JSON',
                    cause: err
                });
            }
            toolsUsed.push(name);

            try {
                const result = await executeDataTool(name, args, req);
                toolResults.push({ tool: name, args, result });
                // 超长结果做「结构化摘要」而非字符硬切，保证回传给模型的 JSON 仍合法可解析
                return { role: 'tool', tool_call_id: call.id, content: summarizeToolResult(result) };
            } catch (err) {
                log(`round ${rounds} tool "${name}" FAILED: ${err.message}`);
                throw err;
            }
        }));
        messages.push(...toolCallResults);

        sendSSE('progress', { step: 'thinking', message: '正在整理结果...' });
        llmResp = await aiService.chat(messages, { ...chatOptions, tools: chatTools, toolChoice: 'auto' });
        toolCalls = aiService.extractToolCalls(llmResp);
    }

    let answer = aiService.extractText(llmResp) || '抱歉，我暂时无法回答这个问题。';
    log(`done: rounds=${rounds} toolsUsed=[${toolsUsed.join(',')}] answerLen=${answer.length}`);

    // 阶段3.3：批量排课 + 弱模型时，附带切换建议（后端兜底逻辑照常执行，不阻塞）。
    // 判定「批量」：输入含多行排课，或本轮生成了多个预览分组。
    const looksLikeBatch = !isAction && typeof question === 'string' &&
        (question.split('\n').filter(l => l.trim()).length >= 3 ||
         toolResults.filter(r => r.result.type === 'schedule_preview').length > 1);
    if (looksLikeBatch && caps._weak) {
        answer += `\n\n（提示：批量排课较复杂，当前模型能力有限，如遇解析不准可在系统设置切换到更强模型，如 Mistral Large / DeepSeek V4，获得更稳定结果。）`;
    }

    // 判断返回类型（基于工具结果）
    let responseType = 'text';
    let structuredData = null;

    if (toolResults.length > 0) {
        const lastResult = toolResults[toolResults.length - 1].result;
        if (lastResult.type) {
            responseType = lastResult.type;
            structuredData = lastResult.data;
        }

        // 合并多个 schedule_preview 结果（批量排课场景）
        const previewResults = toolResults.filter(r => r.result.type === 'schedule_preview');
        if (previewResults.length > 1) {
            responseType = 'schedule_preview';
            const allSchedules = [];
            const previewIds = [];
            let totalTeacher = '';
            let totalStudent = '';
            let totalCourseType = '';
            let totalConflicts = 0;

            for (const pr of previewResults) {
                const d = pr.result.data;
                if (d.schedules) allSchedules.push(...d.schedules);
                if (d.previewId) previewIds.push(d.previewId);
                if (d.teacher) totalTeacher = d.teacher;
                if (d.student) totalStudent = d.student;
                if (d.courseType) totalCourseType = d.courseType;
                // 一次回合里模型分好几次建预览时，头部的「N 处重叠」必须跟着合并，
                // 否则行内 ⚠ 还在、横幅却消失了。单份结果没给计数就按行自己数。
                const own = Number(d.conflictCount);
                totalConflicts += Number.isFinite(own) ? own
                    : (d.schedules || []).filter(s => Array.isArray(s.conflicts) && s.conflicts.length > 0).length;
            }

            structuredData = {
                previewId: previewIds.join(','),  // 多个 previewId 用逗号分隔
                teacher: totalTeacher,
                student: totalStudent,
                courseType: totalCourseType,
                conflictCount: totalConflicts,
                totalCount: allSchedules.length,
                schedules: allSchedules
            };
        }
    }

    if (useStream) {
        sendSSE('progress', { step: 'done', message: '完成' });
        res.write(`data: ${JSON.stringify({ type: 'result', data: { type: responseType, answer, structuredData, toolsUsed } })}\n\n`);
        res.end();
    } else {
        res.json(successResponse({
            type: responseType,
            answer,
            structuredData,
            toolsUsed
        }, { requestId: req.requestId }));
    }

    } catch (err) {
        if (useStream && res.headersSent) {
            try {
                return writeSSEError(res, err, req.requestId);
            } catch (_) {
                try { return res.end(); } catch (_) { return undefined; }
            }
        }
        throw err;
    }
});

/**
 * 获取当前 AI 配置
 * GET /api/ai/config
 */
const getConfig = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.getConfig();
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 获取预设 AI 模型列表
 * GET /api/ai/presets
 */
const getPresets = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.getPresets();
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 更新 AI 配置
 * PUT /api/ai/config
 */
const updateConfig = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.updateConfig(req);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 检测 AI 模型状态（快速检测）
 * POST /api/ai/check
 */
const checkModel = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.checkModel(req);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 测试 AI 模型连接
 * POST /api/ai/test
 */
const testModel = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.testModel(req);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 获取所有渠道支持的模型列表
 * GET /api/ai/models
 */
const getAvailableModels = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.getAvailableModels();
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 获取当前模型的能力信息
 * GET /api/ai/capabilities
 */
const getModelCapabilities = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.getModelCapabilities(req.user?.userType, req.user?.id);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 获取当前用户可选的 AI 模型清单
 * GET /api/ai/selectable-models
 */
const getSelectableModels = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.getSelectableModels(req.user?.userType, req.user?.id);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 读取当前用户自选的模型
 * GET /api/ai/my-model
 */
const getMyModel = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.getMyModel(req.user?.userType, req.user?.id);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 设置当前用户自选的模型（仅对本人会话生效）
 * PUT /api/ai/my-model
 */
const setMyModel = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.setMyModel(req.user?.userType, req.user?.id, req.body);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 验通候选模型但不保存（仅对本人会话生效）
 * POST /api/ai/my-model/check
 */
const checkMyModel = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.verifyUserModel(req.body);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 恢复为系统默认模型
 * DELETE /api/ai/my-model
 */
const clearMyModel = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.clearMyModel(req.user?.userType, req.user?.id);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 渠道 → 端点 → 模型 树
 * GET /api/ai/endpoints
 */
const getEndpoints = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.listEndpoints(req.query.channelId);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 新增端点
 * POST /api/ai/endpoints
 */
const createEndpoint = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.createEndpoint(req.body);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 更新端点（id 可为数据库主键，或 env 种子的 env:LLM2:1）
 * PUT /api/ai/endpoints/:id
 */
const updateEndpoint = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.updateEndpoint(req.params.id, req.body);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 删除端点（仅数据库行；env 种子端点只能停用）
 * DELETE /api/ai/endpoints/:id
 */
const deleteEndpoint = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.deleteEndpoint(req.params.id);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

/**
 * 测试端点连通性
 * POST /api/ai/endpoints/:id/test
 */
const testEndpoint = asyncHandler(async (req, res) => {
    const { status, body } = await aiConfigService.testEndpoint(req.params.id, req.body && req.body.modelId);
    return res.status(status).json(successResponse(body.data, { requestId: req.requestId }));
});

module.exports = {
    getStatus,
    query,
    getConfig,
    getPresets,
    updateConfig,
    checkModel,
    testModel,
    getAvailableModels,
    getModelCapabilities,
    getSelectableModels,
    getMyModel,
    setMyModel,
    checkMyModel,
    clearMyModel,
    getEndpoints,
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    testEndpoint,
    // 内部纯函数导出（仅供单元测试使用）
    _test: {
        computeDateContext,
        getDayOfWeek,
        resolveDateTime,
        parseClock,
        summarizeToolResult,
        isWeakModel,
        resolveModelCapabilities,
        // 集成测试用：驱动 preview_schedule_update / confirm_operation 完整链路
        executeDataTool,
        aiOperationStore
    }
};
