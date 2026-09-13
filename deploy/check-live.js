#!/usr/bin/env node
/* 公网侧安全复核(在任意能访问站点的机器上运行,零依赖)
 *
 * 与 deploy/check.js 的分工:
 *   check.js      在服务器内部跑,验证服务/数据链路/守卫
 *   check-live.js 从公网跑,验证外面看到的就是守卫生效后的样子(含 CDN 是否缓存了旧响应)
 *
 * 用法:
 *   node deploy/check-live.js                        # 默认 https://xinghuo1.org
 *   node deploy/check-live.js https://example.com
 *   node deploy/check-live.js https://xinghuo1.org 1.2.3.4   # 指定 IP 直连(绕开本地 DNS)
 *
 * 全部符合预期 exit 0,否则 exit 1。每项都带时间戳参数穿透 CDN 缓存。
 */
'use strict';
const https = require('https');

const target = (process.argv[2] || 'https://xinghuo1.org').replace(/\/+$/, '');
const ipOverride = process.argv[3] || '';
const stamp = Date.now();

/* 期望值:200 = 正常提供;403 = 守卫拒绝;400 = 畸形路径明确报错。
 * /% 由 500 变 400、/.git/config 与 /deploy/check.js 由 404 变 403,是新旧版本最可靠的判别依据。 */
const EXPECT = [
  ['首页', '/', 200],
  ['官网', '/website/', 200],
  ['数据服务', '/api/ping', 200],
  ['畸形路径 /%', '/%', 400],
  ['服务器源码 /server.js', '/server.js', 403],
  ['版本库 /.git/config', '/.git/config', 403],
  ['版本库 /.git/objects', '/.git/objects/info/packs', 403],
  ['部署脚本 /deploy/check.js', '/deploy/check.js', 403],
  ['测试目录 /_smoke/run.js', '/_smoke/run.js', 403],
  ['启动脚本 /start.bat', '/start.bat', 403],
  ['路径穿越 ..%2f', '/..%2f..%2fetc%2fpasswd', 403]
];

function get(pathname, host, ip) {
  return new Promise(resolve => {
    const url = new URL(target + pathname);
    const opt = {
      host: ip || url.hostname,
      servername: url.hostname,                     // 直连 IP 时仍按域名做 SNI
      port: url.port || 443,
      path: url.pathname + url.search + (url.search ? '&' : '?') + 'qp=' + stamp,
      method: 'GET',
      timeout: 20000,
      headers: { 'user-agent': 'quantpick-check-live', accept: '*/*', 'accept-encoding': 'identity' }
    };
    const req = https.request(opt, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', e => resolve({ status: 0, err: e.code || e.message }));
    req.end();
  });
}

(async () => {
  console.log('\n================ QuantPick 公网复核(' + target + (ipOverride ? ' @' + ipOverride : '') + ') ================');
  console.log('时间:', new Date().toLocaleString('zh-CN'), '\n');

  let fails = 0;
  for (const [label, p, want] of EXPECT) {
    const r = await get(p, null, ipOverride);
    const ok = r.status === want;
    if (!ok) fails++;
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label + ' | 期望 ' + want + ' 实际 ' + (r.status || r.err));
  }

  /* 内容级断言:确认拿到的是"新版本"而不只是状态码对得上 */
  const home = await get('/', null, ipOverride);
  const isNew = home.status === 200 && /牛股智选/.test(home.body || '');
  if (!isNew) fails++;
  console.log((isNew ? 'PASS' : 'FAIL') + ' | 首页内容含产品名(说明不是 CDN 缓存的空壳)');

  const ov = await get('/api/overview', null, ipOverride);
  let fields = false;
  try {
    const j = JSON.parse(ov.body);
    fields = j && j.data && typeof j.data.upPct === 'number' && typeof j.data.downPct === 'number';
  } catch (e) { }
  if (!fields) fails++;
  console.log((fields ? 'PASS' : 'FAIL') + ' | /api/overview 含 upPct/downPct(修复"占比 undefined%"的那个字段)');

  console.log('--------------------------------------');
  console.log('总计:' + (EXPECT.length + 2) + ' 项,失败:' + fails);
  if (fails === 0) console.log('✔ 公网侧一切正常:守卫生效、静态文件已更新、接口字段完整');
  else {
    console.log('✘ 存在失败项。排查顺序:');
    console.log('  1) 服务器上服务是否在跑: netstat -ano | findstr ":80 :443 :8090"');
    console.log('  2) 服务跑的是不是新版本: 比对 server.js 的字节数与 SHA256');
    console.log('  3) 是否 CDN 缓存了旧响应: 本脚本已带时间戳参数,若仍失败请刷新 CDN 缓存');
    process.exit(1);
  }
})().catch(e => { console.error('复核脚本崩溃:', e.message); process.exit(2); });
