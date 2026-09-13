/* ============================================================================
 * QuantPick 数据服务(零依赖 Node)
 * 1. 静态托管 quantpick 前端;
 * 2. 聚合多源行情数据:东方财富(主) + 腾讯财经(兜底),统一映射;
 * 3. 缓存 + 并发控制 + 多主机重试,避免单源限流导致服务中断。
 *
 * 运行: node server.js   (默认 8090)
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first'); // 部分域名 IPv6 连接不稳,统一走 IPv4
/* 说明:上游请求走全局 fetch(undici),其内置连接池已复用 keep-alive 连接,无需自建 agent */

const PORT = +(process.env.PORT || 8090);
/* 桌面版(SEA 单文件 exe):静态文件位于 exe 同目录;本地运行仍用 __dirname */
const IS_SEA = (() => { try { return require('node:sea').isSea(); } catch (e) { return false; } })();
const ROOT = IS_SEA ? path.dirname(process.execPath) : __dirname;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const REFERER = 'https://quote.eastmoney.com/';

/* ---------------- 缓存 / 并发 ---------------- */
const cache = new Map();
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.bat': 'text/plain; charset=utf-8' };

/* 分级缓存策略:静态资源指纹化的(vendor 第三方库)长缓存;应用代码短缓存 + ETag 校验;HTML 每次校验保证能拿到新版本 */
function CACHE_CTL(ext, urlPath) {
  const u = String(urlPath || '');
  if (/[\\/]vendor[\\/]/i.test(u)) return 'public, max-age=604800, immutable'; // echarts 等版本固定的库
  if (ext === '.html' || ext === '.json' || ext === '.md' || ext === '.txt') return 'no-cache'; // 每次 304 校验(极小开销),确保更新即时生效
  if (ext === '.css' || ext === '.js') return 'public, max-age=300'; // 应用代码 5 分钟内复用
  if (/^\.(png|jpg|jpeg|gif|webp|ico|svg|woff2?|ttf|eot)$/.test(ext)) return 'public, max-age=86400';
  return 'public, max-age=300';
}

const MAX_CONC = 14;
let inFlight = 0;
const pending = [];
function acquire() { return new Promise(res => { if (inFlight < MAX_CONC) { inFlight++; res(); } else pending.push(res); }); }
function release() { inFlight--; if (pending.length) { const r = pending.shift(); inFlight++; r(); } }

function cached(key, ttl, loader) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ttl) return Promise.resolve(c.data);
  return loader().then(data => { cache.set(key, { t: Date.now(), data }); return data; });
}
setInterval(() => { const now = Date.now(); cache.forEach((v, k) => { if (now - v.t > 3600000) cache.delete(k); }); }, 600000).unref();

/* ---------------- 预测快照服务端存储(预测台账) ----------------
 * 预测基于全市场公开数据、与用户无关,因此快照是"全局共享的预测台账":
 * 存到服务端后可跨设备/换浏览器保留,并支持长期(多快照)胜率统计。
 * 公开网站的写入接口必须防滥用:结构校验 + 容量上限 + 写入限流。 */
const PRED_FILE = path.join(process.env.QP_DATA_DIR || path.join(ROOT, '.cache'), 'pred-snapshots.json');
const PRED_MAX = 500;                       // 最多保留 500 个快照(约 1~2 年交易日)
const PRED_RATE = { win: 60000, max: 20, hits: [] };   // 写入限流:每分钟最多 20 次
let predList = null;
let predWriteChain = Promise.resolve();

function loadPredStore() {
  if (predList) return predList;
  try {
    const j = JSON.parse(fs.readFileSync(PRED_FILE, 'utf8'));
    predList = Array.isArray(j) ? j : (Array.isArray(j && j.snapshots) ? j.snapshots : []);
  } catch (e) { predList = []; }
  return predList;
}
function savePredStore() {
  const data = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), snapshots: predList || [] });
  predWriteChain = predWriteChain.then(() => new Promise(res => {
    try {
      fs.mkdirSync(path.dirname(PRED_FILE), { recursive: true });
      const tmp = PRED_FILE + '.tmp';
      fs.writeFile(tmp, data, err => {
        if (err) return res();
        fs.rename(tmp, PRED_FILE, () => res());   // 先写临时文件再改名:避免写入中断损坏台账
      });
    } catch (e) { res(); }
  }));
  return predWriteChain;
}
function predRateOk() {
  const now = Date.now();
  PRED_RATE.hits = PRED_RATE.hits.filter(t => now - t < PRED_RATE.win);
  if (PRED_RATE.hits.length >= PRED_RATE.max) return false;
  PRED_RATE.hits.push(now);
  return true;
}
/* 单个快照结构校验:只接受合法形态,拒绝脏数据污染台账 */
function validSnapshot(s) {
  if (!s || typeof s !== 'object') return false;
  if (typeof s.id !== 'string' || !s.id || s.id.length > 64) return false;
  if (typeof s.label !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.label)) return false;
  if (!Array.isArray(s.top) || !s.top.length) return false;
  return true;
}
function normalizeSnapshot(s) {
  return Object.assign({}, s, {
    top: s.top.slice(0, 100),                                  // 最多 100 只
    modelVersion: String(s.modelVersion || 'unknown').slice(0, 40),
    at: String(s.at || new Date().toISOString()).slice(0, 40)
  });
}
/* 合并:按 (label, modelVersion) 去重保留最新,再按日期倒序裁剪到上限 */
function mergePredSnapshots(incoming) {
  const list = loadPredStore();
  const byKey = new Map();
  const keyOf = s => s.label + '|' + (s.modelVersion || 'unknown');
  list.forEach(s => { if (validSnapshot(s)) byKey.set(keyOf(s), s); });
  let added = 0, updated = 0;
  (incoming || []).forEach(raw => {
    if (!validSnapshot(raw)) return;
    const s = normalizeSnapshot(raw);
    const k = keyOf(s);
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, s); added++; }
    else if (String(s.at || '') > String(prev.at || '')) { byKey.set(k, s); updated++; }
  });
  let merged = Array.from(byKey.values()).sort((a, b) => String(b.label).localeCompare(String(a.label)));
  if (merged.length > PRED_MAX) merged = merged.slice(0, PRED_MAX);
  predList = merged;
  return { merged, added, updated };
}
function deletePredSnapshot(id) {
  const list = loadPredStore();
  const next = list.filter(s => s.id !== id);
  const removed = list.length - next.length;
  predList = next;
  return removed;
}

/* 读取请求体(带大小上限,防止超大请求打爆内存) */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || 8 * 1024 * 1024;
    let size = 0; const chunks = [];
    req.on('data', d => {
      size += d.length;
      if (size > max) { reject(new Error('请求体过大')); try { req.destroy(); } catch (e) { } return; }
      chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------------- 全市场快照(消除冷启动 4.5s 等待) ----------------
 * 两道保险:
 *  1) 过期但仍在内存的数据「立即返回 + 后台刷新」(stale-while-revalidate):
 *     数据最多旧 2 分钟,用户不再为刷新等待;
 *  2) 落盘快照:进程重启后首屏可直接用(限 30 分钟内,避免展示过时行情)。
 */
const SNAP_DIR = process.env.QP_DATA_DIR || path.join(ROOT, '.cache');   // 可用 QP_DATA_DIR 隔离(测试实例用)
const SNAP_FILE = path.join(SNAP_DIR, 'market-all.json');
const SNAP_MAX_AGE = 30 * 60 * 1000;
let mallRefreshing = null;

function loadMallSnapshot() {
  try {
    const st = fs.statSync(SNAP_FILE);
    if (Date.now() - st.mtimeMs > SNAP_MAX_AGE) return null;
    const j = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
    if (!j || !Array.isArray(j.list) || !j.list.length) return null;
    return j;
  } catch (e) { return null; }
}
function saveMallSnapshot(data) {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    fs.writeFile(SNAP_FILE, JSON.stringify(data), () => { });
  } catch (e) { }
}
/* 后台刷新全市场缓存(同一时刻只跑一个,避免并发重复拉取 60 页) */
function refreshMallInBackground() {
  if (mallRefreshing) return mallRefreshing;
  mallRefreshing = fetchMarketAll()
    .then(d => { cache.set('mall', { t: Date.now(), data: d }); saveMallSnapshot(d); return d; })
    .catch(() => null)
    .finally(() => { mallRefreshing = null; });
  return mallRefreshing;
}
async function apiMarketAll() {
  const ttl = 120000;
  const c = cache.get('mall');
  if (c && Date.now() - c.t < ttl) return c.data;        // 新鲜:直接返回
  if (c) { refreshMallInBackground(); return c.data; }    // 略过期:先返回旧数据,后台刷新
  const snap = loadMallSnapshot();                        // 进程刚重启:用磁盘快照
  if (snap) {
    cache.set('mall', { t: Date.now() - ttl, data: snap }); // 标记为已过期,下次请求触发后台刷新
    refreshMallInBackground();
    return snap;
  }
  const data = await refreshMallInBackground();           // 完全无数据:只能等(仅首次)
  if (!data) { const old = cache.get('mall'); if (old) return old.data; throw new Error('全市场数据不可用'); }
  return data;
}

/* ---------------- 基础请求(多主机重试) ---------------- */
async function fetchText(url, headers, tries, hosts) {
  await acquire();
  try {
    const list = hosts || [null];
    let lastErr = null;
    for (const host of list) {
      for (let i = 0; i < (tries || 2); i++) {
        const u = host ? url.replace('{HOST}', host) : url;
        const ctrl = new AbortController();
        const tm = setTimeout(() => ctrl.abort(), 3500);
        try {
          const r = await fetch(u, { headers: headers || { 'User-Agent': UA, 'Referer': REFERER, 'Accept': '*/*' }, signal: ctrl.signal });
          clearTimeout(tm);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = Buffer.from(await r.arrayBuffer());
          return buf;
        } catch (e) {
          clearTimeout(tm);
          lastErr = e;
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
    throw lastErr || new Error('请求失败');
  } finally { release(); }
}
function fetchJSON(url, tries, hosts) {
  return fetchText(url, null, tries, hosts).then(buf => {
    const txt = buf.toString('utf8');
    const j = JSON.parse(txt.replace(/^cb\(/, '').replace(/\)\s*;?\s*$/, ''));
    if (j && j.code !== undefined && j.rc !== undefined && j.rc !== 0 && !j.data && !j.result && !j.QuotationCodeTable) throw new Error('数据源返回异常');
    return j;
  });
}

/* ---------------- 东方财富 secid ---------------- */
function secidOf(code) { return /^[69]/.test(code) ? '1.' + code : '0.' + code; }
function tencentSym(code) { return /^[69]/.test(code) ? 'sh' + code : 'sz' + code; }

const INDEX_LIST = [
  /* [代码, 名称, 东财secid, 腾讯代码, 市场标签(界面直接展示,缺失会显示 undefined)] */
  ['000001', '上证指数', '1.000001', 'sh000001', '沪市'], ['399001', '深证成指', '0.399001', 'sz399001', '深市'],
  ['399006', '创业板指', '0.399006', 'sz399006', '深市'], ['000688', '科创50', '1.000688', 'sh000688', '沪市'],
  ['000300', '沪深300', '1.000300', 'sh000300', '跨市场'], ['000905', '中证500', '1.000905', 'sh000905', '跨市场']
];

/* ---------------- 实时行情:东财(带镜像) → 腾讯兜底 ---------------- */
const QF = 'f2,f3,f4,f5,f6,f7,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f37,f38,f39,f41,f44,f57,f62,f71,f84,f85,f107,f111,f116,f117,f127,f177';
const EM_QUOTE_HOSTS = ['push2delay.eastmoney.com', 'push2.eastmoney.com', '93.push2.eastmoney.com'];

async function emQuotes(secids) {
  const url = 'https://{HOST}/api/qt/ulist.np/get?fltt=2&secids=' + secids.join(',') + '&fields=' + QF;
  const j = await fetchJSON(url, 2, EM_QUOTE_HOSTS);
  const diff = j && j.data && j.data.diff;
  if (!diff) throw new Error('行情数据不可用');
  return diff.map(d => ({
    code: String(d.f12), name: String(d.f14 || '').replace(/\s+/g, ''),
    price: d.f2 === '-' || d.f2 == null ? null : +d.f2,
    chg: d.f4 === '-' || d.f4 == null ? null : +d.f4,
    chgPct: d.f3 === '-' || d.f3 == null ? null : +d.f3,
    open: d.f17 === '-' ? null : +d.f17, high: d.f15 === '-' ? null : +d.f15,
    low: d.f16 === '-' ? null : +d.f16, prevClose: d.f18 === '-' ? null : +d.f18,
    volume: d.f5 === '-' ? 0 : +d.f5, amount: d.f6 === '-' ? 0 : +d.f6,
    turnover: d.f8 === '-' ? null : +d.f8, volRatio: d.f10 === '-' ? null : +d.f10,
    amplitude: d.f7 === '-' ? null : +d.f7,
    pe: d.f9 === '-' ? null : +d.f9, pb: d.f23 === '-' ? null : +d.f23,
    mcap: d.f20 === '-' ? null : +d.f20, fcap: d.f21 === '-' ? null : +d.f21,
    totalShares: d.f38 === '-' ? null : +d.f38, floatShares: d.f39 === '-' ? null : +d.f39,
    roe: d.f37 === '-' ? null : +d.f37, revYoY: d.f41 === '-' ? null : +d.f41,
    eps: d.f57 === '-' ? null : +d.f57, mainNet: d.f62 === '-' ? null : +d.f62,
    mainNetPct: d.f71 === '-' ? null : +d.f71
  }));
}

const GBK = new TextDecoder('gbk');
async function tencentQuotes(syms) {
  const url = 'https://qt.gtimg.cn/q=' + syms.join(',');
  const buf = await fetchText(url, { 'User-Agent': UA }, 3);
  const txt = GBK.decode(buf);
  const out = [];
  txt.split(';').forEach(line => {
    const m = line.match(/v_(\w+)="([^"]*)"/);
    if (!m) return;
    const f = m[2].split('~');
    const price = parseFloat(f[3]);
    out.push({
      code: String(f[2] || ''), name: String(f[1] || ''),
      price: price > 0 ? price : null,
      chg: parseFloat(f[31]) || 0, chgPct: parseFloat(f[32]) || 0,
      open: parseFloat(f[5]) || null, high: parseFloat(f[33]) || null,
      low: parseFloat(f[34]) || null, prevClose: parseFloat(f[4]) || null,
      volume: parseFloat(f[6]) || 0, amount: (parseFloat(f[37]) || 0) * 1e4,
      turnover: parseFloat(f[38]) || null, volRatio: parseFloat(f[49]) || null,
      amplitude: parseFloat(f[43]) || null,
      pe: parseFloat(f[39]) || null, pb: parseFloat(f[46]) || null,
      mcap: (parseFloat(f[45]) || 0) * 1e8, fcap: (parseFloat(f[44]) || 0) * 1e8,
      mainNet: null, mainNetPct: null
    });
  });
  return out.filter(q => /^\d{6}$/.test(q.code));
}

async function apiQuotes(codes) {
  const list = Array.isArray(codes) ? codes : String(codes || '').split(',').filter(Boolean);
  const out = [];
  let emOk = true;
  for (let i = 0; i < list.length; i += 60) {
    const secs = list.slice(i, i + 60).map(secidOf);
    try {
      const part = await cached('q:' + secs.join('+'), 2000, () => emQuotes(secs));
      out.push(...part);
    } catch (e) { emOk = false; break; }
  }
  // 质量校验:东财限流时会返回"静态快照"(动态字段全 0),此时切换腾讯兜底
  const goodPrice = out.filter(x => x.price != null && x.price > 0).length;
  if (!(emOk && goodPrice >= Math.min(list.length, 20))) {
    const tx = [];
    for (let i = 0; i < list.length; i += 50) {
      const part = await cached('tq:' + list.slice(i, i + 50).join('+'), 2000, () => tencentQuotes(list.slice(i, i + 50).map(tencentSym)));
      tx.push(...part);
    }
    return tx;
  }
  return out;
}

async function apiIndices() {
  const shape = (code, name, market, d) => ({
    code, name, market,
    quote: { price: d ? d.price : null, chg: d ? d.chg : null, chgPct: d ? d.chgPct : null, amount: d ? d.amount : null, volume: d ? d.volume : null }
  });
  try {
    const qs = await cached('q:idx', 3000, () => emQuotes(INDEX_LIST.map(x => x[2])));
    if (qs.length >= 6) {
      return INDEX_LIST.map(([code, name, , , market]) => shape(code, name, market, qs.find(x => x.code === code)));
    }
    throw new Error('指数数据不可用');
  } catch (e) {
    const qs = await cached('tq:idx', 2000, () => tencentQuotes(INDEX_LIST.map(x => x[3])));
    return INDEX_LIST.map(([code, name, , , market]) => shape(code, name, market, qs.find(x => x.code === code)));
  }
}

/* ---------------- K线:东财 → 腾讯兜底(带熔断) ---------------- */
const EM_KLINE_HOSTS = ['push2his.eastmoney.com', '92.push2his.eastmoney.com', '48.push2his.eastmoney.com'];
let emKlineFail = 0, emKlineBrokenUntil = 0;
function emKlineBroken() { return Date.now() < emKlineBrokenUntil; }
function markEmKlineOk() { emKlineFail = 0; }
function markEmKlineFail() { emKlineFail++; if (emKlineFail >= 3) { emKlineBrokenUntil = Date.now() + 10 * 60 * 1000; console.log('[kline] 东财K线连续失败,熔断 10 分钟,切腾讯兜底'); } }
function emKline(code, klt, fqt, lmt) {
  const url = 'https://{HOST}/api/qt/stock/kline/get?secid=' + secidOf(code) +
    '&klt=' + klt + '&fqt=' + fqt + '&lmt=' + lmt + '&end=20500101&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
  return fetchJSON(url, 1, EM_KLINE_HOSTS).then(j => {
    const data = j && j.data;
    if (!data || !data.klines || !data.klines.length) throw new Error('K线数据不可用:' + code);
    return data.klines.map(line => {
      const p = line.split(',');
      return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], volume: +p[5], amount: +p[6], amplitude: +p[7], chgPct: +p[8], chg: +p[9], turnover: +p[10], source: 'em' };
    });
  });
}
async function tencentKline(code, klt, lmt) {
  const period = klt === 102 ? 'week' : klt === 103 ? 'month' : klt === 5 ? 'm5' : klt === 15 ? 'm15' : klt === 30 ? 'm30' : klt === 60 ? 'm60' : 'day';
  if (klt === 5 || klt === 15 || klt === 30 || klt === 60) {
    /* 分钟线:fqkline/get 已下线分钟周期(返回 bad params),改用 mkline 接口。
     * web.ifzq.gtimg.cn 部分网络 DNS 解析失败,准备多个等价域名依次尝试;
     * mkline 返回行格式:[ "202608281500" 或 [时间,..], open, close, high, low, volume, ... ] */
    const mk = klt === 5 ? 'm5' : klt === 15 ? 'm15' : klt === 30 ? 'm30' : 'm60';
    let lastErr = null;
    for (const base of ['https://ifzq.gtimg.cn', 'https://proxy.finance.qq.com/ifzqgtimg', 'https://web.ifzq.gtimg.cn']) {
      try {
        const url = base + '/appstock/app/kline/mkline?param=' + tencentSym(code) + ',' + mk + ',,' + lmt;
        const j = await fetchJSON(url, 1);
        const d = j && j.data && j.data[tencentSym(code)];
        const arr = d ? (d[mk] || []) : null;
        if (!arr || !arr.length) throw new Error('腾讯分钟K线不可用:' + code);
        return arr.map(row => {
          const t = Array.isArray(row[0]) ? row[0][0] : row[0]; // 兼容 [time,...] 嵌套格式
          const s = String(t);
          // 202608281500 → 2026-08-28 15:00(分钟线);日/周/月线直接用日期字符串
          const date = /^\d{12}$/.test(s) ? s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8) + ' ' + s.slice(8, 10) + ':' + s.slice(10, 12) : s;
          return {
            date: date, open: +row[1], close: +row[2], high: +row[3], low: +row[4],
            volume: +(row[5] || 0), amount: Math.round(+row[2] * +(row[5] || 0) * 100),
            amplitude: 0, chgPct: 0, chg: 0, turnover: 0, source: 'tx'
          };
        });
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('腾讯分钟K线不可用:' + code);
  }
  // 日/周/月线:fqkline/get;web.ifzq 部分网络 DNS 解析失败,多域名依次尝试
  let lastErr = null;
  for (const base of ['https://ifzq.gtimg.cn', 'https://proxy.finance.qq.com/ifzqgtimg', 'https://web.ifzq.gtimg.cn']) {
    try {
      const url = base + '/appstock/app/fqkline/get?param=' + tencentSym(code) + ',' + period + ',,,' + lmt + ',qfq';
      const j = await fetchJSON(url, 1);
      const d = j && j.data && j.data[tencentSym(code)];
      const arr = d ? (d['qfq' + period] || d[period]) : null;
      if (!arr || !arr.length) throw new Error('腾讯K线不可用:' + code);
      return arr.map(row => ({
        date: row[0], open: +row[1], close: +row[2], high: +row[3], low: +row[4],
        volume: +(row[5] || 0), amount: Math.round(+row[2] * +(row[5] || 0) * 100),
        amplitude: 0, chgPct: 0, chg: 0, turnover: 0, source: 'tx'
      }));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('腾讯K线不可用:' + code);
}
async function apiKline(code, klt, fqt, lmt) {
  klt = +(klt || 101); fqt = +(fqt || 1); lmt = +(lmt || 320);
  let bars, source = 'tx';
  if (!emKlineBroken()) {
    try { bars = await emKline(code, klt, fqt, lmt); source = 'em'; markEmKlineOk(); }
    catch (e) { markEmKlineFail(); }
  }
  if (!bars) {
    try { bars = await tencentKline(code, klt, lmt); }
    catch (e2) { const err = new Error('未获取到K线数据(代码可能不存在或数据源均不可用):' + code); err.status = 404; throw err; }
  }
  return { name: '', code: code, klt: klt, source: source, bars: bars };
}

/* ---------------- 交易日历(真实交易日,含调休) ----------------
 * 由「上证指数日K」推导:指数K线存在的日期即真实交易日,可正确反映春节/国庆等休市,
 * 优于「周一~周五」启发式(后者会把国庆假期当成交易日,导致预测快照日期与复盘周期错位)。
 * 指数K线尚未覆盖的未来日期由交易所公布的休市表补齐;已过去的日期一律以K线为准(自校正)。 */
const CAL_TTL = 3600000;                                       // 1 小时(收盘后自动包含当日新K线)
const CAL_HOSTS = ['https://ifzq.gtimg.cn', 'https://proxy.finance.qq.com/ifzqgtimg', 'https://web.ifzq.gtimg.cn'];
/* 上交所《2026年部分节假日休市安排》(2025-12-22 公告)中尚未到来的休市工作日:
 * 中秋 9/25(五);国庆 10/1(四)、10/2(五)、10/5(一)、10/6(二)、10/7(三)——10/3、10/4 为周末。 */
const FUTURE_HOLIDAYS = ['2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'];

async function fetchTradingCalendar() {
  let lastErr = null;
  for (const base of CAL_HOSTS) {
    try {
      const j = await fetchJSON(base + '/appstock/app/fqkline/get?param=sh000001,day,,,800,qfq', 1);
      const d = j && j.data && j.data.sh000001;
      const arr = d ? (d.qfqday || d.day) : null;
      if (!arr || !arr.length) throw new Error('指数K线为空');
      const days = arr.map(x => String(x[0])).filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
      if (days.length < 100) throw new Error('指数K线样本过少:' + days.length);
      return { days: days, last: days[days.length - 1], futureHolidays: FUTURE_HOLIDAYS, source: base.replace('https://', ''), count: days.length };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('交易日历不可用');
}
function apiCalendar() { return cached('cal', CAL_TTL, fetchTradingCalendar); }

/* ---------------- 资金流(东财,不可用则空) ---------------- */
async function apiFflow(code, days) {
  days = +(days || 20);
  const url = 'https://{HOST}/api/qt/stock/fflow/kline/get?lmt=' + days + '&klt=101&secid=' + secidOf(code) +
    '&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65';
  const j = await fetchJSON(url, 2, EM_KLINE_HOSTS);
  const kl = j && j.data && j.data.klines;
  if (!kl) return [];
  return kl.map(line => {
    const p = line.split(',');
    return { date: p[0], mainNet: +p[1], smallNet: +p[2], midNet: +p[3], bigNet: +p[4], superNet: +p[5], mainPct: +p[6] || 0, bigPct: +p[8] || 0 };
  });
}

/* ---------------- 财务(F10) ---------------- */
async function apiFin(code) {
  const secu = /^6/.test(code) ? code + '.SH' : code + '.SZ';
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=ALL&filter=' +
    encodeURIComponent('(SECUCODE="' + secu + '")') + '&pageNumber=1&pageSize=40';
  const j = await fetchJSON(url, 3);
  const rows = j && j.result && j.result.data;
  if (!rows || !rows.length) return { annual: [], quarterly: [], growYears: 0 };
  const seen = new Map();
  rows.forEach(r => { const d = String(r.REPORTDATE || '').slice(0, 10); if (d && !seen.has(d)) seen.set(d, r); });
  const sorted = Array.from(seen.values()).sort((a, b) => String(b.REPORTDATE) < String(a.REPORTDATE) ? -1 : 1);
  const annual = [], quarterly = [];
  sorted.forEach(r => {
    const it = {
      date: String(r.REPORTDATE || '').slice(0, 10), quarter: r.QDATE || '', reportType: String(r.DATATYPE || ''),
      revenue: r.TOTAL_OPERATE_INCOME == null ? null : +(+r.TOTAL_OPERATE_INCOME).toFixed(2),
      revenueYoY: r.YSTZ == null ? null : +(+r.YSTZ).toFixed(2),
      netProfit: r.PARENT_NETPROFIT == null ? null : +(+r.PARENT_NETPROFIT).toFixed(2),
      netProfitYoY: r.SJLTZ == null ? null : +(+r.SJLTZ).toFixed(2),
      roe: r.WEIGHTAVG_ROE == null ? null : +(+r.WEIGHTAVG_ROE).toFixed(2),
      grossMargin: r.XSMLL == null ? null : +(+r.XSMLL).toFixed(2),
      netMargin: (r.TOTAL_OPERATE_INCOME && r.PARENT_NETPROFIT) ? +(+r.PARENT_NETPROFIT / +r.TOTAL_OPERATE_INCOME * 100).toFixed(2) : null,
      eps: r.BASIC_EPS == null ? null : +(+r.BASIC_EPS).toFixed(2),
      kfEps: r.DEDUCT_BASIC_EPS == null ? null : +(+r.DEDUCT_BASIC_EPS).toFixed(2),
      bps: r.BPS == null ? null : +(+r.BPS).toFixed(2),
      ocfps: r.MGJYXJJE == null ? null : +(+r.MGJYXJJE).toFixed(2),
      dividend: r.ASSIGNDSCRPT || ''
    };
    if (String(r.REPORTDATE).indexOf('-12-31') >= 0) annual.push(Object.assign({ year: +String(r.REPORTDATE).slice(0, 4) }, it));
    else quarterly.push(it);
  });
  annual.sort((a, b) => a.year - b.year);
  let growYears = 0;
  for (let i = 1; i < annual.length; i++) { if (annual[i].netProfitYoY != null && annual[i].netProfitYoY > 0) growYears++; else break; }
  return { annual, quarterly: quarterly.slice(0, 12), growYears };
}

/* ---------------- 新闻 ---------------- */
async function apiNews(code, kw, n) {
  n = +(n || 10);
  const param = {
    uid: '', keyword: kw || code, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: n, preTag: '<em>', postTag: '</em>' } }
  };
  const url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=' + encodeURIComponent(JSON.stringify(param));
  const j = await fetchJSON(url, 3);
  const list = j && j.result && j.result.cmsArticleWebOld;
  if (!list) return [];
  const clean = s => String(s || '').replace(/<em>/g, '').replace(/<\/em>/g, '').replace(/<[^>]+>/g, '').trim();
  return list.map(x => ({
    date: String(x.date || '').slice(0, 10), time: String(x.date || '').slice(11, 16),
    title: clean(x.title), source: x.mediaName || '东方财富', url: x.url || ''
  }));
}

/* ---------------- 分红 ---------------- */
async function apiDividend(code) {
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=' +
    encodeURIComponent('(SECURITY_CODE="' + code + '")') + '&pageNumber=1&pageSize=12&sortTypes=-1&sortColumns=EX_DIVIDEND_DATE';
  try {
    const j = await fetchJSON(url, 2);
    const rows = j && j.result && j.result.data;
    if (!rows || !rows.length) return [];
    return rows.map(r => {
      const plan = String(r.IMPL_PLAN_PROFILE || r.PLAN_NOTICE || '').trim();
      let per10 = null;
      const m = plan.match(/派([\d.]+)元/);
      if (m) per10 = +m[1];
      else if (r.PRETAX_BONUS_RMB != null && +r.PRETAX_BONUS_RMB > 0) per10 = +(r.PRETAX_BONUS_RMB * 10).toFixed(2);
      return {
        year: String(r.REPORT_DATE || '').slice(0, 4),
        reportDate: String(r.REPORT_DATE || '').slice(0, 10),
        plan: plan || (per10 != null ? '每10股派' + per10 + '元(含税)' : '方案详见公告'),
        per10: per10,
        exDate: String(r.EX_DIVIDEND_DATE || '').slice(0, 10)
      };
    });
  } catch (e) { return []; }
}

/* ---------------- 搜索 ---------------- */
/* 东方财富搜索接口的 token 是其网页前端公开使用的固定值,非私钥;
   如需更换可通过环境变量 EM_SEARCH_TOKEN 覆盖,避免硬编码。 */
const EM_SEARCH_TOKEN = process.env.EM_SEARCH_TOKEN || 'D43BF722C8E33BDC906FB84D85E326E8';
async function apiSearch(q) {
  const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent(q) +
    '&type=14&token=' + EM_SEARCH_TOKEN + '&count=10';
  const j = await fetchJSON(url, 2);
  const arr = j && j.QuotationCodeTable && j.QuotationCodeTable.Data;
  if (!arr) return [];
  // 仅保留沪深A股(6/0/3 开头);可转债(11/12)、基金(5/1)、北交所(8/4/9)等排除
  return arr.filter(d => /^[603]\d{5}$/.test(d.Code || '')).map(d => ({
    code: d.Code, name: String(d.Name || '').replace(/\s+/g, ''),
    market: d.MktNum == 1 ? '沪' : d.MktNum == 0 ? '深' : String(d.MktNum || ''), type: d.SecurityTypeName || ''
  }));
}

/* ---------------- 全市场列表(东财 clist,约 5900 只) ---------------- */
const FS_ALL = encodeURIComponent('m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048');
const CLIST_HOSTS = ['push2delay.eastmoney.com', '93.push2.eastmoney.com', 'push2.eastmoney.com'];

function mapClist(d) {
  const num = v => (v === '-' || v == null) ? null : +v;
  return {
    code: String(d.f12), name: String(d.f14 || '').replace(/\s+/g, ''),
    market: d.f13 === 1 ? '沪' : '深',
    industry: d.f100 || '',
    price: num(d.f2), chg: num(d.f4), chgPct: num(d.f3),
    open: num(d.f17), high: num(d.f15), low: num(d.f16), prevClose: num(d.f18),
    volume: num(d.f5) || 0, amount: num(d.f6) || 0,
    turnover: num(d.f8), volRatio: num(d.f10), amplitude: num(d.f7),
    pe: num(d.f9), pb: num(d.f23), mcap: num(d.f20), fcap: num(d.f21),
    totalShares: num(d.f38), floatShares: num(d.f39),
    roe: num(d.f37), revYoY: num(d.f41), eps: num(d.f57),
    mainNet: num(d.f62), mainNetPct: num(d.f71)
  };
}
async function emClist(pn, pz, fid, po, fields) {
  const url = 'https://{HOST}/api/qt/clist/get?pn=' + pn + '&pz=' + pz + '&po=' + po + '&np=1&fltt=2&invt=2&fid=' + fid + '&fs=' + FS_ALL + '&fields=' + fields;
  const j = await fetchJSON(url, 2, CLIST_HOSTS);
  return (j && j.data) || { total: 0, diff: [] };
}
async function fetchMarketAll() {
  const fields = 'f12,f14,f2,f3,f4,f5,f6,f7,f8,f9,f10,f13,f15,f16,f17,f18,f20,f21,f23,f37,f38,f39,f41,f44,f57,f62,f71,f84,f85,f100';
  let first;
  try {
    first = await emClist(1, 100, 'f3', 1, fields);
  } catch (e) {
    const old = cache.get('mall');
    if (old) return old.data; // 拉取失败时返回上次缓存
    throw e;
  }
  const total = first.total || 0;
  const pages = Math.ceil(total / 100);
  const diffs = [first.diff || []];
  const CONC = 12;
  for (let pn = 2; pn <= pages; pn += CONC) {
    const arr = [];
    for (let i = 0; i < CONC && pn + i <= pages; i++) arr.push(pn + i);
    const parts = await Promise.all(arr.map(p => emClist(p, 100, 'f3', 1, fields).then(d => d.diff || []).catch(() => [])));
    parts.forEach(d => diffs.push(d));
  }
  const list = diffs.flat().map(mapClist).filter(x => x.code && /^\d{6}$/.test(x.code));
  return { total, list };
}

async function apiRanksAll() {
  const conf = { up: ['f3', 1], down: ['f3', 0], amount: ['f6', 1], turnover: ['f8', 1], volratio: ['f10', 1] };
  const fields = 'f12,f14,f2,f3,f4,f5,f6,f8,f10,f13,f15,f16,f17,f18,f20,f21,f23,f37,f38,f39,f41,f44,f57,f62,f71,f100';
  const keys = Object.keys(conf);
  /* 5 个榜单 × 2 页 = 10 个上游请求「一次性并发」。
     此前每个榜单的两页是串行 await,等于两轮往返,耗时接近翻倍(实测 ~980ms → ~500ms)。 */
  const parts = await Promise.all(keys.map(k => (async () => {
    const [d1, d2] = await Promise.all([
      emClist(1, 100, conf[k][0], conf[k][1], fields).then(d => (d.diff || []).map(mapClist)).catch(() => []),
      emClist(2, 100, conf[k][0], conf[k][1], fields).then(d => (d.diff || []).map(mapClist)).catch(() => [])
    ]);
    return d1.concat(d2); // Top 200
  })()));
  const out = {};
  keys.forEach((k, i) => { out[k] = parts[i]; });
  return out;
}

async function apiOverview() {
  const all = await apiMarketAll();
  let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0, amount = 0, mainNet = 0;
  all.list.forEach(s => {
    const c = s.chgPct;
    if (c == null) { flat++; return; }
    if (c > 0) up++; else if (c < 0) down++; else flat++;
    const is20cm = /^(300|301|688)/.test(s.code);
    const cap = is20cm ? 19.7 : 9.7;
    if (c >= cap) limitUp++;
    if (c <= -cap) limitDown++;
    amount += s.amount || 0;
    mainNet += s.mainNet || 0;
  });
  const total = up + down + flat;
  return {
    total: all.total, up, down, flat, limitUp, limitDown,
    /* upPct/downPct:界面 KPI 直接展示"占比 X%",缺这两个字段会显示 "占比 undefined%"(已修复的真实缺陷) */
    upPct: total ? +(up / total * 100).toFixed(1) : 0,
    downPct: total ? +(down / total * 100).toFixed(1) : 0,
    amount, mainNet, breadth: total ? +(up / total * 100).toFixed(1) : 0
  };
}

/* ---------------- HTTP ---------------- */
async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;
  const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  /* 统一响应:大于 1KB 的 JSON 走 gzip(全市场 2.5MB → 约 200KB,首屏显著提速) */
  const send = (code, obj, cacheCtl) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheCtl || 'no-store',
      'Vary': 'Accept-Encoding'
    };
    if (acceptsGzip && body.length >= 1024) {
      zlib.gzip(body, (err, gz) => {
        if (err) { headers['Content-Length'] = body.length; res.writeHead(code, headers); return res.end(body); }
        headers['Content-Encoding'] = 'gzip';
        headers['Content-Length'] = gz.length;
        res.writeHead(code, headers);
        res.end(gz);
      });
      return;
    }
    headers['Content-Length'] = body.length;
    res.writeHead(code, headers);
    res.end(body);
  };
  try {
    if (p === '/api/ping') return send(200, { ok: true, mode: 'real', source: 'eastmoney+tencent', time: new Date().toLocaleString('zh-CN') });
    if (p === '/api/quote') {
      const raw = String(u.searchParams.get('codes') || '');
      // 去重 + 仅保留 6 位数字代码;空/全非法参数返回空数组
      const codes = [...new Set(raw.split(',').map(s => s.trim()).filter(c => /^\d{6}$/.test(c)))];
      if (!codes.length) return send(200, { ok: true, data: [] });
      return send(200, { ok: true, data: await apiQuotes(codes.join(',')) });
    }
    // 全市场数据服务端已缓存 120s;允许浏览器复用 60s,重复进入页面不再重传 2.5MB
    if (p === '/api/market-all') return send(200, { ok: true, data: await apiMarketAll() }, 'public, max-age=60');
    if (p === '/api/ranks') {
      // 缓存 25s:前端每 10s 轮询一次,此前 8s TTL 导致每次轮询都穿透缓存重发 10 个上游请求
      const data = await cached('ranks', 25000, apiRanksAll);
      return send(200, { ok: true, data });
    }
    if (p === '/api/overview') {
      const data = await cached('ov', 15000, apiOverview);
      return send(200, { ok: true, data });
    }
    if (p === '/api/indices') return send(200, { ok: true, data: await apiIndices() });
    /* 交易日历:前端用于判定"生效交易日/是否锁定",避免把节假日当交易日 */
    if (p === '/api/calendar') {
      const data = await apiCalendar();
      return send(200, { ok: true, data }, 'public, max-age=600');
    }
    /* 预测快照台账:GET 读取全部;POST 合并(按 label+modelVersion 去重保留最新);del 删除单条 */
    if (p === '/api/snapshots') {
      if (req.method === 'GET') {
        return send(200, { ok: true, data: { snapshots: loadPredStore(), count: loadPredStore().length } });
      }
      if (req.method === 'POST') {
        if (!predRateOk()) return send(429, { ok: false, message: '写入过于频繁,请稍后再试' });
        let body;
        try { body = await readBody(req, 4 * 1024 * 1024); }
        catch (e) { return send(413, { ok: false, message: '请求体过大' }); }
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (e) { return send(400, { ok: false, message: '无效的 JSON' }); }
        const incoming = Array.isArray(payload) ? payload : payload.snapshots;
        if (!Array.isArray(incoming)) return send(400, { ok: false, message: '缺少 snapshots 数组' });
        if (incoming.length > 60) return send(400, { ok: false, message: '单次最多提交 60 条快照' });
        const r = mergePredSnapshots(incoming);
        await savePredStore();
        return send(200, { ok: true, data: { snapshots: r.merged, count: r.merged.length, added: r.added, updated: r.updated } });
      }
      return send(405, { ok: false, message: '不支持的方法' });
    }
    if (p === '/api/snapshots/delete' && req.method === 'POST') {
      if (!predRateOk()) return send(429, { ok: false, message: '写入过于频繁,请稍后再试' });
      let body;
      try { body = await readBody(req, 64 * 1024); }
      catch (e) { return send(413, { ok: false, message: '请求体过大' }); }
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch (e) { return send(400, { ok: false, message: '无效的 JSON' }); }
      const id = String(payload.id || '');
      if (!id) return send(400, { ok: false, message: '缺少 id' });
      const removed = deletePredSnapshot(id);
      await savePredStore();
      return send(200, { ok: true, data: { removed: removed, snapshots: loadPredStore() } });
    }
    if (p === '/api/kline') {
      const code = String(u.searchParams.get('code') || '').trim();
      const klt = +(u.searchParams.get('klt') || 101);
      const fqt = +(u.searchParams.get('fqt') || 1);
      const lmt = +(u.searchParams.get('lmt') || 320);
      // 参数校验:非法参数直接 400,而不是让上游失败后误报"数据源不可用"(500)
      if (!/^\d{6}$/.test(code)) return send(400, { ok: false, message: '无效的股票代码:' + code });
      if (![5, 15, 30, 60, 101, 102, 103].includes(klt)) return send(400, { ok: false, message: '无效的K线周期 klt:' + klt });
      if (![0, 1, 2].includes(fqt)) return send(400, { ok: false, message: '无效的复权类型 fqt:' + fqt });
      if (!Number.isFinite(lmt) || lmt < 1 || lmt > 800) return send(400, { ok: false, message: '无效的数量 lmt(1-800):' + lmt });
      // 缓存键必须包含 lmt:否则先取 30 根再取 320 根时会命中同一缓存,返回错误的历史长度
      const data = await cached('k:' + code + ':' + klt + ':' + fqt + ':' + lmt, 300000,
        () => apiKline(code, klt, fqt, lmt));
      return send(200, { ok: true, data });
    }
    if (p === '/api/fflow') {
      const code = u.searchParams.get('code');
      try { const data = await cached('ff:' + code, 30000, () => apiFflow(code, u.searchParams.get('days') || 20)); return send(200, { ok: true, data }); }
      catch (e) { return send(200, { ok: true, data: [] }); }
    }
    if (p === '/api/fin') {
      const code = u.searchParams.get('code');
      try {
        const data = await cached('fin:' + code, 600000, () => apiFin(code));
        return send(200, { ok: true, data });
      } catch (e) {
        const old = cache.get('fin:' + code);
        if (old) return send(200, { ok: true, data: old.data }); // 返回上次成功缓存
        return send(200, { ok: true, data: { annual: [], quarterly: [], growYears: 0 } });
      }
    }
    if (p === '/api/news') {
      const code = u.searchParams.get('code');
      try {
        const data = await cached('news:' + code, 300000, () => apiNews(code, u.searchParams.get('kw'), u.searchParams.get('n') || 10));
        return send(200, { ok: true, data });
      } catch (e) {
        const old = cache.get('news:' + code);
        if (old) return send(200, { ok: true, data: old.data });
        return send(200, { ok: true, data: [] });
      }
    }
    if (p === '/api/dividend') {
      const code = u.searchParams.get('code');
      const data = await cached('div:' + code, 1800000, () => apiDividend(code));
      return send(200, { ok: true, data });
    }
    if (p === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim();
      if (!q) return send(400, { ok: false, message: '缺少搜索词' });
      if (q.length > 30) return send(400, { ok: false, message: '搜索词过长' });
      try {
        const data = await cached('s:' + q, 60000, () => apiSearch(q));
        return send(200, { ok: true, data });
      } catch (e) {
        // 上游限流/异常时降级为空结果,而不是 500
        return send(200, { ok: true, data: [] });
      }
    }
    if (p.startsWith('/api/')) return send(404, { ok: false, message: '未知接口' });

    /* 静态资源路径解析:先解码再规范化,然后确认结果确实落在 ROOT 之内。
     * 不能只用 fp.startsWith(ROOT) 判断:字符串前缀会把"兄弟路径"误判为合法,
     * 例如 ROOT=...\quantpick 时,...\quantpick-update.zip 也"以 ROOT 开头",
     * 于是 /..%2fquantpick-update.zip 就能读到应用目录之外的文件。
     * 正确做法:要求 fp === ROOT,或以 ROOT + 路径分隔符 开头。 */
    let fp;
    try {
      fp = path.normalize(path.join(ROOT, decodeURIComponent(p)));
    } catch (e) {
      /* 畸形百分号编码(如 "/%")会抛 URIError;明确返回 400 而不是落到通用 500 */
      return send(400, { ok: false, message: '非法请求路径' });
    }
    if (fp !== ROOT && !fp.startsWith(ROOT + path.sep)) return send(403, { ok: false, message: '禁止访问' });
    /* 不对外提供:服务器源码 / 桌面构建脚本 / 部署脚本 / 版本库元数据 / 本地密钥与配置。
     * .git 必须挡掉 —— 否则可拉取 .git/objects/* 还原完整提交历史(含曾误提交后删除的文件)。 */
    if (/(^|[\\/])server\.js$|(^|[\\/])_smoke([\\/]|$)|(^|[\\/])deploy([\\/]|$)|(^|[\\/])dist-desktop([\\/]|$)|(^|[\\/])\.cache([\\/]|$)|(^|[\\/])\.git([\\/]|$)|(^|[\\/])\.env(\..*)?$|(^|[\\/])\.npmrc$|\.(bat|ps1|sh|zip|pem|key|pfx|p12|crt|jks|keystore)$/i.test(fp)) {
      return send(403, { ok: false, message: '禁止访问' });
    }
    if (p === '/') fp = path.join(ROOT, 'index.html');
    fs.stat(fp, (err, st) => {
      if (err || !st) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
      if (st.isDirectory()) fp = path.join(fp, 'index.html');   // 目录默认页(如 /website/ → /website/index.html)
      fs.stat(fp, (err2, st2) => {
        if (err2 || !st2 || !st2.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
        const ext = path.extname(fp).toLowerCase();
        /* ETag:内容指纹(大小+修改时间)。命中则返回 304,浏览器直接用本地缓存,零传输 */
        const etag = 'W/"' + st2.size.toString(16) + '-' + st2.mtimeMs.toString(16) + '"';
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { 'ETag': etag, 'Cache-Control': CACHE_CTL(ext, p) });
          return res.end();
        }
        /* 文本类资源(HTML/CSS/JS/SVG/JSON)按需 gzip:vendor/echarts.min.js 约 1MB → 约 330KB */
        const isText = /\.(html|css|js|json|svg|md|txt)$/.test(ext);
        const baseHeaders = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': CACHE_CTL(ext, p), 'ETag': etag, 'Vary': 'Accept-Encoding' };
        if (isText && st2.size >= 1024 && acceptsGzip) {
          baseHeaders['Content-Encoding'] = 'gzip';
          res.writeHead(200, baseHeaders);
          const gz = zlib.createGzip({ level: 6 });
          const rs = fs.createReadStream(fp);
          rs.on('error', () => { try { res.end(); } catch (e) { } });
          gz.on('error', () => { try { res.end(); } catch (e) { } });
          rs.pipe(gz).pipe(res);
          return;
        }
        baseHeaders['Content-Length'] = st2.size;
        res.writeHead(200, baseHeaders);
        fs.createReadStream(fp).pipe(res);
      });
    });
  } catch (e) {
    send(e.status || 500, { ok: false, message: e.message || '服务器错误' });
  }
}

const server = http.createServer(handle);

/* 端口被占用(如已有一个 QuantPick 在运行)时给出友好提示,桌面版自动打开已有实例 */
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('[QuantPick] 端口 ' + PORT + ' 已被占用(可能已有实例在运行)。请关闭已运行的窗口后重试,或改用 PORT 环境变量指定其他端口。');
    if (IS_SEA && process.platform === 'win32') {
      try { require('child_process').exec('start "" http://127.0.0.1:' + PORT); } catch (e2) { }
    }
    process.exit(1);
  }
  throw e;
});

/* 本地独立运行;云函数/Serverless 平台可 require 本文件复用 handle */
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('============================================');
    console.log('  QuantPick 数据服务已启动');
    console.log('  主数据源:东方财富 · 兜底:腾讯财经');
    console.log('  访问: http://127.0.0.1:' + PORT);
    console.log('============================================');
    /* 启动预热:服务起来后立即在后台拉一次全市场(约 4s),这样首位用户打开页面时缓存已就绪,不必干等 */
    setTimeout(() => { refreshMallInBackground().catch(() => null); }, 1500).unref();
  });
}

module.exports = { handle: handle, startServer: () => server.listen(PORT, () => {}) };

/* 桌面版(SEA):启动后自动打开浏览器 */
if (IS_SEA && process.platform === 'win32') {
  setTimeout(() => {
    try { require('child_process').exec('start "" http://127.0.0.1:' + PORT); } catch (e) { }
  }, 1200);
}
