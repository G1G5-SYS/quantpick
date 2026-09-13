/* ============================================================================
 * QuantPick 智能选股终端 — 应用主逻辑
 * 路由 / 页面渲染 / ECharts 图表 / 模拟实时行情 / 本地持久化
 * ========================================================================== */
(function () {
  'use strict';
  const D = root_QP().data;
  const S = root_QP().screener;
  const AI = root_QP().ai;
  const BT = root_QP().bt;

  function root_QP() { return (typeof window !== 'undefined' ? window : globalThis).QP; }

  /* ============================ 工具 ============================ */
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function upTxt(v) { return v > 0 ? 'up-txt' : v < 0 ? 'down-txt' : 'muted'; }
  function pctSpan(v, withSign) {
    const cls = upTxt(v);
    const s = (withSign === false ? '' : v > 0 ? '+' : '') + (v == null ? '--' : v.toFixed(2)) + '%';
    return '<span class="' + cls + ' num">' + s + '</span>';
  }
  function priceSpan(p) {
    return '<span class="num">' + (p == null ? '--' : Number(p).toFixed(2)) + '</span>';
  }
  const fmt = D.fmtMoney, fmtBig = D.fmtBig;

  /* ============================ 状态 ============================ */
  const LS = {
    get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { localStorage.removeItem(k); }
  };

  const state = {
    user: null,
    realMode: false,
    settings: LS.get('qp_settings', { colorMode: 'cn', live: true }),
    watch: null, strategies: LS.get('qp_strategies', []),
    alerts: [], bell: [], chatCtx: null, reportHist: [],
    market: { page: 1, pageSize: 15, sortKey: 'chgPct', sortDir: -1, filters: { market: '', industry: '', status: '', kw: '' } },
    screen: { strategy: null, results: null, sortKey: 'chgPct', sortDir: -1, page: 1, lastRun: null },
    predict: { horizon: 5, dim: 'composite', topN: 100, sector: '', filters: { st: true, suspend: true, liquid: true }, page: 1, reviewN: 20 },
    bt: null, chatHist: [],
    renderToken: 0, chartCounter: 0, liveTimer: null, lastTickCodes: new Set()
  };

  /* 数据源徽章:真实模式 → 东方财富;服务不可用 → 错误提示(不展示模拟数据) */
  function srcChip() {
    if (state.noService) return '<span class="chip red">数据服务不可用</span>';
    return state.realMode
      ? '<span class="chip green">东方财富 · 准实时</span>'
      : '<span class="chip gold">MOCK 模拟数据</span>';
  }
  function srcNote() {
    if (state.noService) return '数据服务未连接,本系统不展示模拟数据。请运行 node server.js 后刷新。';
    return state.realMode
      ? '本页面行情/财务/资金/新闻来自东方财富与腾讯公开接口(演示环境),仅用于研究,不构成投资建议。'
      : '本页面全部数据为模拟数据,仅供功能演示,不构成投资建议。';
  }
  function nf(v, d) {
    return (v === null || v === undefined || isNaN(v)) ? '--' : Number(v).toFixed(d === undefined ? 2 : d);
  }

  const charts = {}; // id -> echarts instance
  function chart(el, option) {
    if (!window.echarts || !el) return null;
    const key = el.id;
    try {
      // 清理残留实例(含异常后遗留),避免 "instance already initialized" 导致空白
      const old = charts[key] || window.echarts.getInstanceByDom(el);
      if (old) { try { old.dispose(); } catch (e) { } delete charts[key]; }
      const inst = window.echarts.init(el, null, { renderer: 'svg' });
      inst.setOption(option);
      charts[key] = inst;
      // 容器尺寸稳定后校准一次,避免隐藏/布局阶段渲染异常
      setTimeout(() => { try { inst.resize(); } catch (e) { } }, 100);
      return inst;
    } catch (e) {
      console.error('图表初始化失败:', e);
      return null;
    }
  }
  function chartSet(key, option) { if (charts[key]) charts[key].setOption(option, true); }
  function disposeCharts() { Object.keys(charts).forEach(k => { try { charts[k].dispose(); } catch (e) { } delete charts[k]; }); }
  window.addEventListener('resize', () => { Object.keys(charts).forEach(k => { try { charts[k].resize(); } catch (e) { } }); });

  function toast(msg, type) {
    const wrap = $('#toastWrap');
    const icons = { ok: '✅', warn: '⚠️', err: '⛔', info: 'ℹ️' };
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.innerHTML = '<span class="t-ico">' + (icons[type] || icons.info) + '</span><span>' + esc(msg) + '</span>';
    wrap.appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, 3400);
  }

  let modalCb = null;
  function openModal(title, bodyHTML, footHTML) {
    $('#modalTitle').innerHTML = esc(title);
    $('#modalBody').innerHTML = bodyHTML;
    $('#modalFoot').innerHTML = footHTML || '';
    $('#modalMask').classList.add('show');
  }
  function closeModal() { $('#modalMask').classList.remove('show'); modalCb = null; }
  function confirmModal(title, body, onOk, okText) {
    openModal(title, '<div style="line-height:1.8">' + body + '</div>',
      '<button class="btn" data-act="modal-cancel">取消</button>' +
      '<button class="btn danger" data-act="modal-ok">' + esc(okText || '确认') + '</button>');
    modalCb = onOk;
  }

  /* ============================ 持久化(按用户) ============================ */
  function wKey(k) { return k + '_' + (state.user ? state.user.name : 'guest'); }
  function loadUserData() {
    state.watch = LS.get(wKey('qp_watch'), { groups: [{ id: 'g1', name: '默认自选', items: [] }] });
    state.alerts = LS.get(wKey('qp_alerts'), []);
    state.reportHist = LS.get(wKey('qp_reports'), []);
  }
  function saveWatch() { LS.set(wKey('qp_watch'), state.watch); }
  function saveAlerts() { LS.set(wKey('qp_alerts'), state.alerts); }
  function saveStrategies() { LS.set('qp_strategies', state.strategies); }

  function inWatch(code) {
    return state.watch.groups.some(g => g.items.some(it => it.code === code));
  }
  function addToWatch(code) {
    const g = state.watch.groups[0];
    if (g.items.some(it => it.code === code)) return false;
    g.items.push({ code: code, note: '', tags: [] });
    saveWatch(); return true;
  }
  function removeFromWatch(code) {
    state.watch.groups.forEach(g => { g.items = g.items.filter(it => it.code !== code); });
    saveWatch();
  }

  /* ============================ 登录 ============================ */
  function hashPass(p) {
    let h = 5381;
    for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) >>> 0;
    return 'qp$' + (h * 2654435761 >>> 0).toString(36) + '$' + p.length;
  }
  const USERS_KEY = 'qp_users';
  function initAuth() {
    $('#tabLogin').onclick = () => { $('#tabLogin').classList.add('on'); $('#tabReg').classList.remove('on'); $('#authBtn').textContent = '登 录'; $('#nickField').style.display = 'none'; };
    $('#tabReg').onclick = () => { $('#tabReg').classList.add('on'); $('#tabLogin').classList.remove('on'); $('#authBtn').textContent = '注 册'; $('#nickField').style.display = 'block'; };
    $('#authForm').onsubmit = (e) => {
      e.preventDefault();
      const user = $('#authUser').value.trim();
      const pass = $('#authPass').value;
      const nick = $('#authNick').value.trim() || user;
      const isReg = $('#tabReg').classList.contains('on');
      const errEl = $('#authError');
      if (!user || !pass) return showAuthErr('请输入账号和密码');
      if (isReg && pass.length < 4) return showAuthErr('密码至少 4 位');
      const users = LS.get(USERS_KEY, {});
      if (isReg) {
        if (users[user]) return showAuthErr('该账号已存在,请直接登录');
        users[user] = { pass: hashPass(pass), nick: nick };
        LS.set(USERS_KEY, users);
        toast('注册成功,已自动登录', 'ok');
        login(user, nick);
      } else {
        const u = users[user];
        if (!u || u.pass !== hashPass(pass)) return showAuthErr('账号或密码错误');
        login(user, u.nick);
      }
    };
    $('#demoLogin').onclick = () => login('demo', '演示用户');
    function showAuthErr(msg) {
      const el = $('#authError');
      el.textContent = msg;
      el.classList.remove('show');
      void el.offsetWidth;
      el.classList.add('show');
    }
    const sess = LS.get('qp_session', null);
    if (sess && LS.get(USERS_KEY, {})[sess.name]) login(sess.name, sess.nick, true);
    else showAuth();
  }
  function showAuth() {
    $('#app').classList.remove('on');
    $('#authScreen').style.display = 'flex';
    $('#preloader').classList.add('hide');
  }
  function login(name, nick, silent) {
    state.user = { name: name, nick: nick };
    LS.set('qp_session', { name: name, nick: nick });
    loadUserData();
    $('#authScreen').style.display = 'none';
    $('#app').classList.add('on');
    $('#userName').textContent = nick;
    $('#userAvatar').textContent = (nick || 'U').charAt(0).toUpperCase();
    renderNav();
    buildTicker();
    startClock();
    startLive();
    if (!silent) toast('欢迎回来,' + nick, 'ok');
    if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
    else route();
  }
  function logout() {
    LS.del('qp_session');
    state.user = null;
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
    disposeCharts();
    showAuth();
  }

  /* ============================ 导航 ============================
   * 按功能语义分组,避免 11 个条目堆在同一标题下造成拥挤与"功能重复"的观感。
   * 分组原则:行情看盘 / 选股工具 / AI 智能 / 我的 / 系统,各司其职但不合并成一项。 */
  const NAV_GROUPS = [
    {
      label: '行情看盘', items: [
        { hash: '#/dashboard', label: '大盘晴雨表', ico: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
        { hash: '#/ranks', label: '榜单中心', ico: 'M4 19V5M10 19V9M16 19V2M22 19h-18' },
        { hash: '#/market', label: '行情中心', ico: 'M3 3v18h18M7 15l4-6 4 3 5-8' }
      ]
    },
    {
      label: '选股工具', items: [
        { hash: '#/screener', label: '条件选股', ico: 'M22 3H2l8 9.5V19l4 2v-8.5z' },
        { hash: '#/backtest', label: '策略回测', ico: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M21 12a9 9 0 1 1-9 9' }
      ]
    },
    {
      label: 'AI 智能', items: [
        /* 预测选股 + 牛股诊断 合并为一个入口(页内分页);alias 让 #/ai 也保持菜单高亮 */
        { hash: '#/predict', alias: '#/ai', label: 'AI 智能分析', title: 'AI 智能分析(预测选股 / 牛股诊断)', ico: 'M3 3v18h18M7 15l4-6 4 3 5-8M18 2l.6 1.9L20.5 4.5l-1.9.6L18 7l-.6-1.9-1.9-.6 1.9-.6z' },
        { hash: '#/chat', label: 'AI 对话', ico: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.4-.7L3 21l1.8-5.6A8.4 8.4 0 1 1 21 11.5z' }
      ]
    },
    {
      label: '我的', items: [
        { hash: '#/watchlist', label: '自选股', ico: 'M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z' },
        { hash: '#/alerts', label: '消息提醒', ico: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0' }
      ]
    },
    {
      label: '系统', items: [
        { hash: '#/settings', label: '系统设置', ico: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }
      ]
    }
  ];
  /* 扁平化后的菜单项(供路由高亮等复用) */
  const NAV = NAV_GROUPS.reduce((acc, g) => acc.concat(g.items), []);
  function renderNav() {
    $('#nav').innerHTML = NAV_GROUPS.map(g =>
      '<div class="nav-label">' + g.label + '</div>' +
      g.items.map(n =>
        '<a class="nav-item" data-hash="' + n.hash + '"' + (n.alias ? ' data-alias="' + n.alias + '"' : '') +
        ' href="' + n.hash + '" title="' + (n.title || n.label) + '">' +
        '<span class="nav-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + n.ico + '"/></svg></span>' +
        '<span class="nav-txt">' + n.label + '</span>' +
        (n.hash === '#/watchlist' ? '<span class="nav-badge" id="watchBadge" style="display:none">0</span>' : '') +
        '</a>'
      ).join('')
    ).join('');
  }

  /* ============================ 路由 ============================ */
  function route() {
    if (!state.user) { showAuth(); return; }
    if (state.noService) { renderNoService(); return; }
    const hash = location.hash || '#/dashboard';
    let m = hash.match(/^#\/stock\/(\d{4,6})(?:\/(\w+))?/);
    if (m) return renderStock(m[1], m[2] || 'chart');
    const page = (hash.replace('#/', '').split('?')[0]) || 'dashboard';
    if (page === 'ranks') {
      const q = new URLSearchParams((hash.split('?')[1] || ''));
      const t = q.get('type');
      if (t && ['up', 'down', 'amount', 'turnover', 'volratio', 'ai'].indexOf(t) >= 0) state.ranksType = t;
    }
    const renderers = {
      dashboard: renderDashboard, ranks: renderRanks, predict: renderPredict, market: renderMarket, screener: renderScreener,
      watchlist: renderWatchlist, ai: renderAI, chat: renderChat, backtest: renderBacktest,
      alerts: renderAlerts, settings: renderSettings
    };
    /* 菜单高亮:支持 alias(如 #/ai 与 #/predict 同属「AI 智能分析」) */
    const cur = '#/' + page;
    $$('#nav .nav-item').forEach(el => el.classList.toggle('on',
      el.dataset.hash === cur || (el.dataset.alias || '') === cur));
    (renderers[page] || renderDashboard)();
  }
  window.addEventListener('hashchange', route);

  /* ============================ 顶部:时钟/状态/搜索/铃铛 ============================ */
  function startClock() {
    const tick = () => {
      const d = new Date();
      const pad = x => String(x).padStart(2, '0');
      $('#clock').textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
      const h = d.getHours() + d.getMinutes() / 60;
      const wd = d.getDay();
      const dot = $('.status-dot');
      let txt = '';
      if (wd === 0 || wd === 6) txt = '休市';
      else if (h >= 9.5 && h < 11.5) txt = '交易中(上午)';
      else if (h >= 13 && h < 15) txt = '交易中(下午)';
      else if (h >= 11.5 && h < 13) txt = '午间休市';
      else txt = '已收盘';
      $('#marketStatusTxt').textContent = '行情:' + txt;
      if (txt.indexOf('交易中') >= 0) dot.className = 'status-dot live';
      else dot.className = 'status-dot closed';
    };
    tick();
    setInterval(tick, 1000);
  }

  function initSearch() {
    const input = $('#globalSearch'), drop = $('#searchDrop');
    let deb;
    input.addEventListener('input', () => {
      clearTimeout(deb);
      const q = input.value.trim();
      if (!q) { drop.classList.remove('show'); return; }
      deb = setTimeout(async () => {
        let hits = D.search(q);
        if (state.realMode && QP.real) {
          const remote = await QP.real.searchRemote(q).catch(() => []);
          const local = new Set(hits.map(h => h.code));
          remote.forEach(r => {
            if (!local.has(r.code) && /^\d{6}$/.test(r.code)) {
              hits.push({ code: r.code, name: r.name, market: r.market === '沪' ? '沪' : r.market === '深' ? '深' : '其他', quote: { chgPct: null, price: null } });
            }
          });
          hits = hits.slice(0, 12);
        }
        if (!hits.length) {
          drop.innerHTML = '<div class="sd-empty">未找到相关股票' + (state.realMode ? '(支持东方财富全市场搜索)' : '') + '</div>';
        } else {
          drop.innerHTML = hits.map(s =>
            '<div class="sd-item" data-act="goto-stock" data-code="' + s.code + '">' +
            '<span class="sd-code">' + s.code + '</span>' +
            '<span class="sd-name">' + esc(s.name) + '</span>' +
            '<span class="sd-market">' + (s.market === '沪' ? '沪' : s.market === '深' ? '深' : s.market) + '</span>' +
            '<span class="sd-chg ' + upTxt(s.quote && s.quote.chgPct) + '">' + (s.quote && s.quote.chgPct != null ? D.fmtPct(s.quote.chgPct) : '--') + '</span>' +
            '</div>').join('');
        }
        drop.classList.add('show');
      }, 250);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && drop.querySelector('.sd-item')) {
        drop.querySelector('.sd-item').click();
      }
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-box')) drop.classList.remove('show');
    });
  }

  function renderBell() {
    const items = state.bell.slice().reverse().slice(0, 20);
    const dot = $('#bellDot');
    dot.style.display = state.bell.length ? 'block' : 'none';
    $('#bellDrop').innerHTML =
      '<div class="bd-head">提醒记录(' + state.bell.length + ')</div>' +
      (items.length ? items.map(b =>
        '<div class="bell-item"><span class="bi-tag">' + b.type + '</span>' +
        '<div class="bi-t">' + esc(b.title) + '</div>' +
        '<div class="bi-s">' + b.time + ' · ' + esc(b.detail) + '</div></div>').join('') :
        '<div class="bell-empty">暂无触发提醒。可在「消息提醒」页设置价格/涨跌幅/成交量提醒。</div>');
  }

  /* ============================ 跑马灯 ============================ */
  let tickerBuilt = false;
  function buildTicker() {
    if (tickerBuilt) return;
    tickerBuilt = true;
    const { list } = D.buildAll();
    const top = list.slice().sort((a, b) => b.quote.mcap - a.quote.mcap).slice(0, 42);
    refreshTicker(top);
  }
  function refreshTicker(forceList) {
    const el = $('#ticker');
    const { list } = D.buildAll();
    const top = forceList || list.slice().sort((a, b) => (b.quote.mcap || 0) - (a.quote.mcap || 0)).slice(0, 42);
    const html = top.map(s => {
      const px = s.quote.price != null ? s.quote.price.toFixed(2) : (s.quote.prevClose != null ? s.quote.prevClose.toFixed(2) : '--');
      return '<div class="ticker-item" data-code="' + s.code + '">' +
      '<span class="t-name">' + esc(s.name) + '</span>' +
      '<span class="t-code">' + s.code + '</span>' +
      '<span class="t-px ' + upTxt(s.quote.chgPct) + '">' + px + '</span>' +
      '<span class="t-pct ' + upTxt(s.quote.chgPct) + '">' + (s.quote.chgPct != null ? D.fmtPct(s.quote.chgPct) : '--') + '</span>' +
      '</div>';
    }).join('');
    el.innerHTML = html + html; // 双份实现无缝滚动
    el.querySelectorAll('.ticker-item').forEach(it => {
      it.onclick = () => { location.hash = '#/stock/' + it.dataset.code; };
    });
  }

  /* ============================ 真实行情自动刷新 ============================ */
  const REAL_TICK_MS = 10000; // 轮询周期:10s(减轻东财/腾讯公开接口压力,避免触发限流)
  function startLive() {
    if (state.liveTimer) clearInterval(state.liveTimer);
    if (state.realMode) {
      // 真实模式:每 10 秒自动刷新(公开接口限流保护)
      state.liveTimer = setInterval(() => realTick(), REAL_TICK_MS);
    } else {
      state.liveTimer = setInterval(() => {
        if (!state.settings.live || !state.user) return;
        liveTick();
      }, 2600);
    }
  }
  let realTicking = false;
  async function realTick() {
    if (realTicking) return;
    realTicking = true;
    try {
      // 轮询心跳:每次刷新必更新"上次更新"时间(即使数据源较慢)
      const lu = $('#lastUpd');
      if (lu) {
        lu.textContent = new Date().toLocaleTimeString('zh-CN');
        $('#lastUpdBox').style.display = '';
      }
      const ok = await Promise.race([
        QP.real.refresh(),
        new Promise(res => setTimeout(() => res(false), 30000)) // 超时保护:refresh 挂起不超过一个轮询周期的 3 倍
      ]);
      if (!ok) return;
      refreshTicker();
      checkAlerts(new Set(QP.real.store.stocks.keys()));
      const page = (location.hash.replace('#/', '') || 'dashboard').split('?')[0].split('/')[0];
      if (page === 'dashboard') updateDashboardLive();
      else if (page === 'ranks') updateRanksLive();
      else if (page === 'predict') updatePredictLive();
      else if (page === 'market') {
        await refreshVisibleQuotes();          // 当前可见页价格刷新
        updateMarketLive(new Set(QP.real.store.stocks.keys()));
      }
      else if (page === 'watchlist') updateWatchLive(new Set(QP.real.store.stocks.keys()));
      else if (page === 'stock') updateStockLive(new Set(QP.real.store.stocks.keys()));
    } finally { realTicking = false; }
  }
  let visRefreshing = false;
  async function refreshVisibleQuotes() {
    if (visRefreshing) return;
    visRefreshing = true;
    try {
      const rows = $$('#mkBody tr[data-code]').map(r => r.dataset.code);
      if (!rows.length) return;
      const qs = await (await fetch('api/quote?codes=' + rows.join(','))).json();
      (qs.data || []).forEach(q => {
        const st = D.getStock(q.code);
        if (!st) return;
        Object.assign(st.quote, {
          price: q.price, chg: q.chg, chgPct: q.chgPct, open: q.open, high: q.high, low: q.low,
          prevClose: q.prevClose, volume: q.volume, amount: q.amount, turnover: q.turnover,
          volRatio: q.volRatio, amplitude: q.amplitude, pe: q.pe, pb: q.pb, mcap: q.mcap, fcap: q.fcap,
          mainNet: q.mainNet, mainNetPct: q.mainNetPct
        });
        st.status = q.price == null ? '停牌' : '正常';
        if (q.name) st.name = q.name.replace(/\s+/g, '');
      });
    } catch (e) { /* 忽略单次失败 */ }
    finally { visRefreshing = false; }
  }
  function liveTick() {
    const { list } = D.buildAll();
    const codes = new Set();
    for (let i = 0; i < 5; i++) codes.add(list[Math.floor(Math.random() * list.length)].code);
    codes.forEach(code => {
      const s = D.getStock(code);
      if (!s || s.status === '停牌') return;
      const q = s.quote;
      const move = (Math.random() - 0.48) * 0.006 * q.price;
      const cap = s.status === 'ST' ? 4.8 : 9.8;
      let np = q.price + move;
      const maxP = q.prevClose * (1 + cap / 100), minP = q.prevClose * (1 - cap / 100);
      np = Math.min(maxP, Math.max(minP, np));
      q.price = +np.toFixed(2);
      q.chg = +(q.price - q.prevClose).toFixed(2);
      q.chgPct = +((q.price / q.prevClose - 1) * 100).toFixed(2);
      q.high = Math.max(q.high, q.price);
      q.low = Math.min(q.low, q.price);
      q.volume = Math.round(q.volume + Math.random() * 40000);
      q.amount = Math.round(q.amount + q.volume * 0.01 * q.price);
      q.mcap = Math.round(q.price * s.totalShares * 1e8);
      q.limitUp = q.chgPct >= 9.7; q.limitDown = q.chgPct <= -9.7;
    });
    state.lastTickCodes = codes;
    refreshTicker();
    checkAlerts(codes);
    // 更新当前页
    const page = (location.hash.replace('#/', '') || 'dashboard').split('/')[0];
    if (page === 'dashboard') updateDashboardLive();
    else if (page === 'market') updateMarketLive(codes);
    else if (page === 'watchlist') updateWatchLive(codes);
    else if (page === 'stock') updateStockLive(codes);
    else if (page === 'predict') updatePredictLive();
  }
  function flashCell(cell, up) {
    if (!cell) return;
    cell.classList.remove('cell-flash-up', 'cell-flash-down');
    void cell.offsetWidth;
    cell.classList.add(up ? 'cell-flash-up' : 'cell-flash-down');
  }
  function checkAlerts(codes) {
    if (!state.alerts.length) return;
    codes.forEach(code => {
      const s = D.getStock(code);
      if (!s) return;
      state.alerts.forEach(a => {
        if (!a.enabled || a.code !== code) return;
        if (a.lastTriggered && Date.now() - a.lastTriggered < 60000) return;
        let hit = false, val = 0, unit = '';
        if (a.type === 'price') { val = s.quote.price; unit = '元'; hit = a.op === '>' ? val >= +a.value : val <= +a.value; }
        else if (a.type === 'chg') { val = s.quote.chgPct; unit = '%'; hit = a.op === '>' ? val >= +a.value : val <= +a.value; }
        else if (a.type === 'volume') { val = Math.round(s.quote.volume / 1e4); unit = '万手'; hit = a.op === '>' ? val >= +a.value : val <= +a.value; }
        if (hit) {
          a.lastTriggered = Date.now();
          a.lastTriggeredAt = new Date().toLocaleString('zh-CN');
          saveAlerts();
          const msg = s.name + '(' + s.code + ') ' + (a.type === 'price' ? '价格' : a.type === 'chg' ? '涨跌幅' : '成交量') +
            ' ' + a.op + ' ' + a.value + unit + ',当前 ' + val + unit;
          toast('提醒触发:' + msg, 'warn');
          state.bell.push({ type: a.type === 'price' ? '价格' : a.type === 'chg' ? '涨跌' : '量能', title: msg, detail: D.DATA_TIME + ' · 真实行情', time: new Date().toLocaleTimeString('zh-CN') });
          state.bell = state.bell.slice(-40);
          renderBell();
        }
      });
    });
  }

  /* ============================ 通用渲染块 ============================ */
  function pageHead(title, sub, actions, opts) {
    return '<div class="page-head">' +
      '<div><div class="page-title">' + title + '</div>' +
      '<div class="sub">' + sub + (state.realMode ? '' : (opts && opts.mock !== false ? ' · 全部为<strong style="color:var(--gold)">模拟数据(Mock)</strong>' : '')) + '</div></div>' +
      '<div class="page-actions">' + (actions || '') + '</div></div>';
  }
  function riskNote(txt, danger) {
    return '<div class="risk-note' + (danger ? ' danger' : '') + ' mt-16">' +
      '<span class="rn-ico">⚠️</span><span>' + (txt || srcNote()) + '</span></div>';
  }
  function skeleton() {
    return '<div class="panel"><div class="panel-body">' +
      Array.from({ length: 6 }).map(() => '<div class="skeleton" style="height:46px;margin-bottom:10px"></div>').join('') +
      '</div></div>';
  }
  function stockRow(st, rank, extra) {
    const q = st.quote;
    return '<tr data-act="goto-stock" data-code="' + st.code + '" class="clickable">' +
      (rank !== undefined ? '<td><span class="rank-badge rank-' + Math.min(rank + 1, 3) + '">' + (rank + 1) + '</span></td>' : '') +
      '<td><span class="num">' + st.code + '</span></td>' +
      '<td><div>' + st.name + (st.status === 'ST' ? ' <span class="chip red" style="padding:0 6px;font-size:10px">ST</span>' : '') + '</div>' +
      '<div class="muted" style="font-size:11px">' + st.industry + '</div></td>' +
      '<td class="num">' + priceSpan(q.price) + '</td>' +
      '<td class="num">' + pctSpan(q.chgPct) + '</td>' +
      '<td class="num">' + fmt(q.amount) + '</td>' +
      '<td class="num">' + q.turnover.toFixed(2) + '%</td>' +
      '<td class="num">' + q.pe.toFixed(1) + '</td>' +
      (extra || '') +
      '</tr>';
  }

  /* ============================ 页面:数据服务不可用(不展示模拟数据) ============================ */
  function renderNoService() {
    $('#content').innerHTML =
      pageHead('数据服务未连接', '本系统不提供模拟数据,请启动数据服务后使用', '<span class="chip red">服务不可用</span>') +
      '<div class="panel"><div class="panel-body center" style="padding:70px 20px">' +
      '<div style="font-size:44px">🛰️</div>' +
      '<div style="font-size:16.5px;margin-top:16px;color:var(--txt-1)">无法连接数据服务(server.js)</div>' +
      '<div class="muted" style="margin-top:12px;line-height:2.1">请在 quantpick 目录执行 <code>node server.js</code> 或双击 <code>start.bat</code>,然后刷新本页面。<br>' +
      '行情/指数/榜单/K线/财务/资金/新闻均来自东方财富与腾讯公开接口。<br>' +
      '为了确保数据真实可信,服务不可用时页面不会展示任何模拟数据。</div>' +
      '<button class="btn primary mt-20" onclick="location.reload()">刷新重试</button>' +
      '</div></div>' +
      '<div class="risk-note danger mt-16"><span class="rn-ico">⚠️</span><span>页面不会显示模拟数据;服务恢复后刷新页面即可。股市有风险,投资需谨慎,不构成投资建议。</span></div>';
  }

  /* ============================ 页面:仪表盘 ============================ */
  function renderDashboard() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      const { indices, list } = D.buildAll();
      const ov = D.marketOverview();
      const secs = D.sectors();
      const newHigh = list.filter(s => s.status !== '停牌' && s.quote.price != null && s.quote.high60 != null && s.quote.price >= s.quote.high60 && s.quote.high60 > s.quote.price * 0.999).sort((a, b) => b.quote.chgPct - a.quote.chgPct).slice(0, 6);
      const lo20 = s => (s.kline && s.kline.length) ? Math.min.apply(null, s.kline.slice(-20).map(b => b.low)) : null;
      const newLow = list.filter(s => {
        if (s.status === '停牌' || s.quote.price == null) return false;
        const l = lo20(s);
        return l != null && s.quote.price <= l;
      }).sort((a, b) => a.quote.chgPct - b.quote.chgPct).slice(0, 6);
      const wl = state.watch.groups[0].items.slice(0, 6).map(it => D.getStock(it.code)).filter(Boolean);

      const idxCards = indices.map((ix, i) => {
        const cid = 'idx-mini-' + ix.code;
        return '<div class="panel hoverable" style="padding:14px 16px;cursor:pointer" data-act="chart-idx" data-i="' + i + '">' +
          '<div class="flex items-center gap-8"><span style="font-size:12.5px;color:var(--txt-2)">' + ix.name + '</span>' +
          '<span class="chip gray" style="margin-left:auto">' + ix.market + '</span></div>' +
          '<div class="num" style="font-size:22px;font-weight:700;margin-top:4px" id="idxPx-' + ix.code + '">' + (ix.quote.price != null ? ix.quote.price.toFixed(2) : '--') + '</div>' +
          '<div class="num ' + upTxt(ix.quote.chgPct) + '" style="font-size:12.5px" id="idxChg-' + ix.code + '">' + (ix.quote.chgPct != null ? D.fmtPct(ix.quote.chgPct) : '--') + '  ' + (ix.quote.amount ? D.fmtMoney(ix.quote.amount) : '--') + '</div>' +
          '<div class="mini-chart" id="' + cid + '"></div></div>';
      }).join('');

      const kpiHTML = '<div class="kpis">' +
        kpi('上涨家数', '<span class="num" id="ovUp">' + ov.up + '</span>', '占比 ' + ov.upPct + '%', 'up', 'M12 19V5M5 12l7-7 7 7') +
        kpi('下跌家数', '<span class="num" id="ovDown">' + ov.down + '</span>', '占比 ' + ov.downPct + '%', 'down', 'M12 5v14M19 12l-7 7-7-7') +
        kpi('涨停 / 跌停', '<span class="num"><span id="ovLU" class="up-txt">' + ov.limitUp + '</span> / <span id="ovLD" class="down-txt">' + ov.limitDown + '</span></span>', '全市场统计', 'limit', 'M13 2L3 14h9l-1 8 10-12h-9z') +
        kpi('两市成交额', '<span class="num" id="ovAmt">' + fmtBig(ov.amount) + '</span>', '全市场合计', 'amt', 'M3 3v18h18M7 15l4-6 4 3 5-8') +
        kpi('主力净流入', '<span class="num" id="ovMain" class="' + (ov.mainNet >= 0 ? 'up-txt' : 'down-txt') + '">' + fmt(ov.mainNet) + '</span>', '样本池合计', 'main', 'M3 17l5-5 4 3 6-7M14 8h4v4') +
        kpi('市场温度', '<span class="num" id="ovTemp">' + Math.round(ov.breadth) + '</span>', '上涨占比 ' + ov.breadth + '%', 'temp', 'M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8') +
        '</div>';
      function kpi(label, val, sub, tone, ico) {
        const bg = { up: 'rgba(245,34,45,.14)', down: 'rgba(0,181,120,.14)', limit: 'rgba(245,179,1,.15)', amt: 'rgba(245,179,1,.16)', main: 'rgba(230,48,48,.16)', temp: 'rgba(245,179,1,.16)' }[tone];
        const fg = { up: 'var(--up)', down: 'var(--down)', limit: 'var(--gold)', amt: 'var(--gold)', main: 'var(--brand)', temp: 'var(--gold-2)' }[tone];
        return '<div class="panel hoverable kpi"><div class="k-label">' + label + '</div>' +
          '<div class="k-value">' + val + '</div><div class="k-sub">' + sub + '</div>' +
          '<div class="k-ico" style="background:' + bg + ';color:' + fg + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + ico + '"/></svg></div></div>';
      }

      const secRows = secs.slice(0, 12).map(s => {
        const maxAbs = Math.max.apply(null, secs.slice(0, 12).map(x => Math.abs(x.chg)));
        const w = Math.abs(s.chg) / maxAbs * 100;
        return '<div class="flex items-center gap-12" style="padding:7px 2px">' +
          '<span style="width:72px;font-size:12.5px">' + esc(s.name) + '</span>' +
          '<div class="bar flex-1"><i style="width:' + Math.max(w, 4) + '%;background:' + (s.chg >= 0 ? 'linear-gradient(90deg,#f6465d,#ff8fa0)' : 'linear-gradient(90deg,#2ebd85,#6ee7b7)') + '"></i></div>' +
          '<span class="num ' + upTxt(s.chg) + '" style="width:74px;text-align:right">' + D.fmtPct(s.chg) + '</span>' +
          '<span class="muted num" style="width:40px;text-align:right;font-size:11px">' + s.count + '</span></div>';
      }).join('');

      const wlRows = wl.length ? wl.map(s =>
        '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '"><td>' + esc(s.name) + '</td>' +
        '<td class="num">' + s.quote.price.toFixed(2) + '</td><td class="num">' + pctSpan(s.quote.chgPct) + '</td>' +
        '<td class="num">' + fmt(s.quote.amount) + '</td><td class="num">' + s.quote.pe.toFixed(1) + '</td></tr>').join('') :
        '<tr><td colspan="5" class="center muted" style="padding:24px">暂无自选股,去「行情中心」添加</td></tr>';

      const repRows = state.reportHist.slice(0, 5).map(r =>
        '<tr class="clickable" data-act="goto-stock" data-code="' + r.code + '"><td>' + esc(r.name) + '</td>' +
        '<td class="num"><b class="' + (r.overall >= 60 ? 'up-txt' : r.overall >= 45 ? '' : 'down-txt') + '">' + r.overall + '</b></td>' +
        '<td>' + (r.risk >= 70 ? '<span class="chip red">高</span>' : r.risk >= 45 ? '<span class="chip gold">中</span>' : '<span class="chip green">低</span>') + '</td>' +
        '<td class="muted num" style="font-size:11px">' + r.at + '</td></tr>').join('') ||
        '<tr><td colspan="4" class="center muted" style="padding:24px">暂无 AI 分析记录,去股票详情页生成</td></tr>';

      /* 首页定位为「概览」:只放市场总体概况(指数/KPI/板块/资金/新高新低/我的动态)。
         涨幅榜/跌幅榜/成交额/换手率/量比等完整排行统一由「榜单中心」承载,避免两处重复展示。 */
      const quickEntry = (href, title, desc, ico) =>
        '<a href="' + href + '" class="quick-card">' +
        '<span class="qc-ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + ico + '"/></svg></span>' +
        '<span class="qc-body"><b>' + title + '</b><i>' + desc + '</i></span></a>';

      $('#content').innerHTML =
        pageHead('大盘晴雨表', '市场总体概况 · 数据更新:' + D.DATA_TIME + ' · ' + (state.realMode ? '东方财富准实时 · 每3秒自动刷新' : '模拟环境') + ' · 🐂 祝您牛运当头',
          srcChip() + '<a href="#/ranks" class="chip">📊 完整榜单 →</a>') +
        '<div class="grid-4" style="grid-template-columns:repeat(auto-fit,minmax(230px,1fr));margin-bottom:20px">' + idxCards + '</div>' +
        kpiHTML +
        '<div class="grid-2 mb-16">' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>板块涨跌(行业)</div>' +
        '<div class="panel-tools"><span class="chip gray">共 ' + secs.length + ' 个行业</span></div></div>' +
        '<div class="panel-body" id="secList">' + secRows + '</div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>主力资金净流入 Top10</div></div>' +
        '<div class="panel-body"><div class="chart" id="chart-fund" style="height:280px"></div></div></div>' +
        '</div>' +
        '<div class="grid-2 mb-16">' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>创新高 / 创新低</div></div>' +
        '<div class="panel-body pt-0"><div class="table-wrap"><table class="grid"><thead><tr><th>创新高(60日)</th><th class="num">涨幅</th></tr></thead><tbody id="nhBody">' +
        newHigh.map(s => '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '"><td>' + esc(s.name) + '</td><td class="num">' + pctSpan(s.quote.chgPct) + '</td></tr>').join('') +
        '<tr><td colspan="2" style="height:8px;border:none"></td></tr>' +
        '<thead><tr><th>创新低(20日)</th><th class="num">跌幅</th></tr></thead>' +
        newLow.map(s => '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '"><td>' + esc(s.name) + '</td><td class="num">' + pctSpan(s.quote.chgPct) + '</td></tr>').join('') +
        '</tbody></table></div></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>我的自选动态</div>' +
        '<div class="panel-tools"><a href="#/watchlist" class="chip">查看全部 →</a></div></div>' +
        '<div class="panel-body pt-0"><div class="table-wrap"><table class="grid"><thead><tr><th>名称</th><th class="num">最新价</th><th class="num">涨跌幅</th><th class="num">成交额</th><th class="num">PE</th></tr></thead><tbody>' +
        wlRows + '</tbody></table></div></div></div>' +
        '</div>' +
        '<div class="grid-2 mb-16">' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>最近 AI 分析报告</div>' +
        '<div class="panel-tools"><a href="#/ai" class="chip">AI 智能分析 →</a></div></div>' +
        '<div class="panel-body pt-0"><div class="table-wrap"><table class="grid"><thead><tr><th>股票</th><th class="num">综合评分</th><th>风险</th><th>时间</th></tr></thead><tbody>' +
        repRows + '</tbody></table></div></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>常用入口</div></div>' +
        '<div class="panel-body pt-0"><div class="quick-grid">' +
        quickEntry('#/ranks', '榜单中心', '涨跌幅/成交额/换手/量比 完整排行', 'M4 19V5M10 19V9M16 19V2M22 19h-18') +
        quickEntry('#/market', '行情中心', '全部个股实时行情与详情', 'M3 3v18h18M7 15l4-6 4 3 5-8') +
        quickEntry('#/screener', '条件选股', '多条件组合筛选(AND/OR/NOT)', 'M22 3H2l8 9.5V19l4 2v-8.5z') +
        quickEntry('#/predict', 'AI 智能分析', '预测选股榜单 + 个股诊断', 'M3 3v18h18M7 15l4-6 4 3 5-8M18 2l.6 1.9L20.5 4.5l-1.9.6L18 7l-.6-1.9-1.9-.6 1.9-.6z') +
        '</div></div></div>' +
        '</div>' +
        riskNote() +
        '<div class="page-foot">QuantPick 牛股智选 · 祝您股海淘金,财源广进 · 全部数据来自东方财富/腾讯公开接口(真实数据) · 数据截止 ' + D.DATA_TIME + ' · 不构成投资建议</div>';

      // 图表
      indices.forEach((ix, i) => {
        const cid = 'idx-mini-' + ix.code;
        const draw = (kl) => {
          const el = $('#idx-mini-' + ix.code);
          if (!el) return;
          const bars = (kl && kl.length) ? kl : null;
          const up = ix.quote.chgPct != null && ix.quote.chgPct >= 0;
          const c = up ? '#f6465d' : '#2ebd85';
          const series = bars ? bars.slice(-60).map(b => b.close) : null;
          chart(el, {
            grid: { left: 2, right: 2, top: 6, bottom: 2 },
            xAxis: { type: 'category', show: false, data: bars ? bars.slice(-60).map(b => b.date) : [] },
            yAxis: { type: 'value', show: false, scale: true },
            tooltip: { show: false },
            series: [{
              type: 'line', data: series, smooth: true, symbol: 'none',
              lineStyle: { width: 1.6, color: c },
              areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: up ? 'rgba(246,70,93,.28)' : 'rgba(46,189,133,.28)' }, { offset: 1, color: 'rgba(0,0,0,0)' }]) }
            }]
          });
        };
        if (state.realMode && QP.real) {
          QP.real.ensureIndexKline(ix.code).then(draw).catch(() => draw(null));
        } else {
          draw(ix.kline);
        }
      });
      // 主力资金(精选池,全市场资金流接口按需加载)
      const ffPool = state.realMode && QP.real ? QP.real.poolList() : list;
      const ffTop = ffPool.slice().filter(s => s.fundFlow && s.fundFlow.mainNet != null)
        .sort((a, b) => b.fundFlow.mainNet - a.fundFlow.mainNet).slice(0, 10).reverse();
      chart($('#chart-fund'), {
        grid: { left: 8, right: 16, top: 12, bottom: 4, containLabel: true },
        xAxis: { type: 'value', axisLabel: { color: '#5f6d92', fontSize: 10, formatter: v => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.08)' } } },
        yAxis: { type: 'category', data: ffTop.map(s => s.name), axisLabel: { color: '#9ba8c9', fontSize: 11 }, axisLine: { show: false }, axisTick: { show: false } },
        tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)', textStyle: { color: '#e9eef8', fontSize: 12 }, formatter: p => p[0].name + '<br>主力净流入:' + fmt(p[0].value) + ' 元' },
        series: [{
          type: 'bar', data: ffTop.map(s => s.fundFlow.mainNet), barWidth: 11,
          itemStyle: { color: p => p.value >= 0 ? '#f6465d' : '#2ebd85', borderRadius: 3 }
        }]
      });
    }, 240);
  }
  function updateDashboardLive() {
    const ov = D.marketOverview();
    const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
    set('#ovUp', ov.up); set('#ovDown', ov.down); set('#ovLU', ov.limitUp); set('#ovLD', ov.limitDown);
    set('#ovAmt', fmtBig(ov.amount)); set('#ovMain', fmt(ov.mainNet)); set('#ovTemp', Math.round(ov.breadth));
    const mn = $('#ovMain'); if (mn) mn.className = 'num ' + upTxt(ov.mainNet);
    // 指数卡:价格/涨跌幅 + 迷你图
    const indices = D.buildIndices();
    indices.forEach(ix => {
      const px = $('#idxPx-' + ix.code), chg = $('#idxChg-' + ix.code);
      if (px) px.textContent = ix.quote.price != null ? ix.quote.price.toFixed(2) : '--';
      if (chg) {
        chg.textContent = (ix.quote.chgPct != null ? D.fmtPct(ix.quote.chgPct) : '--') + '  ' + (ix.quote.amount ? D.fmtMoney(ix.quote.amount) : '--');
        chg.className = 'num ' + upTxt(ix.quote.chgPct);
      }
      const cid = 'idx-mini-' + ix.code;
      const el = $('#' + cid);
      if (el && window.echarts) {
        const kl = ix.kline || [];
        const up = ix.quote.chgPct != null && ix.quote.chgPct >= 0;
        const c = up ? '#f6465d' : '#2ebd85';
        chartSet(cid, {
          grid: { left: 2, right: 2, top: 6, bottom: 2 },
          xAxis: { type: 'category', show: false, data: kl.slice(-60).map(b => b.date) },
          yAxis: { type: 'value', show: false, scale: true },
          series: [{
            type: 'line', data: kl.slice(-60).map(b => b.close), smooth: true, symbol: 'none',
            lineStyle: { width: 1.6, color: c },
            areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: up ? 'rgba(246,70,93,.28)' : 'rgba(46,189,133,.28)' }, { offset: 1, color: 'rgba(0,0,0,0)' }]) }
          }]
        });
      }
    });
    // 板块涨跌(全市场行业)
    const secs = D.sectors();
    const secBox = $('#secList');
    if (secBox && secs.length) {
      const maxAbs = Math.max.apply(null, secs.slice(0, 12).map(x => Math.abs(x.chg))) || 1;
      secBox.innerHTML = secs.slice(0, 12).map(s => {
        const w = Math.abs(s.chg) / maxAbs * 100;
        return '<div class="flex items-center gap-12" style="padding:7px 2px">' +
          '<span style="width:72px;font-size:12.5px">' + esc(s.name) + '</span>' +
          '<div class="bar flex-1"><i style="width:' + Math.max(w, 4) + '%;background:' + (s.chg >= 0 ? 'linear-gradient(90deg,#f6465d,#ff8fa0)' : 'linear-gradient(90deg,#2ebd85,#6ee7b7)') + '"></i></div>' +
          '<span class="num ' + upTxt(s.chg) + '" style="width:74px;text-align:right">' + D.fmtPct(s.chg) + '</span>' +
          '<span class="muted num" style="width:40px;text-align:right;font-size:11px">' + s.count + '</span></div>';
      }).join('');
    }
    // 创新高/新低(基于真实日K;未加载K线的全市场股票暂不计入)
    const { list } = D.buildAll();
    const lo20 = s => (s.kline && s.kline.length) ? Math.min.apply(null, s.kline.slice(-20).map(b => b.low)) : null;
    const newHigh = list.filter(s => s.quote.price != null && s.quote.high60 != null && s.quote.price >= s.quote.high60 && s.quote.high60 > s.quote.price * 0.999).sort((a, b) => b.quote.chgPct - a.quote.chgPct).slice(0, 6);
    const newLow = list.filter(s => {
      if (s.quote.price == null) return false;
      const l = lo20(s);
      return l != null && s.quote.price <= l;
    }).sort((a, b) => a.quote.chgPct - b.quote.chgPct).slice(0, 6);
    const nh = $('#nhBody');
    if (nh) {
      nh.innerHTML = newHigh.map(s => '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '"><td>' + esc(s.name) + '</td><td class="num">' + pctSpan(s.quote.chgPct) + '</td></tr>').join('') +
        '<tr><td colspan="2" style="height:8px;border:none"></td></tr>' +
        '<thead><tr><th>创新低(20日)</th><th class="num">跌幅</th></tr></thead>' +
        newLow.map(s => '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '"><td>' + esc(s.name) + '</td><td class="num">' + pctSpan(s.quote.chgPct) + '</td></tr>').join('');
    }
    // 主力资金 Top10 图(精选池)
    const ffPool = state.realMode && QP.real ? QP.real.poolList() : list;
    const ffTop = ffPool.slice().filter(s => s.fundFlow && s.fundFlow.mainNet != null)
      .sort((a, b) => b.fundFlow.mainNet - a.fundFlow.mainNet).slice(0, 10).reverse();
    if (window.echarts && ffTop.length && $('#chart-fund')) {
      chartSet('chart-fund', {
        yAxis: { type: 'category', data: ffTop.map(s => s.name) },
        series: [{
          type: 'bar', data: ffTop.map(s => s.fundFlow.mainNet), barWidth: 11,
          itemStyle: { color: p => p.value >= 0 ? '#f6465d' : '#2ebd85', borderRadius: 3 }
        }]
      });
    }
    // 自选动态
    const wlTb = $('.grid-2 table.grid tbody');
    if (wlTb && state.watch.groups[0].items.length) {
      wlTb.innerHTML = state.watch.groups[0].items.map(it => D.getStock(it.code)).filter(Boolean).map(s =>
        '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '"><td>' + esc(s.name) + '</td>' +
        '<td class="num">' + (s.quote.price != null ? s.quote.price.toFixed(2) : nf(s.quote.prevClose)) + '</td>' +
        '<td class="num">' + pctSpan(s.quote.chgPct) + '</td>' +
        '<td class="num">' + (s.quote.amount ? fmt(s.quote.amount) : '--') + '</td>' +
        '<td class="num">' + (s.quote.pe != null ? s.quote.pe.toFixed(1) : '--') + '</td></tr>').join('');
    }
  }

  /* ============================ 页面:榜单中心(完整榜单) ============================ */
  const RANK_TABS = [['up', '涨幅榜', 'chgPct'], ['down', '跌幅榜', 'chgPct'], ['amount', '成交额榜', 'amount'], ['turnover', '换手率榜', 'turnover'], ['volratio', '量比榜', 'volRatio'], ['ai', 'AI评估榜', 'ai']];

  /* AI 评估榜:基于规则引擎评分(真实数据),按综合分降序 */
  let _aiRankCache = null, _aiRankAt = 0;
  function aiRankList() {
    const now = Date.now();
    if (_aiRankCache && now - _aiRankAt < 3000) return _aiRankCache;
    const pool = state.realMode && QP.real ? QP.real.poolList() : D.buildAll().list;
    const list = pool.map(s => {
      let rep = null;
      try { rep = AI.analyze(s); } catch (e) { rep = null; }
      return { s: s, rep: rep };
    }).filter(x => x.rep);
    list.sort((a, b) => (b.rep.overall_score - a.rep.overall_score) || ((b.s.quote.chgPct || 0) - (a.s.quote.chgPct || 0)));
    _aiRankCache = list;
    _aiRankAt = now;
    return list;
  }
  function scoreCls(v) { return v >= 70 ? 'up-txt' : v >= 45 ? '' : 'down-txt'; }

  function mockRanks() {
    const { list } = D.buildAll();
    const sorted = list.slice().filter(s => s.quote.chgPct != null);
    const by = key => sorted.slice().sort((a, b) => (b.quote[key] || -Infinity) - (a.quote[key] || -Infinity));
    return {
      up: by('chgPct'), down: sorted.slice().sort((a, b) => (a.quote.chgPct || Infinity) - (b.quote.chgPct || Infinity)),
      amount: by('amount'), turnover: by('turnover'), volratio: by('volRatio')
    };
  }
  function ranksSource() {
    if (state.realMode && QP.real) {
      if (state.ranksType === 'ai') return { ai: aiRankList() };
      return QP.real.store.ranks; // 数据自包含(含 quote/行业/状态),完整 Top 200
    }
    if (state.ranksType === 'ai') {
      const list = D.buildAll().list.map(s => {
        let rep = null;
        try { rep = AI.analyze(s); } catch (e) { rep = null; }
        return { s: s, rep: rep };
      }).filter(x => x.rep).sort((a, b) => b.rep.overall_score - a.rep.overall_score);
      return { ai: list };
    }
    return mockRanks();
  }
  function renderRanks() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      const type = state.ranksType || 'up';
      const ranks = ranksSource();
      const list = ranks[type] || [];
      const pageSize = 25;
      const pages = Math.max(1, Math.ceil(list.length / pageSize));
      if (!state.ranksPage || state.ranksPage > pages) state.ranksPage = 1;
      const rows = list.slice((state.ranksPage - 1) * pageSize, state.ranksPage * pageSize);
      const meta = RANK_TABS.find(t => t[0] === type) || RANK_TABS[0];
      const isAi = type === 'ai';
      // AI 评估榜:进入时预取评分所需数据(已有缓存则秒回)
      if (isAi && state.realMode && QP.real) {
        QP.real.ensureKlineAll().catch(() => {});
        QP.real.ensureFinAll().catch(() => {});
      }
      const headSub = isAi
        ? '规则引擎评分(基于东方财富真实数据)· 样本池 ' + list.length + ' 只 · 每 3 秒自动刷新'
        : (state.realMode ? '全市场 ' + (QP.real.store.marketAll.total || '') + ' 只 · Top 200' : '精选池') + ' · 每 3 秒自动刷新';
      const bodyHtml = isAi ? aiTableHtml(rows, state.ranksPage, pageSize) : normTableHtml(rows, state.ranksPage, pageSize);
      $('#content').innerHTML =
        pageHead('榜单中心', headSub,
          srcChip() + ' <span class="chip gray" id="rkCount">' + meta[1] + ' ' + list.length + ' 只</span>' +
          (isAi ? '<button class="btn primary" data-act="ai-review">📊 评分复盘</button>' : '')) +
        '<div class="tabs">' + RANK_TABS.map(t =>
          '<button class="' + (t[0] === type ? 'on' : '') + '" data-act="rank-tab" data-type="' + t[0] + '">' + t[1] + '</button>').join('') +
        '</div>' +
        '<div class="panel"><div class="table-wrap"><table class="grid"><thead><tr>' + (isAi ? AI_TH : NORM_TH) +
        '</tr></thead><tbody id="rkBody">' + bodyHtml +
        '</tbody></table></div>' +
        (list.length === 0 ? '<div class="empty-state" style="padding:40px"><div class="e-ico">📊</div><div class="e-t">暂无可展示的榜单数据</div><div class="e-s">非交易时段榜单可能为空,开盘后自动恢复</div></div>' : '') +
        pagerHTML(state.ranksPage, pages, 'ranks') +
        '</div>' +
        (isAi ? '<div id="aiReview"></div>' : '') +
        (isAi ? riskNote('AI 评估榜基于「精选样本池」的真实数据(行情/技术指标/财务/资金/新闻)由本地规则引擎计算评分,非投资建议;数据维度未加载时按中性计分,评分随数据每 3 秒更新。') : '') +
        riskNote() +
        '<div class="page-foot">' + (isAi ? 'AI 综合评分 = 30%×基本面 + 28%×技术面 + 17%×资金面 + 10%×新闻面 + 15%×(100-风险)' : '榜单为全市场真实排序') + ' · 每 3 秒自动刷新(无需手动刷新页面) · 数据截止 ' + D.DATA_TIME + ' · 不构成投资建议</div>';
    }, 240);
  }
  const NORM_TH = '<th>#</th><th>代码</th><th>名称</th><th>行业</th><th class="num">最新价</th><th class="num">涨跌幅</th><th class="num">涨跌额</th>' +
    '<th class="num">成交额</th><th class="num">换手率</th><th class="num">量比</th><th class="num">PE</th><th class="num">总市值</th>';
  function normTableHtml(rows, page, pageSize) {
    return rows.map((s, i) => {
      const q = s.quote;
      const px = q.price != null ? nf(q.price) : nf(q.prevClose);
      return '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '">' +
        '<td><span class="rank-badge rank-' + Math.min((page - 1) * pageSize + i + 1, 3) + '">' + ((page - 1) * pageSize + i + 1) + '</span></td>' +
        '<td><span class="num">' + s.code + '</span></td><td>' + esc(s.name) + (s.status === 'ST' ? ' <span class="chip red" style="padding:0 6px;font-size:10px">ST</span>' : '') + '</td>' +
        '<td class="muted" style="font-size:11.5px">' + (s.industry || '--') + '</td>' +
        '<td class="num" data-c="price">' + px + '</td>' +
        '<td class="num" data-c="chgPct">' + pctSpan(q.chgPct) + '</td>' +
        '<td class="num" data-c="chg">' + (q.chg != null ? (q.chg >= 0 ? '+' : '') + q.chg.toFixed(2) : '--') + '</td>' +
        '<td class="num" data-c="amount">' + (q.amount ? fmt(q.amount) : '--') + '</td>' +
        '<td class="num" data-c="turnover">' + (q.turnover != null ? q.turnover.toFixed(2) + '%' : '--') + '</td>' +
        '<td class="num" data-c="volRatio">' + nf(q.volRatio) + '</td>' +
        '<td class="num">' + (q.pe != null ? q.pe.toFixed(1) : '--') + '</td>' +
        '<td class="num">' + (q.mcap != null ? fmtBig(q.mcap) : '--') + '</td>' +
        '</tr>';
    }).join('');
  }
  const AI_TH = '<th>#</th><th>代码</th><th>名称</th><th>行业</th><th class="num">综合评分</th><th>趋势</th><th>风险</th>' +
    '<th class="num">基本面</th><th class="num">技术面</th><th class="num">资金面</th><th class="num">新闻面</th><th class="num">最新价</th><th class="num">涨跌幅</th>';
  function aiTableHtml(rows, page, pageSize) {
    return rows.map((x, i) => {
      const s = x.s, rep = x.rep, q = s.quote;
      const trendCls = rep.trend === '强势' || rep.trend === '偏强' ? 'green' : rep.trend === '中性' ? 'gray' : 'red';
      const riskCls = rep.risk_level === '高' ? 'red' : rep.risk_level === '中' ? 'gold' : 'green';
      return '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '">' +
        '<td><span class="rank-badge rank-' + Math.min((page - 1) * pageSize + i + 1, 3) + '">' + ((page - 1) * pageSize + i + 1) + '</span></td>' +
        '<td><span class="num">' + s.code + '</span></td><td>' + esc(s.name) + (s.status === 'ST' ? ' <span class="chip red" style="padding:0 6px;font-size:10px">ST</span>' : '') + '</td>' +
        '<td class="muted" style="font-size:11.5px">' + (s.industry || '--') + '</td>' +
        '<td class="num" data-c="score"><b class="' + scoreCls(rep.overall_score) + '">' + rep.overall_score + '</b></td>' +
        '<td><span class="chip ' + trendCls + '" data-c="trend">' + rep.trend + '</span></td>' +
        '<td><span class="chip ' + riskCls + '" data-c="risk">' + rep.risk_level + '</span></td>' +
        '<td class="num" data-c="f">' + rep.fundamental_score + '</td>' +
        '<td class="num" data-c="t">' + rep.technical_score + '</td>' +
        '<td class="num" data-c="c">' + rep.capital_score + '</td>' +
        '<td class="num" data-c="n">' + rep.news_score + '</td>' +
        '<td class="num" data-c="price">' + (q.price != null ? nf(q.price) : nf(q.prevClose)) + '</td>' +
        '<td class="num" data-c="chgPct">' + pctSpan(q.chgPct) + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ============ AI 评分复盘:评分与涨幅的相关性分析 ============ */
  function snapshot5(s) {
    const kl = s.kline;
    if (!kl || kl.length < 35) return null;
    const cut = kl.length - 5;
    const kl5 = kl.slice(0, cut);
    if (kl5.length < 30) return null;
    const ind5 = D.calcIndicators(kl5);
    const m = kl5.length - 1;
    const last = kl5[m], prev = kl5[m - 1];
    const highs = kl5.map(b => b.high), lows = kl5.map(b => b.low);
    const q5 = Object.assign({}, s.quote, {
      price: last.close,
      chg: +(last.close - prev.close).toFixed(2),
      chgPct: +((last.close / prev.close - 1) * 100).toFixed(2),
      open: last.open, high: last.high, low: last.low, prevClose: prev.close,
      volume: last.volume, amount: last.amount,
      high52: Math.max.apply(null, highs.slice(-250)),
      low52: Math.min.apply(null, lows.slice(-250)),
      high60: Math.max.apply(null, highs.slice(-60)),
      volRatio: +(last.volume / (ind5.volMa5[m] || last.volume)).toFixed(2),
      amplitude: +((last.high - last.low) / prev.close * 100).toFixed(2)
    });
    return Object.assign({}, s, { quote: q5, kline: kl5, ind: ind5, _snap5: true });
  }
  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx = 0, dy = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - mx) * (ys[i] - my);
      dx += (xs[i] - mx) * (xs[i] - mx);
      dy += (ys[i] - my) * (ys[i] - my);
    }
    if (dx === 0 || dy === 0) return null;
    return +(num / Math.sqrt(dx * dy)).toFixed(3);
  }
  function linreg(xs, ys) {
    const n = xs.length;
    if (n < 3) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
    if (den === 0) return null;
    const a = num / den, b = my - a * mx;
    return { a: +a.toFixed(3), b: +b.toFixed(2) };
  }
  async function buildAIReview() {
    const box = $('#aiReview');
    if (!box) return;
    box.innerHTML = '<div class="empty-state" style="padding:26px"><div class="e-ico">⏳</div><div class="e-t">正在计算评分复盘…</div><div class="e-s">基于真实K线与评分模型(样本池),首次需加载历史数据</div></div>';
    const pool = state.realMode && QP.real ? QP.real.poolList() : D.buildAll().list;
    if (state.realMode && QP.real) {
      box.innerHTML = '<div class="empty-state" style="padding:26px"><div class="e-ico">⏳</div><div class="e-t">正在加载历史K线数据(首次约1分钟,之后走缓存)…</div></div>';
      await QP.real.ensureKlineAll(pool.map(s => s.code));
    }
    box.innerHTML = '<div class="empty-state" style="padding:26px"><div class="e-ico">🧮</div><div class="e-t">正在计算评分与相关性…</div></div>';
    const rows = [];
    pool.forEach(s => {
      const kl = s.kline;
      if (!kl || kl.length < 30) return;
      const n = kl.length;
      const chg1 = (kl[n - 1].close / kl[n - 2].close - 1) * 100;
      const chg5 = (kl[n - 1].close / kl[n - 6].close - 1) * 100;
      let rep = null, rep5 = null;
      try { rep = AI.analyze(s); } catch (e) { }
      try {
        const snap = snapshot5(s);
        if (snap) rep5 = AI.analyze(snap); // 5日前快照评分(资金/新闻为近似)
      } catch (e) { }
      if (!rep) return;
      rows.push({ code: s.code, name: s.name, score: rep.overall_score, score5: rep5 ? rep5.overall_score : null, chg1: chg1, chg5: chg5, trend: rep.trend });
    });
    if (rows.length < 5) {
      box.innerHTML = '<div class="empty-state" style="padding:26px"><div class="e-t">样本不足,无法复盘</div></div>';
      return;
    }
    const r1 = pearson(rows.map(r => r.score), rows.map(r => r.chg1));
    const r5 = pearson(rows.map(r => r.score), rows.map(r => r.chg5));
    const pred = rows.filter(r => r.score5 != null);
    const rPred = pearson(pred.map(r => r.score5), pred.map(r => r.chg5));
    const lr = linreg(pred.map(r => r.score5), pred.map(r => r.chg5));
    const buckets = [[0, 40, '低分组(<40)'], [40, 60, '中分组(40-60)'], [60, 80, '偏高分组(60-80)'], [80, 101, '高分组(≥80)']];
    const bStats = buckets.map(([lo, hi, label]) => {
      const grp = rows.filter(r => r.score >= lo && r.score < hi);
      const avg5 = grp.length ? +(grp.reduce((a, r) => a + r.chg5, 0) / grp.length).toFixed(2) : null;
      return { label: label, lo: lo, hi: hi, cnt: grp.length, avg5: avg5 };
    }).filter(x => x.cnt > 0);
    const hiAvg = bStats.length ? (bStats[bStats.length - 1].avg5) : null;
    const loAvg = bStats.length ? (bStats[0].avg5) : null;
    const cell = (l, v, cls) => '<div class="panel bt-cell"><div class="bc-l">' + l + '</div><div class="bc-v ' + (cls || '') + '">' + v + '</div></div>';
    const fmtR = v => v == null ? '--' : v.toFixed(3);
    box.innerHTML =
      '<div class="panel mt-16" style="border-color:rgba(34,211,238,.3)"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>AI 评分复盘(样本池 ' + rows.length + ' 只 · 真实K线)</div>' +
      '<div class="panel-tools"><span class="chip gray">相关性 = 线性相关程度,越接近 1 越强</span></div></div>' +
      '<div class="panel-body">' +
      '<div class="bt-metrics">' +
      cell('评分 ↔ 当日涨幅 相关系数', fmtR(r1), (r1 != null && r1 > 0) ? 'up-txt' : '') +
      cell('评分 ↔ 近5日涨幅 相关系数', fmtR(r5), (r5 != null && r5 > 0) ? 'up-txt' : '') +
      cell('5日前评分 → 近5日涨幅 相关系数', fmtR(rPred), (rPred != null && rPred > 0) ? 'up-txt' : '') +
      cell('高分组(≥80)平均近5日涨幅', hiAvg != null ? hiAvg + '%' : '--', hiAvg != null ? (hiAvg >= 0 ? 'up-txt' : 'down-txt') : '') +
      cell('低分组(<40)平均近5日涨幅', loAvg != null ? loAvg + '%' : '--', loAvg != null ? (loAvg >= 0 ? 'up-txt' : 'down-txt') : '') +
      cell('线性回归(5日前评分→涨幅)', lr ? ('y=' + lr.a + 'x' + (lr.b >= 0 ? '+' : '') + lr.b + '%') : '--', '') +
      '</div>' +
      '<div class="grid-2 mt-16">' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>评分分组 vs 平均近5日涨幅</div></div>' +
      '<div class="panel-body"><div class="chart" id="chart-review-bucket" style="height:240px"></div></div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>5日前评分 vs 近5日涨幅(散点+回归)</div></div>' +
      '<div class="panel-body"><div class="chart" id="chart-review-scatter" style="height:240px"></div></div></div>' +
      '</div>' +
      '<div class="mt-16" style="font-size:12.5px;color:var(--txt-2);line-height:2">' +
      '<b style="color:var(--txt-1)">复盘结论</b>: ' +
      (rPred == null ? '样本不足,无法判断线性关系。' :
        (rPred > 0.3 ? '5日前评分与近5日涨幅呈<b class="up-txt">明显正相关</b>(r=' + fmtR(rPred) + '),评分越高涨幅表现越好,线性关系成立。' :
          rPred > 0 ? '5日前评分与近5日涨幅呈<b>弱正相关</b>(r=' + fmtR(rPred) + '),方向正确但强度有限。' :
            '5日前评分与近5日涨幅相关性不明显(r=' + fmtR(rPred) + '),评分更侧重基本面/风险描述,而非短期涨幅预测。')) +
      (hiAvg != null && loAvg != null ? ' 高分组平均近5日涨幅 ' + hiAvg + '%,低分组 ' + loAvg + '%,相差 <b>' + (hiAvg - loAvg).toFixed(2) + ' 个百分点</b>。' : '') +
      '<br><span class="muted">评分含动量因子(近5日涨幅),与涨幅保持线性正相关;复盘为统计描述,不构成投资建议;5日前快照的资金/新闻维度为近似值。</span>' +
      '</div>' +
      '</div></div>';
    // 分桶柱状图
    if (window.echarts) {
      chart($('#chart-review-bucket'), {
        grid: { left: 10, right: 14, top: 30, bottom: 4, containLabel: true },
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)', textStyle: { color: '#e9eef8' }, valueFormatter: v => v + '%' },
        xAxis: { type: 'category', data: bStats.map(b => b.label + '(' + b.cnt + ')'), axisLabel: { color: '#9ba8c9', fontSize: 11 }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
        yAxis: { type: 'value', axisLabel: { color: '#5f6d92', formatter: v => v + '%' }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
        series: [{
          type: 'bar', data: bStats.map(b => b.avg5), barWidth: 42,
          itemStyle: { color: p => p.value >= 0 ? 'rgba(246,70,93,.85)' : 'rgba(46,189,133,.85)', borderRadius: 4 },
          label: { show: true, position: 'top', color: '#e9eef8', formatter: p => (p.value == null ? '--' : p.value + '%') }
        }]
      });
      // 散点 + 回归线
      const pts = pred.map(r => [r.score5, +r.chg5.toFixed(2)]);
      const line = lr ? [[40, +(lr.a * 40 + lr.b).toFixed(2)], [100, +(lr.a * 100 + lr.b).toFixed(2)]] : [];
      chart($('#chart-review-scatter'), {
        grid: { left: 10, right: 14, top: 16, bottom: 4, containLabel: true },
        tooltip: { trigger: 'item', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)', textStyle: { color: '#e9eef8' }, formatter: p => '评分 ' + p.value[0] + ' → 近5日涨幅 ' + p.value[1] + '%' },
        xAxis: { type: 'value', name: '5日前评分', min: 20, max: 100, nameTextStyle: { color: '#5f6d92' }, axisLabel: { color: '#5f6d92' }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
        yAxis: { type: 'value', name: '近5日涨幅%', nameTextStyle: { color: '#5f6d92' }, axisLabel: { color: '#5f6d92' }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
        series: [
          { name: '个股', type: 'scatter', data: pts, symbolSize: 7, itemStyle: { color: p => p.value[1] >= 0 ? 'rgba(246,70,93,.65)' : 'rgba(46,189,133,.65)' } },
          { name: '回归线', type: 'line', data: line, symbol: 'none', lineStyle: { width: 2, color: '#22d3ee', type: 'dashed' }, itemStyle: { color: '#22d3ee' } }
        ]
      });
    }
  }
  function updateRanksLive() {
    const tb = $('#rkBody');
    if (!tb) return;
    const type = state.ranksType || 'up';
    const ranks = ranksSource();
    const list = ranks[type] || [];
    const pageSize = 25;
    const rows = list.slice((state.ranksPage - 1) * pageSize, state.ranksPage * pageSize);
    const cnt = $('#rkCount');
    if (cnt) cnt.textContent = (RANK_TABS.find(t => t[0] === type) || RANK_TABS[0])[1] + ' ' + list.length + ' 只';
    if (type === 'ai') {
      // AI 榜:评分随行情变化,整体重排重绘(保持降序与评分一致)
      _aiRankCache = null; // 强制重算排序
      const ranks2 = ranksSource();
      const list2 = ranks2.ai || [];
      const rows2 = list2.slice((state.ranksPage - 1) * pageSize, state.ranksPage * pageSize);
      if (rows2.length) tb.innerHTML = aiTableHtml(rows2, state.ranksPage, pageSize);
      if (cnt) cnt.textContent = 'AI评估榜 ' + list2.length + ' 只';
      return;
    }
    rows.forEach((s) => {
      const row = tb.querySelector('tr[data-code="' + s.code + '"]');
      if (!row) return;
      const q = s.quote;
      const set = (c, html) => { const cell = row.querySelector('td[data-c="' + c + '"]'); if (cell) { cell.innerHTML = html; flashCell(cell, q.chgPct >= 0); } };
      set('price', q.price != null ? nf(q.price) : nf(q.prevClose));
      set('chgPct', pctSpan(q.chgPct));
      set('chg', q.chg != null ? ((q.chg >= 0 ? '+' : '') + q.chg.toFixed(2)) : '--');
      set('amount', q.amount ? fmt(q.amount) : '--');
      set('turnover', q.turnover != null ? q.turnover.toFixed(2) + '%' : '--');
      set('volRatio', nf(q.volRatio));
    });
  }

  /* ============================ 页面:AI 预测选股(全市场 5000+) ============================ */
  const PRED_DIMS = [['composite', '综合评分'], ['prob', '上涨概率'], ['ret', '预期收益'], ['excess', '超额收益'], ['rr', '风险收益比'], ['conf', '高置信度'], ['lowvol', '低波动机会']];
  function predProbCell(p, h) {
    const v = p['p' + h];
    const cls = v >= 55 ? 'up-txt' : v >= 40 ? 'muted' : 'down-txt';
    const fg = v >= 55 ? 'var(--up)' : v >= 40 ? 'var(--gold)' : 'var(--down)';
    return '<div class="prob-cell"><b class="num" style="color:' + fg + '">' + v + '%</b>' +
      '<span class="prob-bar"><i style="width:' + Math.min(100, Math.max(3, v)) + '%"></i></span></div>';
  }
  function predRetSpan(v) {
    if (v == null) return '<span class="num muted">--</span>';
    const cls = v > 0 ? 'up-txt' : v < 0 ? 'down-txt' : 'muted';
    return '<span class="num ' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>';
  }
  function predDDSpan(v) {
    return '<span class="num down-txt">-' + (v == null ? '--' : v.toFixed(1)) + '%</span>';
  }
  /* ---------------- AI 智能分析(合并页:预测选股 / 个股诊断) ----------------
   * 两个功能同属"AI 分析",合并为一个页面下的两个分页,避免左侧菜单重复入口;
   * 路由 #/predict 与 #/ai 均保留(旧链接、测试与深链继续可用)。 */
  const AI_HUB_TABS = [['predict', 'AI 预测选股'], ['diag', 'AI 牛股诊断']];
  function aiHubTabs(active) {
    return '<div class="hub-tabs">' + AI_HUB_TABS.map(t =>
      '<button class="' + (t[0] === active ? 'on' : '') + '" data-act="ai-hub-tab" data-tab="' + t[0] + '">' + t[1] + '</button>'
    ).join('') + '</div>';
  }
  function renderPredict() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    (async () => {
      try {
        if (token !== state.renderToken) return;
        const P = QP.predict;
        if (!P) {
          $('#content').innerHTML = '<div class="empty-state" style="padding:60px"><div class="e-ico">🧠</div><div class="e-t">预测引擎未加载</div></div>';
          return;
        }
        /* 生成/读取预测快照前,先与服务端台账对账(限时 2.5s):避免本地凭旧缓存重复生成当日快照。
           对账已完成或超时都继续渲染,不阻塞页面。 */
        if (QP.real && QP.real.hydrateSnapshots && !state._snapHydrated) {
          state._snapHydrated = true;
          const hy = QP.real.hydrateSnapshots();
          await Promise.race([hy.catch(() => null), new Promise(res => setTimeout(() => res(null), 2500))]);
          if (token !== state.renderToken) return;
          /* 若是超时后才完成对账,回来刷新复盘面板 */
          hy.then(() => {
            if (location.hash.indexOf('#/predict') === 0) { renderPredReview(); renderPredHistory(); }
          }).catch(() => { });
        }
        const daily = P.ensureDailyPrediction();                  // 按生效交易日读取/生成(盘中锁定,盘前盘后可变更)
        if (token !== state.renderToken) return;
        renderPredictContent(daily);
        if (!daily.locked) bgKlinePrefetch(daily);                // 非锁定时段后台预取技术指标(不影响首屏)
      } catch (err) {
        console.error('预测页渲染失败:', err);
        if (token !== state.renderToken) return;
        $('#content').innerHTML =
          '<div class="panel"><div class="panel-body center" style="padding:50px 20px">' +
          '<div style="font-size:40px">⚠️</div>' +
          '<div style="font-size:16px;margin-top:14px;color:var(--txt-1)">预测页加载失败</div>' +
          '<div class="muted" style="margin-top:10px;font-size:12.5px;line-height:2">可能是本地保存的旧版预测数据不兼容导致。<br>可点击下方按钮清除预测快照后重新生成。</div>' +
          '<button class="btn primary mt-16" data-act="pred-reset">🧹 清除预测快照并重试</button>' +
          '</div></div>';
      }
    })();
  }
  function renderPredictContent(daily) {
    const P = QP.predict;
    const st = state.predict;
    const frozen = daily.top || [];                               // 当日锁定的总榜前100(完整预测对象)
    const ranked = P.rankDim(frozen, st.dim);                     // 各维度仅对锁定前100重排
    const filtered = st.sector ? ranked.filter(p => p.industry === st.sector) : ranked;  // 板块:只从总榜前100中选
    const pageSize = 25;
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      if (st.page > pages) st.page = 1;
      const rows = filtered.slice((st.page - 1) * pageSize, st.page * pageSize);
      const h = st.horizon;
      const rg = daily.regime || {};
      const dimMeta = PRED_DIMS.find(d => d[0] === st.dim) || PRED_DIMS[0];
      const regimeChip = rg.regime === '强势' ? '<span class="chip red">市场:强势 🔥</span>'
        : rg.regime === '震荡' ? '<span class="chip gray">市场:震荡</span>'
        : '<span class="chip green">市场:' + (rg.regime || '--') + '</span>';
      const top10 = filtered.slice(0, 10);
      const topAvgScore = top10.length ? +(top10.reduce((a, p) => a + p.score, 0) / top10.length).toFixed(1) : 0;

      const kpiHTML = '<div class="kpis">' +
        predKpi('预测样本', '<span class="num">' + daily.market.count + '</span>', '全 A 股(锁定快照)', 'amt', 'M3 3v18h18M7 15l4-6 4 3 5-8') +
        predKpi('平均上涨概率', '<span class="num" id="pdAvgProb">' + daily.market.avgProb + '%</span>', '未来 ' + h + ' 日涨超 ' + P.TH['p' + h] + '%', 'prob', 'M12 2a7 7 0 0 1 7 7c0 2.4-1.2 4.5-3 5.7V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.3C6.2 13.5 5 11.4 5 9a7 7 0 0 1 7-7z') +
        predKpi('平均预期收益', '<span class="num" id="pdAvgRet">' + (daily.market.avgRet >= 0 ? '+' : '') + daily.market.avgRet + '%</span>', '未来 ' + h + ' 日(规则模型)', 'ret', 'M3 17l5-5 4 3 6-7M14 8h4v4') +
        predKpi('高概率(≥60%)', '<span class="num" id="pdHiProb">' + daily.market.hiProb + '</span>', '只 · 上涨概率高于 60%', 'limit', 'M13 2L3 14h9l-1 8 10-12h-9z') +
        predKpi('Top10 综合评分', '<span class="num" id="pdTopScore">' + topAvgScore + '</span>', '当前「' + dimMeta[1] + '」榜前 10 均值', 'temp', 'M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M19.1 4.9l-2.8 2.8M7.7 16.3l-2.8 2.8') +
        '</div>';
      function predKpi(label, val, sub, tone, ico) {
        const bg = { prob: 'rgba(245,34,45,.15)', ret: 'rgba(245,179,1,.15)', limit: 'rgba(245,179,1,.16)', amt: 'rgba(245,179,1,.14)', temp: 'rgba(181,155,255,.16)' }[tone];
        const fg = { prob: 'var(--up)', ret: 'var(--gold)', limit: 'var(--gold)', amt: 'var(--gold)', temp: 'var(--violet)' }[tone];
        return '<div class="panel hoverable kpi"><div class="k-label">' + label + '</div>' +
          '<div class="k-value">' + val + '</div><div class="k-sub">' + sub + '</div>' +
          '<div class="k-ico" style="background:' + bg + ';color:' + fg + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="' + ico + '"/></svg></div></div>';
      }

      const sectorOpts = P.sectorStatsCached(300000).slice().sort((a, b) => b.count - a.count)
        .map(s => '<option value="' + esc(s.name) + '"' + (st.sector === s.name ? ' selected' : '') + '>' + esc(s.name) + ' (' + s.count + ')</option>').join('');
      const toolbar = '<div class="panel mb-16"><div class="panel-body">' +
        '<div class="flex items-center gap-12" style="flex-wrap:wrap">' +
        '<div class="flex items-center gap-8">' +
        '<span class="muted" style="font-size:12px">预测周期</span>' +
        [5, 10, 20].map(x => '<button class="btn sm ' + (h === x ? 'primary' : '') + '" data-act="predict-horizon" data-h="' + x + '">' + x + ' 日</button>').join('') +
        '</div>' +
        '<div class="flex items-center gap-8">' +
        '<span class="muted" style="font-size:12px">行业</span>' +
        '<select class="select" data-act="predict-sector" style="width:170px;padding:5px 26px 5px 10px;font-size:12px">' +
        '<option value="">全部行业(总榜前100内)</option>' + sectorOpts + '</select>' +
        '</div>' +
        '<div class="flex items-center gap-8" style="font-size:12px;color:var(--txt-2);flex-wrap:wrap">' +
        '<label class="flex items-center gap-4"><input type="checkbox" data-act="predict-filter" data-f="st" ' + (st.filters.st ? 'checked' : '') + '>剔除ST</label>' +
        '<label class="flex items-center gap-4"><input type="checkbox" data-act="predict-filter" data-f="suspend" ' + (st.filters.suspend ? 'checked' : '') + '>剔除停牌</label>' +
        '<label class="flex items-center gap-4"><input type="checkbox" data-act="predict-filter" data-f="liquid" ' + (st.filters.liquid ? 'checked' : '') + '>剔除低流动性</label>' +
        '</div>' +
        '<div style="margin-left:auto" class="flex items-center gap-8">' +
        (daily.locked
          ? '<span class="chip gold" title="开盘(9:30)后至收盘(15:00)前预测锁定,不可变更">🔒 盘中已锁定(开盘后-收盘前不可变更)</span>'
          : '<span class="chip gold">🧪 预测目标:' + daily.label + '(收盘后-次日开盘前可变更)</span>' +
            '<button class="btn" data-act="predict-run">🔄 重新预测</button>') +
        '</div>' +
        '</div></div></div>';

      const th = '<tr><th>#</th><th>代码</th><th>名称</th><th>行业</th>' +
        '<th class="num">现价</th><th class="num">涨跌幅</th>' +
        '<th class="num">上涨概率 P' + h + '</th><th class="num">预期收益 R' + h + '</th>' +
        '<th class="num">超额收益 E' + h + '</th><th class="num">预期回撤</th>' +
        '<th class="num">综合评分</th><th class="num">置信度</th>' +
        '<th>主要正向因素</th><th>风险</th></tr>';
      const body = rows.map((p, i) => {
        const rank = (st.page - 1) * pageSize + i + 1;
        const cls = rank === 1 ? 'rank-1' : rank === 2 ? 'rank-2' : rank === 3 ? 'rank-3' : 'rank-n';
        const posHtml = (p.pos || []).map(x => '<span class="chip" style="padding:1px 7px;font-size:10.5px;margin:1px">' + esc(x) + '</span>').join('');
        const riskHtml = (p.risks || []).length ? p.risks.map(x => '<span class="chip red" style="padding:1px 7px;font-size:10.5px;margin:1px">' + esc(x) + '</span>').join('') : '<span class="muted" style="font-size:11px">--</span>';
        return '<tr class="clickable" data-act="goto-stock" data-code="' + p.code + '">' +
          '<td><span class="rank-badge ' + cls + '">' + rank + '</span></td>' +
          '<td><span class="num">' + p.code + '</span></td>' +
          '<td>' + esc(p.name) + (p.status === 'ST' ? ' <span class="chip red" style="padding:0 6px;font-size:10px">ST</span>' : '') + '</td>' +
          '<td class="muted" style="font-size:11.5px">' + esc(p.industry) + '</td>' +
          '<td class="num" data-c="price">' + priceSpan(p.price) + '</td>' +
          '<td class="num" data-c="chgPct">' + pctSpan(p.chgPct) + '</td>' +
          '<td class="num" data-c="prob">' + predProbCell(p, h) + '</td>' +
          '<td class="num" data-c="ret">' + predRetSpan(p['ret' + h]) + '</td>' +
          '<td class="num" data-c="excess">' + predRetSpan(p['excess' + h]) + '</td>' +
          '<td class="num" data-c="dd">' + predDDSpan(p.expDD) + '</td>' +
          '<td class="num" data-c="score"><b class="' + scoreCls(p.score) + '">' + p.score.toFixed(1) + '</b></td>' +
          '<td class="num" data-c="conf">' + p.confidence + (p.tech ? '<span title="已加载技术指标增强" style="color:var(--gold)">✦</span>' : '') + '</td>' +
          '<td style="max-width:210px">' + posHtml + '</td>' +
          '<td style="max-width:150px">' + riskHtml + '</td>' +
          '</tr>';
      }).join('');
      const tabs = '<div class="tabs">' + PRED_DIMS.map(d =>
        '<button class="' + (d[0] === st.dim ? 'on' : '') + '" data-act="predict-tab" data-dim="' + d[0] + '">' + d[1] + '</button>').join('') + '</div>';

      $('#content').innerHTML =
        pageHead('AI 智能分析', '预测选股 · 全 A 股 ' + daily.market.count + ' 只 · 预测目标交易日 ' + daily.label +
          (daily.locked ? ' · 🔒 盘中锁定' : ' · 🧪 可变更') + ' · 模型 ' + daily.modelVersion + ' · 预测截止 ' + daily.dataAsOf +
          ' · ' + (state.realMode ? '东方财富准实时' : '模拟环境'),
          srcChip() + regimeChip +
          '<span class="chip gray">' + dimMeta[1] + ' ' + filtered.length + ' 只</span>' +
          '<span class="chip gold">🧠 规则概率模型</span>') +
        aiHubTabs('predict') +
        kpiHTML +
        toolbar +
        '<div class="grid-2 mb-16">' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>上涨概率分布(P' + h + ')</div></div><div class="panel-body"><div class="chart" id="chart-pred-prob" style="height:190px"></div></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>综合评分分布</div></div><div class="panel-body"><div class="chart" id="chart-pred-score" style="height:190px"></div></div></div>' +
        '</div>' +
        tabs +
        '<div class="panel"><div class="table-wrap"><table class="grid"><thead>' + th +
        '</thead><tbody id="pdBody">' + body +
        '</tbody></table></div>' +
        (filtered.length === 0 ? '<div class="empty-state" style="padding:40px"><div class="e-ico">🧠</div><div class="e-t">当前筛选条件下无符合条件的股票</div><div class="e-s">板块筛选仅在总榜前100内生效,可切换行业后重试</div></div>' : '') +
        pagerHTML(st.page, pages, 'predict') +
        '</div>' +
        '<div id="predHistory"></div>' +
        '<div id="predReview"></div>' +
        riskNote('AI 预测选股为透明规则概率模型(非机器学习),基于预测时点已公开的行情/行业/市场环境数据计算,仅供研究参考;不承诺收益,不构成投资建议。预测规则:开盘(9:30)后至收盘(15:00)前锁定不可变更;收盘后自动复盘当日预测,并生成下一交易日预测(收盘后至次日开盘前可重新预测)。') +
        '<div class="page-foot">综合评分 = ' + (daily.weights.prob * 100) + '%×上涨概率 + ' + (daily.weights.ret * 100) + '%×预期收益 + ' + (daily.weights.excess * 100) + '%×超额收益 + ' + (daily.weights.sector * 100) + '%×行业强度 - ' + (daily.weights.risk * 100) + '%×风险 · 上涨事件:未来 ' + h + ' 日收益 &gt; ' + P.TH['p' + h] + '% · 模型 ' + daily.modelVersion + ' · 不构成投资建议</div>';

      drawPredCharts(frozen, h);
      // 复盘面板:始终渲染快照列表(含今日锁定);收盘后 autoReview 自动加载历史K线并对照实际表现
      renderPredReview();
      autoReview();
      // 累计长期胜率:先渲染(可能暂无数据),再在后台有界预取历史K线后刷新
      renderPredHistory();
      prefetchHistoryKlines();
  }
  /* ---------------- 累计长期胜率(跨快照汇总) ----------------
   * 单快照只看一次结果;汇总历史才能判断"模型是否稳定、是否在退化"。 */
  function renderPredHistory() {
    const box = $('#predHistory');
    if (!box || !QP.predict || !QP.predict.reviewHistory) return;
    const h = state.predict.horizon || 5;
    const reviewN = state.predict.reviewN || 20;                 // 复盘样本:Top10 / Top20 / Top50 可选
    const agg = QP.predict.reviewHistory({ horizon: h, topN: reviewN, limit: 120 });
    const c = agg.cumulative;
    const chip = (label, val, cls) => '<span class="chip ' + (cls || '') + '">' + label + ' ' + val + '</span>';
    if (!c.snapshots) {
      box.innerHTML = '<div class="panel mt-16"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>累计胜率趋势(近 ' + h + ' 日周期)</div></div>' +
        '<div class="panel-body"><div class="empty-state" style="padding:26px"><div class="e-ico">📈</div>' +
        '<div class="e-t">暂无可统计的历史快照</div>' +
        '<div class="e-s">系统每个交易日自动生成一次预测快照并锁定;快照日之后需至少 3 个交易日的K线才能计入统计(已跳过 ' + c.skipped + ' 个未成熟快照)</div></div></div></div>';
      return;
    }    const hr = c.hitRate;
    const hrCls = hr == null ? 'gray' : hr >= 60 ? 'green' : hr >= 50 ? 'gold' : 'red';
    const biasCls = c.bias == null ? 'gray' : Math.abs(c.bias) <= 1 ? 'green' : Math.abs(c.bias) <= 3 ? 'gold' : 'red';
    box.innerHTML = '<div class="panel mt-16"><div class="panel-head">' +
      '<div class="panel-title"><span class="dot gold"></span>累计胜率趋势(近 ' + h + ' 日周期)</div>' +
      '<div class="panel-tools">' +
      '<span class="muted" style="font-size:11.5px;margin-right:6px">复盘样本</span>' +
      [10, 20, 50].map(n => '<button class="btn xs ' + (n === reviewN ? 'primary' : '') + '" data-act="review-n" data-n="' + n + '">Top' + n + '</button>').join(' ') +
      '<span class="chip gray" style="margin-left:8px">快照 ' + c.snapshots + ' 期</span>' +
      '<span class="chip gray">样本 ' + c.samples + ' 只</span></div></div>' +
      '<div class="panel-body">' +
      '<div class="flex gap-8 mb-16" style="flex-wrap:wrap">' +
      chip('累计命中率', hr == null ? '样本不足' : hr + '%', hrCls) +
      chip('滚动5期', agg.roll5 == null ? '--' : agg.roll5 + '%') +
      chip('滚动10期', agg.roll10 == null ? '--' : agg.roll10 + '%') +
      chip('平均预测', c.avgPred == null ? '--' : (c.avgPred > 0 ? '+' : '') + c.avgPred + '%') +
      chip('平均实际', c.avgAct == null ? '--' : (c.avgAct > 0 ? '+' : '') + c.avgAct + '%') +
      chip('预测偏差', c.bias == null ? '--' : (c.bias > 0 ? '+' : '') + c.bias + '%', biasCls) +
      '</div>' +
      '<div class="chart" id="chart-hist" style="height:220px"></div>' +
      '<div class="muted mt-8" style="font-size:11.5px;line-height:1.8">命中率 = 方向一致的比例(预测概率≥50%且实际上涨,或预测概率&lt;50%且实际未涨);' +
      '滚动命中率按样本数加权,避免样本少的快照被高估;周期 ' + c.first + ' ~ ' + c.last + '。' +
      (c.skipped ? '<br>另有 ' + c.skipped + ' 个快照因尚未走满 ' + h + ' 个交易日(或未加载K线)未计入。' : '') +
      '</div></div></div>';
    // 趋势图:命中率折线(左轴 0-100%) + 样本数柱(右轴)
    if (window.echarts) {
      chart($('#chart-hist'), {
        grid: { left: 44, right: 44, top: 20, bottom: 26 },
        tooltip: {
          trigger: 'axis', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)',
          textStyle: { color: '#e9eef8', fontSize: 12 },
          formatter: p => {
            const i = p[0].dataIndex, s = agg.series[i] || {};
            return s.label + '<br>命中率:' + (s.hitRate == null ? '--' : s.hitRate + '%') +
              '<br>样本:' + s.n + ' 只' +
              '<br>平均预测:' + (s.avgPred == null ? '--' : s.avgPred + '%') +
              '<br>平均实际:' + (s.avgAct == null ? '--' : s.avgAct + '%');
          }
        },
        xAxis: { type: 'category', data: agg.series.map(x => String(x.label).slice(5)), axisLabel: { color: '#9ba8c9', fontSize: 10 }, axisTick: { show: false }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
        yAxis: [
          { type: 'value', min: 0, max: 100, axisLabel: { color: '#5f6d92', fontSize: 10, formatter: '{value}%' }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.08)' } } },
          { type: 'value', min: 0, axisLabel: { color: '#5f6d92', fontSize: 10 }, splitLine: { show: false } }
        ],
        series: [
          { name: '样本数', type: 'bar', yAxisIndex: 1, data: agg.series.map(x => x.n), barWidth: '46%', itemStyle: { color: 'rgba(46,107,230,.28)', borderRadius: [3, 3, 0, 0] } },
          {
            name: '命中率', type: 'line', yAxisIndex: 0, data: agg.series.map(x => x.hitRate),
            smooth: true, symbolSize: 6, connectNulls: true,
            lineStyle: { width: 2.2, color: '#f5b301' }, itemStyle: { color: '#f5b301' },
            markLine: { silent: true, symbol: 'none', data: [{ yAxis: 50, lineStyle: { color: 'rgba(160,190,255,.45)', type: 'dashed' }, label: { formatter: '50%', color: '#9ba8c9', fontSize: 10 } }] }
          }
        ]
      });
    }
  }
  /* 有界预取历史快照K线(本地日缓存命中则秒回),供累计胜率统计使用 */
  let _histPrefetching = false;
  async function prefetchHistoryKlines() {
    if (_histPrefetching || !state.realMode || !QP.real || !QP.predict || !QP.predict.historyCodes) return;
    _histPrefetching = true;
    try {
      const reviewN = state.predict.reviewN || 20;
      /* 快照数随样本量收敛:样本越大,K线预取总量越需控制(上限 150 只) */
      const codes = QP.predict.historyCodes({ topN: reviewN, limit: reviewN >= 50 ? 6 : 12 });
      const need = codes.filter(c => { const st = D.getStock(c); return st && !st.kline; });
      if (!need.length) return;
      const batch = need.slice(0, 150);            // 单次最多 150 只,避免打爆上游接口
      const CONC = 4;
      for (let i = 0; i < batch.length; i += CONC) {
        await Promise.all(batch.slice(i, i + CONC).map(c => QP.real.ensureKline(c).catch(() => null)));
      }
      renderPredHistory();                          // 预取完成后刷新统计
    } finally { _histPrefetching = false; }
  }
  function drawPredCharts(list, h) {
    if (!window.echarts) return;
    const bins = (key) => {
      const out = [];
      for (let i = 0; i <= 100; i += 10) out.push({ b: i, n: 0 });
      list.forEach(p => { const v = Math.min(100, Math.max(0, p[key])); out[Math.min(10, Math.floor(v / 10))].n++; });
      return out.map(o => ({ name: o.b === 100 ? '100' : o.b + '-' + (o.b + 9), value: o.n }));
    };
    const probData = bins('p' + h);
    const scoreData = bins('score');
    chart($('#chart-pred-prob'), {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(46,22,24,.96)', borderColor: 'rgba(255,211,77,.28)', textStyle: { color: '#f8eee6', fontSize: 11 }, formatter: p => p[0].name + '%: ' + p[0].value + ' 只' },
      grid: { left: 44, right: 12, top: 14, bottom: 26 },
      xAxis: { type: 'category', data: probData.map(d => d.name), axisLabel: { color: '#a08279', fontSize: 10, interval: 1 }, axisLine: { lineStyle: { color: 'rgba(255,211,77,.15)' } } },
      yAxis: { type: 'value', axisLabel: { color: '#a08279', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,211,77,.07)' } } },
      series: [{ type: 'bar', data: probData.map(d => d.value), barWidth: '58%', itemStyle: { color: p => p.dataIndex >= 5 ? '#f5222d' : '#f5b301', borderRadius: [4, 4, 0, 0] } }]
    });
    chart($('#chart-pred-score'), {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: 'rgba(46,22,24,.96)', borderColor: 'rgba(255,211,77,.28)', textStyle: { color: '#f8eee6', fontSize: 11 }, formatter: p => '评分 ' + p[0].name + ': ' + p[0].value + ' 只' },
      grid: { left: 44, right: 12, top: 14, bottom: 26 },
      xAxis: { type: 'category', data: scoreData.map(d => d.name), axisLabel: { color: '#a08279', fontSize: 10, interval: 1 }, axisLine: { lineStyle: { color: 'rgba(255,211,77,.15)' } } },
      yAxis: { type: 'value', axisLabel: { color: '#a08279', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,211,77,.07)' } } },
      series: [{ type: 'bar', data: scoreData.map(d => d.value), barWidth: '58%', itemStyle: { color: p => p.dataIndex >= 6 ? '#2e6be6' : '#f5b301', borderRadius: [4, 4, 0, 0] } }]
    });
  }
  function updatePredictLive() {
    // 预测值来自当日锁定快照(不可修改);实时仅刷新现价/涨跌幅
    const tb = $('#pdBody');
    if (!tb) return;
    const rows = $$('#pdBody tr[data-code]');
    rows.forEach(row => {
      const s = D.getStock(row.dataset.code);
      if (!s) return;
      const q = s.quote;
      const set = (c, html) => { const cell = row.querySelector('td[data-c="' + c + '"]'); if (cell) cell.innerHTML = html; };
      set('price', priceSpan(q.price));
      set('chgPct', pctSpan(q.chgPct));
    });
  }
  function renderPredReview() {
    const box = $('#predReview');
    if (!box) return;
    const P = QP.predict;
    const snaps = P.loadSnapshots();
    if (!snaps.length) {
      box.innerHTML = '<div class="panel mt-16"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>预测快照与自动复盘</div></div>' +
        '<div class="panel-body"><div class="empty-state" style="padding:24px"><div class="e-t">暂无预测快照</div><div class="e-s">进入本页后系统会在每个交易日自动生成一次预测快照并锁定;收盘后自动对照实际表现复盘</div></div></div></div>';
      return;
    }
    box.innerHTML = '<div class="panel mt-16"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>预测快照与自动复盘(' + snaps.length + ')</div>' +
      '<div class="panel-tools"><span class="chip gray">收盘后自动对照真实K线复盘,无需人工操作</span></div></div><div class="panel-body">' +
      snaps.slice(0, 10).map(snap => reviewSnapCard(snap, P)).join('') + '</div></div>';
  }
  function reviewSnapCard(snap, P) {
    const reg = snap.regime || {};
    const regCls = reg.regime === '强势' ? 'red' : reg.regime === '震荡' ? 'gray' : 'green';
    const top5 = (snap.top || []).slice(0, 5).map(t => t.name).join('、');
    const avgProb = (snap.market && snap.market.avgProb != null) ? snap.market.avgProb + '%' : '--';
    const avgRet = (snap.market && snap.market.avgRet != null) ? snap.market.avgRet + '%' : '--';
    const isEffective = snap.label === P.effectiveTradeDate();
    // 生效日(今日盘中/盘前)快照无需计算实际表现;历史快照才做自动复盘(5/10/20 日周期)
    let sums = [], best = null, sumChips = '', tableHtml = '';
    if (!isEffective) {
      sums = [5, 10, 20].map(h => P.reviewSnapshotSummary(snap, h, state.predict.reviewN || 20));
      best = sums.slice().sort((a, b) => b.withAct.length - a.withAct.length)[0];
      sumChips = sums.filter(s => s.withAct.length).map(s =>
        '<span class="chip">R' + s.h + ' 命中' + (s.hitRate != null ? s.hitRate + '%' : '--') +
        ' · 预测' + (s.avgPred != null ? (s.avgPred > 0 ? '+' : '') + s.avgPred + '%' : '--') +
        ' · 实际' + (s.avgAct != null ? (s.avgAct > 0 ? '+' : '') + s.avgAct + '%' : '--') + '</span>').join('');
      tableHtml = (best && best.withAct.length)
        ? '<div class="table-wrap" style="margin-top:10px"><table class="grid rev-table"><thead><tr><th>代码</th><th>名称</th><th class="num">预测概率P' + best.h + '</th><th class="num">预测收益R' + best.h + '</th>' +
          '<th class="num">实际收益</th><th class="num">实际最大回撤</th><th>复盘结果</th></tr></thead><tbody>' +
          best.rows.map(r => {
            const hitTxt = r.act == null ? '<span class="chip gray">待验证</span>'
              : r.hit ? '<span class="chip green">命中 ✓</span>' : '<span class="chip red">未中 ✗</span>';
            return '<tr><td><span class="num">' + r.t.code + '</span></td><td>' + esc(r.t.name) + '</td>' +
              '<td class="num">' + (r.t['p' + best.h] != null ? r.t['p' + best.h] + '%' : '--') + '</td>' +
              '<td class="num">' + (r.t['ret' + best.h] != null ? ((r.t['ret' + best.h] > 0 ? '+' : '') + r.t['ret' + best.h] + '%') : '--') + '</td>' +
              '<td class="num">' + (r.act ? ((r.act.ret > 0 ? '<span class="up-txt">+' : '<span class="down-txt">') + r.act.ret + '%</span>') : '--') + '</td>' +
              '<td class="num">' + (r.act ? '<span class="down-txt">' + r.act.maxDD + '%</span>' : '--') + '</td>' +
              '<td>' + hitTxt + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="muted mt-8" style="font-size:12px">验证周期进行中:需要快照日之后至少 5 个交易日的K线,收盘后系统会自动加载并复盘。</div>';
    }
    return '<div class="pred-snap"><div class="flex items-center gap-8" style="flex-wrap:wrap">' +
      '<b>📅 ' + snap.label + (isEffective ? (P.isLocked() ? ' <span class="chip gold">当前生效 · 盘中锁定</span>' : ' <span class="chip gold">当前生效 · 可变更</span>') : '') + '</b>' +
      '<span class="chip gray">' + (snap.modelVersion || '--') + '</span>' +
      '<span class="chip ' + regCls + '">' + (reg.regime || '--') + '</span>' +
      '<span class="chip gray">样本 ' + (snap.count || '--') + ' 只</span>' +
      '<span class="chip gold">平均概率 ' + avgProb + '</span>' +
      '<span class="chip">平均预期R5 ' + avgRet + '</span>' +
      '<button class="btn xs danger" style="margin-left:auto" data-act="pred-snap-del" data-id="' + snap.id + '">删除</button>' +
      '</div>' +
      '<div class="ps-meta muted" style="font-size:11.5px;line-height:1.8">预测截止 ' + (snap.dataAsOf || '--') + ' · 当时Top5:' + esc(top5) + '</div>' +
      (sumChips ? '<div class="flex gap-8 mt-8" style="flex-wrap:wrap">' + sumChips + '</div>' : '') +
      tableHtml + '</div>';
  }
  /* 收盘后自动复盘:自动加载最近一个已收盘快照的 Top10 K线并刷新复盘面板(每个会话一次) */
  async function autoReview() {
    const P = QP.predict;
    if (!P || !state.realMode || !QP.real) return;
    const snaps = P.loadSnapshots();
    const effective = P.effectiveTradeDate();
    const past = snaps.filter(s => s.label !== effective);        // 已收盘/非生效日的快照才需要复盘
    if (!past.length) return;
    const latest = past[0];
    if (state._pdAutoReviewed === latest.id) return;
    state._pdAutoReviewed = latest.id;
    const top = (latest.top || []).slice(0, 10);
    const need = [];
    top.forEach(t => { const st = D.getStock(t.code); if (st && !st.kline) need.push(t.code); });
    if (!need.length) { renderPredReview(); return; }
    const CONC = 5;
    for (let i = 0; i < need.length; i += CONC) {
      await Promise.all(need.slice(i, i + CONC).map(c => QP.real.ensureKline(c).catch(() => null)));
    }
    renderPredReview();
  }
  /* 后台预取 Top20 日K:为诊断与次日预测准备缓存,不阻塞首屏、不修改已锁定的今日快照 */
  let _bgKlinePrefetching = false;
  async function bgKlinePrefetch(daily) {
    if (_bgKlinePrefetching || !state.realMode || !QP.real || !QP.real.ensureKline) return;
    _bgKlinePrefetching = true;
    try {
      const codes = (daily.top || []).slice(0, 20).map(p => p.code);
      const need = [];
      codes.forEach(c => { const st = D.getStock(c); if (st && !st.kline) need.push(c); });
      if (!need.length) return;
      const CONC = 4;
      for (let i = 0; i < need.length; i += CONC) {
        await Promise.all(need.slice(i, i + CONC).map(c => QP.real.ensureKline(c).catch(() => null)));
      }
      const page = (location.hash.replace('#/', '') || '').split('/')[0];
      if (page === 'predict') toast('技术指标后台预取完成(供诊断与次日预测使用,今日锁定预测不变)', 'info');
    } finally { _bgKlinePrefetching = false; }
  }

  /* ============================ 页面:行情中心 ============================ */
  const MARKET_COLS = [
    { key: 'price', label: '最新价' }, { key: 'chgPct', label: '涨跌幅' }, { key: 'chg', label: '涨跌额' },
    { key: 'amount', label: '成交额' }, { key: 'turnover', label: '换手率' }, { key: 'volRatio', label: '量比' },
    { key: 'pe', label: 'PE' }, { key: 'mcap', label: '总市值' }
  ];
  function marketFiltered() {
    const { list } = D.buildAll();
    const f = state.market.filters;
    let arr = list.filter(s => {
      if (f.market && s.market !== f.market) return false;
      if (f.industry && s.industry.indexOf(f.industry) < 0) return false;
      if (f.status === '正常' && s.status !== '正常') return false;
      if (f.status === 'ST' && s.status !== 'ST') return false;
      if (f.status === '停牌' && s.status !== '停牌') return false;
      if (f.kw) {
        const k = f.kw.toUpperCase();
        if (!(s.code.indexOf(k) >= 0 || s.name.indexOf(k) >= 0 || (s.py || '').indexOf(k) >= 0)) return false;
      }
      return true;
    });
    const k = state.market.sortKey, dir = state.market.sortDir;
    arr.sort((a, b) => {
      let va = a.quote[k], vb = b.quote[k];
      if (va == null) va = -Infinity; if (vb == null) vb = -Infinity;
      return (va - vb) * dir;
    });
    return arr;
  }
  function renderMarket() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      const { list } = D.buildAll();
      const f = state.market.filters;
      const arr = marketFiltered();
      const total = arr.length;
      const pg = state.market;
      const pages = Math.max(1, Math.ceil(total / pg.pageSize));
      if (pg.page > pages) pg.page = pages;
      const rows = arr.slice((pg.page - 1) * pg.pageSize, pg.page * pg.pageSize);

      const sel = (val, opts) => '<select class="select" data-mfilter="' + val + '">' + opts + '</select>';
      $('#content').innerHTML =
        pageHead('行情中心', '全 A 股 ' + (total > 1000 ? '约 ' + total : total) + ' 只 · 数据更新:' + D.DATA_TIME,
          srcChip() + ' <span class="chip gray" id="mkCount">共 ' + total + ' 只</span>') +
        '<div class="panel mb-16"><div class="panel-body flex gap-12 items-center" style="flex-wrap:wrap">' +
        sel('market', '<option value="">全部市场</option>' + ['沪主板', '深主板', '创业板', '科创板', '北交所'].map(m => '<option ' + (f.market === m ? 'selected' : '') + '>' + m + '</option>').join('')) +
        '<input class="input" id="mkInd" placeholder="行业关键词(如:白酒/银行/半导体)" value="' + esc(f.industry) + '" style="width:200px">' +
        sel('status', '<option value="">全部状态</option>' + ['正常', 'ST', '停牌'].map(m => '<option ' + (f.status === m ? 'selected' : '') + '>' + m + '</option>').join('')) +
        '<input class="input" style="width:190px" id="mkKw" placeholder="代码/名称/拼音过滤" value="' + esc(f.kw) + '">' +
        '<button class="btn" data-act="market-filter">筛选</button>' +
        '<button class="btn" data-act="market-reset">重置</button>' +
        '<span class="flex-1"></span>' +
        '<button class="btn primary" data-act="batch-watch"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg> 批量加入自选</button>' +
        '</div></div>' +
        '<div class="panel"><div class="table-wrap"><table class="grid" id="mkTable"><thead><tr>' +
        '<th style="width:34px"><input type="checkbox" id="mkAll" title="全选"></th>' +
        '<th>代码</th><th>名称 / 行业</th>' +
        MARKET_COLS.map(c => '<th class="num sortable" data-sort="' + c.key + '">' + c.label +
          (pg.sortKey === c.key ? '<span class="sort-arrow">' + (pg.sortDir === 1 ? '▲' : '▼') + '</span>' : '') + '</th>').join('') +
        '<th>状态</th><th style="width:50px"></th></tr></thead><tbody id="mkBody">' +
        rows.map(s => {
          const q = s.quote;
          const px = q.price != null ? nf(q.price) : nf(q.prevClose);
          return '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '">' +
            '<td onclick="event.stopPropagation()"><input type="checkbox" class="mk-chk" value="' + s.code + '"></td>' +
            '<td><span class="num">' + s.code + '</span></td>' +
            '<td><div>' + esc(s.name) + (s.status === 'ST' ? ' <span class="chip red" style="padding:0 6px;font-size:10px">ST</span>' : '') + '</div>' +
            '<div class="muted" style="font-size:11px">' + (s.industry || '--') + '</div></td>' +
            '<td class="num" data-c="price">' + px + '</td>' +
            '<td class="num" data-c="chgPct">' + pctSpan(q.chgPct) + '</td>' +
            '<td class="num" data-c="chg">' + (q.chg != null ? (q.chg >= 0 ? '+' : '') + q.chg.toFixed(2) : '--') + '</td>' +
            '<td class="num" data-c="amount">' + (q.amount ? fmt(q.amount) : '--') + '</td>' +
            '<td class="num" data-c="turnover">' + (q.turnover != null ? q.turnover.toFixed(2) + '%' : '--') + '</td>' +
            '<td class="num" data-c="volRatio">' + nf(q.volRatio) + '</td>' +
            '<td class="num" data-c="pe">' + (q.pe != null ? q.pe.toFixed(1) : '--') + '</td>' +
            '<td class="num" data-c="mcap">' + (q.mcap != null ? fmtBig(q.mcap) : '--') + '</td>' +
            '<td>' + (s.status === '正常' ? '<span class="chip green">正常</span>' : s.status === 'ST' ? '<span class="chip red">ST</span>' : '<span class="chip gray">停牌</span>') + '</td>' +
            '<td onclick="event.stopPropagation()"><button class="star-btn ' + (inWatch(s.code) ? 'on' : '') + '" data-act="star" data-code="' + s.code + '" title="加入/移出自选">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="' + (inWatch(s.code) ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg></button></td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>' +
        (total === 0 ? '<div class="empty-state"><div class="e-ico">🔍</div><div class="e-t">未找到匹配的股票</div><div class="e-s">请调整筛选条件后重试</div></div>' : '') +
        pagerHTML(pg.page, pages, 'market') +
        '</div>' +
        riskNote();
      $('#mkAll').onchange = e => { $$('.mk-chk').forEach(c => c.checked = e.target.checked); };
      $$('#mkTable th.sortable').forEach(th => th.onclick = () => {
        const k = th.dataset.sort;
        if (pg.sortKey === k) pg.sortDir *= -1; else { pg.sortKey = k; pg.sortDir = k === 'price' || k === 'pe' || k === 'mcap' ? 1 : -1; }
        renderMarket();
      });
    }, 240);
  }
  function pagerHTML(page, pages, kind) {
    const mk = (p, label, cls) => '<button class="' + cls + '" data-act="page" data-kind="' + kind + '" data-page="' + p + '">' + label + '</button>';
    let btns = mk(1, '«');
    for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) btns += mk(p, p, p === page ? 'on' : '');
    btns += mk(pages, '»');
    return '<div class="pager">' + btns + '<span class="pg-info">' + page + ' / ' + pages + ' 页</span></div>';
  }
  function updateMarketLive(codes) {
    const tb = $('#mkBody');
    if (!tb) return;
    codes.forEach(code => {
      const s = D.getStock(code);
      if (!s) return;
      const row = tb.querySelector('tr[data-code="' + code + '"]');
      if (!row) return;
      const q = s.quote;
      const set = (c, html) => { const cell = row.querySelector('td[data-c="' + c + '"]'); if (cell) { cell.innerHTML = html; flashCell(cell, q.chgPct >= 0); } };
      set('price', q.price != null ? nf(q.price) : nf(q.prevClose));
      set('chgPct', pctSpan(q.chgPct));
      set('chg', q.chg != null ? ((q.chg >= 0 ? '+' : '') + q.chg.toFixed(2)) : '--');
      set('amount', q.amount ? fmt(q.amount) : '--');
      set('mcap', q.mcap != null ? fmtBig(q.mcap) : '--');
    });
  }

  /* ============================ 页面:股票详情 ============================ */
  const STOCK_TABS = [['chart', '行情'], ['fin', '财务'], ['fund', '资金'], ['holder', '股东'], ['news', '新闻公告'], ['div', '分红融资'], ['ai', 'AI分析']];
  function renderStock(code, sub) {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    (async () => {
      let s = D.getStock(code);
      if (!s && state.realMode && QP.real) {
        // 搜索到的池外股票:按代码拉取行情并入池
        try {
          const qs = await (await fetch('api/quote?codes=' + code)).json();
          const q = qs.data && qs.data[0];
          if (q && q.code) {
            const meta = { code: q.code, name: q.name || q.code, industry: '其他', concepts: ['其他'], size: '中', py: q.code };
            const R = QP.real.store;
            s = R.marketAll.byCode.get(q.code) || R.stocks.get(q.code);
            if (!s) {
              s = { code: q.code, name: meta.name, py: meta.py, market: QP.real.marketName(q.code), industry: meta.industry, concepts: meta.concepts, listDate: '', desc: q.name + '(' + q.code + ') 真实数据模式。', status: '正常', totalShares: null, floatPct: null, size: '中', quote: {}, kline: null, ind: null, fin: null, fundFlow: null, shareholders: null, news: null, dividends: null };
              R.marketAll.byCode.set(q.code, s);
              if (R.marketAll.list.indexOf(s) < 0) R.marketAll.list.push(s);
            }
            s.name = q.name || s.name;
            s.status = q.price == null ? '停牌' : '正常';
            Object.assign(s.quote, {
              price: q.price, chg: q.chg, chgPct: q.chgPct, open: q.open, high: q.high, low: q.low,
              prevClose: q.prevClose, volume: q.volume, amount: q.amount, turnover: q.turnover,
              volRatio: q.volRatio, amplitude: q.amplitude, pe: q.pe, pb: q.pb, mcap: q.mcap, fcap: q.fcap,
              eps: q.eps, roe: q.roe, revYoY: q.revYoY, mainNet: q.mainNet, mainNetPct: q.mainNetPct,
              dvYield: null, high52: null, low52: null, high60: null, upStreak: 0, downStreak: 0,
              limitUp: false, limitDown: false
            });
            s.totalShares = q.totalShares;
          }
        } catch (e) { /* ignore */ }
      }
      if (!s) {
        $('#content').innerHTML = '<div class="empty-state" style="padding:120px 0"><div class="e-ico">🧭</div><div class="e-t">未找到该股票</div></div>';
        return;
      }
      if (token !== state.renderToken) return;
      // 先立即渲染页头与行情(秒开),K线/财务等随后渐进填充
      renderStockMain(s, sub, code);
      if (state.realMode && QP.real) {
        // K线优先:行情标签尽快可用(本地缓存命中则同步秒开)
        await QP.real.ensureKline(code).catch(() => null);
        if (token !== state.renderToken) return;
        renderStockPane(s, sub, AI.analyze(s));
        // 其余详情数据后台加载,完成后重绘当前标签
        await Promise.allSettled([
          QP.real.ensureFin(code), QP.real.ensureFflow(code),
          QP.real.ensureNews(code), QP.real.ensureDividends(code)
        ]);
        if (token !== state.renderToken) return;
        renderStockPane(s, sub, AI.analyze(s));
      }
    })();
  }
  function renderStockMain(s, sub, code) {
    const q = s.quote;
    const rep = AI.analyze(s);
    state.chatCtx = code;
    const active = sub;

    $('#content').innerHTML =
      pageHead('<a href="#/market" style="color:var(--txt-3);font-size:13px;font-weight:400">← 行情中心</a>', '', '') +
      '<div class="panel stock-hero">' +
      '<div class="hero-top">' +
      '<div><div class="hero-name">' + esc(s.name) +
      (s.status === 'ST' ? ' <span class="chip red">ST</span>' : s.status === '停牌' ? ' <span class="chip gray">停牌</span>' : '') +
      ' <span class="hero-code">' + s.code + ' · ' + s.market + '</span></div>' +
      '<div class="mt-8" style="display:flex;gap:8px;flex-wrap:wrap">' +
      (state.realMode ? '' : (s.concepts || []).slice(0, 5).map(c => '<span class="chip">' + c + '</span>').join('')) +
      '<span class="chip violet">' + s.industry + '</span>' +
      (state.realMode ? '<span class="chip gray">东财行业分类</span>' : '') + '</div></div>' +
      '<div class="hero-actions">' +
      '<button class="btn ' + (inWatch(code) ? 'success' : '') + '" data-act="star" data-code="' + code + '">' +
      (inWatch(code) ? '★ 已在自选' : '☆ 加入自选') + '</button>' +
      '<button class="btn" data-act="set-alert" data-code="' + code + '">🔔 设置提醒</button>' +
      '<button class="btn primary" data-act="goto-ai" data-code="' + code + '">AI 分析</button>' +
      '<button class="btn" data-act="goto-chat" data-code="' + code + '">AI 对话</button>' +
      '</div></div>' +
      '<div class="flex items-center gap-16 mt-12" style="flex-wrap:wrap">' +
      '<div><div class="hero-price ' + upTxt(q.chgPct) + '" id="heroPrice">' + nf(q.price) + '</div>' +
      '<div class="hero-chg ' + upTxt(q.chgPct) + '" id="heroChg">' + (q.chg != null ? (q.chg >= 0 ? '+' : '') + q.chg.toFixed(2) : '--') + '  ' + (q.chgPct != null ? D.fmtPct(q.chgPct) : '--') + '</div></div>' +
      '<div class="hero-meta">' +
      '<span>最高 <b id="hHigh">' + nf(q.high) + '</b></span>' +
      '<span>最低 <b id="hLow">' + nf(q.low) + '</b></span>' +
      '<span>今开 <b>' + nf(q.open) + '</b></span>' +
      '<span>昨收 <b>' + nf(q.prevClose) + '</b></span>' +
      '<span>成交额 <b>' + fmt(q.amount) + '</b></span>' +
      '<span>换手 <b>' + nf(q.turnover, 2) + '%</b></span>' +
      '<span>量比 <b>' + nf(q.volRatio) + '</b></span>' +
      '<span>PE <b>' + nf(q.pe, 1) + '</b></span>' +
      '<span>总市值 <b>' + (q.mcap != null ? fmtBig(q.mcap) : '--') + '</b></span>' +
      '</div></div>' +
      '</div>' +
      '<div class="tabs">' + STOCK_TABS.map(t =>
        '<button class="' + (t[0] === active ? 'on' : '') + '" data-act="stock-tab" data-tab="' + t[0] + '">' + t[1] + '</button>').join('') +
      '</div>' +
      '<div id="stockPane"></div>' +
      '<div class="page-foot">' + esc(s.name) + ' 行情/财务/新闻来自东方财富(演示环境) · 数据截止 ' + D.DATA_TIME + ' · 不构成投资建议</div>';

    renderStockPane(s, active, rep);
  }
  function renderStockPane(s, tab, rep) {
    const pane = $('#stockPane');
    if (!pane) return;
    const q = s.quote, ind = s.ind, kl = s.kline;
    const n = kl ? kl.length : 0;
    // 真实模式:当前标签所需数据未就绪时显示加载占位(渐进渲染完成后会重绘)
    if (state.realMode && QP.real) {
      const need = tab === 'chart' ? !!kl : tab === 'fin' ? !!s.fin : tab === 'fund' ? !!s.fundFlow :
        tab === 'news' ? !!s.news : tab === 'div' ? !!s.dividends : (tab === 'ai' ? !!(kl && s.fin) : true);
      if (!need) {
        pane.innerHTML = '<div class="empty-state" style="padding:60px 0"><div class="e-ico">⏳</div><div class="e-t">正在加载真实数据…</div>' +
          '<div class="e-s">行情/K线/财务/资金/新闻来自东方财富,首次加载约需数秒;数据源繁忙时每 12 秒自动重试</div></div>';
        return;
      }
    }
    if (tab === 'chart') {
      const kp = state.screen.kp || 'day';
      state.screen.inds = state.screen.inds || { ma5: true, ma10: true, ma20: true, ma60: false, boll: false, macd: true, rsi: false, kdj: false };
      const isMin = ['5', '15', '30', '60'].indexOf(kp) >= 0;
      pane.innerHTML =
        '<div class="panel mb-16"><div class="panel-body pt-0">' +
        '<div class="flex items-center gap-12" style="padding:12px 0 8px;flex-wrap:wrap">' +
        '<div class="tabs" style="border:none;margin:0;gap:2px">' +
        [['day', '日线'], ['week', '周线'], ['month', '月线'], ['5', '5分'], ['15', '15分'], ['30', '30分'], ['60', '60分']].map(p =>
          '<button class="' + (p[0] === kp ? 'on' : '') + '" data-act="kp" data-kp="' + p[0] + '">' + p[1] + '</button>').join('') +
        '</div>' +
        '<span class="flex-1"></span>' +
        '<div class="ind-switch" id="indSw">' +
        [['ma5', 'MA5'], ['ma10', 'MA10'], ['ma20', 'MA20'], ['ma60', 'MA60'], ['boll', 'BOLL'], ['macd', 'MACD'], ['rsi', 'RSI'], ['kdj', 'KDJ']].map(p =>
          '<button data-act="ind" data-ind="' + p[0] + '" class="' + (state.screen.inds[p[0]] ? 'on' : '') + '">' + p[1] + '</button>').join('') +
        '</div></div>' +
        '<div class="chart" id="chart-kline" style="height:440px"></div>' +
        '</div></div>' +
        '<div class="quote-grid">' +
        qcell('今开', nf(q.open), '开') + qcell('最高', nf(q.high), '高') + qcell('最低', nf(q.low), '低') + qcell('昨收', nf(q.prevClose), '收') +
        qcell('成交量', fmt(q.volume) + ' 手', '量') + qcell('成交额', fmt(q.amount), '额') + qcell('换手率', nf(q.turnover, 2) + '%', '换') + qcell('量比', nf(q.volRatio), '比') +
        qcell('振幅', nf(q.amplitude, 2) + '%', '振') + qcell('市盈率', nf(q.pe), 'PE') + qcell('市净率', nf(q.pb), 'PB') + qcell('股息率', nf(q.dvYield, 2) + '%', '息') +
        qcell('总市值', q.mcap != null ? fmtBig(q.mcap) : '--', '总') + qcell('流通市值', q.fcap != null ? fmtBig(q.fcap) : '--', '流') + qcell('52周高', nf(q.high52), '高') + qcell('52周低', nf(q.low52), '低') +
        '</div>' +
        riskNote() +
        '<div class="page-foot mt-8">K线来自东方财富(前复权),技术指标由本地计算;分钟线为真实分钟K线(不复权)。</div>';
      const kc = $('#chart-kline');
      if (!window.echarts) {
        kc.innerHTML = '<div class="empty-state" style="padding:60px 0"><div class="e-ico">📉</div><div class="e-t">图表组件加载失败</div><div class="e-s">ECharts 未能加载(本地文件缺失且 CDN 不可达),请检查网络后刷新页面</div></div>';
      } else if (s.kline && s.kline.length) {
        renderKline(s).catch(() => {});
      } else {
        kc.innerHTML = '<div class="empty-state" style="padding:60px 0"><div class="e-ico">⏳</div><div class="e-t">K线数据加载中…</div><div class="e-s">正在从东方财富获取历史行情(数据源繁忙时自动重试)</div></div>';
      }
      return;
    }
    if (tab === 'fin') {
      const a = s.fin.annual;
      const qs = s.fin.quarterly;
      const flags = [];
      const last = a[a.length - 1] || {};
      if (last.debtRatio != null && last.debtRatio > 70) flags.push('<span class="chip red">⚠ 负债率偏高(' + last.debtRatio + '%)</span>');
      if (last.ocf != null && last.ocf <= 0) flags.push('<span class="chip red">⚠ 经营现金流为负</span>');
      if (s.fin.npYoY != null && s.fin.npYoY < 0) flags.push('<span class="chip red">⚠ 净利润同比下滑(' + s.fin.npYoY + '%)</span>');
      if (s.fin.growYears >= 3) flags.push('<span class="chip green">✓ 盈利连续' + s.fin.growYears + '年增长</span>');
      const rows = [
        ['营业收入(亿)', 'revenue', 'revenueYoY', '1'], ['净利润(亿)', 'netProfit', 'netProfitYoY', '1'],
        ['扣非净利润(亿)', 'kfProfit', null, '1'], ['毛利率(%)', 'grossMargin', null, '0'],
        ['净利率(%)', 'netMargin', null, '0'], ['ROE(%)', 'roe', null, '0'], ['ROA(%)', 'roa', null, '0'],
        ['资产负债率(%)', 'debtRatio', null, '0'], ['流动比率', 'currentRatio', null, '1'],
        ['经营现金流(亿)', 'ocf', null, '1'], ['每股收益(元)', 'eps', null, '1'],
        ['每股净资产(元)', 'bps', null, '1'], ['每股经营现金流(元)', 'ocfps', null, '1']
      ];
      pane.innerHTML =
        '<div class="flex items-center gap-8 mb-12" style="flex-wrap:wrap">' +
        (flags.length ? flags.join('') : '<span class="chip green">✓ 未发现明显财务异常(基于可用字段)</span>') +
        '<span class="chip gray">盈利连续增长 ' + (s.fin.growYears == null ? '--' : s.fin.growYears) + ' 年</span>' +
        '<span class="chip gray">PE ' + nf(q.pe, 1) + ' · PB ' + nf(q.pb, 2) + '</span>' +
        (state.realMode ? '<span class="chip">来源:东方财富 F10</span>' : '') +
        '</div>' +
        '<div class="grid-2 mb-16">' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>营收 / 净利润趋势(年度)</div></div>' +
        '<div class="panel-body"><div class="chart" id="chart-fin-trend" style="height:240px"></div></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>盈利质量(年度)</div></div>' +
        '<div class="panel-body"><div class="chart" id="chart-fin-margin" style="height:240px"></div></div></div>' +
        '</div>' +
        '<div class="panel mb-16"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>年度财务数据</div>' +
        '<div class="panel-tools"><span class="chip gray">单位:亿元(每股指标:元) · 真实数据</span></div></div>' +
        '<div class="table-wrap"><table class="grid fin-table"><thead><tr><th>指标</th>' +
        a.map(y => '<th class="num">' + y.year + '<br><span class="muted" style="font-size:10px;font-weight:400">同比%</span></th>').join('') +
        '</tr></thead><tbody>' +
        rows.map(r => '<tr><td class="ft-label">' + r[0] + '</td>' +
          a.map(y => '<td class="num">' + (y[r[1]] == null ? '--' : y[r[1]].toFixed(r[3] === '0' ? 1 : 2)) + '<br>' +
            (r[2] && y[r[2]] != null ? '<span class="' + upTxt(y[r[2]]) + '" style="font-size:10.5px">' + (y[r[2]] > 0 ? '+' : '') + y[r[2]].toFixed(1) + '%</span>' : '<span class="muted" style="font-size:10.5px">--</span>') +
            '</td>').join('') +
        '</tr>').join('') +
        '</tbody></table></div>' +
        (state.realMode ? '<div class="muted" style="padding:8px 16px 12px;font-size:11.5px">扣非净利润/ROA/资产负债率/流动比率/经营现金流 等字段当前数据源(F10 主要指标)未提供,显示为 --。</div>' : '') +
        '</div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>季度财务(近12期,累计口径)</div></div>' +
        '<div class="table-wrap"><table class="grid fin-table"><thead><tr><th>报告期</th><th class="num">营收(亿)</th><th class="num">净利润(亿)</th><th class="num">营收同比%</th><th class="num">净利同比%</th><th class="num">毛利率%</th><th class="num">ROE%</th></tr></thead><tbody>' +
        (qs.length ? qs.map(x => '<tr><td>' + x.quarter + '</td><td class="num">' + nf(x.revenue) + '</td><td class="num">' + nf(x.netProfit) + '</td>' +
          '<td class="num ' + upTxt(x.revenueYoY) + '">' + (x.revenueYoY == null ? '--' : D.fmtPct(x.revenueYoY)) + '</td>' +
          '<td class="num ' + upTxt(x.netProfitYoY) + '">' + (x.netProfitYoY == null ? '--' : D.fmtPct(x.netProfitYoY)) + '</td>' +
          '<td class="num">' + nf(x.grossMargin, 1) + '</td><td class="num">' + nf(x.roe, 2) + '</td></tr>').join('') :
          '<tr><td colspan="7" class="center muted" style="padding:24px">暂无季度数据(数据源未提供)</td></tr>') +
        '</tbody></table></div></div>' +
        riskNote('财务数据来自东方财富 F10 主要财务指标接口(演示环境)。真实使用时应以公司定期报告原文为准。');
      chart($('#chart-fin-trend'), {
        grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
        legend: { textStyle: { color: '#9ba8c9', fontSize: 11 }, top: 4 },
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)', textStyle: { color: '#e9eef8' } },
        xAxis: { type: 'category', data: a.map(y => y.year), axisLabel: { color: '#5f6d92' }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
        yAxis: [{ type: 'value', name: '营收', nameTextStyle: { color: '#5f6d92' }, axisLabel: { color: '#5f6d92' }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
        { type: 'value', name: '净利', nameTextStyle: { color: '#5f6d92' }, axisLabel: { color: '#5f6d92' }, splitLine: { show: false } }],
        series: [
          { name: '营业收入', type: 'bar', data: a.map(y => y.revenue), barWidth: 16, itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#2e6be6' }, { offset: 1, color: 'rgba(46,107,230,.15)' }]), borderRadius: [4, 4, 0, 0] } },
          { name: '净利润', type: 'bar', data: a.map(y => y.netProfit), barWidth: 16, yAxisIndex: 1, itemStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#f5b301' }, { offset: 1, color: 'rgba(245,179,1,.15)' }]), borderRadius: [4, 4, 0, 0] } }
        ]
      });
      chart($('#chart-fin-margin'), {
        grid: { left: 8, right: 8, top: 34, bottom: 4, containLabel: true },
        legend: { textStyle: { color: '#9ba8c9', fontSize: 11 }, top: 4 },
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)', textStyle: { color: '#e9eef8' } },
        xAxis: { type: 'category', data: a.map(y => y.year), axisLabel: { color: '#5f6d92' }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
        yAxis: { type: 'value', axisLabel: { color: '#5f6d92' }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
        series: [
          { name: '毛利率', type: 'line', smooth: true, connectNulls: true, data: a.map(y => y.grossMargin), symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.4, color: '#f0b90b' }, itemStyle: { color: '#f0b90b' }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(240,185,11,.25)' }, { offset: 1, color: 'rgba(240,185,11,0)' }]) } },
          { name: '净利率', type: 'line', smooth: true, connectNulls: true, data: a.map(y => y.netMargin), symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.4, color: '#a78bfa' }, itemStyle: { color: '#a78bfa' } },
          { name: 'ROE', type: 'line', smooth: true, connectNulls: true, data: a.map(y => y.roe), symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.4, color: '#22d3ee' }, itemStyle: { color: '#22d3ee' } }
        ]
      });
      return;
    }
    if (tab === 'fund') {
      const ff = s.fundFlow || {};
      const cells = [
        ['主力净流入', ff.mainNet == null ? '--' : fmt(ff.mainNet), ff.mainNet >= 0 ? 'up-txt' : 'down-txt'],
        ['主力净流入占比', ff.mainNetPct == null ? '--' : ff.mainNetPct.toFixed(2) + '%', upTxt(ff.mainNetPct)],
        ['超大单净流入', ff.superBigNet == null ? '--' : fmt(ff.superBigNet), ff.superBigNet >= 0 ? 'up-txt' : 'down-txt'],
        ['大单净流入', ff.bigNet == null ? '--' : fmt(ff.bigNet), ff.bigNet >= 0 ? 'up-txt' : 'down-txt'],
        ['散户净流入', ff.retailNet == null ? '--' : fmt(ff.retailNet), ff.retailNet >= 0 ? 'up-txt' : 'down-txt'],
        ['北向资金变化', ff.northChgPct == null ? '--' : D.fmtPct(ff.northChgPct), ''],
        ['5日主力净流入', ff.mainNet5 == null ? '--' : fmt(ff.mainNet5), ff.mainNet5 >= 0 ? 'up-txt' : 'down-txt'],
        ['股东户数变化', s.shareholders && s.shareholders.holderChgPct != null ? D.fmtPct(s.shareholders.holderChgPct) : '--', '']
      ];
      pane.innerHTML =
        '<div class="quote-grid mb-16">' + cells.map(c => qcell(c[0], c[1], c[2])).join('') + '</div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>近 20 日主力资金净流入(真实数据)</div>' +
        '<div class="panel-tools"><span class="chip gray">数据截止 ' + D.DATA_TIME + '</span></div></div>' +
        '<div class="panel-body"><div class="chart" id="chart-ff" style="height:260px"></div></div></div>' +
        riskNote('资金流数据来自东方财富(演示环境),主力=超大单+大单,散户=中单+小单。北向资金字段当前数据源未接入。');
      chart($('#chart-ff'), {
        grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
        tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)', textStyle: { color: '#e9eef8' }, formatter: p => p[0].axisValue + '<br>主力净流入: ' + fmt(p[0].value) },
        xAxis: { type: 'category', data: (ff.days || []).map(d => d.date.slice(5)), axisLabel: { color: '#5f6d92', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
        yAxis: { type: 'value', axisLabel: { color: '#5f6d92', formatter: v => fmt(v) }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
        series: [{
          type: 'bar', data: (ff.days || []).map(d => d.mainNet), barWidth: '60%',
          itemStyle: { color: p => p.value >= 0 ? 'rgba(246,70,93,.85)' : 'rgba(46,189,133,.85)', borderRadius: 2 }
        }]
      });
      return;
    }
    if (tab === 'holder') {
      const sh = s.shareholders || {};
      const hasData = sh.top10 && sh.top10.length;
      const bars = [['机构持仓', sh.instPct], ['基金持仓', sh.fundPct], ['北向资金持仓', sh.northPct]];
      pane.innerHTML =
        '<div class="quote-grid mb-16">' +
        qcell('股东户数', sh.holderCount != null ? sh.holderCount + ' 万户' : '--', '户') +
        qcell('户数变化', sh.holderChgPct != null ? D.fmtPct(sh.holderChgPct) : '--', '') +
        qcell('机构持仓', sh.instPct != null ? sh.instPct + '%' : '--', '机') +
        qcell('基金持仓', sh.fundPct != null ? sh.fundPct + '%' : '--', '基') +
        qcell('北向资金', sh.northPct != null ? sh.northPct + '%' : '--', '北') +
        qcell('股东户数趋势', sh.holderChgPct == null ? '--' : (sh.holderChgPct < 0 ? '筹码集中' : '筹码分散'), sh.holderChgPct != null && sh.holderChgPct < 0 ? 'up-txt' : 'down-txt') +
        '</div>' +
        (hasData
          ? '<div class="grid-2">' +
            '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>机构持仓占比</div></div>' +
            '<div class="panel-body">' + bars.map(b =>
              '<div class="flex items-center gap-12" style="padding:9px 2px"><span style="width:110px;font-size:12.5px">' + b[0] + '</span>' +
              '<div class="bar flex-1"><i style="width:' + Math.min((b[1] == null ? 0 : b[1]) * 2.2, 100) + '%"></i></div>' +
              '<span class="num" style="width:56px;text-align:right">' + (b[1] == null ? '--' : b[1].toFixed(1) + '%') + '</span></div>').join('') +
              '</div></div>' +
            '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>前十大股东</div></div>' +
            '<div class="table-wrap"><table class="grid"><thead><tr><th>股东</th><th class="num">持股比例</th><th class="num">较上期</th></tr></thead><tbody>' +
            sh.top10.map(x => '<tr><td style="max-width:220px;overflow:hidden;text-overflow:ellipsis">' + x.name + '</td>' +
              '<td class="num">' + nf(x.pct, 2) + '%</td>' +
              '<td class="num">' + (x.change == null ? '--' : '<span class="' + (x.change >= 0 ? 'up-txt">+' : 'down-txt">') + x.change.toFixed(2) + '%</span>') + '</td></tr>').join('') +
            '</tbody></table></div></div></div>'
          : '<div class="panel"><div class="panel-body center muted" style="padding:40px">股东户数/十大股东数据源(东财 F10 股东接口)暂未接入,敬请期待。<br>行情、财务、资金、新闻均为真实数据。</div></div>') +
        riskNote('股东数据为东财 F10 口径;真实使用时应以定期报告披露为准。');
      return;
    }
    if (tab === 'news') {
      const sentMap = { '+': ['利好', 'green'], '-': ['利空', 'red'], '0': ['中性', 'gray'] };
      const sentSum = (s.news || []).reduce((a, x) => a + (x.sentiment === '+' ? 1 : x.sentiment === '-' ? -1 : 0), 0);
      const avg = (sentSum / Math.max(1, (s.news || []).length)).toFixed(2);
      pane.innerHTML =
        '<div class="panel mb-16"><div class="panel-body flex items-center gap-12" style="flex-wrap:wrap">' +
        '<span class="chip">新闻总数 ' + (s.news ? s.news.length : 0) + ' 条</span>' +
        '<span class="chip ' + (avg > 0 ? 'green' : avg < 0 ? 'red' : 'gray') + '">情绪均值 ' + avg + (avg > 0 ? '(偏正面)' : avg < 0 ? '(偏负面)' : '(中性)') + '</span>' +
        '<span class="chip gray">来源:东方财富资讯 · AI 情绪标签为规则判定,仅作参考</span>' +
        '</div></div>' +
        '<div class="panel"><div class="panel-body pt-0">' +
        (s.news && s.news.length ? s.news.map(x => {
          const st = sentMap[x.sentiment];
          return '<div class="news-item">' +
            '<span class="n-tag chip ' + st[1] + '">' + st[0] + '</span>' +
            '<div style="flex:1;min-width:0"><div class="n-title">' + esc(x.title) + '</div>' +
            '<div class="n-meta"><span>' + esc(x.date) + ' ' + esc(x.time) + '</span><span>' + esc(x.source) + '</span><span class="chip gray" style="padding:0 7px;font-size:10px">' + esc(x.type) + '</span></div></div>' +
            '</div>';
        }).join('') : '<div class="empty-state" style="padding:36px"><div class="e-ico">📰</div><div class="e-t">暂无新闻数据</div><div class="e-s">数据源未返回或当日无相关资讯</div></div>') +
        '</div></div>' +
        riskNote('新闻来自东方财富资讯搜索(演示环境)。标题为事实载体,情绪标签为规则模型推断,请以权威信源为准。', true);
      return;
    }
    if (tab === 'div') {
      const divs = s.dividends || [];
      const latestDiv = divs.find(d => d.per10 != null);
      pane.innerHTML =
        '<div class="quote-grid mb-16">' +
        qcell('分红率(派息率)', s.fin.payout != null ? (s.fin.payout * 100).toFixed(0) + '%' : '--', '派') +
        qcell('股息率', nf(q.dvYield, 2) + '%', '息') +
        qcell('最新年度分红', latestDiv ? (latestDiv.plan || '方案详见公告') : '--', '分') +
        qcell('有分红年度', divs.filter(d => d.plan && d.plan.indexOf('不分配') < 0).length + ' / ' + divs.length + ' 期', '年') +
        '</div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>历史分红送配(东财 F10)</div></div>' +
        '<div class="table-wrap"><table class="grid"><thead><tr><th>年度</th><th>分红方案</th><th>除权除息日</th></tr></thead><tbody>' +
        (divs.length ? divs.slice().reverse().map(d =>
          '<tr><td>' + (d.year || '--') + '</td><td>' + (d.plan || '方案详见公告') + '</td><td class="num">' + (d.exDate || '--') + '</td></tr>').join('') :
          '<tr><td colspan="3" class="center muted" style="padding:24px">暂无分红数据(数据源未接入或未披露)</td></tr>') +
        '</tbody></table></div></div>' +
        '<div class="panel mt-16"><div class="panel-head"><div class="panel-title"><span class="dot"></span>融资与股东行为(说明)</div></div>' +
        '<div class="panel-body"><div class="muted" style="font-size:12px;line-height:1.9">增发/配股/限售解禁/回购/股权质押等明细接口(MVP 阶段)暂未接入,后续可通过东财 F10 融资融券接口补齐。</div></div></div>' +
        riskNote();
      return;
    }
    if (tab === 'ai') {
      pane.innerHTML = renderAIReport(s, rep);
      return;
    }
  }
  function qcell(label, val, tag) {
    return '<div class="quote-cell"><div class="qc-l">' + label + '</div>' +
      '<div class="qc-v ' + (tag === 'up-txt' || tag === 'down-txt' ? tag : '') + '">' + val + '</div></div>';
  }

  /* ---- K线图表 ---- */
  async function renderKline(s) {
    const kp = state.screen.kp || 'day';
    const inds = state.screen.inds || { ma5: true, ma10: true, ma20: true, ma60: false, boll: false, macd: true, rsi: false, kdj: false };
    let kl = s.kline;
    const isMin = ['5', '15', '30', '60'].indexOf(kp) >= 0;
    if (isMin || kp === 'week' || kp === 'month') {
      if (state.realMode && QP.real) {
        const klt = { week: 102, month: 103, '5': 5, '15': 15, '30': 30, '60': 60 }[kp] || 101;
        const bars = await QP.real.ensureKline(s.code, klt, isMin ? 0 : 1);
        if (bars && bars.length) kl = bars;
      } else if (kp === 'week' || kp === 'month') {
        kl = aggK(s.kline || [], kp === 'week' ? 5 : 22);
      }
    }
    if (!kl || !kl.length) { return; }
    let labels = kl.map(b => b.date);
    const inds2 = D.calcIndicators(kl);
    const idx = kl.length - 1;
    const upColor = getCss('--up'), downColor = getCss('--down');

    const series = [{
      name: 'K线', type: 'candlestick', data: kl.map(b => [b.open, b.close, b.low, b.high]),
      itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor },
      xAxisIndex: 0, yAxisIndex: 0
    }];
    const maDefs = [['ma5', 'MA5', '#f0b90b'], ['ma10', 'MA10', '#22d3ee'], ['ma20', 'MA20', '#a78bfa'], ['ma60', 'MA60', '#f97316']];
    maDefs.forEach(m => {
      if (inds[m[0]]) series.push({ name: m[1], type: 'line', data: inds2[m[0]], smooth: true, symbol: 'none', lineStyle: { width: 1.2, color: m[2] }, xAxisIndex: 0, yAxisIndex: 0 });
    });
    if (inds.boll) {
      ['bollUp', 'bollMid', 'bollLo'].forEach((k, i) => {
        series.push({ name: ['BOLL上轨', 'BOLL中轨', 'BOLL下轨'][i], type: 'line', data: inds2[k], symbol: 'none', lineStyle: { width: 1, type: 'dashed', color: ['rgba(34,211,238,.7)', 'rgba(240,185,11,.7)', 'rgba(34,211,238,.7)'][i] }, xAxisIndex: 0, yAxisIndex: 0 });
      });
    }
    // 成交量(轴必须与副图 grid 同组:xAxis[1]+yAxis[1] 同挂 grid1)
    series.push({
      name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1,
      data: kl.map(b => ({ value: b.volume, itemStyle: { color: b.close >= b.open ? 'rgba(246,70,93,.55)' : 'rgba(46,189,133,.55)' } })),
      barWidth: '60%'
    });
    // 指标副图
    let indSeries = [], indGrid = null;
    if (inds.macd) {
      indGrid = { left: 55, right: 14, top: '72%', height: '18%' };
      indSeries = [
        { name: 'DIF', type: 'line', data: inds2.dif, symbol: 'none', lineStyle: { width: 1, color: '#f0b90b' }, xAxisIndex: 2, yAxisIndex: 2 },
        { name: 'DEA', type: 'line', data: inds2.dea, symbol: 'none', lineStyle: { width: 1, color: '#22d3ee' }, xAxisIndex: 2, yAxisIndex: 2 },
        { name: 'MACD', type: 'bar', data: inds2.hist.map(v => ({ value: +v.toFixed(2), itemStyle: { color: v >= 0 ? 'rgba(246,70,93,.7)' : 'rgba(46,189,133,.7)' } })), xAxisIndex: 2, yAxisIndex: 2, barWidth: '60%' }
      ];
    } else if (inds.rsi) {
      indGrid = { left: 55, right: 14, top: '72%', height: '18%' };
      indSeries = [
        { name: 'RSI6', type: 'line', data: inds2.rsi.map((v, i) => i < 5 ? null : v), symbol: 'none', lineStyle: { width: 1, color: '#f0b90b' }, xAxisIndex: 2, yAxisIndex: 2 },
        { name: 'RSI14', type: 'line', data: inds2.rsi, symbol: 'none', lineStyle: { width: 1, color: '#22d3ee' }, xAxisIndex: 2, yAxisIndex: 2 }
      ];
    } else if (inds.kdj) {
      indGrid = { left: 55, right: 14, top: '72%', height: '18%' };
      indSeries = [
        { name: 'K', type: 'line', data: inds2.kdjK, symbol: 'none', lineStyle: { width: 1, color: '#f0b90b' }, xAxisIndex: 2, yAxisIndex: 2 },
        { name: 'D', type: 'line', data: inds2.kdjD, symbol: 'none', lineStyle: { width: 1, color: '#22d3ee' }, xAxisIndex: 2, yAxisIndex: 2 },
        { name: 'J', type: 'line', data: inds2.kdjJ, symbol: 'none', lineStyle: { width: 1, color: '#a78bfa' }, xAxisIndex: 2, yAxisIndex: 2 }
      ];
    }
    const grids = [{ left: 55, right: 14, top: 14, height: '48%' }, { left: 55, right: 14, top: '66%', height: '12%' }];
    if (indGrid) grids.push(indGrid);
    const xAxes = [
      { type: 'category', data: labels, gridIndex: 0, axisLabel: { show: false }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
      { type: 'category', data: labels, gridIndex: 1, axisLabel: { color: '#5f6d92', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } }, axisTick: { show: false } }
    ];
    // 注意:y 轴数量必须与 grids 数量一致,否则 ECharts 初始化异常导致图表空白
    const yAxes = [
      { type: 'value', gridIndex: 0, scale: true, axisLabel: { color: '#5f6d92', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
      { type: 'value', gridIndex: 1, axisLabel: { color: '#5f6d92', fontSize: 9, formatter: v => fmt(v) }, splitLine: { show: false } }
    ];
    if (indGrid) {
      xAxes.push({ type: 'category', data: labels, gridIndex: 2, axisLabel: { show: false } });
      yAxes.push({ type: 'value', gridIndex: 2, axisLabel: { color: '#5f6d92', fontSize: 9 }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } });
    }
    try {
      chart($('#chart-kline'), {
      animation: true,
      axisPointer: { link: [{ xAxisIndex: 'all' }], label: { backgroundColor: 'rgba(245,179,1,.92)', fontSize: 10 } },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'cross', crossStyle: { color: 'rgba(140,160,210,.4)' } },
        backgroundColor: 'rgba(13,20,40,.96)', borderColor: 'rgba(140,160,210,.25)', textStyle: { color: '#e9eef8', fontSize: 11 },
        formatter: p => {
          const i = p[0].dataIndex;
          const b = kl[i];
          let h = '<b>' + (labels[i] || '') + '</b><br>' + esc(s.name) + ' 开:' + b.open + ' 高:' + b.high + ' 低:' + b.low + ' 收:' + b.close;
          p.forEach(x => { if (x.seriesName !== 'K线') h += '<br>' + x.marker + x.seriesName + ': ' + (typeof x.value === 'object' ? x.value[1] : x.value == null ? '--' : Number(x.value).toFixed(2)); });
          return h;
        }
      },
      legend: { show: inds.macd || inds.rsi || inds.kdj, textStyle: { color: '#9ba8c9', fontSize: 10 }, top: 0, data: indSeries.map(x => x.name) },
      grid: grids, xAxis: xAxes, yAxis: yAxes,
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: Math.max(0, 100 - 12000 / Math.max(kl.length, 1)), end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], bottom: 2, height: 16, borderColor: 'rgba(255,211,77,.25)', backgroundColor: 'rgba(255,211,77,.07)', fillerColor: 'rgba(245,179,1,.22)', handleStyle: { color: '#f5b301' }, textStyle: { color: '#a08279', fontSize: 9 } }
      ],
      series: series.concat(indSeries)
      });
    } catch (e) {
      console.error('K线渲染失败:', e);
      const el = $('#chart-kline');
      if (el) el.innerHTML = '<div class="empty-state" style="padding:60px 0"><div class="e-ico">⚠️</div><div class="e-t">K线渲染失败</div><div class="e-s">' + esc(e.message) + '</div></div>';
    }
  }
  function aggK(kl, n) {
    const out = [];
    for (let i = 0; i < kl.length; i += n) {
      const seg = kl.slice(i, i + n);
      out.push({
        date: seg[0].date,
        open: seg[0].open,
        close: seg[seg.length - 1].close,
        high: Math.max.apply(null, seg.map(b => b.high)),
        low: Math.min.apply(null, seg.map(b => b.low)),
        volume: seg.reduce((a, b) => a + b.volume, 0),
        amount: seg.reduce((a, b) => a + b.amount, 0)
      });
    }
    return out;
  }
  function getCss(v) {
    const c = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    return c || '#f6465d';
  }
  function updateStockLive(codes) {
    const m = (location.hash.match(/^#\/stock\/(\d{4,6})/) || [])[1];
    if (!m) return; // 任意股票(含池外)都实时更新
    const s = D.getStock(m);
    if (!s) return;
    const q = s.quote;
    const hp = $('#heroPrice'), hc = $('#heroChg');
    if (hp) { hp.textContent = nf(q.price); hp.className = 'hero-price ' + upTxt(q.chgPct); flashCell(hp, q.chgPct >= 0); }
    if (hc) { hc.textContent = (q.chg != null ? (q.chg >= 0 ? '+' : '') + q.chg.toFixed(2) : '--') + '  ' + (q.chgPct != null ? D.fmtPct(q.chgPct) : '--'); hc.className = 'hero-chg ' + upTxt(q.chgPct); }
    const hh = $('#hHigh'), hl = $('#hLow');
    if (hh) hh.textContent = nf(q.high);
    if (hl) hl.textContent = nf(q.low);
    // —— K线实时更新:把最新报价写入当日K线bar并重绘(日线周期,仅在行情Tab) ——
    if (q.price != null && s.kline && s.kline.length && (state.screen.kp || 'day') === 'day') {
      const kc = $('#chart-kline');
      const kl = s.kline;
      const last = kl[kl.length - 1];
      const d = new Date();
      const today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (last.date === today) {
        last.close = q.price;
        last.high = Math.max(last.high, q.high != null ? q.high : q.price);
        last.low = Math.min(last.low, q.low != null ? q.low : q.price);
        if (q.volume > last.volume) last.volume = q.volume;
        if (q.amount > last.amount) last.amount = q.amount;
      } else {
        // 当日无bar(如非交易时段加载的历史数据):追加当日实时bar
        kl.push({
          date: today, open: q.open != null ? q.open : q.price, close: q.price,
          high: Math.max(q.high != null ? q.high : q.price, q.price),
          low: Math.min(q.low != null ? q.low : q.price, q.price),
          volume: q.volume || 0, amount: q.amount || 0, amplitude: q.amplitude || 0, chgPct: q.chgPct || 0, chg: q.chg || 0, turnover: q.turnover || 0
        });
        s.ind = D.calcIndicators(kl); // 指标重算
      }
      if (kc && !kc.dataset.busy) {
        kc.dataset.busy = '1';
        renderKline(s).catch(() => {}).finally(() => { delete kc.dataset.busy; });
      }
    }
    // —— 详情数据缺失时自动重试(节流:每 12 秒最多一次) ——
    if (state.realMode && QP.real) {
      const now = Date.now();
      const need = [];
      if (!s.kline) need.push(QP.real.ensureKline(m));
      if (!s.fin) need.push(QP.real.ensureFin(m));
      if (!s.fundFlow) need.push(QP.real.ensureFflow(m));
      if (!s.news) need.push(QP.real.ensureNews(m));
      if (need.length && (!state._retryAt || now > state._retryAt)) {
        state._retryAt = now + 12000;
        Promise.allSettled(need).then(() => {
          const tab = (location.hash.match(/^#\/stock\/\d{4,6}\/(\w+)/) || [])[1] || 'chart';
          if ((location.hash.match(/^#\/stock\/(\d{4,6})/) || [])[1] === m) {
            renderStockPane(s, tab, AI.analyze(s));
          }
        });
      }
    }
  }

  /* ============================ AI 报告 ============================ */
  function renderAIReport(s, rep) {
    const ring = (label, val, max, color) => {
      const p = Math.round(val / max * 100);
      const c = color || (val >= 70 ? '#2ebd85' : val >= 45 ? '#f0b90b' : '#f6465d');
      return '<div class="center"><div class="score-ring" style="--p:' + p + ';--c:' + c + '">' +
        '<span class="sr-val">' + val + '</span><span class="sr-label">' + label + '</span></div></div>';
    };
    const trendCls = rep.trend === '强势' || rep.trend === '偏强' ? 'chip green' : rep.trend === '弱势' || rep.trend === '偏弱' ? 'chip red' : 'chip gold';
    return '<div class="grid-2 mb-16">' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>综合评分</div>' +
      '<div class="panel-tools"><span class="chip ' + (rep.risk_level === '高' ? 'red' : rep.risk_level === '中' ? 'gold' : 'green') + '">风险:' + rep.risk_level + '</span><span class="chip ' + (rep.trend === '强势' || rep.trend === '偏强' ? 'green' : rep.trend === '中性' ? 'gray' : 'red') + '">趋势:' + rep.trend + '</span></div></div>' +
      '<div class="panel-body center" style="padding-top:20px">' +
      '<div class="score-ring" style="--p:' + rep.overall_score + ';--c:' + (rep.overall_score >= 70 ? '#2ebd85' : rep.overall_score >= 45 ? '#4f7cff' : '#f6465d') + ';width:150px;height:150px">' +
      '<span class="sr-val" style="font-size:40px">' + rep.overall_score + '</span><span class="sr-label" style="bottom:30px">综合评分 0-100</span></div>' +
      '<div class="muted mt-8" style="font-size:12px">当前状态:<b class="' + (rep.trend === '强势' || rep.trend === '偏强' ? 'up-txt' : rep.trend === '中性' ? '' : 'down-txt') + '">' + rep.trend + '</b></div>' +
      '</div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>分项评分</div></div>' +
      '<div class="panel-body"><div class="grid-3" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:14px">' +
      ring('基本面', rep.fundamental_score, 100) + ring('技术面', rep.technical_score, 100) +
      ring('资金面', rep.capital_score, 100) + ring('新闻面', rep.news_score, 100) +
      ring('风险', rep.risk_score, 100, rep.risk_score >= 70 ? '#f6465d' : rep.risk_score >= 45 ? '#f0b90b' : '#2ebd85') +
      '<div class="center" style="display:flex;flex-direction:column;justify-content:center;gap:6px">' +
      '<div class="muted" style="font-size:11px">风险分数越高越危险</div>' +
      '<div class="muted" style="font-size:11px">数据截止:' + rep.data_as_of + '</div>' +
      '</div></div></div></div>' +
      '</div>' +
      '<div class="grid-2 mb-16">' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot green"></span>主要支持因素</div></div>' +
      '<div class="panel-body pt-0">' + (rep.positive_factors.length ? rep.positive_factors.map(f => '<div class="news-item" style="padding:9px 2px"><span style="color:var(--ok)">▲</span><div style="font-size:12.5px;line-height:1.7">' + f + '</div></div>').join('') : '<div class="empty-state" style="padding:30px">暂无显著正面因素</div>') + '</div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot red"></span>主要风险因素</div></div>' +
      '<div class="panel-body pt-0">' + (rep.negative_factors.length ? rep.negative_factors.map(f => '<div class="news-item" style="padding:9px 2px"><span style="color:var(--danger)">▼</span><div style="font-size:12.5px;line-height:1.7">' + f + '</div></div>').join('') : '<div class="empty-state" style="padding:30px">暂无显著负面因素</div>') + '</div></div>' +
      '</div>' +
      '<div class="panel mb-16"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>风险清单</div></div>' +
      '<div class="panel-body pt-0">' + (rep.risks.length ? rep.risks.map((r, i) => '<div class="news-item" style="padding:8px 2px"><span class="chip red" style="padding:1px 8px">' + (i + 1) + '</span><div style="font-size:12.5px">' + r + '</div></div>').join('') : '<div class="empty-state" style="padding:24px">当前未识别到显著风险(基于真实数据)</div>') + '</div></div>' +
      '<div class="grid-2 mb-16">' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>需要持续观察的数据</div></div>' +
      '<div class="panel-body pt-0">' + rep.watch_items.map(w => '<div class="news-item" style="padding:8px 2px"><span style="color:var(--brand-2)">👁</span><div style="font-size:12.5px">' + w + '</div></div>').join('') + '</div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>评分依据</div></div>' +
      '<div class="panel-body pt-0">' + rep.reasoning.map(r => '<div class="news-item" style="padding:7px 2px;font-size:12px"><span class="muted">▪</span><div>' + r + '</div></div>').join('') + '</div></div>' +
      '</div>' +
      '<div class="panel mb-16" style="border-color:rgba(240,185,11,.3)"><div class="panel-body" style="padding:14px 18px">' +
      '<div style="font-size:12.5px;color:var(--txt-2);line-height:1.9">' +
      '<b style="color:var(--txt-1)">报告说明</b><br>' +
      '· 数据来源:东方财富真实行情/财务(' + rep.data_as_of + '),生成时间 ' + rep.generated_at + '<br>' +
      '· 本报告由规则模型基于结构化数据自动生成,不含任何外部 AI 大模型推理<br>' +
      '· 所有引用均标注数据来源与时间;推测性结论以「推测」标注<br>' +
      '· 结论有效期:至下一交易日收盘后自动失效' +
      '</div></div></div>' +
      '<div class="risk-note danger mt-8"><span class="rn-ico">⚠️</span><span>' + rep.disclaimer + '</span></div>';
  }
  function renderAI() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      $('#content').innerHTML =
        pageHead('AI 智能分析', '牛股诊断 · 选择一只股票后,基于其全部真实数据(行情/日K技术指标/财务/资金流/新闻)自动生成诊断报告与概率预测',
          '<span class="chip violet">规则引擎 + 概率模型</span> ' + srcChip()) +
        aiHubTabs('diag') +
        '<div class="panel mb-16"><div class="panel-body">' +
        '<div class="flex gap-8 items-center" style="flex-wrap:wrap">' +
        '<span class="muted" style="font-size:12.5px">选择股票:</span>' +
        '<input class="input" id="aiStockSearch" placeholder="输入代码 / 名称 / 拼音首字母,如 600519 / 茅台 / GZMT" style="width:340px" autocomplete="off">' +
        '</div>' +
        '<div id="aiSuggest"></div>' +
        '<div class="muted mt-8" style="font-size:11.5px;line-height:1.8">本页不预置任何股票预测;选定股票后,系统自动加载其日K/财务/资金/新闻(加载完整数据后评分更准确),生成六维评分 + 上涨概率/预期收益/回撤/置信度。</div>' +
        '</div></div>' +
        '<div id="aiResult"><div class="panel"><div class="panel-body center" style="padding:56px 20px">' +
        '<div style="font-size:40px">🔍</div>' +
        '<div style="font-size:15px;margin-top:14px;color:var(--txt-2)">请在上方输入并选择一只股票</div>' +
        '<div class="muted" style="margin-top:8px;font-size:12px">针对您选择的股票生成诊断,支持回车或点击候选</div>' +
        '</div></div></div>' +
        riskNote() +
        '<div class="page-foot">AI 诊断由本地规则引擎生成 · 数据截止 ' + D.DATA_TIME + ' · 不构成投资建议</div>';
      const inp = $('#aiStockSearch');
      inp.addEventListener('input', () => {
        const q = inp.value.trim();
        const box = $('#aiSuggest');
        if (!q) { box.style.display = 'none'; box.innerHTML = ''; return; }
        const hits = D.search(q).slice(0, 8);
        if (!hits.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
        box.style.display = 'block';
        box.className = 'panel';
        box.style.cssText = 'margin-top:8px;padding:8px;width:100%;';
        box.innerHTML = hits.map(s => '<div class="sd-item" data-act="ai-pick" data-code="' + s.code + '">' +
          '<span class="sd-code">' + s.code + '</span><span class="sd-name">' + esc(s.name) + '</span>' +
          '<span class="sd-market">' + esc(s.industry || '') + '</span>' +
          '<span class="sd-chg ' + upTxt(s.quote && s.quote.chgPct) + '">' + D.fmtPct(s.quote && s.quote.chgPct) + '</span></div>').join('');
      });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          const first = $('#aiSuggest .sd-item[data-act="ai-pick"]');
          if (first) { first.click(); e.preventDefault(); }
        }
      });
    }, 240);
  }
  async function pickAIDiagnosis(code) {
    const box = $('#aiResult');
    if (!box) return;
    let s = D.getStock(code);
    if (!s) { toast('未找到该股票', 'warn'); return; }
    const name = s.name;
    box.innerHTML = '<div class="panel"><div class="panel-body center" style="padding:30px">正在加载 <b>' + esc(name) + '</b> 全部数据并生成诊断(首次约数秒)…</div></div>';
    // 加载全部数据:保证六维评分与技术/资金/新闻特征为真实值(提高准确度)
    if (state.realMode && QP.real) {
      await Promise.allSettled([
        QP.real.ensureKline(code), QP.real.ensureFin(code),
        QP.real.ensureFflow(code), QP.real.ensureNews(code),
        QP.real.ensureDividends(code)
      ]);
    }
    s = D.getStock(code);
    const rep = AI.analyze(s);
    let pred = null;
    if (QP.predict) {
      const P = QP.predict;
      const sectors = P.sectorStatsCached(60000);
      const smap = {};
      sectors.forEach(x => { smap[x.name] = x; });
      pred = P.predictOne(s, smap[s.industry], P.marketRegime());
    }
    box.innerHTML = aiDiagnosisHTML(s, rep, pred) + aiHistoryHTML(s);
    try { box.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { }
  }
  function aiDiagnosisHTML(s, rep, pred) {
    const q = s.quote;
    const hero = '<div class="panel stock-hero mb-16"><div class="hero-top"><div>' +
      '<div class="hero-name">' + esc(s.name) + '<span class="hero-code">' + s.code + '</span>' +
      (s.status === 'ST' ? ' <span class="chip red" style="padding:0 6px;font-size:10px">ST</span>' : '') + '</div>' +
      '<div class="flex items-center gap-16 mt-8" style="flex-wrap:wrap">' +
      '<span class="hero-price ' + upTxt(q.chgPct) + '">' + (q.price != null ? q.price.toFixed(2) : '--') + '</span>' +
      '<span class="hero-chg ' + upTxt(q.chgPct) + '">' + D.fmtPct(q.chgPct) + '</span>' +
      '<span class="chip gray">' + esc(s.industry || '--') + '</span>' +
      '<span class="chip gray">' + (s.market || '--') + '</span>' +
      '</div></div>' +
      '<div class="hero-actions">' +
      '<button class="btn" data-act="goto-chat" data-code="' + s.code + '">💬 AI 对话</button>' +
      '<button class="btn primary" data-act="goto-stock" data-code="' + s.code + '">查看详情 →</button>' +
      '</div></div></div>';
    let predHtml = '';
    if (pred) {
      const bar = (v) => '<div class="prob-cell"><b class="num" style="color:' + (v >= 55 ? 'var(--up)' : v >= 40 ? 'var(--gold)' : 'var(--down)') + '">' + v + '%</b>' +
        '<span class="prob-bar"><i style="width:' + Math.min(100, Math.max(3, v)) + '%"></i></span></div>';
      predHtml = '<div class="panel mb-16"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>概率预测(未来 5/10/20 日)</div>' +
        '<div class="panel-tools"><span class="chip gray">' + (pred.regime || '--') + '市场</span><span class="chip">置信度 ' + pred.confidence + '</span></div></div>' +
        '<div class="panel-body"><div class="grid-3" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px">' +
        '<div class="quote-cell"><div class="qc-l">上涨概率 P5 / P10 / P20</div><div class="qc-v" style="display:flex;flex-direction:column;gap:7px;margin-top:6px">' +
        bar(pred.p5) + bar(pred.p10) + bar(pred.p20) + '</div></div>' +
        '<div class="quote-cell"><div class="qc-l">预期收益 R5 / R10 / R20</div><div class="qc-v" style="font-size:14px;margin-top:6px;line-height:2.1">' +
        predRetSpan(pred.ret5) + '<br>' + predRetSpan(pred.ret10) + '<br>' + predRetSpan(pred.ret20) + '</div></div>' +
        '<div class="quote-cell"><div class="qc-l">超额收益 E5 / 预期回撤 / 综合预测分</div><div class="qc-v" style="font-size:14px;margin-top:6px;line-height:2.1">' +
        predRetSpan(pred.excess5) + '<br>' + predDDSpan(pred.expDD) + '<br><b class="' + scoreCls(pred.score) + '">' + pred.score.toFixed(1) + '</b></div></div>' +
        '</div>' +
        '<div class="flex gap-8 mt-12" style="flex-wrap:wrap">' +
        (pred.pos || []).map(x => '<span class="chip" style="padding:2px 9px">▲ ' + esc(x) + '</span>').join('') +
        (pred.risks || []).map(x => '<span class="chip red" style="padding:2px 9px">▼ ' + esc(x) + '</span>').join('') +
        '</div>' +
        '<div class="muted mt-8" style="font-size:11px">概率为「未来 N 日收益超过 ' + QP.predict.TH.p5 + '% / ' + QP.predict.TH.p10 + '% / ' + QP.predict.TH.p20 + '%」的规则模型估计;已加载日K技术指标:' + (pred.tech ? '是(评分更准)' : '否') + '。</div>' +
        '</div></div>';
    }
    return hero + predHtml + renderAIReport(s, rep);
  }
  function aiHistoryHTML(s) {
    if (!QP.predict) return '';
    const P = QP.predict;
    const snaps = P.loadSnapshots();
    const rows = [];
    snaps.forEach(snap => {
      const t = (snap.top || []).find(x => x.code === s.code);
      if (!t) return;
      [5, 10].forEach(h => {
        const act = P.actualReturn(s, snap.label, h);
        if (!act) return;
        const predUp = (t['p' + h] || 0) >= 50;
        rows.push({ label: snap.label, h: h, predP: t['p' + h], predR: t['ret' + h], actR: act.ret, hit: predUp ? act.ret > 0 : act.ret <= 0 });
      });
    });
    if (!rows.length) return '';
    const hits = rows.filter(r => r.hit).length;
    const hitRate = Math.round(hits / rows.length * 100);
    return '<div class="panel mb-16"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>该股历史预测验证(来自每日锁定快照)</div>' +
      '<div class="panel-tools"><span class="chip ' + (hitRate >= 50 ? 'green' : 'red') + '">命中率 ' + hitRate + '% (' + hits + '/' + rows.length + ')</span></div></div>' +
      '<div class="panel-body pt-0"><div class="table-wrap"><table class="grid rev-table"><thead><tr><th>快照日</th><th class="num">周期</th><th class="num">预测概率</th><th class="num">预测收益</th><th class="num">实际收益</th><th>结果</th></tr></thead><tbody>' +
      rows.slice(0, 12).map(r => '<tr><td>' + r.label + '</td><td class="num">' + r.h + '日</td>' +
        '<td class="num">' + (r.predP != null ? r.predP + '%' : '--') + '</td>' +
        '<td class="num">' + (r.predR != null ? ((r.predR > 0 ? '+' : '') + r.predR + '%') : '--') + '</td>' +
        '<td class="num">' + (r.actR > 0 ? '<span class="up-txt">+' : '<span class="down-txt">') + r.actR + '%</span></td>' +
        '<td>' + (r.hit ? '<span class="chip green">命中 ✓</span>' : '<span class="chip red">未中 ✗</span>') + '</td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="muted mt-8" style="font-size:11px">仅统计已到期且K线可用的历史预测(真实日K);历史命中不代表未来表现。</div></div></div>';
  }

  /* ============================ 页面:条件选股 ============================ */
  const SCREENER_TEMPLATES = {
    '白马成长': { name: '白马成长', groups: [{ id: 'g1', logic: 'AND', conds: [S.newCond('mcap', { op: '>', v1: 5e10 }), S.newCond('revYoY', { op: '>', v1: 15 }), S.newCond('npYoY', { op: '>', v1: 15 }), S.newCond('roe', { op: '>', v1: 12 }), S.newCond('debtRatio', { op: '<', v1: 60 })] }] },
    '低估值高股息': { name: '低估值高股息', groups: [{ id: 'g1', logic: 'AND', conds: [S.newCond('pe', { op: '<', v1: 15 }), S.newCond('pb', { op: '<', v1: 2 }), S.newCond('dvYield', { op: '>', v1: 3 }), S.newCond('mcap', { op: '>', v1: 3e10 })] }] },
    '放量突破': { name: '放量突破', groups: [{ id: 'g1', logic: 'AND', conds: [S.newCond('breakout20', { op: '=', v1: '是' }), S.newCond('volRatio', { op: '>', v1: 1.8 }), S.newCond('chgPct', { op: '>', v1: 2 })] }] },
    '超跌反弹': { name: '超跌反弹', groups: [{ id: 'g1', logic: 'AND', conds: [S.newCond('rsi', { op: '<', v1: 35 }), S.newCond('downStreak', { op: '>=', v1: 3 }), S.newCond('debtRatio', { op: '<', v1: 65 })] }] }
  };
  function fieldOpts(cur) {
    const cats = ['行情', '技术', '基本面', '资金', '分类'];
    return cats.map(c => {
      const fs = S.FIELDS.filter(f => f.cat === c);
      return '<optgroup label="' + c + '条件">' + fs.map(f => '<option value="' + f.key + '"' + (f.key === cur ? ' selected' : '') + '>' + f.label + '</option>').join('') + '</optgroup>';
    }).join('');
  }
  function condRowHTML(cond) {
    const f = S.FIELD_MAP[cond.field];
    const ops = S.opsOf(f).map(o => '<option value="' + o.v + '" ' + (cond.op === o.v ? 'selected' : '') + '>' + o.label + '</option>').join('');
    const v2 = cond.op === 'between' ? '<input class="input num" data-cf="v2" value="' + esc(cond.v2) + '" placeholder="上限">' : '';
    return '<div class="cond-row" data-cid="' + cond.id + '">' +
      '<select class="select" data-cf="field" style="min-width:190px">' + fieldOpts(cond.field) + '</select>' +
      '<select class="select" data-cf="op" style="min-width:110px">' + ops + '</select>' +
      '<input class="input num" data-cf="v1" value="' + esc(cond.v1) + '" placeholder="' + (f.type === 'str' ? '关键词' : f.type === 'enum' ? '选项' : '数值') + '" style="min-width:100px">' +
      v2 +
      '<button class="cond-del" data-act="del-cond" title="删除条件"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>';
  }
  function groupHTML(g) {
    return '<div class="cond-group" data-gid="' + g.id + '">' +
      '<div class="cond-group-head">' +
      '<span class="group-logic-tag">组内逻辑</span>' +
      '<select class="select logic-select" data-gf="logic">' +
      ['AND', 'OR', 'NOT'].map(l => '<option ' + (g.logic === l ? 'selected' : '') + '>' + l + '</option>').join('') +
      '</select>' +
      '<span class="muted" style="font-size:11.5px">' + g.conds.length + ' 个条件</span>' +
      '<span class="flex-1"></span>' +
      '<button class="btn xs" data-act="add-cond" data-gid="' + g.id + '">+ 条件</button>' +
      '<button class="cond-del" data-act="del-group" data-gid="' + g.id + '" title="删除分组"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>' +
      '<div class="cond-rows">' + g.conds.map(condRowHTML).join('') +
      (g.conds.length ? '' : '<div class="cond-row muted" style="font-size:12px">该分组暂无条件,点击「+ 条件」添加</div>') +
      '</div></div>';
  }
  function syncStrategyFromDOM() {
    const st = state.screen.strategy;
    st.logic = $('#strategyLogic').value;
    st.name = $('#strategyName').value.trim();
    st.groups = $$('#strategyGroups .cond-group').map(gEl => {
      const gid = gEl.dataset.gid;
      const g = st.groups.find(x => x.id === gid);
      g.logic = gEl.querySelector('[data-gf="logic"]').value;
      g.conds = $$('.cond-row', gEl).map(rEl => {
        const cid = rEl.dataset.cid;
        const c = g.conds.find(x => x.id === cid);
        c.field = rEl.querySelector('[data-cf="field"]').value;
        c.op = rEl.querySelector('[data-cf="op"]').value;
        c.v1 = rEl.querySelector('[data-cf="v1"]').value;
        const v2 = rEl.querySelector('[data-cf="v2"]');
        c.v2 = v2 ? v2.value : '';
        return c;
      });
      return g;
    });
  }
  function renderScreener() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      if (!state.screen.strategy) {
        const tpl = SCREENER_TEMPLATES['白马成长'];
        state.screen.strategy = JSON.parse(JSON.stringify(tpl));
        state.screen.strategy.name = '';
        state.screen.strategy.id = 's' + Date.now().toString(36);
      }
      const st = state.screen.strategy;
      const saved = state.strategies;
      $('#content').innerHTML =
        pageHead('条件选股', '可视化组合条件,支持 AND / OR / NOT 逻辑与条件分组',
          srcChip()) +
        '<div class="panel mb-16"><div class="panel-body">' +
        '<div class="flex gap-12 items-center" style="flex-wrap:wrap">' +
        '<input class="input" id="strategyName" placeholder="策略名称,如:低估值白马" value="' + esc(st.name) + '" style="width:200px">' +
        '<span class="muted" style="font-size:12.5px">组间逻辑</span>' +
        '<select class="select" id="strategyLogic" style="width:88px">' +
        ['AND', 'OR'].map(l => '<option ' + (st.logic === l ? 'selected' : '') + '>' + l + '</option>').join('') +
        '</select>' +
        '<button class="btn" data-act="add-sgroup">+ 添加分组</button>' +
        '<span class="flex-1"></span>' +
        '<button class="btn" data-act="save-strategy">💾 保存策略</button>' +
        '<select class="select" id="strategyLoad" style="width:170px">' +
        '<option value="">—— 载入已保存策略 ——</option>' +
        saved.map(x => '<option value="' + x.id + '">' + esc(x.name) + '(命中' + (x.lastCount == null ? '?' : x.lastCount) + ')</option>').join('') +
        '</select>' +
        '<button class="btn primary" data-act="run-strategy"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg> 执行选股</button>' +
        '</div>' +
        '<div class="mt-12 flex gap-8" style="flex-wrap:wrap">' +
        '<span class="muted" style="font-size:11.5px;align-self:center">快速模板:</span>' +
        Object.keys(SCREENER_TEMPLATES).map(k => '<button class="btn xs" data-act="tpl" data-tpl="' + k + '">' + k + '</button>').join('') +
        '</div></div></div>' +
        '<div id="strategyGroups" class="mb-16">' + st.groups.map(groupHTML).join('') + '</div>' +
        '<div class="grid-3 mb-16" style="grid-template-columns:2fr 1fr;align-items:start">' +
        '<div class="panel" id="screenResultPanel"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>选股结果</div>' +
        '<div class="panel-tools" id="resTools"></div></div>' +
        '<div class="panel-body pt-0" id="resBody"><div class="empty-state" style="padding:36px"><div class="e-ico">⚡</div><div class="e-t">点击「执行选股」开始筛选</div><div class="e-s">支持对结果排序、导出 CSV、批量加入自选</div></div></div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>已保存策略</div></div>' +
        '<div class="panel-body pt-0" id="savedList">' + (saved.length ? saved.map(x =>
          '<div class="strategy-card panel" style="margin-bottom:10px;padding:13px 15px"><div class="sc-name">' + esc(x.name) + '</div>' +
          '<div class="sc-meta">最近运行:' + (x.lastRunAt || '从未') + (x.lastCount != null ? ' · 命中 ' + x.lastCount + ' 只' : '') + '</div>' +
          '<div class="sc-conds">' + x.groups.flatMap(g => g.conds).slice(0, 5).map(c => '<span class="chip gray">' + S.condDesc(c) + '</span>').join('') + '</div>' +
          '<div class="sc-actions"><button class="btn xs" data-act="load-strategy" data-id="' + x.id + '">载入</button>' +
          '<button class="btn xs" data-act="run-saved" data-id="' + x.id + '">运行</button>' +
          '<button class="btn xs" data-act="copy-strategy" data-id="' + x.id + '">复制</button>' +
          '<button class="btn xs danger" data-act="del-strategy" data-id="' + x.id + '">删除</button></div></div>').join('') :
          '<div class="empty-state" style="padding:30px"><div class="e-ico">🗂️</div><div class="e-t">暂无保存的策略</div><div class="e-s">设计好条件后点击「保存策略」</div></div>') + '</div></div>' +
        '</div>' +
        riskNote() +
        '<div class="page-foot">筛选基于东方财富真实数据计算(样本池) · 数据截止 ' + D.DATA_TIME + ' · 结果不构成投资建议</div>';
      // 结果区恢复
      if (state.screen.results) renderScreenResults();
    }, 240);
  }
  function renderScreenResults() {
    const st = state.screen;
    const body = $('#resBody'), tools = $('#resTools');
    if (!body) return;
    const res = st.results || [];
    const pages = Math.max(1, Math.ceil(res.length / 15));
    if (st.page > pages) st.page = pages;
    const rows = res.slice((st.page - 1) * 15, st.page * 15);
    tools.innerHTML =
      '<span class="chip">命中 ' + res.length + ' 只</span>' +
      '<button class="btn xs" data-act="export-csv">导出 CSV</button>' +
      '<button class="btn xs" data-act="batch-watch">批量加入自选</button>';
    body.innerHTML =
      '<div class="table-wrap"><table class="grid"><thead><tr>' +
      '<th>#</th><th>代码</th><th>名称</th>' +
      [['price', '最新价'], ['chgPct', '涨跌幅'], ['amount', '成交额'], ['turnover', '换手率'], ['pe', 'PE'], ['roe', 'ROE%'], ['npYoY', '净利同比'], ['dvYield', '股息率']].map(c =>
        '<th class="num sortable" data-sort="' + c[0] + '">' + c[1] + (st.sortKey === c[0] ? '<span class="sort-arrow">' + (st.sortDir === 1 ? '▲' : '▼') + '</span>' : '') + '</th>').join('') +
      '<th style="width:44px"></th></tr></thead><tbody>' +
      rows.map((s, i) => {
        const q = s.quote;
        const fin = s.fin || {};
        const annual = (fin.annual && fin.annual.length) ? fin.annual[fin.annual.length - 1] : {};
        return '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '">' +
          '<td><span class="rank-badge rank-' + Math.min(st.page * 15 - 14 + i, 3) + '">' + (st.page * 15 - 14 + i) + '</span></td>' +
          '<td><span class="num">' + s.code + '</span></td><td>' + esc(s.name) + '</td>' +
          '<td class="num">' + nf(q.price) + '</td>' +
          '<td class="num">' + pctSpan(q.chgPct) + '</td>' +
          '<td class="num">' + (q.amount ? fmt(q.amount) : '--') + '</td>' +
          '<td class="num">' + nf(q.turnover, 2) + '%</td>' +
          '<td class="num">' + nf(q.pe, 1) + '</td>' +
          '<td class="num">' + (annual.roe == null ? '--' : annual.roe.toFixed(1)) + '</td>' +
          '<td class="num ' + upTxt(fin.npYoY) + '">' + (fin.npYoY == null ? '--' : D.fmtPct(fin.npYoY)) + '</td>' +
          '<td class="num">' + nf(q.dvYield, 2) + '%</td>' +
          '<td><button class="star-btn ' + (inWatch(s.code) ? 'on' : '') + '" data-act="star" data-code="' + s.code + '" onclick="event.stopPropagation()">★</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>' +
      (res.length === 0 ? '<div class="empty-state" style="padding:30px"><div class="e-ico">🔍</div><div class="e-t">没有股票满足当前条件组合</div><div class="e-s">尝试放宽条件或调整逻辑</div></div>' : '') +
      pagerHTML(st.page, pages, 'screen');
    $$('#resBody th.sortable').forEach(th => th.onclick = () => {
      const k = th.dataset.sort;
      if (st.sortKey === k) st.sortDir *= -1; else { st.sortKey = k; st.sortDir = -1; }
      res.sort((a, b) => {
        let va = a.quote[k], vb = b.quote[k];
        if (va == null && k === 'roe') va = a.fin && a.fin.annual && a.fin.annual.length ? a.fin.annual[a.fin.annual.length - 1].roe : null;
        if (vb == null && k === 'roe') vb = b.fin && b.fin.annual && b.fin.annual.length ? b.fin.annual[b.fin.annual.length - 1].roe : null;
        if (va == null) va = -Infinity; if (vb == null) vb = -Infinity;
        return (va - vb) * st.sortDir;
      });
      renderScreenResults();
    });
  }
  const TECH_FIELDS = ['aboveMA20', 'aboveMA60', 'crossMA5_20', 'crossMA20_60', 'macdCross', 'kdjCross', 'rsi', 'breakout20', 'breakdown20', 'volBurst', 'upStreak', 'downStreak'];
  const FIN_FIELDS = ['revYoY', 'npYoY', 'grossMargin', 'netMargin', 'roe', 'debtRatio', 'ocf', 'growYears'];
  async function runScreenStrategy(strat, announce) {
    const list = state.realMode && QP.real ? QP.real.poolList() : D.buildAll().list;
    if (state.realMode && QP.real) {
      const used = new Set(strat.groups.flatMap(g => g.conds.map(c => c.field)));
      const codes = list.map(s => s.code);
      if (TECH_FIELDS.some(f => used.has(f))) {
        toast('正在加载全池历史K线数据(首次约1分钟,之后走缓存)…', 'info');
        await QP.real.ensureKlineAll(codes);
      }
      if (FIN_FIELDS.some(f => used.has(f))) {
        toast('正在加载全池财务数据(首次约1分钟,之后走缓存)…', 'info');
        await QP.real.ensureFinAll(codes);
      }
      if (used.has('dvYield')) {
        toast('正在加载全池分红数据以计算股息率(约10秒)…', 'info');
        await QP.real.ensureDividendsAll(codes);
      }
    }
    const res = S.run(strat, list);
    if (state.realMode && QP.real) {
      // 结果表展示 ROE/股息率,补齐命中个股的财务与分红
      await Promise.allSettled([
        QP.real.ensureFinAll(res.map(s => s.code)),
        Promise.all(res.map(s => QP.real.ensureDividends(s.code).catch(() => null)))
      ]);
    }
    state.screen.results = res;
    state.screen.sortKey = 'chgPct'; state.screen.sortDir = -1; state.screen.page = 1;
    state.screen.lastRun = new Date();
    strat.lastRunAt = new Date().toLocaleString('zh-CN');
    strat.lastCount = res.length;
    saveStrategies();
    renderScreenResults();
    if (announce) toast('选股完成,命中 ' + res.length + ' 只', 'ok');
  }

  /* ============================ 页面:自选股 ============================ */
  function renderWatchlist() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      const groups = state.watch.groups;
      const cur = state.watch.cur || groups[0].id;
      const g = groups.find(x => x.id === cur) || groups[0];
      const items = g.items.map(it => ({ it, s: D.getStock(it.code) })).filter(x => x.s);
      $('#content').innerHTML =
        pageHead('自选股', '分组管理 · 备注标签 · 价格提醒 · ' + (state.realMode ? '真实行情 3 秒自动刷新' : '模拟实时更新'),
          srcChip()) +
        '<div class="panel mb-16"><div class="panel-body flex gap-8 items-center" style="flex-wrap:wrap">' +
        '<span class="muted" style="font-size:12px">添加股票:</span>' +
        '<input class="input" id="wlSearch" placeholder="输入代码/名称搜索" style="width:230px">' +
        '<div id="wlSuggest" style="display:none"></div>' +
        '<span class="flex-1"></span>' +
        '<button class="btn" data-act="add-group">+ 新建分组</button>' +
        '</div></div>' +
        '<div class="tabs">' + groups.map(x =>
          '<button class="' + (x.id === g.id ? 'on' : '') + '" data-act="wl-group" data-gid="' + x.id + '">' + x.name + ' (' + x.items.length + ')</button>').join('') +
        '</div>' +
        '<div class="panel"><div class="table-wrap"><table class="grid"><thead><tr>' +
        '<th>名称</th><th>最新价</th><th>涨跌幅</th><th>成交量</th><th>换手率</th><th>PE</th><th>行业</th><th class="num">AI评分</th><th>风险</th><th>备注/标签</th><th>提醒</th><th style="width:40px"></th>' +
        '</tr></thead><tbody>' +
        items.map(({ it, s }) => {
          const rep = AI.analyze(s);
          return '<tr class="clickable" data-act="goto-stock" data-code="' + s.code + '">' +
            '<td><div>' + esc(s.name) + '</div><div class="muted num" style="font-size:11px">' + s.code + '</div></td>' +
            '<td class="num" data-wl="price">' + nf(s.quote.price) + '</td>' +
            '<td class="num" data-wl="chg">' + pctSpan(s.quote.chgPct) + '</td>' +
            '<td class="num" data-wl="vol">' + (s.quote.volume ? fmt(s.quote.volume) : '--') + '</td>' +
            '<td class="num">' + nf(s.quote.turnover, 2) + '%</td>' +
            '<td class="num">' + nf(s.quote.pe, 1) + '</td>' +
            '<td>' + s.industry + '</td>' +
            '<td class="num"><b class="' + (rep.overall_score >= 60 ? 'up-txt' : rep.overall_score >= 45 ? '' : 'down-txt') + '">' + rep.overall_score + '</b></td>' +
            '<td>' + (rep.risk_level === '高' ? '<span class="chip red">高</span>' : rep.risk_level === '中' ? '<span class="chip gold">中</span>' : '<span class="chip green">低</span>') + '</td>' +
            '<td><div style="max-width:150px">' + (it.note ? '<span class="chip">📝 ' + esc(it.note) + '</span>' : '<span class="muted" style="font-size:11px">无备注</span>') +
            (it.tags && it.tags.length ? ' ' + it.tags.map(t => '<span class="chip violet">' + esc(t) + '</span>').join(' ') : '') + '</div>' +
            '<button class="btn xs mt-8" data-act="edit-wl" data-code="' + s.code + '">备注/标签</button></td>' +
            '<td><button class="btn xs" data-act="set-alert" data-code="' + s.code + '">+ 提醒</button></td>' +
            '<td onclick="event.stopPropagation()"><button class="star-btn on" data-act="star" data-code="' + s.code + '" title="移出自选">✕</button></td>' +
            '</tr>';
        }).join('') +
        '</tbody></table></div>' +
        (items.length === 0 ? '<div class="empty-state"><div class="e-ico">⭐</div><div class="e-t">该分组暂无自选股</div><div class="e-s">在搜索框输入代码或名称添加,或在行情中心点击 ☆</div></div>' : '') +
        '</div>' +
        riskNote() +
        '<div class="page-foot">自选数据保存在浏览器本地(localStorage) · 行情为真实数据(东方财富) · 数据截止 ' + D.DATA_TIME + '</div>';
      const inp = $('#wlSearch');
      inp.addEventListener('input', () => {
        const q = inp.value.trim();
        const box = $('#wlSuggest');
        if (!q) { box.style.display = 'none'; return; }
        const hits = D.search(q).slice(0, 6);
        if (!hits.length) { box.style.display = 'none'; return; }
        box.style.display = 'block';
        box.className = 'panel';
        box.style.cssText = 'margin-top:8px;padding:8px;width:100%;';
        box.innerHTML = hits.map(s => '<div class="sd-item" data-act="wl-add" data-code="' + s.code + '">' +
          '<span class="sd-code">' + s.code + '</span><span class="sd-name">' + esc(s.name) + '</span>' +
          '<span class="sd-chg ' + upTxt(s.quote.chgPct) + '">' + D.fmtPct(s.quote.chgPct) + '</span></div>').join('');
      });
    }, 240);
  }
  function updateWatchLive(codes) {
    const tb = $('#content table.grid tbody');
    if (!tb) return;
    codes.forEach(code => {
      const s = D.getStock(code);
      if (!s) return;
      const row = tb.querySelector('tr[data-code="' + code + '"]');
      if (!row) return;
      const set = (c, html) => { const cell = row.querySelector('td[data-wl="' + c + '"]'); if (cell) { cell.innerHTML = html; flashCell(cell, s.quote.chgPct >= 0); } };
      set('price', nf(s.quote.price));
      set('chg', pctSpan(s.quote.chgPct));
      set('vol', s.quote.volume ? fmt(s.quote.volume) : '--');
    });
  }

  /* ============================ 页面:AI 对话 ============================ */
  function renderChat() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      const ctxCode = state.chatCtx || (state.watch.groups[0].items[0] && state.watch.groups[0].items[0].code) || '600519';
      const ctx = D.getStock(ctxCode);
      const { list } = D.buildAll();
      const wlCodes = state.watch.groups[0].items.map(it => it.code);
      $('#content').innerHTML =
        pageHead('AI 研究助手', '基于股票结构化数据回答问题 · 明确标注数据来源与推测内容',
          '<span class="chip violet">规则引擎</span> ' + srcChip()) +
        '<div class="panel" style="display:flex;flex-direction:column">' +
        '<div class="panel-body flex gap-8 items-center" style="padding-bottom:10px;border-bottom:1px solid var(--line);flex-wrap:wrap">' +
        '<span class="muted" style="font-size:12px">当前分析标的:</span>' +
        '<select class="select" id="chatCtx" style="width:220px">' +
        [ctx].concat(wlCodes.filter(c => c !== ctxCode).map(c => D.getStock(c)).filter(Boolean),
          list.slice().sort((a, b) => b.quote.mcap - a.quote.mcap).slice(0, 15).filter(s => s.code !== ctxCode && !wlCodes.includes(s.code))).map(s =>
          '<option value="' + s.code + '" ' + (s.code === ctxCode ? 'selected' : '') + '>' + esc(s.name) + ' (' + s.code + ')</option>').join('') +
        '</select>' +
        '<span class="chip gray">数据截止 ' + D.DATA_TIME + '</span>' +
        '</div>' +
        '<div class="chat-quick">' +
        ['分析一下这只股票最近上涨的原因', '它现在估值高不高?', '这家公司财务质量怎么样?', '有哪些主要风险?', '和同行业其他公司相比怎么样?', '帮我按低估值、高股息筛选股票'].map(q =>
          '<button data-act="chat-quick" data-q="' + esc(q) + '">' + q + '</button>').join('') +
        '</div>' +
        '<div class="chat-box">' +
        '<div class="chat-scroll" id="chatScroll"></div>' +
        '<div class="chat-input-row">' +
        '<input class="input flex-1" id="chatInput" placeholder="输入问题,例如:分析一下为什么最近上涨…">' +
        '<button class="btn primary" data-act="chat-send">发送</button>' +
        '</div></div></div>' +
        riskNote('AI 助手为规则引擎,只使用本系统的真实结构化数据回答(东方财富);无法获取的数据会明确说明,不编造信息;推测性内容标注「推测」。', true) +
        '<div class="page-foot">数据截止 ' + D.DATA_TIME + ' · 真实数据环境 · 不构成投资建议</div>';
      $('#chatCtx').onchange = e => { state.chatCtx = e.target.value; renderChat(); };
      const inp = $('#chatInput');
      inp.onkeydown = e => { if (e.key === 'Enter') sendChat(inp.value); };
      const sc = $('#chatScroll');
      if (!state.chatHist.length) {
        botMsg('你好,我是 **QuantPick 研究助手**。\n\n我可以基于当前股票的真实结构化数据(东方财富)回答估值、财务、风险、资金、新闻等问题,也能按「低估值、高成长、高股息」等关键词帮你筛选股票。\n\n所有回答均标注数据截止时间,推测性内容会明确标注「推测」,不构成投资建议。', ctx);
      } else {
        state.chatHist.forEach(m => m.role === 'me' ? meMsg(m.text) : botMsg(m.text, ctx, false));
      }
      sc.scrollTop = sc.scrollHeight;
      setTimeout(() => { sc.scrollTop = sc.scrollHeight; }, 60);
    }, 240);
  }
  function meMsg(text) {
    const sc = $('#chatScroll');
    if (!sc) return;
    const div = document.createElement('div');
    div.className = 'chat-msg me';
    div.innerHTML = esc(text) + '<span class="cm-time">' + new Date().toLocaleTimeString('zh-CN') + '</span>';
    sc.appendChild(div);
    sc.scrollTop = sc.scrollHeight;
  }
  function botMsg(text, ctx, animate) {
    const sc = $('#chatScroll');
    if (!sc) return;
    const div = document.createElement('div');
    div.className = 'chat-msg bot';
    if (animate === false) {
      div.innerHTML = mdLite(text) + '<span class="cm-time">' + new Date().toLocaleTimeString('zh-CN') + ' · 标的:' + ctx.name + '</span>';
      sc.appendChild(div);
      sc.scrollTop = sc.scrollHeight;
      return;
    }
    div.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span><span class="cm-time">' + new Date().toLocaleTimeString('zh-CN') + ' · ' + ctx.name + '</span>';
    sc.appendChild(div);
    sc.scrollTop = sc.scrollHeight;
    let i = 0;
    const full = mdLite(text);
    const timer = setInterval(() => {
      i += 2;
      div.innerHTML = full.slice(0, i) + '<span class="cm-time">' + new Date().toLocaleTimeString('zh-CN') + ' · 标的:' + ctx.name + '</span>';
      sc.scrollTop = sc.scrollHeight;
      if (i >= full.length) clearInterval(timer);
    }, 16);
  }
  async function sendChat(text) {
    text = (text || '').trim();
    if (!text) return;
    const stock = D.getStock(state.chatCtx) || D.getStock('600519');
    if (!stock) { toast('请先选择分析标的', 'warn'); return; }
    state.chatHist.push({ role: 'me', text: text });
    meMsg(text);
    // 思考中的气泡
    const sc = $('#chatScroll');
    const typingEl = document.createElement('div');
    typingEl.className = 'chat-msg bot';
    typingEl.innerHTML = '<span class="chat-typing"><i></i><i></i><i></i></span><span class="cm-time">思考中…</span>';
    sc.appendChild(typingEl);
    sc.scrollTop = sc.scrollHeight;
    try {
      const reply = await AI.chat(stock, text);
      state.chatHist.push({ role: 'bot', text: reply });
      typingEl.innerHTML = mdLite(reply) + '<span class="cm-time">' + new Date().toLocaleTimeString('zh-CN') + ' · 标的:' + stock.name + '</span>';
      sc.scrollTop = sc.scrollHeight;
    } catch (e) {
      typingEl.innerHTML = '<div style="color:var(--danger)">回答生成失败:' + esc(e.message) + '</div>';
    }
    $('#chatInput').value = '';
  }
  function mdLite(t) {
    let h = esc(t);
    h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    h = h.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    h = h.replace(/^(\|.*\|)$/gm, m => { // 表格行
      const cells = m.split('|').slice(1, -1);
      if (/^[-\s:]+$/.test(cells.join(''))) return '<tr class="sep">' + cells.map(() => '<td></td>').join('') + '</tr>';
      const tag = m.trim().startsWith('|---') || /^(\|?)\s*[-: ]*\|/.test(m) && cells.every(c => /^[-: ]+$/.test(c)) ? '' : (cells.length && /^[-: ]+$/.test(cells.join('')) ? '' : 'td');
      return '<tr>' + cells.map(c => '<' + tag + '>' + c.trim() + '</' + tag + '>').join('') + '</tr>';
    });
    h = h.replace(/<tr class="sep">.*?<\/tr>/g, '');
    // 把连续表格行包成 table
    const rows = h.split('\n');
    let out = '', inT = false;
    rows.forEach(r => {
      if (r.startsWith('<tr>')) {
        if (!inT) { out += '<table>'; inT = true; }
        out += r;
      } else {
        if (inT) { out += '</table>'; inT = false; }
        out += r;
      }
    });
    if (inT) out += '</table>';
    h = out;
    h = h.replace(/^- (.+)$/gm, '<div style="padding-left:10px">• $1</div>');
    h = h.replace(/\n{2,}/g, '<br><br>');
    h = h.replace(/\n/g, '<br>');
    return h;
  }

  /* ============================ 页面:回测 ============================ */
  function renderBacktest() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      const saved = state.strategies;
      $('#content').innerHTML =
        pageHead('策略回测', '简化版组合回测 · 等权持仓 · 次日收盘成交 · 避免未来数据',
          '<span class="chip gold">简化版</span> ' + srcChip()) +
        '<div class="panel mb-16"><div class="panel-body flex gap-12 items-center" style="flex-wrap:wrap">' +
        '<span class="muted" style="font-size:12.5px">回测策略</span>' +
        '<select class="select" id="btStrategy" style="width:230px">' +
        '<option value="">—— 请选择已保存策略 ——</option>' +
        saved.map(x => '<option value="' + x.id + '">' + x.name + '</option>').join('') +
        '</select>' +
        '<span class="muted" style="font-size:12.5px">周期</span>' +
        '<select class="select" id="btPeriod" style="width:170px">' +
        BT.PERIODS.map(p => '<option value="' + p.days + '">' + p.label + '</option>').join('') +
        '</select>' +
        '<span class="muted" style="font-size:12.5px">初始资金</span>' +
        '<input class="input num" id="btCapital" value="1000000" style="width:130px">' +
        '<button class="btn primary" data-act="bt-run">开始回测</button>' +
        '</div></div>' +
        '<div class="risk-note danger mb-16"><span class="rn-ico">⚠️</span><span>' + esc(BT.LIMITS) + '</span></div>' +
        '<div id="btResult"><div class="empty-state" style="padding:60px 0"><div class="e-ico">📈</div><div class="e-t">尚未运行回测</div><div class="e-s">先在「条件选股」页保存一个策略,再回到这里回测</div></div></div>' +
        '<div class="page-foot">历史回测不代表未来收益 · 基于真实K线数据 · 数据截止 ' + D.DATA_TIME + '</div>';
    }, 240);
  }
  /* 当前回测页选中的策略(供窗口稳健性分析复用,避免重复解析) */
  function btStrategy() {
    const sel = $('#btStrategy');
    if (!sel) return null;
    return state.strategies.find(x => x.id === sel.value) || null;
  }
  async function runBacktest() {
    const sel = $('#btStrategy');
    const strat = state.strategies.find(x => x.id === sel.value);
    if (!strat) { toast('请先选择已保存的策略(可在条件选股页保存)', 'warn'); return; }
    const days = +$('#btPeriod').value || 120;
    const capital = +$('#btCapital').value || 1000000;
    const btn = $('[data-act="bt-run"]');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 回测计算中';
    try {
      // 真实模式:补齐全池历史 K 线与财务(回测必须),并加载基准指数K线
      if (state.realMode && QP.real) {
        btn.innerHTML = '<span class="spin"></span> 加载历史数据中(首次约1分钟)…';
        await Promise.all([
          QP.real.ensureKlineAll(),
          QP.real.ensureFinAll(),
          QP.real.ensureIndexKline('000001')
        ]);
        btn.innerHTML = '<span class="spin"></span> 回测计算中…';
      }
      const res = BT.backtest(strat, days, capital, state.realMode && QP.real ? QP.real.poolList() : null);
      state.bt = res;
      btn.disabled = false; btn.textContent = '开始回测';
      renderBtResult(res);
      toast('回测完成:' + D.fmtPct(res.metrics.totalReturn), res.metrics.totalReturn >= 0 ? 'ok' : 'warn');
    } catch (e) {
      btn.disabled = false; btn.textContent = '开始回测';
      toast('回测失败:' + e.message, 'err');
    }
  }
  function renderBtResult(res) {
    const m = res.metrics;
    const cell = (l, v, cls) => '<div class="panel bt-cell"><div class="bc-l">' + l + '</div><div class="bc-v ' + (cls || '') + '">' + v + '</div></div>';
    $('#btResult').innerHTML =
      '<div class="bt-metrics">' +
      cell('总收益率', D.fmtPct(m.totalReturn), upTxt(m.totalReturn)) +
      cell('年化收益率', D.fmtPct(m.annualized), upTxt(m.annualized)) +
      cell('最大回撤', D.fmtPct(m.maxDrawdown), 'down-txt') +
      cell('胜率', m.winRate.toFixed(1) + '%', '') +
      cell('盈亏比', m.plRatio.toFixed(2), '') +
      cell('交易次数', m.trades, '') +
      cell('总手续费', fmt(m.fees), '') +
      cell('基准收益(上证)', D.fmtPct(m.benchReturn), upTxt(m.benchReturn)) +
      cell('超额收益', D.fmtPct(m.excess), upTxt(m.excess)) +
      cell('期末资产', fmt(m.finalValue), upTxt(m.totalReturn)) +
      '</div>' +
      '<div class="grid-2 mb-16">' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>净值曲线(策略 vs 基准)</div></div>' +
      '<div class="panel-body"><div class="chart" id="chart-bt-eq" style="height:300px"></div></div></div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot red"></span>回撤曲线</div></div>' +
      '<div class="panel-body"><div class="chart" id="chart-bt-dd" style="height:300px"></div></div></div>' +
      '</div>' +
      '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>逐笔交易记录(' + res.trades.length + ')</div>' +
      '<div class="panel-tools"><span class="chip gray">' + res.period[0] + ' ~ ' + res.period[1] + ' · 初始资金 ' + fmt(res.initialCapital) + '</span></div></div>' +
      '<div class="table-wrap"><table class="grid"><thead><tr><th>#</th><th>股票</th><th class="num">买入日</th><th class="num">买入价</th><th class="num">卖出日</th><th class="num">卖出价</th><th class="num">盈亏</th><th class="num">盈亏%</th></tr></thead><tbody>' +
      res.trades.slice().reverse().slice(0, 60).map((t, i) =>
        '<tr' + (t.isOpen ? ' style="opacity:.65"' : '') + '><td class="num">' + (res.trades.length - i) + '</td>' +
        '<td>' + t.name + '<span class="muted num" style="font-size:10.5px"> ' + t.code + '</span></td>' +
        '<td class="num">' + t.buyDate + '</td><td class="num">' + t.buyPrice + '</td>' +
        '<td class="num">' + (t.sellDate || '持有中') + '</td><td class="num">' + (t.sellPrice || '--') + '</td>' +
        '<td class="num ' + upTxt(t.pnl) + '">' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(0) + '</td>' +
        '<td class="num ' + upTxt(t.pnlPct) + '">' + D.fmtPct(t.pnlPct) + '</td></tr>').join('') +
      '</tbody></table></div></div>' +
      '<div class="risk-note danger mt-16"><span class="rn-ico">⚠️</span><span>历史回测不代表未来收益。回测未模拟停牌/涨跌停无法成交、分红除权等真实约束,且部分估值类条件使用最新报告期数据。</span></div>' +
      '<div id="btMc"></div><div id="btSens"></div>';
    const eq = res.equity, bm = res.benchmark;
    const eq0 = eq[0] ? eq[0].value : 1, bm0 = bm[0] ? bm[0].value : 1;
    chart($('#chart-bt-eq'), {
      grid: { left: 10, right: 14, top: 34, bottom: 4, containLabel: true },
      legend: { textStyle: { color: '#9ba8c9', fontSize: 11 }, top: 2 },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)', textStyle: { color: '#e9eef8' }, valueFormatter: v => (v * 100).toFixed(2) + '%' },
      xAxis: { type: 'category', data: eq.map(p => p.date), axisLabel: { color: '#5f6d92', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
      yAxis: { type: 'value', axisLabel: { color: '#5f6d92', formatter: v => (v * 100).toFixed(0) + '%' }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
      series: [
        { name: '策略净值', type: 'line', data: eq.map(p => +(p.value / eq0 - 1).toFixed(4)), smooth: true, symbol: 'none', lineStyle: { width: 2, color: '#f5222d' }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(245,34,45,.32)' }, { offset: 1, color: 'rgba(245,34,45,0)' }]) } },
        { name: '基准(上证指数)', type: 'line', data: bm.map(p => +(p.value / bm0 - 1).toFixed(4)), smooth: true, symbol: 'none', lineStyle: { width: 1.4, color: '#f0b90b', type: 'dashed' } }
      ]
    });
    chart($('#chart-bt-dd'), {
      grid: { left: 10, right: 14, top: 16, bottom: 4, containLabel: true },
      tooltip: { trigger: 'axis', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)', textStyle: { color: '#e9eef8' }, valueFormatter: v => v.toFixed(2) + '%' },
      xAxis: { type: 'category', data: res.drawdown.map(p => p.date), axisLabel: { color: '#5f6d92', fontSize: 10 }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
      yAxis: { type: 'value', max: 0, axisLabel: { color: '#5f6d92', formatter: v => v + '%' }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
      series: [{ type: 'line', data: res.drawdown.map(p => p.value), symbol: 'none', lineStyle: { width: 1.6, color: '#f6465d' }, areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(246,70,93,.35)' }, { offset: 1, color: 'rgba(246,70,93,0)' }]) } }]
    });
    renderBtMonteCarlo(res);
    renderBtSensitivityShell();
  }
  /* ---------------- 蒙特卡洛回撤(UI) ----------------
   * 历史最大回撤只是"已发生的那一条路径";这里对日收益做自助重采样模拟大量路径,
   * 给出回撤分布,用于判断历史回撤是否偏乐观。 */
  function renderBtMonteCarlo(res) {
    const box = $('#btMc');
    if (!box || !BT.monteCarloDrawdown) return;
    const mc = BT.monteCarloDrawdown(res, { paths: 400 });
    if (!mc) { box.innerHTML = ''; return; }
    const chip = (l, v, cls) => '<span class="chip ' + (cls || '') + '">' + l + ' ' + v + '</span>';
    const riskCls = mc.probWorseThanHist >= 60 ? 'red' : mc.probWorseThanHist >= 35 ? 'gold' : 'green';
    const riskTxt = mc.probWorseThanHist >= 60 ? '历史回撤偏乐观(多数模拟路径更差)'
      : mc.probWorseThanHist >= 35 ? '历史回撤略偏乐观' : '历史回撤具有代表性';
    box.innerHTML = '<div class="panel mt-16"><div class="panel-head">' +
      '<div class="panel-title"><span class="dot violet"></span>蒙特卡洛回撤(自助重采样 ' + mc.paths + ' 条路径)</div>' +
      '<div class="panel-tools">' + chip('样本', mc.samples + ' 个交易日收益') + '</div></div>' +
      '<div class="panel-body">' +
      '<div class="flex gap-8 mb-16" style="flex-wrap:wrap">' +
      chip('历史最大回撤', mc.histDD + '%', 'gold') +
      chip('回撤中位数', mc.dd.median + '%') +
      chip('P95(最差5%)', mc.dd.p95 + '%', 'red') +
      chip('模拟最差', mc.dd.worst + '%', 'red') +
      chip('比历史更差概率', mc.probWorseThanHist + '%', riskCls) +
      chip('收益中位数', (mc.ret.median > 0 ? '+' : '') + mc.ret.median + '%') +
      '</div>' +
      '<div class="chart" id="chart-bt-mc" style="height:200px"></div>' +
      '<div class="muted mt-8" style="font-size:11.5px;line-height:1.8">' +
      '做法:提取策略净值的日收益率,有放回随机重采样 ' + mc.paths + ' 次(每次 ' + mc.horizon + ' 个交易日),统计各路径的最大回撤分布。' +
      '<br><b style="color:var(--txt-1)">结论:' + riskTxt + '</b>——模拟路径中有 ' + mc.probWorseThanHist + '% 的回撤比历史值(' + mc.histDD + '%)更差。' +
      '该分析为纯统计推演,不改变策略与成交规则,不构成投资建议。</div>' +
      '</div></div>';
    if (window.echarts && mc.hist) {
      chart($('#chart-bt-mc'), {
        grid: { left: 44, right: 16, top: 22, bottom: 26 },
        tooltip: {
          trigger: 'axis', backgroundColor: 'rgba(13,20,40,.95)', borderColor: 'rgba(140,160,210,.2)',
          textStyle: { color: '#e9eef8', fontSize: 12 },
          formatter: p => '回撤约 ' + p[0].name + '%<br>路径数 ' + p[0].value +
            ' <span style="opacity:.7">(' + (p[0].value / mc.paths * 100).toFixed(1) + '%)</span>'
        },
        xAxis: { type: 'category', data: mc.hist.bins, axisLabel: { color: '#9ba8c9', fontSize: 10, formatter: v => v + '%' }, axisTick: { show: false }, axisLine: { lineStyle: { color: 'rgba(140,160,210,.15)' } } },
        yAxis: { type: 'value', name: '路径数', nameTextStyle: { color: '#5f6d92', fontSize: 10 }, axisLabel: { color: '#5f6d92', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(140,160,210,.07)' } } },
        series: [{
          type: 'bar', data: mc.hist.counts, barWidth: '82%',
          itemStyle: { color: 'rgba(167,139,250,.55)', borderRadius: [3, 3, 0, 0] },
          markLine: {
            silent: true, symbol: 'none',
            data: [{ xAxis: mc.hist.bins.reduce((best, b, i) => Math.abs(b - mc.histDD) < Math.abs(mc.hist.bins[best] - mc.histDD) ? i : best, 0),
              lineStyle: { color: '#f5b301', type: 'dashed', width: 1.4 },
              label: { formatter: '历史 ' + mc.histDD + '%', color: '#f5b301', fontSize: 10 } }]
          }
        }]
      });
    }
  }
  /* ---------------- 窗口稳健性(参数敏感性) ----------------
   * 同一策略在不同回测窗口重跑:结论若随窗口剧烈变化,说明对区间敏感、稳健性不足。
   * 计算量为单次回测的 N 倍,故按需触发(点击按钮)而非自动执行。 */
  function renderBtSensitivityShell() {
    const box = $('#btSens');
    if (!box) return;
    box.innerHTML = '<div class="panel mt-16"><div class="panel-head">' +
      '<div class="panel-title"><span class="dot gold"></span>窗口稳健性分析</div>' +
      '<div class="panel-tools"><button class="btn sm" data-act="bt-sens">📊 运行(4 个窗口)</button></div></div>' +
      '<div class="panel-body"><div class="muted" style="font-size:12px;line-height:1.9">' +
      '把同一策略分别在近 60 / 120 / 180 / 250 个交易日上重跑,对比收益、回撤与超额收益:' +
      '<br>· 各窗口均盈利且均跑赢基准 → 稳健性<b>高</b>' +
      '<br>· 各窗口均盈利 → <b>中</b>;出现亏损 → <b>低</b>(结果可能依赖特定区间)' +
      '</div></div></div>';
  }
  function renderBtSensitivity() {
    const box = $('#btSens');
    if (!box || !BT.periodSensitivity) return;
    const strat = btStrategy ? btStrategy() : null;
    if (!strat) { toast('请先选择策略并回测', 'warn'); return; }
    const capital = +($('#btCapital') || {}).value || 1000000;
    const stockList = (state.realMode && QP.real) ? QP.real.poolList() : null;
    box.innerHTML = '<div class="panel mt-16"><div class="panel-body center" style="padding:26px">' +
      '<span class="spin"></span> 正在按 4 个窗口分别回测…</div></div>';
    setTimeout(() => {
      let sens;
      try { sens = BT.periodSensitivity(strat, capital, stockList); }
      catch (e) { box.innerHTML = '<div class="panel mt-16"><div class="panel-body center" style="padding:26px">分析失败:' + esc(e.message) + '</div></div>'; return; }
      const rCls = sens.robustness === '高' ? 'green' : sens.robustness === '中' ? 'gold' : sens.robustness === '低' ? 'red' : 'gray';
      box.innerHTML = '<div class="panel mt-16"><div class="panel-head">' +
        '<div class="panel-title"><span class="dot gold"></span>窗口稳健性分析(同策略 · 不同回测窗口)</div>' +
        '<div class="panel-tools">' +
        '<span class="chip ' + rCls + '">稳健性:' + sens.robustness + '</span>' +
        (sens.spreadReturn ? '<span class="chip gray">收益区间 ' + sens.spreadReturn.min + '% ~ ' + sens.spreadReturn.max + '%</span>' : '') +
        '<button class="btn sm" data-act="bt-sens">重新计算</button></div></div>' +
        '<div class="table-wrap"><table class="grid"><thead><tr>' +
        '<th>回测窗口</th><th class="num">总收益率</th><th class="num">年化</th><th class="num">最大回撤</th>' +
        '<th class="num">超额收益</th><th class="num">胜率</th><th class="num">交易次数</th></tr></thead><tbody>' +
        sens.rows.map(r => r.empty
          ? '<tr><td>' + r.label + '</td><td colspan="6" class="muted center">数据不足(需≥120个交易日的K线)</td></tr>'
          : '<tr><td>' + r.label + '</td>' +
          '<td class="num ' + upTxt(r.totalReturn) + '">' + D.fmtPct(r.totalReturn) + '</td>' +
          '<td class="num ' + upTxt(r.annualized) + '">' + D.fmtPct(r.annualized) + '</td>' +
          '<td class="num down-txt">' + D.fmtPct(r.maxDrawdown) + '</td>' +
          '<td class="num ' + upTxt(r.excess) + '">' + D.fmtPct(r.excess) + '</td>' +
          '<td class="num">' + (r.winRate != null ? r.winRate.toFixed(1) + '%' : '--') + '</td>' +
          '<td class="num">' + r.trades + '</td></tr>').join('') +
        '</tbody></table></div>' +
        '<div class="panel-body"><div class="muted" style="font-size:12px;line-height:1.9;padding-top:10px">' +
        '· 稳健性判定:<b>高</b>=各窗口均盈利且均跑赢基准;<b>中</b>=各窗口均盈利;<b>低</b>=存在亏损窗口。' +
        '<br>· 若不同窗口结论差异很大,说明策略表现依赖特定区间(过拟合风险),应谨慎看待单次回测结果。' +
        '<br>· 本分析仅改变回测区间,策略条件、成交规则与费用口径完全一致。</div></div></div>';
    }, 30);
  }

  /* ============================ 页面:消息提醒 ============================ */
  function renderAlerts() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      const { list } = D.buildAll();
      $('#content').innerHTML =
        pageHead('消息提醒', '价格 / 涨跌幅 / 成交量提醒 · ' + (state.realMode ? '由真实行情轮询触发(约3秒)' : '由模拟行情触发'),
          srcChip()) +
        '<div class="panel mb-16"><div class="panel-head"><div class="panel-title"><span class="dot"></span>新建提醒</div></div>' +
        '<div class="panel-body flex gap-12 items-center" style="flex-wrap:wrap">' +
        '<input class="input" id="alStock" placeholder="输入股票代码/名称" style="width:210px">' +
        '<select class="select" id="alType" style="width:130px">' +
        '<option value="price">价格</option><option value="chg">涨跌幅</option><option value="volume">成交量</option>' +
        '</select>' +
        '<select class="select" id="alOp" style="width:90px"><option value=">">大于等于</option><option value="<">小于等于</option></select>' +
        '<input class="input num" id="alVal" placeholder="阈值" style="width:110px">' +
        '<button class="btn primary" data-act="al-add">添加提醒</button>' +
        '<span class="muted" style="font-size:11.5px">涨跌幅阈值单位 % · 成交量单位 万手</span>' +
        '</div></div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>我的提醒(' + state.alerts.length + ')</div></div>' +
        '<div class="table-wrap"><table class="grid"><thead><tr><th>股票</th><th>提醒条件</th><th>类型</th><th>状态</th><th>上次触发</th><th style="width:90px">操作</th></tr></thead><tbody>' +
        (state.alerts.length ? state.alerts.map(a => {
          const s = D.getStock(a.code);
          const cond = (a.type === 'price' ? '价格' : a.type === 'chg' ? '涨跌幅' : '成交量') + ' ' + (a.op === '>' ? '≥' : '≤') + ' ' + a.value + (a.type === 'price' ? ' 元' : a.type === 'chg' ? '%' : ' 万手');
          return '<tr><td>' + (s ? s.name : a.code) + '<span class="muted num" style="font-size:10.5px"> ' + a.code + '</span></td>' +
            '<td class="num">' + cond + '</td>' +
            '<td>' + (a.type === 'price' ? '<span class="chip">价格</span>' : a.type === 'chg' ? '<span class="chip gold">涨跌</span>' : '<span class="chip violet">量能</span>') + '</td>' +
            '<td><span class="switch ' + (a.enabled ? 'on' : '') + '" data-act="al-toggle" data-id="' + a.id + '"></span></td>' +
            '<td class="muted" style="font-size:11.5px">' + (a.lastTriggeredAt || '尚未触发') + '</td>' +
            '<td><button class="btn xs danger" data-act="al-del" data-id="' + a.id + '">删除</button></td></tr>';
        }).join('') :
          '<tr><td colspan="6" class="center muted" style="padding:30px">暂无提醒,设置后会在行情波动时触发</td></tr>') +
        '</tbody></table></div></div>' +
        riskNote('提醒由真实行情轮询(每 3 秒)自动检测并触发,无需刷新页面。') +
        '<div class="page-foot">提醒保存在浏览器本地 · 真实数据环境 · 不构成投资建议</div>';
    }, 240);
  }

  /* ============================ 页面:设置 ============================ */
  function renderSettings() {
    const token = ++state.renderToken;
    $('#content').innerHTML = skeleton();
    setTimeout(() => {
      if (token !== state.renderToken) return;
      const st = state.settings;
      $('#content').innerHTML =
        pageHead('系统设置', '外观 / 数据 / 服务状态', srcChip()) +
        '<div class="panel mb-16" style="border-color:rgba(46,189,133,.25)"><div class="panel-head"><div class="panel-title"><span class="dot green"></span>数据源状态</div></div>' +
        '<div class="panel-body">' +
        '<div class="grid-2" style="gap:10px">' +
        '<div class="flex items-center gap-8" style="padding:12px;background:rgba(9,14,28,.55);border:1px solid var(--line);border-radius:10px"><span>' + (state.realMode ? '🟢' : '🔴') + '</span><div><div style="font-size:13.5px">' + (state.realMode ? '东方财富 · 准实时数据' : '数据服务不可用') + '</div><div class="muted" style="font-size:11.5px">' + (state.realMode ? '行情约 2~3 秒缓存,前端每 3 秒轮询;K线/财务/资金/新闻懒加载' : '本系统不展示模拟数据;请运行 node server.js 后刷新') + '</div></div></div>' +
        '<div class="flex items-center gap-8" style="padding:12px;background:rgba(9,14,28,.55);border:1px solid var(--line);border-radius:10px"><span>🕐</span><div><div style="font-size:13.5px">数据更新时间</div><div class="muted num" style="font-size:11.5px">' + D.DATA_TIME + '</div></div></div>' +
        '</div>' +
        '<div class="muted mt-12" style="font-size:11.5px;line-height:1.8">启动真实数据服务:在 quantpick 目录执行 <code>node server.js</code>(或双击 start.bat)。股东户数/十大股东接口暂未接入;北向资金字段暂未接入;全市场行业分类来自东方财富。</div>' +
        '</div></div>' +
        '<div class="grid-2">' +
        '<div class="panel mb-16"><div class="panel-head"><div class="panel-title"><span class="dot"></span>涨跌颜色约定</div></div>' +
        '<div class="panel-body">' +
        '<div class="flex gap-12 items-center">' +
        '<button class="btn ' + (st.colorMode === 'cn' ? 'primary' : '') + '" data-act="color-mode" data-mode="cn">A股:红涨绿跌</button>' +
        '<button class="btn ' + (st.colorMode === 'intl' ? 'primary' : '') + '" data-act="color-mode" data-mode="intl">国际:绿涨红跌</button>' +
        '</div>' +
        '<div class="muted mt-12" style="font-size:12px;line-height:1.8">切换后全局生效,包括 K 线、表格、跑马灯与图表。</div></div></div>' +
        '<div class="panel mb-16"><div class="panel-head"><div class="panel-title"><span class="dot gold"></span>' + (state.realMode ? '行情自动刷新' : '模拟实时行情') + '</div></div>' +
        '<div class="panel-body flex items-center gap-12">' +
        '<span class="switch ' + (st.live ? 'on' : '') + '" data-act="live-toggle"></span>' +
        '<div><div style="font-size:13.5px">' + (state.realMode
          ? (st.live ? '已开启:每 3 秒自动刷新全部真实行情' : '已关闭:行情停止自动刷新(不推荐)')
          : (st.live ? '已开启:每 2.6 秒随机波动一批股票价格' : '已关闭:行情保持静态')) + '</div>' +
        '<div class="muted" style="font-size:11.5px">' + (state.realMode
          ? '真实模式下自动刷新建议保持开启,所有页面数字实时更新,无需手动刷新'
          : '用于演示提醒触发与动态刷新效果') + '</div></div></div></div>' +
        '<div class="panel mb-16"><div class="panel-head"><div class="panel-title"><span class="dot violet"></span>本地数据</div></div>' +
        '<div class="panel-body flex gap-8" style="flex-wrap:wrap">' +
        '<button class="btn" data-act="export-data">导出数据(JSON)</button>' +
        '<button class="btn" data-act="import-data">导入数据</button>' +
        '<input type="file" id="importFile" accept=".json" style="display:none">' +
        '<button class="btn danger" data-act="clear-data">清空全部本地数据</button>' +
        '</div></div>' +
        '</div>' +
        '<div class="panel"><div class="panel-head"><div class="panel-title"><span class="dot"></span>关于 QuantPick</div></div>' +
        '<div class="panel-body" style="font-size:13px;color:var(--txt-2);line-height:2.1">' +
        '<b style="color:var(--txt-1)">QuantPick 智能选股终端</b> — v1.1.0(真实数据版)<br>' +
        '· 技术栈:Node 数据服务(server.js) + 原生 JS SPA + ECharts<br>' +
        '· 数据:<b>东方财富 + 腾讯公开接口,全市场约 5900 只 A 股真实行情/指数/榜单/K线/财务/资金/新闻/分红</b>,前端每 3 秒自动刷新<br>' +
        '· 功能:仪表盘 / 榜单中心(完整榜单) / 行情中心 / 条件选股(AND·OR·NOT) / 自选股 / AI 分析 / AI 对话 / 简化版回测 / 消息提醒<br>' +
        '· 边界:股东户数/十大股东、北向资金暂未接入;条件选股与回测使用精选样本池(全市场K线加载不可行);分钟级资金流未接入<br>' +
        '· 服务不可用时页面明确报错,<b>不展示任何模拟数据</b>;用户数据仅保存在浏览器本地(localStorage)' +
        '</div></div>' +
        riskNote('行情与资讯来自东方财富/腾讯公开接口,仅供技术演示与研究;不构成投资建议,据此操作,风险自担。', true) +
        '<div class="page-foot">QuantPick · 真实数据环境 · 数据截止 ' + D.DATA_TIME + '</div>';
    }, 240);
  }
  function applyColorMode() {
    const st = state.settings;
    const r = document.documentElement;
    if (st.colorMode === 'cn') {
      r.style.setProperty('--up', '#f5222d');
      r.style.setProperty('--down', '#00b578');
    } else {
      r.style.setProperty('--up', '#00b578');
      r.style.setProperty('--down', '#f5222d');
    }
    LS.set('qp_settings', st);
  }

  /* ============================ 全局事件 ============================ */
  document.addEventListener('click', e => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    const act = t.dataset.act;
    switch (act) {
      case 'chart-idx': location.hash = '#/market'; break;
      case 'goto-stock': location.hash = '#/stock/' + t.dataset.code; break;
      case 'goto-chat': state.chatCtx = t.dataset.code; location.hash = '#/chat'; break;
      case 'goto-ai': location.hash = '#/stock/' + t.dataset.code + '/ai'; break;
      case 'star': {
        const code = t.dataset.code;
        if (inWatch(code)) { removeFromWatch(code); toast('已从自选移除', 'info'); }
        else { addToWatch(code); toast('已加入自选', 'ok'); }
        t.classList.toggle('on', inWatch(code));
        t.innerHTML = inWatch(code) ? '★ 已在自选' : '☆ 加入自选';
        refreshWatchBadge();
        break;
      }
      case 'batch-watch': {
        const codes = $$('.mk-chk:checked, #resBody .mk-chk:checked').map(c => c.value);
        const pool = codes.length ? codes : (state.screen.results || []).slice(0, 20).map(s => s.code);
        if (!pool.length) { toast('请先勾选要加入的股票(或先执行选股)', 'warn'); return; }
        let n = 0;
        pool.forEach(c => { if (addToWatch(c)) n++; });
        toast('已批量加入 ' + n + ' 只到「默认自选」', 'ok');
        refreshWatchBadge();
        break;
      }
      case 'stock-tab': {
        const m = location.hash.match(/^#\/stock\/(\d{4,6})/);
        if (m) location.hash = '#/stock/' + m[1] + '/' + t.dataset.tab;
        break;
      }
      case 'kp': state.screen.kp = t.dataset.kp; route(); break;
      case 'ind': {
        state.screen.inds = state.screen.inds || {};
        state.screen.inds[t.dataset.ind] = !state.screen.inds[t.dataset.ind];
        const m = location.hash.match(/^#\/stock\/(\d{4,6})/);
        if (m) renderKline(D.getStock(m[1]));
        t.classList.toggle('on');
        break;
      }
      case 'set-alert': {
        const code = t.dataset.code;
        const s = D.getStock(code);
        openModal('设置提醒 · ' + (s ? s.name : code),
          '<div class="flex gap-8" style="flex-wrap:wrap">' +
          '<select class="select" id="alTypeM" style="width:120px"><option value="price">价格</option><option value="chg">涨跌幅</option><option value="volume">成交量</option></select>' +
          '<select class="select" id="alOpM" style="width:110px"><option value=">">大于等于</option><option value="<">小于等于</option></select>' +
          '<input class="input num" id="alValM" placeholder="阈值" style="width:120px"></div>' +
          '<div class="muted mt-8" style="font-size:11.5px">涨跌幅阈值单位 %,成交量单位 万手。触发后通过右上角铃铛与 Toast 通知。</div>',
          '<button class="btn" data-act="modal-cancel">取消</button><button class="btn primary" data-act="modal-al-ok" data-code="' + code + '">确认添加</button>');
        break;
      }
      case 'modal-al-ok': {
        const code = t.dataset.code;
        const val = $('#alValM').value.trim();
        if (!val || isNaN(+val)) { toast('请输入有效阈值', 'warn'); return; }
        state.alerts.push({
          id: 'a' + Date.now().toString(36), code: code,
          type: $('#alTypeM').value, op: $('#alOpM').value, value: +val,
          enabled: true, lastTriggeredAt: null
        });
        saveAlerts(); closeModal();
        toast('提醒已添加(演示)', 'ok');
        break;
      }
      case 'al-add': {
        const q = $('#alStock').value.trim();
        const hits = D.search(q);
        if (!hits.length) { toast('未找到该股票', 'warn'); return; }
        const code = hits[0].code;
        const val = $('#alVal').value.trim();
        if (!val || isNaN(+val)) { toast('请输入有效阈值', 'warn'); return; }
        state.alerts.push({ id: 'a' + Date.now().toString(36), code: code, type: $('#alType').value, op: $('#alOp').value, value: +val, enabled: true, lastTriggeredAt: null });
        saveAlerts();
        toast('提醒已添加:' + hits[0].name, 'ok');
        renderAlerts();
        break;
      }
      case 'al-toggle': {
        const a = state.alerts.find(x => x.id === t.dataset.id);
        if (a) { a.enabled = !a.enabled; saveAlerts(); renderAlerts(); }
        break;
      }
      case 'al-del': {
        state.alerts = state.alerts.filter(x => x.id !== t.dataset.id);
        saveAlerts(); renderAlerts(); toast('提醒已删除', 'info');
        break;
      }
      case 'add-group': {
        const name = prompt('分组名称(最多6字):');
        if (!name) return;
        state.watch.groups.push({ id: 'g' + Date.now().toString(36), name: name.slice(0, 6), items: [] });
        state.watch.cur = state.watch.groups[state.watch.groups.length - 1].id;
        saveWatch(); renderWatchlist();
        break;
      }
      case 'wl-group': state.watch.cur = t.dataset.gid; saveWatch(); renderWatchlist(); break;
      case 'wl-add': {
        if (addToWatch(t.dataset.code)) { toast('已加入自选', 'ok'); renderWatchlist(); }
        else toast('已在自选中', 'info');
        refreshWatchBadge();
        break;
      }
      case 'edit-wl': {
        const code = t.dataset.code;
        let found = null;
        state.watch.groups.forEach(g => g.items.forEach(it => { if (it.code === code) found = it; }));
        if (!found) return;
        const s = D.getStock(code);
        openModal('自选备注 · ' + (found ? found.name : code),
          '<div class="field"><label>备注</label><input class="input" id="wlNote" value="' + esc(found.note || '') + '" placeholder="如:回调到 45 元附近关注"></div>' +
          '<div class="field"><label>标签(逗号分隔)</label><input class="input" id="wlTags" value="' + esc((found.tags || []).join(',')) + '" placeholder="如:长线,高股息"></div>',
          '<button class="btn" data-act="modal-cancel">取消</button><button class="btn primary" data-act="modal-wl-ok" data-code="' + code + '">保存</button>');
        break;
      }
      case 'modal-wl-ok': {
        const code = t.dataset.code;
        state.watch.groups.forEach(g => g.items.forEach(it => {
          if (it.code === code) {
            it.note = $('#wlNote').value.trim();
            it.tags = $('#wlTags').value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
          }
        }));
        saveWatch(); closeModal(); renderWatchlist();
        toast('备注已保存', 'ok');
        break;
      }
      case 'save-strategy': {
        syncStrategyFromDOM();
        const st = state.screen.strategy;
        if (!st.name) { toast('请先填写策略名称', 'warn'); return; }
        if (!st.id) st.id = 's' + Date.now().toString(36);
        const errs = st.groups.flatMap(g => g.conds).map(S.validateCond).filter(Boolean);
        if (errs.length) { toast('条件有误:' + errs[0], 'warn'); return; }
        const exist = state.strategies.find(x => x.id === st.id);
        if (exist) Object.assign(exist, JSON.parse(JSON.stringify(st)));
        else state.strategies.push(JSON.parse(JSON.stringify(st)));
        saveStrategies();
        toast('策略已保存:' + st.name, 'ok');
        renderScreener();
        break;
      }
      case 'load-strategy': {
        const x = state.strategies.find(s => s.id === t.dataset.id);
        if (x) {
          state.screen.strategy = JSON.parse(JSON.stringify(x));
          renderScreener();
          toast('已载入策略:' + x.name, 'info');
        }
        break;
      }
      case 'run-saved': {
        const x = state.strategies.find(s => s.id === t.dataset.id);
        if (x) {
          state.screen.strategy = JSON.parse(JSON.stringify(x));
          runScreenStrategy(x, false);
          renderScreener();
          toast('已运行策略:' + x.name + ',命中 ' + (x.lastCount || 0) + ' 只', 'info');
        }
        break;
      }
      case 'copy-strategy': {
        const x = state.strategies.find(s => s.id === t.dataset.id);
        if (x) {
          const cp = JSON.parse(JSON.stringify(x));
          cp.id = 's' + Date.now().toString(36);
          cp.name = x.name + '(副本)';
          cp.lastRunAt = null; cp.lastCount = null;
          state.strategies.push(cp);
          saveStrategies(); renderScreener();
          toast('已复制策略', 'ok');
        }
        break;
      }
      case 'del-strategy': {
        const x = state.strategies.find(s => s.id === t.dataset.id);
        if (x) confirmModal('删除策略', '确定删除策略「' + esc(x.name) + '」吗?删除后不可恢复。', () => {
          state.strategies = state.strategies.filter(s => s.id !== t.dataset.id);
          saveStrategies(); renderScreener();
          toast('策略已删除', 'info');
        }, '删除');
        break;
      }
      case 'add-cond': {
        syncStrategyFromDOM();
        const g = state.screen.strategy.groups.find(x => x.id === t.dataset.gid);
        if (g) { g.conds.push(S.newCond('price')); renderScreener(); }
        break;
      }
      case 'del-cond': {
        syncStrategyFromDOM();
        const cid = t.closest('.cond-row').dataset.cid;
        state.screen.strategy.groups.forEach(g => { g.conds = g.conds.filter(c => c.id !== cid); });
        renderScreener();
        break;
      }
      case 'add-sgroup': {
        syncStrategyFromDOM();
        state.screen.strategy.groups.push(S.newGroup());
        renderScreener();
        break;
      }
      case 'del-group': {
        syncStrategyFromDOM();
        state.screen.strategy.groups = state.screen.strategy.groups.filter(g => g.id !== t.dataset.gid);
        renderScreener();
        break;
      }
      case 'tpl': {
        state.screen.strategy = JSON.parse(JSON.stringify(SCREENER_TEMPLATES[t.dataset.tpl]));
        state.screen.strategy.id = 's' + Date.now().toString(36);
        renderScreener();
        toast('已载入模板:' + t.dataset.tpl, 'info');
        break;
      }
      case 'run-strategy': {
        syncStrategyFromDOM();
        const errs = state.screen.strategy.groups.flatMap(g => g.conds).map(S.validateCond).filter(Boolean);
        if (errs.length) { toast('条件有误:' + errs[0], 'warn'); return; }
        runScreenStrategy(state.screen.strategy, true);
        break;
      }
      case 'export-csv': {
        const res = state.screen.results || [];
        if (!res.length) { toast('暂无可导出的结果', 'warn'); return; }
        const head = ['代码', '名称', '最新价', '涨跌幅%', '成交额', '换手率%', '量比', 'PE', 'PB', 'ROE%', '净利同比%', '股息率%', '行业'];
        const lines = res.map(s => [s.code, s.name, s.quote.price, s.quote.chgPct, s.quote.amount, s.quote.turnover, s.quote.volRatio, s.quote.pe, s.quote.pb, (Array.isArray(s.fin && s.fin.annual) && s.fin.annual.length ? (s.fin.annual[s.fin.annual.length - 1] || {}).roe : null), s.fin && s.fin.npYoY, s.quote.dvYield, s.industry].join(','));
        download('quantpick_选股结果_' + Date.now() + '.csv', '\ufeff' + head.join(',') + '\n' + lines.join('\n'));
        toast('CSV 已导出', 'ok');
        break;
      }
      case 'market-filter': {
        state.market.filters.market = $('[data-mfilter="market"]').value;
        state.market.filters.industry = ($('#mkInd').value || '').trim();
        state.market.filters.status = $('[data-mfilter="status"]').value;
        state.market.filters.kw = $('#mkKw').value.trim();
        state.market.page = 1;
        renderMarket();
        break;
      }
      case 'market-reset': {
        state.market.filters = { market: '', industry: '', status: '', kw: '' };
        state.market.page = 1;
        renderMarket();
        break;
      }
      case 'page': {
        const kind = t.dataset.kind;
        if (kind === 'market') { state.market.page = +t.dataset.page; renderMarket(); }
        else if (kind === 'screen') { state.screen.page = +t.dataset.page; renderScreenResults(); }
        else if (kind === 'ranks') { state.ranksPage = +t.dataset.page; renderRanks(); }
        else if (kind === 'predict') { state.predict.page = +t.dataset.page; renderPredict(); }
        break;
      }
      case 'rank-tab': {
        state.ranksType = t.dataset.type;
        state.ranksPage = 1;
        location.hash = '#/ranks?type=' + t.dataset.type;
        break;
      }
      case 'ai-review': {
        buildAIReview();
        break;
      }
      case 'predict-tab': state.predict.dim = t.dataset.dim; state.predict.page = 1; route(); break;
      /* AI 智能分析页内的分页切换(#/predict 与 #/ai 两条路由均保留) */
      case 'ai-hub-tab': location.hash = t.dataset.tab === 'diag' ? '#/ai' : '#/predict'; break;
      /* 复盘样本量切换(Top10 / Top20 / Top50):仅改变统计样本范围,不影响预测模型 */
      case 'review-n': {
        const n = +t.dataset.n || 20;
        state.predict.reviewN = n;
        renderPredHistory();
        renderPredReview();
        prefetchHistoryKlines();
        break;
      }
      /* 窗口稳健性分析(参数敏感性):按需触发,避免每次回测都多跑 4 次 */
      case 'bt-sens': renderBtSensitivity(); break;
      case 'predict-horizon': state.predict.horizon = +t.dataset.h; state.predict.page = 1; route(); break;
      case 'predict-run': {
        if (!QP.predict) break;
        const snap = QP.predict.regenerateDailyPrediction();
        if (!snap) { toast('交易时段(9:30-15:00)预测已锁定,不可变更', 'warn'); break; }
        toast('已重新预测并锁定目标日:' + snap.label, 'ok');
        QP.predict.invalidateCache();
        route();
        break;
      }
      case 'ai-pick': pickAIDiagnosis(t.dataset.code); break;
      case 'pred-reset': {
        if (QP.predict) { QP.predict.saveSnapshots([]); QP.predict.invalidateCache(); }
        try { localStorage.removeItem('qp_pred_hist'); } catch (e) { }
        toast('预测快照已清除,正在重新生成今日预测…', 'info');
        route();
        break;
      }
      case 'pred-snap-del': {
        if (!QP.predict) break;
        const snaps = QP.predict.removeSnapshot(t.dataset.id);
        toast('已删除快照,剩余 ' + snaps.length + ' 条', 'info');
        renderPredReview();
        break;
      }
      case 'bt-run': runBacktest(); break;
      case 'chat-send': sendChat($('#chatInput').value); break;
      case 'chat-quick': sendChat(t.dataset.q); break;
      case 'color-mode': state.settings.colorMode = t.dataset.mode; applyColorMode(); renderSettings(); break;
      case 'live-toggle': state.settings.live = !state.settings.live; LS.set('qp_settings', state.settings); renderSettings(); break;
      case 'export-data': {
        const payload = { exportedAt: new Date().toISOString(), watch: state.watch, strategies: state.strategies, alerts: state.alerts, settings: state.settings };
        download('quantpick_backup.json', JSON.stringify(payload, null, 2));
        toast('数据已导出', 'ok');
        break;
      }
      case 'import-data': { $('#importFile').click(); break; }
      case 'clear-data': {
        confirmModal('清空本地数据', '将删除自选股、策略、提醒与报告记录(行情数据为本地生成,不受影响)。确定继续吗?', () => {
          LS.del(wKey('qp_watch')); LS.del(wKey('qp_alerts')); LS.del(wKey('qp_reports'));
          loadUserData(); refreshWatchBadge(); renderSettings();
          toast('本地数据已清空', 'info');
        }, '清空');
        break;
      }
      case 'modal-ok': { const cb = modalCb; closeModal(); if (cb) cb(); break; }
      case 'modal-cancel': closeModal(); break;
    }
  });
  function refreshWatchBadge() {
    const n = state.watch ? state.watch.groups.reduce((a, g) => a + g.items.length, 0) : 0;
    const b = $('#watchBadge');
    if (b) { b.textContent = n; b.style.display = n ? 'block' : 'none'; }
  }
  function download(name, content) {
    const blob = new Blob([content], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ============================ 选股器输入联动 ============================ */
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.matches('#strategyGroups [data-cf="field"]')) {
      const row = el.closest('.cond-row');
      const f = S.FIELD_MAP[el.value];
      const ops = S.opsOf(f).map(o => '<option value="' + o.v + '"' + (o.v === (f.type === 'num' ? '>' : '=') ? ' selected' : '') + '>' + o.label + '</option>').join('');
      row.querySelector('[data-cf="op"]').innerHTML = ops;
      const v1 = row.querySelector('[data-cf="v1"]');
      v1.placeholder = f.type === 'str' ? '关键词' : f.type === 'enum' ? '选项' : '数值';
      v1.value = f.type === 'enum' ? (f.values && f.values[0]) : '';
      const v2 = row.querySelector('[data-cf="v2"]');
      if (v2) v2.remove();
      row.querySelector('.cond-del').insertAdjacentHTML('beforebegin', '');
    }
    if (el.matches('#strategyGroups [data-cf="op"]')) {
      const row = el.closest('.cond-row');
      const v2 = row.querySelector('[data-cf="v2"]');
      if (el.value === 'between' && !v2) {
        const inp = document.createElement('input');
        inp.className = 'input num'; inp.dataset.cf = 'v2'; inp.placeholder = '上限';
        el.insertAdjacentElement('afterend', inp);
      } else if (el.value !== 'between' && v2) {
        v2.remove();
      }
    }
    if (el.id === 'strategyLoad' && el.value) {
      const x = state.strategies.find(s => s.id === el.value);
      if (x) {
        state.screen.strategy = JSON.parse(JSON.stringify(x));
        renderScreener();
        toast('已载入策略:' + x.name, 'info');
      }
    }
    if (el.matches('[data-act="predict-sector"]')) { state.predict.sector = el.value; state.predict.page = 1; route(); }
    if (el.matches('[data-act="predict-filter"]')) {
      state.predict.filters[el.dataset.f] = el.checked;
      state.predict.page = 1;
      route();
    }
    if (el.id === 'importFile' && el.files && el.files[0]) {
      const f = el.files[0];
      const rd = new FileReader();
      rd.onload = () => {
        try {
          const d = JSON.parse(rd.result);
          if (d.watch) { state.watch = d.watch; saveWatch(); }
          if (d.strategies) { state.strategies = d.strategies; saveStrategies(); }
          if (d.alerts) { state.alerts = d.alerts; saveAlerts(); }
          if (d.settings) { state.settings = Object.assign(state.settings, d.settings); applyColorMode(); }
          toast('数据导入成功', 'ok');
          renderSettings();
        } catch (err) { toast('导入失败:文件格式不正确', 'err'); }
      };
      rd.readAsText(f);
    }
  });

  /* ============================ 背景粒子 ============================ */
  function initBg() {
    const cv = $('#bg-canvas');
    if (!cv || !cv.getContext) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let W, H, parts = [];
    function resize() { W = cv.width = innerWidth; H = cv.height = innerHeight; }
    resize();
    addEventListener('resize', resize);
    for (let i = 0; i < 55; i++) {
      parts.push({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: Math.random() * 1.6 + 0.4, vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25, a: Math.random() * 0.4 + 0.12 });
    }
    let raf = null, running = true;
    function draw() {
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > W) p.vx *= -1;
        if (p.y < 0 || p.y > H) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(120,180,255,' + p.a + ')';
        ctx.fill();
      }
      // 连线
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const dx = parts[i].x - parts[j].x, dy = parts[i].y - parts[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 130 * 130) {
            ctx.beginPath();
            ctx.moveTo(parts[i].x, parts[i].y);
            ctx.lineTo(parts[j].x, parts[j].y);
            ctx.strokeStyle = 'rgba(90,160,255,' + (0.07 * (1 - d2 / (130 * 130))) + ')';
            ctx.lineWidth = 0.6;
            ctx.stroke();
          }
        }
      }
      if (running) raf = requestAnimationFrame(draw);
    }
    draw();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { running = false; cancelAnimationFrame(raf); }
      else { running = true; draw(); }
    });
  }

  /* ============================ 初始化 ============================ */
  async function init() {
    initBg();
    applyColorMode();
    initSearch();
    $('#hamburger').onclick = () => { $('#sidebar').classList.toggle('open'); $('#mobileMask').classList.toggle('show'); };
    $('#mobileMask').onclick = () => { $('#sidebar').classList.remove('open'); $('#mobileMask').classList.remove('show'); };
    $('#logoutBtn').onclick = () => { confirmModal('退出登录', '确定退出当前账号吗?本地数据将保留,下次登录可继续使用。', logout, '退出'); };
    $('#bellBtn').onclick = e => { e.stopPropagation(); const d = $('#bellDrop'); d.classList.toggle('show'); renderBell(); };
    document.addEventListener('click', e => { if (!e.target.closest('.bell-btn') && !e.target.closest('.bell-drop')) $('#bellDrop').classList.remove('show'); });
    $('#modalClose').onclick = closeModal;
    $('#modalMask').addEventListener('mousedown', e => { if (e.target === $('#modalMask')) closeModal(); });
    if (!window.echarts) {
      setTimeout(() => toast('图表库(ECharts CDN)加载失败,请检查网络后刷新页面', 'err'), 900);
    }
    // 预加载:接入真实数据服务(东方财富);本系统不展示模拟数据
    const preTxt = $('#preloader').querySelector('.pre-txt');
    try {
      preTxt.textContent = '正在连接数据服务(东方财富)…';
      const realOk = await QP.real.init();
      if (realOk) {
        state.realMode = true;
        preTxt.textContent = '真实行情加载完成';
        // 后台预热全池K线与财务,让首次"条件选股/回测"不再长时间等待
        setTimeout(() => {
          if (!state.user) return;
          QP.real.ensureKlineAll().catch(() => {});
          QP.real.ensureFinAll().catch(() => {});
        }, 6000);
      } else {
        state.realMode = false;
        state.noService = true;
        preTxt.textContent = '数据服务不可用(不展示模拟数据)';
        setTimeout(() => toast('未检测到数据服务:请在 quantpick 目录运行 node server.js(或双击 start.bat)后刷新页面。本系统不会展示任何模拟数据。', 'err'), 900);
      }
    } catch (err) {
      console.error(err);
      state.realMode = false;
      state.noService = true;
      preTxt.textContent = '数据初始化失败:' + err.message;
    }
    window.setTimeout(() => {
      const pl = $('#preloader');
      if (pl) {
        pl.classList.add('hide');
        setTimeout(() => pl.remove(), 600);
      }
    }, 500);
    // 登录(真实数据就绪后再进入,保证首屏即真实行情)
    initAuth();
    // 侧栏折叠(桌面)
    $('#sidebar .brand').style.cursor = 'pointer';
    $('#sidebar .brand').onclick = () => { if (innerWidth > 900) $('#sidebar').classList.toggle('collapsed'); };
    refreshWatchBadge();
    renderBell();
  }
  document.addEventListener('DOMContentLoaded', () => { init(); });
})();
