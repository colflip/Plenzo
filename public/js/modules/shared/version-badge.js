(function () {
    const BADGE_ID = 'appVersionBadge';

    function formatUpdatedAt(value) {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        // 紧凑日期：YYYYMMDD（东八区）
        const parts = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).formatToParts(date);
        const get = (type) => (parts.find(p => p.type === type) || {}).value || '';
        return `${get('year')}${get('month')}${get('day')}`;
    }

    function resolveMountTarget() {
        // 优先挂到最外层背景卡片（dashboard-container），否则回退到 body
        const container = document.querySelector('.dashboard-container');
        return container || document.body;
    }

    function ensureBadge() {
        let badge = document.getElementById(BADGE_ID);
        if (badge && badge.isConnected) return badge;

        if (badge && !badge.isConnected) {
            // 节点已存在但被移出文档树（如重渲染），重新挂载
            const target = resolveMountTarget();
            target.appendChild(badge);
            return badge;
        }

        badge = document.createElement('a');
        badge.id = BADGE_ID;
        badge.className = 'app-version-badge';
        badge.href = '#';
        badge.target = '_blank';
        badge.rel = 'noopener noreferrer';
        badge.setAttribute('aria-label', '系统版本');
        badge.textContent = '';
        const target = resolveMountTarget();
        target.appendChild(badge);
        return badge;
    }

    function syncOverviewVisibility() {
        const badge = document.getElementById(BADGE_ID);
        if (!badge) return;

        const overview = document.getElementById('overview');
        const shouldShow = !overview || overview.classList.contains('active');
        badge.classList.toggle('is-hidden', !shouldShow);
    }

    function watchOverviewVisibility() {
        syncOverviewVisibility();

        const overview = document.getElementById('overview');
        if (overview) {
            const observer = new MutationObserver(syncOverviewVisibility);
            observer.observe(overview, {
                attributes: true,
                attributeFilter: ['class', 'style']
            });
        }

        document.addEventListener('click', (event) => {
            if (event.target.closest('[data-section]')) {
                setTimeout(syncOverviewVisibility, 0);
            }
        });
    }

    async function loadVersionBadge() {
        const badge = ensureBadge();
        watchOverviewVisibility();
        try {
            const response = await fetch('/api/meta/version', {
                headers: { 'Accept': 'application/json' },
                credentials: 'same-origin'
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const meta = await response.json();
            const dateText = formatUpdatedAt(meta.updatedAt);
            const sha = meta.shortSha || '';
            // 显示格式：shortSha,YYYYMMDD（缺失项自动省略）
            const label = [sha, dateText].filter(Boolean).join(',');
            badge.textContent = label || '版本未知';
            badge.title = meta.source === 'github'
                ? '来自 GitHub 仓库版本信息'
                : '来自本地 Git 最近提交时间';

            if (meta.repoUrl) {
                badge.href = meta.repoUrl;
            } else {
                badge.removeAttribute('href');
            }
        } catch (error) {
            badge.textContent = '版本未知';
            badge.title = '无法获取系统版本信息';
            badge.removeAttribute('href');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadVersionBadge);
    } else {
        loadVersionBadge();
    }
})();
