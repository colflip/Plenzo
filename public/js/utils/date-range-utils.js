(function () {
  const TIME_ZONE = 'Asia/Shanghai';
  function toStartOfDay(date) {
    const d = new Date(date); d.setHours(0, 0, 0, 0); return d;
  }
  function formatYMD(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function getISOWeekNumber(date) {
    const d = toStartOfDay(date);
    const day = d.getDay() || 7; // 周日=7
    d.setDate(d.getDate() + 4 - day); // 跳到本周周四
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return weekNo;
  }
  function getWeekDates(baseDate) {
    const d = toStartOfDay(baseDate);
    const day = d.getDay() || 7; // 周日=7
    const monday = new Date(d); monday.setDate(d.getDate() - (day - 1));
    const week = [];
    for (let i = 0; i < 7; i++) {
      const cur = new Date(monday); cur.setDate(monday.getDate() + i);
      week.push(cur);
    }
    return week;
  }
  function formatRangeText(start, end) {
    const weekNo = getISOWeekNumber(start);
    return `${formatYMD(start)} - ${formatYMD(end)}（第${weekNo}周）`;
  }
  function updateRangeText({ start, end, el }) {
    const target = el || document.getElementById('weekRange');
    if (!target) return;
    target.textContent = formatRangeText(start, end);
  }
  window.DateRangeUtils = { getWeekDates, formatYMD, getISOWeekNumber, formatRangeText, updateRangeText };
})();