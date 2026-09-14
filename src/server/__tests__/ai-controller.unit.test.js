/**
 * AI 控制器纯函数单元测试
 * 覆盖阶段2/3/4 引入的确定性逻辑：时间解析、结果摘要、模型能力判定。
 * 这些逻辑从 LLM 手里收回代码，是「对模型不敏感」的关键，必须有测试兜底。
 */

const { _test } = require('../controllers/ai-controller');
const { computeDateContext, getDayOfWeek, resolveDateTime, parseClock, summarizeToolResult, isWeakModel, resolveModelCapabilities } = _test;

describe('computeDateContext', () => {
    it('返回今天、本周、下周的完整日期映射', () => {
        const ctx = computeDateContext();
        expect(ctx.todayStr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(Object.keys(ctx.thisWeek)).toEqual(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
        expect(Object.keys(ctx.nextWeek)).toEqual(['周一', '周二', '周三', '周四', '周五', '周六', '周日']);
        // 每个日期都是合法 YYYY-MM-DD
        Object.values(ctx.thisWeek).forEach(d => expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/));
    });

    it('下周一 = 本周一 + 7 天', () => {
        const ctx = computeDateContext();
        const thisMon = new Date(ctx.thisWeek['周一'] + 'T00:00:00+08:00');
        const nextMon = new Date(ctx.nextWeek['周一'] + 'T00:00:00+08:00');
        expect((nextMon - thisMon) / (24 * 3600 * 1000)).toBe(7);
    });
});

describe('getDayOfWeek / 日期-星期一致性（时区回归）', () => {
    // 独立于被测函数的“真实星期”基准：用 UTC 锚定，永不受进程时区影响。
    // 复现原线上 bug：以 TZ=UTC 运行本文件，旧实现会让整周日期 +1、星期 -1。
    const cnToIdx = { 周日: 0, 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5, 周六: 6 };
    const trueWeekdayIdx = (iso) => {
        const [y, m, d] = iso.split('-').map(Number);
        return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    };

    it('已知日期返回真实星期（与进程时区无关）', () => {
        // 2026-07-27=周一 … 2026-08-02=周日
        expect(getDayOfWeek('2026-07-27')).toBe('周一');
        expect(getDayOfWeek('2026-07-28')).toBe('周二');
        expect(getDayOfWeek('2026-07-31')).toBe('周五');
        expect(getDayOfWeek('2026-08-01')).toBe('周六');
        expect(getDayOfWeek('2026-08-02')).toBe('周日');
    });

    it('本周/下周每个日期都真正落在其标注的星期上', () => {
        const ctx = computeDateContext();
        [ctx.thisWeek, ctx.nextWeek].forEach(week => {
            Object.entries(week).forEach(([label, date]) => {
                expect(trueWeekdayIdx(date)).toBe(cnToIdx[label]);
                expect(getDayOfWeek(date)).toBe(label);
            });
        });
    });

    it('今天的日期 / 星期 / currentWeekDay 三者自洽', () => {
        const ctx = computeDateContext();
        expect(getDayOfWeek(ctx.todayStr)).toBe(ctx.currentWeekDay);
        expect(trueWeekdayIdx(ctx.todayStr)).toBe(cnToIdx[ctx.currentWeekDay]);
    });
});

describe('parseClock', () => {
    it('解析 HH:MM / HH:MM:SS', () => {
        expect(parseClock('19:30')).toBe('19:30:00');
        expect(parseClock('14:00:00')).toBe('14:00:00');
    });
    it('解析纯小时数字', () => {
        expect(parseClock('19')).toBe('19:00:00');
        expect(parseClock('7')).toBe('07:00:00');
    });
    it('解析中文「点」', () => {
        expect(parseClock('一点')).toBe('01:00:00');
        expect(parseClock('三点半')).toBe('03:30:00');
        expect(parseClock('7点')).toBe('07:00:00');
    });
    it('无法解析返回 null', () => {
        expect(parseClock('abc')).toBeNull();
        expect(parseClock('')).toBeNull();
        expect(parseClock(null)).toBeNull();
    });
});

describe('resolveDateTime', () => {
    it('本周/下周 + 周几 得到具体日期', () => {
        const ctx = computeDateContext();
        const r = resolveDateTime('下周四晚上');
        expect(r.date).toBe(ctx.nextWeek['周四']);
        expect(r.dayOfWeek).toBe('周四');
        expect(r.startTime).toBe('19:00:00');
        expect(r.endTime).toBe('21:30:00');
        expect(r.matched).toBe(true);
    });

    it('默认时段：下午 = 14:00-17:00', () => {
        const r = resolveDateTime('周三下午');
        expect(r.startTime).toBe('14:00:00');
        expect(r.endTime).toBe('17:00:00');
    });

    it('显式区间覆盖默认时段：19-22', () => {
        const r = resolveDateTime('下周一晚上19-22');
        expect(r.startTime).toBe('19:00:00');
        expect(r.endTime).toBe('22:00:00');
    });

    it('中文区间 + 下午语境：一点到三点 → 13:00-15:00（12→24 小时归一）', () => {
        const r = resolveDateTime('周六下午一点到三点');
        expect(r.startTime).toBe('13:00:00');
        expect(r.endTime).toBe('15:00:00');
    });

    it('晚上语境：七点到九点 → 19:00-21:00', () => {
        const r = resolveDateTime('周三晚上七点到九点');
        expect(r.startTime).toBe('19:00:00');
        expect(r.endTime).toBe('21:00:00');
    });

    it('「点-」分隔符：下午一点-三点 → 13:00-15:00', () => {
        const r = resolveDateTime('周六下午暂定一点-三点');
        expect(r.startTime).toBe('13:00:00');
        expect(r.endTime).toBe('15:00:00');
    });

    it('24 小时制显式区间不受时段影响：14:30-15:30', () => {
        const r = resolveDateTime('周六下午14:30-15:30');
        expect(r.startTime).toBe('14:30:00');
        expect(r.endTime).toBe('15:30:00');
    });

    it('无日期时给出警告且 matched=false', () => {
        const r = resolveDateTime('随便什么时候');
        expect(r.date).toBeNull();
        expect(r.matched).toBe(false);
        expect(r.warnings.length).toBeGreaterThan(0);
    });

    it('今天/明天相对日期', () => {
        const ctx = computeDateContext();
        expect(resolveDateTime('今天上午').date).toBe(ctx.todayStr);
        const tomorrow = new Date(ctx.todayStr + 'T00:00:00+08:00');
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tStr = tomorrow.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        expect(resolveDateTime('明天晚上').date).toBe(tStr);
    });
});

describe('summarizeToolResult', () => {
    it('短结果原样返回合法 JSON', () => {
        const r = { type: 'data_table', data: { a: 1 } };
        const out = summarizeToolResult(r);
        expect(JSON.parse(out)).toEqual(r);
    });

    it('超长 schedules 数组按条数裁剪且仍是合法 JSON', () => {
        const schedules = Array.from({ length: 500 }, (_, i) => ({
            id: i, class_date: '2026-07-01', start_time: '19:00:00', end_time: '21:00:00',
            teacher_name: '教师某某某', student_name: '学生某某某', course_type_cn: '入户课程'
        }));
        const r = { type: 'schedule_preview', title: '预览', data: { schedules } };
        const out = summarizeToolResult(r, 4000);
        expect(out.length).toBeLessThanOrEqual(4000);
        const parsed = JSON.parse(out); // 不抛错 = JSON 合法
        expect(parsed.data.schedules.length).toBeLessThan(500);
        expect(parsed._truncated).toBeDefined();
        expect(parsed._truncated.total).toBe(500);
    });
});

describe('isWeakModel', () => {
    it('small/flash/lite/mini 判为弱模型', () => {
        expect(isWeakModel('mistral-small-latest')).toBe(true);
        expect(isWeakModel('agnes-2.0-flash')).toBe(true);
        expect(isWeakModel('sensenova-6.7-flash-lite')).toBe(true);
        expect(isWeakModel('gpt-4o-mini')).toBe(true);
    });
    it('large/medium/opus/sonnet/deepseek-v4 不是弱模型', () => {
        expect(isWeakModel('mistral-large-latest')).toBe(false);
        expect(isWeakModel('mistral-medium-latest')).toBe(false);
        expect(isWeakModel('claude-opus-4-8')).toBe(false);
        expect(isWeakModel('deepseek-v4-flash')).toBe(false);
    });
});

describe('resolveModelCapabilities', () => {
    it('已知模型返回声明能力', () => {
        const c = resolveModelCapabilities('mistral-small-latest');
        expect(c._known).toBe(true);
        expect(c.tools).toBe(true);
        expect(c.vision).toBe(false);
    });
    it('已知 vision 模型', () => {
        const c = resolveModelCapabilities('claude-opus-4-8');
        expect(c._known).toBe(true);
        expect(c.vision).toBe(true);
        expect(c.tools).toBe(true);
    });
    it('未知/自定义模型默认假设支持 tools', () => {
        const c = resolveModelCapabilities('some-custom-gateway-model');
        expect(c._known).toBe(false);
        expect(c.tools).toBe(true);
        expect(c.vision).toBe(false);
    });
});
