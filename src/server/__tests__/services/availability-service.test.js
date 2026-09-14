// D1-4：availability-service 单测（helper + teacher 事务方法，mock tx）
const AvailabilityService = require('../../services/availability-service');

describe('availability 纯函数', () => {
    test('normalizeSlotKey', () => {
        expect(AvailabilityService.normalizeSlotKey('Morning')).toBe('morning');
        expect(AvailabilityService.normalizeSlotKey('xyz')).toBeNull();
        expect(AvailabilityService.normalizeSlotKey(null)).toBeNull();
    });
    test('normalizeSlotValue', () => {
        expect(AvailabilityService.normalizeSlotValue(true)).toBe(1);
        expect(AvailabilityService.normalizeSlotValue('available')).toBe(1);
        expect(AvailabilityService.normalizeSlotValue(0)).toBe(0);
        expect(AvailabilityService.normalizeSlotValue('x')).toBeNull();
    });
    test('isValidDateString', () => {
        expect(AvailabilityService.isValidDateString('2026-01-01')).toBe(true);
        expect(AvailabilityService.isValidDateString('2026/01/01')).toBe(false);
    });
    test('slotToColumn / toSlotBit', () => {
        expect(AvailabilityService.slotToColumn('morning')).toBe('morning_available');
        expect(AvailabilityService.toSlotBit(true)).toBe(1);
        expect(AvailabilityService.toSlotBit(false)).toBe(0);
    });
    test('collectAvailabilityUpdates', () => {
        const m = AvailabilityService.collectAvailabilityUpdates([
            { date: '2026-01-01', timeSlot: 'morning', isAvailable: true }
        ]);
        expect(m.get('2026-01-01').morning).toBe(1);
    });
});

// 内存 mock 事务查询：按 SQL 关键字路由，模拟 teacher_daily_availability 表
function makeTx(initialRows = []) {
    const store = new Map();
    for (const r of initialRows) store.set(r.date, { ...r });
    const calls = [];
    const q = async (sql, params) => {
        calls.push({ sql, params });
        // 批量读现值：setTeacherAvailability 用一条 date = ANY($2) 取回整批（往返固定 2 次）
        if (/SELECT[\s\S]*teacher_daily_availability/.test(sql) && /date = ANY/.test(sql)) {
            const wanted = Array.isArray(params[1]) ? params[1] : [];
            return { rows: wanted.filter(d => store.has(d)).map(d => ({ date: d, ...store.get(d) })) };
        }
        if (/SELECT[\s\S]*teacher_daily_availability/.test(sql) && /LIMIT 1/.test(sql)) {
            const row = store.get(params[1]);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (/INSERT INTO teacher_daily_availability/.test(sql)) {
            // 多值 INSERT：$1 是 teacher_id，其后每 4 个参数一行（date, morning, afternoon, evening）
            if (/ON CONFLICT/.test(sql)) {
                for (let i = 1; i + 3 < params.length + 1; i += 4) {
                    store.set(params[i], {
                        morning_available: params[i + 1],
                        afternoon_available: params[i + 2],
                        evening_available: params[i + 3]
                    });
                }
                return { rows: [], rowCount: (params.length - 1) / 4 };
            }
            store.set(params[1], {
                morning_available: params[2], afternoon_available: params[3], evening_available: params[4]
            });
            return { rows: [], rowCount: 1 };
        }
        if (/UPDATE teacher_daily_availability/.test(sql) && /RETURNING/.test(sql)) {
            const col = (sql.match(/SET (\w+) = 0/) || [])[1];
            const row = store.get(params[1]);
            if (row && col) row[col] = 0;
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (/UPDATE teacher_daily_availability/.test(sql)) {
            const row = store.get(params[1]);
            if (row) {
                row.morning_available = params[2];
                row.afternoon_available = params[3];
                row.evening_available = params[4];
            }
            return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM teacher_daily_availability/.test(sql)) {
            const before = store.has(params[1]);
            store.delete(params[1]);
            return { rows: [], rowCount: before ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
    };
    return { q, store, calls };
}

describe('setTeacherAvailability', () => {
    test('新日期 → insert；已存在且有变化 → update；无变化 → unchanged', async () => {
        const { q } = makeTx([{ date: '2026-01-02', morning_available: 0, afternoon_available: 0, evening_available: 0 }]);
        const r = await AvailabilityService.setTeacherAvailability(q, 1, [
            { date: '2026-01-01', slots: { morning: 1 } },          // 新 → insert
            { date: '2026-01-02', slots: { morning: 1 } },          // 已存在变化 → update
            { date: '2026-01-03', slots: {} }                        // 无显式更新 → unchanged
        ]);
        expect(r.insertCount).toBe(1);
        expect(r.updateCount).toBe(1);
        expect(r.unchangedCount).toBe(1);
    });
    test('无效日期 → 抛错', async () => {
        const { q } = makeTx();
        await expect(AvailabilityService.setTeacherAvailability(q, 1, [{ date: 'bad', slots: { morning: 1 } }]))
            .rejects.toThrow(/无效的日期格式/);
    });
});

describe('replaceTeacherAvailability (R2 原子保存)', () => {
    test('updates 新日期 → insert；removals.removeAll → delete', async () => {
        const { q, store } = makeTx([{ date: '2026-02-01', morning_available: 1, afternoon_available: 0, evening_available: 0 }]);
        const r = await AvailabilityService.replaceTeacherAvailability(q, 1, {
            updates: [{ date: '2026-01-01', slots: { morning: 1, afternoon: 1, evening: 0 } }],
            removals: [{ date: '2026-02-01', removeAll: true }]
        });
        expect(r.insertCount).toBe(1);
        expect(r.deleteCount).toBe(1);
        expect(store.has('2026-02-01')).toBe(false);
        expect(store.has('2026-01-01')).toBe(true);
    });
    test('removals 单槽置 0 且全零 → 整行删除', async () => {
        const { q, store } = makeTx([{ date: '2026-03-01', morning_available: 1, afternoon_available: 0, evening_available: 0 }]);
        const r = await AvailabilityService.replaceTeacherAvailability(q, 1, {
            updates: [],
            removals: [{ date: '2026-03-01', timeSlot: 'morning' }]
        });
        expect(r.deleteCount).toBe(1);
        expect(store.has('2026-03-01')).toBe(false);
    });
});

describe('deleteTeacherAvailability', () => {
    test('单槽置 0 未全零 → updateCount；全零 → deleteCount', async () => {
        const { q, store } = makeTx([
            { date: '2026-04-01', morning_available: 1, afternoon_available: 1, evening_available: 0 }
        ]);
        const r = await AvailabilityService.deleteTeacherAvailability(q, 1, [
            { date: '2026-04-01', timeSlot: 'morning' } // 置 morning=0 后仍有 afternoon=1 → update
        ]);
        expect(r.updateCount).toBe(1);
        expect(store.has('2026-04-01')).toBe(true);
    });
});

describe('upsertAvailabilityByAdmin', () => {
    test('teacher 表 upsert 写入', async () => {
        const { q } = makeTx();
        const calls = [];
        const tq = async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; };
        await AvailabilityService.upsertAvailabilityByAdmin(tq, 'teacher_daily_availability', 'teacher_id', [
            { teacher_id: 5, date: '2026-05-01', morning: true, afternoon: false, evening: true }
        ]);
        const ins = calls.find(c => /INSERT INTO teacher_daily_availability/.test(c.sql));
        expect(ins).toBeTruthy();
        // toSlotBit: true→1, false→0
        expect(ins.params).toEqual([5, '2026-05-01', 1, 0, 1]);
    });
});

describe('upsertAvailabilityByAdmin 权限落地（created_by 归属）', () => {
    const l1 = { id: 1, userType: 'admin', permissionLevel: 1 };
    const l3 = { id: 9, userType: 'admin', permissionLevel: 3 };

    test('带 actorUser 时 INSERT 打标 created_by，UPDATE 用 COALESCE 认领无主行', async () => {
        const calls = [];
        const tq = async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; };
        await AvailabilityService.upsertAvailabilityByAdmin(tq, 'teacher_daily_availability', 'teacher_id', [
            { teacher_id: 5, date: '2026-05-02', morning: true, afternoon: false, evening: true }
        ], l3);
        const ins = calls.find(c => /INSERT INTO teacher_daily_availability/.test(c.sql));
        expect(ins.sql).toContain('created_by');
        expect(ins.params).toEqual([5, '2026-05-02', 1, 0, 1, 9]); // 第 6 参为 created_by
        expect(ins.sql).toMatch(/COALESCE\(teacher_daily_availability\.created_by, EXCLUDED\.created_by\)/);
    });

    test('L3 修改他人创建的记录 → 抛 404', async () => {
        const tq = async (sql) => {
            if (/SELECT/.test(sql)) return { rows: [{ created_by: 8 }] }; // 他人创建
            return { rows: [], rowCount: 1 };
        };
        await expect(AvailabilityService.upsertAvailabilityByAdmin(tq, 'teacher_daily_availability', 'teacher_id', [
            { teacher_id: 5, date: '2026-05-03', morning: true, afternoon: false, evening: true }
        ], l3)).rejects.toMatchObject({ statusCode: 404 });
    });

    test('L3 修改自己创建/无主记录 → 正常 upsert；L1 不做存在性探测', async () => {
        const ownCalls = [];
        const tqOwn = async (sql, params) => {
            ownCalls.push({ sql, params });
            if (/SELECT/.test(sql)) return { rows: [{ created_by: 9 }] };
            return { rows: [], rowCount: 1 };
        };
        await AvailabilityService.upsertAvailabilityByAdmin(tqOwn, 'teacher_daily_availability', 'teacher_id', [
            { teacher_id: 5, date: '2026-05-04', morning: false, afternoon: false, evening: false }
        ], l3);
        expect(ownCalls.some(c => /INSERT INTO/.test(c.sql))).toBe(true);

        const l1Calls = [];
        const tqL1 = async (sql, params) => { l1Calls.push({ sql, params }); return { rows: [], rowCount: 1 }; };
        await AvailabilityService.upsertAvailabilityByAdmin(tqL1, 'student_daily_availability', 'student_id', [
            { student_id: 7, date: '2026-05-05', morning: true, afternoon: true, evening: true }
        ], l1);
        expect(l1Calls.some(c => /SELECT created_by/.test(c.sql))).toBe(false); // L1 不探测归属
    });
});
