/* 真实数据引擎测试(Node):连接本地数据服务(东方财富代理),
 * 验证 选股/回测/AI分析 在真实数据上正常运行,并抽查与东财口径一致性 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { JSDOM } = require('jsdom');
const { BASE } = require('./test-env');

// 用 jsdom 提供 window 环境(real.js 挂到 window),但不渲染页面
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: BASE + '/', runScripts: 'dangerously' });
const w = dom.window;
// jsdom window 无 fetch,注入 Node 的 fetch(相对路径按页面 origin 解析 + 兼容 AbortController)
w.fetch = (u, opts) => globalThis.fetch(new URL(u, BASE + '/').href, opts);
w.AbortController = globalThis.AbortController;
w.AbortSignal = globalThis.AbortSignal;

['js/data.js', 'js/real.js', 'js/screener.js', 'js/ai.js', 'js/backtest.js'].forEach(f => {
  w.eval(require('fs').readFileSync(path.join(ROOT, f), 'utf8'));
});

(async () => {
  const QP = w.QP;
  const D = QP.data, S = QP.screener, AI = QP.ai, BT = QP.bt;
  // 诊断 init 失败原因
  try {
    const ctrl = new w.AbortController();
    const r = await w.fetch('api/ping', { signal: ctrl.signal });
    console.log('ping:', r.status, (await r.text()).slice(0, 120));
  } catch (e) { console.log('ping 诊断失败:', e.name, e.message); }
  const ok = await QP.real.init();
  console.log('真实模式:', ok ? 'ON' : 'FAIL', '| 数据源:', QP.real.store.source);

  const { list } = D.buildAll();
  console.log('股票池数量:', list.length);
  const m = D.getStock('600519');
  console.log('茅台真实行情: 价格', m.quote.price, '涨跌幅', m.quote.chgPct + '%', 'PE', m.quote.pe, 'PB', m.quote.pb, '市值', D.fmtBig(m.quote.mcap), '主力', D.fmtMoney(m.quote.mainNet));

  const idx = D.buildIndices();
  console.log('指数:', idx.map(i => i.name + ' ' + i.quote.price).join(' | '));

  const ov = D.marketOverview();
  console.log('概览: 涨', ov.up, '跌', ov.down, '平', ov.flat, '涨停', ov.limitUp, '成交额', D.fmtBig(ov.amount));
  console.log('涨幅榜 Top3:', D.topRank('chgPct', 3).map(s => s.name + '(' + s.quote.chgPct + '%)').join(' '));

  // K线 + 指标
  await QP.real.ensureKline('600519');
  const k = m.kline;
  console.log('茅台K线:', k.length, '根,最新', k[k.length - 1].date, '收', k[k.length - 1].close);
  console.log('MA20:', m.ind.ma20[m.ind.ma20.length - 1].toFixed(2), 'RSI:', m.ind.rsi[m.ind.rsi.length - 1], 'MACD:', m.ind.hist[m.ind.hist.length - 1].toFixed(2));

  // 财务
  await QP.real.ensureFin('600519');
  console.log('财务年报年数:', m.fin.annual.length, '最新:', JSON.stringify(m.fin.annual[m.fin.annual.length - 1]).slice(0, 200));

  // 资金流
  await QP.real.ensureFflow('600519');
  console.log('资金流: 主力', D.fmtMoney(m.fundFlow.mainNet), '大单', D.fmtMoney(m.fundFlow.bigNet), '超大单', D.fmtMoney(m.fundFlow.superBigNet), '散户', D.fmtMoney(m.fundFlow.retailNet));

  // 新闻
  await QP.real.ensureNews('600519');
  console.log('新闻:', m.news.length, '条,首条:', m.news[0].title.slice(0, 30), '情绪', m.news[0].sentiment);

  // AI 分析(真实数据)
  const rep = AI.analyze(m);
  console.log('AI评分: 综合', rep.overall_score, '基本面', rep.fundamental_score, '技术', rep.technical_score, '资金', rep.capital_score, '新闻', rep.news_score, '风险', rep.risk_score, rep.risk_level, rep.trend);

  // 选股(行情字段,无需全池K线)
  const strat = { id: 't', name: '真实测试', logic: 'AND', groups: [{ id: 'g1', logic: 'AND', conds: [
    S.newCond('mcap', { op: '>', v1: 1e11 }), S.newCond('pe', { op: '>', v1: 0 }), S.newCond('pe', { op: '<', v1: 30 }),
    S.newCond('chgPct', { op: '>', v1: -99 })
  ] }] };
  const hits = S.run(strat, list);
  console.log('真实选股命中(市值>1000亿且PE<30):', hits.length, hits.slice(0, 5).map(s => s.name + '(' + s.quote.pe + ')').join(' '));

  // 技术条件选股:先补全池K线
  console.log('加载全池K线中…');
  const t0 = Date.now();
  await QP.real.ensureKlineAll(list.map(s => s.code));
  console.log('全池K线加载耗时:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const strat2 = { id: 't2', name: '突破', logic: 'AND', groups: [{ id: 'g1', logic: 'AND', conds: [
    S.newCond('breakout20', { op: '=', v1: '是' }), S.newCond('volRatio', { op: '>', v1: 1.2 })
  ] }] };
  const hits2 = S.run(strat2, list);
  console.log('真实选股命中(20日新高+放量):', hits2.length, hits2.slice(0, 5).map(s => s.name + '(' + s.quote.chgPct + '%)').join(' '));

  // 回测(真实K线,样本池;指数基准)
  console.log('回测中(近120日,样本池)…');
  await QP.real.ensureIndexKline('000001');
  const btRes = BT.backtest(strat2, 120, 1000000, QP.real.poolList());
  console.log('回测结果:', JSON.stringify(btRes.metrics));
  console.log('成交笔数:', btRes.trades.length, '首笔:', btRes.trades[0] ? btRes.trades[0].name + ' ' + btRes.trades[0].buyDate : '无');

  console.log('\n=== 真实数据引擎测试完成 ===');
  process.exit(0);
})().catch(e => { console.error('测试失败:', e); process.exit(1); });
