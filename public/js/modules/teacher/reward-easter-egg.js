/**
 * 教师端"数据统计"隐藏酬劳计算彩蛋
 * 触发：统计区块标题连续点击 5 次（间隔 >3s 重置）
 * 成功后跳转到新页面 /teacher/dashboard/teaching-display/goodluck，由该页面直接渲染 JSON
 */

// 触发后跳转的目标页面（该页面自包含计算并展示 JSON）
const REWARD_PAGE = '/teacher/dashboard/teaching-display/goodluck';

// 标题样式（保持可点击且独占整行）
const TRIGGER_CSS = `
.reward-trigger-title{display:block;width:100%;font-size:20px;font-weight:700;color:#1e293b;margin:0 0 16px;padding:4px 0;cursor:pointer;user-select:none;position:relative;transition:color .15s ease,transform .1s ease;}
.reward-trigger-title:hover{color:#2563eb;}
.reward-trigger-title.tapped{color:#3b82f6;transform:scale(.98);}
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
    const query = (start && end)
        ? `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
        : '';
    // 全页跳转：goodluck 页面会自行按当前日期段拉取统计并渲染 JSON
    window.location.href = REWARD_PAGE + query;
}

export function initRewardEasterEgg() {
    injectStyle();
    const title = document.getElementById('rewardTriggerTitle');
    if (!title || title.__rewardBound) return;
    title.__rewardBound = true;
    title.title = title.title || '连续点击 5 次查看隐藏面板';

    let clickCount = 0;
    let lastClick = 0;
    const RESET_MS = 3000;

    function onTap() {
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
