/* 累计长期胜率(reviewHistory)测试
 * 用「可控行情」精确验证汇总计算:命中率、样本数、滚动加权、跳过逻辑、趋势排序。
 * 关键口径:
 *   命中 = 方向一致(预测概率≥50% 且 实际上涨) 或 (预测概率<50% 且 实际未涨)
 *   实际收益 = 快照日起未来 h 个交易日收盘价收益
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window;
w.localStorage = (function () {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
})();
['js/data.js', 'js/predict.js'].forEach(f => w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8')));
const D = w.QP.data, P = w.QP.predict;

const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

/* ---- 构造可控行情:12 个连续交易日 ---- */
function isoAddDays(start, n) { const d = new Date(start + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function mkKline(start, closes) {
  return closes.map((c, i) => ({ date: isoAddDays(start, i), open: c, close: c, high: c * 1.02, low: c * 0.98, volume: 1000, amount: 1e6 }));
}
const START = '2026-08-03';
const KL = {
  '600001': mkKline(START, [10, 10.2, 10.4, 10.6, 11.0, 11.4, 11.8, 12.0, 12.2, 12.4, 12.6, 12.8]),   // 持续上涨
  '600002': mkKline(START, [10, 9.9, 9.8, 9.6, 9.4, 9.2, 9.0, 8.9, 8.8, 8.7, 8.6, 8.5]),              // 持续下跌
  '600003': mkKline(START, [10, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 11.0, 11.1])     // 温和上涨
};
/* 覆盖 getStock,使复盘读到可控K线;未知代码返回 null(模拟K线未加载) */
D.getStock = function (code) { return KL[code] ? { code: code, name: 'X' + code, kline: KL[code] } : null; };

function snap(id, label, top) { return { id: id, label: label, modelVersion: 'QP-PRED-1.0', at: label + 'T08:00:00.000Z', top: top }; }
const t = (code, p5) => ({ code: code, name: 'X' + code, p5: p5, p10: p5, p20: p5, ret5: 5, ret10: 5, ret20: 5 });

(async () => {
  /* 快照1(08-03): 600001 涨→命中; 600002 跌(预测涨)→未中; 600003 涨(预测概率40%)→方向不一致未中
     预期: 命中 1/3 = 33%, 平均预测 5.00, 平均实际 (14.00 - 8.00 + 5.00)/3 = 3.67 */
  P.saveSnapshots([
    snap('A1', '2026-08-03', [t('600001', 60), t('600002', 60), t('600003', 40)]),
    /* 快照2(08-04): 600001 涨→命中; 600002 跌且预测不涨→命中; 600003 涨→命中
       预期: 命中 3/3 = 100% */
    snap('A2', '2026-08-04', [t('600001', 60), t('600002', 40), t('600003', 60)])
  ], { noPush: true });

  const agg = P.reviewHistory({ horizon: 5, topN: 10 });
  check('统计到 2 个快照', agg.cumulative.snapshots === 2, '实际 ' + agg.cumulative.snapshots);
  check('累计样本 = 6 只', agg.cumulative.samples === 6, '实际 ' + agg.cumulative.samples);
  check('累计命中率 = 67%(4/6)', agg.cumulative.hitRate === 67, '实际 ' + agg.cumulative.hitRate);
  check('快照1 命中率 = 33%(1/3)', agg.series[0] && agg.series[0].hitRate === 33, '实际 ' + (agg.series[0] || {}).hitRate);
  check('快照2 命中率 = 100%(3/3)', agg.series[1] && agg.series[1].hitRate === 100, '实际 ' + (agg.series[1] || {}).hitRate);
  check('趋势按时间正序(08-03 → 08-04)', agg.series[0].label === '2026-08-03' && agg.series[1].label === '2026-08-04', agg.series.map(x => x.label).join(' → '));
  check('滚动5期按样本加权 = 67%', agg.roll5 === 67, '实际 ' + agg.roll5);
  /* 平均实际收益推导(逐快照先取均值,再对快照取均值):
     快照1(08-03): 600001 +14.00, 600002 -8.00, 600003 +5.00 → 均值 3.67
     快照2(08-04): 600001 (11.8/10.2-1)=+15.69, 600002 (9.0/9.9-1)=-9.09, 600003 (10.6/10.1-1)=+4.95 → 均值 3.85
     合计: avgPred = (5+5)/2 = 5.00, avgAct = (3.67+3.85)/2 = 3.76, 偏差 = 5.00-3.76 = 1.24 */
  check('平均预测 = 5.00', agg.cumulative.avgPred === 5, '实际 ' + agg.cumulative.avgPred);
  check('平均实际 = 3.76', agg.cumulative.avgAct === 3.76, '实际 ' + agg.cumulative.avgAct);
  check('预测偏差 = 1.24(偏乐观)', agg.cumulative.bias === 1.24, '实际 ' + agg.cumulative.bias);
  check('首尾标签可读', agg.first === '2026-08-03' && agg.last === '2026-08-04', agg.first + '~' + agg.last);

  /* 未加载K线的股票(未知代码)应被跳过,不计入样本 */
  P.saveSnapshots([
    snap('B1', '2026-08-05', [t('999999', 60), t('888888', 60), t('777777', 60)])
  ].concat(P.loadSnapshots()), { noPush: true });
  const agg2 = P.reviewHistory({ horizon: 5, topN: 10 });
  check('K线未加载的快照不计入样本', agg2.cumulative.samples === 6, '实际 ' + agg2.cumulative.samples);
  check('未成熟/K线缺失的快照计入 skipped', agg2.cumulative.skipped >= 1, 'skipped=' + agg2.cumulative.skipped);

  /* 生效日快照应被跳过(未来尚未成熟) */
  const effLabel = P.effectiveTradeDate();
  P.saveSnapshots([snap('C1', effLabel, [t('600001', 60), t('600002', 60), t('600003', 60)])].concat(P.loadSnapshots()), { noPush: true });
  const agg3 = P.reviewHistory({ horizon: 5, topN: 10 });
  check('生效日快照被跳过(不计入)', agg3.cumulative.snapshots === 2 && agg3.cumulative.samples === 6,
    'snapshots=' + agg3.cumulative.snapshots + ' samples=' + agg3.cumulative.samples);

  /* 不同周期独立计算(h=10 时 600001 从 idx0 到 idx10: 10 → 12.6 = +26%) */
  const agg10 = P.reviewHistory({ horizon: 10, topN: 10 });
  check('周期 10 日可独立统计', agg10.horizon === 10 && agg10.cumulative.samples > 0, 'samples=' + agg10.cumulative.samples + ' hitRate=' + agg10.cumulative.hitRate);

  /* 样本不足(<3)时不给命中率 */
  P.saveSnapshots([snap('D1', '2026-08-06', [t('600001', 60)])], { noPush: true });
  const single = P.reviewHistory({ horizon: 5, topN: 1, limit: 1 });
  check('单只样本不输出命中率(null)', single.series.length === 1 && single.series[0].hitRate === null, JSON.stringify(single.series[0] || {}));

  /* historyCodes:去重 + 仅取非生效日快照 */
  P.saveSnapshots([
    snap('E1', '2026-08-07', [t('600001', 60), t('600002', 60)]),
    snap('E2', '2026-08-08', [t('600002', 60), t('600003', 60)]),
    snap('E3', P.effectiveTradeDate(), [t('600009', 60)])
  ], { noPush: true });
  const codes = P.historyCodes({ topN: 10, limit: 10 });
  const uniq = new Set(codes);
  check('historyCodes 去重', uniq.size === codes.length, codes.join(','));
  check('historyCodes 排除生效日快照', codes.indexOf('600009') < 0, codes.join(','));
  check('historyCodes 含历史快照股票', codes.indexOf('600001') >= 0 && codes.indexOf('600003') >= 0, codes.join(','));

  /* ---------- 复盘样本量(Top10 / Top20 / Top50)----------
     构造 25 只:前 10 只上涨(命中)、后 15 只下跌(未中),全部预测概率 60%。
     预期:h=5 时 Top10 → 10 样本全命中(100%);Top20 → 20 样本(100%→50%);Top25 → 25 样本(40%)。 */
  const big = [];
  const UP12 = [10, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 11.0, 11.1];   // h=5 时 +5%
  const DOWN12 = [10, 9.9, 9.8, 9.7, 9.6, 9.5, 9.4, 9.3, 9.2, 9.1, 9.0, 8.9];          // h=5 时 -5%
  for (let i = 1; i <= 25; i++) {
    const code = '9' + String(i).padStart(5, '0');
    const up = i <= 10;
    KL[code] = mkKline('2026-08-10', up ? UP12 : DOWN12);   // 需 >= horizon+2 条,故用 12 条
    big.push(t(code, 60));
  }
  P.saveSnapshots([snap('N1', '2026-08-10', big)], { noPush: true });
  const g10 = P.reviewHistory({ horizon: 5, topN: 10 });
  const g20 = P.reviewHistory({ horizon: 5, topN: 20 });
  const g50 = P.reviewHistory({ horizon: 5, topN: 50 });
  check('Top10 样本 = 10', g10.cumulative.samples === 10, '实际 ' + g10.cumulative.samples);
  check('Top20 样本 = 20', g20.cumulative.samples === 20, '实际 ' + g20.cumulative.samples);
  check('Top50 样本 = 25(快照仅存 25 只,按实际截断)', g50.cumulative.samples === 25, '实际 ' + g50.cumulative.samples);
  check('Top10 命中率 = 100%(前10只全涨)', g10.cumulative.hitRate === 100, '实际 ' + g10.cumulative.hitRate);
  check('Top20 命中率 = 50%(含10只下跌)', g20.cumulative.hitRate === 50, '实际 ' + g20.cumulative.hitRate);
  check('Top50 命中率 = 40%(10/25)', g50.cumulative.hitRate === 40, '实际 ' + g50.cumulative.hitRate);
  check('样本量改变会改变结论(证明扩容生效)', g10.cumulative.hitRate !== g50.cumulative.hitRate,
    'Top10=' + g10.cumulative.hitRate + '% vs Top50=' + g50.cumulative.hitRate + '%');
  check('historyCodes 随样本量扩容', P.historyCodes({ topN: 25, limit: 5 }).length === 25,
    '实际 ' + P.historyCodes({ topN: 25, limit: 5 }).length);

  console.log('\n================ 累计长期胜率测试 ================');
  results.forEach(r => console.log(r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('--------------------------------------');
  console.log('总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });
