/**
 * 酬劳达成弹窗（学生端 / 教师端概览共用，原两处逐字相同）。
 *
 * 依赖 reward-modal-overlay / reward-confetti 的既有 CSS（dashboard.css），
 * 关闭按钮走 data-action="reward-close"（action-delegate 全局分发）。
 */

export function createRewardModal() {
    if (document.getElementById('rewardModal')) return;

    const modal = document.createElement('div');
    modal.className = 'reward-modal-overlay';
    modal.id = 'rewardModal';
    modal.innerHTML = `
        <div class="reward-modal-content">
            <span class="material-icons-round reward-icon" id="rewardIcon">emoji_events</span>
            <div class="reward-title" id="rewardTitle">Title</div>
            <div class="reward-value" id="rewardValue">0</div>
            <button class="reward-close-btn" data-action="reward-close">Awesome!</button>
        </div>
    `;
    document.body.appendChild(modal);

    // Close on overlay click
    modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.remove('active');
    });
}

export function showReward(title, value, type) {
    createRewardModal(); // Ensure it exists
    const modal = document.getElementById('rewardModal');

    document.getElementById('rewardTitle').textContent = title;
    document.getElementById('rewardValue').textContent = value;

    // Icon selection
    const icons = {
        'weekly': 'date_range',
        'monthly': 'calendar_today',
        'yearly': 'star',
        'pending': 'pending_actions',
        'completed': 'verified',
        'cancelled': 'cancel'
    };
    document.getElementById('rewardIcon').textContent = icons[type] || 'emoji_events';

    modal.classList.add('active');
    createConfetti();
}

export function createConfetti() {
    const colors = ['#EF4444', '#F59E0B', '#10B981', '#3B82F6', '#6366F1', '#EC4899'];
    const container = document.getElementById('rewardModal');

    for (let i = 0; i < 50; i++) {
        const confetti = document.createElement('div');
        confetti.className = 'reward-confetti';
        confetti.style.left = Math.random() * 100 + '%';
        confetti.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        confetti.style.animationDuration = (Math.random() * 3 + 2) + 's';
        confetti.style.animationDelay = Math.random() * 2 + 's';
        container.appendChild(confetti);

        // Cleanup
        setTimeout(() => confetti.remove(), 5000);
    }
}
