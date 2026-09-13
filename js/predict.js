/* ============================================================================
 * QuantPick — AI 预测选股引擎 (透明规则概率模型 v1)
 * 样本:全 A 股(东方财富真实数据,约 5000+ 只,与「行情中心」同一市场池)
 *
 * 预测目标(参照《AI复盘提示词》):
 *   - 上涨概率 P5/P10/P20:未来 5/10/20 个交易日收益超过阈值(2%/5%/8%)的概率
 *   - 预期收益率 R5/R10/R20
 *   - 超额收益(相对大盘指数动量)
 *   - 预期最大回撤(下行风险)
 *   - 置信度(数据完整度)
 *
 * 综合评分 = 35%×上涨概率 + 30%×预期收益 + 15%×超额收益 + 10%×行业强度 - 10%×风险
 * (权重可配置)
 *
 * 原则:
 *   - 仅使用"预测时点已公开"的数据(行情/行业/市场环境),K线懒加载增强技术特征
 *   - 每次预测保存快照(localStorage),收盘后可对照实际表现复盘(命中率/误差)
 *   - 规则引擎,非机器学习;不承诺收益,不构成投资建议
 * ========================================================================== */
(function (root) {
  'use strict';
  const D = root.QP.data;

  const MODEL_VERSION = 'QP-PRED-1.0';
  const MODEL_DESC = '透明规则概率引擎 · 全市场特征 + 行业/市场环境 + 概率校准';
  const SNAP_VERSION = 2;                    // 快照格式版本:v1 旧格式缺 pos/risks/ret20,需重建
  const WEIGHTS = { prob: 0.35, ret: 0.30, excess: 0.15, sector: 0.10, risk: 0.10 };
  const TH = { p5: 2, p10: 5, p20: 8 };          // 上涨事件阈值(%)

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  function round1(v) { return Math.round(v * 10) / 10; }

  /* ---------------- 市场环境 ---------------- */
  function marketRegime() {
    const R = root.QP.real ? root.QP.real.store : null;
    const ov = (R && R.overview) || {};
    const idx = (R && R.indices && R.indices.length) ? R.indices : (D.buildIndices() || []);
    const sh = idx.find(x => x.code === '000001') || idx[0] || {};
    const shChg = (sh.quote && sh.quote.chgPct != null) ? sh.quote.chgPct : 0;
    const breadth = ov.breadth != null ? ov.breadth : 50;
    const limitUp = ov.limitUp || 0, limitDown = ov.limitDown || 0;
    let regime = '震荡';
    if (shChg > 1.2 && breadth > 55 && limitUp > limitDown * 2) regime = '强势';
    else if (shChg < -1.2 && breadth < 45) regime = '弱势';
    else if (limitDown > 30) regime = '普跌';
    return {
      shChg: +shChg.toFixed(2), breadth: +breadth.toFixed(1),
      limitUp: limitUp, limitDown: limitDown, amount: ov.amount || 0, regime: regime
    };
  }

  /* ---------------- 行业统计(全市场) ---------------- */
  function sectorStats() {
    const list = D.buildAll().list;
    const map = {};
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const c = s.quote && s.quote.chgPct;
      if (c == null || !s.industry) continue;
      let m = map[s.industry];
      if (!m) { m = map[s.industry] = { name: s.industry, chgSum: 0, count: 0, up: 0, amount: 0 }; }
      m.chgSum += c; m.count++; m.amount += s.quote.amount || 0;
      if (c > 0) m.up++;
    }
    const arr = [];
    Object.keys(map).forEach(k => {
      const m = map[k];
      m.avgChg = +(m.chgSum / m.count).toFixed(2);
      m.upRatio = m.count ? +((m.up / m.count) * 100).toFixed(1) : 0;
      if (m.count >= 3) arr.push(m);
    });
    return arr;
  }
  const _sectorCache = { at: 0, data: null };
  function sectorStatsCached(maxAge) {
    const now = Date.now();
    if (_sectorCache.data && now - _sectorCache.at < (maxAge || 10000)) return _sectorCache.data;
    _sectorCache.at = now; _sectorCache.data = sectorStats();
    return _sectorCache.data;
  }

  /* ---------------- 单只股票预测 ---------------- */
  function predictOne(st, sector, regime) {
    const q = st.quote || {};
    const price = q.price, chgPct = q.chgPct, turnover = q.turnover, volRatio = q.volRatio,
      amplitude = q.amplitude, amount = q.amount, pe = q.pe, mainNetPct = q.mainNetPct;
    const ind = st.ind, kl = st.kline;
    const tech = !!(ind && kl && kl.length > 30 && ind.ma20 && ind.ma20[kl.length - 1] != null);
    const n = kl ? kl.length : 0, last = n - 1;

    /* 动量/趋势分(0-100) */
    let M = 50;
    if (chgPct != null) M += clamp(chgPct * 6, -25, 25);
    if (turnover != null) {
      if (turnover >= 3 && turnover <= 15) M += 8;
      else if (turnover > 25) M -= 5;
      else if (turnover < 0.5) M -= 5;
    }
    if (volRatio != null) {
      if (volRatio > 2) M += 8;
      else if (volRatio > 1.2) M += 4;
      else if (volRatio < 0.7) M -= 5;
    }
    if (amplitude != null && amplitude > 8) M -= 4;
    if (mainNetPct != null) {
      if (mainNetPct > 2) M += 8;
      else if (mainNetPct > 0) M += 4;
      else if (mainNetPct < -3) M -= 8;
      else if (mainNetPct < -8) M -= 12;
    }
    if (tech) {
      const c = kl[last].close;
      if (n > 5) {
        const r5 = (c / kl[n - 6].close - 1) * 100;
        M += clamp(r5 * 1.2, -18, 18);
      }
      const ma20v = ind.ma20[last], ma60v = ind.ma60[last];
      if (ma20v != null && ma60v != null) {
        if (c > ma20v && ma20v > ma60v) M += 10;
        else if (c < ma20v && ma20v < ma60v) M -= 10;
      }
      const rsi = ind.rsi[last];
      if (rsi != null) {
        if (rsi > 78) M -= 8;
        else if (rsi > 62) M += 4;
      }
      if (ind.hist[last] > 0) M += 5; else M -= 4;
      if (q.high60 != null && price != null && price >= q.high60 * 0.97) M += 6;
      if (q.upStreak >= 3) M += 5;
      if (q.downStreak >= 3) M -= 8;
      if (ind.volMa5 && ind.volMa5[last] > 0 && kl[last].volume > ind.volMa5[last] * 1.5) M += 5;
    }
    M = clamp(Math.round(M), 3, 97);

    /* 资金分(0-100) */
    let C = 50;
    if (mainNetPct != null) C = clamp(50 + mainNetPct * 8, 0, 100);
    C = Math.round(C);

    /* 行业强度分(0-100) */
    let SC = 50;
    if (sector) SC = clamp(50 + (sector.avgChg - regime.shChg) * 6 + (sector.upRatio - 50) * 0.5, 0, 100);
    SC = Math.round(SC);

    /* 风险分(0-100,越高越危险) */
    let R = 10;
    const risks = [];
    if (st.status === 'ST') { R += 30; risks.push('ST'); }
    if (st.status === '停牌') { R += 40; risks.push('停牌'); }
    if (pe != null && pe < 0) { R += 12; risks.push('亏损'); }
    else if (pe != null && pe > 150) { R += 8; risks.push('高估值'); }
    else if (pe != null && pe > 60) { R += 4; }
    if (amount != null && amount < 3e7) { R += 15; risks.push('低流动性'); }
    else if (amount != null && amount < 1e8) { R += 6; }
    if (amplitude != null && amplitude > 10) { R += 10; risks.push('高波动'); }
    else if (amplitude != null && amplitude > 7) { R += 5; }
    if (chgPct != null && chgPct > 9.5) { R += 15; risks.push('追高风险'); }
    else if (chgPct != null && chgPct > 7) { R += 10; risks.push('短线过热'); }
    if (price != null && price < 2) { R += 8; risks.push('低价股'); }
    if (volRatio != null && volRatio > 4) { R += 6; }
    if (mainNetPct != null && mainNetPct < -8) { R += 8; risks.push('资金流出'); }
    if (tech) {
      if (ind.rsi[last] != null && ind.rsi[last] > 85) R += 8;
      if (q.downStreak >= 4) { R += 8; risks.push('连跌'); }
    }
    R = clamp(Math.round(R), 0, 100);

    /* 上涨概率(概率校准:sigmoid 映射 + 市场环境修正 + 周期拉长调整) */
    const adj = regime.regime === '强势' ? 4 : regime.regime === '弱势' ? -6 : regime.regime === '普跌' ? -10 : 0;
    const p5 = clamp(Math.round(sigmoid((M + adj - 55) / 10) * 100), 3, 96);
    const p10 = clamp(p5 + 10 + Math.round(adj * 0.5), 3, 97);
    const p20 = clamp(p5 + 20 + adj, 3, 98);

    /* 预期收益(与动量分线性挂钩,含市场环境修正) */
    const ret5 = clamp(round1((M - 50) * 0.12 + adj * 0.15), -10, 12);
    const ret10 = clamp(round1(ret5 * 1.9), -15, 20);
    const ret20 = clamp(round1(ret5 * 2.7), -20, 30);
    const excess5 = clamp(round1(ret5 - regime.shChg * 0.25 - 0.15), -12, 12);
    const excess10 = clamp(round1(ret10 - regime.shChg * 0.45), -18, 20);
    const excess20 = clamp(round1(ret20 - regime.shChg * 0.6), -22, 25);

    /* 预期最大回撤 */
    const expDD = clamp(round1(4 + (100 - M) * 0.12 + (amplitude || 0) * 0.35 + ((turnover || 0) > 15 ? 2 : 0) + R * 0.06), 2, 40);

    /* 置信度(数据完整度) */
    const confidence = clamp(Math.round(50 + (tech ? 18 : 0) + (price != null ? 10 : 0) +
      (turnover != null ? 6 : 0) + (pe != null ? 4 : 0) + (mainNetPct != null ? 4 : 0) - (R > 60 ? 6 : 0)), 25, 95);

    /* 子得分与综合评分 */
    const sProb = p5;
    const sRet = clamp((ret5 + 10) / 20 * 100, 0, 100);
    const sExcess = clamp((excess5 + 8) / 16 * 100, 0, 100);
    const score = round1(clamp(WEIGHTS.prob * sProb + WEIGHTS.ret * sRet + WEIGHTS.excess * sExcess +
      WEIGHTS.sector * SC - WEIGHTS.risk * R, 5, 98));

    /* 主要正向因素(解释) */
    const pos = [];
    if (chgPct != null && chgPct > 2) pos.push('当日强势 +' + chgPct.toFixed(1) + '%');
    if (mainNetPct != null && mainNetPct > 1) pos.push('主力净流入 ' + mainNetPct.toFixed(1) + '%');
    if (volRatio != null && volRatio > 1.2) pos.push('量比 ' + volRatio.toFixed(1));
    if (sector && sector.avgChg > regime.shChg) pos.push('行业「' + sector.name + '」走强');
    if (sector && sector.upRatio > 60) pos.push('行业上涨家数占比 ' + sector.upRatio + '%');
    if (tech) {
      if (n > 5) {
        const r5 = (kl[last].close / kl[n - 6].close - 1) * 100;
        if (r5 > 3) pos.push('5日动量 +' + r5.toFixed(1) + '%');
      }
      if (ind.ma20[last] != null && ind.ma60[last] != null && price != null &&
        price > ind.ma20[last] && ind.ma20[last] > ind.ma60[last]) pos.push('均线多头排列');
      if (ind.hist[last] > 0) pos.push('MACD 红柱');
      if (q.high60 != null && price != null && price >= q.high60 * 0.97) pos.push('逼近 60 日新高');
    }
    if (!pos.length) pos.push('中性震荡');

    return {
      code: st.code, name: st.name, industry: st.industry || '其他', status: st.status,
      market: st.market || '', price: price, chgPct: chgPct, turnover: turnover,
      volRatio: volRatio, amount: amount, pe: pe, mainNetPct: mainNetPct, tech: tech,
      p5: p5, p10: p10, p20: p20,
      ret5: ret5, ret10: ret10, ret20: ret20,
      excess5: excess5, excess10: excess10, excess20: excess20,
      expDD: expDD, confidence: confidence,
      mScore: M, cScore: C, sScore: SC, rScore: R,
      sProb: sProb, sRet: sRet, sExcess: sExcess, score: score,
      pos: pos.slice(0, 3), risks: risks.slice(0, 3), regime: regime.regime
    };
  }

  /* ---------------- 全市场预测 ---------------- */
  function predictAll() {
    const list = D.buildAll().list;
    const regime = marketRegime();
    const sectors = sectorStatsCached();
    const smap = {};
    for (let i = 0; i < sectors.length; i++) smap[sectors[i].name] = sectors[i];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      const q = st.quote || {};
      if (q.price == null && q.chgPct == null) continue;   // 无行情的股票不参与预测
      try { out.push(predictOne(st, smap[st.industry], regime)); }
      catch (e) { /* 单只异常跳过 */ }
    }
    const market = {
      count: out.length,
      avgProb: out.length ? +(out.reduce((a, p) => a + p.p5, 0) / out.length).toFixed(1) : 0,
      avgRet: out.length ? +(out.reduce((a, p) => a + p.ret5, 0) / out.length).toFixed(2) : 0,
      avgScore: out.length ? +(out.reduce((a, p) => a + p.score, 0) / out.length).toFixed(1) : 0,
      hiProb: out.filter(p => p.p5 >= 60).length
    };
    return {
      at: Date.now(), dataAsOf: D.DATA_TIME, modelVersion: MODEL_VERSION, modelDesc: MODEL_DESC,
      regime: regime, weights: Object.assign({}, WEIGHTS), market: market, list: out
    };
  }
  const _predCache = { at: 0, data: null };
  function predictAllCached(maxAge) {
    const now = Date.now();
    if (_predCache.data && now - _predCache.at < (maxAge || 3000)) return _predCache.data;
    _predCache.at = now; _predCache.data = predictAll();
    return _predCache.data;
  }
  function invalidateCache() { _predCache.at = 0; _predCache.data = null; _sectorCache.at = 0; _sectorCache.data = null; }

  /* ---------------- 过滤与排名 ---------------- */
  function applyFilters(preds, f) {
    f = f || {};
    return preds.filter(p => {
      if (f.st && p.status === 'ST') return false;
      if (f.suspend && p.status === '停牌') return false;
      if (f.liquid && p.amount != null && p.amount < 3e7) return false;
      if (f.sector && p.industry !== f.sector) return false;
      return true;
    });
  }
  const DIMS = {
    composite: { label: '综合评分', sort: (a, b) => b.score - a.score },
    prob: { label: '上涨概率', sort: (a, b) => b.p5 - a.p5 },
    ret: { label: '预期收益', sort: (a, b) => b.ret5 - a.ret5 },
    excess: { label: '超额收益', sort: (a, b) => b.excess5 - a.excess5 },
    rr: { label: '风险收益比', sort: (a, b) => (b.ret5 / Math.max(b.expDD, 1)) - (a.ret5 / Math.max(a.expDD, 1)) },
    conf: { label: '高置信度', sort: (a, b) => ((b.confidence >= 70 ? b.score : -999) - (a.confidence >= 70 ? a.score : -999)) },
    lowvol: { label: '低波动机会', sort: (a, b) => (a.expDD - b.expDD) || (b.score - a.score) }
  };
  function rankDim(preds, dim) {
    let list = preds.slice();
    const cfg = DIMS[dim] || DIMS.composite;
    if (dim === 'conf') list = list.filter(p => p.confidence >= 70);
    if (dim === 'lowvol') list = list.filter(p => p.expDD <= 15 && p.p5 >= 45);
    list.sort(cfg.sort);
    return list;
  }

  /* ---------------- 预测快照与复盘 ----------------
   * localStorage 作为「离线镜像 + 写穿缓存」;服务端 /api/snapshots 作为权威台账。
   * 好处:预测历史跨设备保留、不因清缓存丢失,并可支撑长期(多快照)胜率统计。
   * 服务端不可用时自动退回纯本地模式(不影响功能,只是历史不跨设备)。 */
  const SNAP_KEY = 'qp_pred_hist';
  const SNAP_LOCAL_MAX = 60;                 // 本地镜像上限(控制 localStorage 体积)
  const _snapCache = { at: 0, data: null };
  let SYNC = null;                           // 由 real.js 注入的服务端传输
  const snapSync = { ok: null, at: 0, count: 0, error: '' };
  function setSyncTransport(t) { SYNC = t || null; }
  function snapshotSyncState() { return Object.assign({}, snapSync); }

  function loadSnapshots() {
    const now = Date.now();
    if (_snapCache.data && now - _snapCache.at < 2000) return _snapCache.data;   // 2s 缓存,避免频繁 JSON.parse
    let arr = [];
    try { arr = JSON.parse(root.localStorage.getItem(SNAP_KEY) || '[]'); } catch (e) { arr = []; }
    _snapCache.at = now; _snapCache.data = arr;
    return arr;
  }
  function writeLocalMirror(list) {
    const capped = (list || []).slice(0, SNAP_LOCAL_MAX);
    try { root.localStorage.setItem(SNAP_KEY, JSON.stringify(capped)); } catch (e) { }
    _snapCache.at = 0; _snapCache.data = capped;
    return capped;
  }
  function saveSnapshots(arr, opts) {
    const capped = writeLocalMirror(arr);
    if (SYNC && !(opts && opts.noPush)) scheduleSyncPush(arr);
    return capped;
  }
  /* 上传采用「按 label+modelVersion 合并」语义:服务端保留更大历史,不会被本地 60 条上限截断 */
  let pushTimer = null, pushPending = null;
  function scheduleSyncPush(list) {
    pushPending = (list || []).slice(0, SNAP_LOCAL_MAX);
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(flushSyncPush, 800);
  }
  async function flushSyncPush() {
    pushTimer = null;
    const list = pushPending; pushPending = null;
    if (!SYNC || !list || !list.length) return null;
    try {
      const merged = await SYNC.push(list);
      if (Array.isArray(merged)) {
        writeLocalMirror(merged);
        snapSync.ok = true; snapSync.at = Date.now(); snapSync.count = merged.length; snapSync.error = '';
      }
      return merged;
    } catch (e) {
      snapSync.ok = false; snapSync.error = (e && e.message) || '同步失败';
      return null;
    }
  }
  /* 首次进入时与服务端台账对账:拉取远端 + 把本地独有(尚未上传)的迁移上去 */
  async function hydrateSnapshots() {
    if (!SYNC) return null;
    let local = [];
    try { local = JSON.parse(root.localStorage.getItem(SNAP_KEY) || '[]'); } catch (e) { local = []; }
    try {
      let list = await SYNC.pull();
      list = Array.isArray(list) ? list : [];
      const remoteKeys = new Set(list.map(s => s && (s.label + '|' + (s.modelVersion || ''))));
      const localOnly = (local || []).filter(s => s && s.id && !remoteKeys.has(s.label + '|' + (s.modelVersion || '')));
      if (localOnly.length) {
        try { const m = await SYNC.push(localOnly); if (Array.isArray(m)) list = m; } catch (e) { }
      }
      writeLocalMirror(list);
      snapSync.ok = true; snapSync.at = Date.now(); snapSync.count = list.length; snapSync.error = '';
      return list;
    } catch (e) {
      snapSync.ok = false; snapSync.error = (e && e.message) || '同步失败';
      return null;                                  // 保持本地可用
    }
  }
  function todayLabel() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ---------------- 交易时段(预测锁定规则) ----------------
   * 开盘(9:30)~收盘(15:00)之间(含午休)为交易时段:预测锁定,不可变更;
   * 收盘后至次日开盘前(含周末/节假日)为非锁定时段:自动复盘 + 可重新预测(为下一交易日做准备)。
   *
   * 交易日判定优先使用服务端下发的「真实交易日历」(由上证指数日K推导,含调休),
   * 未加载日历时回退为「周一~周五」启发式——回退状态下节假日会被误判,
   * 因此应用启动时会优先拉取日历(setCalendar)。 */
  const CAL = { days: null, set: null, last: '', holidays: null };   // set/holidays 为 Set;days 为升序数组
  function setCalendar(data) {
    if (!data || !Array.isArray(data.days) || !data.days.length) return false;
    CAL.days = data.days.slice().sort();
    CAL.set = new Set(CAL.days);
    CAL.last = data.last || CAL.days[CAL.days.length - 1];
    CAL.holidays = new Set(Array.isArray(data.futureHolidays) ? data.futureHolidays : []);
    return true;
  }
  function hasCalendar() { return !!(CAL.set && CAL.days); }
  function calendarInfo() { return hasCalendar() ? { last: CAL.last, count: CAL.days.length } : null; }
  function isWeekday(d) { const w = d.getDay(); return w !== 0 && w !== 6; }
  /* 是否交易日:早于等于日历最后一日 → 以真实日历为准(含调休);
     晚于日历最后一日 → 周一~周五 且不在交易所公布的未来休市表内 */
  function isTradingDay(d, dayStr) {
    const s = dayStr || fmtDay(d);
    if (hasCalendar()) {
      if (s <= CAL.last) return CAL.set.has(s);
      return isWeekday(d) && !CAL.holidays.has(s);
    }
    return isWeekday(d);
  }
  function isHolidayKnownOutsideCalendar(d, dayStr) {
    return hasCalendar() && CAL.holidays.has(dayStr || fmtDay(d));
  }
  function nextTradeDay(from) {
    const d = from ? new Date(from) : new Date();
    do { d.setDate(d.getDate() + 1); } while (!isTradingDay(d));
    return d;
  }
  /* 按交易日平移 N 天(正=向后,负=向前)。
     日历覆盖范围内用精确列表;向后超出日历末尾时继续按休市规则推算。
     用于把"未来 N 个交易日"对齐到真实交易日,避免节假日错位。 */
  function parseDay(s) {
    const p = String(s || '').split('-').map(Number);
    return (p.length === 3 && p.every(v => !isNaN(v))) ? new Date(p[0], p[1] - 1, p[2]) : null;
  }
  function shiftTradingDays(fromDateStr, n) {
    n = +n || 0;
    if (!hasCalendar()) return null;
    const i = CAL.days.indexOf(fromDateStr);
    if (i < 0) return null;                        // 不在日历内(早于起点或非交易日)
    const j = i + n;
    if (j < 0) return null;                        // 早于日历起点,无法推算
    if (j < CAL.days.length) return CAL.days[j];
    let d = parseDay(CAL.days[CAL.days.length - 1]);   // 超出日历末尾:按规则向后推算
    if (!d) return null;
    let need = j - (CAL.days.length - 1);
    while (need > 0) { d = nextTradeDay(d); need--; }
    return fmtDay(d);
  }
  function fmtDay(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function isTradeTime(now) {
    const d = now ? new Date(now) : new Date();
    if (!isTradingDay(d)) return false;
    const h = d.getHours() + d.getMinutes() / 60;
    return h >= 9.5 && h < 15;                       // 9:30~15:00(含午休)
  }
  function isLocked(now) { return isTradeTime(now); }  // 盘中锁定;盘前/盘后/周末/节假日可变更
  function effectiveTradeDate(now) {
    // 预测生效交易日:交易日盘前(0:00~9:30)与盘中 → 今天;收盘后/非交易日 → 下一交易日
    const d = now ? new Date(now) : new Date();
    if (isTradingDay(d)) {
      const h = d.getHours() + d.getMinutes() / 60;
      if (h < 15) return fmtDay(d);
    }
    return fmtDay(nextTradeDay(d));
  }

  function saveSnapshot(preds, now) {
    const snaps = loadSnapshots();
    const label = effectiveTradeDate(now);
    const snap = {
      id: 'p' + Date.now().toString(36),
      label: label, at: new Date().toISOString(),
      version: SNAP_VERSION,                             // 快照格式版本(旧版无此字段)
      modelVersion: preds.modelVersion, dataAsOf: preds.dataAsOf,
      regime: preds.regime, weights: preds.weights, market: preds.market,
      count: preds.market.count,
      // 保存完整预测对象(含 pos/risks/全部周期字段),保证页面展示与复盘均可追溯
      top: preds.list.slice(0, 100)
    };
    const idx = snaps.findIndex(s => s.label === label && s.modelVersion === preds.modelVersion);
    if (idx >= 0) snaps[idx] = snap; else snaps.unshift(snap);
    saveSnapshots(snaps);
    return snap;
  }
  function removeSnapshot(id) {
    const snaps = loadSnapshots().filter(s => s.id !== id);
    saveSnapshots(snaps, { noPush: true });
    /* 删除是显式动作:单独通知服务端(合并语义不会删除,故必须显式调用) */
    if (SYNC && SYNC.del) {
      SYNC.del(id).then(list => {
        if (Array.isArray(list)) { writeLocalMirror(list); snapSync.count = list.length; }
      }).catch(e => { snapSync.ok = false; snapSync.error = (e && e.message) || '删除同步失败'; });
    }
    return snaps;
  }

  /* 快照格式兼容性:旧版快照缺 pos/risks/ret20 等字段,会导致页面渲染崩溃 */
  function snapshotCompatible(snap) {
    if (!snap || !Array.isArray(snap.top) || !snap.top.length) return false;
    const t = snap.top[0];
    return Array.isArray(t.pos) && Array.isArray(t.risks) && typeof t.ret20 === 'number';
  }

  /* 预测读取:按"生效交易日"取快照(不存在则生成)。锁定与否由页面控制:
   * 盘中锁定(不可变更);收盘后~次日开盘前可重新预测(regenerateDailyPrediction)。
   * 若生效日存在旧格式(不兼容)快照,则作废重建一次(格式升级)。 */
  function ensureDailyPrediction(now) {
    const label = effectiveTradeDate(now);
    const snaps = loadSnapshots();
    let idx = snaps.findIndex(s => s.label === label);
    if (idx >= 0 && !snapshotCompatible(snaps[idx])) {
      snaps.splice(idx, 1);                 // 旧格式快照:重建(一次性格式升级)
      saveSnapshots(snaps);
      idx = -1;
    }
    let snap = idx >= 0 ? snaps[idx] : saveSnapshot(predictAll(), now);
    return {
      snapshot: snap, label: label, locked: isLocked(now),
      modelVersion: snap.modelVersion || MODEL_VERSION,
      dataAsOf: snap.dataAsOf || D.DATA_TIME,
      regime: snap.regime, weights: snap.weights || Object.assign({}, WEIGHTS),
      market: snap.market, top: snap.top || []
    };
  }

  /* 重新预测(仅非锁定时段可用):删除生效日旧快照并生成新快照;交易时段返回 null */
  function regenerateDailyPrediction(now) {
    if (isLocked(now)) return null;
    const label = effectiveTradeDate(now);
    const snaps = loadSnapshots().filter(s => s.label !== label);
    saveSnapshots(snaps);
    return saveSnapshot(predictAll(), now);
  }

  /* 单快照复盘:对某快照 TopN 计算未来 h 日实际表现(需要已加载K线;无K线返回待验证) */
  function reviewSnapshotSummary(snap, h, topN) {
    const top = (snap.top || []).slice(0, topN || 10);
    const rows = top.map(t => {
      const st = D.getStock(t.code);
      const act = st ? actualReturn(st, snap.label, +h) : null;
      const predUp = (t['p' + h] || 0) >= 50;
      const hit = act ? ((predUp && act.ret > 0) || (!predUp && act.ret <= 0)) : null;
      return { t: t, act: act, hit: hit };
    });
    const withAct = rows.filter(r => r.act);
    const avgPred = withAct.length ? +(withAct.reduce((a, r) => a + (r.t['ret' + h] || 0), 0) / withAct.length).toFixed(2) : null;
    const avgAct = withAct.length ? +(withAct.reduce((a, r) => a + r.act.ret, 0) / withAct.length).toFixed(2) : null;
    const hitRate = withAct.length >= 3 ? Math.round(withAct.filter(r => r.hit).length / withAct.length * 100) : null;
    return {
      h: +h, rows: rows, withAct: withAct,
      hitRate: hitRate, avgPred: avgPred, avgAct: avgAct,
      bias: (avgPred != null && avgAct != null) ? +(avgPred - avgAct).toFixed(2) : null
    };
  }

  /* ---------------- 累计长期胜率(滚动多个快照) ----------------
   * 单个快照只看一次结果;把历史快照汇总后才能判断"模型是否稳定/是否在退化"。
   * 只统计已有实际数据(已成熟)的样本,样本不足的周期不参与计算。 */
  function reviewHistory(opts) {
    opts = opts || {};
    const h = +opts.horizon || 5;
    const topN = +opts.topN || 10;
    const limit = +opts.limit || 120;                    // 最多统计最近 N 个快照
    const effective = effectiveTradeDate();
    const snaps = loadSnapshots().slice(0, limit);
    const series = [];
    let totHit = 0, totRows = 0, sumPred = 0, sumAct = 0, predN = 0, skipped = 0;
    snaps.forEach(snap => {
      if (!snap || !snap.label) return;
      if (snap.label === effective) { skipped++; return; }   // 生效日尚未成熟
      const s = reviewSnapshotSummary(snap, h, topN);
      if (!s.withAct.length) { skipped++; return; }
      const hits = s.withAct.filter(r => r.hit).length;
      series.push({ label: snap.label, n: s.withAct.length, hitRate: s.hitRate, avgPred: s.avgPred, avgAct: s.avgAct, bias: s.bias });
      totHit += hits; totRows += s.withAct.length;
      if (s.avgPred != null && s.avgAct != null) { sumPred += s.avgPred; sumAct += s.avgAct; predN++; }
    });
    series.sort((a, b) => String(a.label).localeCompare(String(b.label)));   // 时间正序,便于画趋势
    const cumulative = {
      hitRate: totRows >= 3 ? Math.round(totHit / totRows * 100) : null,
      samples: totRows,
      snapshots: series.length,
      skipped: skipped,
      avgPred: predN ? +(sumPred / predN).toFixed(2) : null,
      avgAct: predN ? +(sumAct / predN).toFixed(2) : null,
      bias: predN ? +((sumPred - sumAct) / predN).toFixed(2) : null
    };
    /* 滚动命中率:按"样本加权"而非简单平均,避免样本少的快照被高估 */
    const rolling = n => {
      const tail = series.slice(-n);
      const rows = tail.reduce((a, x) => a + x.n, 0);
      if (rows < 3) return null;
      const hit = tail.reduce((a, x) => a + Math.round((x.hitRate || 0) * x.n / 100), 0);
      return Math.round(hit / rows * 100);
    };
    return {
      horizon: h, topN: topN, series: series, cumulative: cumulative,
      roll5: rolling(5), roll10: rolling(10),
      first: series.length ? series[0].label : null,
      last: series.length ? series[series.length - 1].label : null
    };
  }
  /* 为累计胜率做有界预取所需股票代码:最近 N 个已成熟快照的 TopN(去重) */
  function historyCodes(opts) {
    opts = opts || {};
    const topN = +opts.topN || 10;
    const limit = +opts.limit || 12;
    const effective = effectiveTradeDate();
    const codes = [];
    const seen = new Set();
    loadSnapshots().slice(0, limit).forEach(snap => {
      if (!snap || snap.label === effective) return;
      (snap.top || []).slice(0, topN).forEach(t => {
        if (t && t.code && !seen.has(t.code)) { seen.add(t.code); codes.push(t.code); }
      });
    });
    return codes;
  }

  /* 实际收益:以快照日为起点,未来 horizon 个交易日的收益(需要日K) */
  function actualReturn(st, snapDate, horizon) {
    const kl = st.kline;
    if (!kl || kl.length < horizon + 2) return null;
    let start = -1;
    for (let i = 0; i < kl.length; i++) {
      if (kl[i].date >= snapDate) { start = i; break; }
    }
    if (start < 0) return null;
    const end = start + horizon;
    if (end >= kl.length) return null;
    const s0 = kl[start].close;
    if (!s0) return null;
    let hi = s0, lo = s0;
    for (let i = start + 1; i <= end; i++) {
      hi = Math.max(hi, kl[i].high);
      lo = Math.min(lo, kl[i].low);
    }
    return {
      ret: +((kl[end].close / s0 - 1) * 100).toFixed(2),
      maxDD: +((lo / s0 - 1) * 100).toFixed(2),
      maxUp: +((hi / s0 - 1) * 100).toFixed(2)
    };
  }

  /* ---------------- 导出 ---------------- */
  root.QP.predict = {
    MODEL_VERSION: MODEL_VERSION, MODEL_DESC: MODEL_DESC, WEIGHTS: WEIGHTS, TH: TH, DIMS: DIMS,
    marketRegime: marketRegime, sectorStats: sectorStats, sectorStatsCached: sectorStatsCached,
    predictOne: predictOne, predictAll: predictAll, predictAllCached: predictAllCached,
    invalidateCache: invalidateCache,
    applyFilters: applyFilters, rankDim: rankDim,
    loadSnapshots: loadSnapshots, saveSnapshots: saveSnapshots, saveSnapshot: saveSnapshot,
    removeSnapshot: removeSnapshot, todayLabel: todayLabel, actualReturn: actualReturn,
    /* 服务端台账同步(由 real.js 注入传输;未注入时纯本地运行) */
    setSyncTransport: setSyncTransport, hydrateSnapshots: hydrateSnapshots,
    flushSyncPush: flushSyncPush, snapshotSyncState: snapshotSyncState,
    isWeekday: isWeekday, isTradeTime: isTradeTime, isLocked: isLocked,
    effectiveTradeDate: effectiveTradeDate, nextTradeDay: nextTradeDay,
    /* 交易日历(真实交易日,含调休):由服务端 /api/calendar 提供 */
    setCalendar: setCalendar, hasCalendar: hasCalendar, calendarInfo: calendarInfo,
    isTradingDay: isTradingDay, shiftTradingDays: shiftTradingDays,
    ensureDailyPrediction: ensureDailyPrediction, regenerateDailyPrediction: regenerateDailyPrediction,
    reviewSnapshotSummary: reviewSnapshotSummary, snapshotCompatible: snapshotCompatible,
    /* 累计长期胜率 */
    reviewHistory: reviewHistory, historyCodes: historyCodes
  };
})(typeof window !== 'undefined' ? window : globalThis);
