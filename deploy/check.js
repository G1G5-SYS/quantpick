#!/usr/bin/env node
/* QuantPick 部署自检脚本(服务器上运行,零依赖,兼容 Node 16+)
 * 用法: node deploy/check.js [baseUrl]   默认 http://127.0.0.1:8090
 * 输出每项 PASS/FAIL,全部通过 exit 0,否则 exit 1 */
'use strict';
const http = require('http');
const base = process.argv[2] || 'http://127.0.0.1:8090';
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }
function get(path, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const req = http.get(u, { timeout: timeout || 15000 }, res => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}
(async () => {
  // 1. Node 版本
  const mv = process.versions.node.split('.').map(Number);
  check('Node 版本 >= 16', mv[0] >= 16, 'v' + process.versions.node);

  // 2. 服务存活
  try {
    const ping = await get('/api/ping');
    const ok = ping.status === 200 && /"ok":true/.test(ping.body);
    check('数据服务 /api/ping', ok, 'HTTP ' + ping.status);
  } catch (e) { check('数据服务 /api/ping', false, e.message); }

  // 3. 应用本体(根路径)
  try {
    const idx = await get('/');
    check('应用本体 / (含 #app)', idx.status === 200 && idx.body.indexOf('id="app"') >= 0, 'HTTP ' + idx.status + ', ' + idx.body.length + 'B');
  } catch (e) { check('应用本体 / (含 #app)', false, e.message); }

  // 4. 官网
  try {
    const w1 = await get('/website/');
    const w2 = await get('/website/index.html');
    const ok = (w1.status === 200 && w1.body.indexOf('牛股智选') >= 0) || (w2.status === 200 && w2.body.indexOf('牛股智选') >= 0);
    check('官网 /website/', ok, '短链 ' + w1.status + ' / 文件 ' + w2.status);
  } catch (e) { check('官网 /website/', false, e.message); }

  // 5. 真实数据链路(单只行情)
  try {
    const q = await get('/api/quote?codes=600519', 20000);
    let price = null;
    try { const j = JSON.parse(q.body); price = j.data && j.data[0] && j.data[0].price; } catch (e) { }
    check('真实行情 /api/quote(600519)', q.status === 200 && price != null, 'HTTP ' + q.status + ', price=' + price);
  } catch (e) { check('真实行情 /api/quote(600519)', false, e.message); }

  // 6. 全市场列表(约5900只)
  try {
    const m = await get('/api/market-all', 60000);
    let total = null;
    try { const j = JSON.parse(m.body); total = j.data && j.data.total; } catch (e) { }
    check('全市场 /api/market-all', m.status === 200 && total > 3000, 'HTTP ' + m.status + ', total=' + total);
  } catch (e) { check('全市场 /api/market-all', false, e.message); }

  /* 7-9. 静态资源安全守卫(公网部署必须全为 403)
   * 背景:曾出现越界读取(/..%2f 可读到应用目录之外的文件)与 .git 元数据暴露。
   * 注意路径穿越必须写成 ..%2f:URL 解析器会把 %2e%2e 还原成 .. 并规范化掉,那样测不到真实行为。 */
  for (const [name, p] of [
    ['静态守卫 /server.js', '/server.js'],
    ['静态守卫 /.git/config', '/.git/config'],
    ['静态守卫 路径穿越', '/..%2f..%2fetc%2fpasswd']
  ]) {
    try {
      const r = await get(p);
      check(name + ' 应为 403', r.status === 403, 'HTTP ' + r.status);
    } catch (e) { check(name + ' 应为 403', false, e.message); }
  }

  console.log('\n================ QuantPick 部署自检(' + base + ') ================');
  results.forEach(r => console.log(r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('--------------------------------------');
  console.log('总计:' + results.length + ' 项,失败:' + fails.length);
  if (fails.length === 0) console.log('✔ 部署正常:应用 / · 官网 /website/ · 数据链路畅通');
  else { console.log('✘ 存在失败项,请对照 deploy/DEPLOY.md 排查'); process.exit(1); }
})().catch(e => { console.error('自检脚本崩溃:', e); process.exit(2); });
