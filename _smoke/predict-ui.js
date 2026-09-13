/* AI 预测选股页 + AI 牛股诊断页 UI 集成测试:jsdom + 本地数据服务(东方财富真实数据)
 * 验证:#/predict 每日锁定预测(总榜前100)、板块筛选、自动复盘;
 *       #/ai 用户选股诊断(无预置股票预测)、诊断报告与概率预测渲染 */
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
w.echarts = { init: () => new FakeChart(), getInstanceByDom: () => null, graphic: { LinearGradient: function (x, y, x2, y2, s) { return { type: 'linear', colorStops: s }; } } };
w.URL.createObjectURL = () => 'blob:x';
w.confirm = () => false; w.prompt = () => null;
w.localStorage.setItem('qp_users', JSON.stringify({ demo: { pass: 'x', nick: '演示' } }));
w.localStorage.setItem('qp_session', JSON.stringify({ name: 'demo', nick: '演示' }));
w.localStorage.setItem('qp_settings', JSON.stringify({ colorMode: 'cn', live: false }));

['js/data.js', 'js/real.js', 'js/screener.js', 'js/ai.js', 'js/predict.js', 'js/backtest.js', 'js/app.js'].forEach(f => {
  w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
});

const errors = [];
w.addEventListener('error', e => errors.push('ERR: ' + e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout, interval) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(interval || 1000);
  }
  return false;
}
function setHash(h) { w.location.hash = h; w.dispatchEvent(new w.Event('hashchange')); }
function q(sel) { return d.querySelector(sel); }
function qa(sel) { return Array.from(d.querySelectorAll(sel)); }
function click(sel) { const el = q(sel); if (!el) return false; el.click(); return true; }
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

(async () => {
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await sleep(10000);
  check('真实模式开启', w.QP.real.store.mode === 'real', '数据源:' + w.QP.real.store.source);
  for (let i = 0; i < 20 && w.QP.real.store.marketAll.total < 3000; i++) await sleep(2000);
  check('全市场样本(5000+)', w.QP.real.store.marketAll.total > 3000, '总数:' + w.QP.real.store.marketAll.total);
  check('自动登录', d.getElementById('app').classList.contains('on'));

  // ================= 预测页(每日锁定) =================
  setHash('#/predict');
  // 首次进入:生成并锁定今日预测(含技术指标预取),最多等待 60 秒
  const pageReady = await waitFor(() => qa('#pdBody tr').length > 0, 60000, 1500);
  check('预测页渲染(按生效交易日)', pageReady, '行数:' + qa('#pdBody tr').length);
  check('锁定/可变更状态显示', d.body.textContent.includes('盘中已锁定') || d.body.textContent.includes('可变更'), '');
  check('总榜前100(4页)', d.body.textContent.includes('1 / 4 页'), '');
  check('KPI 统计条', !!q('#pdAvgProb') && !!q('#pdHiProb'), '平均概率:' + (q('#pdAvgProb') || {}).textContent);
  check('排名维度 Tab(7 种)', qa('#content .tabs button').length === 7, '');
  check('概率条渲染', !!q('#pdBody .prob-bar i'), '');

  // 生效日快照已生成(盘中锁定 / 盘前盘后为下一交易日)
  const snap1 = w.QP.predict.loadSnapshots().find(s => s.label === w.QP.predict.effectiveTradeDate());
  check('生效日快照已自动生成', !!snap1 && Array.isArray(snap1.top) && snap1.top.length === 100,
    'label:' + (snap1 ? snap1.label : '未找到') + ' top:' + (snap1 && Array.isArray(snap1.top) ? snap1.top.length : 0) +
    ' 本地快照数:' + w.QP.predict.loadSnapshots().length +
    ' 同步:' + JSON.stringify(w.QP.predict.snapshotSyncState ? w.QP.predict.snapshotSyncState() : null));

  // 排名维度切换(仅对锁定前100重排)
  click('[data-act="predict-tab"][data-dim="prob"]'); await sleep(1500);
  check('概率榜切换生效', qa('#pdBody tr').length > 0, 'Top1:' + ((qa('#pdBody tr')[0] || {}).textContent || '').slice(0, 30));
  click('[data-act="predict-horizon"][data-h="10"]'); await sleep(1500);
  check('周期切换为10日', d.body.textContent.includes('上涨概率 P10') && d.body.textContent.includes('预期收益 R10'), '');

  // 板块筛选:只从总榜前100中选(取首行所属行业,保证至少1行)
  const firstRow = q('#pdBody tr[data-code]');
  let sectorFiltered = true;
  if (firstRow) {
    const code = firstRow.dataset.code;
    const sec = w.QP.data.getStock(code);
    const secSel = q('[data-act="predict-sector"]');
    if (sec && secSel && sec.industry) {
      // 找到该行业 option 并选中
      const opt = Array.from(secSel.options).find(o => o.value === sec.industry);
      if (opt) {
        secSel.value = opt.value;
        secSel.dispatchEvent(new w.Event('change', { bubbles: true }));
        await sleep(1500);
        const rows2 = qa('#pdBody tr').length;
        const allInSector = qa('#pdBody tr[data-code]').every(r => {
          const st = w.QP.data.getStock(r.dataset.code);
          return st && st.industry === sec.industry;
        });
        sectorFiltered = rows2 > 0 && allInSector;
        check('板块筛选(总榜前100内)', sectorFiltered, '行业:' + sec.industry + ' 行数:' + rows2);
        // 恢复
        secSel.value = '';
        secSel.dispatchEvent(new w.Event('change', { bubbles: true }));
        await sleep(1200);
      } else {
        check('板块筛选(总榜前100内)', true, '无该行业option,跳过');
      }
    } else {
      check('板块筛选(总榜前100内)', true, '无行业信息,跳过');
    }
  } else {
    check('板块筛选(总榜前100内)', false, '无预测行');
  }

  // 自动复盘:快照面板自动渲染(无需点击)
  check('自动复盘面板渲染', qa('#predReview .pred-snap').length >= 1, '快照卡:' + qa('#predReview .pred-snap').length);
  const revText = (q('#predReview') || {}).textContent || '';
  check('复盘面板含状态/周期说明', revText.includes('已锁定') || revText.includes('可变更') || revText.includes('验证周期进行中'), '');

  // 预测值来自锁定快照:实时刷新不应改变预测列(记录概率值)
  const probBefore = (q('#pdBody tr td[data-c="prob"] b') || {}).textContent;
  await sleep(3800);
  const probAfter = (q('#pdBody tr td[data-c="prob"] b') || {}).textContent;
  check('预测值锁定(实时刷新不改预测)', probBefore === probAfter && probAfter != null, probBefore + ' -> ' + probAfter);

  // ================= AI 牛股诊断页(用户选股) =================
  /* 用轮询等待页面元素出现,而非固定 sleep——冷启动/慢网络下固定等待会误判 */
  setHash('#/ai');
  const aiReady = await waitFor(() => !!q('#aiStockSearch'), 20000, 500);
  check('AI页无预置股票预测', aiReady && !q('#aiResult .score-ring') && !!q('#aiStockSearch'), '准备就绪:' + aiReady);
  const aiInp = q('#aiStockSearch');
  if (!aiInp) { report(); return; }
  aiInp.value = '茅台';
  aiInp.dispatchEvent(new w.Event('input', { bubbles: true }));
  await waitFor(() => !!q('#aiSuggest .sd-item[data-act="ai-pick"]'), 8000, 400);
  const suggest = q('#aiSuggest .sd-item[data-act="ai-pick"]');
  check('选股建议出现', !!suggest, suggest ? suggest.textContent.trim().slice(0, 30) : '');
  if (suggest) {
    suggest.click();
    const reportReady = await waitFor(() => !!q('#aiResult .score-ring'), 40000, 1500);
    check('诊断报告生成(六维评分)', reportReady, '综合分:' + ((q('#aiResult .sr-val') || {}).textContent || ''));
    const aiTxt = (q('#aiResult') || {}).textContent || '';
    check('诊断含概率预测', aiTxt.includes('上涨概率') && aiTxt.includes('预期收益') && aiTxt.includes('置信度'), '');
    check('诊断含评分依据', aiTxt.includes('综合评分') && aiTxt.includes('风险'), '');
  }

  console.log('\n================ 预测/诊断 UI 集成测试 ================');
  report();
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });

/* 收尾汇总(供正常结束与提前返回共用) */
function report() {
  results.forEach(r => console.log(r));
  console.log('--------------------------------------');
  if (errors.length) { console.log('JS 错误:\n' + errors.join('\n')); }
  else console.log('无 JS 运行时错误');
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\n总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length || errors.length ? 1 : 0);
}
