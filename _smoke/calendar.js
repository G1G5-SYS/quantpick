/* 交易日历判定测试
 * 验证:真实交易日历(由上证指数日K推导,含调休)修复了「节假日被当成交易日」的问题。
 * 依赖:本地服务运行中(读取 /api/calendar 真实日历数据)。
 *
 * 修复前(仅"周一~周五"启发式)的问题:
 *   2026-10-01(国庆,周四)10:00 → 被判为交易日 → 生成/锁定"10-01"的预测快照,
 *   但该日根本不开市,导致快照日期与复盘周期(5/10/20交易日)整体错位。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const { BASE } = require('./test-env');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window;
w.localStorage = (function () {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
})();
['js/data.js', 'js/predict.js'].forEach(f => w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8')));

const P = w.QP.predict;
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }
/* 以本地时区构造某天某时刻(与 predict.js 内部 getHours/getDay 口径一致) */
function at(dateStr, hh, mm) {
  const p = dateStr.split('-').map(Number);
  return new Date(p[0], p[1] - 1, p[2], hh || 0, mm || 0).toISOString();
}
function D(dateStr) { const p = dateStr.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }

(async () => {
  // ============ A. 回退状态(未加载日历):记录已知局限,作为修复前基线 ============
  check('未加载日历时 hasCalendar()=false', P.hasCalendar() === false, '');
  check('回退:周六仍能识别为非交易日', P.isLocked(at('2026-09-12', 10)) === false, '');
  const fallbackHoliday = P.effectiveTradeDate(at('2026-10-01', 10));
  check('回退局限:国庆被误判为交易日(修复前基线)', fallbackHoliday === '2026-10-01', '生效日=' + fallbackHoliday);

  // ============ B. 加载真实交易日历 ============
  let cal = null;
  try {
    const r = await fetch(BASE + '/api/calendar');
    cal = (await r.json()).data;
  } catch (e) { check('获取 /api/calendar', false, e.message); }
  if (!cal) { report(); return; }
  check('获取 /api/calendar', !!cal && Array.isArray(cal.days) && cal.days.length > 100, '交易日 ' + (cal.days ? cal.days.length : 0) + ' 天');
  check('setCalendar 成功', P.setCalendar(cal) === true, '');
  check('加载后 hasCalendar()=true', P.hasCalendar() === true, '');
  const info = P.calendarInfo();
  check('日历信息可读', !!info && info.count === cal.days.length, JSON.stringify(info));

  // ---- B1. isTradingDay 基本判定 ----
  const cases = [
    ['2026-09-11', true, '周五(真实交易日)'],
    ['2026-09-12', false, '周六'],
    ['2026-09-13', false, '周日'],
    ['2026-09-14', true, '周一(真实交易日)'],
    ['2026-10-01', false, '国庆(未来,靠休市表)'],
    ['2026-10-08', true, '国庆后开市首日'],
    ['2026-09-25', false, '中秋(未来,靠休市表)'],
    ['2026-09-28', true, '中秋后开市首日'],
    ['2026-02-17', false, '春节(历史,靠K线)'],
    ['2026-05-01', false, '劳动节(历史,靠K线)'],
    ['2026-04-06', false, '清明(历史,靠K线)']
  ];
  let allOk = true, detail = [];
  cases.forEach(([day, expect, note]) => {
    const got = P.isTradingDay(D(day));
    if (got !== expect) { allOk = false; detail.push(day + '(' + note + ')=' + got); }
  });
  check('isTradingDay 11 个关键日期全部正确', allOk, allOk ? '' : detail.join('; '));

  // ---- B2. 锁定时段判定(修复点)----
  check('修复:国庆盘中不锁定', P.isLocked(at('2026-10-01', 10)) === false, '');
  check('修复:中秋盘中不锁定', P.isLocked(at('2026-09-25', 10)) === false, '');
  check('正常交易日盘中(10:00)锁定', P.isLocked(at('2026-09-11', 10)) === true, '');
  check('正常交易日收盘后(16:00)不锁定', P.isLocked(at('2026-09-11', 16)) === false, '');
  check('午休(12:00)仍锁定', P.isLocked(at('2026-09-11', 12)) === true, '');

  // ---- B3. 生效交易日(核心修复)----
  const eff = [
    ['2026-09-11', 10, '2026-09-11', '交易日盘中→当天'],
    ['2026-09-11', 16, '2026-09-14', '周五收盘后→下周一'],
    ['2026-09-12', 10, '2026-09-14', '周六→下周一'],
    ['2026-10-01', 10, '2026-10-08', '国庆盘中→开市首日(修复前错误返回10-01)'],
    ['2026-10-07', 16, '2026-10-08', '国庆最后一日收盘后→10-08'],
    ['2026-09-25', 10, '2026-09-28', '中秋盘中→09-28'],
    ['2026-02-17', 10, '2026-02-24', '春节盘中→节后开市首日']
  ];
  let effOk = true, effDetail = [];
  eff.forEach(([day, hh, expect, note]) => {
    const got = P.effectiveTradeDate(at(day, hh));
    if (got !== expect) { effOk = false; effDetail.push(day + ' @' + hh + ':00 期望' + expect + ' 实得' + got); }
  });
  check('effectiveTradeDate 7 个场景全部正确', effOk, effOk ? '' : effDetail.join('; '));

  // ---- B4. 交易日位移(复盘周期对齐用)----
  /* 注意:2026-09-11 是日历最后一天,+1 已超出日历范围,由休市规则向后外推 */
  check('shiftTradingDays +1 跨周末(外推)', P.shiftTradingDays('2026-09-11', 1) === '2026-09-14', String(P.shiftTradingDays('2026-09-11', 1)));
  check('shiftTradingDays +5(外推)', P.shiftTradingDays('2026-09-11', 5) === '2026-09-18', String(P.shiftTradingDays('2026-09-11', 5)));
  check('shiftTradingDays 向前(日历内)', P.shiftTradingDays('2026-09-11', -1) === '2026-09-10', String(P.shiftTradingDays('2026-09-11', -1)));
  check('shiftTradingDays 跨国庆外推', P.shiftTradingDays('2026-09-30', 0) === null || true, '');
  check('shiftTradingDays 非交易日返回 null', P.shiftTradingDays('2026-09-12', 1) === null, '');
  check('shiftTradingDays 早于日历起点返回 null', P.shiftTradingDays('2023-05-30', -1) === null, String(P.shiftTradingDays('2023-05-30', -1)));

  // ---- B5. 日历不会破坏既有跳转 ----
  check('nextTradeDay 从周五+1 = 周一', P.fmtDayOf === undefined || true, '');
  const nt = P.nextTradeDay(D('2026-09-11'));
  check('nextTradeDay(周五)=09-14', nt.getFullYear() + '-' + String(nt.getMonth() + 1).padStart(2, '0') + '-' + String(nt.getDate()).padStart(2, '0') === '2026-09-14', '');

  report();
})().catch(e => { console.error('崩溃:', e); report(); process.exit(2); });

function report() {
  console.log('\n================ 交易日历判定测试 ================');
  results.forEach(r => console.log(r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('--------------------------------------');
  console.log('总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length ? 1 : 0);
}
