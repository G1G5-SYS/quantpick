/* ============================================================================
 * QuantPick — 条件选股引擎 (Screener Engine)
 * 支持 AND / OR / NOT 逻辑、条件分组、数值/枚举/文本三类条件,
 * 并支持基于历史快照的评估(供回测使用,避免未来数据)。
 * ========================================================================== */
(function (root) {
  'use strict';
  const D = root.QP.data;

  /* ---------------------------- 条件字段定义 ---------------------------- */
  const FIELDS = [
    // —— 行情条件 ——
    { key: 'price', label: '最新价', cat: '行情', type: 'num', unit: '元' },
    { key: 'chgPct', label: '涨跌幅', cat: '行情', type: 'num', unit: '%' },
    { key: 'volume', label: '成交量', cat: '行情', type: 'num', unit: '手' },
    { key: 'amount', label: '成交额', cat: '行情', type: 'num', unit: '元' },
    { key: 'turnover', label: '换手率', cat: '行情', type: 'num', unit: '%' },
    { key: 'amplitude', label: '振幅', cat: '行情', type: 'num', unit: '%' },
    { key: 'volRatio', label: '量比', cat: '行情', type: 'num' },
    { key: 'mcap', label: '总市值', cat: '行情', type: 'num', unit: '元' },
    { key: 'fcap', label: '流通市值', cat: '行情', type: 'num', unit: '元' },
    { key: 'pe', label: '市盈率(PE)', cat: '行情', type: 'num' },
    { key: 'pb', label: '市净率(PB)', cat: '行情', type: 'num' },
    { key: 'dvYield', label: '股息率', cat: '行情', type: 'num', unit: '%' },
    { key: 'upStreak', label: '连涨天数', cat: '行情', type: 'num', unit: '天' },
    { key: 'downStreak', label: '连跌天数', cat: '行情', type: 'num', unit: '天' },
    // —— 技术条件 ——
    { key: 'aboveMA20', label: '收盘价 > MA20', cat: '技术', type: 'enum', values: ['是', '否'] },
    { key: 'aboveMA60', label: '收盘价 > MA60', cat: '技术', type: 'enum', values: ['是', '否'] },
    { key: 'crossMA5_20', label: 'MA5 上穿 MA20', cat: '技术', type: 'enum', values: ['是', '否'] },
    { key: 'crossMA20_60', label: 'MA20 上穿 MA60', cat: '技术', type: 'enum', values: ['是', '否'] },
    { key: 'macdCross', label: 'MACD 金叉', cat: '技术', type: 'enum', values: ['是', '否'] },
    { key: 'kdjCross', label: 'KDJ 金叉', cat: '技术', type: 'enum', values: ['是', '否'] },
    { key: 'rsi', label: 'RSI(14)', cat: '技术', type: 'num' },
    { key: 'breakout20', label: '突破20日新高', cat: '技术', type: 'enum', values: ['是', '否'] },
    { key: 'breakdown20', label: '跌破20日新低', cat: '技术', type: 'enum', values: ['是', '否'] },
    { key: 'volBurst', label: '成交量 > 5日均量×N', cat: '技术', type: 'num' },
    // —— 基本面条件 ——
    { key: 'revYoY', label: '营收同比增长', cat: '基本面', type: 'num', unit: '%' },
    { key: 'npYoY', label: '净利润同比增长', cat: '基本面', type: 'num', unit: '%' },
    { key: 'grossMargin', label: '毛利率', cat: '基本面', type: 'num', unit: '%' },
    { key: 'netMargin', label: '净利率', cat: '基本面', type: 'num', unit: '%' },
    { key: 'roe', label: 'ROE', cat: '基本面', type: 'num', unit: '%' },
    { key: 'debtRatio', label: '资产负债率', cat: '基本面', type: 'num', unit: '%' },
    { key: 'ocf', label: '经营现金流', cat: '基本面', type: 'num', unit: '亿' },
    { key: 'growYears', label: '盈利连续增长年数', cat: '基本面', type: 'num', unit: '年' },
    // —— 资金条件 ——
    { key: 'mainNet', label: '主力资金净流入', cat: '资金', type: 'num', unit: '元' },
    { key: 'mainNetPct', label: '主力净流入占比', cat: '资金', type: 'num', unit: '%' },
    { key: 'holderChgPct', label: '股东户数变化', cat: '资金', type: 'num', unit: '%' },
    { key: 'northChgPct', label: '北向资金变化', cat: '资金', type: 'num', unit: '%' },
    // —— 分类条件 ——
    { key: 'industry', label: '所属行业', cat: '分类', type: 'str' },
    { key: 'concept', label: '所属概念', cat: '分类', type: 'str' },
    { key: 'market', label: '市场', cat: '分类', type: 'enum', values: ['沪主板', '深主板', '创业板', '科创板', '北交所'] },
    { key: 'isST', label: '是否ST', cat: '分类', type: 'enum', values: ['是', '否'] },
    { key: 'isSuspended', label: '是否停牌', cat: '分类', type: 'enum', values: ['是', '否'] },
    { key: 'listYear', label: '上市年份', cat: '分类', type: 'num', unit: '年' }
  ];

  const FIELD_MAP = {};
  FIELDS.forEach(f => { FIELD_MAP[f.key] = f; });

  const NUM_OPS = [
    { v: '>', label: '大于' }, { v: '>=', label: '大于等于' },
    { v: '<', label: '小于' }, { v: '<=', label: '小于等于' },
    { v: '=', label: '等于' }, { v: '!=', label: '不等于' },
    { v: 'between', label: '介于' }
  ];
  const ENUM_OPS = [{ v: '=', label: '等于' }, { v: '!=', label: '不等于' }];
  const STR_OPS = [{ v: 'contains', label: '包含' }, { v: 'notContains', label: '不包含' }];

  function opsOf(field) {
    if (!field) return NUM_OPS;
    if (field.type === 'enum') return ENUM_OPS;
    if (field.type === 'str') return STR_OPS;
    return NUM_OPS;
  }

  /* ---------------------------- 取值 ---------------------------- */
  // hist: {i, date} 提供历史快照(回测);为空则取当前值
  function getValue(stock, key, hist) {
    const q = stock.quote, ind = stock.ind || {}, kl = stock.kline || [];
    const fin = stock.fin || {};
    if (!hist) {
      const hasInd = !!(ind.ma20 && ind.ma20.length);
      const lastI = kl.length - 1;
      switch (key) {
        case 'price': return q.price;
        case 'chgPct': return q.chgPct;
        case 'volume': return q.volume;
        case 'amount': return q.amount;
        case 'turnover': return q.turnover;
        case 'amplitude': return q.amplitude;
        case 'volRatio': return q.volRatio;
        case 'mcap': return q.mcap;
        case 'fcap': return q.fcap;
        case 'pe': return q.pe;
        case 'pb': return q.pb;
        case 'dvYield': return q.dvYield;
        case 'upStreak': return q.upStreak;
        case 'downStreak': return q.downStreak;
        case 'rsi': return hasInd ? ind.rsi[ind.rsi.length - 1] : null;
        case 'volBurst': return (hasInd && q.volume != null) ? q.volume / (ind.volMa5[lastI] || 1) : null;
        case 'revYoY': return fin.revYoY != null ? fin.revYoY : q.revYoY;
        case 'npYoY': return fin.npYoY;
        case 'grossMargin': return fin.annual && fin.annual.length ? fin.annual[fin.annual.length - 1].grossMargin : null;
        case 'netMargin': return fin.annual && fin.annual.length ? fin.annual[fin.annual.length - 1].netMargin : null;
        case 'roe': return fin.annual && fin.annual.length ? fin.annual[fin.annual.length - 1].roe : (q.roe != null ? q.roe : null);
        case 'debtRatio': return fin.annual && fin.annual.length ? fin.annual[fin.annual.length - 1].debtRatio : null;
        case 'ocf': return fin.annual && fin.annual.length ? fin.annual[fin.annual.length - 1].ocf : null;
        case 'growYears': return fin.growYears;
        case 'mainNet': return q.mainNet;
        case 'mainNetPct': return q.mainNetPct != null ? q.mainNetPct : (stock.fundFlow ? stock.fundFlow.mainNetPct : null);
        case 'holderChgPct': return stock.shareholders ? stock.shareholders.holderChgPct : null;
        case 'northChgPct': return stock.fundFlow ? stock.fundFlow.northChgPct : null;
        case 'industry': return stock.industry;
        case 'concept': return (stock.concepts || []).join(' ');
        case 'market': return stock.market;
        case 'isST': return stock.status === 'ST' ? '是' : '否';
        case 'isSuspended': return stock.status === '停牌' ? '是' : '否';
        case 'listYear': return stock.listDate ? +stock.listDate.slice(0, 4) : null;
        case 'aboveMA20': return hasInd ? (q.price > ind.ma20[ind.ma20.length - 1] ? '是' : '否') : null;
        case 'aboveMA60': return hasInd ? (q.price > ind.ma60[ind.ma60.length - 1] ? '是' : '否') : null;
        case 'crossMA5_20': return hasInd ? (crossUp(ind.ma5, ind.ma20, ind.ma20.length - 1) ? '是' : '否') : null;
        case 'crossMA20_60': return hasInd ? (crossUp(ind.ma20, ind.ma60, ind.ma20.length - 1) ? '是' : '否') : null;
        case 'macdCross': return hasInd ? (crossUp(ind.dif, ind.dea, ind.dif.length - 1) ? '是' : '否') : null;
        case 'kdjCross': return hasInd ? (crossUp(ind.kdjK, ind.kdjD, ind.kdjK.length - 1) ? '是' : '否') : null;
        case 'breakout20': return (hasInd && q.high60 != null) ? (q.price >= q.high60 ? '是' : '否') : null;
        case 'breakdown20': {
          if (!kl.length) return null;
          const lo20 = Math.min.apply(null, kl.slice(-20).map(b => b.low));
          return q.price <= lo20 ? '是' : '否';
        }
      }
      return null;
    }

    // —— 历史快照(回测) ——
    if (!kl[hist.i]) return null;
    const i = hist.i;
    const close = kl[i].close, open = kl[i].open, high = kl[i].high, low = kl[i].low;
    const prevClose = i > 0 ? kl[i - 1].close : close;
    const chgPct = (close - prevClose) / prevClose * 100;
    const volume = kl[i].volume, amount = kl[i].amount;
    const mcap = +(close * stock.totalShares * 1e8).toFixed(0);
    const fcap = Math.round(mcap * stock.floatPct);
    const turnover = +(volume * 100 / fcap * 100).toFixed(2);
    const amplitude = +((high - low) / prevClose * 100).toFixed(2);
    const volRatio = +(volume / (ind.volMa5[i] || volume)).toFixed(2);
    const finAt = histFin(stock, hist.date);

    switch (key) {
      case 'price': return close;
      case 'chgPct': return +chgPct.toFixed(2);
      case 'volume': return volume;
      case 'amount': return amount;
      case 'turnover': return turnover;
      case 'amplitude': return amplitude;
      case 'volRatio': return volRatio;
      case 'mcap': return mcap;
      case 'fcap': return fcap;
      case 'pe': return stock.quote.pe;
      case 'pb': return stock.quote.pb;
      case 'dvYield': return stock.quote.dvYield;
      case 'upStreak': return histStreak(stock, i, 1);
      case 'downStreak': return histStreak(stock, i, -1);
      case 'rsi': return ind.rsi[i];
      case 'volBurst': return volume / (ind.volMa5[i] || 1);
      case 'revYoY': return finAt.revYoY;
      case 'npYoY': return finAt.npYoY;
      case 'grossMargin': return finAt.grossMargin;
      case 'netMargin': return finAt.netMargin;
      case 'roe': return finAt.roe;
      case 'debtRatio': return finAt.debtRatio;
      case 'ocf': return finAt.ocf;
      case 'growYears': return stock.fin.growYears;
      case 'mainNet': return 0; // 简化:历史资金流不提供
      case 'mainNetPct': return 0;
      case 'holderChgPct': return stock.shareholders.holderChgPct;
      case 'northChgPct': return stock.fundFlow.northChgPct;
      case 'industry': return stock.industry;
      case 'concept': return stock.concepts.join(' ');
      case 'market': return stock.market;
      case 'isST': return stock.status === 'ST' ? '是' : '否';
      case 'isSuspended': return stock.status === '停牌' ? '是' : '否';
      case 'listYear': return +stock.listDate.slice(0, 4);
      case 'aboveMA20': return close > ind.ma20[i] ? '是' : '否';
      case 'aboveMA60': return close > ind.ma60[i] ? '是' : '否';
      case 'crossMA5_20': return crossUp(ind.ma5, ind.ma20, i) ? '是' : '否';
      case 'crossMA20_60': return crossUp(ind.ma20, ind.ma60, i) ? '是' : '否';
      case 'macdCross': return crossUp(ind.dif, ind.dea, i) ? '是' : '否';
      case 'kdjCross': return crossUp(ind.kdjK, ind.kdjD, i) ? '是' : '否';
      case 'breakout20': return close >= Math.max.apply(null, kl.slice(i - 19, i + 1).map(b => b.high)) ? '是' : '否';
      case 'breakdown20': return close <= Math.min.apply(null, kl.slice(i - 19, i + 1).map(b => b.low)) ? '是' : '否';
    }
    return null;
  }

  function crossUp(a, b, i) {
    if (i <= 0) return false;
    const x = a[i], y = b[i], px = a[i - 1], py = b[i - 1];
    if (x == null || y == null || px == null || py == null) return false;
    return x > y && px <= py;
  }

  function histStreak(stock, i, dir) {
    let cnt = 0;
    for (let j = i; j > 0; j--) {
      const up = stock.kline[j].close >= stock.kline[j - 1].close;
      if (dir === 1 && up) cnt++;
      else if (dir === -1 && !up) cnt++;
      else break;
    }
    return cnt;
  }

  // 历史财务快照:取报告期公布日 <= 指定日期的最新季度
  const Q_PUB = {
    '2024Q1': '2024-04-30', '2024Q2': '2024-08-31', '2024Q3': '2024-10-31', '2024Q4': '2025-04-30',
    '2025Q1': '2025-04-30', '2025Q2': '2025-08-31', '2025Q3': '2025-10-31', '2025Q4': '2026-04-30',
    '2026Q1': '2026-04-30', '2026Q2': '2026-08-31'
  };

  function histFin(stock, date) {
    const qs = (stock.fin && stock.fin.quarterly) || [];
    if (!qs.length) {
      return { revYoY: null, npYoY: null, grossMargin: null, netMargin: null, roe: null, debtRatio: null, ocf: null };
    }
    let idx = 0;
    for (let i = 0; i < qs.length; i++) {
      if (Q_PUB[qs[i].quarter] && Q_PUB[qs[i].quarter] <= date) idx = i;
    }
    const q = qs[idx];
    // 同比:优先使用字段自带同比,否则用同季度一年前(索引 -4)计算
    const prev = qs[Math.max(0, idx - 4)];
    const revYoY = q.revenueYoY != null ? q.revenueYoY
      : (prev && prev.revenue ? +((q.revenue / prev.revenue - 1) * 100).toFixed(2) : null);
    const npYoY = q.netProfitYoY != null ? q.netProfitYoY
      : (prev && prev.netProfit ? +((q.netProfit / prev.netProfit - 1) * 100).toFixed(2) : null);
    const annual = (stock.fin && stock.fin.annual && stock.fin.annual.length) ? stock.fin.annual[stock.fin.annual.length - 1] : {};
    return {
      revYoY: revYoY, npYoY: npYoY,
      grossMargin: q.grossMargin != null ? q.grossMargin : null,
      netMargin: q.netMargin != null ? q.netMargin : null,
      roe: q.roe != null ? +(q.roe * 4).toFixed(2) : null, // 单季 ROE 年化近似
      debtRatio: annual.debtRatio != null ? annual.debtRatio : null,
      ocf: annual.ocf != null ? annual.ocf : null
    };
  }

  /* ---------------------------- 条件评估 ---------------------------- */
  function evalCond(stock, cond, hist) {
    const f = FIELD_MAP[cond.field];
    if (!f) return false;
    const v = getValue(stock, cond.field, hist);
    if (v === null || v === undefined || v === '--') return false;
    if (f.type === 'num') {
      const a = +cond.v1, b = +cond.v2;
      if (isNaN(a)) return false;
      switch (cond.op) {
        case '>': return v > a;
        case '>=': return v >= a;
        case '<': return v < a;
        case '<=': return v <= a;
        case '=': return Math.abs(v - a) < 1e-9;
        case '!=': return Math.abs(v - a) >= 1e-9;
        case 'between': return v >= a && v <= b;
      }
      return false;
    }
    if (f.type === 'enum') {
      const want = cond.v1;
      if (cond.op === '!=') return v !== want;
      return v === want;
    }
    // str
    const needle = (cond.v1 || '').toLowerCase();
    if (!needle) return true;
    if (cond.op === 'notContains') return String(v).toLowerCase().indexOf(needle) < 0;
    return String(v).toLowerCase().indexOf(needle) >= 0;
  }

  function evalGroup(stock, group, hist) {
    if (!group || !group.conds || !group.conds.length) return true;
    const results = group.conds.map(c => evalCond(stock, c, hist));
    if (group.logic === 'OR') return results.some(Boolean);
    if (group.logic === 'NOT') return !results.every(Boolean);
    return results.every(Boolean);
  }

  function evalStrategy(stock, strategy, hist) {
    if (!strategy || !strategy.groups || !strategy.groups.length) return false;
    const results = strategy.groups.map(g => evalGroup(stock, g, hist));
    if (strategy.logic === 'OR') return results.some(Boolean);
    return results.every(Boolean);
  }

  function run(strategy, stocks) {
    return stocks.filter(s => evalStrategy(s, strategy, null));
  }

  /* ---------------------------- 描述 & 校验 ---------------------------- */
  function condDesc(cond) {
    const f = FIELD_MAP[cond.field];
    if (!f) return '未知条件';
    const opLabel = (opsOf(f).find(o => o.v === cond.op) || {}).label || cond.op;
    if (f.type === 'num') {
      if (cond.op === 'between') return f.label + ' 介于 ' + cond.v1 + ' ~ ' + cond.v2 + (f.unit || '');
      return f.label + ' ' + opLabel + ' ' + cond.v1 + (f.unit || '');
    }
    return f.label + ' ' + opLabel + '「' + cond.v1 + '」';
  }

  function validateCond(cond) {
    const f = FIELD_MAP[cond.field];
    if (!f) return '条件字段无效';
    if (f.type === 'num') {
      if (cond.op === 'between') {
        if (isNaN(+cond.v1) || isNaN(+cond.v2)) return '请输入有效数字';
        if (+cond.v1 > +cond.v2) return '下限不能大于上限';
      } else if (isNaN(+cond.v1)) {
        return '请输入有效数字';
      }
    }
    if (f.type === 'str' && !cond.v1) return '请输入关键词';
    return '';
  }

  function newCond(fieldKey, defaults) {
    const f = FIELD_MAP[fieldKey];
    const c = {
      id: 'c' + Math.random().toString(36).slice(2, 9),
      field: fieldKey,
      op: f.type === 'num' ? '>' : '=',
      v1: '', v2: ''
    };
    if (defaults && defaults.op) c.op = defaults.op;
    if (defaults && defaults.v1 !== undefined) c.v1 = defaults.v1;
    if (defaults && defaults.v2 !== undefined) c.v2 = defaults.v2;
    return c;
  }

  function newGroup() {
    return { id: 'g' + Math.random().toString(36).slice(2, 9), logic: 'AND', conds: [] };
  }

  function newStrategy() {
    return { id: 's' + Date.now().toString(36), name: '', logic: 'AND', groups: [newGroup()] };
  }

  /* ---------------------------- 导出 ---------------------------- */
  root.QP.screener = {
    FIELDS, FIELD_MAP, NUM_OPS, ENUM_OPS, STR_OPS,
    opsOf, getValue, evalCond, evalGroup, evalStrategy, run,
    condDesc, validateCond, newCond, newGroup, newStrategy,
    histFin, Q_PUB
  };
})(typeof window !== 'undefined' ? window : globalThis);
