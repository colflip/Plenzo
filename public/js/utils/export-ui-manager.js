/**
 * 前端数据导出工具模块
 * 处理Excel文件生成、下载、进度反馈等功能
 */

window.ExportUIManager = (function() {
    // 导出状态管理
    const state = {
        isExporting: false,
        currentProgress: 0,
        currentDataType: null
    };

    /**
     * 获取导出按钮
     * @param {string} dataType - 'teacher' 或 'student'
     * @returns {HTMLElement|null}
     */
    function getExportButton(dataType) {
        const btnId = dataType === 'teacher' ? 'exportTeacherData' : 'exportStudentData';
        return document.getElementById(btnId);
    }

    /**
     * 禁用导出按钮
     */
    function disableExportButtons() {
        const teacherBtn = getExportButton('teacher');
        const studentBtn = getExportButton('student');
        if (teacherBtn) teacherBtn.disabled = true;
        if (studentBtn) studentBtn.disabled = true;
    }

    /**
     * 启用导出按钮
     */
    function enableExportButtons() {
        const teacherBtn = getExportButton('teacher');
        const studentBtn = getExportButton('student');
        if (teacherBtn) teacherBtn.disabled = false;
        if (studentBtn) studentBtn.disabled = false;
    }

    /**
     * 更新按钮加载状态
     * @param {string} dataType - 'teacher' 或 'student'
     * @param {boolean} loading - 是否加载中
     */
    function updateButtonLoadingState(dataType, loading) {
        const btn = getExportButton(dataType);
        if (!btn) return;

        if (loading) {
            btn.disabled = true;
            btn.classList.add('loading');
            const spinner = btn.querySelector('.spinner');
            if (spinner) spinner.style.display = 'inline-block';
            const text = btn.querySelector('.export-text');
            if (text) text.style.display = 'none';
        } else {
            btn.disabled = false;
            btn.classList.remove('loading');
            const spinner = btn.querySelector('.spinner');
            if (spinner) spinner.style.display = 'none';
            const text = btn.querySelector('.export-text');
            if (text) text.style.display = 'inline';
        }
    }

    /**
     * 显示进度指示器
     * @param {number} progress - 进度百分比 0-100
     * @param {string} message - 进度信息
     */
    function showProgressIndicator(progress, message = '') {
        let progressContainer = document.getElementById('exportProgressContainer');
        if (!progressContainer) {
            progressContainer = document.createElement('div');
            progressContainer.id = 'exportProgressContainer';
            progressContainer.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: white;
                border-radius: 8px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.15);
                padding: 24px;
                z-index: 10000;
                min-width: 300px;
                text-align: center;
            `;
            document.body.appendChild(progressContainer);
        }

        const progressBar = progressContainer.querySelector('.progress-bar') || 
                           (() => {
                               const bar = document.createElement('div');
                               bar.className = 'progress-bar';
                               bar.style.cssText = `
                                   width: 100%;
                                   height: 6px;
                                   background: #e0e0e0;
                                   border-radius: 3px;
                                   overflow: hidden;
                                   margin: 12px 0;
                               `;
                               const fill = document.createElement('div');
                               fill.className = 'progress-fill';
                               fill.style.cssText = `
                                   height: 100%;
                                   background: linear-gradient(90deg, #3b82f6, #2563eb);
                                   width: 0%;
                                   transition: width 0.3s ease;
                               `;
                               bar.appendChild(fill);
                               return bar;
                           })();

        if (!progressContainer.querySelector('.progress-bar')) {
            progressContainer.appendChild(progressBar);
        }

        const fill = progressBar.querySelector('.progress-fill');
        if (fill) fill.style.width = `${progress}%`;

        const msgEl = progressContainer.querySelector('.progress-message') ||
                     (() => {
                         const el = document.createElement('div');
                         el.className = 'progress-message';
                         el.style.cssText = `
                             margin-top: 12px;
                             color: #666;
                             font-size: 14px;
                         `;
                         progressContainer.appendChild(el);
                         return el;
                     })();

        msgEl.textContent = message || `处理中... ${progress}%`;
        progressContainer.style.display = 'block';

        if (progress >= 100) {
            setTimeout(() => {
                progressContainer.style.display = 'none';
            }, 1000);
        }
    }

    /**
     * 隐藏进度指示器
     */
    function hideProgressIndicator() {
        const container = document.getElementById('exportProgressContainer');
        if (container) container.style.display = 'none';
    }

    /**
     * 创建并下载Excel文件
     * @param {Object} excelData - Excel数据对象
     * @param {Array} excelData.data - 数据行数组
     * @param {Object} excelData.metadata - 元数据
     */
    async function createAndDownloadExcel(excelData) {
        try {
            // 确保XLSX库已加载
            if (typeof XLSX === 'undefined') {
                throw new Error('Excel库未加载，请稍后重试');
            }

            showProgressIndicator(30, '生成Excel文件...');

            // 创建工作簿
            const wb = XLSX.utils.book_new();

            // 将数据转换为工作表
            showProgressIndicator(50, '转换数据格式...');
            const ws = XLSX.utils.json_to_sheet(excelData.data);

            // 设置列宽
            const colWidths = [];
            const firstRow = excelData.data[0] || {};
            Object.keys(firstRow).forEach(key => {
                const maxLength = Math.max(
                    key.length,
                    ...excelData.data.map(row => String(row[key] || '').length)
                );
                colWidths.push({ wch: Math.min(Math.max(maxLength + 2, 15), 40) });
            });
            ws['!cols'] = colWidths;

            // 添加主数据工作表
            XLSX.utils.book_append_sheet(wb, ws, excelData.metadata?.title || '数据');

            // 如果有元数据，创建元数据工作表
            if (excelData.metadata) {
                showProgressIndicator(70, '添加元数据...');
                const metadataData = [
                    ['属性', '值'],
                    ['标题', excelData.metadata.title || ''],
                    ['数据范围', excelData.metadata.dateRange || ''],
                    ['导出时间', excelData.metadata.exportTime || ''],
                    ['记录总数', excelData.metadata.totalRecords || 0],
                    ['导出版本', excelData.metadata.exportVersion || '1.0']
                ];
                const metadataWs = XLSX.utils.aoa_to_sheet(metadataData);
                metadataWs['!cols'] = [{ wch: 20 }, { wch: 40 }];
                XLSX.utils.book_append_sheet(wb, metadataWs, '导出信息');
            }

            // 下载文件
            showProgressIndicator(90, '准备下载...');
            XLSX.writeFile(wb, excelData.filename);

            showProgressIndicator(100, '导出完成！');
            return true;
        } catch (error) {
            console.error('创建Excel文件失败:', error);
            hideProgressIndicator();
            throw error;
        }
    }

    /**
     * 动态加载XLSX库
     * @returns {Promise<boolean>}
     */
    async function ensureXLSXLoaded() {
        return new Promise((resolve) => {
            if (typeof XLSX !== 'undefined') {
                resolve(true);
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
    }

    /**
     * 处理导出错误
     * @param {Error} error - 错误对象
     * @returns {Object} 包含状态码和错误信息的对象
     */
    function handleExportError(error) {
        const message = error.message || '导出失败，请稍后重试';
        let statusCode = 'error';
        let suggestion = '';

        if (message.includes('超过限制')) {
            statusCode = 'size_exceeded';
            suggestion = '请缩小导出日期范围或分次导出。';
        } else if (message.includes('权限')) {
            statusCode = 'permission_denied';
            suggestion = '您没有权限执行此操作。';
        } else if (message.includes('日期')) {
            statusCode = 'invalid_date';
            suggestion = '请检查日期范围是否正确。';
        } else if (error.status === 413) {
            statusCode = 'payload_too_large';
            suggestion = '数据量过大，请缩小查询范围。';
        } else if (error.status === 401) {
            statusCode = 'unauthorized';
            suggestion = '您的登录已过期，请重新登录。';
        } else if (error.status === 403) {
            statusCode = 'forbidden';
            suggestion = '您没有权限执行此操作。';
        }

        return { statusCode, message, suggestion };
    }

    // 公开接口
    return {
        getExportButton,
        disableExportButtons,
        enableExportButtons,
        updateButtonLoadingState,
        showProgressIndicator,
        hideProgressIndicator,
        createAndDownloadExcel,
        ensureXLSXLoaded,
        handleExportError,
        getState: () => ({ ...state }),
        setState: (newState) => Object.assign(state, newState)
    };
})();
