/**
 * permission.js —— 管理端权限级别前端工具（Phase 2）
 *
 * 与后端 src/server/utils/admin-permissions.js 保持同一套语义：
 *   - 权限级别：L1 超管 / L2 普通管理员 / L3 操作员（数字越小权限越高，缺省视为 L3）
 *   - 导航区块最低级别（data-min-level）
 *   - 用户信息字段敏感度（public/internal/sensitive），与后端裁剪结果对齐，
 *     避免表格出现整列空白的「幽灵列」。
 *
 * 原则：前端隐藏仅是体验优化，真正的安全边界由后端路由门禁与服务层范围过滤保证。
 */
(function () {
    'use strict';

    // 导航/功能入口的最低可见级别（数字越小权限越高；未标注默认全员可见）
    const SECTION_MIN_LEVEL = {
        overview: 3,
        'availability-mgmt': 3,
        schedule: 3,
        finance: 3,
        statistics: 3,
        users: 2,           // L2 只读（字段受限），L1 全量管理
        'system-settings': 1 // 课程类型写/假期写/反馈处理均仅 L1
    };

    // 字段敏感度镜像（与后端 FIELD_SENSITIVITY 一致）
    const FIELD_SENSITIVITY = {
        id: 'public',
        username: 'public',
        name: 'public',
        nickname: 'public',
        profession: 'public',
        status: 'public',
        student_ids: 'public',
        home_address: 'public',
        work_location: 'public',
        visit_location: 'public',
        contact: 'internal',
        email: 'internal',
        restriction: 'sensitive',
        permission_level: 'sensitive',
        last_login: 'sensitive',
        created_at: 'sensitive'
    };

    const SENSITIVITY_MAX_LEVEL = {
        public: 3,
        internal: 2,
        sensitive: 1
    };

    /** 从 localStorage.userData 读取当前管理员权限级别 */
    function getLevel() {
        try {
            const raw = localStorage.getItem('userData');
            if (!raw) return 3;
            const data = JSON.parse(raw);
            const lvl = parseInt(data && data.permission_level, 10);
            return Number.isInteger(lvl) && lvl >= 1 && lvl <= 3 ? lvl : 3;
        } catch (_) {
            return 3;
        }
    }

    /** 当前操作者是否至少为指定级别（level 数字越小权力越大） */
    function atLeast(level) {
        return getLevel() <= level;
    }

    /** 是否超级管理员(L1)：账号增删改、系统设置等唯一凭据 */
    function isSuperAdmin() {
        return getLevel() === 1;
    }

    /** 区块/入口是否对当前级别可见 */
    function canSeeSection(sectionId) {
        const min = SECTION_MIN_LEVEL[sectionId];
        if (typeof min !== 'number') return true;
        return atLeast(min);
    }

    /**
     * 按 data-min-level 属性批量隐藏越权入口（导航项、按钮等）。
     * 在页面初始化时调用一次。
     */
    function applyPermissionGating(root = document) {
        const level = getLevel();
        root.querySelectorAll('[data-min-level]').forEach(el => {
            const min = parseInt(el.dataset.minLevel, 10);
            if (Number.isInteger(min) && level > min) {
                el.style.display = 'none';
                el.dataset.permissionHidden = '1';
            }
        });
    }

    function canSeeField(field) {
        const tier = FIELD_SENSITIVITY[field] || 'public';
        return getLevel() <= SENSITIVITY_MAX_LEVEL[tier];
    }

    /** 过滤表格字段清单（与后端 SELECT 列裁剪结果对齐） */
    function visibleFields(fields) {
        return (fields || []).filter(canSeeField);
    }

    window.permissionUtils = {
        getLevel,
        atLeast,
        isSuperAdmin,
        canSeeSection,
        applyPermissionGating,
        canSeeField,
        visibleFields,
        SECTION_MIN_LEVEL,
        FIELD_SENSITIVITY
    };
})();
