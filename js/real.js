/* ============================================================================
 * QuantPick — 真实数据层 (Real Data Layer)
 * 数据源:东方财富公开接口(经本地 server.js 代理)
 * - 行情/指数:约 3~5 秒缓存,前端 5 秒轮询 = 准实时
 * - K线/资金流/财务/新闻:懒加载 + 长缓存
 * - 覆写 QP.data 的同步接口,使现有渲染代码零改动读取真实数据;
 *   服务不可用时自动降级为 Mock 模式。
 * ========================================================================== */
(function (root) {
  'use strict';
  const D = root.QP.data;
  const API_BASE = 'api/';

  const store = {
    mode: 'mock',          // 'real' | 'mock'
    ready: false,
    source: '模拟数据(Mock)',
    lastUpdate: '',
    pool: D.pool,          // 精选关注池元数据(代码/名称/行业/概念)
    stocks: new Map(),     // 精选池行情对象(供选股/回测/详情)
    marketAll: { total: 0, list: [], byCode: new Map() }, // 全 A 股(约5900只)
    ranks: { up: [], down: [], amount: [], turnover: [], volratio: [] },
    ranksMap: new Map(),
    overview: null,
    indices: [],           // 指数(quote + kline 懒加载)
    _klineLoading: new Map(),
    _finLoading: new Map(),
    _ffLoading: new Map(),
    _newsLoading: new Map(),
    _divLoading: new Map(),
    _idxKLoading: new Map(),
    _loadingAllK: null,
    _loadingAllFin: null
  };

  /* 选股/回测使用的样本池(精选池;全市场技术选股需全市场K线,暂不提供) */
  function poolList() {
    return Array.from(store.stocks.values());
  }

  /* 任意代码定位行情对象:全市场列表 → 精选池 → 榜单;均无则创建临时对象 */
  function stockOf(code) {
    let st = store.marketAll.byCode.get(code) || store.stocks.get(code) || store.ranksMap.get(code);
    if (!st) {
      st = fullMarketObj({ code: code, name: code, price: null, industry: '其他' });
      st.py = code;
      store.marketAll.byCode.set(code, st);
      if (store.marketAll.list.indexOf(st) < 0) store.marketAll.list.push(st);
    }
    return st;
  }

  /* ------------------- 基础请求 ------------------- */
  async function api(path, timeout) {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), timeout || 15000);
    try {
      const r = await fetch(API_BASE + path, { signal: ctrl.signal });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.message) || '接口错误');
      return j.data;
    } finally { clearTimeout(tm); }
  }
  /* POST 版本(用于写入预测快照台账);同样返回 {ok,data} 中的 data */
  async function apiPost(path, body, timeout) {
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), timeout || 15000);
    try {
      const r = await fetch(API_BASE + path, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
      const j = await r.json();
      if (!j || !j.ok) throw new Error((j && j.message) || '接口错误');
      return j.data;
    } finally { clearTimeout(tm); }
  }

  /* ------------------- 元数据 ------------------- */
  function marketName(code) {
    if (/^688/.test(code)) return '科创板';
    if (/^(300|301)/.test(code)) return '创业板';
    if (/^(8|4|9)/.test(code)) return '北交所';
    if (/^6/.test(code)) return '沪主板';
    return '深主板';
  }
  function pyOf(name) {
    const n = D.pool.find(x => x.name === name);
    if (n) return n.py || '';
    return name.slice(0, 2);
  }
  function metaOf(code) {
    return store.pool.find(x => x.code === code) || {
      code: code, name: code, industry: '其他', concepts: ['其他'], size: '中', py: code
    };
  }

  /* ------------------- 行情对象构建 ------------------- */
  function createStock(meta) {
    const st = {
      code: meta.code,
      name: meta.name,
      py: meta.py || meta.code,
      market: marketName(meta.code),
      industry: meta.industry,
      concepts: meta.concepts || [],
      listDate: '',
      desc: meta.name + '(' + meta.code + ') 真实数据模式:行情/财务/资金/新闻来自东方财富公开接口;行业与概念为本地分类标注。',
      status: '正常',
      totalShares: null,
      floatPct: null,
      size: meta.size,
      quote: {
        price: null, chg: null, chgPct: null, open: null, high: null, low: null, prevClose: null,
        volume: 0, amount: 0, turnover: null, volRatio: null, amplitude: null,
        pe: null, pb: null, dvYield: null, ps: null,
        mcap: null, fcap: null,
        high52: null, low52: null, high60: null,
        upStreak: 0, downStreak: 0,
        limitUp: false, limitDown: false,
        eps: null, roe: null, revYoY: null, npYoY: null,
        mainNet: null, mainNetPct: null
      },
      kline: null, ind: null, fin: null, fundFlow: null,
      shareholders: null, news: null, dividends: null
    };
    return st;
  }

  function applyQuote(st, q) {
    if (!q) return;
    const qq = st.quote;
    qq.price = q.price; qq.chg = q.chg; qq.chgPct = q.chgPct;
    qq.open = q.open; qq.high = q.high; qq.low = q.low; qq.prevClose = q.prevClose;
    qq.volume = q.volume || 0; qq.amount = q.amount || 0;
    qq.turnover = q.turnover; qq.volRatio = q.volRatio; qq.amplitude = q.amplitude;
    qq.pe = q.pe; qq.pb = q.pb;
    qq.mcap = q.mcap; qq.fcap = q.fcap;
    qq.eps = q.eps; qq.roe = q.roe; qq.revYoY = q.revYoY;
    qq.mainNet = q.mainNet; qq.mainNetPct = q.mainNetPct;
    st.totalShares = q.totalShares;
    if (st.totalShares) st.floatPct = q.floatShares ? +(q.floatShares / st.totalShares).toFixed(4) : null;
    st.status = q.price == null ? '停牌' : (/ST/.test(st.name) ? 'ST' : '正常');
    if (q.price != null) {
      qq.limitUp = qq.chgPct >= 9.7; qq.limitDown = qq.chgPct <= -9.7;
    }
    // 名称以行情为准(东财),去除空格
    if (q.name) st.name = q.name.replace(/\s+/g, '');
  }

  /* ------------------- 初始化:拉全池行情 + 全市场 ------------------- */
  async function refreshQuotes() {
    const codes = store.pool.map(s => s.code).join(',');
    const qs = await api('quote?codes=' + codes);
    const qmap = {};
    qs.forEach(q => { qmap[q.code] = q; });
    store.pool.forEach(meta => {
      let st = store.stocks.get(meta.code);
      if (!st) { st = createStock(meta); store.stocks.set(meta.code, st); }
      applyQuote(st, qmap[meta.code]);
    });
    return qs.length;
  }

  async function refreshMarketAll() {
    let data;
    try {
      data = await api('market-all');
    } catch (e) {
      // 全市场列表暂不可用:回退展示精选池(页面仍可用)
      const list = poolList();
      store.marketAll = { total: list.length, list: list, byCode: store.stocks };
      return;
    }
    const byCode = new Map();
    const list = [];
    data.list.forEach(x => {
      // 复用已有对象(保留已加载的K线/财务/资金/新闻等详情数据),仅更新基础字段
      let obj = store.marketAll.byCode.get(x.code) || store.stocks.get(x.code) || store.ranksMap.get(x.code);
      if (obj) {
        obj.name = x.name || obj.name;
        obj.industry = x.industry || obj.industry;
        const q = obj.quote;
        if (x.price != null) {
          q.price = x.price; q.chg = x.chg; q.chgPct = x.chgPct;
          q.open = x.open; q.high = x.high; q.low = x.low; q.prevClose = x.prevClose;
          q.volume = x.volume; q.amount = x.amount;
          q.turnover = x.turnover; q.volRatio = x.volRatio; q.amplitude = x.amplitude;
          q.pe = x.pe; q.pb = x.pb; q.mcap = x.mcap; q.fcap = x.fcap;
          q.mainNet = x.mainNet; q.mainNetPct = x.mainNetPct;
        }
        if (x.totalShares) obj.totalShares = x.totalShares;
        if (x.price != null) obj.status = /ST/.test(obj.name) ? 'ST' : '正常';
        else if (obj.status === '正常') obj.status = '停牌';
      } else {
        obj = fullMarketObj(x);
      }
      byCode.set(x.code, obj);
      list.push(obj);
    });
    store.marketAll = { total: data.total, list: list, byCode: byCode };
  }

  async function refreshRanks() {
    const data = await api('ranks');
    const out = {};
    const ranksMap = new Map();
    Object.keys(data).forEach(k => {
      out[k] = data[k].map(x => {
        // 复用已有对象(保留详情数据)
        let obj = store.marketAll.byCode.get(x.code) || store.stocks.get(x.code) || store.ranksMap.get(x.code);
        if (obj) {
          const q = obj.quote;
          if (x.price != null) {
            q.price = x.price; q.chg = x.chg; q.chgPct = x.chgPct;
            q.high = x.high; q.low = x.low; q.prevClose = x.prevClose;
            q.volume = x.volume; q.amount = x.amount;
            q.turnover = x.turnover; q.volRatio = x.volRatio;
            q.pe = x.pe; q.pb = x.pb; q.mcap = x.mcap; q.fcap = x.fcap;
          }
        } else {
          obj = fullMarketObj(x);
        }
        ranksMap.set(obj.code, obj);
        return obj;
      });
    });
    store.ranks = out;
    store.ranksMap = ranksMap;
  }

  /* 由榜单/列表原始数据构建与精选池同构的对象(含 quote/status) */
  function fullMarketObj(x) {
    return {
      code: x.code, name: x.name, py: x.code, market: marketName(x.code),
      industry: x.industry || '其他', concepts: [], listDate: '',
      desc: x.name + '(' + x.code + ') 真实行情数据。',
      status: x.price == null ? '停牌' : (/ST/.test(x.name) ? 'ST' : '正常'),
      totalShares: x.totalShares, floatPct: null, size: '中',
      quote: Object.assign({}, x, { dvYield: null, high52: null, low52: null, high60: null, upStreak: 0, downStreak: 0, limitUp: false, limitDown: false, ps: null }),
      kline: null, ind: null, fin: null, fundFlow: null, shareholders: null, news: null, dividends: null
    };
  }

  async function refreshOverview() {
    store.overview = await api('overview');
  }

  /* 交易日历(真实交易日,含调休):供预测模块判定"生效交易日/是否锁定"。
     失败不致命——预测模块会回退到"周一~周五"启发式。 */
  let calendarLoading = null;
  async function refreshCalendar() {
    if (calendarLoading) return calendarLoading;
    calendarLoading = (async () => {
      try {
        const data = await api('calendar');
        if (typeof QP !== 'undefined' && QP.predict && QP.predict.setCalendar) {
          return QP.predict.setCalendar(data) ? QP.predict.calendarInfo() : null;
        }
        return null;
      } catch (e) { return null; } finally { calendarLoading = null; }
    })();
    return calendarLoading;
  }

  /* 预测快照台账:把服务端存储注入预测模块(未注入时预测模块纯本地运行)。
     预测基于全市场公开数据、与用户无关,故为全局共享台账。 */
  function bindSnapshotTransport() {
    if (typeof QP === 'undefined' || !QP.predict || !QP.predict.setSyncTransport) return false;
    QP.predict.setSyncTransport({
      pull: () => api('snapshots').then(d => (d && d.snapshots) || []),
      push: list => apiPost('snapshots', { snapshots: list }).then(d => (d && d.snapshots) || []),
      del: id => apiPost('snapshots/delete', { id: id }).then(d => (d && d.snapshots) || [])
    });
    return true;
  }
  /* 与服务端台账对账(离线时静默失败,保持本地可用) */
  async function hydrateSnapshots() {
    if (typeof QP === 'undefined' || !QP.predict) return null;
    bindSnapshotTransport();
    return QP.predict.hydrateSnapshots ? QP.predict.hydrateSnapshots() : null;
  }

  async function init() {
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 6000);
      let ping;
      try {
        const r = await fetch(API_BASE + 'ping', { signal: ctrl.signal });
        ping = await r.json();
      } finally { clearTimeout(tm); }
      if (!ping || !ping.ok) throw new Error('数据服务不可用');
      // 交易日历优先加载(约10KB,失败不阻塞):保证预测快照日期落在真实交易日上
      await refreshCalendar().catch(() => null);
      /* 预测快照台账对账:放到后台执行,不阻塞首屏(预测页在生成快照前会自行等待,带超时) */
      hydrateSnapshots().catch(() => null);
      // 分步加载:单步失败不致命,只有核心行情失败才降级 Mock
      const q = await refreshQuotes().catch(() => null);
      if (q == null) throw new Error('核心行情加载失败');
      await refreshMarketAll().catch(() => null);
      await refreshRanks().catch(() => null);
      await refreshOverview().catch(() => null);
      store.indices = await api('indices').catch(() => store.indices || []);
      store.mode = 'real';
      store.ready = true;
      store.source = '东方财富 · 准实时';
      applyOverrides();
      return true;
    } catch (e) {
      store.mode = 'mock';
      store.ready = false;
      store.source = '模拟数据(Mock)';
      return false;
    }
  }

  /* ------------------- 实时轮询刷新 ------------------- */
  let refreshing = false;
  async function refresh() {
    if (refreshing || store.mode !== 'real') return;
    refreshing = true;
    try {
      await Promise.all([
        refreshQuotes().catch(() => null),
        refreshMarketAll().catch(() => null),
        refreshRanks().catch(() => null),
        refreshOverview().catch(() => null),
        api('indices').then(d => {
          // 保留已加载的指数K线(供迷你图/回测基准)
          if (store.indices && store.indices.length) {
            d.forEach((x, i) => { if (store.indices[i] && store.indices[i].kline) x.kline = store.indices[i].kline; });
          }
          store.indices = d;
        }).catch(() => null)
      ]);
      store.lastUpdate = new Date().toLocaleString('zh-CN');
      D._setDataTime(store.lastUpdate + ' · 数据源:东方财富');
      return true;
    } catch (e) { return false; }
    finally { refreshing = false; }
  }

  /* ------------------- 懒加载:个股 K 线(本地缓存加速) ------------------- */
  const KLC = 'qp_kline_cache_v1';
  function klineToday() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function readKlineCache(code) {
    try {
      if (!root.localStorage) return null;
      const c = JSON.parse(root.localStorage.getItem(KLC) || 'null');
      if (c && c.d === klineToday() && c.m && c.m[code]) return c.m[code];
    } catch (e) { }
    return null;
  }
  let klcQueue = Promise.resolve(); // 串行化缓存写入,避免并发读改写竞争丢数据
  function writeKlineCache(code, bars) {
    klcQueue = klcQueue.then(() => {
      try {
        if (!root.localStorage) return;
        let c = JSON.parse(root.localStorage.getItem(KLC) || 'null') || { d: klineToday(), m: {} };
        if (c.d !== klineToday()) c = { d: klineToday(), m: {} };
        c.m[code] = bars;
        const keys = Object.keys(c.m);
        if (keys.length > 40) keys.slice(0, keys.length - 40).forEach(k => delete c.m[k]);
        root.localStorage.setItem(KLC, JSON.stringify(c));
      } catch (e) { }
    });
    return klcQueue;
  }
  function applyKline(st, bars) {
    st.kline = bars;
    st.ind = D.calcIndicators(bars);
    const n = bars.length;
    if (n > 1) {
      const qq = st.quote;
      const highs = bars.map(b => b.high), lows = bars.map(b => b.low);
      qq.high52 = Math.max.apply(null, highs.slice(-250));
      qq.low52 = Math.min.apply(null, lows.slice(-250));
      qq.high60 = Math.max.apply(null, highs.slice(-60));
      let up = 0, down = 0;
      for (let i = n - 1; i > 0; i--) {
        if (bars[i].close >= bars[i - 1].close) { up++; if (down) break; }
        else { down++; if (up) break; }
      }
      qq.upStreak = up > down ? up : 0;
      qq.downStreak = down >= up ? down : 0;
      const prev = bars[n - 1];
      if (qq.prevClose == null) qq.prevClose = prev.close;
    }
  }
  async function ensureKline(code, klt, fqt) {
    klt = klt || 101; fqt = fqt || 1;
    const st = stockOf(code);
    if (!st) return null;
    if (!st._k) st._k = {};
    const key = code + ':' + klt;
    if (st._k[key]) return st._k[key];
    if (klt === 101) {
      if (st.kline) { st._k[key] = st.kline; return st.kline; }
      // 本地缓存(当日有效):命中则秒开,后台刷新
      const cached = readKlineCache(code);
      if (cached && cached.length > 30) {
        applyKline(st, cached);
        st._k[key] = st.kline;
        api('kline?code=' + code + '&klt=101&fqt=1&lmt=320').then(data => {
          applyKline(st, data.bars);
          writeKlineCache(code, data.bars);
        }).catch(() => { });
        return st.kline;
      }
    }
    if (store._klineLoading.has(key)) return store._klineLoading.get(key);
    const p = api('kline?code=' + code + '&klt=' + klt + '&fqt=' + fqt + '&lmt=320')
      .then(data => {
        const bars = data.bars;
        st._k[key] = bars;
        if (klt === 101) {
          applyKline(st, bars);
          writeKlineCache(code, bars);
        }
        return bars;
      })
      .catch(e => { store._klineLoading.delete(key); throw e; });
    store._klineLoading.set(key, p);
    return p;
  }

  function ensureKlineAll(codes, onProgress) {
    if (store._loadingAllK) return store._loadingAllK;
    const list = (codes || Array.from(store.stocks.keys())).filter(c => {
      const st = store.stocks.get(c);
      return st && !st.kline;
    });
    let done = 0;
    const total = list.length;
    store._loadingAllK = (async () => {
      const CONC = 8;
      for (let i = 0; i < list.length; i += CONC) {
        await Promise.all(list.slice(i, i + CONC).map(c => ensureKline(c).catch(() => null)));
        done += Math.min(CONC, list.length - i);
        if (onProgress) onProgress(done, total);
      }
    })().finally(() => { store._loadingAllK = null; });
    return store._loadingAllK;
  }

  /* ------------------- 懒加载:财务 ------------------- */
  async function ensureFin(code) {
    const st = stockOf(code);
    if (!st) return null;
    if (st.fin) return st.fin;
    if (store._finLoading.has(code)) return store._finLoading.get(code);
    const p = api('fin?code=' + code).then(data => {
      const annual = data.annual.map(r => ({
        year: r.year, revenue: r.revenue != null ? +(r.revenue / 1e8).toFixed(2) : null, // 元 → 亿
        revenueYoY: r.revenueYoY,
        netProfit: r.netProfit != null ? +(r.netProfit / 1e8).toFixed(2) : null,
        netProfitYoY: r.netProfitYoY,
        kfProfit: null, grossMargin: r.grossMargin, netMargin: r.netMargin,
        roe: r.roe, roa: null, debtRatio: null, currentRatio: null, ocf: null,
        eps: r.eps, bps: r.bps, ocfps: r.ocfps
      }));
      const quarterly = data.quarterly.map(r => ({
        quarter: r.quarter, revenue: r.revenue != null ? +(r.revenue / 1e8).toFixed(2) : null,
        netProfit: r.netProfit != null ? +(r.netProfit / 1e8).toFixed(2) : null,
        grossMargin: r.grossMargin, netMargin: r.netMargin, roe: r.roe,
        revenueYoY: r.revenueYoY, netProfitYoY: r.netProfitYoY
      }));
      const latest = quarterly[0] || {};
      st.fin = {
        annual: annual, quarterly: quarterly, growYears: data.growYears,
        pe: st.quote.pe, pb: st.quote.pb, ps: null, dvYield: st.quote.dvYield,
        payout: null, roe: latest.roe != null ? latest.roe : null,
        debt: null,
        revYoY: latest.revenueYoY != null ? latest.revenueYoY : null,
        npYoY: latest.netProfitYoY != null ? latest.netProfitYoY : null
      };
      return st.fin;
    }).catch(e => { store._finLoading.delete(code); throw e; });
    store._finLoading.set(code, p);
    return p;
  }

  function ensureFinAll(codes, onProgress) {
    if (store._loadingAllFin) return store._loadingAllFin;
    const list = (codes || Array.from(store.stocks.keys())).filter(c => {
      const st = store.stocks.get(c);
      return st && !st.fin;
    });
    let done = 0;
    const total = list.length;
    store._loadingAllFin = (async () => {
      const CONC = 8;
      for (let i = 0; i < list.length; i += CONC) {
        await Promise.all(list.slice(i, i + CONC).map(c => ensureFin(c).catch(() => null)));
        done += Math.min(CONC, list.length - i);
        if (onProgress) onProgress(done, total);
      }
    })().finally(() => { store._loadingAllFin = null; });
    return store._loadingAllFin;
  }

  /* ------------------- 懒加载:资金流 ------------------- */
  async function ensureFflow(code) {
    const st = stockOf(code);
    if (!st) return null;
    if (st.fundFlow) return st.fundFlow;
    if (store._ffLoading.has(code)) return store._ffLoading.get(code);
    const p = api('fflow?code=' + code + '&days=20').then(days => {
      const last = days[days.length - 1];
      const sum5 = days.slice(-5).reduce((a, d) => a + d.mainNet, 0);
      st.fundFlow = {
        days: days.map(d => ({ date: d.date, mainNet: d.mainNet })),
        mainNet: last ? last.mainNet : null,
        mainNet5: sum5,
        mainNetPct: st.quote.amount ? +((last ? last.mainNet : 0) / st.quote.amount * 100).toFixed(2) : null,
        bigNet: last ? last.bigNet : null,
        superBigNet: last ? last.superNet : null,
        retailNet: last ? (last.smallNet + last.midNet) : null,
        northChgPct: null   // 北向数据源暂未接入
      };
      return st.fundFlow;
    }).catch(e => { store._ffLoading.delete(code); throw e; });
    store._ffLoading.set(code, p);
    return p;
  }

  /* ------------------- 懒加载:新闻 ------------------- */
  const NEG = /减持|诉讼|问询|风险|亏损|下滑|解禁|处罚|调查|低于预期|跌停/;
  const POS = /增持|回购|中标|增长|签约|净买入|新高|超预期|突破|获批|上调|盈利/;
  function sentimentOf(title) {
    if (NEG.test(title)) return '-';
    if (POS.test(title)) return '+';
    return '0';
  }
  function typeOf(title) {
    if (/减持|增持|回购|解禁|股东/.test(title)) return '股东';
    if (/财报|业绩|营收|净利|分红|季度/.test(title)) return '业绩';
    if (/问询|处罚|调查|诉讼/.test(title)) return '监管';
    if (/中标|签约|合作|订单/.test(title)) return '合作';
    if (/研报|评级|目标价/.test(title)) return '研报';
    return '资讯';
  }
  async function ensureNews(code) {
    const st = stockOf(code);
    if (!st) return [];
    if (st.news) return st.news;
    if (store._newsLoading.has(code)) return store._newsLoading.get(code);
    const p = api('news?code=' + code + '&kw=' + encodeURIComponent(st.name) + '&n=12')
      .then(items => {
        st.news = items.map(x => ({
          id: x.date + x.time + code,
          date: x.date, time: x.time, title: x.title, source: x.source || '东方财富',
          sentiment: sentimentOf(x.title), type: typeOf(x.title), url: x.url || '#'
        }));
        return st.news;
      }).catch(e => { store._newsLoading.delete(code); throw e; });
    store._newsLoading.set(code, p);
    return p;
  }

  /* ------------------- 懒加载:分红 ------------------- */
  async function ensureDividends(code) {
    const st = stockOf(code);
    if (!st) return [];
    if (st.dividends) return st.dividends;
    if (store._divLoading.has(code)) return store._divLoading.get(code);
    const p = api('dividend?code=' + code).then(items => {
      st.dividends = items.map(x => {
        let per10 = x.per10;
        if (per10 == null) {
          const m = String(x.plan || '').match(/10派([\d.]+)/);
          if (m) per10 = +m[1];
        }
        return { year: x.year, per10: per10, plan: x.plan || '方案详见公告', exDate: x.exDate || '--' };
      });
      // 由分红推算股息率
      const latest = st.dividends.find(d => d.per10 != null);
      if (latest && st.quote.price) {
        st.quote.dvYield = +((latest.per10 / 10) / st.quote.price * 100).toFixed(2);
        if (st.fin) st.fin.dvYield = st.quote.dvYield;
      }
      return st.dividends;
    }).catch(e => { store._divLoading.delete(code); throw e; });
    store._divLoading.set(code, p);
    return p;
  }

  let _loadingAllDiv = null;
  function ensureDividendsAll(codes, onProgress) {
    if (_loadingAllDiv) return _loadingAllDiv;
    const list = (codes || Array.from(store.stocks.keys())).filter(c => {
      const st = store.stocks.get(c);
      return st && !st.dividends;
    });
    let done = 0;
    const total = list.length;
    _loadingAllDiv = (async () => {
      const CONC = 10;
      for (let i = 0; i < list.length; i += CONC) {
        await Promise.all(list.slice(i, i + CONC).map(c => ensureDividends(c).catch(() => null)));
        done += Math.min(CONC, list.length - i);
        if (onProgress) onProgress(done, total);
      }
    })().finally(() => { _loadingAllDiv = null; });
    return _loadingAllDiv;
  }

  /* ------------------- 指数 K 线(迷你图 + 回测基准) ------------------- */
  function ensureIndexKline(code) {
    if (store._idxKLoading.has(code)) return store._idxKLoading.get(code);
    const p = api('kline?code=' + code + '&klt=101&fqt=0&lmt=130')
      .then(data => {
        const bars = data.bars;
        const ix = store.indices.find(x => x.code === code);
        if (ix) ix.kline = bars;
        return bars;
      })
      .catch(e => { store._idxKLoading.delete(code); return []; });
    store._idxKLoading.set(code, p);
    return p;
  }

  /* ------------------- 股东(数据源暂未接入) ------------------- */
  function ensureShareholders() {
    return { holderCount: null, holderChgPct: null, instPct: null, fundPct: null, northPct: null, top10: [] };
  }

  /* ------------------- 搜索(全市场) ------------------- */
  function search(q) {
    const s = (q || '').trim().toUpperCase();
    if (!s) return [];
    return store.marketAll.list.filter(st => {
      return st.code.indexOf(s) >= 0 || st.name.indexOf(s) >= 0 ||
        st.py.indexOf(s) >= 0 || st.industry.indexOf(s) >= 0;
    }).slice(0, 10);
  }
  async function searchRemote(q) {
    try { return await api('search?q=' + encodeURIComponent(q)); }
    catch (e) { return []; }
  }

  /* ------------------- 覆写 QP.data 同步接口 ------------------- */
  function applyOverrides() {
    const realBuildAll = () => ({
      list: store.marketAll.list,
      byCode: store.marketAll.byCode,
      indices: store.indices
    });
    const realGetStock = code => store.marketAll.byCode.get(code) || store.stocks.get(code) || store.ranksMap.get(code) || null;

    D.buildAll = realBuildAll;
    D.getStock = realGetStock;
    D.search = search;
    D.buildIndices = () => store.indices;

    // 市场概览(基于全市场统计,服务端计算)
    D.marketOverview = () => store.overview || { up: 0, down: 0, flat: 0, total: 0, upPct: 0, downPct: 0, limitUp: 0, limitDown: 0, amount: 0, mainNet: 0, breadth: 0 };
    // 榜单(全市场 Top,服务端排序;数据自包含,不依赖列表映射)
    D.topRank = function (key, n) {
      const map = { chgPct: 'up', amount: 'amount', turnover: 'turnover', volRatio: 'volratio' };
      return (store.ranks[map[key] || 'up'] || []).slice(0, n);
    };
    D.sectors = function () {
      const map = {};
      store.marketAll.list.forEach(s => {
        const c = s.quote.chgPct;
        if (c == null || !s.industry) return;
        if (!map[s.industry]) map[s.industry] = { name: s.industry, chg: 0, count: 0, amount: 0, up: 0 };
        const sec = map[s.industry];
        sec.chg += c;
        sec.count++; sec.amount += s.quote.amount || 0;
        if (c > 0) sec.up++;
      });
      return Object.keys(map).map(k => {
        const m = map[k];
        m.chg = +(m.chg / m.count).toFixed(2);
        return m;
      }).sort((a, b) => b.chg - a.chg).slice(0, 30);
    };
  }

  /* ------------------- 导出 ------------------- */
  root.QP.real = {
    store: store,
    poolList: poolList,
    init: init,
    refresh: refresh,
    ensureKline: ensureKline,
    ensureKlineAll: ensureKlineAll,
    ensureFin: ensureFin,
    ensureFinAll: ensureFinAll,
    ensureFflow: ensureFflow,
    ensureNews: ensureNews,
    ensureDividends: ensureDividends,
    ensureDividendsAll: ensureDividendsAll,
    ensureIndexKline: ensureIndexKline,
    refreshCalendar: refreshCalendar,
    hydrateSnapshots: hydrateSnapshots,
    ensureShareholders: ensureShareholders,
    searchRemote: searchRemote,
    marketName: marketName
  };
})(typeof window !== 'undefined' ? window : globalThis);
