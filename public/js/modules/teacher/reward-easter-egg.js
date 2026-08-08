/**
 * 教师端"数据统计"隐藏酬劳计算彩蛋
 * @description 绑定到教师端原始标题(#pageTitle，切到数据统计时显示"数据统计")，
 *              连续点击 5 次后跳转到 /teacher/dashboard/teaching-display/goodluck，
 *              该路由直接返回 JSON（无 HTML）。
 */

const REWARD_PAGE = '/teacher/dashboard/teaching-display/goodluck';
const TRIGGER_TEXT = '数据统计';
const RESET_MS = 3000;

// 仅给触发瞬间的标题一个极轻微的缩放反馈（行为反馈，不改颜色/布局）。
const TRIGGER_CSS = `
#pageTitle.tapped { transform: scale(.98); }
`;

function injectStyle() {
    if (document.getElementById('rewardEasterEggStyle')) return;
    const s = document.createElement('style');
    s.id = 'rewardEasterEggStyle';
    s.textContent = TRIGGER_CSS;
    document.head.appendChild(s);
}

function gotoRewardPage() {
    const start = document.getElementById('teachingStartDate')?.value || '';
    const end = document.getElementById('teachingEndDate')?.value || '';
    const token = localStorage.getItem('token') || '';
    const q = [];
    if (start && end) {
        q.push(`start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    }
    // 直接导航无法带 Authorization 头，故把 token 带入 URL（隐藏调试页，非敏感操作）。
    if (token) q.push(`token=${encodeURIComponent(token)}`);
    window.location.href = REWARD_PAGE + (q.length ? '?' + q.join('&') : '');
}

export function initRewardEasterEgg() {
    injectStyle();
    const title = document.getElementById('pageTitle');
    if (!title || title.__rewardBound) return;
    title.__rewardBound = true;
    title.title = title.title || '连续点击 5 次查看隐藏面板';
    let clickCount = 0;
    let lastClick = 0;

    function onTap() {
        // 仅在当前标题为"数据统计"（即处于统计区块）时计数
        if (title.textContent.trim() !== TRIGGER_TEXT) return;
        const now = Date.now();
        if (now - lastClick > RESET_MS) clickCount = 0;
        lastClick = now;
        clickCount++;
        title.classList.add('tapped');
        setTimeout(() => title.classList.remove('tapped'), 120);
        if (clickCount >= 5) {
            clickCount = 0;
            gotoRewardPage();
        }
    }

    title.addEventListener('click', onTap);
    title.addEventListener('touchstart', (e) => {
        e.preventDefault();
        onTap();
    }, { passive: false });
}
