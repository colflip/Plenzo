/**
 * 权限过滤器
 * 负责根据用户类型过滤列和数据
 */

class PermissionFilter {
    /**
     * 过滤学生端列（移除敏感信息）
     * @param {Array} data - 数据数组
     * @param {string} userType - 用户类型
     * @returns {Array} 过滤后的数据
     */
    static filterStudentColumns(data, userType) {
        if (userType !== 'student') return data;

        return data.map(row => {
            const newRow = { ...row };
            // 学生端隐藏：学生名称、交通费、其他费用
            delete newRow['学生名称'];
            delete newRow['交通费'];
            delete newRow['其他费用'];
            delete newRow['费用'];
            delete newRow['周汇总'];
            return newRow;
        });
    }

    /**
     * 过滤交通费（根据权限）
     * @param {*} transportFee - 交通费原始值
     * @param {string} userType - 用户类型
     * @param {number} userId - 用户ID
     * @param {number} teacherId - 教师ID（课程的）
     * @returns {string} 过滤后的交通费显示值
     */
    static filterTransportFee(transportFee, userType, userId, teacherId) {
        // 学生端完全隐藏交通费
        if (userType === 'student') {
            return '/';
        }

        // 管理员、教师、班主任：显示所有交通费（无过滤）
        // 这里保持原有逻辑，不做额外的教师权限过滤
        return transportFee;
    }

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
