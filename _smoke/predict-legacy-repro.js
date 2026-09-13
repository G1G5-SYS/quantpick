/* 复现:localStorage 存在"旧格式今日快照"(上一版仅存部分字段)时,预测页是否渲染崩溃 */
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
class FakeChart { setOption() {} dispose() {} resize() {} }
w.echarts = { init: () => new FakeChart(), getInstanceByDom: () => null, graphic: { LinearGradient: function () { return {}; } } };
w.URL.createObjectURL = () => 'blob:x';
w.confirm = () => false; w.prompt = () => null;
w.localStorage.setItem('qp_users', JSON.stringify({ demo: { pass: 'x', nick: '演示' } }));
w.localStorage.setItem('qp_session', JSON.stringify({ name: 'demo', nick: '演示' }));
w.localStorage.setItem('qp_settings', JSON.stringify({ colorMode: 'cn', live: false }));

// 预置:今日旧格式快照(旧版 saveSnapshot 只存这些字段,没有 pos/risks/tech/ret20/excess10)
const d0 = new Date();
const label = d0.getFullYear() + '-' + String(d0.getMonth() + 1).padStart(2, '0') + '-' + String(d0.getDate()).padStart(2, '0');
const oldSnap = {
  id: 'oldfmt', label: label, at: new Date().toISOString(), modelVersion: 'QP-PRED-1.0', dataAsOf: '旧格式',
  regime: { regime: '震荡' }, weights: { prob: .35, ret: .3, excess: .15, sector: .1, risk: .1 },
  market: { count: 5899, avgProb: 55, avgRet: 0.5, hiProb: 500, avgScore: 50 },
  count: 5899,
  top: Array.from({ length: 100 }, (_, i) => ({   // 旧格式:缺 pos/risks/tech/ret20/excess10/excess20
    code: String(600000 + i), name: '旧股' + i, industry: '测试行业', price: 10 + i, chgPct: 1, status: '正常',
    p5: 50 + (i % 40), p10: 60, p20: 70, ret5: 1, ret10: 2, excess5: 0.5, expDD: 6, confidence: 70, score: 55
  }))
};
w.localStorage.setItem('qp_pred_hist', JSON.stringify([oldSnap]));

['js/data.js', 'js/real.js', 'js/screener.js', 'js/ai.js', 'js/predict.js', 'js/backtest.js', 'js/app.js'].forEach(f => {
  w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
});
const errors = [];
w.addEventListener('error', e => errors.push('ERR: ' + e.message));
w.addEventListener('unhandledrejection', e => errors.push('UNHANDLED: ' + (e.reason && e.reason.message)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await sleep(12000);   // 等真实模式初始化
  w.location.hash = '#/predict';
  w.dispatchEvent(new w.Event('hashchange'));
  await sleep(5000);    // 等页面渲染
  const rows = d.querySelectorAll('#pdBody tr').length;
  const skeletonLeft = !!d.querySelector('#content .skeleton');
  const contentText = (d.getElementById('content') || {}).textContent || '';
  console.log('预测行数:', rows, '| 骨架残留:', skeletonLeft, '| 内容长度:', contentText.length);
  console.log('页面含"今日预测已锁定":', contentText.includes('今日预测已锁定'));
  console.log('页面含"AI 预测选股":', contentText.includes('AI 预测选股'));
  if (errors.length) console.log('JS 错误:\n' + errors.join('\n'));
  else console.log('无 JS 运行时错误');
  process.exit(rows > 0 && !skeletonLeft && errors.length === 0 ? 0 : 1);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });
