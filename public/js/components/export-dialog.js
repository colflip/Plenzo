/**
 * 数据导出对话框模块
 * 提供灵活的导出配置界面，支持多种导出类型和文件格式
 * 
 * 导出类型：
 * 1. 老师信息数据 - 基本信息+统计数据
 * 2. 学生信息数据 - 基本信息+统计数据
 * 3. 指定时间段的老师排课记录 - 详细排课信息
 * 4. 指定时间段的学生排课记录 - 详细排课信息
 * 
 * 导出格式：Excel, CSV
 */

window.ExportDialog = (function () {
    // ============ 常量定义 ============
    const EXPORT_TYPES = {
        TEACHER_INFO: 'teacher_info',           // 老师信息数据
        STUDENT_INFO: 'student_info',           // 学生信息数据
        TEACHER_SCHEDULE: 'teacher_schedule',   // 老师排课记录
        STUDENT_SCHEDULE: 'student_schedule'    // 学生排课记录
    };

    const EXPORT_FORMATS = {
        EXCEL: 'excel',
        CSV: 'csv'
    };

    const EXPORT_TYPE_CONFIG = {
        [EXPORT_TYPES.TEACHER_INFO]: {
            label: '老师信息数据',
            description: '导出所有老师的基本信息及相关统计数据',
            requiresDateRange: false,
            icon: 'person'
        },
        [EXPORT_TYPES.STUDENT_INFO]: {
            label: '学生信息数据',
            description: '导出所有学生的基本信息及相关统计数据',
            requiresDateRange: false,
            icon: 'people'
        },
        [EXPORT_TYPES.TEACHER_SCHEDULE]: {
            label: '老师排课记录',
            description: '导出老师在指定时间范围内的排课详细记录',
            requiresDateRange: true,
            icon: 'event_note'
        },
        [EXPORT_TYPES.STUDENT_SCHEDULE]: {
            label: '学生上课记录',
            description: '导出学生在指定时间范围内的上课详细记录',
            requiresDateRange: true,
            icon: 'calendar_month'
        }
    };

    // ============ 状态管理 ============
    const state = {
        isOpen: false,
        selectedType: null,
        selectedFormat: EXPORT_FORMATS.EXCEL,
        startDate: null,
        endDate: null,
        isExporting: false
    };

    // ============ DOM 引用 ============
    let dialogElement = null;
    let modalOverlay = null;

    // ============ 类型标准化工具 ============
    /**
     * 标准化类型名称（英文key）
     * 将线上类型统一为基础类型：review_online → review, visit_online → visit
     * @param {string} typeKey - 类型英文标识 (如 review, review_online, visit, visit_online)
     * @returns {string} 标准化后的类型英文标识
     */
    const normalizeTypeKey = (typeKey) => {
        const lower = String(typeKey || '').toLowerCase().trim();
        // 线上评审 → 评审
        if (lower === 'review_online' || lower === 'online_review') return 'review';
        // 线上入户 → 入户
        if (lower === 'visit_online' || lower === 'online_visit') return 'visit';
        return lower;
    };

    /**
     * 标准化类型中文描述
     * 将（线上）评审/（线上）入户统一为评审/入户
     * @param {string} typeDesc - 类型中文描述 (如 评审, （线上）评审, 入户, （线上）入户)
     * @returns {string} 标准化后的中文描述
     */
    const normalizeTypeDesc = (typeDesc) => {
        let desc = String(typeDesc || '').trim();
        // （线上）评审 / 线上评审 → 评审
        if (desc === '（线上）评审' || desc === '(线上)评审' || desc === '线上评审') return '评审';
        // （线上）入户 / 线上入户 → 入户
        if (desc === '（线上）入户' || desc === '(线上)入户' || desc === '线上入户') return '入户';
        return desc;
    };

    /**
     * 初始化对话框 HTML 结构
     */
    function createDialogHTML() {
        // 根据角色过滤导出类型
        const currentUser = window.currentUser || {};
        const userType = currentUser.userType || 'admin';

        let filteredTypes = Object.entries(EXPORT_TYPE_CONFIG);
        if (userType === 'teacher') {
            filteredTypes = filteredTypes.filter(([id]) => id === EXPORT_TYPES.TEACHER_SCHEDULE);
        } else if (userType === 'student') {
            filteredTypes = filteredTypes.filter(([id]) => id === EXPORT_TYPES.STUDENT_SCHEDULE);
        }

        const html = `
            <div id="exportDialogOverlay" class="export-dialog-overlay" style="display: none;">
                <div id="exportDialog" class="export-dialog-container">
                    <!-- 对话框头部 -->
                    <div class="export-dialog-header">
                        <div class="export-dialog-title">
                            <span class="material-icons-round">file_download</span>
                            <h2>数据导出</h2>
                        </div>
                        <button class="export-dialog-close" aria-label="关闭导出对话框">
                            <span class="material-icons-round">close</span>
                        </button>
                    </div>

                    <!-- 对话框内容 -->
                    <div class="export-dialog-content">


                        <!-- 步骤 1：选择导出类型 -->
                        <div class="export-step-content active" data-step="1">
                            <h3>选择导出类型</h3>
                            <div class="export-type-selector" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;">
                                ${filteredTypes.map(([typeId, config]) => `
                                    <label class="export-type-option" data-type="${typeId}" style="margin-bottom: 0;">
                                        <input type="radio" name="exportType" value="${typeId}" style="display: none;">
                                        <div class="export-type-card" style="padding: 12px; height: 100%; display: flex; align-items: center; gap: 12px;">
                                            <div class="export-type-icon" style="width: 36px; height: 36px; font-size: 20px;">
                                                <span class="material-icons-round" style="font-size: 20px;">${config.icon}</span>
                                            </div>
                                            <div class="export-type-info" style="flex: 1;">
                                                <h4 style="font-size: 14px; margin-bottom: 4px;">${config.label}</h4>
                                                <p style="font-size: 12px; line-height: 1.3; margin-bottom: 0;">${config.description}</p>
                                            </div>
                                            <div class="export-type-check" style="top: 8px; right: 8px;">
                                                <span class="material-icons-round" style="font-size: 16px;">check_circle</span>
                                            </div>
                                        </div>
                                    </label>
                                `).join('')}
                            </div>
                        </div>

                        <!-- 步骤 2：配置选项 -->
                        <div class="export-step-content" data-step="2">
                            <h3>配置导出选项</h3>
                            
                            <!-- 日期范围选择（仅对需要的类型显示） -->
                            <div class="export-date-range-section" style="display: none;">
                                <!-- 组合日期输入和快速选择 -->
                                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 12px;">
                                    <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                                        <div class="export-form-group" style="flex: 1; margin-bottom: 0;">
                                            <label for="exportStartDate">开始日期</label>
                                            <input type="date" id="exportStartDate" required>
                                        </div>
                                        <div class="export-form-group" style="flex: 1; margin-bottom: 0;">
                                            <label for="exportEndDate">结束日期</label>
                                            <input type="date" id="exportEndDate" required>
                                        </div>
                                    </div>
                                    
                                    <div class="export-date-presets" style="margin: 0; padding: 0; border: none;">
                                        <label style="margin-bottom: 8px; display: block;">快速选择:</label>
                                        <div class="export-preset-buttons">
                                            <button type="button" class="export-preset-btn" data-preset="week">本周</button>
                                            <button type="button" class="export-preset-btn active" data-preset="month">本月</button>
                                            <button type="button" class="export-preset-btn" data-preset="quarter">本季度</button>
                                            <button type="button" class="export-preset-btn" data-preset="last-week">上周</button>
                                            <button type="button" class="export-preset-btn" data-preset="last-month">上月</button>
                                            <button type="button" class="export-preset-btn" data-preset="last-quarter">上季度</button>
                                        </div>
                                    </div>
                                    <div class="export-date-validation" style="display: none; margin-top: 12px; padding: 8px 12px;">
                                        <span class="material-icons-round" style="font-size: 16px;">info</span>
                                        <span id="exportDateValidationMsg" style="font-size: 12px;">日期范围有效</span>
                                    </div>
                                </div>

                                <div class="export-filters-row" style="display: flex; gap: 12px;">
                                    <div class="export-form-group" id="exportStudentFilter" style="display: none; flex: 1;">
                                        <label for="exportStudentSelect">筛选学生</label>
                                        <select id="exportStudentSelect" style="width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
                                            <option value="">全部学生</option>
                                            <option value="loading" disabled>加载中...</option>
                                        </select>
                                    </div>

                                    <div class="export-form-group" id="exportTeacherFilter" style="display: none; flex: 1;">
                                        <label for="exportTeacherSelect">筛选教师</label>
                                        <select id="exportTeacherSelect" style="width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box;">
                                            <option value="">全部教师</option>
                                            <option value="loading" disabled>加载中...</option>
                                        </select>
                                    </div>
                                </div>
                                <div style="margin-top: 4px; display: none;" id="filterHint">
                                     <p style="font-size: 12px; color: #94a3b8; margin: 0;">选择特定人员以导出相关记录</p>
                                </div>
                            </div>

                            <!-- (已移除 CSV 选项，默认仅支持 Excel) -->
                            <div class="export-format-section" style="display: none;">
                                <h4>导出格式</h4>
                                <div class="export-format-options">
                                    <label class="export-format-option">
                                        <input type="radio" name="exportFormat" value="excel" checked style="display: none;">
                                        <div class="export-format-card">
                                            <span class="material-icons-round">table_chart</span>
                                            <span>Excel (.xlsx)</span>
                                        </div>
                                    </label>
                                </div>
                            </div>

                            <!-- 导出信息汇总 -->
                            <div class="export-config-summary">
                                <h4>导出配置汇总</h4>
                                <div class="export-summary-items">
                                    <div class="export-summary-item">
                                        <span class="export-summary-label">导出类型:</span>
                                        <span class="export-summary-value" id="exportConfigType">-</span>
                                    </div>
                                    <div class="export-summary-item export-summary-date" style="display: none;">
                                        <span class="export-summary-label">时间范围:</span>
                                        <span class="export-summary-value" id="exportConfigRange">-</span>
                                    </div>
                                    <div class="export-summary-item">
                                        <span class="export-summary-label">导出格式:</span>
                                        <span class="export-summary-value" id="exportConfigFormat">Excel</span>
                                    </div>
                                </div>
                                </div>
                            </div>
                            <!-- 隐藏之前的汇总部分减少高度 -->
                        </div>

                        <!-- 步骤 3：导出进度 -->
                        <div class="export-step-content" data-step="3" style="height: 100%; display: none; flex-direction: column; justify-content: center;">
                            <div style="text-align: center; margin-bottom: 24px;">
                                <h3 style="margin-bottom: 8px;">导出进度</h3>
                                <p style="color: #64748b; font-size: 14px; margin: 0;">正在生成文件，请稍候...</p>
                            </div>
                            <div class="export-progress-section" style="max-width: 400px; margin: 0 auto; width: 100%;">
                                <div class="export-progress-bar-container" style="margin-bottom: 24px;">
                                    <div class="export-progress-bar" style="height: 12px; background-color: #f1f5f9; border-radius: 6px;">
                                        <div class="export-progress-fill" id="exportProgressFill" style="width: 0%; height: 100%; border-radius: 6px; background: linear-gradient(90deg, #0ea5e9, #3b82f6); transition: width 0.3s ease;"></div>
                                    </div>
                                    <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 12px; color: #64748b;">
                                        <span id="exportProgressMsg">准备就绪</span>
                                        <span id="exportProgressPercent" style="font-weight: 600; color: #0ea5e9;">0%</span>
                                    </div>
                                </div>
                                <div class="export-progress-details" id="exportProgressDetails" style="display: none; text-align: left; margin-top: 24px;">
                                    <!-- 详细进度信息 -->
                                </div>
                            </div>
                        </div>
                        <!-- 步骤指示器 (移动到底部) -->
                        <div class="export-steps" style="margin-top: 16px; padding: 0 16px;">
                            <div class="step active" data-step="1">
                                <span class="step-number" style="width: 24px; height: 24px; font-size: 12px;">1</span>
                                <span class="step-label" style="font-size: 12px;">类型</span>
                            </div>
                            <div class="step-connector"></div>
                            <div class="step" data-step="2">
                                <span class="step-number" style="width: 24px; height: 24px; font-size: 12px;">2</span>
                                <span class="step-label" style="font-size: 12px;">配置</span>
                            </div>
                            <div class="step-connector"></div>
                            <div class="step" data-step="3">
                                <span class="step-number" style="width: 24px; height: 24px; font-size: 12px;">3</span>
                                <span class="step-label" style="font-size: 12px;">导出</span>
                            </div>
                        </div>
                    </div>

                    <!-- 对话框底部 -->
                    <div class="export-dialog-footer">
                        <div class="export-dialog-actions">
                            <div class="export-dialog-spacer"></div>
                            <button id="exportDialogPrevBtn" class="export-btn-secondary" style="margin-right: 12px; display: none;">
                                <span class="material-icons-round">arrow_back</span>
                                上一步
                            </button>
                            <button id="exportDialogCancelBtn" class="export-btn-secondary" style="margin-right: 12px;">
                                取消
                            </button>
                            <!-- 复制按钮已移除 -->
                            <button id="exportDialogNextBtn" class="export-btn-primary" disabled>
                                <span class="material-icons-round">arrow_forward</span>
                                下一步
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        return html;
    }

    /**
     * 初始化对话框样式
     */
    function injectStyles() {
        const existingStyle = document.getElementById('exportDialogStyles');
        if (existingStyle) existingStyle.remove();

        const style = document.createElement('style');
        style.id = 'exportDialogStyles';
        style.textContent = `
            /* ========== 现代弹窗样式 ========== */
            .export-dialog-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(15, 23, 42, 0.45); /* 深色遮罩 */
                backdrop-filter: blur(4px); /* 毛玻璃 */
                z-index: 9999;
                display: flex;
                align-items: center;
                justify-content: center;
                animation: fadeIn 0.2s ease;
            }

            .export-dialog-container {
                background: #ffffff;
                border-radius: 16px; /* 更大的圆角 */
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
                width: 90%;
                max-width: 600px;
                max-height: 85vh;
                display: flex !important;
                flex-direction: column !important;
                position: relative !important;
                overflow: hidden;
                animation: scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: 'Inter', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }

            @keyframes scaleIn {
                from { opacity: 0; transform: scale(0.95) translateY(10px); }
                to { opacity: 1; transform: scale(1) translateY(0); }
            }

            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

            /* ========== 头部 ========== */
            .export-dialog-header {
                padding: 16px 24px;
                border-bottom: 1px solid #f1f5f9;
                background: #fff;
                display: flex;
                align-items: center;
                justify-content: space-between;
            }

            .export-dialog-title {
                display: flex;
                align-items: center;
                gap: 12px;
                margin: 0;
            }

            .export-dialog-title h2 {
                margin: 0;
                font-size: 18px;
                font-weight: 600;
                color: #0f172a;
                letter-spacing: -0.025em;
            }

            .export-dialog-title .material-icons-round {
                color: #3b82f6; 
                font-size: 24px;
                background: #eff6ff;
                padding: 8px;
                border-radius: 10px;
            }

            .export-dialog-close {
                background: transparent;
                border: none;
                color: #94a3b8;
                cursor: pointer;
                padding: 8px;
                border-radius: 8px;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                justify-content: center;
            }

            .export-dialog-close:hover {
                background: #f1f5f9;
                color: #64748b;
            }

            /* ========== 内容区域 ========== */
            .export-dialog-content {
                flex: 1;
                overflow-y: auto;
                padding: 24px;
                display: flex;
                flex-direction: column;
                background: #fafafa; /* 极淡灰背景 */
            }

            .export-step-content {
                animation: fadeIn 0.3s ease;
            }

            .export-step-content h3 {
                margin: 0 0 16px 0;
                font-size: 16px;
                font-weight: 600;
                color: #334155;
            }

            /* ========== 类型选择 ========== */
            .export-type-selector {
                gap: 16px;
                display: flex;
                flex-direction: column;
            }

            .export-type-option { 
                cursor: pointer; 
                user-select: none;
            }

            .export-type-card {
                display: flex;
                align-items: center;
                gap: 16px;
                padding: 16px;
                background: #fff;
                border: 1px solid #e2e8f0;
                border-radius: 12px;
                transition: all 0.2s ease;
                box-shadow: 0 1px 2px rgba(0,0,0,0.05);
            }

            .export-type-option:hover .export-type-card {
                border-color: #93c5fd;
                transform: translateY(-1px);
                box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            }

            .export-type-option input:checked + .export-type-card {
                border-color: #3b82f6;
                background: #eff6ff;
                box-shadow: 0 0 0 1px #3b82f6;
            }

            .export-type-icon {
                width: 44px;
                height: 44px;
                background: #f8fafc;
                border-radius: 10px;
                display: flex;
                align-items: center;
                justify-content: center;
                color: #64748b;
                font-size: 22px;
                transition: color 0.2s;
            }

            .export-type-option input:checked + .export-type-card .export-type-icon {
                background: #dbeafe;
                color: #3b82f6;
            }

            .export-type-info {
                flex: 1;
            }

            .export-type-info h4 {
                margin: 0 0 4px 0;
                font-size: 15px;
                font-weight: 600;
                color: #0f172a;
            }

            .export-type-info p {
                margin: 0;
                font-size: 13px;
                color: #64748b;
            }
            
            .export-type-check {
                display: none;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                color: #0ea5e9;
            }

            .export-type-option input:checked + .export-type-card .export-type-check {
                display: flex;
            }

            /* ========== 底部区域 (步骤条 + 按钮) ========== */
            .export-dialog-footer {
                padding: 16px 24px;
                background: #fff;
                border-top: 1px solid #f1f5f9;
                display: flex;
                flex-direction: column; 
                gap: 16px;
            }

            /* Refined Steps Indicator */
            .export-steps {
                display: flex;
                justify-content: center;
                align-items: center;
                margin-bottom: 8px;
            }

            .step {
                display: flex;
                align-items: center;
                gap: 8px;
                color: #94a3b8;
                font-weight: 500;
                font-size: 13px;
                position: relative;
            }

            .step.active {
                color: #3b82f6;
                font-weight: 600;
            }

            .step-number {
                width: 24px;
                height: 24px;
                border-radius: 50%;
                background: #f1f5f9;
                color: #64748b;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 12px;
                font-weight: 700;
                transition: all 0.3s;
            }

            .step.active .step-number {
                background: #3b82f6;
                color: #fff;
                box-shadow: 0 0 0 3px #dbeafe;
            }

            .step-connector {
                width: 40px;
                height: 2px;
                background: #e2e8f0;
                margin: 0 12px;
                border-radius: 2px;
            }

            .step.active + .step-connector {
                background: #cbd5e1;
            }

            /* ========== 按钮组 ========== */
            .export-dialog-actions {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                margin-top: 0; 
            }

            .btn-secondary {
                padding: 10px 20px;
                border: 1px solid #cbd5e1;
                background: #fff;
                color: #475569;
                border-radius: 8px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
                font-size: 14px;
            }

            .btn-secondary:hover {
                background: #f8fafc;
                border-color: #94a3b8;
                color: #334155;
            }

            .btn-primary {
                padding: 10px 24px;
                background: #3b82f6;
                color: white;
                border: none;
                border-radius: 8px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
                box-shadow: 0 4px 6px -1px rgba(59, 130, 246, 0.4);
                font-size: 14px;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .btn-primary:hover {
                background: #2563eb;
                transform: translateY(-1px);
                box-shadow: 0 6px 8px -1px rgba(59, 130, 246, 0.5);
            }

            .btn-primary:disabled {
                background: #94a3b8;
                cursor: not-allowed;
                transform: none;
                box-shadow: none;
            }
            
            /* Form Style Polish */
             .export-date-range-section {
                background: #fff;
                border: 1px solid #e2e8f0;
                border-radius: 12px;
                padding: 20px;
                box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                margin-bottom: 20px;
            }
            
            .export-form-group input, .export-form-group select {
                width: 100%;
                padding: 10px 14px;
                border: 1px solid #cbd5e1;
                border-radius: 8px;
                font-size: 14px;
                transition: all 0.2s;
                background: #fff;
                box-sizing: border-box; 
            }
            .export-form-group input:focus, .export-form-group select:focus {
                border-color: #3b82f6;
                box-shadow: 0 0 0 3px #dbeafe;
                outline: none;
            }
            
            .export-preset-btn {
                background: #fff;
                border: 1px solid #e2e8f0;
                color: #475569;
                padding: 6px 12px;
                border-radius: 6px;
                font-size: 12px;
                cursor: pointer;
                transition: all 0.2s;
            }
            .export-preset-btn:hover {
                border-color: #93c5fd;
                color: #3b82f6;
                background: #eff6ff;
            }
            .export-preset-btn.active {
                border-color: #3b82f6;
                color: #3b82f6;
                background: #eff6ff;
                font-weight: 500;
                box-shadow: 0 0 0 1px #3b82f6;
            }

            /* Hidden Utility */
            .hidden { display: none !important; }
    `;

        document.head.appendChild(style);
    }

    /**
     * 关闭对话框
     */
    function close() {
        if (modalOverlay) modalOverlay.style.display = 'none';
        if (dialogElement) dialogElement.style.display = 'none';
        document.body.style.overflow = '';
        state.isOpen = false;
        resetState();
    }

    /**
     * 初始化对话框
     */
    function init() {
        // 防止重复创建：先移除已存在的 DOM
        const existing = document.getElementById('exportDialogOverlay');
        if (existing) {
            existing.remove();
            dialogElement = null; // 重置引用
        }

        if (dialogElement) return; // double check

        // 注入样式
        injectStyles();

        // 创建 HTML
        const html = createDialogHTML();
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const element = tempDiv.firstElementChild;
        document.body.appendChild(element);

        modalOverlay = document.getElementById('exportDialogOverlay');
        dialogElement = document.getElementById('exportDialog');

        // 绑定事件
        bindEvents();
    }

    /**
     * 绑定事件处理
     */
    /**
     * 绑定事件处理
     */
    function bindEvents() {
        // 关闭按钮 (Header & Footer)
        document.querySelectorAll('.export-dialog-close, #exportDialogCancelBtn').forEach(btn => {
            btn.addEventListener('click', close);
        });

        // 侧边栏类型选择
        document.querySelectorAll('.export-type-item').forEach(item => {
            item.addEventListener('click', () => {
                const typeId = item.getAttribute('data-type');
                selectExportType(typeId);
            });
        });

        // 快速日期选择
        document.querySelectorAll('.export-preset-btn').forEach(btn => {
            btn.addEventListener('click', function () {
                const preset = this.getAttribute('data-preset');
                setQuickSelectDate(preset);
            });
        });

        // 日期输入变化
        const startInput = document.getElementById('exportStartDate');
        const endInput = document.getElementById('exportEndDate');
        if (startInput) startInput.addEventListener('change', validateForm);
        if (endInput) endInput.addEventListener('change', validateForm);

        // 导出按钮
        const exportBtn = document.getElementById('exportBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', performExport);
        }

        // 点击背景关闭
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                close();
            }
        });

        // 复制按钮事件 (已移除)
    }

    /**
     * 选择导出类型
     */
    function selectExportType(typeId) {
        // 防御性检查
        const config = EXPORT_TYPE_CONFIG[typeId];
        if (!config) {
            return;
        }

        state.selectedType = typeId;

        // 1. 更新侧边栏状态
        document.querySelectorAll('.export-type-item').forEach(item => {
            const isActive = item.getAttribute('data-type') === typeId;
            item.classList.toggle('active', isActive);
        });

        // 2. 更新头部信息
        const titleEl = document.getElementById('exportMainTitle');
        const descEl = document.getElementById('exportMainDesc');
        if (titleEl) titleEl.textContent = config.label;
        if (descEl) descEl.textContent = config.description;

        // 3. 显示配置容器
        const configContainer = document.getElementById('exportConfigContainer');
        if (configContainer) configContainer.style.display = 'block';

        // 4. 显示/隐藏日期范围
        const dateSection = document.getElementById('dateRangeSection');
        if (dateSection) {
            dateSection.style.display = config.requiresDateRange ? 'block' : 'none';
        }

        // 5. 显示/隐藏筛选区域（老师授课记录时显示学生+教师筛选）
        const filterSection = document.getElementById('exportFilterSection');
        const studentFilter = document.getElementById('exportStudentFilter');
        const teacherFilter = document.getElementById('exportTeacherFilter');
        const showFilters = (typeId === EXPORT_TYPES.TEACHER_SCHEDULE);

        // 显示筛选区域容器
        if (filterSection) {
            filterSection.style.display = showFilters ? 'block' : 'none';
        }

        // 显示学生筛选
        if (studentFilter) {
            studentFilter.style.display = showFilters ? 'block' : 'none';
            if (showFilters && !state.studentsLoaded) {
                loadStudentList();
            }
        }

        // 显示教师筛选
        if (teacherFilter) {
            teacherFilter.style.display = showFilters ? 'block' : 'none';
            if (showFilters && !state.teachersLoaded) {
                loadTeacherList();
            }
        }

        // 如果需要日期范围且未设置，默认选中本月
        if (config.requiresDateRange && (!state.startDate || !state.endDate)) {
            setQuickSelectDate('last-month');
        } else {
            validateForm();
        }
    }

    /**
     * 应用日期预设
     */
    /**
     * 应用日期预设
     */
    function setQuickSelectDate(preset) {
        const today = new Date();
        const year = today.getFullYear();
        let start, end;

        // 辅助格式化
        const formatDate = (d) => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        };

        const getWeekRange = (date, offset = 0) => {
            const currentDay = date.getDay(); // 0-6 (Sun-Sat)
            const diffToMon = currentDay === 0 ? 6 : currentDay - 1;
            const mon = new Date(date);
            mon.setDate(date.getDate() - diffToMon + (offset * 7));
            const sun = new Date(mon);
            sun.setDate(mon.getDate() + 6);
            return [mon, sun];
        };

        switch (preset) {
            case 'week': {
                // 本周
                const [mon, sun] = getWeekRange(today, 0);
                start = formatDate(mon);
                end = formatDate(sun);
                break;
            }
            case 'last-week': {
                // 上周
                const [mon, sun] = getWeekRange(today, -1);
                start = formatDate(mon);
                end = formatDate(sun);
                break;
            }
            case 'month': {
                // 本月
                const firstDay = new Date(year, today.getMonth(), 1);
                const lastDay = new Date(year, today.getMonth() + 1, 0);
                start = formatDate(firstDay);
                end = formatDate(lastDay);
                break;
            }
            case 'last-month': {
                // 上月
                const firstDay = new Date(year, today.getMonth() - 1, 1);
                const lastDay = new Date(year, today.getMonth(), 0);
                start = formatDate(firstDay);
                end = formatDate(lastDay);
                break;
            }
            case 'quarter': {
                // 本季度
                const currMonth = today.getMonth();
                const startMonth = Math.floor(currMonth / 3) * 3;
                const firstDay = new Date(year, startMonth, 1);
                const lastDay = new Date(year, startMonth + 3, 0);
                start = formatDate(firstDay);
                end = formatDate(lastDay);
                break;
            }
            case 'last-quarter': {
                // 上季度
                const currMonth = today.getMonth();
                const startMonth = Math.floor(currMonth / 3) * 3 - 3; // Move back 3 months
                const firstDay = new Date(year, startMonth, 1);
                // end date is last day of the quarter (startMonth + 3)
                // Note: new Date(year, month, 0) gives last day of previous month, so we want startMonth + 3
                const lastDay = new Date(year, startMonth + 3, 0);
                start = formatDate(firstDay);
                end = formatDate(lastDay);
                break;
            }
            default:
                break;
        }

        const sInput = document.getElementById('exportStartDate');
        const eInput = document.getElementById('exportEndDate');
        if (sInput && start) sInput.value = start;
        if (eInput && end) eInput.value = end;

        // 更新按钮状态
        document.querySelectorAll('.export-preset-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-preset') === preset);
        });

        validateForm();
    }

    /**
     * 加载学生列表
     */
    async function loadStudentList() {
        const studentSelect = document.getElementById('exportStudentSelect');
        if (!studentSelect) return;

        // 优先检查本地缓存
        let cachedData = null;
        try {
            const raw = localStorage.getItem('cached_students_full');
            if (raw) cachedData = JSON.parse(raw);
        } catch (e) {
        }

        const renderList = (list) => {
            let html = '<option value="">全部学生</option>';
            // Sort by name for better UX
            list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            list.forEach(s => {
                const name = s.name || s.username || '未知';
                html += `<option value="${s.id}">${name}</option>`;
            });
            studentSelect.innerHTML = html;
        };

        if (cachedData && Array.isArray(cachedData) && cachedData.length > 0) {
            // 使用缓存立即渲染
            renderList(cachedData);
            studentSelect.disabled = false;
            state.studentsLoaded = true;
            // 仍然可以在后台更新缓存（可选，如果用户要求"进入系统读取"则此处可能不需要强制刷新，除非缓存为空。但为了保证数据新鲜度，可以静默更新）
            // 用户逻辑："用户进入系统读取的时候将学生和老师列表保存到本地缓存", 此处我们先用缓存，如果缓存没有，则 Fetch
        } else {
            // 无缓存，显示 Loading 并请求
            studentSelect.innerHTML = '<option value="">加载中...</option>';
            studentSelect.disabled = true;
        }

        // 无论有无缓存，如果当前尚未标记为 'fresh' (或者我们决定每次打开都静默刷新)，都可以尝试 Fetch。
        // 但为了避免 UI 跳变和 "加载不出" 的问题，如果有了缓存，我们在本次会话中就不必频繁 Fetch，除非显式触发刷新。
        // 根据用户描述："用户进入系统读取的时候...保存到本地缓存"，我们可以在 Dialog Init 或者 Admin Init 加载一次。
        // 这里作为 fallback：如果没有缓存，或者缓存数据为空，强制 Fetch。如果有缓存，我们可以信任缓存（由 Admin 模块负责更新）。

        if (!cachedData || cachedData.length === 0) {
            try {
                const response = await window.apiUtils.get('/admin/users/student');
                const students = Array.isArray(response) ? response : (response.data || []);

                // 更新缓存
                localStorage.setItem('cached_students_full', JSON.stringify(students));

                // 渲染
                renderList(students);
                studentSelect.disabled = false;
                state.studentsLoaded = true;
            } catch (e) {
                console.error('Failed to load students:', e);
                // 如果没有缓存且加载失败
                if (!cachedData) {
                    studentSelect.innerHTML = '<option value="">加载失败</option>';
                    studentSelect.disabled = false;
                }
            }
        }
    }

    /**
     * 加载教师列表
     */
    async function loadTeacherList() {
        const teacherSelect = document.getElementById('exportTeacherSelect');
        if (!teacherSelect) return;

        // 优先检查本地缓存
        let cachedData = null;
        try {
            const raw = localStorage.getItem('cached_teachers_full');
            if (raw) cachedData = JSON.parse(raw);
        } catch (e) {
        }

        const renderList = (list) => {
            let html = '<option value="">全部教师</option>';
            const activeTeachers = list.filter(t => Number(t.status) !== -1);
            activeTeachers.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
            activeTeachers.forEach(t => {
                const name = t.name || t.username || '未知';
                html += `<option value="${t.id}">${name}</option>`;
            });
            teacherSelect.innerHTML = html;
        };

        if (cachedData && Array.isArray(cachedData) && cachedData.length > 0) {
            renderList(cachedData);
            teacherSelect.disabled = false;
            state.teachersLoaded = true;
        } else {
            teacherSelect.innerHTML = '<option value="">加载中...</option>';
            teacherSelect.disabled = true;
        }

        if (!cachedData || cachedData.length === 0) {
            try {
                const response = await window.apiUtils.get('/admin/users/teacher');
                const teachers = Array.isArray(response) ? response : (response.data || []);

                // 更新缓存
                localStorage.setItem('cached_teachers_full', JSON.stringify(teachers));

                renderList(teachers);
                teacherSelect.disabled = false;
                state.teachersLoaded = true;
            } catch (e) {
                console.error('Failed to load teachers:', e);
                if (!cachedData) {
                    teacherSelect.innerHTML = '<option value="">加载失败</option>';
                    teacherSelect.disabled = false;
                }
            }
        }
    }


    /**
     * 验证表单并更新按钮状态
     */
    function validateForm() {
        const exportBtn = document.getElementById('exportBtn');
        const msgSpan = document.getElementById('exportDateValidationMsg');
        if (!state.selectedType) {
            if (exportBtn) exportBtn.disabled = true;
            return;
        }

        const config = EXPORT_TYPE_CONFIG[state.selectedType];
        let isValid = true;
        let message = '';

        if (config.requiresDateRange) {
            const sVal = document.getElementById('exportStartDate')?.value;
            const eVal = document.getElementById('exportEndDate')?.value;

            if (!sVal || !eVal) {
                isValid = false;
            } else {
                const sDate = new Date(sVal);
                const eDate = new Date(eVal);

                if (sDate > eDate) {
                    isValid = false;
                    message = '开始日期不能晚于结束日期';
                } else if ((eDate - sDate) / (1000 * 3600 * 24) > 365) {
                    isValid = false;
                    message = '时间跨度不能超过一年';
                }

                if (isValid) {
                    state.startDate = sDate;
                    state.endDate = eDate;
                }
            }
        }

        if (msgSpan) {
            msgSpan.textContent = message;
            msgSpan.style.display = message ? 'block' : 'none';
            msgSpan.className = 'validation-msg error'; // Ensure style
        }

        if (exportBtn) exportBtn.disabled = !isValid;

        // 复制按钮状态更新 (已移除)
    }

    // performCopy 已被移除

    /**
     * 执行导出
     */
    async function performExport() {


        if (state.isExporting) {
            return;
        }
        state.isExporting = true;

        const typeConfig = EXPORT_TYPE_CONFIG[state.selectedType];
        const format = state.selectedFormat;

        if (!typeConfig) {
            console.error('[ExportDialog] 未选择导出类型或类型配置不存在:', state.selectedType);
            state.isExporting = false;
            return;
        }

        try {
            // 立即更新按钮状态
            const exportBtn = document.getElementById('exportDialogNextBtn');
            const originalBtnText = exportBtn ? exportBtn.innerHTML : '导出 Excel';
            if (exportBtn) {
                exportBtn.disabled = true;
                exportBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 文件导出中...';
            }

            // 更新 UI
            updateProgress(5, '验证参数...');
            // 减少模拟过渡动画时间，提升响应感
            await new Promise(r => setTimeout(r, 300));

            // 构建请求参数
            const params = new URLSearchParams({
                type: state.selectedType,
                format: format
            });

            // 添加学生筛选
            const studentSelect = document.getElementById('exportStudentSelect');
            if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE && studentSelect && studentSelect.value) {
                params.append('student_id', studentSelect.value);
            }

            // 添加教师筛选
            const teacherSelect = document.getElementById('exportTeacherSelect');
            if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE && teacherSelect && teacherSelect.value) {
                params.append('teacher_id', teacherSelect.value);
            }

            if (typeConfig.requiresDateRange) {
                if (!state.startDate || !state.endDate) {
                    throw new Error('需要有效的导出日期范围');
                }
                const startDateStr = state.startDate.toISOString().split('T')[0];
                const endDateStr = state.endDate.toISOString().split('T')[0];
                // 兼容不同后端命名习惯 (camelCase 和 snake_case)
                params.append('startDate', startDateStr);
                params.append('endDate', endDateStr);
                params.append('start_date', startDateStr);
                params.append('end_date', endDateStr);
            }

            // 确保 type 也传对
            params.append('type_id', state.selectedType || '');



            // 确保类型数据已加载
            if (window.ScheduleTypesStore) {
                await window.ScheduleTypesStore.init();
            }

            updateProgress(20, '正在加载数据...');
            await new Promise(r => setTimeout(r, 300));

            // 调用导出 API
            // 根据角色判断调用哪个接口
            let apiUrl = `/admin/export-advanced?${params.toString()}`;
            const currentUser = window.currentUser || {};
            const userType = currentUser.userType || 'admin';

            if (userType === 'teacher') {
                apiUrl = `/api/teacher/export?${params.toString()}`;
            } else if (userType === 'student') {
                apiUrl = `/api/student/export?${params.toString()}`;
            }

            const response = await window.apiUtils.get(apiUrl);


            updateProgress(60, '正在生成文件...');
            await new Promise(r => setTimeout(r, 300));

            if (!response) {
                throw new Error('导出 API 返回为空');
            }

            // API 直接返回导出结果对象 {format, data, columns?, filename} 或直接返回数组
            const exportResult = response;

            // 5. 构建优化后的文件名
            // 5. 构建优化后的文件名
            // 格式要求：
            // 管理员: [教师/学生]授课记录指定时间[开始_结束]_当前[管理员名].xlsx
            // 教师/学生: [姓名]授课记录[开始_结束]_当前.xlsx

            const now = new Date();
            const yyyyMMdd = now.toISOString().slice(0, 10).replace(/-/g, '');
            const hhmmss = now.toTimeString().slice(0, 8).replace(/:/g, '');
            const timestamp = `${yyyyMMdd}${hhmmss}`; // YYYYMMDDHHMMSS

            let dateRangeStr = '';
            if (state.startDate && state.endDate) {
                const s = state.startDate.toISOString().split('T')[0].replace(/-/g, '');
                const e = state.endDate.toISOString().split('T')[0].replace(/-/g, '');
                dateRangeStr = `[${s}_${e}]`;
            }

            // 尝试获取用户数据 (兼容 window.currentUser 或 localStorage)
            let appUser = currentUser || {};
            if (!appUser.username && !appUser.name) {
                try {
                    const localData = JSON.parse(localStorage.getItem('userData'));
                    if (localData) appUser = localData;
                } catch (e) {
                }
            }
            let filename = '';

            // 优先使用后端返回的文件名，但在 "老师授课记录" 和 "学生排课记录" 场景下，强制使用前端生成的格式
            if (exportResult && exportResult.filename &&
                state.selectedType !== EXPORT_TYPES.TEACHER_SCHEDULE &&
                state.selectedType !== EXPORT_TYPES.STUDENT_SCHEDULE) {
                filename = exportResult.filename;
            } else {
                if (userType === 'admin') {
                    // 管理员格式
                    // 授课记录指定时间 -> 这里的 typeConfig.label 可能是 "教师授课记录" 或 "学生授课记录"
                    // 去掉可能的 "导出" 字样，保持核心名词
                    let coreName = typeConfig.label || '数据导出';
                    // 如果是特定格式的需求，强制调整 coreName
                    if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) coreName = '教师授课记录';
                    if (state.selectedType === EXPORT_TYPES.STUDENT_SCHEDULE) coreName = '学生排课记录';

                    // 管理员名称使用 username
                    const adminName = appUser.username || appUser.name || 'admin';

                    // 获取筛选值文本
                    const studentSelect = document.getElementById('exportStudentSelect');
                    const teacherSelect = document.getElementById('exportTeacherSelect');

                    let studentFilterStr = '全部学生';
                    if (studentSelect && studentSelect.value) {
                        const option = studentSelect.options[studentSelect.selectedIndex];
                        if (option) studentFilterStr = option.text;
                    }

                    let teacherFilterStr = '全部教师';
                    if (teacherSelect && teacherSelect.value) {
                        const option = teacherSelect.options[teacherSelect.selectedIndex];
                        if (option) teacherFilterStr = option.text;
                    }

                    // 格式：教师授课/学生排课记录[学生筛选][老师筛选][导出日期段][导出人用户名]_当前时间戳
                    filename = `${coreName}[${studentFilterStr}][${teacherFilterStr}]${dateRangeStr}[${adminName}]_${timestamp}`;
                } else {
                    // 教师/学生格式
                    // [姓名]授课记录[开始_结束]_当前
                    const myName = appUser.name || appUser.username || '用户';

                    filename = `[${myName}]授课记录${dateRangeStr}_${timestamp}`;
                }

                filename += `.${format === EXPORT_FORMATS.EXCEL ? 'xlsx' : 'csv'}`;
            }

            // 生成文件 - 传递 filename 参数
            // 兼容直接返回数组，或嵌套在 data.data 中的情况
            let rawData = [];

            if (Array.isArray(exportResult)) {
                rawData = exportResult;
            } else if (exportResult && exportResult.data) {
                if (Array.isArray(exportResult.data)) {
                    rawData = exportResult.data;
                } else if (Array.isArray(exportResult.data.data)) {
                    rawData = exportResult.data.data;
                }
            }



            // const studentSelect ... (removed to fix lint, already declared)
            const selectedStudentId = (document.getElementById('exportStudentSelect') || {}).value;
            // Get selected student name for remark generation
            let selectedStudentName = '全部学生';
            const studentSelectEl = document.getElementById('exportStudentSelect');
            if (studentSelectEl && studentSelectEl.value) {
                const opt = studentSelectEl.options[studentSelectEl.selectedIndex];
                if (opt) selectedStudentName = opt.text;
            }

            const transformedData = transformExportData(rawData, selectedStudentId, selectedStudentName, userType);

            if (format === EXPORT_FORMATS.EXCEL) {
                await generateExcelFile(transformedData, filename);
            } else {
                // CSV 不支持多 Sheet，如果是多 Sheet 数据，默认仅导出 "总览表"
                let csvData = transformedData;

                if (!Array.isArray(transformedData)) {
                    if (transformedData['总览表']) {
                        csvData = transformedData['总览表'];
                    } else if (typeof transformedData === 'object') {
                        // 兜底：如果没找到"总览表"，取第一个是数组的值
                        const values = Object.values(transformedData);
                        const firstArray = values.find(v => Array.isArray(v));
                        if (firstArray) {
                            csvData = firstArray;
                        }
                    }
                }

                generateCsvFile(csvData, filename);
            }


            /**
             * 转换导出数据：映射列名，格式化类型和状态
             * @param {Array} originalData 原始数据数组
             * @returns {Array|Object} 转换后的数据数组或多 Sheet 对象
             */
            // 生成日历排课表数据
            function transformToCalendarData(originalData, startDate, endDate, studentId) {
                if (!startDate || !endDate) return [];

                // 1. 生成完整日期序列
                const fullDateList = [];
                let curr = new Date(startDate);
                const end = new Date(endDate);
                while (curr <= end) {
                    fullDateList.push(curr.toISOString().split('T')[0]);
                    curr.setDate(curr.getDate() + 1);
                }

                // 2. 预处理数据 & 按日期分组
                const dataByDate = {}; // date -> rows
                if (Array.isArray(originalData)) {
                    originalData.forEach(row => {
                        let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
                        if (dateStr) {
                            const d = new Date(dateStr);
                            if (!isNaN(d.getTime())) {
                                const year = d.getFullYear();
                                const month = String(d.getMonth() + 1).padStart(2, '0');
                                const day = String(d.getDate()).padStart(2, '0');
                                dateStr = `${year}-${month}-${day}`;
                            } else if (dateStr.includes('T')) {
                                dateStr = dateStr.split('T')[0];
                            }
                        }
                        if (!dateStr) return;

                        if (!dataByDate[dateStr]) dataByDate[dateStr] = [];

                        // 解析时间
                        let sTime = row.start_time || row.startTime || row.begin_time;
                        let eTime = row.end_time || row.endTime || row.finish_time;
                        if ((!sTime || !eTime)) {
                            const range = row['时间段'] || row.time_range;
                            if (range && range.includes('-')) {
                                [sTime, eTime] = range.split('-');
                            }
                        }
                        const fmtMeta = (t) => {
                            if (!t) return '';
                            const match = String(t).match(/(\d{1,2}:\d{2})/);
                            return match ? match[1].padStart(5, '0') : String(t);
                        };
                        sTime = fmtMeta(sTime);
                        eTime = fmtMeta(eTime);
                        const timeRange = (sTime && eTime) ? `${sTime} -${eTime} ` : (row['时间段'] || row.time_range || '全天');

                        // 解析并汉化类型（保持原始显示，如"（线上）评审"）
                        let typeName = row.type || row.type_name || row['类型'] || '';
                        const lowerType = String(typeName).toLowerCase();
                        if (lowerType === 'review_record' || lowerType === 'review record') typeName = '评审记录';
                        else if (lowerType === 'advisory') typeName = '咨询';
                        else if (lowerType === 'review') typeName = '评审';
                        else if (lowerType === 'review_online' || lowerType === 'online_review') typeName = '（线上）评审';
                        else if (lowerType === 'trial') typeName = '试教';
                        else if (lowerType === 'visit') typeName = '入户';
                        else if (lowerType === 'visit_online' || lowerType === 'online_visit') typeName = '（线上）入户';
                        else if (lowerType === 'half_visit' || lowerType === 'half visit') typeName = '半次入户';
                        else if (lowerType === 'group' || lowerType === 'group activity') typeName = '集体';

                        let groupType = 'normal';
                        if (typeName.includes('评审') || typeName.includes('咨询')) {
                            groupType = 'review_group';
                        }

                        dataByDate[dateStr].push({
                            ...row,
                            _parsedDate: dateStr,
                            _parsedTimeRange: timeRange,
                            _typeName: typeName,
                            _groupType: groupType,
                            _sTime: sTime // 用于排序
                        });
                    });
                }

                // 辅助函数：计算ISO周次
                const getISOWeekNumber = (d) => {
                    const date = new Date(d.getTime());
                    date.setHours(0, 0, 0, 0);
                    date.setDate(date.getDate() + 3 - (date.getDay() + 6) % 7);
                    const week1 = new Date(date.getFullYear(), 0, 4);
                    return 1 + Math.round(((date.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
                };

                // 3. 组装结果 (Row Splitting Logic)
                const resultRows = [];
                const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

                fullDateList.forEach(date => {
                    const dObj = new Date(date);
                    const weekStr = days[dObj.getDay()];
                    const isSunday = dObj.getDay() === 0;
                    const weekNumber = getISOWeekNumber(dObj);

                    const dayRows = dataByDate[date] || [];

                    // 如果当天无数据，也输出一行占位
                    if (dayRows.length === 0) {
                        resultRows.push({
                            '日期': date,
                            '星期': weekStr,
                            '计划安排': '',
                            '实际安排': '',
                            '费用': '',
                            '周汇总': '',
                            '_isRedRow': false,
                            '_isSunday': isSunday,
                            '_weekNumber': weekNumber
                        });
                        return;
                    }

                    // 按时间排序
                    dayRows.sort((a, b) => (a._sTime || '').localeCompare(b._sTime || ''));

                    // 分组聚合
                    const timeSlots = {};
                    dayRows.forEach(item => {
                        const key = item._parsedTimeRange;
                        if (!timeSlots[key]) timeSlots[key] = { reviewItems: [], normalItems: [] };
                        if (item._groupType === 'review_group') timeSlots[key].reviewItems.push(item);
                        else timeSlots[key].normalItems.push(item);
                    });

                    // Flatten Logic: Each event becomes a separate row
                    // We will just process them in order and push them.
                    // Merging happens in generateExcelFile
                    Object.keys(timeSlots).sort().forEach(time => {
                        const group = timeSlots[time];

                        // 1. 评审组/咨询 (Review Group)
                        if (group.reviewItems.length > 0) {
                            // 按学生分组，确保不同学生的评审是分行的
                            const reviewsByStudent = {};
                            group.reviewItems.forEach(r => {
                                const sName = r.student_name || r['学生名称'] || r.name || 'Unknown';
                                if (!reviewsByStudent[sName]) reviewsByStudent[sName] = [];
                                reviewsByStudent[sName].push(r);
                            });

                            Object.keys(reviewsByStudent).forEach(sName => {
                                const items = reviewsByStudent[sName];

                                const mainTypeSet = new Set();
                                const teachers = [];  // 改为数组存储教师信息
                                const recorders = [];  // 改为数组存储记录教师信息
                                const teacherMap = new Map();  // 用于去重
                                const recorderMap = new Map();  // 用于去重

                                let allCancelled = true;

                                items.forEach(r => {
                                    const status = r.status || r['状态'];
                                    const isCancelled = (status === 'cancelled' || status === '已取消');
                                    if (!isCancelled) allCancelled = false;

                                    // 提取教师ID和名称
                                    const tid = r.teacher_id || r.id || r['教师ID'] || 0;
                                    const tName = r.teacher_name || r.name || r['教师名称'];

                                    if (!tName) return;

                                    if (r._typeName.includes('记录')) {
                                        // 记录教师去重并存储
                                        if (!recorderMap.has(tid)) {
                                            recorderMap.set(tid, { id: tid, name: tName });
                                            recorders.push({ id: tid, name: tName });
                                        }
                                    } else {
                                        mainTypeSet.add(r._typeName);
                                        // 主教师去重并存储
                                        if (!teacherMap.has(tid)) {
                                            teacherMap.set(tid, { id: tid, name: tName });
                                            teachers.push({ id: tid, name: tName });
                                        }
                                    }
                                });

                                const mainTypeStr = Array.from(mainTypeSet).join('/') || '评审';

                                // 按教师ID排序
                                teachers.sort((a, b) => Number(a.id) - Number(b.id));
                                recorders.sort((a, b) => Number(a.id) - Number(b.id));

                                // Detail: Teachers only (student name is in prefix)
                                const detailParts = [];
                                const teachStr = teachers.map(t => t.name).join(', ');
                                if (teachStr) detailParts.push(teachStr);
                                const recStr = recorders.map(r => `${r.name} (记录)`).join(', ');
                                if (recStr) detailParts.push(recStr);

                                const detailContent = detailParts.join(', ');

                                // Prefix Logic
                                const shouldShowStudent = !studentId && sName !== 'Unknown';
                                const prefix = shouldShowStudent ? `[${sName}]` : '';

                                const planLine = `${prefix}${mainTypeStr} (${time}): ${detailContent} `;

                                // Actual Line Logic
                                let actualLine = planLine;
                                if (allCancelled) {
                                    // 合并所有教师并按ID排序
                                    const allTeachers = [...teachers, ...recorders];
                                    const uniqueMap = new Map();
                                    allTeachers.forEach(t => uniqueMap.set(t.id, t));
                                    const sortedAll = Array.from(uniqueMap.values()).sort((a, b) => Number(a.id) - Number(b.id));
                                    const allT = sortedAll.map(t => t.name).join(',');
                                    actualLine = `已取消[${allT}, ${mainTypeStr}]`;
                                }


                                resultRows.push({
                                    '日期': date,
                                    '星期': weekStr,
                                    '计划安排': planLine,
                                    '实际安排': actualLine,
                                    '费用': '',
                                    '周汇总': '',
                                    '_isRedRow': true,
                                    '_isSunday': isSunday,
                                    '_weekNumber': weekNumber
                                });
                            });
                        }

                        // 2. 普通组 (Normal Group) - Each item is a row
                        group.normalItems.forEach(item => {
                            const type = item._typeName;
                            const teacher = item.teacher_name || item.name || item['教师名称'] || '-';
                            const shouldShowStudent = !studentId;
                            const studentName = item.student_name || item.name || item['学生名称'] || '';
                            const prefix = (shouldShowStudent && studentName) ? `[${studentName}]` : '';

                            const planLine = `${prefix}${type} (${time}): ${teacher} `;
                            let actualLine = planLine;

                            const status = item.status || item['状态'];
                            const isCancelled = (status === 'cancelled' || status === '已取消');

                            if (isCancelled) {
                                actualLine = `已取消[${teacher}, ${type}]`;
                            }

                            resultRows.push({
                                '日期': date,
                                '星期': weekStr,
                                '计划安排': planLine,
                                '实际安排': actualLine,
                                '费用': '',
                                '周汇总': '',
                                '_isRedRow': false,
                                '_isSunday': isSunday,
                                '_weekNumber': weekNumber
                            });
                        });
                    });
                });

                return resultRows;
            }

            /**
             * 数据转换处理函数
             * @param {Array} originalData 原始数据
             * @param {string} studentId 学生ID (可选)
             * @param {string} studentName 学生姓名 (可选)
             * @param {string} userType 用户类型 (通过调用方显式传入，默认 undefined)
             */
            function transformExportData(originalData, studentId, studentName = '全部学生', passedUserType) {
                if (!Array.isArray(originalData)) return [];

                // 状态映射
                const statusMap = {
                    1: '正常',
                    0: '已取消',
                    2: '已完成',
                    'pending': '待确认',
                    'confirmed': '已确认',
                    'completed': '已完成',
                    'cancelled': '已取消'
                };

                // 优先使用传入的 userType，否则尝试从全局获取，最后默认为 'admin'
                const currentUser = window.currentUser || {};
                const userType = passedUserType || currentUser.userType || 'admin';

                // 获取类型名称的辅助函数
                const getTypeName = (typeIdOrName) => {
                    if (!typeIdOrName) return '';
                    // 如果是数字ID，尝试查找
                    if (window.ScheduleTypesStore) {
                        const type = window.ScheduleTypesStore.getById(typeIdOrName);
                        if (type) return type.name || type.description;
                    }
                    return String(typeIdOrName);
                };

                // 转换基础数据（第一张表：排课明细）
                const baseData = originalData.map(row => {
                    // 解析日期和时间
                    let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
                    if (dateStr) {
                        const d = new Date(dateStr);
                        if (!isNaN(d.getTime())) {
                            const year = d.getFullYear();
                            const month = String(d.getMonth() + 1).padStart(2, '0');
                            const day = String(d.getDate()).padStart(2, '0');
                            dateStr = `${year}-${month}-${day}`;
                        } else if (dateStr.includes('T')) {
                            dateStr = dateStr.split('T')[0];
                        }
                    }

                    // 计算星期
                    let weekStr = '';
                    if (dateStr) {
                        const date = new Date(dateStr);
                        if (!isNaN(date.getTime())) {
                            const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
                            weekStr = days[date.getDay()];
                        }
                    }

                    // 3. 类型: 中文 (英文)
                    // 后端返回的 Keys 中包含 '类型' (值为英文 name, e.g. 'visit')
                    const rawTypeVal = row['类型'] || row.course_id || row.courseId || row.type || row.schedule_type || row.type_id;
                    let typeKey = '';
                    let typeDesc = '未知';

                    // 尝试从 Store 获取
                    if (window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getAll === 'function') {
                        const allTypes = window.ScheduleTypesStore.getAll();
                        let t = null;

                        // 1. 尝试通过 name 匹配 (e.g. rawTypeVal === 'visit')
                        t = allTypes.find(item => item.name === rawTypeVal);

                        // 2. 如果没找到，尝试通过 ID 匹配
                        if (!t) {
                            t = allTypes.find(item => String(item.id) === String(rawTypeVal));
                        }

                        if (t) {
                            typeKey = t.name || '';         // e.g. visit, review_online
                            typeDesc = t.description || '未知'; // e.g. 入户, （线上）评审
                        }
                    }

                    // 如果 Store 查找失败，但有原始值
                    if (typeDesc === '未知' && rawTypeVal) {
                        typeKey = String(rawTypeVal);
                    }

                    // 使用"中文 (英文)"格式显示
                    const typeStr = (typeDesc !== '未知' || (typeKey && typeKey !== '0')) ? `${typeDesc} (${typeKey})` : '未知';

                    // 4. 时间段 start_time-end_time
                    // 后端返回的 Keys 中包含 '时间'，或尝试 start_time
                    let timeStr = '';

                    // 优先检查 start_time / end_time (以防后端修正后返回这些字段)
                    let sTime = row.start_time || row.startTime || row.begin_time;
                    let eTime = row.end_time || row.endTime || row.finish_time;

                    if (sTime && eTime) {
                        const fmt = (t) => {
                            if (!t) return '';
                            const match = String(t).match(/(\d{1,2}:\d{2})/);
                            return match ? match[1].padStart(5, '0') : String(t);
                        };
                        timeStr = `${fmt(sTime)} -${fmt(eTime)} `;
                    } else if (row['时间']) {
                        // 如果后端直接返回 '时间' 字段
                        timeStr = row['时间'];
                    } else if (row['时间段']) {
                        // 兼容高级导出中已映射为中文 Key 的 '时间段'
                        timeStr = row['时间段'];
                    } else if (row.time_range && row.time_range !== 'undefined-undefined') {
                        timeStr = row.time_range;
                    }

                    // 格式化创建时间
                    let createdAtStr = row.created_at || row['创建时间'] || '';
                    if (createdAtStr) {
                        if (String(createdAtStr).includes('-') && String(createdAtStr).includes(':')) {
                            // 可能是已经格式化的，不做处理
                        } else {
                            try {
                                const d = new Date(createdAtStr);
                                if (!isNaN(d.getTime())) {
                                    createdAtStr = d.toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
                                }
                            } catch (e) { }
                        }
                    }

                    const statusVal = row.status || row['状态'];

                    return {
                        '教师名称': row.teacher_name || row.name || row['教师名称'] || '',
                        '学生名称': row.student_name || row['学生名称'] || '',
                        '类型': typeStr,
                        '日期': dateStr,
                        '星期': weekStr,
                        '时间段': timeStr,
                        '状态': statusMap[statusVal] || statusVal || '未知',
                        '创建时间': createdAtStr,
                        '排课ID': row.id || row.schedule_id || row['排课ID'] || '',
                        '教师ID': row.teacher_id || row['教师ID'] || '',
                        '学生ID': row.student_id || row['学生ID'] || '',
                        '备注': row.remark || row.notes || row['备注'] || ''
                    };
                });

                // ============ 管理员角色导出逻辑 (4个工作表深度重构) ============
                if (userType === 'admin') {
                    const studentStats = aggregateStudentStats(originalData);
                    const teacherStats = aggregateTeacherStats(originalData, studentName);
                    const calendarData = transformToCalendarData(originalData, state.startDate, state.endDate, studentId);

                    // 1. 每日排课明细 (Sheet 1)
                    // 恢复“费用”和“周汇总”列（原逻辑删除了这两列）
                    const sheet1Data = calendarData.map(row => {
                        return { ...row };
                    });

                    // 2. 工作汇总 (Sheet 2)
                    let sheet2Data = [];
                    if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) {
                        sheet2Data = teacherStats.map(stat => ({
                            '教师姓名': stat['姓名'],
                            '试教': stat['试教'],
                            '入户': stat['入户'],
                            '评审': stat['评审'],
                            '集体活动': stat['集体活动'],
                            '咨询': stat['咨询'],
                            '汇总': stat['汇总'],
                            '核对': '未核对' // 修正为可选项状态，默认未核对
                        }));
                    } else {
                        sheet2Data = studentStats.map(stat => ({
                            '学生姓名': stat['姓名'],
                            '试教': stat['试教'] || 0,
                            '入户': stat['入户'],
                            '评审': stat['评审'],
                            '集体活动': stat['集体活动'],
                            '咨询': stat['咨询'],
                            '汇总': stat['汇总'],
                            '核对': '未核对'
                        }));
                    }

                    // 3. 排课原始记录 (Sheet 3 - 21个列精准映射)
                    const sheet3Data = originalData.map(row => {
                        const dateStr = row.date || row.class_date || row['日期'] || '';
                        const d = new Date(dateStr);
                        const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
                        const weekStr = !isNaN(d.getTime()) ? weekDays[d.getDay()] : '';

                        const startTime = row.start_time || '';
                        const endTime = row.end_time || '';
                        const timeStr = (startTime && endTime) ? `${String(startTime).substring(0, 5)}-${String(endTime).substring(0, 5)}` : '';

                        const familyMap = {
                            0: '无人', 1: '妈', 2: '爸', 3: '爸妈', 4: '多人',
                            10: '学生', 11: '学生+妈', 12: '学生+爸', 13: '学生+爸妈', 14: '学生+多人'
                        };

                        const statusMap = {
                            'pending': '待确认', 'confirmed': '已确认', 'cancelled': '已取消', 'completed': '已完成'
                        };

                        // 格式化时间函数
                        const fmt = (val) => {
                            if (!val) return '';
                            const date = new Date(val);
                            return isNaN(date.getTime()) ? String(val) : date.toLocaleString('zh-CN', { hour12: false });
                        };

                        // 构建有序对象
                        return {
                            '日期': dateStr.includes('T') ? dateStr.split('T')[0] : dateStr,
                            '星期': weekStr,
                            '教师名称': row.teacher_name || '',
                            '学生名称': row.student_name || '',
                            '类型': row.type_desc || row.type_name || row['类型'] || '',
                            '时间段': timeStr,
                            '状态': statusMap[row.status] || row.status || '',
                            '上课地点': row.location || '',
                            '创建时间': fmt(row.created_at),
                            '更新时间': fmt(row.updated_at),
                            '课程状态自动更新时间': fmt(row.last_auto_update),
                            '排课 ID': row.schedule_id || row.id || '',
                            '教师 ID': row.teacher_id || '',
                            '学生 ID': row.student_id || '',
                            'admin ID': row.created_by || '',
                            '家庭参加人员': familyMap[row.family_participants] !== undefined ? familyMap[row.family_participants] : (row.family_participants || ''),
                            '教师评分': row.teacher_rating || '',
                            '教师评价内容': row.teacher_comment || '',
                            '学生评分': row.student_rating || '',
                            '学生评价内容': row.student_comment || '',
                            '备注': ''
                        };
                    });

                    // 4. 教师授课/学生上课统计 (Sheet 4 - 动态透视结构)
                    // 获取全量课程类型列表 (从 Store 获取描述)
                    let allTypeConfigs = [];
                    if (window.ScheduleTypesStore) {
                        allTypeConfigs = window.ScheduleTypesStore.getAll() || [];
                    }
                    // 按 ID 排序以保证列顺序稳定
                    allTypeConfigs.sort((a, b) => Number(a.id) - Number(b.id));

                    const typeHeaders = allTypeConfigs.map(t => t.description || t.name);
                    const typeIdToHeader = {};
                    allTypeConfigs.forEach(t => {
                        typeIdToHeader[t.id] = t.description || t.name;
                    });

                    let dateRangeStr = '';
                    if (state.startDate && state.endDate) {
                        const s = state.startDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
                        const e = state.endDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
                        dateRangeStr = `${s} 至 ${e}`;
                    }

                    const dynamicStatsMap = new Map();

                    originalData.forEach(row => {
                        const statusVal = row.status || '';
                        if (String(statusVal).toLowerCase() === '已取消' || statusVal === 'cancelled' || statusVal === '0') return;

                        const name = state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE ?
                            (row.teacher_name || '') : (row.student_name || '');
                        if (!name) return;

                        // 提取ID用于排序(教师或学生)
                        const personId = state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE ?
                            (row.teacher_id || row.id || row['教师ID'] || 999999) :
                            (row.student_id || row.id || row['学生ID'] || 999999);

                        if (!dynamicStatsMap.has(name)) {
                            dynamicStatsMap.set(name, {
                                姓名: name,
                                _id: personId,  // 添加ID字段用于排序
                                types: {},
                                total: 0
                            });
                        }
                        const entry = dynamicStatsMap.get(name);

                        // 使用关联 ID 匹配表头，如果匹配不到则使用 type_desc
                        const typeId = row.course_id || row.type_id;
                        const header = typeIdToHeader[typeId] || row.type_desc || row.type_name || '其他';

                        entry.types[header] = (entry.types[header] || 0) + 1;
                        entry.total++;
                    });

                    const statsForRemarks = (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) ? teacherStats : studentStats;

                    // 转换为数组并按ID排序
                    const sortedEntries = Array.from(dynamicStatsMap.values())
                        .sort((a, b) => Number(a._id) - Number(b._id));

                    const sheet4Data = sortedEntries.map(entry => {
                        const row = { '姓名': entry.姓名 };
                        // 2 到 n 列：显示所有课程类型名称
                        typeHeaders.forEach(header => {
                            row[header] = entry.types[header] || 0;
                        });
                        // n+1 列：汇总
                        row['汇总'] = entry.total;

                        // n+2 列：备注
                        const statMatch = statsForRemarks.find(s => (s['姓名'] || s['学生姓名']) === entry.姓名);
                        let remark = '';
                        if (statMatch) {
                            const detailStr = statMatch['汇总'] || '';
                            const targetPerson = state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE ? studentName : '全部老师';
                            const title = state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE ? '老师' : '同学';
                            remark = `${entry.姓名}${title}好！${dateRangeStr} 期间，您在[${targetPerson}]处入户等相关数据为 ：${detailStr || (entry.total + '次活动')}。请问是否正确？`;
                        }
                        row['备注'] = remark;
                        return row;
                    });

                    const sheetNames = state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE ?
                        ['每日排课明细', '教师授课汇总', '排课原始记录', '教师授课统计'] :
                        ['每日排课明细', '学生上课汇总', '排课原始记录', '学生上课统计'];

                    return {
                        [sheetNames[0]]: sheet1Data,
                        [sheetNames[1]]: sheet2Data,
                        [sheetNames[2]]: sheet3Data,
                        [sheetNames[3]]: sheet4Data
                    };
                }

                // ============ 教师/学生角色导出逻辑 (保持原有) ============
                if (state.selectedType === EXPORT_TYPES.TEACHER_SCHEDULE) {
                    const statsData = aggregateTeacherStats(originalData, studentName);
                    const calendarData = transformToCalendarData(originalData, state.startDate, state.endDate, studentId);
                    return {
                        '每日排课明细': calendarData,  // 原"日历排课表" (内容：每日聚合的排课详情)
                        '教师课时统计': statsData,     // 原"分老师明细表" (内容：教师课时统计)
                        '排课原始记录': baseData       // 原"总览表" (内容：原始的流水记录)
                    };
                }

                // 如果是学生排课记录导出
                if (state.selectedType === EXPORT_TYPES.STUDENT_SCHEDULE) {
                    // 1. 交换第一列和第二列 (学生名称 <-> 教师名称)
                    const reorderedBaseData = baseData.map(row => {
                        // 创建新对象以保证键的顺序
                        return {
                            '学生名称': row['学生名称'],
                            '教师名称': row['教师名称'],
                            ...row // 展开剩余属性，注意：后续同名属性会覆盖前面的，但这里我们主要为了调整前两个 keys 的顺序
                        };
                        // 上面的写法其实不能保证 Key 的顺序（JS对象的Key是无序的，但在大多数导出库中，可能依赖 Key 添加顺序或者 columns定义）
                        // 为了保险起见，我们重新构造对象
                        const newRow = {};
                        newRow['学生名称'] = row['学生名称'];
                        newRow['教师名称'] = row['教师名称'];
                        Object.keys(row).forEach(k => {
                            if (k !== '学生名称' && k !== '教师名称') {
                                newRow[k] = row[k];
                            }
                        });
                        return newRow;
                    });

                    // 2. 生成学生统计表
                    const statsData = aggregateStudentStats(originalData);

                    return {
                        '总览表': reorderedBaseData,
                        '分学生明细表': statsData
                    };
                }

                return baseData;
            }

            /**
             * 聚合学生统计数据 (第二张表)
             * 逻辑：
             * 1. 按学生汇总
             * 2. 入户/评审 去重逻辑：同一日期和时间(start_time)的n个老师授课/评审，当作一次。
             */
            function aggregateStudentStats(rawData) {
                const statsMap = new Map();

                rawData.forEach(row => {
                    // 排除已取消
                    const statusVal = row.status || row['状态'] || '';
                    const status = String(statusVal).toLowerCase();
                    if (status === '0' || status === 'cancelled' || status === '已取消') return;

                    const studentName = row.student_name || row['学生名称'] || '未知学生';
                    if (!statsMap.has(studentName)) {
                        statsMap.set(studentName, {
                            name: studentName,
                            // trial: 0, // Removed per request
                            consultation: 0,
                            group_activity: 0,
                            others: 0,
                            // 用于去重计数: key = date + '_' + start_time
                            visitSet: new Set(),
                            reviewSet: new Set(),

                            dates: new Set()
                        });
                    }

                    const stat = statsMap.get(studentName);

                    // 记录日期
                    let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
                    if (dateStr && dateStr.includes('T')) dateStr = dateStr.split('T')[0];
                    if (dateStr) stat.dates.add(dateStr);

                    // 时间 Key 用于去重
                    let startTime = row.start_time || '';
                    if (startTime && startTime.length > 5) startTime = startTime.substring(0, 5);
                    const timeKey = `${dateStr}_${startTime} `; // e.g. "2023-01-01_10:00"

                    // 类型判断
                    let typeKey = '';
                    const typeVal = row.course_id || row.type || row.schedule_type || row['类型'];
                    if (window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
                        const t = window.ScheduleTypesStore.getById(typeVal);
                        typeKey = t ? t.name : String(typeVal);
                    } else {
                        typeKey = String(typeVal || '');
                    }
                    typeKey = typeKey.toLowerCase();

                    // 统计逻辑
                    if (typeKey === 'visit' || typeKey === 'half_visit' || /visit/i.test(typeKey)) {
                        stat.visitSet.add(timeKey);
                    } else if (typeKey === 'review' || typeKey === 'review_record' || /review/i.test(typeKey)) {
                        // 评审 和 评审记录 都算作评审，且去重
                        stat.reviewSet.add(timeKey);
                    } else if (typeKey === 'trial' || /trial/i.test(typeKey)) {
                        stat.trial++;
                    } else if (typeKey === 'consultation' || /consultation/i.test(typeKey)) {
                        stat.consultation++;
                    } else if (typeKey === 'group_activity' || /group/i.test(typeKey)) {
                        stat.group_activity++;
                    } else {
                        stat.others++;
                    }
                });

                const result = [];
                statsMap.forEach(stat => {
                    // 计算日期范围
                    let dateRangeStr = '';
                    if (state.startDate && state.endDate) {
                        const s = state.startDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
                        const e = state.endDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
                        dateRangeStr = `${s}至${e} `;
                    } else {
                        const sortedDates = Array.from(stat.dates).sort();
                        if (sortedDates.length > 0) {
                            dateRangeStr = sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]}至${sortedDates[sortedDates.length - 1]} `;
                        }
                    }

                    // 学生汇总逻辑也应用相同的折算逻辑 (按去重后的 Set 计算)
                    // 注意：Set 中存储的是排课记录，对于学生端，去重后的 key 代表一次排课动作
                    const visitCount = stat.visitSet.size;
                    const reviewCount = stat.reviewSet.size;

                    // 备注：学生姓名，日期段，X次... (仅显示次数 > 0 的项)
                    const remarkParts = [stat.name, dateRangeStr];
                    if (visitCount > 0) remarkParts.push(`${visitCount} 次入户`);
                    if (reviewCount > 0) remarkParts.push(`${reviewCount} 次评审`);
                    if (stat.group_activity > 0) remarkParts.push(`${stat.group_activity} 次集体活动`);
                    if (stat.consultation > 0) remarkParts.push(`${stat.consultation} 次咨询`);

                    const remarks = remarkParts.join('，');

                    result.push({
                        '姓名': stat.name,
                        '试教': stat.trial || 0,
                        '入户': visitCount,
                        '评审': reviewCount,
                        '集体活动': stat.group_activity,
                        '咨询': stat.consultation,
                        '汇总': remarks, // 学生的汇总目前显示备注详情
                        '核对': '确定',
                        '备注': remarks
                    });
                });

                return result;
            }

            /**
             * 聚合老师统计数据 (第二张表)
             * @param {Array} rawData 原始数据
             * @param {string} studentName 学生名称（用于备注）
             */
            function aggregateTeacherStats(rawData, studentName = '全部学生') {
                const statsMap = new Map();

                rawData.forEach(row => {
                    // 排除已取消的记录
                    const statusVal = row.status || row['状态'] || '';
                    const status = String(statusVal).toLowerCase();
                    if (status === '0' || status === 'cancelled' || status === '已取消') {
                        return;
                    }

                    const teacherName = row.teacher_name || row.name || row['教师名称'] || '未知老师';
                    const teacherId = row.teacher_id || row.id || row['教师ID'] || 999999;  // 收集教师ID,默认值为大数字

                    if (!statsMap.has(teacherName)) {
                        statsMap.set(teacherName, {
                            name: teacherName,
                            teacher_id: teacherId,  // 添加教师ID字段
                            trial: 0,        // 试教
                            home_visit: 0,   // 入户
                            half_visit: 0,   // 半次入户
                            review: 0,       // 评审
                            review_record: 0,// 评审记录
                            consultation: 0, // 咨询/advisory
                            group_activity: 0, // 集体活动
                            others: 0,
                            dates: new Set() // 用于记录日期范围
                        });
                    }

                    const stat = statsMap.get(teacherName);

                    // 记录日期
                    let dateStr = row.date || row.arr_date || row.class_date || row['日期'] || '';
                    if (dateStr && dateStr.includes('T')) dateStr = dateStr.split('T')[0];
                    if (dateStr) stat.dates.add(dateStr);

                    // 统计类型
                    let typeKey = ''; // english key: visit, review, etc.
                    // let typeName = ''; // localized name

                    const typeVal = row.course_id || row.type || row.schedule_type || row['类型'];

                    if (window.ScheduleTypesStore && window.ScheduleTypesStore.getById) {
                        const t = window.ScheduleTypesStore.getById(typeVal);
                        typeKey = t ? t.name : String(typeVal); // name is usually the english key
                    } else {
                        // Fallback if store not loaded
                        typeKey = String(typeVal || '');
                    }

                    // 标准化处理：线上类型 → 基础类型 (review_online → review, visit_online → visit)
                    typeKey = normalizeTypeKey(typeKey);

                    // Strict matching based on schedule_types table (image provided by user)
                    if (typeKey === 'visit') stat.home_visit++;
                    else if (typeKey === 'half_visit') stat.half_visit++;
                    else if (typeKey === 'review') stat.review++;
                    else if (typeKey === 'review_record') stat.review_record++;
                    else if (typeKey === 'trial') stat.trial++;
                    else if (typeKey === 'consultation' || typeKey === 'advisory') stat.consultation++;
                    else if (typeKey === 'group_activity') stat.group_activity++;
                    else {
                        // Regex fallbacks only if strict match fails
                        if (/half_visit/i.test(typeKey)) stat.half_visit++;
                        else if (/visit/i.test(typeKey)) stat.home_visit++;
                        else if (/review_record/i.test(typeKey)) stat.review_record++;
                        else if (/review/i.test(typeKey)) stat.review++;
                        else if (/trial/i.test(typeKey)) stat.trial++;
                        else if (/consultation|advisory/i.test(typeKey)) stat.consultation++;
                        else if (/group/i.test(typeKey)) stat.group_activity++;
                        else stat.others++;
                    }
                });

                const result = [];
                // 转换 Map 为数组并可以计算衍生字段
                statsMap.forEach(stat => {
                    // 计算日期范围字符串
                    let dateRangeStr = '';
                    if (state.startDate && state.endDate) {
                        const s = state.startDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
                        const e = state.endDate.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '-');
                        dateRangeStr = `${s}至${e} `;
                    } else {
                        const sortedDates = Array.from(stat.dates).sort();
                        if (sortedDates.length > 0) {
                            dateRangeStr = sortedDates.length === 1 ? sortedDates[0] : `${sortedDates[0]}至${sortedDates[sortedDates.length - 1]} `;
                        }
                    }

                    // ============ 核心计算逻辑修正 ============
                    // 入户 = 入户 + 0.5 * 半次入户 + 0.5 * 评审记录
                    const effectiveVisits = stat.home_visit + (stat.half_visit * 0.5) + (stat.review_record * 0.5);
                    // 评审 = 评审 + 评审记录
                    const effectiveReviews = stat.review + stat.review_record;

                    let cleanDateRange = dateRangeStr.trim().replace('至', ' 至 ');

                    const details = [];
                    if (stat.trial > 0) details.push(`${stat.trial}次试教`);
                    if (effectiveVisits > 0) details.push(`${effectiveVisits}次入户`);
                    if (effectiveReviews > 0) details.push(`${effectiveReviews}次评审`);
                    if (stat.group_activity > 0) details.push(`${stat.group_activity}次集体活动`);
                    if (stat.consultation > 0) details.push(`${stat.consultation}次咨询`);

                    const detailsStr = details.length > 0 ? details.join('、') : '无';
                    const remarks = `${stat.name}老师好！${cleanDateRange} 期间，在[${studentName}]处入户相关数据为 ：${detailsStr}。请问是否正确？`;

                    result.push({
                        '姓名': stat.name,
                        '_teacher_id': stat.teacher_id,  // 内部字段用于排序
                        '试教': stat.trial,
                        '入户': effectiveVisits,
                        '评审': effectiveReviews,
                        '集体活动': stat.group_activity,
                        '咨询': stat.consultation,
                        '汇总': detailsStr,
                        '核对': '确定', // 默认为确定，管理员可手动微调
                        '备注': remarks
                    });
                });

                // 按教师ID从小到大排序
                result.sort((a, b) => Number(a._teacher_id) - Number(b._teacher_id));

                return result;
            }

            // 计算记录数用于显示
            const recordCount = rawData.length || 0;

            updateProgress(100, `导出完成！共 ${recordCount} 条记录`);

            // 重置导出状态（放在前面确保后续点击能正常触发）
            state.isExporting = false;

            // 优化关闭逻辑：缩短延迟，提升流畅度
            setTimeout(() => {
                showToast(`导出成功，共 ${recordCount} 条记录`, 'success');
                // 下载完成后尽快关闭
                setTimeout(() => {
                    close();
                }, 400);
            }, 300);
        } catch (error) {
            console.error('导出失败:', error);
            updateProgress(0, '导出失败');

            // 显示错误提示并提供重试按钮
            const progressMsg = document.getElementById('exportProgressMsg');
            if (progressMsg) {
                progressMsg.innerHTML = `
        < span style = "color: #ef4444;" > 导出失败: ${error.message || '未知错误'}</span >
            <button onclick="window.ExportDialog.retryExport()" style="
                        margin-left: 12px;
                        padding: 4px 12px;
                        background: #0ea5e9;
                        color: white;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                    ">重试</button>
    `;
            }
            showToast(`导出失败: ${error.message} `, 'error');
            state.isExporting = false;

            // 恢复按钮状态
            const exportBtn = document.getElementById('exportDialogNextBtn');
            if (exportBtn) {
                exportBtn.disabled = false;
                exportBtn.innerHTML = '导出 Excel';
            }
        }
    }


    /**
     * 重试导出
     */
    function retryExport() {
        state.isExporting = false;
        performExport();
    }

    /**
     * 更新导出进度
     */
    function updateProgress(percent, message) {
        const fill = document.getElementById('exportProgressFill');
        const percentSpan = document.getElementById('exportProgressPercent');
        const msgSpan = document.getElementById('exportProgressMsg');

        if (fill) fill.style.width = percent + '%';
        if (percentSpan) percentSpan.textContent = percent + '%';
        if (msgSpan) msgSpan.textContent = message;
    }

    /**
     * 生成 Excel 文件
     * @param {Object|Array} exportData - 导出数据 (支持 { sheetName: [], ... } 多 Sheet 结构)
     * @param {string} filename - 文件名 (可选)
     */
    async function generateExcelFile_Legacy(exportData, filename) {
        // 确保 XLSX 库已加载
        if (typeof XLSX === 'undefined') {
            await loadXLSXLibrary();
        }

        const wb = XLSX.utils.book_new();

        // 统一处理成 { SheetName: DataArray } 格式
        let sheets = {};
        if (Array.isArray(exportData)) {
            sheets['数据'] = exportData;
        } else if (exportData && typeof exportData === 'object' && !exportData.data) {
            // 认为是多 Sheet 结构
            sheets = exportData;
        } else {
            // 兼容旧结构
            let data = (exportData && exportData.data) ? exportData.data : [];
            sheets['数据'] = Array.isArray(data) ? data : [];
        }

        // Helper: Check if string is purely English/Numbers/Punctuation
        const isEnglishOrNum = (str) => /^[\x00-\x7F]*$/.test(String(str));

        let hasData = false;
        Object.keys(sheets).forEach((sheetName, sheetIndex) => {
            const data = sheets[sheetName];
            if (Array.isArray(data) && data.length > 0) {
                const ws = XLSX.utils.json_to_sheet(data);

                // --- 1. 计算列宽 ---
                const colWidths = [];
                const headers = Object.keys(data[0]);

                // 预设宽度
                const minWidths = {
                    '时间段': 15,
                    '备注': 30,
                    '创建时间': 20,
                    '日期': 12,
                    '类型': 15
                };

                headers.forEach((key, i) => {
                    let maxLength = minWidths[key] || 10;
                    // 遍历样本数据
                    const sampleSize = Math.min(data.length, 50);
                    for (let r = 0; r < sampleSize; r++) {
                        const val = data[r][key];
                        if (val) {
                            const strVal = String(val);
                            // 中文算2，英文算1
                            let len = 0;
                            for (let k = 0; k < strVal.length; k++) {
                                len += (strVal.charCodeAt(k) > 255 ? 2 : 1);
                            }
                            if (len > maxLength) maxLength = len;
                        }
                    }
                    colWidths[i] = { wch: Math.min(maxLength + 2, 60) };
                });
                ws['!cols'] = colWidths;

                // --- 2. 冻结首行 ---
                ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };

                // --- 3. 应用样式 ---
                const range = XLSX.utils.decode_range(ws['!ref']);

                for (let R = range.s.r; R <= range.e.r; ++R) {
                    // 检查由 "星期" 列决定的行样式 (仅限第一个 Sheet)
                    let isSundayRow = false;
                    if (sheetIndex === 0) {
                        for (let C = range.s.c; C <= range.e.c; ++C) {
                            const cellRef = XLSX.utils.encode_cell({ c: C, r: R });
                            const cell = ws[cellRef];
                            if (cell && cell.v === '周日') {
                                isSundayRow = true;
                                break;
                            }
                        }
                    }

                    for (let C = range.s.c; C <= range.e.c; ++C) {
                        const cellAddress = XLSX.utils.encode_cell({ c: C, r: R });
                        if (!ws[cellAddress]) continue;

                        const cell = ws[cellAddress];
                        const value = cell.v || '';
                        const strValue = String(value);

                        // --- 基础样式 ---
                        cell.s = {
                            font: {
                                name: '宋体',
                                sz: 11
                            },
                            alignment: {
                                vertical: 'center',
                                wrapText: true,
                                horizontal: 'center' // 默认居中
                            },
                            border: {
                                top: { style: 'thin' },
                                bottom: { style: 'thin' },
                                left: { style: 'thin' },
                                right: { style: 'thin' }
                            }
                        };

                        // 字体：英文/数字用 Times New Roman
                        if (isEnglishOrNum(value)) {
                            cell.s.font.name = 'Times New Roman';
                        }

                        if (R === 0) {
                            // --- 标题行 ---
                            cell.s.font.sz = 12; // 标题大一些
                            cell.s.font.bold = true;
                            cell.s.font.name = '宋体'; // 标题强制宋体
                            // cell.s.fill = { fgColor: { rgb: "E0E0E0" } }; // 可选灰色背景
                        } else {
                            // --- 正文行 ---

                            // 1. 水平对齐：超过10个汉字(或长度>20字符?) 靠左
                            // 用户要求："文本超过10个汉字的靠左显示" -> 长度判断
                            // 简单按字符长度 > 10
                            if (strValue.length > 10) {
                                cell.s.alignment.horizontal = 'left';
                            }

                            // 2. 特殊条件 (仅 Sheet 1)
                            if (sheetIndex === 0) {
                                // 列头检查
                                const headerRef = XLSX.utils.encode_cell({ c: C, r: 0 });
                                const headerCell = ws[headerRef];
                                const headerVal = headerCell ? String(headerCell.v) : '';

                                // a. 日期列 -> 绿色填充
                                if (headerVal.includes('日期')) {
                                    cell.s.fill = { fgColor: { rgb: "90EE90" } }; // LightGreen
                                }
                                // b. 周日行 -> 蓝色填充 (排除日期列，避免冲突? 或覆盖? 
                                // 用户："周日所在行使用蓝色填充，日期列使用绿色填充"
                                // 逻辑：如果也是日期列，上面已设绿。如果是其他列且是周日行，设蓝。)
                                else if (isSundayRow) {
                                    cell.s.fill = { fgColor: { rgb: "ADD8E6" } }; // LightBlue
                                }

                                // c. 评审/咨询类 -> 红色文字 ("类型"列)
                                if (headerVal.includes('类型')) {
                                    if (strValue.includes('评审') || strValue.includes('咨询')) {
                                        cell.s.font.color = { rgb: "FF0000" };
                                    }
                                }
                            }
                        }
                    }
                }

                XLSX.utils.book_append_sheet(wb, ws, sheetName);
                hasData = true;
            }
        });

        if (!hasData) {
            throw new Error('没有可导出的数据');
        }

        const finalFilename = filename || `export_${Date.now()}.xlsx`;
        XLSX.writeFile(wb, finalFilename);
    }

    /**
     * 生成 CSV 文件
     * @param {Object|Array|string} exportData - 导出数据
     * @param {string} filename - 文件名 (可选)
     */
    function generateCsvFile(exportData, filename) {
        // 处理导出数据：可能是字符串或包含 data 字段的响应对象，或者是直接的数组
        let csvContent = null;

        if (Array.isArray(exportData)) {
            // 如果直接是数组 (Transformed data)
            const data = exportData;
            if (data.length === 0) {
                throw new Error('没有可导出的数据');
            }
            const headers = Object.keys(data[0]);
            const rows = data.map(row =>
                headers.map(header => {
                    const value = row[header];
                    if (value === null || value === undefined) return '""';
                    return `"${String(value).replace(/"/g, '""')}"`;
                }).join(',')
            );
            csvContent = [
                headers.map(h => `"${h}"`).join(','),
                ...rows
            ].join('\n');
        } else if (typeof exportData === 'string') {
            // 如果已经是 CSV 字符串
            csvContent = exportData;
        } else if (exportData && typeof exportData === 'object') {
            // 如果是响应对象，尝试获取 data 字段
            if (typeof exportData.data === 'string') {
                csvContent = exportData.data;
            } else if (Array.isArray(exportData.data)) {
                // 如果 data 是数组，转换为 CSV
                const data = exportData.data;
                if (data.length === 0) {
                    throw new Error('没有可导出的数据');
                }
                const headers = Object.keys(data[0]);
                const rows = data.map(row =>
                    headers.map(header => {
                        const value = row[header];
                        if (value === null || value === undefined) return '""';
                        return `"${String(value).replace(/"/g, '""')}"`;
                    }).join(',')
                );
                csvContent = [
                    headers.map(h => `"${h}"`).join(','),
                    ...rows
                ].join('\n');
            }
        }

        if (!csvContent) {
            console.error('导出数据格式不正确:', exportData);
            throw new Error('导出数据格式不正确');
        }

        const blob = new Blob(['\ufeff' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        // 使用传入的文件名或默认文件名
        link.download = filename || `export_${Date.now()}.csv`;
        link.click();
    }

    /**
     * 加载 XLSX 库
     */
    /**
     * 生成 Excel 文件 (新版 - 支持样式)
     */
    async function generateExcelFile(exportData, filename) {
        // 确保 XLSX 库已加载
        if (typeof XLSX === 'undefined') {
            await loadXLSXLibrary();
        }

        const wb = XLSX.utils.book_new();

        // 统一处理成 { SheetName: DataArray } 格式
        let sheets = {};
        if (Array.isArray(exportData)) {
            sheets['数据'] = exportData;
        } else if (exportData && typeof exportData === 'object' && !exportData.data) {
            sheets = exportData;
        } else {
            let data = (exportData && exportData.data) ? exportData.data : [];
            sheets['数据'] = Array.isArray(data) ? data : [];
        }

        let hasData = false;
        Object.keys(sheets).forEach((sheetName, sheetIndex) => {
            const rawDataList = sheets[sheetName];
            if (Array.isArray(rawDataList) && rawDataList.length > 0) {
                // Remove internal flags before converting to sheet
                const cleanData = rawDataList.map(row => {
                    const newRow = { ...row };
                    delete newRow._isRedRow;
                    delete newRow._sTime;
                    delete newRow._parsedDate;
                    delete newRow._parsedTimeRange;
                    delete newRow._typeName;
                    delete newRow._groupType;
                    delete newRow._isSunday;
                    delete newRow._weekNumber;
                    return newRow;
                });

                const ws = XLSX.utils.json_to_sheet(cleanData);

                // --- 1. 计算列宽 ---
                const colWidths = [];
                const headers = Object.keys(cleanData[0]);

                // 预设宽度
                const minWidths = {
                    '时间段': 15,
                    '备注': 30,
                    '创建时间': 20,
                    '日期': 12,
                    '类型': 15
                };

                headers.forEach((key, i) => {
                    let maxLength = minWidths[key] || 10;
                    const sampleSize = Math.min(cleanData.length, 50);
                    for (let r = 0; r < sampleSize; r++) {
                        const val = cleanData[r][key];
                        if (val) {
                            const strVal = String(val);
                            let len = 0;
                            for (let k = 0; k < strVal.length; k++) {
                                len += (strVal.charCodeAt(k) > 255 ? 2 : 1);
                            }
                            if (len > maxLength) maxLength = len;
                        }
                    }
                    colWidths[i] = { wch: Math.min(maxLength + 2, 60) };
                });
                ws['!cols'] = colWidths;

                // --- 2. 冻结首行 ---
                ws['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };

                // --- 3. 合并单元格 (Merge Logic for Sheet 0) ---
                if (sheetIndex === 0) {
                    if (!ws['!merges']) ws['!merges'] = [];
                    // We need to find consecutive rows with same Date/Week
                    // rawDataList matches cleanData index 1:1

                    let dateStartRow = 1; // 0 is header, data starts at 1
                    let weekStartRow = 1;

                    // Column Indices for Date and Week
                    const dateColIdx = headers.indexOf('日期');
                    const weekColIdx = headers.indexOf('星期');

                    if (dateColIdx !== -1 && weekColIdx !== -1) {
                        for (let i = 1; i < rawDataList.length; i++) {
                            const prev = rawDataList[i - 1];
                            const curr = rawDataList[i];
                            const currentRowIdx = i + 1; // logical row index in Excel (0-based)

                            // Check Date Change
                            if (curr['日期'] !== prev['日期']) {
                                // Merge previous block if > 1 row
                                if ((i) - dateStartRow > 0) {
                                    ws['!merges'].push({ s: { r: dateStartRow, c: dateColIdx }, e: { r: i, c: dateColIdx } });
                                    ws['!merges'].push({ s: { r: dateStartRow, c: weekColIdx }, e: { r: i, c: weekColIdx } });
                                }
                                dateStartRow = currentRowIdx;
                            }
                        }
                        // Merge last block
                        if (rawDataList.length - dateStartRow > 0) {
                            ws['!merges'].push({ s: { r: dateStartRow, c: dateColIdx }, e: { r: rawDataList.length, c: dateColIdx } });
                            ws['!merges'].push({ s: { r: dateStartRow, c: weekColIdx }, e: { r: rawDataList.length, c: weekColIdx } });
                        }
                    }

                    // --- 费用列合并（与日期列相同逻辑）---
                    const feeColIdx = headers.indexOf('费用');
                    if (feeColIdx !== -1) {
                        let feeStartRow = 1;
                        for (let i = 1; i < rawDataList.length; i++) {
                            const prev = rawDataList[i - 1];
                            const curr = rawDataList[i];
                            const currentRowIdx = i + 1;
                            if (curr['日期'] !== prev['日期']) {
                                if ((i) - feeStartRow > 0) {
                                    ws['!merges'].push({ s: { r: feeStartRow, c: feeColIdx }, e: { r: i, c: feeColIdx } });
                                }
                                feeStartRow = currentRowIdx;
                            }
                        }
                        // 合并最后一块
                        if (rawDataList.length - feeStartRow > 0) {
                            ws['!merges'].push({ s: { r: feeStartRow, c: feeColIdx }, e: { r: rawDataList.length, c: feeColIdx } });
                        }
                    }

                    // --- 周汇总列合并（按周合并）---
                    const weekSummaryColIdx = headers.indexOf('周汇总');
                    if (weekSummaryColIdx !== -1) {
                        let weekSummaryStartRow = 1;
                        for (let i = 1; i < rawDataList.length; i++) {
                            const prev = rawDataList[i - 1];
                            const curr = rawDataList[i];
                            const currentRowIdx = i + 1;
                            // 当周次变化时进行合并
                            if (curr._weekNumber !== prev._weekNumber) {
                                if ((i) - weekSummaryStartRow > 0) {
                                    ws['!merges'].push({ s: { r: weekSummaryStartRow, c: weekSummaryColIdx }, e: { r: i, c: weekSummaryColIdx } });
                                }
                                weekSummaryStartRow = currentRowIdx;
                            }
                        }
                        // 合并最后一块
                        if (rawDataList.length - weekSummaryStartRow > 0) {
                            ws['!merges'].push({ s: { r: weekSummaryStartRow, c: weekSummaryColIdx }, e: { r: rawDataList.length, c: weekSummaryColIdx } });
                        }
                    }
                }

                // --- 4. 应用样式 ---
                const range = XLSX.utils.decode_range(ws['!ref']);
                // Helper: Check if string is English/Num
                const isEnglishOrNum = (str) => /^[\x00-\x7F]*$/.test(String(str));

                for (let R = range.s.r; R <= range.e.r; ++R) {
                    // Check flags from raw data (R-1 because R=0 is header)
                    const dataRow = (R > 0) ? rawDataList[R - 1] : null;
                    const isRedRow = dataRow ? dataRow._isRedRow : false;
                    const isSunday = dataRow ? (dataRow['星期'] === '周日') : false;

                    for (let C = range.s.c; C <= range.e.c; ++C) {
                        const cellAddress = XLSX.utils.encode_cell({ c: C, r: R });
                        // Ensure cell exists even if empty (essential for merged cells styling)
                        if (!ws[cellAddress]) {
                            // Only recreate if it's within data range (might be needed for borders on merged cells)
                            // For simple usage, we only style existing cells usually, 
                            // but merged cells usually only keep top-left content. Use top-left for style?
                            // XLSX-style library handles border on merged cells often by applying to top-left.
                            continue;
                        }

                        const cell = ws[cellAddress];
                        const value = cell.v || '';
                        const strValue = String(value);

                        // Base Style
                        cell.s = {
                            font: { name: '宋体', sz: 11 },
                            alignment: { vertical: 'center', wrapText: true, horizontal: 'center' },
                            border: {
                                top: { style: 'thin', color: { rgb: "D4D4D4" } },
                                bottom: { style: 'thin', color: { rgb: "D4D4D4" } },
                                left: { style: 'thin', color: { rgb: "D4D4D4" } },
                                right: { style: 'thin', color: { rgb: "D4D4D4" } }
                            }
                        };

                        if (isEnglishOrNum(value)) {
                            cell.s.font.name = 'Times New Roman';
                        }

                        if (R === 0) {
                            // Header Style
                            cell.s.font.sz = 12;
                            cell.s.font.bold = true;
                            cell.s.font.name = '宋体';
                            cell.s.fill = { fgColor: { rgb: "F2F2F2" } };
                        } else {
                            // Content

                            // Horizontal Align
                            // Sheet 3 (Index 2) always center, others left-align long text
                            if (sheetIndex !== 2 && strValue.length > 10) {
                                cell.s.alignment.horizontal = 'left';
                            }

                            // 2. 通用条件样式 (所有 Sheet)
                            const headerRef = XLSX.utils.encode_cell({ c: C, r: 0 });
                            const headerCell = ws[headerRef];
                            const headerVal = headerCell ? String(headerCell.v) : '';

                            // a. 日期列 -> 浅绿色
                            if (headerVal.includes('日期')) {
                                cell.s.fill = { fgColor: { rgb: "E2EFDA" } };
                            }

                            // b. 周日行 -> 浅蓝色
                            if (isSunday) {
                                cell.s.fill = { fgColor: { rgb: "DDEBF7" } };
                            }

                            // c. 评审/咨询/试教类 -> 红色文字 (但管理员导出的汇总与统计表除外)
                            const isCoreField = headerVal.includes('计划') || headerVal.includes('实际') || headerVal.includes('类型');
                            const isStatField = headerVal === '评审' || headerVal === '咨询' || headerVal === '试教';

                            if (isCoreField || isStatField) {
                                const isExcludedSheet = (sheetIndex === 1 || sheetIndex === 2 || sheetIndex === 3) && userType === 'admin';
                                const shouldBeRed = (isRedRow || (isStatField && Number(value) > 0)) && !isExcludedSheet;

                                if (shouldBeRed) {
                                    cell.s.font.color = { rgb: "FF0000" };
                                } else {
                                    cell.s.font.color = { rgb: "000000" };
                                }
                            }

                            // d. 费用/汇总列特殊对齐
                            if (headerVal === '费用' || headerVal === '周汇总' || headerVal === '汇总') {
                                cell.s.alignment = { horizontal: 'right', vertical: 'bottom', wrapText: true };
                            }
                        }
                    }
                }

                XLSX.utils.book_append_sheet(wb, ws, sheetName);
                hasData = true;
            }
        });

        if (!hasData) throw new Error('没有可导出的数据');
        const finalFilename = filename || `export_${Date.now()}.xlsx`;
        XLSX.writeFile(wb, finalFilename);
    }

    async function loadXLSXLibrary() {
        return new Promise((resolve, reject) => {
            if (typeof XLSX !== 'undefined') {
                resolve();
                return;
            }

            const script = document.createElement('script');
            // 使用支持样式的 xlsx-js-style 库 (bundle version contains everything)
            script.src = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.min.js';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
    }

    /**
     * 显示提示信息（需要 admin.js 中的 showToast 函数）
     */
    function showToast(message, type = 'info') {
        if (window.showToast) {
            window.showToast(message, type);
        } else {
            alert(message);
        }
    }

    /**
     * 重置状态
     */
    /**
     * 重置状态
     * @param {Object} options - 初始化选项 { startDate, endDate }
     */
    function resetState(options = {}) {
        state.selectedType = null;
        state.selectedFormat = EXPORT_FORMATS.EXCEL;
        state.isExporting = false;
        state.studentsLoaded = false;
        state.teachersLoaded = false;

        // 使用传入的日期或默认为空
        state.startDate = options.startDate || null;
        state.endDate = options.endDate || null;

        // 如果 DOM 已存在，立即更新日期输入框
        const startInput = document.getElementById('exportStartDate');
        const endInput = document.getElementById('exportEndDate');
        if (startInput) startInput.value = state.startDate || '';
        if (endInput) endInput.value = state.endDate || '';

        // 重置进度和 Loading 状态
        const progressFill = document.getElementById('exportProgressFill');
        if (progressFill) progressFill.style.width = '0%';

        const progressMsg = document.getElementById('exportProgressMsg');
        if (progressMsg) {
            progressMsg.textContent = '准备就绪';
            progressMsg.style.color = '#64748b';
            // remove any error html
            progressMsg.innerHTML = '准备就绪';
        }

        const overlay = document.getElementById('exportLoadingOverlay');
        if (overlay) overlay.style.display = 'none';

        // 自动选择默认类型（优先选择"老师授课记录"，否则选第一个）
        setTimeout(() => {
            // EXPORT_TYPES.TEACHER_SCHEDULE value is 'teacher_schedule'
            const defaultType = 'teacher_schedule';
            let targetItem = document.querySelector(`.export-type-item[data-type="${defaultType}"]`);

            if (!targetItem) {
                targetItem = document.querySelector('.export-type-item');
            }

            if (targetItem) {
                targetItem.click();
            }
        }, 0);
    }

    /**
     * 显示对话框
     * @param {Object} options - 配置项 { startDate, endDate }
     */
    function show(options) {
        init();
        // 确保 DOM 初始化后再重置状态，并传入选项
        resetState(options);
        if (dialogElement) dialogElement.style.display = 'flex';
        if (modalOverlay) modalOverlay.style.display = 'flex';
        document.body.style.overflow = 'hidden';
        state.isOpen = true;
    }

    /**
     * 初始化对话框 HTML 结构 - Split View Layout
     */
    function createDialogHTML() {
        // 根据角色过滤导出类型
        const currentUser = window.currentUser || {};
        const userType = currentUser.userType || 'admin';

        let filteredTypes = Object.entries(EXPORT_TYPE_CONFIG);
        if (userType === 'teacher') {
            filteredTypes = filteredTypes.filter(([id]) => id === EXPORT_TYPES.TEACHER_SCHEDULE);
        } else if (userType === 'student') {
            filteredTypes = filteredTypes.filter(([id]) => id === EXPORT_TYPES.STUDENT_SCHEDULE);
        }

        const html = `
            <div id="exportDialogOverlay" class="export-dialog-overlay" style="display: none;">
                <div id="exportDialog" class="export-dialog-container">
                    
                    <!-- 侧边栏：类型选择 -->
                    <div class="export-sidebar">
                        <div class="export-sidebar-header">
                            <h3>导出类型</h3>
                        </div>
                        <div class="export-type-list">
                            ${filteredTypes.map(([typeId, config]) => `
                                <div class="export-type-item" data-type="${typeId}">
                                    <span class="material-icons-round export-type-icon">${config.icon}</span>
                                    <div class="export-type-text">
                                        <span class="export-type-label">${config.label}</span>
                                    </div>
                                    <span class="material-icons-round check-icon">check</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>

                    <!-- 主内容区：配置与操作 -->
                    <div class="export-main">
                        <div class="export-header">
                            <div class="export-title-group">
                                <h2 id="exportMainTitle">请选择导出类型</h2>
                                <p id="exportMainDesc">选择左侧类型以配置导出选项</p>
                            </div>
                            <button class="export-dialog-close" aria-label="关闭">
                                <span class="material-icons-round">close</span>
                            </button>
                        </div>

                        <div class="export-body">
                            <!-- 配置表单容器 -->
                            <div id="exportConfigContainer" class="export-config-container" style="display:none;">
                                
                                <!-- 日期范围 -->
                                <div class="config-section" id="dateRangeSection">
                                    <label class="section-label">时间范围</label>
                                    <div class="date-input-group">
                                        <div class="input-wrapper">
                                            <label>开始日期</label>
                                            <input type="date" id="exportStartDate">
                                        </div>
                                        <div class="input-wrapper">
                                            <label>结束日期</label>
                                            <input type="date" id="exportEndDate">
                                        </div>
                                    </div>
                                    
                                    <!-- 快速选择胶囊按钮 -->
                                    <div class="quick-select-group">
                                        <button type="button" class="export-preset-btn" data-preset="week">本周</button>
                                        <button type="button" class="export-preset-btn" data-preset="month">本月</button>
                                        <button type="button" class="export-preset-btn" data-preset="quarter">本季度</button>
                                        <button type="button" class="export-preset-btn" data-preset="last-week">上周</button>
                                        <button type="button" class="export-preset-btn active" data-preset="last-month">上月</button>
                                        <button type="button" class="export-preset-btn" data-preset="last-quarter">上季度</button>
                                    </div>
                                    <div class="validation-msg" id="exportDateValidationMsg" style="display:none"></div>
                                </div>

                                <!-- 学生/教师筛选 (并列布局) -->
                                <div class="config-section filter-row" id="exportFilterSection" style="display: none;">
                                    <label class="section-label">筛选条件</label>
                                    <div class="filter-select-group" style="display: flex; gap: 16px;">
                                        <!-- 学生筛选 -->
                                        <div class="filter-item" id="exportStudentFilter" style="flex: 1; display: none;">
                                            <label class="filter-label" style="font-size: 13px; color: #64748b; margin-bottom: 6px; display: block;">筛选学生</label>
                                            <select id="exportStudentSelect" class="student-select" style="width: 100%;">
                                                <option value="">全部学生</option>
                                                <option value="loading" disabled>加载中...</option>
                                            </select>
                                        </div>
                                        <!-- 教师筛选 -->
                                        <div class="filter-item" id="exportTeacherFilter" style="flex: 1; display: none;">
                                            <label class="filter-label" style="font-size: 13px; color: #64748b; margin-bottom: 6px; display: block;">筛选教师</label>
                                            <select id="exportTeacherSelect" class="teacher-select" style="width: 100%;">
                                                <option value="">全部教师</option>
                                                <option value="loading" disabled>加载中...</option>
                                            </select>
                                        </div>
                                    </div>
                                    <p class="section-hint">选择特定人员以导出相关记录</p>
                                </div>

                            </div>
                            
                            <!-- 导出进度遮罩 (覆盖在主内容区) -->
                            <div id="exportLoadingOverlay" class="export-loading-overlay" style="display: none;">
                                <div class="loading-content">
                                    <div class="spinner-box">
                                        <div class="export-spinner"></div>
                                    </div>
                                    <h3>正在导出...</h3>
                                    <p id="exportProgressMsg">准备数据中</p>
                                    <div class="progress-bar-bg">
                                        <div id="exportProgressFill" class="progress-bar-fill" style="width: 0%"></div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- 底部操作栏 -->
                        <div class="export-footer">
                            <button id="exportDialogCancelBtn" class="btn-cancel">取消</button>

                            <button id="exportBtn" class="btn-export" disabled>
                                <span class="material-icons-round">download</span>
                                导出 Excel
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        return html;
    }

    /**
     * 初始化对话框样式 - Split View Clean UI
     */
    function injectStyles() {
        const existingStyle = document.getElementById('exportDialogStyles');
        if (existingStyle) existingStyle.remove();

        const style = document.createElement('style');
        style.id = 'exportDialogStyles';
        style.textContent = `
            /* ========== 布局容器 ========== */
            .export-dialog-overlay {
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(15, 23, 42, 0.5);
                backdrop-filter: blur(4px);
                z-index: 9999;
                display: flex; align-items: center; justify-content: center;
                animation: fadeIn 0.2s ease;
            }

            .export-dialog-container {
                background: #fff;
                width: 800px;
                height: 520px;
                border-radius: 16px;
                box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
                display: flex;
                overflow: hidden;
                animation: scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                font-family: 'Inter', system-ui, sans-serif;
            }

            /* ========== 左侧侧边栏 ========== */
            .export-sidebar {
                width: 260px;
                background: #f8fafc;
                border-right: 1px solid #e2e8f0;
                display: flex;
                flex-direction: column;
                padding: 24px 16px;
                flex-shrink: 0;
            }

            .export-sidebar-header h3 {
                margin: 0 0 16px 8px;
                font-size: 12px;
                font-weight: 700;
                text-transform: uppercase;
                color: #94a3b8;
                letter-spacing: 0.05em;
            }

            .export-type-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }

            .export-type-item {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 16px;
                border-radius: 8px;
                cursor: pointer;
                transition: all 0.2s ease;
                color: #475569;
                border: 1px solid transparent;
            }

            .export-type-item:hover {
                background: #fff;
                color: #1e293b;
                box-shadow: 0 1px 3px rgba(0,0,0,0.05);
            }

            .export-type-item.active {
                background: #fff;
                color: #2563eb;
                box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 4px 6px -1px rgba(0,0,0,0.02);
                border-color: #e2e8f0;
            }

            .export-type-item .export-type-icon { font-size: 20px; }
            .export-type-item .check-icon { 
                font-size: 16px; 
                margin-left: auto; 
                opacity: 0; 
                transform: scale(0.5);
                transition: all 0.2s;
            }
            .export-type-item.active .check-icon { opacity: 1; transform: scale(1); }
            
            .export-type-label { font-size: 14px; font-weight: 500; }

            /* ========== 右侧主内容区 ========== */
            .export-main {
                flex: 1;
                display: flex;
                flex-direction: column;
                background: #fff;
                position: relative;
            }

            .export-header {
                padding: 24px 32px;
                border-bottom: 1px solid #f1f5f9;
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
            }

            .export-title-group h2 {
                margin: 0 0 4px 0;
                font-size: 18px;
                font-weight: 600;
                color: #0f172a;
            }

            .export-title-group p {
                margin: 0;
                font-size: 13px;
                color: #64748b;
            }

            .export-dialog-close {
                background: transparent; border: none; cursor: pointer;
                color: #94a3b8; padding: 4px; border-radius: 6px;
                transition: all 0.2s;
            }
            .export-dialog-close:hover { background: #f1f5f9; color: #475569; }

            .export-body {
                flex: 1;
                padding: 32px;
                overflow-y: auto;
                position: relative;
            }

            /* ========== 配置表单 ========== */
            .config-section { margin-bottom: 24px; }
            
            .section-label {
                display: block;
                font-size: 14px;
                font-weight: 600;
                color: #334155;
                margin-bottom: 12px;
            }

            .date-input-group {
                display: flex;
                gap: 16px;
                margin-bottom: 16px;
            }

            .input-wrapper { flex: 1; }
            .input-wrapper label {
                display: block;
                font-size: 12px;
                color: #64748b;
                margin-bottom: 6px;
            }

            .input-wrapper input, .student-select {
                width: 100%;
                padding: 10px 12px;
                font-size: 14px;
                border: 1px solid #cbd5e1;
                border-radius: 8px;
                color: #1e293b;
                background: #f8fafc;
                transition: all 0.2s;
                box-sizing: border-box;
            }

            .input-wrapper input:focus, .student-select:focus {
                background: #fff;
                border-color: #3b82f6;
                outline: none;
                box-shadow: 0 0 0 3px #dbeafe;
            }

            /* 快速选择 */
            .quick-select-group {
                display: flex;
                gap: 8px;
            }

            .export-preset-btn {
                padding: 6px 14px;
                font-size: 13px;
                border: 1px solid #e2e8f0;
                background: #fff;
                color: #475569;
                border-radius: 20px;
                cursor: pointer;
                transition: all 0.2s;
            }

            .export-preset-btn:hover { border-color: #cbd5e1; color: #1e293b; }
            .export-preset-btn.active {
                background: #eff6ff;
                border-color: #3b82f6;
                color: #2563eb;
                font-weight: 500;
            }

            .section-hint {
                font-size: 12px;
                color: #94a3b8;
                margin: 8px 0 0 0;
            }

            /* ========== 底部操作栏 ========== */
            .export-footer {
                padding: 20px 32px;
                border-top: 1px solid #f1f5f9;
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                background: #fff;
            }

            .btn-cancel {
                padding: 10px 20px;
                border: 1px solid #e2e8f0;
                background: #fff;
                color: #64748b;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                transition: all 0.2s;
            }
            .btn-cancel:hover { background: #f8fafc; color: #334155; border-color: #cbd5e1; }



            .btn-export {
                padding: 10px 24px;
                background: #2563eb;
                color: white;
                border: none;
                border-radius: 8px;
                font-size: 14px;
                font-weight: 500;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 8px;
                transition: all 0.2s;
                box-shadow: 0 4px 6px -1px rgba(37, 99, 235, 0.3);
            }
            .btn-export:hover:not(:disabled) {
                background: #1d4ed8;
                transform: translateY(-1px);
                box-shadow: 0 6px 8px -1px rgba(37, 99, 235, 0.4);
            }
            .btn-export:disabled {
                background: #94a3b8;
                cursor: not-allowed;
                box-shadow: none;
                transform: none;
            }

            /* ========== Loading Overlay ========== */
            .export-loading-overlay {
                position: absolute;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(255,255,255,0.9);
                backdrop-filter: blur(2px);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 50;
                border-radius: 0 0 16px 0; /* Corner match */
            }

            .loading-content { text-align: center; }
            .spinner-box { margin-bottom: 20px; }
            
            .export-spinner {
                width: 40px; height: 40px;
                border: 3px solid #e2e8f0;
                border-top-color: #3b82f6;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin: 0 auto;
            }

            .loading-content h3 {
                margin: 0 0 8px 0;
                color: #1e293b;
                font-size: 16px;
            }
            
            .loading-content p {
                margin: 0 0 16px 0;
                color: #64748b;
                font-size: 13px;
            }

            .progress-bar-bg {
                width: 240px;
                height: 6px;
                background: #f1f5f9;
                border-radius: 3px;
                overflow: hidden;
                margin: 0 auto;
            }

            .progress-bar-fill {
                height: 100%;
                background: #3b82f6;
                border-radius: 3px;
                transition: width 0.3s ease;
            }

            @keyframes spin { to { transform: rotate(360deg); } }
            @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
            @keyframes scaleIn { from { opacity: 0; transform: scale(0.95); } to { opacity: 1; transform: scale(1); } }
        `;
        document.head.appendChild(style);
    }

    /**
     * 公共 API
     */
    return {
        open: show,
        close,
        init,
        retryExport,
        isOpen: () => state.isOpen,
        // 公开 applyPreset，供页面其它脚本调用以同步预设
        applyPreset: (preset) => {
            // ensure dialog created
            try { init(); } catch (_) { }
        }
    };

})(); // End IIFE

