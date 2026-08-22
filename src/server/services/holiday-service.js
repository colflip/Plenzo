/**
 * holiday-service.js —— 节假日子域业务逻辑层（D1-1）
 *
 * 从 admin-controller 下沉的「纯业务逻辑」。控制器只负责 HTTP 封装
 * （standardResponse / 状态码），本层负责数据访问契约与业务规则。
 *
 * 设计约定（与 controllers/services 既有约定一致）：
 * - 直接 require 单例 `db` 与 `recordAudit`（jest 全局 mock 仍生效）；
 * - 纯函数尽量无副作用，便于单测；
 * - service 方法返回领域结果（对象），不直接操作 res；
 * - 业务错误以 `{ status, error }` 形式返回，由控制器映射为 HTTP 响应。
 */

const db = require('../db/db');
const { recordAudit } = require('../middleware/audit');
const logger = require('../utils/logger');

const HOLIDAY_COLUMNS = ['year', 'type', 'label', 'start_date', 'end_date'];

/** 校验节假日 5 字段完整性；通过返回 null，否则返回中文字段错误信息 */
function validateHolidayFields(payload) {
    if (!payload) return '请求参数缺失';
    for (const col of HOLIDAY_COLUMNS) {
        if (payload[col] === undefined || payload[col] === null || payload[col] === '') {
            return '年份、类型、名称、日期均不能为空';
        }
    }
    return null;
}

/** 列出全部节假日（按年份、起始日期升序） */
async function listHolidays() {
    const result = await db.query('SELECT * FROM holidays ORDER BY year ASC, start_date ASC');
    return result.rows || [];
}

/** 创建单条节假日；返回 { status, data } 或 { status, error } */
async function createHoliday(payload, req) {
    const fieldError = validateHolidayFields(payload);
    if (fieldError) return { status: 400, error: fieldError };

    const { year, type, label, start_date, end_date } = payload;
    const result = await db.query(
        'INSERT INTO holidays (year, type, label, start_date, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [year, type, label, start_date, end_date]
    );

    await recordAudit(req, { op: 'create_holiday', details: { year, type, label, start_date, end_date } });
    return { status: 201, data: result.rows[0] };
}

/** 更新单条节假日；返回 { status, data } 或 { status, error } */
async function updateHoliday(id, payload, req) {
    const fieldError = validateHolidayFields(payload);
    if (fieldError) return { status: 400, error: fieldError };

    const { year, type, label, start_date, end_date } = payload;
    const result = await db.query(
        'UPDATE holidays SET year = $1, type = $2, label = $3, start_date = $4, end_date = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
        [year, type, label, start_date, end_date, id]
    );

    if (result.rows.length === 0) {
        return { status: 404, error: '节假日记录不存在' };
    }

    await recordAudit(req, { op: 'update_holiday', entityId: id, details: { year, type, label, start_date, end_date } });
    return { status: 200, data: result.rows[0] };
}

/** 删除单条节假日；返回 { status } 或 { status, error } */
async function deleteHoliday(id, req) {
    const result = await db.query('DELETE FROM holidays WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
        return { status: 404, error: '节假日记录不存在' };
    }

    await recordAudit(req, { op: 'delete_holiday', entityId: id });
    return { status: 200 };
}

/**
 * 批量 upsert（按涉及年份先清空再逐条写入）
 * 返回 { status, data: { count, years } } 或 { status, error }
 */
async function batchUpsertHolidays(items, req) {
    if (!Array.isArray(items) || items.length === 0) {
        return { status: 400, error: '同步数据不能为空' };
    }

    const years = [...new Set(items.map((i) => i.year).filter(Boolean))];
    if (years.length > 0) {
        await db.query('DELETE FROM holidays WHERE year = ANY($1::int[])', [years]);
    }

    for (const item of items) {
        if (!item.year || !item.type || !item.label || !item.start_date || !item.end_date) continue;
        await db.query(
            'INSERT INTO holidays (year, type, label, start_date, end_date) VALUES ($1, $2, $3, $4, $5)',
            [item.year, item.type, item.label, item.start_date, item.end_date]
        );
    }

    await recordAudit(req, { op: 'batch_sync_holidays', details: { years, count: items.length } });
    return { status: 200, data: { count: items.length, years } };
}

/**
 * 从第三方 API（timor.tech）同步指定年份的节假日到数据库。
 * fetcher 可注入以便测试（默认全局 fetch）。
 * 返回 { status, data } 或 { status, error }。
 */
async function syncHolidaysFromAPI(yearsInput, req, { fetcher = fetch } = {}) {
    const years = Array.isArray(yearsInput) && yearsInput.length ? yearsInput : [2025, 2026, 2027];

    const items = [];
    for (const year of years) {
        let data;
        try {
            const resp = await fetcher(`https://timor.tech/api/holiday/year/${year}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (!resp.ok) continue;
            data = await resp.json();
        } catch (e) {
            logger.warn(`节假日同步：获取 ${year} 年数据失败`, e && e.message);
            continue;
        }
        if (!data || !data.holiday) continue;

        for (const [key, info] of Object.entries(data.holiday)) {
            if (!key || key.length < 2 || !info || !info.name) continue;
            const parts = key.replace(/^-/, '').split('-');
            const month = (parts[0] || '01').padStart(2, '0');
            const day = (parts[1] || '01').padStart(2, '0');
            const date = `${year}-${month}-${day}`;
            items.push({
                year,
                type: info.holiday ? 'holiday' : 'makeup',
                label: info.name,
                start_date: date,
                end_date: date
            });
        }
    }

    if (items.length === 0) {
        return { status: 200, data: [], checkedYears: years };
    }

    const syncedYears = [...new Set(items.map((i) => i.year))];
    await db.query('DELETE FROM holidays WHERE year = ANY($1::int[])', [syncedYears]);
    for (const item of items) {
        await db.query(
            'INSERT INTO holidays (year, type, label, start_date, end_date) VALUES ($1, $2, $3, $4, $5)',
            [item.year, item.type, item.label, item.start_date, item.end_date]
        );
    }

    await recordAudit(req, { op: 'sync_holidays_from_api', details: { years: syncedYears, count: items.length } });

    const result = await db.query('SELECT * FROM holidays ORDER BY year ASC, start_date ASC');
    return { status: 200, data: result.rows || [], count: items.length, checkedYears: years };
}

module.exports = {
    HOLIDAY_COLUMNS,
    validateHolidayFields,
    listHolidays,
    createHoliday,
    updateHoliday,
    deleteHoliday,
    batchUpsertHolidays,
    syncHolidaysFromAPI
};
