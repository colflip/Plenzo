/**
 * AI 控制器 (AI Controller) - 全新重构版本
 * @description 处理 AI 相关请求：数据查询、智能排课
 * @module controllers/aiController
 */

const { standardResponse } = require('../middleware/validation');
const { AppError, asyncHandler } = require('../middleware/error');
const aiService = require('../services/aiService');
const db = require('../db/db');
const scheduleService = require('../services/scheduleService');
const { getPresetModels } = require('../services/presetModels');
const aiConfigManager = require('../services/aiConfigManager');
const fs = require('fs');
const path = require('path');

/**
 * AI 功能状态检查
 * GET /api/ai/status
 */
const getStatus = (req, res) => {
    res.json(standardResponse(true, {
        enabled: aiService.isAvailable(),
        provider: aiService.getAIConfig().provider,
        role: req.user?.userType
    }, 'ok'));
};

/**
 * 状态的中英文映射（统一使用 sharedUtils.STATUS_MAP 作为权威来源）
 */
const { STATUS_MAP: STATUS_MAPPING, getStatusLabel: translateStatus } = require('../utils/sharedUtils');

/**
 * 课程类型映射缓存
 */
let courseTypeCache = null;

/**
 * 从数据库加载课程类型映射
 */
async function loadCourseTypeMapping() {
    if (courseTypeCache) return courseTypeCache;
    try {
        const result = await db.query('SELECT name, description FROM schedule_types ORDER BY id;');
        courseTypeCache = {};
        result.rows.forEach(row => {
            courseTypeCache[row.name] = row.description;
        });
        return courseTypeCache;
    } catch (err) {
        return {};
    }
}

/**
 * 翻译课程类型（从数据库）
 */
async function translateCourseType(type) {
    const mapping = await loadCourseTypeMapping();
    return mapping[type] || type;
}

/**
 * 获取日期对应的星期几（中文）
 * @param {string} dateStr - YYYY-MM-DD
 * @returns {string} 周一~周日
 */
function getDayOfWeek(dateStr) {
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const d = new Date(dateStr + 'T00:00:00+08:00');
    return days[d.getDay()];
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
    const today = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
    const dayOfWeek = today.getDay(); // 0=周日, 1=周一
    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

    const currentDateTime = today.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    });
    const currentWeekDay = weekDays[dayOfWeek];
    const todayStr = today.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });

    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const thisMonday = new Date(today);
    thisMonday.setDate(today.getDate() + mondayOffset);
    const nextMonday = new Date(thisMonday);
    nextMonday.setDate(thisMonday.getDate() + 7);

    const cnDays = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const buildWeek = (monday) => {
        const map = {};
        for (let i = 0; i < 7; i++) {
            const d = new Date(monday);
            d.setDate(monday.getDate() + i);
            map[cnDays[i]] = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
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
    晚上: { startTime: '19:00:00', endTime: '21:45:00' }
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
                description: '查询排课列表，支持按教师、学生、日期范围、状态筛选',
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
                description: '根据可用时段生成排课预览方案。支持两种模式：\n' +
                    '1. 单组模式：传 teacherId+studentId+courseType+slots\n' +
                    '2. 批量模式：传 groups 数组（多教师多课程一次性预览，表格自动排序）',
                parameters: {
                    type: 'object',
                    properties: {
                        teacherId: { type: 'integer', description: '教师ID（单组模式）' },
                        studentId: { type: 'integer', description: '学生ID（单组模式）' },
                        courseType: { type: 'string', description: '课程类型名称（单组模式）' },
                        location: { type: 'string', description: '上课地点（单组模式）' },
                        slots: {
                            type: 'array',
                            description: '时段列表（单组模式）',
                            items: {
                                type: 'object',
                                properties: {
                                    date: { type: 'string', description: 'YYYY-MM-DD' },
                                    startTime: { type: 'string', description: 'HH:MM:SS' },
                                    endTime: { type: 'string', description: 'HH:MM:SS' }
                                },
                                required: ['date', 'startTime', 'endTime']
                            }
                        },
                        groups: {
                            type: 'array',
                            description: '批量排课分组（批量模式，用于评审/咨询等多教师场景）',
                            items: {
                                type: 'object',
                                properties: {
                                    teacherId: { type: 'integer', description: '教师ID' },
                                    studentId: { type: 'integer', description: '学生ID' },
                                    courseType: { type: 'string', description: '课程类型name字段（如 visit/review/review_record 等）' },
                                    location: { type: 'string', description: '上课地点' },
                                    slots: {
                                        type: 'array',
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
                                required: ['teacherId', 'studentId', 'courseType', 'slots']
                            }
                        }
                    }
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
                description: '【第1步】预览排课修改：查看修改前后的对比，生成操作ID供确认。',
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
                                teacherId: { type: 'integer', description: '新教师ID' },
                                studentId: { type: 'integer', description: '新学生ID' },
                                classDate: { type: 'string', description: '新日期 YYYY-MM-DD' },
                                startTime: { type: 'string', description: '新开始时间 HH:MM:SS' },
                                endTime: { type: 'string', description: '新结束时间 HH:MM:SS' },
                                status: { type: 'string', enum: ['pending', 'confirmed', 'cancelled', 'completed', 'modified_away'], description: '新状态' },
                                courseType: { type: 'string', description: '新课程类型名称（name字段）：visit/half_visit/review/review_record/consultation/consultation_record/trial/group_activity等' },
                                location: { type: 'string', description: '新地点（如：新课堂、老课堂等）' },
                                familyParticipants: { type: 'integer', description: '家长参与人数' },
                                transportFee: { type: 'number', description: '交通费' },
                                otherFee: { type: 'number', description: '其他费用' }
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
                description: '【第1步】预览排课删除：查看要删除的排课详情，生成操作ID供确认。',
                parameters: {
                    type: 'object',
                    properties: {
                        scheduleIds: {
                            type: 'array',
                            items: { type: 'integer' },
                            description: '要删除的排课ID列表（可以是一个或多个）'
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

    switch (toolName) {
        case 'query_overview': {
            if (userType !== 'admin') throw new AppError('权限不足', 403);

            const [teachers, students, monthSchedules, pending] = await Promise.all([
                db.query('SELECT COUNT(*) as count FROM teachers WHERE status=1'),
                db.query('SELECT COUNT(*) as count FROM students WHERE status=1'),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)
                    AND EXTRACT(MONTH FROM class_date)=EXTRACT(MONTH FROM CURRENT_DATE)`),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE status='pending'`)
            ]);

            return {
                type: 'data_table',
                title: '系统总览',
                data: {
                    teacherCount: parseInt(teachers.rows[0].count),
                    studentCount: parseInt(students.rows[0].count),
                    monthSchedules: parseInt(monthSchedules.rows[0].count),
                    pendingSchedules: parseInt(pending.rows[0].count)
                }
            };
        }

        case 'query_schedules': {
            if (userType !== 'admin') throw new AppError('权限不足', 403);

            let query = 'SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status, ' +
                       't.name as teacher_name, s.name as student_name, st.name as course_type ' +
                       'FROM course_arrangement ca ' +
                       'JOIN teachers t ON ca.teacher_id=t.id ' +
                       'JOIN students s ON ca.student_id=s.id ' +
                       'JOIN schedule_types st ON ca.course_id=st.id WHERE 1=1';
            const params = [];
            let paramCount = 1;

            if (args.teacherId) {
                query += ` AND ca.teacher_id=$${paramCount++}`;
                params.push(args.teacherId);
            }
            if (args.studentId) {
                query += ` AND ca.student_id=$${paramCount++}`;
                params.push(args.studentId);
            }
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
                title: '排课列表',
                data: translatedData
            };
        }

        case 'query_teachers': {
            if (userType !== 'admin') throw new AppError('权限不足', 403);

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
            if (userType !== 'admin') throw new AppError('权限不足', 403);

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
            if (userType !== 'admin') throw new AppError('权限不足', 403);

            const { dimension, startDate, endDate } = args;
            let query, params = [];

            if (dimension === 'type') {
                query = `SELECT st.name as category, COUNT(*) as count
                        FROM course_arrangement ca
                        JOIN schedule_types st ON ca.course_id=st.id
                        WHERE 1=1`;
            } else if (dimension === 'teacher') {
                query = `SELECT t.name as category, COUNT(*) as count
                        FROM course_arrangement ca
                        JOIN teachers t ON ca.teacher_id=t.id
                        WHERE 1=1`;
            } else {
                query = `SELECT s.name as category, COUNT(*) as count
                        FROM course_arrangement ca
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

            query += ' GROUP BY category ORDER BY count DESC LIMIT 20';
            const result = await db.query(query, params);

            return {
                type: 'chart_data',
                title: `按${dimension === 'type' ? '课程类型' : dimension === 'teacher' ? '教师' : '学生'}统计`,
                data: result.rows
            };
        }

        case 'query_my_overview': {
            if (userType !== 'teacher' && userType !== 'student') throw new AppError('仅教师和学生可查询', 403);

            const idField = userType === 'teacher' ? 'teacher_id' : 'student_id';

            const [week, month, year, pending, confirmed, cancelled] = await Promise.all([
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE ${idField}=$1 AND class_date>=CURRENT_DATE-7`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE ${idField}=$1 AND EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)
                    AND EXTRACT(MONTH FROM class_date)=EXTRACT(MONTH FROM CURRENT_DATE)`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement
                    WHERE ${idField}=$1 AND EXTRACT(YEAR FROM class_date)=EXTRACT(YEAR FROM CURRENT_DATE)`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE ${idField}=$1 AND status='pending'`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE ${idField}=$1 AND status='confirmed'`, [userId]),
                db.query(`SELECT COUNT(*) as count FROM course_arrangement WHERE ${idField}=$1 AND status='cancelled'`, [userId])
            ]);

            return {
                type: 'data_table',
                title: '我的总览',
                data: {
                    weekSchedules: parseInt(week.rows[0].count),
                    monthSchedules: parseInt(month.rows[0].count),
                    yearSchedules: parseInt(year.rows[0].count),
                    pending: parseInt(pending.rows[0].count),
                    confirmed: parseInt(confirmed.rows[0].count),
                    cancelled: parseInt(cancelled.rows[0].count)
                }
            };
        }

        case 'query_my_schedules': {
            if (userType !== 'teacher' && userType !== 'student') throw new AppError('仅教师和学生可查询', 403);

            const idField = userType === 'teacher' ? 'teacher_id' : 'student_id';
            const joinField = userType === 'teacher' ? 's.name as student_name' : 't.name as teacher_name';

            let query = `SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status,
                        ${joinField}, st.name as course_type
                        FROM course_arrangement ca
                        JOIN teachers t ON ca.teacher_id=t.id
                        JOIN students s ON ca.student_id=s.id
                        JOIN schedule_types st ON ca.course_id=st.id
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
            if (userType !== 'student') throw new AppError('仅学生可查询学习统计', 403);

            // 默认查询最近3个月
            const startDate = args.startDate || new Date(new Date().setMonth(new Date().getMonth() - 3)).toISOString().split('T')[0];
            const endDate = args.endDate || new Date().toISOString().split('T')[0];

            const [typeStats, monthlyStats] = await Promise.all([
                db.query(`SELECT st.name as category, st.description as category_cn, COUNT(*) as count
                    FROM course_arrangement ca
                    JOIN schedule_types st ON ca.course_id=st.id
                    WHERE ca.student_id=$1 AND ca.class_date>=$2 AND ca.class_date<=$3
                    GROUP BY st.name, st.description ORDER BY count DESC`, [userId, startDate, endDate]),
                db.query(`SELECT TO_CHAR(ca.class_date, 'YYYY-MM') as month, COUNT(*) as count
                    FROM course_arrangement ca
                    WHERE ca.student_id=$1 AND ca.class_date>=$2 AND ca.class_date<=$3
                    GROUP BY month ORDER BY month`, [userId, startDate, endDate])
            ]);

            return {
                type: 'chart_data',
                title: '学习统计',
                data: {
                    typeStats: typeStats.rows,
                    monthlyStats: monthlyStats.rows,
                    period: { startDate, endDate }
                }
            };
        }

        case 'resolve_datetime': {
            if (userType !== 'admin') throw new AppError('仅管理员可解析排课时间', 403);
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
            if (userType !== 'admin') throw new AppError('仅管理员可查找时段', 403);

            const { teacherId, studentId, startDate, endDate, preferredDays, duration = 2 } = args;

            // 验证教师和学生存在
            const [teacher, student] = await Promise.all([
                db.query('SELECT id, name FROM teachers WHERE id=$1 AND status=1', [teacherId]),
                db.query('SELECT id, name FROM students WHERE id=$1 AND status=1', [studentId])
            ]);

            if (teacher.rows.length === 0) throw new AppError(`教师 ID ${teacherId} 不存在或已禁用`, 404);
            if (student.rows.length === 0) throw new AppError(`学生 ID ${studentId} 不存在或已禁用`, 404);

            // 查询指定日期范围内的已有排课
            const existingSchedules = await db.query(
                `SELECT class_date, start_time, end_time
                 FROM course_arrangement
                 WHERE (teacher_id=$1 OR student_id=$2)
                 AND class_date BETWEEN $3 AND $4
                 AND status != 'cancelled'
                 ORDER BY class_date, start_time`,
                [teacherId, studentId, startDate, endDate]
            );

            // 生成日期范围
            const start = new Date(startDate);
            const end = new Date(endDate);
            const availableSlots = [];

            // 工作时间段定义（可配置）
            const workingHours = [
                { start: '09:00:00', end: '12:00:00' },
                { start: '14:00:00', end: '18:00:00' },
                { start: '19:00:00', end: '22:00:00' }
            ];

            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().split('T')[0];
                const dayOfWeek = d.getDay() === 0 ? 7 : d.getDay(); // 转换为 1-7

                // 如果指定了偏好星期，跳过非偏好日期
                if (preferredDays && preferredDays.length > 0 && !preferredDays.includes(dayOfWeek)) {
                    continue;
                }

                // 该日期的已有排课
                const daySchedules = existingSchedules.rows.filter(s =>
                    s.class_date.toISOString().split('T')[0] === dateStr
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
            if (userType !== 'admin') throw new AppError('仅管理员可创建排课', 403);

            const { groups } = args;
            const isBatch = Array.isArray(groups) && groups.length > 0;

            // 统一为 groups 格式
            const normalizedGroups = isBatch ? groups : [{
                teacherId: args.teacherId,
                studentId: args.studentId,
                courseType: args.courseType,
                location: args.location,
                slots: args.slots
            }];

            // 收集所有唯一ID，批量预加载（避免 N+1 查询）
            const teacherIds = [...new Set(normalizedGroups.map(g => g.teacherId).filter(Boolean))];
            const studentIds = [...new Set(normalizedGroups.map(g => g.studentId).filter(Boolean))];
            const courseTypeNames = [...new Set(normalizedGroups.map(g => g.courseType).filter(Boolean))];

            const [teachersResult, studentsResult, courseTypesResult] = await Promise.all([
                teacherIds.length ? db.query('SELECT id, name FROM teachers WHERE id=ANY($1) AND status=1', [teacherIds]) : { rows: [] },
                studentIds.length ? db.query('SELECT id, name FROM students WHERE id=ANY($1) AND status=1', [studentIds]) : { rows: [] },
                courseTypeNames.length ? db.query('SELECT id, name, description FROM schedule_types WHERE name=ANY($1)', [courseTypeNames]) : { rows: [] }
            ]);

            const teacherMap = Object.fromEntries(teachersResult.rows.map(r => [r.id, r]));
            const studentMap = Object.fromEntries(studentsResult.rows.map(r => [r.id, r]));
            const courseTypeMap = Object.fromEntries(courseTypesResult.rows.map(r => [r.name, r]));

            // 验证并收集所有排课数据
            const allSchedules = [];
            const previewGroups = [];

            for (const group of normalizedGroups) {
                const { teacherId, studentId, courseType, location, slots } = group;
                if (!teacherId || !studentId || !courseType || !slots?.length) continue;

                const teacher = teacherMap[teacherId];
                const student = studentMap[studentId];
                if (!teacher) throw new AppError(`教师 ID ${teacherId} 不存在或已禁用`, 404);
                if (!student) throw new AppError(`学生 ID ${studentId} 不存在或已禁用`, 404);

                const courseTypeRow = courseTypeMap[courseType];
                if (!courseTypeRow) throw new AppError(`课程类型 ${courseType} 不存在`, 404);

                const courseId = courseTypeRow.id;
                const courseTypeCn = courseTypeRow.description || courseType;

                previewGroups.push({
                    teacherId, studentId, courseId,
                    teacherName: teacher.name,
                    studentName: student.name,
                    courseTypeCn, location: location || null,
                    slots: slots.map(s => ({ date: s.date, startTime: s.startTime, endTime: s.endTime, status: s.status }))
                });

                for (const slot of slots) {
                    allSchedules.push({
                        class_date: slot.date,
                        day_of_week: getDayOfWeek(slot.date),
                        start_time: slot.startTime,
                        end_time: slot.endTime,
                        teacher_id: teacher.id,
                        teacher_name: teacher.name,
                        student_name: student.name,
                        course_type_cn: courseTypeCn,
                        location: location || null,
                        status: slot.status || 'confirmed',
                        status_cn: slot.status === 'pending' ? '待确认' : '已确认'
                    });
                }
            }

            // 按日期和时间排序
            allSchedules.sort((a, b) => `${a.class_date} ${a.start_time}`.localeCompare(`${b.class_date} ${b.start_time}`));

            // 生成预览ID
            const previewId = `preview_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            schedulePreviewStore.set(previewId, { previewId, groups: previewGroups, createdAt: new Date().toISOString() });
            setTimeout(() => schedulePreviewStore.delete(previewId), 5 * 60 * 1000);

            const uniqueTeachers = [...new Set(previewGroups.map(g => g.teacherName))];
            const uniqueStudents = [...new Set(previewGroups.map(g => g.studentName))];
            const uniqueCourses = [...new Set(previewGroups.map(g => g.courseTypeCn))];

            return {
                type: 'schedule_preview',
                title: '排课预览方案',
                data: {
                    previewId,
                    teacher: uniqueTeachers.join('、'),
                    student: uniqueStudents.join('、'),
                    courseType: uniqueCourses.join('、'),
                    totalCount: allSchedules.length,
                    schedules: allSchedules
                }
            };
        }

        case 'confirm_schedule_creation': {
            if (userType !== 'admin') throw new AppError('仅管理员可创建排课', 403);

            const { previewId } = args;

            // 从存储中获取预览数据
            const previewData = schedulePreviewStore.get(previewId);
            if (!previewData) {
                throw new AppError('预览方案不存在或已过期，请重新生成', 404);
            }

            // 兼容批量模式（groups）和旧单组模式
            const groups = previewData.groups || [{
                teacherId: previewData.teacherId,
                studentId: previewData.studentId,
                courseId: previewData.courseId,
                location: previewData.location,
                slots: previewData.slots
            }];

            // 批量插入排课
            const insertedIds = [];
            for (const group of groups) {
                const { teacherId, studentId, courseId, location, slots } = group;
                for (const slot of slots) {
                    const result = await db.query(
                        `INSERT INTO course_arrangement
                        (teacher_id, student_id, course_id, class_date, start_time, end_time, status, location, created_at, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        RETURNING id`,
                        [teacherId, studentId, courseId, slot.date, slot.startTime, slot.endTime, slot.status || 'confirmed', location || null]
                    );
                    insertedIds.push(result.rows[0].id);
                }
            }

            // 删除预览数据
            schedulePreviewStore.delete(previewId);

            const uniqueTeachers = [...new Set(groups.map(g => g.teacherName).filter(Boolean))];
            const uniqueStudents = [...new Set(groups.map(g => g.studentName).filter(Boolean))];

            return {
                type: 'text',
                title: '排课创建成功',
                data: {
                    message: `成功创建 ${insertedIds.length} 条排课记录`,
                    scheduleIds: insertedIds,
                    teacher: uniqueTeachers.join('、'),
                    student: uniqueStudents.join('、'),
                    courseType: groups.map(g => g.courseTypeCn).filter(Boolean).join('、')
                }
            };
        }

        case 'preview_schedule_update': {
            if (userType !== 'admin') throw new AppError('仅管理员可修改排课', 403);

            const { scheduleIds, fields } = args;

            if (!scheduleIds || scheduleIds.length === 0) {
                throw new AppError('请提供要修改的排课ID', 400);
            }

            if (!fields || Object.keys(fields).length === 0) {
                throw new AppError('请提供要修改的字段', 400);
            }

            // 检查排课是否存在并获取详细信息
            const existingSchedules = await db.query(
                `SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status,
                        ca.location, ca.family_participants, ca.transport_fee, ca.other_fee,
                        t.name as teacher_name, t.id as teacher_id,
                        s.name as student_name, s.id as student_id,
                        st.name as course_type, st.description as course_type_cn
                 FROM course_arrangement ca
                 JOIN teachers t ON ca.teacher_id = t.id
                 JOIN students s ON ca.student_id = s.id
                 JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.id = ANY($1)`,
                [scheduleIds]
            );

            if (existingSchedules.rows.length === 0) {
                throw new AppError('未找到指定的排课', 404);
            }

            if (existingSchedules.rows.length < scheduleIds.length) {
                const foundIds = existingSchedules.rows.map(r => r.id);
                const missingIds = scheduleIds.filter(id => !foundIds.includes(id));
                throw new AppError(`排课 ID ${missingIds.join(', ')} 不存在`, 404);
            }

            // 验证新值的合法性
            let newTeacherName, newStudentName, newCourseTypeCn;

            if (fields.teacherId) {
                const teacherCheck = await db.query('SELECT id, name, status FROM teachers WHERE id=$1', [fields.teacherId]);
                if (teacherCheck.rows.length === 0) throw new AppError(`教师 ID ${fields.teacherId} 不存在`, 404);
                if (teacherCheck.rows[0].status !== 1) throw new AppError(`教师 ${teacherCheck.rows[0].name} 已被禁用`, 400);
                newTeacherName = teacherCheck.rows[0].name;
            }

            if (fields.studentId) {
                const studentCheck = await db.query('SELECT id, name, status FROM students WHERE id=$1', [fields.studentId]);
                if (studentCheck.rows.length === 0) throw new AppError(`学生 ID ${fields.studentId} 不存在`, 404);
                if (studentCheck.rows[0].status !== 1) throw new AppError(`学生 ${studentCheck.rows[0].name} 已被禁用`, 400);
                newStudentName = studentCheck.rows[0].name;
            }

            if (fields.courseType) {
                const courseTypeResult = await db.query('SELECT id, name, description FROM schedule_types WHERE name=$1', [fields.courseType]);
                if (courseTypeResult.rows.length === 0) throw new AppError(`课程类型 ${fields.courseType} 不存在`, 404);
                newCourseTypeCn = courseTypeResult.rows[0].description;
            }

            // 生成操作ID
            const operationId = `update_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

            // 构建变更对比
            const fieldNames = {
                teacherId: '教师',
                studentId: '学生',
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

            const changes = [];
            Object.keys(fields).forEach(key => {
                const fieldLabel = fieldNames[key] || key;
                let newValue = fields[key];

                // 转换显示值
                if (key === 'teacherId') newValue = `${newTeacherName} (ID: ${fields[key]})`;
                else if (key === 'studentId') newValue = `${newStudentName} (ID: ${fields[key]})`;
                else if (key === 'courseType') newValue = `${newCourseTypeCn} (${fields[key]})`;
                else if (key === 'status') newValue = translateStatus(fields[key]);

                changes.push({ field: fieldLabel, newValue });
            });

            // 存储待确认操作
            pendingOperationStore.set(operationId, {
                type: 'update',
                scheduleIds,
                fields,
                schedules: existingSchedules.rows,
                changes,
                createdAt: Date.now()
            });

            // 5分钟后自动过期
            setTimeout(() => pendingOperationStore.delete(operationId), 5 * 60 * 1000);

            return {
                type: 'schedule_operation_preview',
                title: '修改预览',
                data: {
                    operationId,
                    operationType: 'update',
                    affectedCount: scheduleIds.length,
                    schedules: existingSchedules.rows,
                    changes,
                    message: `将修改 ${scheduleIds.length} 条排课的${changes.map(c => c.field).join('、')}`
                }
            };
        }

        case 'preview_schedule_deletion': {
            if (userType !== 'admin') throw new AppError('仅管理员可删除排课', 403);

            const { scheduleIds, reason } = args;

            if (!scheduleIds || scheduleIds.length === 0) {
                throw new AppError('请提供要删除的排课ID', 400);
            }

            // 检查排课是否存在并获取详细信息
            const existingSchedules = await db.query(
                `SELECT ca.id, ca.class_date, ca.start_time, ca.end_time, ca.status,
                        t.name as teacher_name, s.name as student_name,
                        st.name as course_type, st.description as course_type_cn
                 FROM course_arrangement ca
                 JOIN teachers t ON ca.teacher_id = t.id
                 JOIN students s ON ca.student_id = s.id
                 JOIN schedule_types st ON ca.course_id = st.id
                 WHERE ca.id = ANY($1)`,
                [scheduleIds]
            );

            if (existingSchedules.rows.length === 0) {
                throw new AppError('未找到指定的排课', 404);
            }

            if (existingSchedules.rows.length < scheduleIds.length) {
                const foundIds = existingSchedules.rows.map(r => r.id);
                const missingIds = scheduleIds.filter(id => !foundIds.includes(id));
                throw new AppError(`排课 ID ${missingIds.join(', ')} 不存在`, 404);
            }

            // 生成操作ID
            const operationId = `delete_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

            // 存储待确认操作
            pendingOperationStore.set(operationId, {
                type: 'delete',
                scheduleIds,
                reason,
                schedules: existingSchedules.rows,
                createdAt: Date.now()
            });

            // 5分钟后自动过期
            setTimeout(() => pendingOperationStore.delete(operationId), 5 * 60 * 1000);

            return {
                type: 'schedule_operation_preview',
                title: '删除预览',
                data: {
                    operationId,
                    operationType: 'delete',
                    affectedCount: scheduleIds.length,
                    schedules: existingSchedules.rows,
                    reason: reason || '未提供',
                    message: `即将删除 ${scheduleIds.length} 条排课`
                }
            };
        }

        case 'confirm_operation': {
            if (userType !== 'admin') throw new AppError('仅管理员可执行敏感操作', 403);

            const { operationId } = args;

            if (!operationId) {
                throw new AppError('请提供操作ID', 400);
            }

            // 从临时存储中获取操作信息
            const operation = pendingOperationStore.get(operationId);

            if (!operation) {
                throw new AppError('操作ID无效或已过期（5分钟有效期），请重新预览', 400);
            }

            // 根据操作类型执行相应逻辑
            if (operation.type === 'update') {
                // 执行修改操作
                const { scheduleIds, fields } = operation;

                const updateFields = [];
                const params = [];
                let paramCount = 1;

                // 处理课程类型
                if (fields.courseType) {
                    const courseTypeResult = await db.query('SELECT id FROM schedule_types WHERE name=$1', [fields.courseType]);
                    updateFields.push(`course_id=$${paramCount++}`);
                    params.push(courseTypeResult.rows[0].id);
                }

                // 处理其他字段
                if (fields.teacherId) { updateFields.push(`teacher_id=$${paramCount++}`); params.push(fields.teacherId); }
                if (fields.studentId) { updateFields.push(`student_id=$${paramCount++}`); params.push(fields.studentId); }
                if (fields.classDate) { updateFields.push(`class_date=$${paramCount++}`); params.push(fields.classDate); }
                if (fields.startTime) { updateFields.push(`start_time=$${paramCount++}`); params.push(fields.startTime); }
                if (fields.endTime) { updateFields.push(`end_time=$${paramCount++}`); params.push(fields.endTime); }
                if (fields.status) { updateFields.push(`status=$${paramCount++}`); params.push(fields.status); }
                if (fields.location !== undefined) { updateFields.push(`location=$${paramCount++}`); params.push(fields.location); }
                if (fields.familyParticipants !== undefined) { updateFields.push(`family_participants=$${paramCount++}`); params.push(fields.familyParticipants); }
                if (fields.transportFee !== undefined) { updateFields.push(`transport_fee=$${paramCount++}`); params.push(fields.transportFee); }
                if (fields.otherFee !== undefined) { updateFields.push(`other_fee=$${paramCount++}`); params.push(fields.otherFee); }

                updateFields.push('updated_at=CURRENT_TIMESTAMP');

                params.push(scheduleIds);
                const updateQuery = `UPDATE course_arrangement SET ${updateFields.join(', ')} WHERE id = ANY($${paramCount})`;

                await db.query(updateQuery, params);

                // 删除已执行的操作
                pendingOperationStore.delete(operationId);

                return {
                    type: 'text',
                    title: '修改成功',
                    data: {
                        message: `已成功修改 ${scheduleIds.length} 条排课`,
                        scheduleIds,
                        changedFields: operation.changes.map(c => c.field).join('、')
                    }
                };

            } else if (operation.type === 'delete') {
                // 执行删除操作
                const { scheduleIds, reason } = operation;

                await db.query('DELETE FROM course_arrangement WHERE id = ANY($1)', [scheduleIds]);

                // 删除已执行的操作
                pendingOperationStore.delete(operationId);

                const deletedList = operation.schedules.map(row => {
                    return `${row.class_date.toISOString().split('T')[0]} ${row.start_time} ${row.teacher_name}-${row.student_name} ${row.course_type_cn}`;
                });

                return {
                    type: 'text',
                    title: '删除成功',
                    data: {
                        message: `已成功删除 ${scheduleIds.length} 条排课`,
                        scheduleIds,
                        deletedSchedules: deletedList.slice(0, 5),
                        reason: reason || '未提供'
                    }
                };

            } else {
                throw new AppError('未知的操作类型', 400);
            }
        }

        default:
            throw new AppError(`未知工具: ${toolName}`, 400);
    }
}

/**
 * 将工具结果安全序列化为发给 LLM 的字符串。
 * 超长时不做字符硬截断（会破坏 JSON 且切断数据），改为按条数裁剪 + 明确标注省略数量，
 * 保证模型拿到的仍是合法可解析的 JSON，且知道数据被裁剪过。
 */
function summarizeToolResult(result, maxLen = 4000) {
    let str = JSON.stringify(result);
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

/**
 * AI 数据查询主入口
 * POST /api/ai/query
 * body: { question: string, history?: array }
 */
const query = asyncHandler(async (req, res) => {
    if (!aiService.isAvailable()) {
        throw new AppError('AI 功能未启用，请在服务端配置 AI_API_KEY 并设置 AI_ENABLED=true', 503);
    }

    const { question, history, action, images } = req.body;

    // action 为确认类敏感操作（创建/修改/删除排课的二次确认），走独立字段，不依赖自然语言文本
    const isAction = action && typeof action === 'object' && typeof action.type === 'string';

    if (!isAction && (!question || !question.trim())) {
        throw new AppError('请输入问题', 400);
    }

    // 输入长度验证（防止滥用 token 配额）
    if (question && question.length > 2000) {
        throw new AppError('问题长度不能超过 2000 个字符', 400);
    }
    if (history && Array.isArray(history) && history.length > 20) {
        throw new AppError('对话历史不能超过 20 条消息', 400);
    }

    // SSE 模式设置响应头
    const useStream = req.body.stream === true;

    const userType = req.user.userType;

    // 结构化日志：便于线上定位「没调工具/调错工具/截断/解析失败」哪一环
    const logPrefix = `[AI][${userType}#${req.user.id}]`;
    const log = (...args) => console.log(logPrefix, ...args);
    log(isAction
        ? `action=${action.type}`
        : `question="${(question || '').slice(0, 120).replace(/\n/g, ' ')}" history=${Array.isArray(history) ? history.length : 0} images=${Array.isArray(images) ? images.length : 0}`);


    const tools = DATA_TOOLS[userType] || DATA_TOOLS.teacher;

    // 计算当前时间上下文（东八区）——统一走 computeDateContext，与 resolve_datetime 工具同源
    const {
        currentDateTime, currentWeekDay, todayStr,
        thisWeekDateMap, nextWeekDateMap
    } = computeDateContext();

    // 动态加载课程类型和教师列表（用于系统提示，帮助 LLM 精确匹配）
    let courseTypeListStr = '';
    let teacherListStr = '';
    try {
        const [ctResult, tResult] = await Promise.all([
            db.query('SELECT name, description FROM schedule_types ORDER BY id'),
            db.query("SELECT name FROM teachers WHERE status=1 ORDER BY id")
        ]);
        courseTypeListStr = ctResult.rows.map(r => `${r.name}（${r.description}）`).join(' | ');
        teacherListStr = tResult.rows.map(r => r.name).join('、');
    } catch (_) { /* 静默失败，不影响主流程 */ }

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
          `R2. 【人员ID】排课/改课前，必须先用 query_students / query_teachers 查到真实 ID。查不到就停下来询问用户，禁止编造 ID 或姓名。\n` +
          `R3. 【课程类型】只能使用下方课程类型清单里的 name 字段，必须精确匹配，禁止近似名（如"半程入户"不可写成"半次入户"）。\n` +
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
          `处理步骤：\n` +
          `(1) 逐条拆分输入（批量时每行一条，不合并不跳过）。\n` +
          `(2) 对每条的时间表述调用 resolve_datetime 得到精确日期时间。\n` +
          `(3) 用 query_students / query_teachers 把昵称/姓名换成真实 ID。\n` +
          `(4) 把所有条目组装成 groups 数组，一次性调用 create_schedule_preview(groups:[...])。\n` +
          `(5) 系统返回预览表格，交由用户点击"确认创建排课"按钮执行。\n` +
          `状态判定："待定/看情况/可能"→pending，其余→confirmed。\n` +
          `\n【正例】输入"下周一晚上 浩浩入户（周老师，新课堂）"：\n` +
          `  → resolve_datetime("下周一晚上") 得 date=下周一, 19:00:00-21:45:00\n` +
          `  → query_students(nickname:"浩浩") 得 studentId；query_teachers(name:"周老师") 得 teacherId\n` +
          `  → create_schedule_preview(groups:[{teacherId, studentId, courseType:"visit", location:"新课堂", slots:[{date,startTime,endTime}]}])\n` +
          `【反例】不要直接写 create_schedule_preview 而跳过 resolve_datetime 或 query_students —— 会导致日期错、学生错。\n` +
          `\n============================\n` +
          `# 7. 评审/咨询课程（多教师，同时间同地点各生成一条记录）\n` +
          `============================\n` +
          `规则：教师名后紧跟"记录"二字 → 该教师课程类型为"评审记录"/"咨询记录"（review_record/consultation_record），且不再额外生成普通评审；其余参与教师各生成一条普通"评审"/"咨询"。\n` +
          `【正例】输入"浩浩评审（周老师记录，高老师参加，金老师尽量去，下午一点到三点，新课堂）"：\n` +
          `  → resolve_datetime("下午一点到三点") 得 13:00:00-15:00:00\n` +
          `  → 生成三条 group，同日期同时间同地点：①周老师+review_record ②高老师+review ③金老师+review\n` +
          `【反例】不要给"周老师记录"既生成 review 又生成 review_record（重复）。\n` +
          `\n============================\n` +
          `# 8. 改课 / 删课流程\n` +
          `============================\n` +
          `改课：query_schedules 查到目标 → preview_schedule_update(scheduleIds, fields) → 用户按钮确认。\n` +
          `删课：query_schedules 查到目标 → preview_schedule_deletion(scheduleIds) → 用户按钮确认。\n` +
          `\n============================\n` +
          `# 9. 回复格式\n` +
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
        const allInsertedIds = [];
        for (const pid of previewIds) {
            try {
                const result = await executeDataTool('confirm_schedule_creation', { previewId: pid }, req);
                if (result.data && result.data.scheduleIds) {
                    allInsertedIds.push(...result.data.scheduleIds);
                }
            } catch (err) {
                console.warn('[AI][confirm_create] previewId 执行失败:', pid, err.message);
            }
        }
        const answerText = allInsertedIds.length > 0
            ? `成功创建 ${allInsertedIds.length} 条排课记录`
            : '排课创建失败，预览可能已过期，请重新生成';
        return {
            type: 'text',
            answer: answerText,
            structuredData: { message: answerText, scheduleIds: allInsertedIds },
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
        console.log('[AI][query] action:', action.type, 'user:', req.user.id, req.user.userType);
        try {
            let responseData;
            if (action.type === 'confirm_create' && action.previewId) {
                responseData = await handleConfirmCreate(action.previewId);
            } else if (action.type === 'confirm_operation' && action.operationId) {
                responseData = await handleConfirmOperation(action.operationId);
            } else {
                throw new AppError('无效的确认操作参数', 400);
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
            return res.json(standardResponse(true, responseData));
        } catch (err) {
            if (useStream && res.headersSent) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || '确认操作失败' })}\n\n`);
                return res.end();
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
        return res.json(standardResponse(true, responseData));
    }

    const confirmOpMatch = question && question.match(/确认执行操作.*operationId[:\s]+(\S+)/);
    if (confirmOpMatch) {
        const responseData = await handleConfirmOperation(confirmOpMatch[1]);
        if (useStream) {
            res.write(`data: ${JSON.stringify({ type: 'result', data: responseData })}\n\n`);
            return res.end();
        }
        return res.json(standardResponse(true, responseData));
    }

    // 构建消息列表：系统提示 + 历史对话 + 当前问题
    const messages = [
        { role: 'system', content: systemPrompt }
    ];

    // 添加历史对话（如果有）
    if (history && Array.isArray(history) && history.length > 0) {
        // 只保留最近10轮对话，避免上下文过长
        const recentHistory = history.slice(-10);
        messages.push(...recentHistory);
    }

    // 模型能力：提前计算，供多模态 content 构造与后续工具分流共用
    const currentModel = aiService.getAIConfig().model;
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
    let llmResp = await aiService.chat(messages, chatTools ? { tools: chatTools, toolChoice: 'auto' } : {});
    let toolCalls = toolsEnabled ? aiService.extractToolCalls(llmResp) : [];

    // 循环执行工具调用（最多 12 轮，支持智能排课的多步操作）
    let rounds = 0;
    while (toolsEnabled && toolCalls.length > 0 && rounds < 12) {
        rounds++;
        messages.push(llmResp.choices[0].message);

        // 发送工具执行进度
        const toolNames = toolCalls.map(t => t.function.name);
        sendSSE('progress', { step: 'executing', message: getToolProgressMessage(toolNames) });

        log(`round ${rounds} tools: ${toolNames.join(', ')}`);

        // 并行执行所有工具调用
        const toolCallResults = await Promise.all(toolCalls.map(async (call) => {
            const name = call.function.name;
            let args = {};
            try { args = JSON.parse(call.function.arguments || '{}'); } catch (_) { /* noop */ }
            toolsUsed.push(name);

            try {
                const result = await executeDataTool(name, args, req);
                toolResults.push({ tool: name, args, result });
                // 超长结果做「结构化摘要」而非字符硬切，保证回传给模型的 JSON 仍合法可解析
                return { role: 'tool', tool_call_id: call.id, content: summarizeToolResult(result) };
            } catch (err) {
                log(`round ${rounds} tool "${name}" FAILED: ${err.message}`);
                return { role: 'tool', tool_call_id: call.id, content: `工具执行失败: ${err.message}` };
            }
        }));
        messages.push(...toolCallResults);

        sendSSE('progress', { step: 'thinking', message: '正在整理结果...' });
        llmResp = await aiService.chat(messages, { tools: chatTools, toolChoice: 'auto' });
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

            for (const pr of previewResults) {
                const d = pr.result.data;
                if (d.schedules) allSchedules.push(...d.schedules);
                if (d.previewId) previewIds.push(d.previewId);
                if (d.teacher) totalTeacher = d.teacher;
                if (d.student) totalStudent = d.student;
                if (d.courseType) totalCourseType = d.courseType;
            }

            structuredData = {
                previewId: previewIds.join(','),  // 多个 previewId 用逗号分隔
                teacher: totalTeacher,
                student: totalStudent,
                courseType: totalCourseType,
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
        res.json(standardResponse(true, {
            type: responseType,
            answer,
            structuredData,
            toolsUsed
        }));
    }

    } catch (err) {
        if (useStream && res.headersSent) {
            // SSE 头已发送，通过 SSE 发送错误
            try {
                res.write(`data: ${JSON.stringify({ type: 'error', message: err.message || '查询失败，请稍后重试' })}\n\n`);
                res.end();
            } catch (_) { try { res.end(); } catch (_) {} }
        } else if (useStream) {
            // SSE 头未发送，返回 JSON 错误
            return res.status(err.statusCode || 500).json(
                standardResponse(false, null, err.message || '查询失败')
            );
        } else {
            throw err; // 非 SSE 模式交给 asyncHandler 处理
        }
    }
});

/**
 * 获取当前 AI 配置
 * GET /api/ai/config
 */
const getConfig = asyncHandler(async (req, res) => {
    const config = aiService.getAIConfig();
    res.json(standardResponse(true, {
        enabled: config.enabled,
        provider: config.provider,
        protocol: config.protocol,
        baseUrl: config.baseUrl,
        model: config.model,
        timeout: config.timeout,
        maxTokens: config.maxTokens,
        apiKey: config.apiKey ? '***已配置***' : null
    }));
});

/**
 * 获取预设 AI 模型列表
 * GET /api/ai/presets
 */
const getPresets = asyncHandler(async (req, res) => {
    const presets = getPresetModels(false); // 不包含真实 API Key
    res.json(standardResponse(true, { presets }));
});

/**
 * 更新 AI 配置
 * PUT /api/ai/config
 */
const updateConfig = asyncHandler(async (req, res) => {
    const { provider, protocol, apiKey, baseUrl, model, timeout, maxTokens, presetId } = req.body;

    // 如果是预设模型切换，从环境变量获取真实的 API Key
    let realApiKey = apiKey;
    if (presetId) {
        const presets = getPresetModels(true); // 包含真实 API Key
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
            realApiKey = preset.apiKey;
        }
    }

    if (!provider || !realApiKey || !baseUrl || !model) {
        throw new AppError('缺少必要的配置参数', 400);
    }

    // 使用配置管理器更新配置（立即生效，无需重启）
    aiConfigManager.updateAIConfig({
        provider,
        protocol: protocol || 'openai',
        apiKey: realApiKey,
        baseUrl,
        model,
        timeout: timeout || 30000,
        maxTokens: maxTokens || 3000
    });

    res.json(standardResponse(true, { message: '配置已更新并立即生效！' }));
});

/**
 * 检测 AI 模型状态（快速检测）
 * POST /api/ai/check
 */
const checkModel = asyncHandler(async (req, res) => {
    const { provider, protocol, apiKey, baseUrl, model, presetId } = req.body;

    // 如果是预设模型，从环境变量获取真实的 API Key
    let realApiKey = apiKey;
    if (presetId) {
        const presets = getPresetModels(true);
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
            realApiKey = preset.apiKey;
        }
    }

    if (!realApiKey || !baseUrl || !model) {
        return res.json(standardResponse(false, {
            available: false,
            error: '缺少必要的参数'
        }));
    }

    try {
        // 快速检测：使用临时配置，避免修改全局 process.env（消除竞态条件）
        const testConfig = {
            enabled: true,
            provider: provider || 'custom',
            protocol: protocol || 'openai',
            apiKey: realApiKey,
            baseUrl,
            model,
            timeout: 8000, // 8秒超时
            maxTokens: 20  // 20 token 足够返回简短响应
        };

        // 发送极简测试请求（通过 configOverride 传入临时配置）
        await aiService.chat([
            { role: 'user', content: 'test' }
        ], { configOverride: testConfig });

        res.json(standardResponse(true, {
            available: true
        }));
    } catch (error) {
        console.error('[AI] 可用性检查失败:', error.message || error);
        res.json(standardResponse(true, {
            available: false,
            error: '服务暂不可用'
        }));
    }
});

/**
 * 测试 AI 模型连接
 * POST /api/ai/test
 */
const testModel = asyncHandler(async (req, res) => {
    const { provider, protocol, apiKey, baseUrl, model, timeout, maxTokens, presetId } = req.body;

    // 如果是预设模型测试，从环境变量获取真实的 API Key
    let realApiKey = apiKey;
    if (presetId) {
        const presets = getPresetModels(true); // 包含真实 API Key
        const preset = presets.find(p => p.id === presetId);
        if (preset) {
            realApiKey = preset.apiKey;
        }
    }

    if (!realApiKey || !baseUrl || !model) {
        throw new AppError('缺少必要的测试参数', 400);
    }

    // 使用临时配置（通过 configOverride 传入，避免修改全局 process.env）
    const testConfig = {
        enabled: true,
        provider: provider || 'custom',
        protocol: protocol || 'openai',
        apiKey: realApiKey,
        baseUrl,
        model,
        timeout: timeout || 30000,
        maxTokens: 100  // 增加到 100 token，确保完整响应
    };

    try {
        const startTime = Date.now();

        // 发送测试消息（通过 configOverride 传入临时配置）
        const response = await aiService.chat([
            { role: 'user', content: '请简单回复"测试成功"' }
        ], { configOverride: testConfig });

        const latency = Date.now() - startTime;
        const text = aiService.extractText(response);

        res.json(standardResponse(true, {
            success: true,
            latency,
            model: testConfig.model,
            response: text
        }));
    } catch (error) {
        console.error('[AI] 模型测试失败:', error.message || error);
        res.json(standardResponse(false, {
            success: false,
            error: 'AI 服务请求失败'
        }));
    }
});

/**
 * 获取所有渠道支持的模型列表
 * GET /api/ai/models
 */
const getAvailableModels = asyncHandler(async (req, res) => {
    const modelsFilePath = path.join(__dirname, '../data/ai-models.json');

    try {
        const modelsData = fs.readFileSync(modelsFilePath, 'utf8');
        const models = JSON.parse(modelsData);

        res.json(standardResponse(true, { models }));
    } catch (error) {
        // 如果文件不存在，返回空对象
        res.json(standardResponse(true, { models: {} }));
    }
});

/**
 * 获取当前模型的能力信息
 * GET /api/ai/capabilities
 */
const getModelCapabilities = asyncHandler(async (req, res) => {
    const config = aiService.getAIConfig();
    const modelsFilePath = path.join(__dirname, '../data/ai-models.json');

    try {
        const modelsData = fs.readFileSync(modelsFilePath, 'utf8');
        const allModels = JSON.parse(modelsData);

        // 根据当前配置查找对应的模型能力
        let capabilities = {
            vision: false,
            tools: false,
            reasoning: false
        };

        // 查找匹配的 provider
        for (const [provider, models] of Object.entries(allModels)) {
            const model = models.find(m => m.id === config.model);
            if (model) {
                capabilities = model.capabilities;
                break;
            }
        }

        res.json(standardResponse(true, { capabilities, model: config.model }));
    } catch (error) {
        // 默认返回不支持任何高级功能
        res.json(standardResponse(true, {
            capabilities: {
                vision: false,
                tools: false,
                reasoning: false
            },
            model: config.model
        }));
    }
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
    // 内部纯函数导出（仅供单元测试使用）
    _test: {
        computeDateContext,
        resolveDateTime,
        parseClock,
        summarizeToolResult,
        isWeakModel,
        resolveModelCapabilities
    }
};
