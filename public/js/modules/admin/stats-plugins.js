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

  // 现代化配色方案 - 与 admin-statistics.css 保持一致
  // 主色: #2ECC71 (Green)
  // 辅色: #3498DB (Blue), #9B59B6 (Purple), #F1C40F (Yellow), #E74C3C (Red), #1ABC9C (Teal)
  const ACCESSIBLE_PALETTE = [
    '#2ECC71', // Green (Primary)
    '#3498DB', // Blue
    '#9B59B6', // Purple
    '#F1C40F', // Yellow
    '#E74C3C', // Red
    '#1ABC9C', // Teal
    '#E67E22', // Orange
    '#34495E', // Navy
    '#95A5A6', // Gray
    '#16A085'  // Dark Teal
  ];

  // 全局配置 Chart.js 默认字体
  try {
    // 优先使用 Inter，其次是系统字体
    const chartFont = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
    if (window.Chart && Chart.defaults) {
      Chart.defaults.font.family = chartFont;
      Chart.defaults.color = '#64748b'; // slate-500
      Chart.defaults.scale.grid.color = '#f1f5f9'; // slate-100
      Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(30, 41, 59, 0.9)'; // slate-800
      Chart.defaults.plugins.tooltip.padding = 10;
      Chart.defaults.plugins.tooltip.cornerRadius = 8;
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

  function buildStackedByTypePerDay(rows, dayLabels) {
    const typeSet = new Set();
    const dayTypeCount = dayLabels.map(() => ({}));

    function mapTypeLabel(t) {
      const raw = String(t || '').trim();
      if (!raw) return '未分类';
      const num = Number(raw);
      const isId = !isNaN(num) && /^\d+$/.test(raw);
      if (isId && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
        const found = window.ScheduleTypesStore.getById(num);
        if (found) return found.description || found.name || String(num);
      }
      return raw;
    }

    rows.forEach(r => {
      const iso = ensureISO(r && r.date);
      const idx = dayLabels.indexOf(iso);
      if (idx === -1) return;
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
      data: sanitizeArray(s.data, clampMax),
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

  function renderStackedBarChart(canvasId, labels, stacks, opts = {}) {
    try {
      // 检查必要元素和依赖
      const el = document.getElementById(canvasId);
      if (!el) {
        return;
      }

      // 检查Chart.js是否加载
      if (typeof window.Chart === 'undefined') {
        console.error('renderStackedBarChart: Chart.js is not loaded');
        // 显示错误提示
        const parent = el.parentElement;
        if (parent) {
          const errorDiv = document.createElement('div');
          errorDiv.className = 'chart-error';
          errorDiv.textContent = '图表加载失败，请刷新页面';
          errorDiv.style.padding = '20px';
          errorDiv.style.textAlign = 'center';
          errorDiv.style.color = '#666';
          parent.appendChild(errorDiv);
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

      // 计算异常值边界
      const clampMax = computeClampMaxFromSeries(normalizedStacks);

      const datasets = normalizedStacks.map((s, i) => ({
        label: s.label,
        data: sanitizeArray(s.data, clampMax),
        backgroundColor: colorFor(s.label, i),
        borderColor: colorFor(s.label, i),
        borderWidth: 1,
        barPercentage: 0.85,
        categoryPercentage: 0.9
      }));

      // 可选：添加总计折线图叠加
      if (opts.showTotalLine) {
        console.log('[Stats-Plugins] showTotalLine 已启用，准备添加蓝色虚线折线图');

        // 计算每日总数
        const totalPerDay = formattedLabels.map((_, dayIdx) => {
          return normalizedStacks.reduce((sum, stack) => sum + (stack.data[dayIdx] || 0), 0);
        });

        // 美观的渐变蓝色（带透明度）
        const lineColor = 'rgba(59, 130, 246, 0.85)';  // 蓝色，85%透明度
        const pointColor = 'rgba(59, 130, 246, 1)';     // 实心点

        console.log('[Stats-Plugins] 折线图配置:', {
          颜色: lineColor,
          虚线样式: [8, 4],
          光滑度: 0.4,
          数据点数: totalPerDay.length
        });

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
          order: 0,                        // 折线显示在柱状图上方
          z: 10                            // 确保层级最高
        });
      }

      // 创建图表配置
      const chartConfig = {
        type: 'bar',
        data: {
          labels: formattedLabels,
          datasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: opts.animation === false ? false : { duration: 500 },
          interaction: {
            mode: opts.interactionMode || 'index',
            intersect: false
          },
          plugins: {
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
                      const base = ds.backgroundColor;
                      if (newIndex == null) {
                        ds.backgroundColor = base;
                        ds.borderColor = base;
                      } else if (di === newIndex) {
                        ds.backgroundColor = base;
                        ds.borderColor = base;
                      } else {
                        const dim = addAlpha(base, 0.25);
                        ds.backgroundColor = dim;
                        ds.borderColor = dim;
                      }
                    });
                    chart.update();
                    return;
                  }

                  const vis = chart.isDatasetVisible(idx);
                  chart.setDatasetVisibility(idx, !vis);
                  chart.update();
                } catch (err) {
                  console.error('Error handling legend click:', err);
                }
              },
              labels: {
                usePointStyle: true,
                padding: 20
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
              backgroundColor: 'rgba(0, 0, 0, 0.7)',
              titleColor: '#fff',
              bodyColor: '#fff',
              borderColor: 'rgba(255, 255, 255, 0.2)',
              borderWidth: 1,
              padding: 10,
              cornerRadius: 6,
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
                autoSkip: true,
                maxRotation: 45,
                minRotation: 45,
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
              suggestedMax: clampMax,
              min: 0,
              title: {
                display: false  // Explicitly hide y-axis title (no labels)
              },
              grid: {
                color: 'rgba(0,0,0,0.08)'
              },
              ticks: {
                precision: 0 // 确保Y轴显示整数
              }
            }
          }
        }
      };

      // 创建图表实例
      const chart = new Chart(el.getContext('2d'), chartConfig);

      // 隐藏加载状态
      if (loadingContainer) {
        loadingContainer.style.display = 'none';
      }

      // 添加响应式处理
      const handleResize = () => {
        try {
          chart.resize();
        } catch (err) {
          console.error('Error resizing chart:', err);
        }
      };

      // 防止重复添加事件监听器
      window.removeEventListener('resize', handleResize);
      window.addEventListener('resize', handleResize);

      // 存储清理函数
      el._chartCleanup = () => {
        window.removeEventListener('resize', handleResize);
        try { chart.destroy(); } catch (_) { }
      };

      return chart;

    } catch (error) {
      console.error('Error rendering stacked bar chart:', error);

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
    renderSmoothMultiLineChart,
    renderStackedBarChart
  };
})();
