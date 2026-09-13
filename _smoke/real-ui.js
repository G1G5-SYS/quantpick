/* 真实模式 UI 冒烟测试:jsdom + 本地数据服务(东方财富/腾讯),
 * 验证真实数据渲染到页面(仪表盘/行情/详情/选股/对话/设置) */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { BASE } = require('./test-env');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window, d = w.document;

// 环境注入
w.fetch = (u, opts) => globalThis.fetch(new URL(u, BASE + '/').href, opts);
w.AbortController = globalThis.AbortController;
w.AbortSignal = globalThis.AbortSignal;
class FakeChart { setOption() {} dispose() {} resize() {} }
w.echarts = {
  init: () => new FakeChart(),
  getInstanceByDom: () => null,   // app.js chart() 会调用,补齐 mock
  graphic: { LinearGradient: function (x, y, x2, y2, s) { return { type: 'linear', colorStops: s }; } }
};
w.URL.createObjectURL = () => 'blob:x';
w.confirm = () => false; w.prompt = () => null;
w.localStorage.setItem('qp_users', JSON.stringify({ demo: { pass: 'x', nick: '演示' } }));
w.localStorage.setItem('qp_session', JSON.stringify({ name: 'demo', nick: '演示' }));
w.localStorage.setItem('qp_settings', JSON.stringify({ colorMode: 'cn', live: false }));

['js/data.js', 'js/real.js', 'js/screener.js', 'js/ai.js', 'js/backtest.js', 'js/app.js'].forEach(f => {
  w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
});

const errors = [];
w.addEventListener('error', e => errors.push('ERR: ' + e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function setHash(h) { w.location.hash = h; w.dispatchEvent(new w.Event('hashchange')); }
function q(sel) { return d.querySelector(sel); }
function qa(sel) { return Array.from(d.querySelectorAll(sel)); }
function click(sel) { const el = q(sel); if (!el) return false; el.click(); return true; }
function setVal(sel, v) { const el = q(sel); if (!el) return false; el.value = v; return true; }
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

(async () => {
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await sleep(10000); // 等真实行情+全市场加载完成
  check('真实模式开启', w.QP.real.store.mode === 'real', '数据源:' + w.QP.real.store.source);
  check('全市场数量', w.QP.real.store.marketAll.total > 3000, '总数:' + w.QP.real.store.marketAll.total);
  check('自动登录', d.getElementById('app').classList.contains('on'));
  const m = w.QP.data.getStock('600519');
  check('茅台真实报价', m.quote.price != null && m.quote.price > 500, '价格:' + m.quote.price + ' 涨跌幅:' + (m.quote.chgPct != null ? m.quote.chgPct + '%' : '--'));

  // 仪表盘(首页已精简为「市场总体概况」:指数/KPI/板块/资金/新高新低/自选,榜单排行移至榜单中心)
  await sleep(700);
  check('仪表盘渲染', !!q('.kpis'), 'KPI:' + qa('.kpi').length + ' 数据行:' + qa('#content tr[data-act="goto-stock"]').length);
  // 仪表盘停留 3+ 秒:全量区块(指数卡/板块/创新高/主力图)自动更新且不报错
  await sleep(4200);
  check('仪表盘停留自动更新', !!q('#secList') && !!q('#idxPx-000001') && !!q('#nhBody tr') && !!q('#chart-fund'),
    '指数卡:' + (q('#idxPx-000001') || {}).textContent + ' 板块行:' + qa('#secList > div').length);
  // 首页数据行点击 → 详情页秒开
  const firstRow = q('#content tr[data-act="goto-stock"]');
  if (firstRow) {
    firstRow.click();
    await sleep(800);
    check('榜单点击打开详情', !!q('.hero-price') && w.location.hash.indexOf('#/stock/') === 0,
      'hash:' + w.location.hash + ' 价格:' + (q('.hero-price') || {}).textContent);
    setHash('#/dashboard'); await sleep(700);
  } else {
    check('榜单点击打开详情', false, '无数据行(非交易时段)');
  }

  // 榜单中心(完整榜单)
  setHash('#/ranks'); await sleep(1200);
  const rkRows = qa('#rkBody tr').length;
  const rkCount = (q('#rkCount') || {}).textContent;
  check('榜单中心完整榜单', rkRows > 0 && qa('#content .tabs button').length === 6, '行数:' + rkRows + ' ' + rkCount);
  click('[data-act="rank-tab"][data-type="down"]'); await sleep(1000);
  check('榜单Tab切换', w.location.hash.indexOf('type=down') >= 0 && qa('#rkBody tr').length > 0, 'hash:' + w.location.hash);
  const rkRow = q('#rkBody tr[data-act="goto-stock"]');
  if (rkRow) {
    rkRow.click(); await sleep(800);
    check('榜单行打开详情', !!q('.hero-price'), 'hash:' + w.location.hash);
    setHash('#/ranks?type=up'); await sleep(900);
  }
  // 自动刷新验证:真实模式轮询周期为 10s(REAL_TICK_MS),故等待需 > 一个周期才能稳定观测到变化
  const lu1 = (q('#lastUpd') || {}).textContent;
  await sleep(11500);
  const lu2 = (q('#lastUpd') || {}).textContent;
  check('页面自动刷新(无需切换)', !!lu1 && lu2 !== lu1, '更新:' + lu1 + ' -> ' + lu2);
  setHash('#/dashboard'); await sleep(600);

  // AI 评估榜
  setHash('#/ranks?type=ai'); await sleep(2500);
  const aiRows = qa('#rkBody tr[data-act="goto-stock"]');
  const aiFirst = q('#rkBody tr[data-act="goto-stock"] td[data-c="score"] b');
  check('AI评估榜渲染', aiRows.length > 0 && !!aiFirst, '行数:' + aiRows.length + ' 综合分:' + (aiFirst || {}).textContent);
  const aiScores = qa('#rkBody td[data-c="score"] b').map(b => +b.textContent);
  const aiSorted = aiScores.slice().sort((a, b) => b - a);
  check('AI榜按评分降序', aiScores.every((v, i) => v === aiSorted[i]), '前5:' + aiScores.slice(0, 5).join(','));
  if (aiRows[0]) {
    aiRows[0].click(); await sleep(800);
    check('AI榜行打开详情', !!q('.hero-price'), 'hash:' + w.location.hash);
  }
  // AI 评分复盘(先回到 AI 榜页)
  setHash('#/ranks?type=ai'); await sleep(800);
  click('[data-act="ai-review"]'); await sleep(60000);
  const revText = d.body.textContent;
  check('AI评分复盘面板', revText.includes('评分复盘') && revText.includes('相关系数') && revText.includes('复盘结论'),
    '相关系数r5:' + (revText.match(/近5日涨幅 相关系数[^\d]*([\d.-]+)/) || [])[1]);
  check('复盘统计卡', qa('#aiReview .bt-cell').length >= 6, '卡片:' + qa('#aiReview .bt-cell').length);
  check('复盘图表', !!q('#chart-review-bucket') && !!q('#chart-review-scatter'));
  // K线本地缓存验证(移至 601288 加载之后)
  setHash('#/ranks?type=up'); await sleep(700);

  // 行情中心
  setHash('#/market'); await sleep(800);
  check('行情中心(真实)', qa('#mkBody tr').length > 0, '行数:' + qa('#mkBody tr').length + ' 首行价格:' + (q('#mkBody td[data-c="price"]') || {}).textContent);

  // 股票详情(触发 K线/财务/资金/新闻 真实加载)
  setHash('#/stock/600519'); await sleep(6000);
  check('详情-行情', !!q('#chart-kline') && !!q('.hero-price'), '价格:' + (q('.hero-price') || {}).textContent);
  check('详情-52周数据', (q('.quote-cell .qc-v') || {}).textContent !== undefined);
  setHash('#/stock/600519/fin'); await sleep(2500);
  check('详情-财务(真实F10)', qa('.fin-table tbody tr').length > 5, '年度行:' + qa('.fin-table tbody tr').length + ' 最新:' + (q('.fin-table tbody tr td') || {}).textContent);
  setHash('#/stock/600519/fund'); await sleep(2000);
  check('详情-资金(真实)', !!q('#chart-ff'), '主力:' + (qa('#stockPane .qc-v')[0] || {}).textContent);
  setHash('#/stock/600519/news'); await sleep(2500);
  check('详情-新闻(真实)', qa('.news-item').length >= 1, '条数:' + qa('.news-item').length);
  setHash('#/stock/600519/ai'); await sleep(1500);
  check('详情-AI(真实数据)', !!q('.score-ring'), '综合分:' + (q('.sr-val') || {}).textContent);

  // 池外股票详情(601288 农业银行不在精选池,验证全市场任意股票可加载)
  setHash('#/stock/601288'); await sleep(10000);
  const st601 = w.QP.real.store.marketAll.byCode.get('601288') || w.QP.real.store.ranksMap.get('601288');
  check('池外股票K线加载', !!(st601 && st601.kline && st601.kline.length), 'bar数:' + (st601 && st601.kline ? st601.kline.length : 0));
  check('池外股票财务加载', !!(st601 && st601.fin && st601.fin.annual && st601.fin.annual.length), '年报:' + (st601 && st601.fin ? st601.fin.annual.length : 0));
  check('池外股票资金加载', !!(st601 && st601.fundFlow && st601.fundFlow.days && st601.fundFlow.days.length));
  check('池外股票新闻加载', !!(st601 && st601.news && st601.news.length), '条数:' + (st601 && st601.news ? st601.news.length : 0));
  const kl601 = st601 && st601.kline;
  if (kl601 && kl601.length) {
    const last = kl601[kl601.length - 1];
    const td = new Date();
    const ts = td.getFullYear() + '-' + String(td.getMonth() + 1).padStart(2, '0') + '-' + String(td.getDate()).padStart(2, '0');
    // 未开盘(盘前/周末/节假日)时今日K线bar尚未生成,行情可能返回昨收价:
    // 允许回退到最近交易日(bar 日期与今日相差 ≤3 天即视为正常)
    const closeMatch = st601.quote.price == null || Math.abs(last.close - st601.quote.price) < 0.05;
    const dateOk = last.date === ts || Math.abs(new Date(last.date) - new Date(ts)) <= 3 * 864e5;
    check('K线当日bar实时更新', dateOk && closeMatch, 'bar:' + last.date + ' 收:' + last.close + ' 现价:' + st601.quote.price);
  }
  setHash('#/stock/601288/fin'); await sleep(2000);
  check('池外股票财务页渲染', qa('.fin-table tbody tr').length > 0, '行数:' + qa('.fin-table tbody tr').length);

  // K线本地缓存验证(机制生效:缓存中有多只股票且含完整K线;具体股票受LRU上限影响)
  let klc = null;
  try { klc = JSON.parse(w.localStorage.getItem('qp_kline_cache_v1') || 'null'); } catch (e) { }
  const klcKeys = klc && klc.m ? Object.keys(klc.m) : [];
  const klcFull = klc && klc.m ? Object.values(klc.m).filter(a => a && a.length > 100).length : 0;
  check('K线本地缓存已写入', klcKeys.length >= 5 && klcFull >= 5,
    '缓存股票数:' + klcKeys.length + ' 完整K线数:' + klcFull);

  // 选股(行情字段,避免全池K线等待)
  setHash('#/screener'); await sleep(800);
  click('[data-act="tpl"][data-tpl="低估值高股息"]'); await sleep(600);
  setVal('#strategyName', '真实策略测试');
  click('[data-act="save-strategy"]'); await sleep(600);
  click('[data-act="run-strategy"]'); await sleep(20000); // 首次需加载分红数据计算股息率
  check('真实选股结果', qa('#resBody tbody tr').length > 0, '命中:' + (q('#resTools .chip') || {}).textContent);

  // AI 对话(单只,快速)
  setHash('#/chat'); await sleep(800);
  setVal('#chatInput', '它现在估值高不高?');
  click('[data-act="chat-send"]'); await sleep(6000);
  const msgs = qa('.chat-msg');
  check('AI对话(真实数据)', msgs.length >= 2 && (msgs[msgs.length - 1].textContent.includes('市盈率') || msgs[msgs.length - 1].textContent.includes('估值')), '消息:' + msgs.length);

  // 设置页数据源状态
  setHash('#/settings'); await sleep(600);
  check('设置页-数据源面板', d.body.textContent.includes('东方财富'), '');

  console.log('\n================ 真实模式 UI 结果 ================');
  results.forEach(r => console.log(r));
  console.log('--------------------------------------');
  if (errors.length) { console.log('JS 错误:\n' + errors.join('\n')); }
  else console.log('无 JS 运行时错误');
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\n总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
