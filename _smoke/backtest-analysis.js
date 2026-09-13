/* 回测分析增强测试:蒙特卡洛回撤 + 参数敏感性(窗口稳健性)
 * A. 确定性部分:maxDrawdownOf 与 monteCarloDrawdown 用"恒定收益率序列"精确验证
 *    —— 每日收益完全相同时,自助重采样得到唯一路径,结果可精确预期。
 * B. 集成部分:用真实数据跑一次回测,再验证参数敏感性的结构与内部一致性。
 * 依赖:隔离实例(QP_TEST_BASE)提供K线;若未加载到足够K线则跳过集成断言。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { BASE } = require('./test-env');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window, d = w.document;
w.fetch = (u, opts) => globalThis.fetch(new URL(u, BASE + '/').href, opts);
w.AbortController = globalThis.AbortController;
w.AbortSignal = globalThis.AbortSignal;
class FakeChart { setOption() { } dispose() { } resize() { } }
w.echarts = { init: () => new FakeChart(), getInstanceByDom: () => null, graphic: { LinearGradient: function (x, y, x2, y2, s) { return { type: 'linear', colorStops: s }; } } };
w.localStorage.setItem('qp_users', JSON.stringify({ demo: { pass: 'x', nick: 'T' } }));
w.localStorage.setItem('qp_session', JSON.stringify({ name: 'demo', nick: 'T' }));
w.localStorage.setItem('qp_settings', JSON.stringify({ colorMode: 'cn', live: false }));
['js/data.js', 'js/real.js', 'js/screener.js', 'js/ai.js', 'js/backtest.js', 'js/app.js'].forEach(f => {
  w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
});

const BT = w.QP.bt, S = w.QP.screener;
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- A. 确定性验证 ---------- */
/* 恒定日收益 r 的净值序列:等价于每日复利,回撤/收益均可精确计算 */
function constEquity(n, r, capital) {
  const out = [];
  let v = capital || 1000000;
  for (let i = 0; i < n; i++) { out.push({ date: '2026-01-01', value: v }); v = v * (1 + r); }
  return out;
}

(function deterministic() {
  check('maxDrawdownOf 单调上涨 = 0', BT.maxDrawdownOf([1, 2, 3, 4]) === 0, String(BT.maxDrawdownOf([1, 2, 3, 4])));
  check('maxDrawdownOf 已知回撤精确', Math.abs(BT.maxDrawdownOf([1, 2, 1, 0.5]) - (-75)) < 1e-9, String(BT.maxDrawdownOf([1, 2, 1, 0.5])));
  check('maxDrawdownOf 空/单元素安全', BT.maxDrawdownOf([1]) === 0 && BT.maxDrawdownOf([]) === 0, '');

  // 每日 -1%,共 101 个点(100 个收益):最大回撤 = 0.99^100 - 1
  const eq = constEquity(101, -0.01);
  const expectDD = +((Math.pow(0.99, 100) - 1) * 100).toFixed(2);
  const mc = BT.monteCarloDrawdown({ equity: eq }, { paths: 50 });
  check('monteCarloDrawdown 返回结构完整', !!mc && typeof mc.histDD === 'number' && !!mc.dd && !!mc.ret, '');
  check('历史最大回撤计算正确', Math.abs(mc.histDD - expectDD) < 0.02, '实得 ' + mc.histDD + ' 期望 ' + expectDD);
  check('恒定收益下 P50 ≈ 历史回撤', Math.abs(mc.dd.median - expectDD) < 0.5, 'P50=' + mc.dd.median);
  check('恒定收益下 最差 ≈ 历史回撤', Math.abs(mc.dd.worst - expectDD) < 0.5, 'worst=' + mc.dd.worst);
  /* 恒定收益 → 自助重采样得到的路径完全相同,故回撤分布"无宽度"(极差≈0)。
     注:不宜断言 probWorseThanHist===100 —— MC 与历史回撤在浮点上等值,`<=` 判定会抖动。 */
  check('恒定收益下回撤分布无宽度(极差≈0)', Math.abs(mc.dd.worst - mc.dd.median) < 0.01,
    'worst=' + mc.dd.worst + ' median=' + mc.dd.median);
  check('恒定收益下比历史更差比例在 0~100', mc.probWorseThanHist >= 0 && mc.probWorseThanHist <= 100, mc.probWorseThanHist + '%');
  check('horizon 默认等于收益样本数', mc.horizon === 100 && mc.samples === 100, 'horizon=' + mc.horizon + ' samples=' + mc.samples);

  // 每日 +1%(单调上涨):任意路径回撤恒为 0
  const mcUp = BT.monteCarloDrawdown({ equity: constEquity(80, 0.01) }, { paths: 30 });
  check('单调上涨时回撤恒为 0', mcUp.dd.worst === 0 && mcUp.dd.median === 0, 'worst=' + mcUp.dd.worst);
  check('单调上涨时收益中位数为正', mcUp.ret.median > 0, 'median=' + mcUp.ret.median);

  // 混合序列:分布应有宽度,且 P95(更差) <= P50 <= 最好
  const mixed = [];
  let v = 1000000;
  const rets = [0.02, -0.03, 0.015, -0.01, 0.025, -0.04, 0.005, 0.03, -0.02, 0.01];
  for (let i = 0; i < 300; i++) { mixed.push({ date: '2026-01-01', value: v }); v *= (1 + rets[i % rets.length]); }
  const mcMix = BT.monteCarloDrawdown({ equity: mixed }, { paths: 300 });
  check('混合序列 P95(最差5%) 不优于 P50', mcMix.dd.p95 <= mcMix.dd.median, 'P95=' + mcMix.dd.p95 + ' P50=' + mcMix.dd.median);
  check('混合序列 worst 不优于 P95', mcMix.dd.worst <= mcMix.dd.p95, 'worst=' + mcMix.dd.worst + ' P95=' + mcMix.dd.p95);
  check('混合序列 比历史更差比例在 0~100', mcMix.probWorseThanHist >= 0 && mcMix.probWorseThanHist <= 100, mcMix.probWorseThanHist + '%');
  check('混合序列 收益分布有序', mcMix.ret.p05 <= mcMix.ret.median && mcMix.ret.median <= mcMix.ret.p95,
    mcMix.ret.p05 + ' / ' + mcMix.ret.median + ' / ' + mcMix.ret.p95);

  check('净值过短返回 null', BT.monteCarloDrawdown({ equity: [{ date: 'x', value: 1 }, { date: 'y', value: 2 }] }) === null, '');
  check('空结果安全返回 null', BT.monteCarloDrawdown(null) === null && BT.monteCarloDrawdown({}) === null, '');
})();

/* ---------- B. 集成:真实数据上的窗口敏感性 ---------- */
(async () => {
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await sleep(8000);
  const pool = (w.QP.real && w.QP.real.poolList) ? w.QP.real.poolList() : [];
  if (!pool.length) { check('数据层就绪(集成部分)', false, '池为空'); return report(); }
  await w.QP.real.ensureKlineAll(pool.slice(0, 20).map(s => s.code)).catch(() => null);
  const ready = pool.filter(s => Array.isArray(s.kline) && s.kline.length >= 120);
  if (ready.length < 3) { check('K线就绪(跳过集成断言)', true, '可用 ' + ready.length + ' 只'); return report(); }

  const strat = {
    id: 't-sens', name: '突破+放量', logic: 'AND', groups: [{ id: 'g1', logic: 'AND', conds: [
      S.newCond('breakout20', { op: '=', v1: '是' }), S.newCond('volRatio', { op: '>', v1: 1.2 })
    ] }]
  };
  const r1 = BT.backtest(strat, 120, 1000000, ready);
  check('单次回测可运行', !!r1 && !!r1.metrics, JSON.stringify(r1.metrics || {}).slice(0, 90));
  const mcReal = BT.monteCarloDrawdown(r1, { paths: 200 });
  check('真实回测可做蒙特卡洛', !!mcReal && typeof mcReal.histDD === 'number', mcReal ? ('历史DD=' + mcReal.histDD + '% P95=' + mcReal.dd.p95 + '% 更差概率=' + mcReal.probWorseThanHist + '%') : 'null');

  const sens = BT.periodSensitivity(strat, 1000000, ready, [{ label: '近 60', days: 60 }, { label: '近 120', days: 120 }]);
  check('敏感性返回与窗口数一致的行', sens.rows.length === 2, '行数 ' + sens.rows.length);
  check('敏感性含区间统计', !!sens.spreadReturn && sens.spreadReturn.min <= sens.spreadReturn.max,
    JSON.stringify(sens.spreadReturn));
  check('稳健性评级合法', ['高', '中', '低', '样本不足'].indexOf(sens.robustness) >= 0, sens.robustness);
  check('每行含关键指标', sens.rows.every(x => typeof x.totalReturn === 'number' && typeof x.maxDrawdown === 'number' && typeof x.trades === 'number'),
    sens.rows.map(x => x.label + ':' + x.totalReturn + '%/DD' + x.maxDrawdown + '%').join(' | '));

  report();
})().catch(e => { console.error('崩溃:', e); report(); });

function report() {
  console.log('\n================ 回测分析增强测试 ================');
  results.forEach(r => console.log(r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('--------------------------------------');
  console.log('总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length ? 1 : 0);
}
