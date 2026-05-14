(function () {
    const BADGE_ID = 'appVersionBadge';

    function formatUpdatedAt(value) {
        if (!value) return '未知';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '未知';
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(date).replace(/\//g, '-');
    }

    function ensureBadge() {
        let badge = document.getElementById(BADGE_ID);
        if (badge) return badge;

        badge = document.createElement('a');
        badge.id = BADGE_ID;
        badge.className = 'app-version-badge';
        badge.href = '#';
        badge.target = '_blank';
        badge.rel = 'noopener noreferrer';
        badge.setAttribute('aria-label', '系统版本');
        badge.textContent = '系统版本 加载中';
        document.body.appendChild(badge);
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
            const updatedText = formatUpdatedAt(meta.updatedAt);
            const suffix = meta.shortSha ? ` · ${meta.shortSha}` : '';
            badge.textContent = `系统版本 ${updatedText}${suffix}`;
            badge.title = meta.source === 'github'
                ? '来自 GitHub 仓库版本信息'
                : '来自本地 Git 最近提交时间';

            if (meta.repoUrl) {
                badge.href = meta.repoUrl;
            } else {
                badge.removeAttribute('href');
            }
        } catch (error) {
            badge.textContent = '系统版本 暂不可用';
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
