/* 静态资源安全守卫测试
 *
 * 背景(两个真实缺陷,已修复):
 *   1) 越界读取:静态托管曾用 `fp.startsWith(ROOT)` 判断解析后的路径是否落在应用目录内。
 *      字符串前缀会把"兄弟路径"误判为合法 —— ROOT = ...\quantpick 时,
 *      ...\quantpick-update.zip 也"以 ROOT 开头",于是
 *          GET /..%2fquantpick-update.zip   →  200,直接下载到应用目录之外的 ZIP。
 *      (注意:%2e%2e%2f 会被 URL 解析器还原成 .. 从而被规范化掉,必须用 ..%2f 这种形式)
 *   2) 源码历史泄露:`.git` 未被屏蔽,`/.git/config`、`/.git/objects/*` 均可读取,
 *      攻击者能还原完整提交历史(包括曾经误提交后删除的文件)。
 *   同时:畸形百分号编码(如 `/%`)会抛 URIError 落到通用 500,现已明确返回 400。
 *
 * 本测试把上述行为固化为契约,防止回归。
 * 依赖:运行中的服务(隔离实例 QP_TEST_BASE)。
 * 副作用:仅在被测应用目录的父目录创建一个探针文件并立即删除,不写入任何业务数据。
 */
const fs = require('fs');
const path = require('path');
const { BASE } = require('./test-env');

const ROOT = path.join(__dirname, '..');
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

async function get(p) {
  try {
    const r = await fetch(BASE + p, { signal: AbortSignal.timeout(30000) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, len: buf.length, buf: buf };
  } catch (e) { return { status: 0, len: 0, err: e.message }; }
}

(async () => {
  /* ---------- 基线:服务可用且合法资源照常提供(守卫不能误伤) ---------- */
  const ping = await get('/api/ping');
  check('服务可用(/api/ping)', ping.status === 200, 'HTTP ' + ping.status);

  for (const asset of ['/', '/css/style.css', '/js/app.js', '/website/index.html', '/README.md']) {
    const r = await get(asset);
    check('合法资源可访问 ' + asset, r.status === 200 && r.len > 0, 'HTTP ' + r.status + ' ' + r.len + 'B');
  }

  /* ---------- 内部实现不应对外提供 ---------- */
  const blocked = [
    ['服务器源码 /server.js', '/server.js'],
    ['测试目录 /_smoke/run.js', '/_smoke/run.js'],
    ['运行数据 /_smoke/_data/...', '/_smoke/_data/market-all.json'],
    ['快照目录 /.cache/...', '/.cache/pred-snapshots.json'],
    ['桌面构建 /dist-desktop/...', '/dist-desktop/run.cmd'],
    ['Windows 脚本 /start.bat', '/start.bat'],
    ['部署脚本 /deploy/setup-ubuntu.sh', '/deploy/setup-ubuntu.sh']
  ];
  for (const [label, p] of blocked) {
    const r = await get(p);
    check('拒绝访问 ' + label, r.status === 403, 'HTTP ' + r.status);
  }

  /* ---------- 版本库元数据:必须挡掉,否则可还原完整历史 ---------- */
  for (const p of ['/.git/config', '/.git/HEAD', '/.git/objects/info/packs', '/.git/logs/HEAD']) {
    const r = await get(p);
    check('拒绝访问 ' + p, r.status === 403, 'HTTP ' + r.status);
  }

  /* ---------- 常规路径穿越 ---------- */
  const up = await get('/..%2f..%2f..%2fetc%2fpasswd');
  check('常规越界 ../.. 被拒绝', up.status === 403, 'HTTP ' + up.status);
  const win = await get('/..%2f..%2fWindows%2fwin.ini');
  check('常规越界指向系统文件被拒绝', win.status === 403, 'HTTP ' + win.status);

  /* ---------- 畸形编码:不应落成 500 ---------- */
  const bad = await get('/%');
  check('畸形百分号编码返回 400(不是 500)', bad.status === 400, 'HTTP ' + bad.status);

  /* ---------- 关键回归:兄弟目录前缀绕过(需要真实存在的文件才算数) ---------- */
  const parent = path.dirname(ROOT);
  const probeName = path.basename(ROOT) + '-static-guard-probe.txt';
  const probePath = path.join(parent, probeName);
  const MARK = 'PROBE-SHOULD-NOT-BE-SERVED';
  let created = false;
  try { fs.writeFileSync(probePath, MARK, 'utf8'); created = true; } catch (e) { created = false; }
  try {
    if (created) {
      const r = await get('/..%2f' + probeName);
      check('兄弟目录前缀绕过被拒绝(探针文件真实存在)', r.status === 403, 'HTTP ' + r.status);
      check('绕过响应体不含探针内容', !r.buf.includes(MARK), 'len=' + r.len);
    } else {
      results.push('SKIP | 兄弟目录前缀绕过(父目录不可写,未能创建探针文件)');
    }
  } finally {
    if (created) { try { fs.unlinkSync(probePath); } catch (e) { } }
  }

  console.log('\n================ 静态资源安全守卫 ================');
  results.forEach(r => console.log(r));
  console.log('--------------------------------------');
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('\n总计:' + results.length + ' 项,失败:' + fails.length);
  /* 用 exitCode 而不是 process.exit():本套件连续发起大量请求,
   * undici 连接尚未收尾时强退会在 Windows 上触发 libuv 断言(进程异常退出码),
   * 那样"断言全过"却被判成崩溃。 */
  process.exitCode = fails.length ? 1 : 0;
})().catch(e => { console.error('测试崩溃:', e); process.exitCode = 2; });
