/**
 * 权限过滤器
 * 负责根据用户类型过滤列和数据
 */

class PermissionFilter {
    // filterStudentColumns / filterTransportFee 曾在这里，各自有 13 条测试，
    // 但生产代码一次都没调用过（审查报告 P3-9）：真正生效的费用遮蔽是下面这条
    // removeFeeColumns（calendar-generator.js:38 调）与 filterEmptyColumns
    // （sheet-builder / stats-aggregator 调）。留着两份「看起来在用」的平行实现，
    // 下次改费用遮蔽的人会改错地方。
    /**
     * 移除学生端的费用相关列
     * @param {Array} data - 日历数据
     * @param {string} userType - 用户类型
     * @returns {Array} 过滤后的数据
     */
    static removeFeeColumns(data, userType) {
        if (userType !== 'student') return data;

        data.forEach(row => {
            delete row['费用'];
            delete row['周汇总'];
            delete row['报销状态'];
        });

        return data;
    }

    /**
     * 过滤掉全空的列
     * @param {Array} data - 数据数组
     * @param {Array} columnsToCheck - 需要检查的列名
     * @returns {Array} 过滤后的数据
     */
    static filterEmptyColumns(data, columnsToCheck = ['试教', '入户', '评审', '集体活动', '咨询']) {
        if (!data || data.length === 0) return data;

        const columnsWithData = new Set();
        data.forEach(row => {
            columnsToCheck.forEach(col => {
                const val = row[col];
                if (val !== undefined && val !== null && val !== '/' && val !== '' && val !== 0) {
                    columnsWithData.add(col);
                }
            });
        });

        // 删除空列
        return data.map(row => {
            const newRow = { ...row };
            columnsToCheck.forEach(col => {
                if (!columnsWithData.has(col)) {
                    delete newRow[col];
                }
            });
            return newRow;
        });
    }
}

module.exports = PermissionFilter;
