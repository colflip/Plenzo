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
  function computeRange(preset) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const year = today.getFullYear();
    const month = today.getMonth();
    let start, end;

    const p = String(preset || '').toLowerCase().replace(/_/g, '-');

    switch (p) {
      case 'today':
        start = end = today;
        break;
      case 'yesterday':
        start = end = new Date(today);
        start.setDate(today.getDate() - 1);
        break;
      case 'week':
      case 'this-week': {
        const day = today.getDay() || 7;
        start = new Date(today);
        start.setDate(today.getDate() - (day - 1));
        end = new Date(start);
        end.setDate(start.getDate() + 6);
        break;
      }
      case 'prev-week':
      case 'last-week': {
        const day = today.getDay() || 7;
        const thisMon = new Date(today);
        thisMon.setDate(today.getDate() - (day - 1));
        start = new Date(thisMon);
        start.setDate(thisMon.getDate() - 7);
        end = new Date(start);
        end.setDate(start.getDate() + 6);
        break;
      }
      case 'month':
      case 'this-month':
        start = new Date(year, month, 1);
        end = new Date(year, month + 1, 0);
        break;
      case 'prev-month':
      case 'last-month':
        start = new Date(year, month - 1, 1);
        end = new Date(year, month, 0);
        break;
      case 'quarter':
      case 'this-quarter': {
        const q = Math.floor(month / 3);
        start = new Date(year, q * 3, 1);
        end = new Date(year, (q + 1) * 3, 0);
        break;
      }
      case 'prev-quarter':
      case 'last-quarter': {
        const q = Math.floor(month / 3);
        let sMonth = (q * 3) - 3;
        let sYear = year;
        if (sMonth < 0) { sMonth += 12; sYear--; }
        start = new Date(sYear, sMonth, 1);
        end = new Date(sYear, sMonth + 3, 0);
        break;
      }
      case 'year':
      case 'this-year':
        start = new Date(year, 0, 1);
        end = new Date(year, 11, 31);
        break;
      case 'prev-year':
      case 'last-year':
        start = new Date(year - 1, 0, 1);
        end = new Date(year - 1, 11, 31);
        break;
      default:
        return null;
    }
    return { start: formatYMD(start), end: formatYMD(end) };
  }

  function syncPresetButtons(startDate, endDate, container) {
    if (!container) return;
    const btns = container.querySelectorAll('.preset-btn');
    if (!btns || btns.length === 0) return;

    btns.forEach(btn => {
      const preset = btn.getAttribute('data-preset') || btn.getAttribute('data-range');
      const range = computeRange(preset);
      const isActive = (range && range.start === startDate && range.end === endDate);

      if (isActive) {
        btn.classList.add('active');
        // 兼容 Teacher/Student 端的硬编码样式样式
        if (btn.style) {
          btn.style.backgroundColor = '#dcfce7';
          btn.style.color = '#15803d';
          btn.style.borderColor = 'transparent';
          btn.style.outline = 'none';
        }
      } else {
        btn.classList.remove('active');
        if (btn.style) {
          btn.style.backgroundColor = 'white';
          btn.style.color = '#333';
          btn.style.borderColor = '#d1d5db';
        }
      }
    });
  }

  window.DateRangeUtils = { getWeekDates, formatYMD, getISOWeekNumber, formatRangeText, updateRangeText, computeRange, syncPresetButtons };
})();