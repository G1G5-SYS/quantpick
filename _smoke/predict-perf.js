/* 性能测量:真实全市场(5899只)预测耗时 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { BASE } = require('./test-env');
const ROOT = path.join(__dirname, '..');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window;
w.fetch = (u, opts) => globalThis.fetch(new URL(u, BASE + '/').href, opts);
w.AbortController = globalThis.AbortController;
w.AbortSignal = globalThis.AbortSignal;
w.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
['js/data.js', 'js/real.js', 'js/predict.js'].forEach(f => w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8')));
(async () => {
  const t0 = Date.now();
  const ok = await w.QP.real.init();
  while (w.QP.real.store.marketAll.total < 3000) await new Promise(r => setTimeout(r, 1000));
  const t1 = Date.now();
  // 首次全量预测
  const t2 = Date.now();
  const pred = w.QP.predict.predictAll();
  const t3 = Date.now();
  // 二次(缓存 sector)
  w.QP.predict.predictAll();
  const t4 = Date.now();
  // 快照保存
  const t5 = Date.now();
  w.QP.predict.saveSnapshot(pred);
  const t6 = Date.now();
  // 每日锁定读取
  const t7 = Date.now();
  w.QP.predict.ensureDailyPrediction();
  const t8 = Date.now();
  console.log('真实模式初始化+全市场加载:', (t1 - t0) / 1000, 's | 样本:', w.QP.real.store.marketAll.total);
  console.log('首次 predictAll(全量特征+排序):', (t3 - t2), 'ms');
  console.log('二次 predictAll(sector缓存):', (t4 - t3), 'ms');
  console.log('saveSnapshot(Top100 序列化):', (t6 - t5), 'ms');
  console.log('ensureDailyPrediction(读取锁定):', (t8 - t7), 'ms');
  console.log('loadSnapshots(20个快照解析,带2s缓存):', (() => { const a = Date.now(); w.QP.predict.loadSnapshots(); w.QP.predict.loadSnapshots(); return Date.now() - a; })(), 'ms');
  process.exit(0);
})().catch(e => { console.error(e); process.exit(2); });
