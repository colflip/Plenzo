/**
 * DataTransformer 测试
 */

const DataTransformer = require('../../../services/export/data-transformer');

describe('DataTransformer', () => {
    describe('normalizeTypeKey', () => {
        test('正确归一化 review_online 类型', () => {
            expect(DataTransformer.normalizeTypeKey('review_online')).toBe('review');
            expect(DataTransformer.normalizeTypeKey('online_review')).toBe('review');
            expect(DataTransformer.normalizeTypeKey('REVIEW_ONLINE')).toBe('review');
        });

        test('正确归一化 visit_online 类型', () => {
            expect(DataTransformer.normalizeTypeKey('visit_online')).toBe('visit');
            expect(DataTransformer.normalizeTypeKey('online_visit')).toBe('visit');
            expect(DataTransformer.normalizeTypeKey('VISIT_ONLINE')).toBe('visit');
        });

        test('正确归一化 consultation_online 类型', () => {
            expect(DataTransformer.normalizeTypeKey('consultation_online')).toBe('consultation');
            expect(DataTransformer.normalizeTypeKey('online_consultation')).toBe('consultation');
            expect(DataTransformer.normalizeTypeKey('advisory_online')).toBe('consultation');
            expect(DataTransformer.normalizeTypeKey('online_advisory')).toBe('consultation');
        });

        test('正确归一化 review_record_online 类型', () => {
            expect(DataTransformer.normalizeTypeKey('review_record_online')).toBe('review_record');
            expect(DataTransformer.normalizeTypeKey('online_review_record')).toBe('review_record');
        });

        test('正确归一化 consultation_record_online 类型', () => {
            expect(DataTransformer.normalizeTypeKey('consultation_record_online')).toBe('consultation_record');
            expect(DataTransformer.normalizeTypeKey('online_consultation_record')).toBe('consultation_record');
        });

        test('非线上类型保持小写', () => {
            expect(DataTransformer.normalizeTypeKey('trial')).toBe('trial');
            expect(DataTransformer.normalizeTypeKey('VISIT')).toBe('visit');
            expect(DataTransformer.normalizeTypeKey('Review')).toBe('review');
        });

        test('处理 null 和 undefined', () => {
            expect(DataTransformer.normalizeTypeKey(null)).toBe('');
            expect(DataTransformer.normalizeTypeKey(undefined)).toBe('');
        });

        test('处理空字符串和空白字符', () => {
            expect(DataTransformer.normalizeTypeKey('')).toBe('');
            expect(DataTransformer.normalizeTypeKey('   ')).toBe('');
        });
    });

    describe('isCountableSchedule', () => {
        test('正常课程返回 true', () => {
            expect(DataTransformer.isCountableSchedule({ status: 'confirmed' })).toBe(true);
            expect(DataTransformer.isCountableSchedule({ status: 'completed' })).toBe(true);
            expect(DataTransformer.isCountableSchedule({ status: 'pending' })).toBe(true);
        });

        test('已取消课程返回 false', () => {
            expect(DataTransformer.isCountableSchedule({ status: 'cancelled' })).toBe(false);
            expect(DataTransformer.isCountableSchedule({ status: '已取消' })).toBe(false);
            expect(DataTransformer.isCountableSchedule({ status: 0 })).toBe(false);
            expect(DataTransformer.isCountableSchedule({ status: '0' })).toBe(false);
        });

        test('已调整课程返回 false', () => {
            expect(DataTransformer.isCountableSchedule({ status: 'modified_away' })).toBe(false);
            expect(DataTransformer.isCountableSchedule({ status: '已调整' })).toBe(false);
        });

        test('处理不同的状态字段名', () => {
            expect(DataTransformer.isCountableSchedule({ 状态: 'cancelled' })).toBe(false);
            expect(DataTransformer.isCountableSchedule({ 状态: 'confirmed' })).toBe(true);
        });

        test('处理 null 和 undefined', () => {
            expect(DataTransformer.isCountableSchedule(null)).toBe(true);
            expect(DataTransformer.isCountableSchedule(undefined)).toBe(true);
            expect(DataTransformer.isCountableSchedule({})).toBe(true);
        });

        test('处理大小写混合的状态', () => {
            expect(DataTransformer.isCountableSchedule({ status: 'CANCELLED' })).toBe(false);
            expect(DataTransformer.isCountableSchedule({ status: 'Modified_Away' })).toBe(false);
        });
    });

    describe('formatFee', () => {
        test('正常费用返回字符串', () => {
            expect(DataTransformer.formatFee(100)).toBe('100');
            expect(DataTransformer.formatFee(25.5)).toBe('25.5');
            expect(DataTransformer.formatFee('50')).toBe('50');
        });

        test('向上取整到小数点后两位', () => {
            expect(DataTransformer.formatFee(25.556)).toBe('25.56');
            expect(DataTransformer.formatFee(25.551)).toBe('25.56');
        });

        test('零值返回 "/"', () => {
            expect(DataTransformer.formatFee(0)).toBe('/');
            expect(DataTransformer.formatFee('0')).toBe('/');
        });

        test('null、undefined、空字符串返回 "/"', () => {
            expect(DataTransformer.formatFee(null)).toBe('/');
            expect(DataTransformer.formatFee(undefined)).toBe('/');
            expect(DataTransformer.formatFee('')).toBe('/');
        });

        test('非数字返回 "/"', () => {
            expect(DataTransformer.formatFee('abc')).toBe('/');
            expect(DataTransformer.formatFee(NaN)).toBe('/');
        });
    });

    describe('formatLocaleDate', () => {
        test('正确格式化日期对象', () => {
            const date = new Date('2024-06-10T10:30:00');
            expect(DataTransformer.formatLocaleDate(date)).toBe('2024-06-10');
        });

        test('正确格式化日期字符串', () => {
            expect(DataTransformer.formatLocaleDate('2024-06-10')).toBe('2024-06-10');
            expect(DataTransformer.formatLocaleDate('2024-12-31')).toBe('2024-12-31');
        });

        test('正确格式化月份和日期的零填充', () => {
            expect(DataTransformer.formatLocaleDate('2024-01-05')).toBe('2024-01-05');
            expect(DataTransformer.formatLocaleDate('2024-09-09')).toBe('2024-09-09');
        });

        test('处理 null 和 undefined', () => {
            expect(DataTransformer.formatLocaleDate(null)).toBe('');
            expect(DataTransformer.formatLocaleDate(undefined)).toBe('');
        });

        test('处理无效日期', () => {
            expect(DataTransformer.formatLocaleDate('invalid')).toBe('invalid');
            expect(DataTransformer.formatLocaleDate('not-a-date')).toBe('not-a-date');
        });
    });

    describe('formatTimestamp', () => {
        test('正确格式化时间戳', () => {
            const timestamp = new Date('2024-06-10T10:30:00').getTime();
            const result = DataTransformer.formatTimestamp(timestamp);
            expect(result).toMatch(/2024/);
            expect(result).toMatch(/10:30/);
        });

        test('处理 null 和 undefined', () => {
            expect(DataTransformer.formatTimestamp(null)).toBe('');
            expect(DataTransformer.formatTimestamp(undefined)).toBe('');
        });

        test('处理无效时间戳', () => {
            expect(DataTransformer.formatTimestamp('invalid')).toBe('invalid');
        });
    });

    describe('sanitizeFilename', () => {
        test('移除文件系统非法字符', () => {
            expect(DataTransformer.sanitizeFilename('test<file>name')).toBe('test_file_name');
            expect(DataTransformer.sanitizeFilename('test:file|name')).toBe('test_file_name');
            expect(DataTransformer.sanitizeFilename('test/file\\name')).toBe('test_file_name');
            expect(DataTransformer.sanitizeFilename('test"file"name')).toBe('test_file_name');
        });

        test('空格转下划线', () => {
            expect(DataTransformer.sanitizeFilename('test file name')).toBe('test_file_name');
            expect(DataTransformer.sanitizeFilename('test  file  name')).toBe('test_file_name');
        });

        test('连续点号转下划线', () => {
            expect(DataTransformer.sanitizeFilename('test..file..name')).toBe('test_file_name');
            expect(DataTransformer.sanitizeFilename('test...name')).toBe('test_name');
        });

        test('限制长度为50字符', () => {
            const longName = 'a'.repeat(100);
            expect(DataTransformer.sanitizeFilename(longName).length).toBe(50);
        });

        test('处理 null 和 undefined', () => {
            expect(DataTransformer.sanitizeFilename(null)).toBe('未知');
            expect(DataTransformer.sanitizeFilename(undefined)).toBe('未知');
        });

        test('处理空字符串', () => {
            expect(DataTransformer.sanitizeFilename('')).toBe('未知');
        });
    });

    describe('generateTimestamp', () => {
        test('生成14位时间戳格式', () => {
            const timestamp = DataTransformer.generateTimestamp();
            expect(timestamp).toMatch(/^\d{14}$/);
        });

        test('格式为 YYYYMMDDHHMMSS', () => {
            const timestamp = DataTransformer.generateTimestamp();
            const year = parseInt(timestamp.substring(0, 4));
            const month = parseInt(timestamp.substring(4, 6));
            const day = parseInt(timestamp.substring(6, 8));
            const hour = parseInt(timestamp.substring(8, 10));
            const minute = parseInt(timestamp.substring(10, 12));
            const second = parseInt(timestamp.substring(12, 14));

            expect(year).toBeGreaterThan(2020);
            expect(month).toBeGreaterThanOrEqual(1);
            expect(month).toBeLessThanOrEqual(12);
            expect(day).toBeGreaterThanOrEqual(1);
            expect(day).toBeLessThanOrEqual(31);
            expect(hour).toBeGreaterThanOrEqual(0);
            expect(hour).toBeLessThanOrEqual(23);
            expect(minute).toBeGreaterThanOrEqual(0);
            expect(minute).toBeLessThanOrEqual(59);
            expect(second).toBeGreaterThanOrEqual(0);
            expect(second).toBeLessThanOrEqual(59);
        });
    });

    describe('groupDataByDate', () => {
        test('正确按日期分组数据', () => {
            const data = [
                { date: '2024-06-10', name: 'A' },
                { date: '2024-06-10', name: 'B' },
                { date: '2024-06-11', name: 'C' }
            ];

            const result = DataTransformer.groupDataByDate(data);

            expect(result.size).toBe(2);
            expect(result.get('2024-06-10').length).toBe(2);
            expect(result.get('2024-06-11').length).toBe(1);
        });

        test('支持不同的日期字段名', () => {
            const data = [
                { class_date: '2024-06-10', name: 'A' },
                { arr_date: '2024-06-11', name: 'B' }
            ];

            const result = DataTransformer.groupDataByDate(data);

            expect(result.size).toBe(2);
            expect(result.get('2024-06-10').length).toBe(1);
            expect(result.get('2024-06-11').length).toBe(1);
        });

        test('忽略没有日期的记录', () => {
            const data = [
                { date: '2024-06-10', name: 'A' },
                { name: 'B' },
                { date: null, name: 'C' }
            ];

            const result = DataTransformer.groupDataByDate(data);

            expect(result.size).toBe(1);
            expect(result.get('2024-06-10').length).toBe(1);
        });

        test('处理空数组', () => {
            const result = DataTransformer.groupDataByDate([]);
            expect(result.size).toBe(0);
        });
    });

    describe('groupByTimeSlot', () => {
        test('正确按时间段分组', () => {
            const schedules = [
                { start_time: '09:00:00', end_time: '10:00:00', name: 'A' },
                { start_time: '09:00:00', end_time: '10:00:00', name: 'B' },
                { start_time: '14:00:00', end_time: '15:00:00', name: 'C' }
            ];

            const result = DataTransformer.groupByTimeSlot(schedules);

            expect(result.length).toBe(2);
            expect(result[0].timeSlot).toBe('09:00-10:00');
            expect(result[0].schedules.length).toBe(2);
            expect(result[1].timeSlot).toBe('14:00-15:00');
            expect(result[1].schedules.length).toBe(1);
        });

        test('处理空数组', () => {
            const result = DataTransformer.groupByTimeSlot([]);
            expect(result.length).toBe(0);
        });

        test('处理缺少时间字段的数据', () => {
            const schedules = [
                { start_time: null, end_time: null, name: 'A' },
                { name: 'B' }
            ];

            const result = DataTransformer.groupByTimeSlot(schedules);

            expect(result.length).toBeGreaterThan(0);
        });
    });
});
