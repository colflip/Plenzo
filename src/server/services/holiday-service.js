/**
 * holiday-service.js —— 节假日子域业务逻辑层（D1-1）
 *
 * 从 admin-controller 下沉的「纯业务逻辑」。控制器只负责 HTTP 封装
 * （standardResponse / 状态码），本层负责数据访问契约与业务规则。
 *
 * 设计约定（与 controllers/services 既有约定一致）：
 * - 直接 require 单例 `db` 与 `recordAudit`（jest 全局 mock 仍生效）；
 * - 纯函数尽量无副作用，便于单测；
 * - service 只返回领域数据；业务错误抛 AppError，由 controller 统一封装 HTTP 响应。
 */

const db = require('../db/db');
const { recordAudit } = require('../middleware/audit');
const logger = require('../utils/logger');
const { AppError } = require('../middleware/error');

const HOLIDAY_COLUMNS = ['year', 'type', 'label', 'start_date', 'end_date'];

/**
 * 把若干节假日拼成**一条**多值 INSERT。
 * 远程库每条语句约 250ms，三年节假日 100-300 条，逐条写要 25-75 秒；
 * 合成一条后是一次往返。items 已由调用方过滤过必填字段。
 */
async function insertHolidaysBatch(items) {
    if (items.length === 0) return;
    const params = [];
    const tuples = items.map((it) => {
        params.push(it.year, it.type, it.label, it.start_date, it.end_date);
        const n = params.length;
        return `($${n - 4}, $${n - 3}, $${n - 2}, $${n - 1}, $${n})`;
    });
    await db.query(
        `INSERT INTO holidays (year, type, label, start_date, end_date) VALUES ${tuples.join(', ')}`,
        params
    );
}

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

/** 创建单条节假日；返回创建后的记录 */
async function createHoliday(payload, req) {
    const fieldError = validateHolidayFields(payload);
    if (fieldError) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: fieldError });
    }

    const { year, type, label, start_date, end_date } = payload;
    const result = await db.query(
        'INSERT INTO holidays (year, type, label, start_date, end_date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [year, type, label, start_date, end_date]
    );

    await recordAudit(req, { op: 'create_holiday', details: { year, type, label, start_date, end_date } });
    return result.rows[0];
}

/** 更新单条节假日；返回更新后的记录 */
async function updateHoliday(id, payload, req) {
    const fieldError = validateHolidayFields(payload);
    if (fieldError) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: fieldError });
    }

    const { year, type, label, start_date, end_date } = payload;
    const result = await db.query(
        'UPDATE holidays SET year = $1, type = $2, label = $3, start_date = $4, end_date = $5, updated_at = CURRENT_TIMESTAMP WHERE id = $6 RETURNING *',
        [year, type, label, start_date, end_date, id]
    );

    if (result.rows.length === 0) {
        throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '节假日记录不存在' });
    }

    await recordAudit(req, { op: 'update_holiday', entityId: id, details: { year, type, label, start_date, end_date } });
    return result.rows[0];
}

/** 删除单条节假日 */
async function deleteHoliday(id, req) {
    const result = await db.query('DELETE FROM holidays WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
        throw new AppError({ code: 'RESOURCE_NOT_FOUND', statusCode: 404, message: '节假日记录不存在' });
    }

    await recordAudit(req, { op: 'delete_holiday', entityId: id });
}

/**
 * 批量 upsert（按涉及年份先清空，再一条多值 INSERT 写入）
 * 返回 { count, years }
 */
async function batchUpsertHolidays(items, req) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new AppError({ code: 'BAD_REQUEST', statusCode: 400, message: '同步数据不能为空' });
    }

    const years = [...new Set(items.map((i) => i.year).filter(Boolean))];
    if (years.length > 0) {
        await db.query('DELETE FROM holidays WHERE year = ANY($1::int[])', [years]);
    }

    const valid = items.filter(
        (it) => it.year && it.type && it.label && it.start_date && it.end_date
    );
    await insertHolidaysBatch(valid);

    await recordAudit(req, { op: 'batch_sync_holidays', details: { years, count: items.length } });
    return { count: items.length, years };
}

/**
 * 从第三方 API（timor.tech）同步指定年份的节假日到数据库。
 * fetcher 可注入以便测试（默认全局 fetch）。
 * 返回同步后的完整节假日列表。
 *
 * 全部年份都没取到数据时抛 503：上游整体不可用与「这一年确实没有节假日」
 * 是两回事，前者若返回空数组会让调用方以为同步成功。
 */
async function syncHolidaysFromAPI(yearsInput, req, { fetcher = fetch } = {}) {
    const years = Array.isArray(yearsInput) && yearsInput.length ? yearsInput : [2025, 2026, 2027];

    const items = [];
    const failedYears = [];
    const fetchedYears = [];
    for (const year of years) {
        let data;
        try {
            const resp = await fetcher(`https://timor.tech/api/holiday/year/${year}`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            if (!resp.ok) {
                failedYears.push(year);
                continue;
            }
            data = await resp.json();
        } catch (e) {
            logger.warn(`节假日同步：获取 ${year} 年数据失败`, e && e.message);
            failedYears.push(year);
            continue;
        }
        fetchedYears.push(year);
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

    if (fetchedYears.length === 0 && failedYears.length > 0) {
        throw new AppError({
            code: 'SERVICE_UNAVAILABLE',
            statusCode: 503,
            message: '节假日数据源暂时不可用，请稍后重试',
            details: failedYears.map((year) => ({ year }))
        });
    }
    if (failedYears.length > 0) {
        logger.warn(`节假日同步：${failedYears.join('、')} 年数据获取失败，仅同步成功年份`);
    }

    if (items.length === 0) {
        return [];
    }

    const syncedYears = [...new Set(items.map((i) => i.year))];
    await db.query('DELETE FROM holidays WHERE year = ANY($1::int[])', [syncedYears]);
    await insertHolidaysBatch(items);

    await recordAudit(req, { op: 'sync_holidays_from_api', details: { years: syncedYears, count: items.length } });

    const result = await db.query('SELECT * FROM holidays ORDER BY year ASC, start_date ASC');
    return result.rows || [];
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
