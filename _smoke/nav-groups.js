/* 导航分组渲染验证:确认 5 个分组标题 + 11 个菜单项正确生成,且路由高亮可用 */
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
w.echarts = {
  init: () => new FakeChart(),
  getInstanceByDom: () => null,
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
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

(async () => {
  d.dispatchEvent(new w.Event('DOMContentLoaded'));
  await sleep(3000);

  const labels = Array.from(d.querySelectorAll('#nav .nav-label')).map(e => e.textContent.trim());
  const items = Array.from(d.querySelectorAll('#nav .nav-item'));
  const hashes = items.map(e => e.dataset.hash);
  const texts = items.map(e => (e.querySelector('.nav-txt') || {}).textContent || '');

  check('分组数量为 5', labels.length === 5, labels.join(' / '));
  check('分组名称正确', labels.join(',') === '行情看盘,选股工具,AI 智能,我的,系统', labels.join(','));
  check('菜单项数量为 10(AI 两项已合并)', items.length === 10, '实际 ' + items.length);
  check('无重复路由', new Set(hashes).size === hashes.length, hashes.join(' '));
  check('每个菜单项都有图标', items.every(e => e.querySelector('.nav-ico svg')), '');
  check('每个菜单项都有文字', texts.every(t => t && t.length > 0), texts.join(' / '));
  check('自选股带角标容器', !!d.querySelector('#nav .nav-badge'), '');
  check('AI 智能分析项带 alias(#/ai)', (d.querySelector('#nav .nav-item[data-hash="#/predict"]') || {}).dataset.alias === '#/ai', '');
  check('默认高亮大盘晴雨表', !!d.querySelector('#nav .nav-item.on[data-hash="#/dashboard"]'),
    (d.querySelector('#nav .nav-item.on') || {}).dataset ? d.querySelector('#nav .nav-item.on').dataset.hash : 'none');
  check('无 JS 运行时错误', errors.length === 0, errors.join(' ; '));

  console.log('\n================ 导航分组验证 ================');
  // 按分组打印树状结构
  let gi = 0, ii = 0;
  for (const child of d.querySelectorAll('#nav > *')) {
    if (child.classList.contains('nav-label')) { console.log('[' + child.textContent.trim() + ']'); }
    else { console.log('    ' + child.querySelector('.nav-txt').textContent + '  ' + child.dataset.hash); }
  }
  console.log('--------------------------------------');
  results.forEach(r => console.log(r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });
