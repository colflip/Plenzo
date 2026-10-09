/**
 * 费用金额的**唯一**解析出口（校验层与写库层共用，避免两边各写一套口径）。
 *
 * 过去两侧都用 `parseFloat`，它会：
 *   - `'1,000'` → 1            （千分位被当结束符，金额直接缩水 1000 倍）
 *   - `'100元'` → 100          （尾部垃圾被静默丢弃）
 *   - `'1.500'` → 1.5          （小数点后三位被截读）
 *   - `'Infinity'` → Infinity  （过掉 `< 0` 检查，最后 JSON.stringify 变成 null = 「未填」）
 *   - `'0x10'` → 0
 * 本项目的长期规则是「手填金额按原样读取，系统不做二次运算」，因此这里只做
 * **格式归一**（去空白与千分位分隔符），绝不改写数值本身；
 * 精度超过 2 位、或归一后不是十进制数字的输入一律**明确拒绝**，而不是猜一个值存进去
 * （审计列是 DECIMAL(10,2)，存 12.999 会让明细与审计各说各话）。
 */

// 允许：可选负号 + 整数部分 + 最多两位小数
const FEE_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * @param {*} value 原始输入（number / string / null / undefined / ''）
 * @returns {{ok: boolean, value: number|null, reason?: string}}
 *          ok=true 时 value 为可入库的数字或 null（null = 未填，与 0 语义不同）
 */
function parseFeeAmount(value) {
    if (value === null || value === undefined) return { ok: true, value: null };
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return { ok: false, reason: '金额必须是有限数字' };
        return parseFeeAmount(String(value));
    }
    if (typeof value !== 'string') return { ok: false, reason: '金额格式无效' };

    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, value: null };       // 空串 = 未填

    // 去千分位（半角/全角逗号）：这是**书写格式**，不是数值运算
    const digits = trimmed.replace(/[,，]/g, '');   // 半角/全角千分位都认
    if (!FEE_PATTERN.test(digits)) {
        return { ok: false, reason: '金额只能是不多于两位小数的数字' };
    }
    return { ok: true, value: Number(digits) };
}

/**
 * 严格版：解析失败直接抛（调用方已在边界处理过格式时才用）。
 * @param {*} value
 * @returns {number|null}
 */
function requireFeeAmount(value) {
    const parsed = parseFeeAmount(value);
    if (!parsed.ok) {
        const err = new Error(parsed.reason);
        err.code = 'VALIDATION_FAILED';
        err.statusCode = 400;
        throw err;
    }
    return parsed.value;
}

module.exports = { parseFeeAmount, requireFeeAmount, FEE_PATTERN };
