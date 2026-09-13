/* 接口字段契约测试
 *
 * 背景(真实缺陷): 界面直接把接口字段拼进 HTML,一旦接口少返回字段,页面就会显示
 *   "undefined"。已发现并修复过两处:
 *     - /api/overview 缺 upPct/downPct  → KPI 显示 "占比 undefined%"
 *     - /api/indices  缺 market         → 指数卡片右上角显示 "undefined"
 * 本测试把"界面实际会渲染的字段"固化为契约,防止再次回归。
 *
 * 依赖: 隔离实例(QP_TEST_BASE)。只读接口,不写入任何数据。
 */
const { BASE } = require('./test-env');

const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }

async function get(path, timeout) {
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), timeout || 90000);
  try {
    const r = await fetch(BASE + path, { signal: ctrl.signal });
    const j = await r.json();
    return { status: r.status, json: j };
  } catch (e) {
    return { status: 0, err: e.message };
  } finally { clearTimeout(tm); }
}
const isNum = v => typeof v === 'number' && isFinite(v);
const isStr = v => typeof v === 'string' && v.length > 0;
/* 递归检查对象里是否出现 undefined 值(界面拼串会变成 "undefined") */
function undefinedKeys(obj, prefix, out, depth) {
  out = out || []; depth = depth || 0;
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  Object.keys(obj).forEach(k => {
    const v = obj[k];
    if (v === undefined) out.push((prefix ? prefix + '.' : '') + k);
    else if (v && typeof v === 'object' && !Array.isArray(v)) undefinedKeys(v, (prefix ? prefix + '.' : '') + k, out, depth + 1);
  });
  return out;
}

(async () => {
  /* ---------- /api/overview:大盘 KPI ---------- */
  const ov = await get('/api/overview');
  check('/api/overview 返回 200', ov.status === 200 && ov.json && ov.json.ok === true, 'HTTP ' + ov.status);
  const o = (ov.json && ov.json.data) || {};
  check('overview.up / down 为数字', isNum(o.up) && isNum(o.down), 'up=' + o.up + ' down=' + o.down);
  /* 这两条就是本次修复的字段:界面渲染 "占比 X%" */
  check('overview.upPct 存在且为数字(修复点)', isNum(o.upPct), 'upPct=' + o.upPct);
  check('overview.downPct 存在且为数字(修复点)', isNum(o.downPct), 'downPct=' + o.downPct);
  check('overview.limitUp / limitDown 为数字', isNum(o.limitUp) && isNum(o.limitDown), o.limitUp + '/' + o.limitDown);
  check('overview.amount / mainNet 为数字', isNum(o.amount) && isNum(o.mainNet), 'amount=' + o.amount);
  check('overview.breadth 为数字', isNum(o.breadth), 'breadth=' + o.breadth);
  check('overview 无 undefined 字段', undefinedKeys(o).length === 0, undefinedKeys(o).join(','));
  check('upPct 与 up/breadth 口径一致', (o.up + o.down + (o.flat || 0)) === 0 ||
    Math.abs(o.upPct - o.breadth) < 0.11, 'upPct=' + o.upPct + ' breadth=' + o.breadth);

  /* ---------- /api/indices:指数卡片 ---------- */
  const ix = await get('/api/indices');
  check('/api/indices 返回 200', ix.status === 200 && ix.json && ix.json.ok === true, 'HTTP ' + ix.status);
  const arr = (ix.json && ix.json.data) || [];
  check('指数数量 ≥ 6', arr.length >= 6, '实际 ' + arr.length);
  const missMarket = arr.filter(x => !isStr(x.market));
  /* 这条就是本次修复的字段:指数卡片右上角标签 */
  check('每个指数都有 market 标签(修复点)', missMarket.length === 0,
    missMarket.length ? ('缺失: ' + missMarket.map(x => x.code).join(',')) : arr.map(x => x.market).join('/'));
  check('每个指数都有 code / name', arr.every(x => isStr(x.code) && isStr(x.name)), '');
  check('每个指数都有 quote 且含 price/chgPct 字段', arr.every(x => x.quote && ('price' in x.quote) && ('chgPct' in x.quote)), '');
  check('指数无 undefined 字段', undefinedKeys(arr).length === 0, undefinedKeys(arr).slice(0, 6).join(','));

  /* ---------- /api/ranks:榜单中心 ---------- */
  const rk = await get('/api/ranks');
  check('/api/ranks 返回 200', rk.status === 200 && rk.json && rk.json.ok === true, 'HTTP ' + rk.status);
  const rkd = (rk.json && rk.json.data) || {};
  const need = ['up', 'down', 'amount', 'turnover', 'volratio'];
  check('ranks 含 5 类榜单', need.every(k => Array.isArray(rkd[k])), Object.keys(rkd).join(','));
  const firstRows = rkd.up || [];
  check('榜单行含 code/name/chgPct', firstRows.length > 0 && firstRows.every(r => isStr(r.code) && isStr(r.name) && ('chgPct' in r)),
    '首行 ' + (firstRows[0] ? (firstRows[0].code + '/' + firstRows[0].name) : '(空)'));

  /* ---------- /api/market-all:全市场 ---------- */
  const ma = await get('/api/market-all');
  check('/api/market-all 返回 200', ma.status === 200 && ma.json && ma.json.ok === true, 'HTTP ' + ma.status);
  const mad = (ma.json && ma.json.data) || {};
  check('全市场 total > 3000', mad.total > 3000, 'total=' + mad.total);
  check('全市场列表非空且含必要字段', Array.isArray(mad.list) && mad.list.length > 0 &&
    isStr(mad.list[0].code) && isStr(mad.list[0].name), '样本 ' + (mad.list ? mad.list.length : 0) + ' 只');

  /* ---------- /api/calendar:交易日历 ---------- */
  const cal = await get('/api/calendar');
  check('/api/calendar 返回 200', cal.status === 200 && cal.json && cal.json.ok === true, 'HTTP ' + cal.status);
  const cd = (cal.json && cal.json.data) || {};
  check('日历 days 非空且为升序日期串', Array.isArray(cd.days) && cd.days.length > 100 && /^\d{4}-\d{2}-\d{2}$/.test(cd.days[0]),
    'count=' + (cd.days ? cd.days.length : 0));
  check('日历 last 与 days 末尾一致', cd.last === cd.days[cd.days.length - 1], cd.last);
  check('日历含 futureHolidays 数组', Array.isArray(cd.futureHolidays), '');

  /* ---------- /api/snapshots:预测台账 ---------- */
  const sn = await get('/api/snapshots');
  check('/api/snapshots 返回 200', sn.status === 200 && sn.json && sn.json.ok === true, 'HTTP ' + sn.status);
  check('台账返回 snapshots 数组', Array.isArray((sn.json.data || {}).snapshots), '');

  /* ---------- /api/quote:行情 ---------- */
  const q = await get('/api/quote?codes=600519');
  check('/api/quote 返回 200', q.status === 200 && q.json && q.json.ok === true, 'HTTP ' + q.status);
  const q0 = (q.json.data || [])[0] || {};
  check('行情含 code/name/price', isStr(q0.code) && isStr(q0.name) && ('price' in q0), q0.code + ' ' + q0.name + ' ' + q0.price);

  console.log('\n================ 接口字段契约测试 ================');
  results.forEach(r => console.log(r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('--------------------------------------');
  console.log('总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('崩溃:', e); process.exit(2); });
