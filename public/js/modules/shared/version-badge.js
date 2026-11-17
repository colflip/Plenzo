(function () {
    const BADGE_ID = 'appVersionBadge';
    const REPO = 'colflip/Plenzo';

    /**
     * 实时读 GitHub 仓库的最新 commit（api.github.com 是 GitHub 官方唯一允许浏览器
     * 跨域访问的入口，仓库 HTML 页面没有 CORS 头，前端 fetch 会被浏览器拦掉）。
     * 未认证限额 60 次/小时/IP，仅本徽章使用足够。
     */
    async function fetchLiveGitHubCommit() {
        const response = await fetch(`https://api.github.com/repos/${REPO}/commits/HEAD`, {
            headers: { 'Accept': 'application/vnd.github+json' },
            signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) throw new Error(`GitHub API ${response.status}`);
        const data = await response.json();
        return (data.sha || '').slice(0, 7);
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
        badge.href = 'https://github.com/colflip/Plenzo';
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

        // 只在首页（总览）显示：无 overview 区块的页面（如登录页）不显示
        const overview = document.getElementById('overview');
        const shouldShow = Boolean(overview) && overview.classList.contains('active');
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
        badge.textContent = '';
        badge.href = `https://github.com/${REPO}`;

        // 服务端版本信息只请求一次：runtime 字段始终要用，同时作为 GitHub 读不到时的兜底。
        const serverMetaPromise = window.apiUtils
            ? window.apiUtils.get('/meta/version', {}, {
                timeoutMs: 10000,
                suppressErrorToast: true
            }).catch(() => null)
            : Promise.resolve(null);

        // 版本号优先实时读 GitHub 最新 commit；读不到（断网/限流）再退回服务端版本。
        let sha = '';
        const [live, serverMeta] = await Promise.all([
            fetchLiveGitHubCommit().catch(() => null),
            serverMetaPromise
        ]);

        if (live) {
            sha = live;
            badge.title = '实时读取自 GitHub 仓库最新提交';
        } else if (serverMeta && typeof serverMeta === 'object') {
            sha = serverMeta.shortSha || '';
            badge.title = serverMeta.source === 'github'
                ? '来自 GitHub 仓库版本信息（服务端）'
                : '来自本地 Git 最近提交时间';
            badge.href = serverMeta.repoUrl || `https://github.com/${REPO}`;
        } else {
            badge.title = '无法获取系统版本信息';
        }

        const runtime = (serverMeta && serverMeta.runtime) || '';

        // 只显示拿到的字段（shortSha,环境）；全部缺失则整个徽章不显示
        const label = [sha, runtime].filter(Boolean).join(',');
        if (label) {
            badge.textContent = label;
            badge.classList.remove('is-hidden');
        } else {
            badge.classList.add('is-hidden');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadVersionBadge);
    } else {
        loadVersionBadge();
    }
})();
