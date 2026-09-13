/* 官网页面冒烟测试:jsdom 加载 website/index.html
 * 验证:关键区块齐全、无 JS 错误、进入应用链接自适应(server 访问→应用根;file://→启动引导) */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { BASE } = require('./test-env');
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'website', 'index.html'), 'utf8');
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

async function runCase(url, name) {
  const dom = new JSDOM(html, { url: url, runScripts: 'dangerously', pretendToBeVisual: true });
  const w = dom.window, d = w.document;
  const errors = [];
  w.addEventListener('error', e => errors.push('ERR: ' + e.message));
  await new Promise(r => setTimeout(r, 1200));
  const body = d.body.textContent;
  const btns = d.querySelectorAll('[data-enter-app]');
  return { w, d, errors, body, btns, name };
}

(async () => {
  // 1. 通过 server 访问(http://127.0.0.1:8090/website/index.html)
  const s = await runCase(BASE + '/website/index.html', 'server');
  check('server访问:按钮存在', s.btns.length === 2, '按钮数:' + s.btns.length);
  const href0 = s.btns[0].getAttribute('href');
  const href1 = s.btns[1].getAttribute('href');
  check('server访问:链接自动指向应用根', href0 === BASE + '/' && href1 === BASE + '/', href0 + ' | ' + href1);
  check('server访问:无 JS 错误', s.errors.length === 0, s.errors.join(';'));
  check('Hero 标题', s.body.includes('牛股智选'), '');
  check('预测机制说明(按时段锁定)', s.body.includes('开盘（9:30）后至收盘（15:00）前预测锁定') && s.body.includes('收盘后至次日开盘前可重新预测'), '');
  check('数据区/使用/免责/界面示意', s.body.includes('只用真实数据') && s.body.includes('打开就能用') && s.body.includes('股市有风险') && html.includes('界面示意（非真实预测结果）'), '');
  /* 内容与产品同步:新能力必须出现在官网上(避免官网落后于应用) */
  check('官网已同步:AI 入口合并', s.body.includes('AI 智能分析') && !s.body.includes('AI 预测选股 · 大盘'), '');
  check('官网已同步:预测台账与累计胜率', s.body.includes('预测台账') && s.body.includes('累计胜率'), '');
  check('官网已同步:真实交易日历', s.body.includes('真实交易日历'), '');
  check('官网已同步:回测分析增强', s.body.includes('蒙特卡洛回撤') && s.body.includes('窗口稳健性'), '');
  check('官网已同步:导航分组口径', s.body.includes('行情中心'), '');
  /* 配色与应用统一(深海蓝金):不应再出现旧红金主题色 */
  check('配色已统一:无旧红金底色', !/#12090a|#1a0e0f|#231315|#2e1a1d|#d41f1f|#c8102e|#e8373a/i.test(html), '');
  check('配色已统一:使用深海蓝品牌色', /#2e6be6/i.test(html) && /#0b1220/i.test(html), '');
  /* 语义色必须保留(A 股铁律:红涨绿跌) */
  check('语义色保留:红涨绿跌', /--up:\s*#ff4d4f|--up:\s*#f5222d/i.test(html) && /--down:\s*#00b578/i.test(html), '');

  // 2. 直接双击文件打开(file://)
  const f = await runCase('file:///C:/Users/x/Desktop/quantpick/website/index.html', 'file');
  const fh = f.btns[0].getAttribute('href');
  check('file访问:链接降级为#', fh === '#', 'href:' + fh);
  f.btns[0].dispatchEvent(new f.w.MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise(r => setTimeout(r, 200));
  const tip = f.d.getElementById('enterTip');
  check('file访问:点击显示启动引导', !!tip && tip.style.display === 'block', '');

  console.log('\n================ 官网页面测试 ================');
  results.forEach(r => console.log(r));
  console.log('--------------------------------------');
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\n总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('测试崩溃:', e); process.exit(2); });
