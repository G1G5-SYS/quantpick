/* 无数据服务回归测试:验证服务不可用时页面明确报错,不渲染任何模拟数据 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
// 故意使用无服务的 origin,模拟数据服务不可用
const dom = new JSDOM(html, { url: 'http://localhost:1/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window, d = w.document;

class FakeChart { setOption() {} dispose() {} resize() {} }
w.echarts = { init: () => new FakeChart(), graphic: { LinearGradient: function (x, y, x2, y2, s) { return { type: 'linear', colorStops: s }; } } };
w.URL.createObjectURL = () => 'blob:x';
w.confirm = () => false; w.prompt = () => null;
w.localStorage.setItem('qp_users', JSON.stringify({ demo: { pass: 'x', nick: '演示' } }));
w.localStorage.setItem('qp_session', JSON.stringify({ name: 'demo', nick: '演示' }));
w.localStorage.setItem('qp_settings', JSON.stringify({ colorMode: 'cn', live: true }));

['js/data.js', 'js/real.js', 'js/screener.js', 'js/ai.js', 'js/backtest.js', 'js/app.js'].forEach(f => {
  w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
});

const errors = [];
w.addEventListener('error', e => errors.push('ERR: ' + e.message));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = sel => d.querySelector(sel);
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

(async () => {
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await sleep(2500);
  check('服务不可用判定', w.QP.real.store.mode === 'mock' && w.QP.real.store.ready === false);
  check('自动登录', d.getElementById('app').classList.contains('on'));
  await sleep(600);
  const content = d.getElementById('content').innerHTML;
  check('显示数据服务错误页(不渲染模拟数据)', content.includes('数据服务未连接') || content.includes('无法连接数据服务'), '');
  check('页面无模拟行情表格', !content.includes('kpi') && !content.includes('grid-3'), '');
  const text = d.body.textContent;
  check('文案无模拟数据内容', text.includes('不展示任何模拟数据') || text.includes('不展示模拟数据'), '');

  console.log('\n================ 无服务模式结果 ================');
  results.forEach(r => console.log(r));
  console.log('--------------------------------------');
  if (errors.length) { console.log('JS 错误:\n' + errors.join('\n')); }
  else console.log('无 JS 运行时错误');
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\n总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
