// 简易国际化与类型标签工具
// 提供：根据数值ID或英文/中文标识返回本地化标签；统一图表字体

(function(){
  const fallbackMapZh = {
    'home-visit': '入户',
    'trial-teaching': '试教',
    'review': '评审',
    'review-record': '评审记录',
    'half-home-visit': '半次入户',
    'group-activity': '集体活动',
    'psychological-counseling': '心理咨询',
    'online-tutoring': '线上辅导',
    'offline-tutoring': '线下辅导',
    'unclassified': '未分类'
  };

  const fallbackMapEn = {
    '入户': 'home visit',
    '试教': 'trial teaching',
    '评审': 'review',
    '评审记录': 'review record',
    '半次入户': 'half home visit',
    '集体活动': 'group activity',
    '心理咨询': 'psychological counseling',
    '线上辅导': 'online tutoring',
    '线下辅导': 'offline tutoring',
    '未分类': 'unclassified'
  };

  function normalize(val){
    const raw = String(val == null ? '' : val).trim();
    if (!raw) return '';
    return raw;
  }

  function isNumericId(raw){
    const num = Number(raw);
    return !isNaN(num) && /^\d+$/.test(raw);
  }

  function mapByStore(raw){
    try {
      if (isNumericId(raw) && window.ScheduleTypesStore && typeof window.ScheduleTypesStore.getById === 'function') {
        const found = window.ScheduleTypesStore.getById(Number(raw));
        if (found) return found.description || found.name || String(raw);
      }
    } catch(e) {}
    return null;
  }

  function translateFallback(raw, locale){
    const key = raw.toLowerCase();
    if (locale === 'zh-CN') {
      return fallbackMapZh[key] || raw;
    }
    if (locale === 'en-US') {
      // 若原文本是中文则转英文
      return fallbackMapEn[raw] || raw;
    }
    return raw;
  }

  function getTypeLabelLocalized(value, locale){
    const raw = normalize(value);
    if (!raw) return locale === 'en-US' ? 'unclassified' : '未分类';
    const byStore = mapByStore(raw);
    if (byStore) return byStore;
    return translateFallback(raw, locale || 'zh-CN');
  }

  function getCssVar(name, fallback){
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback || '';
    } catch(e) {
      return fallback || '';
    }
  }

  function applyChartFont(){
    try {
      const family = getCssVar('--chart-font-family', 'Source Han Sans CN, Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif');
      const sizeVar = getCssVar('--chart-font-size', '12');
      const weightVar = getCssVar('--chart-font-weight', '500');
      const sizeNum = Number(String(sizeVar).trim());
      if (window.Chart && window.Chart.defaults && window.Chart.defaults.font) {
        window.Chart.defaults.font.family = family;
        window.Chart.defaults.font.weight = String(weightVar || '500'); // Medium视觉权重
        if (!isNaN(sizeNum) && sizeNum > 0) {
          window.Chart.defaults.font.size = sizeNum;
        }
        window.Chart.defaults.color = getCssVar('--text-color', '#1F2937');
      }
    } catch(e) {}
  }

  window.i18nUtils = {
    getTypeLabelLocalized,
    applyChartFont
  };
})();
