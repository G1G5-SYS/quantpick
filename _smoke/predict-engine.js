/* AI 预测选股引擎测试:jsdom + data.js + predict.js(mock 数据层)
 * 验证:全市场预测覆盖、概率/收益/回撤/置信度数值范围、综合评分公式、
 *      多维度排名、过滤、快照保存/读取/复盘计算 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = '<!DOCTYPE html><html><body></body></html>';
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window, d = w.document;
w.localStorage = (function () {
  const m = {};
  return {
    getItem: k => (k in m ? m[k] : null),
    setItem: (k, v) => { m[k] = String(v); },
    removeItem: k => { delete m[k]; }
  };
})();

['js/data.js', 'js/predict.js'].forEach(f => {
  w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
});

const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

(async () => {
  const D = w.QP.data, P = w.QP.predict;

  check('引擎导出完整', ['predictAll', 'predictAllCached', 'sectorStatsCached', 'applyFilters', 'rankDim', 'saveSnapshot', 'actualReturn'].every(k => typeof P[k] === 'function'), '');

  // 1. 全市场预测(mock 池 125 只,真实模式下为 5000+)
  const pred = P.predictAll();
  check('预测覆盖全部有行情股票', pred.list.length > 100, '样本:' + pred.list.length);
  check('市场环境输出', !!pred.regime && ['强势', '震荡', '弱势', '普跌'].indexOf(pred.regime.regime) >= 0, JSON.stringify(pred.regime));
  check('综合评分公式权重', Math.abs(pred.weights.prob + pred.weights.ret + pred.weights.excess + pred.weights.sector - pred.weights.risk - 0.8) < 1e-9, JSON.stringify(pred.weights));

  // 2. 数值范围抽查
  const bad = pred.list.filter(p =>
    p.p5 < 3 || p.p5 > 96 || p.p10 < 3 || p.p10 > 97 || p.p20 < 3 || p.p20 > 98 ||
    p.confidence < 25 || p.confidence > 95 ||
    p.score < 5 || p.score > 98 ||
    p.expDD < 2 || p.expDD > 40 ||
    p.ret5 < -10 || p.ret5 > 12
  );
  check('所有预测值均在合理区间', bad.length === 0, '越界:' + bad.length);
  const p0 = pred.list[0];
  check('预测字段完整性', ['p5', 'p10', 'p20', 'ret5', 'ret10', 'ret20', 'excess5', 'excess10', 'expDD', 'confidence', 'score', 'pos', 'risks'].every(k => k in p0), JSON.stringify({ code: p0.code, p5: p0.p5, ret5: p0.ret5, score: p0.score }));
  check('概率随周期递增(P5<=P10<=P20)', pred.list.every(p => p.p5 <= p.p10 && p.p10 <= p.p20), '');
  check('解释因素非空', pred.list.every(p => p.pos.length > 0), '');

  // 3. 综合评分与动量分相关性(评分应与动量分正相关)
  const corr = spearman(pred.list.map(p => p.mScore), pred.list.map(p => p.score));
  check('综合评分与动量分正相关(Spearman>0.6)', corr > 0.6, 'rho=' + corr.toFixed(3));

  // 4. 多维排名
  Object.keys(P.DIMS).forEach(dim => {
    const ranked = P.rankDim(pred.list, dim);
    check('排名维度可运行:' + dim, ranked.length > 0 && ranked.length <= pred.list.length, ranked.length + ' 只');
  });
  const composite = P.rankDim(pred.list, 'composite');
  check('综合排名降序', composite.every((p, i) => i === 0 || composite[i - 1].score >= p.score), 'Top1:' + composite[0].name + ' ' + composite[0].score);

  // 5. 过滤
  const noSt = P.applyFilters(pred.list, { st: true });
  check('过滤剔除ST', noSt.every(p => p.status !== 'ST'), '');
  const liquid = P.applyFilters(pred.list, { liquid: true });
  check('过滤低流动性', liquid.every(p => p.amount == null || p.amount >= 3e7), '');

  // 6. 快照保存/读取/删除
  const snap = P.saveSnapshot(pred);
  check('快照已保存', P.loadSnapshots().length === 1, 'id:' + snap.id + ' label:' + snap.label);
  check('快照含Top100', snap.top.length === 100, '');
  check('快照保存完整预测字段', !!(snap.top[0].pos && snap.top[0].risks && snap.top[0].industry && snap.top[0].p10 && snap.top[0].ret10), JSON.stringify({ c: snap.top[0].code, pos: snap.top[0].pos.length }));
  const snaps2 = P.removeSnapshot(snap.id);
  check('快照删除', snaps2.length === 0, '');

  // 6b. 每日锁定预测:同一天多次调用返回同一快照(锁定不可修改)
  const d1 = P.ensureDailyPrediction();
  const d2 = P.ensureDailyPrediction();
  check('每日预测锁定(同id)', d1.snapshot.id === d2.snapshot.id && d1.top.length === 100, 'id:' + d1.snapshot.id);
  check('每日预测含市场统计', d1.market && d1.market.count > 0 && typeof d1.market.avgProb === 'number', '样本:' + d1.market.count);
  check('锁定快照含完整字段', d1.top.every(t => t.pos && t.risks && t.p5 != null && t.ret5 != null), '');
  const d3 = P.ensureDailyPrediction();
  check('二次调用不新增快照', P.loadSnapshots().length === 1 && d3.snapshot.id === d1.snapshot.id, '');

  // 6d. 交易时段锁定规则
  const fmt = P.todayLabel();
  check('生效交易日格式', /^\d{4}-\d{2}-\d{2}$/.test(P.effectiveTradeDate()), P.effectiveTradeDate());
  check('锁定判定为布尔', typeof P.isLocked() === 'boolean', '');
  // 用固定时间验证:下一工作日 10:00(盘中→锁定,生效日=当天);同一天 16:00(已收盘→不锁定,生效日=下一交易日)
  const wd = P.nextTradeDay(new Date('2026-08-18T00:00:00'));   // 2026-08-18 是周二
  const lockedNow = new Date(wd.getFullYear(), wd.getMonth(), wd.getDate(), 10, 0).toISOString();
  const closedNow = new Date(wd.getFullYear(), wd.getMonth(), wd.getDate(), 16, 0).toISOString();
  check('盘中(10:00)锁定', P.isLocked(lockedNow) === true, lockedNow);
  check('收盘后(16:00)不锁定', P.isLocked(closedNow) === false, closedNow);
  check('盘中生效日=当天', P.effectiveTradeDate(lockedNow) === fmtDayOf(wd), '');
  check('收盘后生效日=下一交易日', P.effectiveTradeDate(closedNow) !== fmtDayOf(wd), P.effectiveTradeDate(closedNow));
  const rLocked = P.regenerateDailyPrediction(lockedNow);
  check('盘中不可重新预测', rLocked === null, '');
  const rOpen = P.regenerateDailyPrediction(closedNow);
  check('收盘后可以重新预测', !!rOpen && rOpen.label === P.effectiveTradeDate(closedNow), 'label:' + (rOpen || {}).label);
  const rOpen2 = P.regenerateDailyPrediction(closedNow);
  check('收盘后可多次变更(新id)', !!rOpen2 && rOpen2.id !== rOpen.id, rOpen2.id + ' vs ' + rOpen.id);
  function fmtDayOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

  // 6e. 旧格式快照兼容性:生效日旧快照(缺 pos/risks)应自动重建
  const label2 = P.effectiveTradeDate();
  const oldSnap = { id: 'old', label: label2, version: 1, modelVersion: 'QP-PRED-1.0', regime: { regime: '震荡' },
    market: { count: 125, avgProb: 50, avgRet: 0, hiProb: 10 }, count: 125,
    top: Array.from({ length: 100 }, (_, i) => ({ code: '60' + String(i).padStart(4, '0'), name: '旧' + i, industry: 'x', price: 1, chgPct: 1, status: '正常', p5: 50, p10: 60, p20: 70, ret5: 1, ret10: 2, excess5: 0, expDD: 5, confidence: 60, score: 50 })) };
  P.saveSnapshots([oldSnap]);
  check('旧格式判定不兼容', P.snapshotCompatible(oldSnap) === false, '');
  const d4 = P.ensureDailyPrediction();
  check('旧格式生效日快照自动重建', d4.snapshot.id !== 'old' && Array.isArray(d4.top[0].pos) && Array.isArray(d4.top[0].risks), 'id:' + d4.snapshot.id);

  // 6c. 自动复盘统计(构造含快照日与未来K线的假K线并注册进数据层)
  const fakeSt = {
    code: '600000', name: '测试', quote: {},
    kline: (function () {
      const bars = [];
      const base = new Date('2025-01-01');
      let px = 10;
      for (let i = 0; i < 60; i++) {
        const dd = new Date(base); dd.setDate(base.getDate() + i);
        const o = px, c = px * (1 + (i % 3 === 0 ? -0.02 : 0.015));
        bars.push({ date: dd.toISOString().slice(0, 10), open: o, high: Math.max(o, c) * 1.01, low: Math.min(o, c) * 0.99, close: c, volume: 1000, amount: 100000 });
        px = c;
      }
      return bars;
    })()
  };
  D.buildAll().byCode['600000'] = fakeSt;
  const fakeSnap = { id: 'x1', label: '2025-01-02', top: [{ code: '600000', name: '测试', p5: 70, ret5: 3, p10: 75, ret10: 5 }] };
  const sum = P.reviewSnapshotSummary(fakeSnap, 5);
  check('复盘统计计算', sum.withAct.length === 1 && sum.avgAct != null && typeof sum.avgAct === 'number', JSON.stringify({ h: sum.h, avgAct: sum.avgAct }));

  // 7. 复盘计算(直接使用上述假K线)
  const r5 = P.actualReturn(fakeSt, '2025-01-02', 5);
  check('复盘实际收益计算', r5 && typeof r5.ret === 'number' && typeof r5.maxDD === 'number', JSON.stringify(r5));
  const rShort = P.actualReturn(fakeSt, '2025-01-30', 40);
  check('复盘数据不足返回null', rShort === null, '');

  // 8. 市场环境在 mock 下可运行(overview/indices 为空时使用默认值)
  check('市场环境空数据安全', typeof P.marketRegime().regime === 'string', '');

  console.log('\n================ AI 预测引擎测试 ================');
  results.forEach(r => console.log(r));
  console.log('--------------------------------------');
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\n总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length ? 1 : 0);

  function spearman(a, b) {
    const n = a.length;
    if (!n) return 0;
    const ra = rank(a), rb = rank(b);
    let d2 = 0;
    for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) * (ra[i] - rb[i]);
    return 1 - 6 * d2 / (n * (n * n - 1));
  }
  function rank(arr) {
    const idx = arr.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
    const r = new Array(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  }
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
