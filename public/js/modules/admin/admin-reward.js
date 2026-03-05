
// Admin Reward Logic

// 创建管理员端奖励弹窗
export function createAdminRewardModal() {
    if (document.getElementById('adminRewardModal')) return;

    const modal = document.createElement('div');
    modal.className = 'reward-modal-overlay';
    modal.id = 'adminRewardModal';
    modal.innerHTML = `
        <div class="reward-modal-content">
            <span class="material-icons-round reward-icon" id="adminRewardIcon">emoji_events</span>
            <div class="reward-title" id="adminRewardTitle">Title</div>
            <div class="reward-value" id="adminRewardValue">0</div>
            <button class="reward-close-btn" onclick="document.getElementById('adminRewardModal').classList.remove('active')">Awesome!</button>
        </div>
    `;
    document.body.appendChild(modal);

    // 点击遮罩层关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
    });
}

// 显示管理员端奖励弹窗
export function showAdminReward(title, value, type) {
    createAdminRewardModal();
    const modal = document.getElementById('adminRewardModal');

    document.getElementById('adminRewardTitle').textContent = title;
    document.getElementById('adminRewardValue').textContent = value;

    // Icon映射
    const icons = {
        'teachers': 'group',
        'students': 'school',
        'weekly': 'date_range',
        'monthly': 'calendar_today',
        'yearly': 'star',
        'pending': 'pending_actions',
        'completed': 'verified',
        'cancelled': 'cancel'
    };
    document.getElementById('adminRewardIcon').textContent = icons[type] || 'emoji_events';

    modal.classList.add('active');
    createAdminConfetti();
}

// 创建彩纸动画
export function createAdminConfetti() {
    const colors = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#6366F1', '#EC4899'];
    const container = document.getElementById('adminRewardModal');

    // 增加数量到150个，让撒花更密集
    for (let i = 0; i < 150; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'reward-confetti';
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];

        // 增加粒子大小变化
        const size = 8 + Math.random() * 8; // 8-16px
        confetti.style.width = size + 'px';
        confetti.style.height = size + 'px';

        // 降低透明度（提高不透明度）
        confetti.style.opacity = '0.9';

        confetti.style.animationDuration = (Math.random() * 3 + 2) + 's';
        confetti.style.animationDelay = Math.random() * 0.5 + 's'; // 减少延迟，更快出现
        confetti.style.animation = `fall ${confetti.style.animationDuration} linear forwards`;
        confetti.style.animationDelay = confetti.style.animationDelay;
        container.appendChild(confetti);

        // 清理
        setTimeout(() => confetti.remove(), 6000);
    }
}

// ============================================================================
// 关键修复：确保使用 schedule-manager.js 中的真实 WeeklyDataStore 实现
// ============================================================================
// 问题：schedule-manager.js 是 ES 模块（type="module"），会在所有普通脚本之后执行
// 导致 legacy-adapter.js 总是先运行并创建存根，即使在HTML中 schedule-manager.js 位置靠前
// 解决方案：延迟0ms后重新检查 window.WeeklyDataStore，如果发现真实实现则替换本地引用

setTimeout(() => {
    const realStore = window.WeeklyDataStore;

    // 检查是否有真实的 getSchedules 实现（不是存根）
    if (realStore && realStore.getSchedules) {
        const fnString = realStore.getSchedules.toString();
        const isRealImplementation = fnString.includes('fetch') || fnString.includes('apiUtils');

        if (window.WeeklyDataStore && typeof window.WeeklyDataStore.getSchedules === 'function') {
            const realStore = window.WeeklyDataStore;
            window.WeeklyDataStore = realStore;
        } else {
            
            
        }
    } else {
        
    }
}, 0);


// Global exposure
window.createAdminRewardModal = createAdminRewardModal;
window.showAdminReward = showAdminReward;
window.createAdminConfetti = createAdminConfetti;
