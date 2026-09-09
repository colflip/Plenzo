(function () {
  // 读取 CSS 变量工具，带回退
  function getCssVar(name, fallback = '') {
    try {
      const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return val || fallback;
    } catch (_) {
      return fallback;
    }
  }

  // 现代化配色方案 - 与 color-utils.js 扩展色池保持一致
  // 仅作为 getLegendColor 不可用时的兜底
  const ACCESSIBLE_PALETTE = [
    '#2563EB', // Blue (Primary)
    '#10B981', // Emerald
    '#8B5CF6', // Violet
    '#06B6D4', // Cyan
    '#F59E0B', // Amber
    '#F472B6', // Pink
    '#FB923C', // Orange
    '#6366F1', // Indigo
    '#14B8A6', // Teal
    '#94A3B8'  // Slate
  ];

  // 全局配置 Chart.js 默认字体
  try {
    // 优先使用 Inter，其次是系统字体
    const chartFont = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    if (window.Chart && Chart.defaults) {
      Chart.defaults.font.family = chartFont;
      Chart.defaults.color = '#64748b'; // slate-500
      Chart.defaults.scale.grid.color = 'rgba(15, 23, 42, 0.06)';
      // 浅色现代 tooltip，与卡片设计语言一致
      Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(255, 255, 255, 0.96)';
      Chart.defaults.plugins.tooltip.titleColor = '#1F2937';
      Chart.defaults.plugins.tooltip.bodyColor = '#4B5563';
      Chart.defaults.plugins.tooltip.footerColor = '#1F2937';
      Chart.defaults.plugins.tooltip.borderColor = '#E5E7EB';
      Chart.defaults.plugins.tooltip.borderWidth = 1;
      Chart.defaults.plugins.tooltip.padding = 12;
      Chart.defaults.plugins.tooltip.cornerRadius = 8;
      Chart.defaults.plugins.tooltip.usePointStyle = true;
    }
  } catch (_) { }

  // 获取配色方案（循环使用）
  function getPalette(opts) {
    if (opts && opts.palette && Array.isArray(opts.palette)) return opts.palette;
    return ACCESSIBLE_PALETTE;
  }

  function destroyChartById(canvasId) {
    const el = document.getElementById(canvasId);
    if (!el) return;
    const prev = Chart.getChart(el);
    if (prev) try { prev.destroy(); } catch (_) { }
  }

  // 异常值与边界处理工具
  function sanitizeArray(arr, clampMax) {
    return (arr || []).map(v => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return 0;
      if (typeof clampMax === 'number' && clampMax > 0) return Math.min(n, clampMax);
      return n;
    });
  }

  function computeClampMaxFromSeries(seriesList) {
    const values = [];
    (seriesList || []).forEach(s => {
      (s?.data || []).forEach(v => {
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) values.push(n);
      });
    });
    if (!values.length) return 10; // 安全默认
    values.sort((a, b) => a - b);
    const p = 0.95;
    const idx = Math.max(0, Math.min(values.length - 1, Math.floor(values.length * p)));
    const p95 = values[idx];
    // 给予少量余量，避免顶格
    const margin = Math.max(1, Math.ceil(p95 * 0.05));
    return Math.max(1, p95 + margin);
  }

  function localToISODate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function ensureISO(dateLike) {
    if (!dateLike) return '';
    if (typeof dateLike === 'string') {
      const m = dateLike.match(/^\d{4}-\d{2}-\d{2}/);
      if (m) return m[0];
      try {
        return (typeof window.toISODate === 'function')
          ? window.toISODate(new Date(dateLike))
          : localToISODate(new Date(dateLike));
      } catch (_) {
        return '';
      }
    } else {
      const d = new Date(dateLike);
      return (typeof window.toISODate === 'function') ? window.toISODate(d) : localToISODate(d);
    }
  }

  function buildDayLabels(startISO, endISO) {
    const start = new Date(startISO);
    const end = new Date(endISO);
    const labels = [];
    const cur = new Date(start);
    cur.setHours(0, 0, 0, 0);
    const endDate = new Date(end);
    endDate.setHours(0, 0, 0, 0);
    const toIso = (typeof window.toISODate === 'function') ? window.toISODate : localToISODate;
    while (cur <= endDate) {
      labels.push(toIso(cur));
      cur.setDate(cur.getDate() + 1);
    }
    return labels;
  }

  function buildTopEntitiesByCount(rows, key, n) {
    const counts = new Map();
    rows.forEach(r => {
      const name = (r && r[key]) ? r[key] : '未分配';
      counts.set(name, (counts.get(name) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, n || 3))
      .map(([name]) => name);
  }

  function buildDailySeriesForEntities(rows, key, dayLabels, entities) {
    const map = new Map();
    entities.forEach(e => map.set(e, new Array(dayLabels.length).fill(0)));
    rows.forEach(r => {
      const iso = ensureISO(r && r.date);
      if (!iso) return;
      const idx = dayLabels.indexOf(iso);
      if (idx === -1) return;
      const name = (r && r[key]) ? r[key] : '未分配';
      if (!map.has(name)) return;
      const arr = map.get(name);
      arr[idx] += 1;
    });
    return entities.map((e, i) => ({
      label: e,
      data: map.get(e) || new Array(dayLabels.length).fill(0)
    }));
  }

  // 评审等价别名：业务口径中「大评审」等同于「评审」，参与统计与折算时合并计入。
  // 集中在此处，避免各统计路径各自硬编码。
  const REVIEW_ALIASES = ['大评审', '大評審', 'big_review', 'bigreview'];
  function normalizeReviewLabel(label) {
    const l = String(label || '').trim();
    if (REVIEW_ALIASES.includes(l) || REVIEW_ALIASES.includes(l.toLowerCase())) return '评审';
    return label;
  }

  // 从统计接口（每日 × 类型，session 去重口径）构建堆叠数据集。
  // 教师视图/学生视图的「按日期汇总」用这份权威口径，不再从 grid 的
  // pair 行自行聚合 —— grid 为排课管理做了师生 JOIN 与删除过滤，
  // 会缺"已删除师生参与"的课程，导致图例类型不全。
  function buildStacksFromDailyStats(dailyStats, dayLabels) {
    const byType = new Map();
    (Array.isArray(dailyStats) ? dailyStats : []).forEach(row => {
      if (!row) return;
      const label = normalizeReviewLabel(String(row.type || '未分类'));
      if (!byType.has(label)) {
        const dayMap = {};
        dayLabels.forEach(d => { dayMap[d] = 0; });
        byType.set(label, dayMap);
      }
      const dayMap = byType.get(label);
      const iso = ensureISO(row.date);
      if (dayMap[iso] === undefined) return;
      dayMap[iso] += Number(row.count) || 0;
    });
    return Array.from(byType.entries())
      .map(([label, dayMap]) => {
        let total = 0;
        const data = dayLabels.map(d => {
          const v = dayMap[d] || 0;
          total += v;
          return v;
        });
        return { label, data, total };
      })
      .sort((a, b) => b.total - a.total)
      .map(({ label, data }) => ({ label, data }));
  }

  function buildStackedByTypePerDay(rows, dayLabels) {
    const typeSet = new Set();
    const dayTypeCount = dayLabels.map(() => ({}));
    // 口径：按「课程」计数 —— 同一场课（session）关联多名教师/学生时，
    // grid 会展开成多条 pair 行，这里每个 session 在同一日期只计 1 次，
    // 避免"按人头重复"把课程数放大。session_id 缺失时退化为行键兜底。
    const seenSessions = dayLabels.map(() => new Set());

    function mapTypeLabel(t) {
      const raw = String(t || '').trim();
      if (!raw) return '未分类';
      const num = Number(raw);
      const isId = !isNaN(num) && /^\d+$/.test(raw);
      if (isId && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
        const found = window.ScheduleTypesStore.getById(num);
        if (found) return normalizeReviewLabel(found.description || found.name || String(num));
      }
      return normalizeReviewLabel(raw);
    }

    rows.forEach(r => {
      const iso = ensureISO(r && r.date);
      const idx = dayLabels.indexOf(iso);
      if (idx === -1) return;
      const sessionKey = (r && r.session_id != null) ? 's:' + r.session_id
        : (r && r.id != null) ? 's:' + r.id
        : 'row:' + iso;
      if (seenSessions[idx].has(sessionKey)) return;
      seenSessions[idx].add(sessionKey);
      const typesStr = (r && r.schedule_types) ? String(r.schedule_types) : '';
      const types = typesStr ? typesStr.split(',') : ['未分类'];
      types.forEach(t => {
        const label = mapTypeLabel(t);
        typeSet.add(label);
        const obj = dayTypeCount[idx];
        obj[label] = (obj[label] || 0) + 1;
      });
    });
    const types = Array.from(typeSet);
    return types.map(label => ({
      label,
      data: dayTypeCount.map(cnt => cnt[label] || 0)
    }));
  }

  function renderSmoothMultiLineChart(canvasId, labels, seriesList, opts = {}) {
    const el = document.getElementById(canvasId);
    if (!el) return;
    destroyChartById(canvasId);
    const palette = getPalette(opts);
    const addAlpha = (color, alpha) => {
      const c = String(color || '').trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
        let r, g, b;
        if (c.length === 4) { r = parseInt(c[1] + c[1], 16); g = parseInt(c[2] + c[2], 16); b = parseInt(c[3] + c[3], 16); }
        else { r = parseInt(c.slice(1, 3), 16); g = parseInt(c.slice(3, 5), 16); b = parseInt(c.slice(5, 7), 16); }
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
      }
      if (/^rgba?\(/i.test(c)) {
        return c.replace(/rgba?\(([^)]+)\)/i, (m, inner) => {
          const parts = inner.split(',').map(s => s.trim());
          const [r, g, b] = parts; return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        });
      }
      return c;
    };
    const colorFor = (label, i) => {
      try { if (typeof window.getLegendColor === 'function') return window.getLegendColor(label); } catch (_) { }
      return palette[i % palette.length];
    };
    const clampMax = computeClampMaxFromSeries(seriesList);
    const datasets = seriesList.map((s, i) => ({
      label: s.label,
      data: sanitizeArray(s.data),
      borderColor: colorFor(s.label, i),
      backgroundColor: colorFor(s.label, i),
      fill: false,
      tension: 0.35,
      pointRadius: opts.pointRadius ?? 0,
      borderWidth: 2,
      spanGaps: true
    }));
    const chart = new Chart(el.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: opts.animation === false ? false : undefined,
        interaction: { mode: opts.interactionMode || 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            onHover: (e) => { if (e && e.native) e.native.target.style.cursor = 'pointer'; },
            onClick: (e, item, legend) => {
              const chart = legend.chart;
              const idx = item.datasetIndex ?? item.index ?? 0;
              const now = Date.now();
              const last = chart.$lastLegendClick || 0;
              const isDbl = (now - last) < 300 && chart.$lastLegendIndex === idx;
              chart.$lastLegendClick = now; chart.$lastLegendIndex = idx;
              if (isDbl) {
                const current = chart.$highlightIndex;
                const newIndex = current === idx ? null : idx;
                chart.$highlightIndex = newIndex;
                chart.data.datasets.forEach((ds, di) => {
                  const base = ds.borderColor;
                  if (newIndex == null) {
                    ds.borderColor = base; ds.backgroundColor = base; ds.borderWidth = 2;
                  } else if (di === newIndex) {
                    ds.borderColor = base; ds.backgroundColor = base; ds.borderWidth = 3;
                  } else {
                    const dim = addAlpha(base, 0.25);
                    ds.borderColor = dim; ds.backgroundColor = dim; ds.borderWidth = 2;
                  }
                });
                chart.update(); return;
              }
              const vis = chart.isDatasetVisible(idx);
              chart.setDatasetVisibility(idx, !vis);
              chart.update();
            }
          },
          title: { display: false },
          tooltip: {
            enabled: true,
            callbacks: {
              title: function (tooltipItems) {
                // 将日期格式化为 YYYY年MM月DD日
                if (tooltipItems && tooltipItems.length > 0) {
                  const dataIndex = tooltipItems[0].dataIndex;
                  const originalLabel = labels[dataIndex];

                  // 检查是否是完整的 YYYY-MM-DD 格式
                  if (originalLabel && /^\d{4}-\d{2}-\d{2}$/.test(originalLabel)) {
                    const [year, month, day] = originalLabel.split('-');
                    return `${year}年${month}月${day}日`;
                  }

                  // 如果不是完整格式,返回原标签
                  const label = tooltipItems[0].label;
                  return label || '';
                }
                return '';
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              callback: function (value, index) {
                try {
                  const label = this.getLabelForValue ? this.getLabelForValue(value) : (labels[index] || value);
                  const m = String(label || '').match(/^\d{4}-\d{2}-(\d{2})/);
                  return m ? m[1] : label;
                } catch (_) { return value; }
              }
            }
          },
          y: { beginAtZero: true, suggestedMax: clampMax, min: 0, grid: { color: 'rgba(0,0,0,0.08)' } }
        }
      }
    });
  }

  // 「划线」揭示插件：动画期间把绘制裁剪到 chartArea 左缘 → 当前进度处，
  // 曲线/面积沿时间路径逐步显现（线条像被笔画出来），坐标轴在裁剪范围外不受影响。
  // 进度由 renderStackedBarChart 的 rAF 循环驱动（options.plugins.revealClip）。
  // easeInOutCubic：起步与收尾略缓、中段流畅，贴近手写划线的节奏。
  const REVEAL_EASE = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
  const REVEAL_CLIP_PLUGIN = {
    id: 'revealClip',
    beforeDatasetsDraw(chart, args, opts) {
      if (!opts || !opts.enabled || !opts.startTime) return;
      const area = chart.chartArea;
      if (!area || area.right <= area.left) return;
      const p = Math.min(1, (Date.now() - opts.startTime) / opts.duration);
      const clipX = area.left + (area.right - area.left) * REVEAL_EASE(p);
      const ctx = chart.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(area.left - 1, 0, Math.max(0, clipX - (area.left - 1)), chart.height);
      ctx.clip();
    },
    afterDatasetsDraw(chart, args, opts) {
      if (!opts || !opts.enabled || !opts.startTime) return;
      chart.ctx.restore();
    }
  };

  function renderStackedBarChart(canvasId, labels, stacks, opts = {}) {
    try {
      // 检查必要元素和依赖
      const el = document.getElementById(canvasId);
      if (!el) {
        return;
      }

      // 检查Chart.js是否加载
      if (typeof window.Chart === 'undefined') {

        // 统一错误态（window.ErrorUI 由 shared/error-ui.js 提供；未就绪时降级为文本）
        const parent = el.parentElement;
        if (parent) {
          if (window.ErrorUI && typeof window.ErrorUI.createErrorState === 'function') {
            parent.appendChild(window.ErrorUI.createErrorState({
              title: '图表加载失败',
              detail: '图表组件未就绪，请刷新页面重试'
            }));
          } else {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'chart-error';
            errorDiv.textContent = '图表加载失败，请刷新页面';
            parent.appendChild(errorDiv);
          }
        }
        return;
      }

      // 销毁旧图表
      destroyChartById(canvasId);

      // 显示加载中状态（如果有加载容器）
      const loadingContainer = document.getElementById(`${canvasId}-loading`);
      if (loadingContainer) {
        loadingContainer.style.display = 'flex';
      }

      // 确保labels是数组
      const safeLabels = Array.isArray(labels) ? labels : [];

      // 智能格式化日期标签（根据日期范围跨月/跨年情况）
      const formatDateLabels = (dateLabels) => {
        if (!dateLabels || dateLabels.length === 0) return dateLabels;

        // 解析所有日期
        const dates = dateLabels.map(dateStr => new Date(dateStr));

        // 获取年份和月份范围
        const years = dates.map(d => d.getFullYear());
        const months = dates.map(d => d.getMonth());

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);
        const minMonth = Math.min(...months);
        const maxMonth = Math.max(...months);

        // 检测是否跨年
        const spansMultipleYears = maxYear > minYear;

        // 检测是否跨月（同一年内）
        const spansMultipleMonths = maxMonth > minMonth || spansMultipleYears;

        // 跨年：显示 "YYYY-MM-DD" 格式
        if (spansMultipleYears) {
          return dateLabels; // 保持原格式 YYYY-MM-DD
        }

        // 跨月（但不跨年）：显示 "MM-DD" 格式
        if (spansMultipleMonths) {
          return dateLabels.map(dateStr => {
            const date = new Date(dateStr);
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${month}-${day}`;
          });
        }

        // 同一月内：显示 "DD" 格式
        return dateLabels.map(dateStr => {
          const date = new Date(dateStr);
          return String(date.getDate());
        });
      };

      // 格式化日期标签
      const formattedLabels = formatDateLabels(safeLabels);

      const palette = getPalette(opts);

      const addAlpha = (color, alpha) => {
        const c = String(color || '').trim();
        if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c)) {
          let r, g, b;
          if (c.length === 4) { r = parseInt(c[1] + c[1], 16); g = parseInt(c[2] + c[2], 16); b = parseInt(c[3] + c[3], 16); }
          else { r = parseInt(c.slice(1, 3), 16); g = parseInt(c.slice(3, 5), 16); b = parseInt(c.slice(5, 7), 16); }
          return `rgba(${r}, ${g}, ${b}, ${alpha})`;
        }
        if (/^rgba?\(/i.test(c)) {
          return c.replace(/rgba?\(([^)]+)\)/i, (m, inner) => {
            const parts = inner.split(',').map(s => s.trim());
            const [r, g, b] = parts; return `rgba(${r}, ${g}, ${b}, ${alpha})`;
          });
        }
        return c;
      };

      const colorFor = (label, i) => {
        try {
          if (typeof window.getLegendColor === 'function') {
            return window.getLegendColor(label);
          }
        } catch (_) { }
        return palette[i % palette.length];
      };

      // 若无数据集，提供一个"无数据"占位，以便仍显示日期轴
      const normalizedStacks = (Array.isArray(stacks) && stacks.length > 0)
        ? stacks
        : [{ label: '无数据', data: new Array(formattedLabels.length).fill(0) }];

      // 「从时间起点划到终点」动画：数据一次性完整加载（坐标轴/刻度按最终数据
      // 只渲染一次，全程不动），由 revealClip 插件把裁剪窗口从 chartArea 左缘
      // 匀速推到右缘 —— 曲线/面积沿时间路径逐步显现，即真实划线效果。
      // revealAnimation:false 可关闭；点数不足 3 个时直接静态渲染。
      const revealEnabled = opts.revealAnimation !== false && formattedLabels.length > 2;
      const REVEAL_DURATION_MS = 1600;
      const fullSeries = normalizedStacks.map(s => sanitizeArray(s.data));

      // 计算异常值边界
      const clampMax = computeClampMaxFromSeries(normalizedStacks);

      // 堆叠面积图数据集：平滑曲线 + 半透明填充，悬停才显示数据点
      // stack: 'types' 与总计线的 stack 分组隔离，避免总计被叠加计算
      const datasets = normalizedStacks.map((s, i) => {
        const color = colorFor(s.label, i);
        return {
          label: s.label,
          data: fullSeries[i],
          borderColor: color,
          backgroundColor: addAlpha(color, 0.78),
          borderWidth: 1.5,
          fill: i === 0 ? 'origin' : '-1',
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 10,
          pointBackgroundColor: color,
          pointBorderColor: '#fff',
          pointBorderWidth: 1.5,
          spanGaps: true,
          stack: 'types'
        };
      });

      // 可选：添加总计折线图叠加
      if (opts.showTotalLine) {
        

        // 计算每日总数
        const totalPerDay = formattedLabels.map((_, dayIdx) => {
          return normalizedStacks.reduce((sum, stack) => sum + (stack.data[dayIdx] || 0), 0);
        });

        // 美观的渐变蓝色（带透明度）
        const lineColor = 'rgba(59, 130, 246, 0.85)';  // 蓝色，85%透明度
        const pointColor = 'rgba(59, 130, 246, 1)';     // 实心点

        datasets.push({
          type: 'line',
          label: '总计',
          data: totalPerDay,
          borderColor: lineColor,
          backgroundColor: 'transparent',
          borderWidth: 3,                  // 稍微加粗
          borderDash: [6, 4],              // 调整虚线间隔：6px实线+4px间隔
          borderCapStyle: 'round',         // 圆角端点，更美观
          tension: 0.4,                    // 光滑曲线
          pointRadius: 4.5,                // 稍微加大点
          pointBackgroundColor: pointColor,
          pointBorderColor: '#fff',
          pointBorderWidth: 2,
          pointHoverRadius: 7,             // 悬停时点的半径
          pointHoverBackgroundColor: pointColor,
          pointHoverBorderWidth: 2,
          fill: false,
          order: 0,                        // 折线显示在面积图上方
          z: 10,                           // 确保层级最高
          stack: 'total',                  // 独立 stack 分组，不与类型面积叠加
          $isTotalLine: true
        });
      }

      // 创建图表配置（堆叠面积图）
      // Y 轴用强制 max（= P95 建议值与真实峰值的较大者 + 1 格余量），替代可被可见数据
      // 撑动的 suggestedMax —— 保证坐标轴与刻度在动画全程与静态展示完全一致。
      // 末尾 +1 是用户要求的"阈值"：最大值为 2 时轴显示 3，让整张堆叠图（含顶部总计线）
      // 顶部留出余量，避免最上层被坐标轴截断、视觉上"显示不全"。
      const fullDataMaxY = fullSeries.reduce((m, arr) => {
        arr.forEach(v => { const n = Number(v); if (Number.isFinite(n) && n > m) m = n; });
        return m;
      }, 0);
      const fixedYMax = Math.max(Number(clampMax) || 0, fullDataMaxY, 1) + 1;

      const chartConfig = {
        type: 'line',
        plugins: [REVEAL_CLIP_PLUGIN],
        data: {
          labels: formattedLabels,
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: {
            mode: opts.interactionMode || 'index',
            intersect: false
          },
          plugins: {
            revealClip: revealEnabled
              ? { enabled: true, startTime: 0, duration: REVEAL_DURATION_MS }
              : { enabled: false },
            legend: {
              position: 'bottom',
              onHover: (e) => {
                if (e && e.native) e.native.target.style.cursor = 'pointer';
              },
              onClick: (e, item, legend) => {
                try {
                  const chart = legend.chart;
                  const idx = item.datasetIndex ?? item.index ?? 0;
                  const now = Date.now();
                  const last = chart.$lastLegendClick || 0;
                  const isDbl = (now - last) < 300 && chart.$lastLegendIndex === idx;
                  chart.$lastLegendClick = now;
                  chart.$lastLegendIndex = idx;

                  if (isDbl) {
                    const current = chart.$highlightIndex;
                    const newIndex = current === idx ? null : idx;
                    chart.$highlightIndex = newIndex;
                    chart.data.datasets.forEach((ds, di) => {
                      if (ds.$isTotalLine) return;
                      const base = colorFor(ds.label, di);
                      const active = (newIndex == null) || (di === newIndex);
                      ds.borderColor = active ? base : addAlpha(base, 0.2);
                      ds.backgroundColor = active ? addAlpha(base, 0.78) : addAlpha(base, 0.12);
                    });
                    chart.update();
                    return;
                  }

                  const vis = chart.isDatasetVisible(idx);
                  chart.setDatasetVisibility(idx, !vis);
                  chart.update();
                } catch (err) {

                }
              },
              labels: {
                // 压缩图例：小色点 + 紧凑间距，类型多时自动换行，保证全部类型可见
                usePointStyle: true,
                boxWidth: 9,
                boxHeight: 9,
                padding: 12,
                font: { size: 12 }
              }
            },
            title: {
              display: !!opts.title,
              text: opts.title || '',
              color: '#374151',
              font: {
                size: 16,
                weight: 'bold'
              },
              padding: {
                top: 10,
                bottom: 20
              }
            },
            tooltip: {
              enabled: true,
              callbacks: {
                title: function (tooltipItems) {
                  // 将日期格式化为 YYYY年MM月DD日
                  if (tooltipItems && tooltipItems.length > 0) {
                    const dataIndex = tooltipItems[0].dataIndex;
                    const originalLabel = safeLabels[dataIndex];

                    // 检查是否是完整的 YYYY-MM-DD 格式
                    if (originalLabel && /^\d{4}-\d{2}-\d{2}$/.test(originalLabel)) {
                      const [year, month, day] = originalLabel.split('-');
                      return `${year}年${month}月${day}日`;
                    }

                    // 如果不是完整格式,尝试补全
                    const label = tooltipItems[0].label;
                    return label || '';
                  }
                  return '';
                },
                label: function (context) {
                  const label = context.dataset.label || '';
                  const value = context.parsed.y || 0;
                  return `${label}: ${value}`;
                }
              }
            }
          },
          scales: {
            x: {
              stacked: true,
              grid: {
                display: false
              },
              ticks: {
                // 逐日展示：不跳过任何日期标签；空间不足由 45° 旋转 + 压缩字号消化
                autoSkip: false,
                maxRotation: 45,
                minRotation: 45,
                font: { size: 11 },
                color: function (context) {
                  // 根据日期判断是否为周末,设置不同颜色
                  const index = context.index;
                  const originalLabel = safeLabels[index];

                  // 检查是否是完整的 YYYY-MM-DD 格式
                  if (originalLabel && /^\d{4}-\d{2}-\d{2}$/.test(originalLabel)) {
                    const date = new Date(originalLabel);
                    const dayOfWeek = date.getDay(); // 0=周日, 6=周六

                    // 周六周日用红色字体
                    if (dayOfWeek === 0 || dayOfWeek === 6) {
                      return '#EF4444'; // 红色 (Tailwind red-500)
                    }
                  }

                  // 工作日用默认灰色
                  return '#64748b'; // slate-500
                }
                // Labels are already formatted by formatDateLabels function
              }
            },
            y: {
              stacked: true,
              beginAtZero: true,
              max: fixedYMax,
              min: 0,
              title: {
                display: false  // Explicitly hide y-axis title (no labels)
              },
              grid: {
                color: 'rgba(15, 23, 42, 0.06)'
              },
              border: { display: false },
              ticks: {
                precision: 0 // 确保Y轴显示整数
              }
            }
          }
        }
      };

      // 创建图表实例
      const chart = new Chart(el.getContext('2d'), chartConfig);

      // rAF 驱动揭示进度：裁剪窗口匀速推进，动画结束关闭插件并做最终渲染，
      // 保证结束时呈现的图形与静态展示完全一致。图表被销毁/替换时循环自停。
      if (revealEnabled) {
        if (el._revealRaf) cancelAnimationFrame(el._revealRaf);
        chart.options.plugins.revealClip.startTime = performance.now();
        const frame = () => {
          if (window.Chart.getChart(el) !== chart) return;
          const revealOpts = chart.options.plugins.revealClip;
          const p = (performance.now() - revealOpts.startTime) / revealOpts.duration;
          if (p >= 1) {
            revealOpts.enabled = false;
            chart.render();
            el._revealRaf = null;
            return;
          }
          chart.render();
          el._revealRaf = requestAnimationFrame(frame);
        };
        el._revealRaf = requestAnimationFrame(frame);
      }

      // 隐藏加载状态
      if (loadingContainer) {
        loadingContainer.style.display = 'none';
      }

      // 添加响应式处理
      const handleResize = () => {
        try {
          // 检查 canvas 元素是否仍然存在
          const canvas = document.getElementById(canvasId);
          if (!canvas || !document.body.contains(canvas)) {
            // Canvas 已被移除，清理事件监听器
            window.removeEventListener('resize', handleResize);
            return;
          }
          chart.resize();
        } catch (err) {
          
        }
      };

      // 防止重复添加事件监听器
      window.removeEventListener('resize', handleResize);
      window.addEventListener('resize', handleResize);

      // 存储清理函数
      el._chartCleanup = () => {
        if (el._revealRaf) cancelAnimationFrame(el._revealRaf);
        window.removeEventListener('resize', handleResize);
        try { chart.destroy(); } catch (_) { }
      };

      return chart;

    } catch (error) {
      

      // 隐藏加载状态并显示错误
      const loadingContainer = document.getElementById(`${canvasId}-loading`);
      if (loadingContainer) {
        loadingContainer.style.display = 'none';
      }

      const el = document.getElementById(canvasId);
      if (el && el.parentElement) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'chart-error';
        errorDiv.textContent = '图表渲染失败';
        errorDiv.style.padding = '20px';
        errorDiv.style.textAlign = 'center';
        errorDiv.style.color = '#e53e3e';
        errorDiv.style.backgroundColor = '#fed7d7';
        errorDiv.style.borderRadius = '8px';
        errorDiv.style.marginTop = '10px';
        el.parentElement.appendChild(errorDiv);
      }
    }
  }

  window.StatsPlugins = {
    buildDayLabels,
    buildTopEntitiesByCount,
    buildDailySeriesForEntities,
    buildStackedByTypePerDay,
    buildStacksFromDailyStats,
    renderSmoothMultiLineChart,
    renderStackedBarChart
  };
})();
