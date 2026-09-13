/* ============================================================================
 * QuantPick — 简化版策略回测引擎
 * 规则:
 *  1. 第 i 日收盘后,基于截至当日的数据(价格/均线/指标/已披露财报)评估策略;
 *  2. 信号在下一交易日收盘价成交(避免使用当日收盘价同时做决策与成交,杜绝未来数据);
 *  3. 等权组合,单票上限 8 只,买入/卖出收取佣金、印花税与滑点;
 *  4. 简化限制(页面需提示): 未模拟停牌、涨跌停无法成交、分红除权等因素。
 * ========================================================================== */
(function (root) {
  'use strict';
  const D = root.QP.data;
  const S = root.QP.screener;

  const FEE_BUY = 0.0005;   // 佣金+过户费
  const FEE_SELL = 0.0010;  // 佣金+过户费+印花税
  const SLIPPAGE = 0.0005;  // 单边滑点
  const MAX_POSITIONS = 8;

  function backtest(strategy, days, capital, stockList) {
    const { list: allList, indices } = D.buildAll();
    // 防御:过滤无K线或历史长度不足的股票,避免新上市/长期停牌股导致崩溃
    const MIN_BARS = 120;
    const stocks = (stockList || allList).filter(s =>
      s && s.status !== '停牌' && Array.isArray(s.kline) && s.kline.length >= MIN_BARS);
    if (!stocks.length) {
      return {
        strategy: strategy, period: ['', ''], initialCapital: capital,
        metrics: { totalReturn: 0, annualized: 0, maxDrawdown: 0, winRate: 0, plRatio: 0, trades: 0, fees: 0, benchReturn: 0, excess: 0, finalValue: capital, days: 0 },
        equity: [], drawdown: [], benchmark: [], trades: [],
        empty: true, emptyReason: '股票池中没有K线历史足够的股票(需≥120个交易日),请先在真实模式下加载历史K线'
      };
    }
    const n = Math.min.apply(null, [320].concat(stocks.map(s => s.kline.length)));
    const start = n - days;
    const warm = 70;                       // 指标预热
    const startIdx = Math.max(start, warm);

    let cash = capital;
    const holdings = new Map();            // code -> {name, shares, cost, buyDate, buyPrice, pnlPctAcc}
    const trades = [];
    const equitySeries = [];
    let fees = 0;

    const idxK = (indices[0] && indices[0].kline) ? indices[0].kline : null; // 上证指数作基准(UI 层需先加载指数K线)
    const idxStart = idxK ? idxK.length - days : 0;
    const benchSeries = [];

    for (let i = startIdx; i < n - 1; i++) {
      if (!stocks[0] || !stocks[0].kline[i] || !stocks[0].kline[i + 1]) continue; // 防御:K线对齐异常时跳过该日
      const date = stocks[0].kline[i].date;
      const nextDate = stocks[0].kline[i + 1].date;
      const hist = { i: i, date: date };

      // 1) 评估当日信号
      const matched = new Set();
      stocks.forEach(function (s) {
        if (S.evalStrategy(s, strategy, hist)) matched.add(s.code);
      });

      // 2) 次日收盘卖出不再匹配的持仓
      holdings.forEach(function (h, code) {
        if (!matched.has(code)) {
          const st = D.getStock(code);
          if (!st || !Array.isArray(st.kline) || !st.kline[i + 1]) return; // 防御:K线缺失时保留持仓
          const px = st.kline[i + 1].close;
          const exec = px * (1 - SLIPPAGE);
          const proceeds = h.shares * exec;
          const fee = proceeds * FEE_SELL;
          fees += fee;
          cash += proceeds - fee;
          const pnl = proceeds - fee - h.cost;
          trades.push({
            code: code, name: h.name,
            buyDate: h.buyDate, buyPrice: h.buyPrice,
            sellDate: nextDate, sellPrice: +exec.toFixed(2),
            pnl: +pnl.toFixed(2), pnlPct: +(pnl / h.cost * 100).toFixed(2)
          });
          holdings.delete(code);
        }
      });

      // 3) 次日收盘买入新匹配股票(等权)
      const candidates = stocks.filter(s => matched.has(s.code) && !holdings.has(s.code));
      const slots = MAX_POSITIONS - holdings.size;
      if (candidates.length && slots > 0) {
        const buys = candidates.slice(0, slots);
        const per = cash / buys.length;
        buys.forEach(function (st) {
          if (!Array.isArray(st.kline) || !st.kline[i + 1]) return; // 防御:K线缺失不买入
          const px = st.kline[i + 1].close;
          const exec = px * (1 + SLIPPAGE);
          const budget = Math.min(per, cash);
          if (budget < exec * 100) return;
          const shares = Math.floor(budget / exec / 100) * 100;
          if (shares <= 0) return;
          const cost = shares * exec;
          const fee = cost * FEE_BUY;
          fees += fee;
          cash -= cost + fee;
          holdings.set(st.code, {
            name: st.name, shares: shares, cost: cost + fee,
            buyDate: nextDate, buyPrice: +exec.toFixed(2)
          });
        });
      }

      // 4) 记录组合净值
      let mv = cash;
      holdings.forEach(function (h, code) {
        const st = D.getStock(code);
        if (st && Array.isArray(st.kline) && st.kline[i + 1]) mv += h.shares * st.kline[i + 1].close;
      });
      equitySeries.push({ date: nextDate, value: +mv.toFixed(2) });

      // 基准
      if (idxK) {
        const bi = idxStart + (i - startIdx + 1);
        if (idxK[bi]) benchSeries.push({ date: nextDate, value: idxK[bi].close });
      }
    }

    // 期末清仓(按最后一日收盘价)
    const finalDate = equitySeries.length ? equitySeries[equitySeries.length - 1].date : '';
    holdings.forEach(function (h, code) {
      const st = D.getStock(code);
      if (!st || !Array.isArray(st.kline) || !st.kline[n - 1]) return; // 防御:K线缺失时跳过清仓计价
      const px = st.kline[n - 1].close;
      const exec = px * (1 - SLIPPAGE);
      const proceeds = h.shares * exec;
      const fee = proceeds * FEE_SELL;
      fees += fee;
      cash += proceeds - fee;
      const pnl = proceeds - fee - h.cost;
      trades.push({
        code: code, name: h.name,
        buyDate: h.buyDate, buyPrice: h.buyPrice,
        sellDate: finalDate, sellPrice: +exec.toFixed(2),
        pnl: +pnl.toFixed(2), pnlPct: +(pnl / h.cost * 100).toFixed(2),
        isOpen: true
      });
    });

    // 指标
    const first = equitySeries[0] ? equitySeries[0].value : capital;
    const lastV = equitySeries.length ? equitySeries[equitySeries.length - 1].value : capital;
    const totalReturn = (lastV / first - 1) * 100;
    const years = equitySeries.length / 252;
    const annualized = years > 0 ? (Math.pow(lastV / first, 1 / years) - 1) * 100 : 0;

    let peak = -Infinity, maxDD = 0;
    equitySeries.forEach(function (p) {
      peak = Math.max(peak, p.value);
      const dd = (p.value / peak - 1) * 100;
      if (dd < maxDD) maxDD = dd;
    });

    const closed = trades.filter(t => !t.isOpen);
    const wins = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl <= 0);
    const winRate = closed.length ? wins.length / closed.length * 100 : 0;
    const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
    const plRatio = avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : 0;

    const benchFirst = benchSeries[0] ? benchSeries[0].value : 1;
    const benchLast = benchSeries.length ? benchSeries[benchSeries.length - 1].value : 1;
    const benchReturn = (benchLast / benchFirst - 1) * 100;
    const excess = totalReturn - benchReturn;

    // 回撤序列
    let pk = -Infinity;
    const ddSeries = equitySeries.map(function (p) {
      pk = Math.max(pk, p.value);
      return { date: p.date, value: +((p.value / pk - 1) * 100).toFixed(2) };
    });

    return {
      strategy: strategy,
      period: [equitySeries.length ? equitySeries[0].date : '', finalDate],
      initialCapital: capital,
      metrics: {
        totalReturn: +totalReturn.toFixed(2),
        annualized: +annualized.toFixed(2),
        maxDrawdown: +maxDD.toFixed(2),
        winRate: +winRate.toFixed(1),
        plRatio: plRatio,
        trades: trades.length,
        fees: +fees.toFixed(2),
        benchReturn: +benchReturn.toFixed(2),
        excess: +excess.toFixed(2),
        finalValue: +lastV.toFixed(0),
        days: equitySeries.length
      },
      equity: equitySeries,
      drawdown: ddSeries,
      benchmark: benchSeries,
      trades: trades
    };
  }

  const PERIODS = [
    { label: '近 60 个交易日', days: 60 },
    { label: '近 120 个交易日', days: 120 },
    { label: '近 180 个交易日', days: 180 },
    { label: '近 250 个交易日', days: 250 }
  ];

  /* ---------------- 单序列最大回撤 ---------------- */
  function maxDrawdownOf(values) {
    let peak = -Infinity, dd = 0;
    for (let i = 0; i < values.length; i++) {
      peak = Math.max(peak, values[i]);
      if (peak > 0) dd = Math.min(dd, values[i] / peak - 1);
    }
    return dd * 100;
  }
  function quantile(sorted, p) {
    if (!sorted.length) return 0;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
  }

  /* ---------------- 蒙特卡洛回撤 ----------------
   * 历史最大回撤只是"已发生的那一条路径";对净值日收益做有放回重采样(自助法),
   * 模拟大量可能路径,给出回撤的分布(P50/P95/最差)与"比历史更差"的概率,
   * 用于判断历史回撤是否偏乐观。纯统计,不改变策略与成交规则。 */
  function monteCarloDrawdown(result, opts) {
    opts = opts || {};
    const periods = Math.max(50, Math.min(2000, +opts.paths || 400));
    const equity = (result && result.equity) || [];
    if (equity.length < 20) return null;
    // 日收益率序列
    const rets = [];
    for (let i = 1; i < equity.length; i++) {
      const prev = equity[i - 1].value;
      if (prev > 0) rets.push(equity[i].value / prev - 1);
    }
    if (rets.length < 15) return null;
    const horizon = Math.max(10, Math.min(600, +opts.horizon || rets.length));
    const histDD = maxDrawdownOf(equity.map(e => e.value));
    const dds = [], retsEnd = [];
    for (let p = 0; p < periods; p++) {
      let v = 1, peak = 1, dd = 0;
      for (let i = 0; i < horizon; i++) {
        v *= (1 + rets[(Math.random() * rets.length) | 0]);
        if (v > peak) peak = v;
        const cur = v / peak - 1;
        if (cur < dd) dd = cur;
      }
      dds.push(dd * 100);
      retsEnd.push((v - 1) * 100);
    }
    dds.sort((a, b) => a - b); retsEnd.sort((a, b) => a - b);
    const worse = dds.filter(d => d <= histDD).length;
    return {
      paths: periods, horizon: horizon, samples: rets.length,
      histDD: +histDD.toFixed(2),
      dd: {
        median: +quantile(dds, 0.50).toFixed(2),
        p95: +quantile(dds, 0.05).toFixed(2),        // 最差 5% 分位(回撤为负,越小越差)
        worst: +dds[0].toFixed(2)
      },
      /* 模拟路径中"回撤比历史更差"的比例:越高说明历史回撤越偏乐观 */
      probWorseThanHist: +(worse / periods * 100).toFixed(1),
      /* 回撤分布直方图(供 UI 直接绘制,避免前端重复模拟) */
      hist: (function () {
        const lo = dds[0], hi = 0, B = 12;
        const step = (hi - lo) / B || 1;
        const bins = [], counts = [];
        for (let b = 0; b < B; b++) {
          const a = lo + step * b, z = lo + step * (b + 1);
          bins.push(+((a + z) / 2).toFixed(2));
          counts.push(dds.filter(x => x >= a && (b === B - 1 ? x <= z : x < z)).length);
        }
        return { bins: bins, counts: counts };
      })(),
      ret: {
        p05: +quantile(retsEnd, 0.05).toFixed(2),
        median: +quantile(retsEnd, 0.50).toFixed(2),
        p95: +quantile(retsEnd, 0.95).toFixed(2)
      }
    };
  }

  /* ---------------- 参数敏感性(回测窗口) ----------------
   * 同一策略在不同回测窗口下重跑:若结论随窗口剧烈变化,说明结果对区间敏感、
   * 稳健性不足(可能是某段行情特别适配)。用于避免"只挑好看区间"。 */
  function periodSensitivity(strategy, capital, stockList, periodList) {
    const list = periodList || PERIODS;
    const rows = list.map(function (p) {
      const r = backtest(strategy, p.days, capital, stockList);
      const m = r.metrics || {};
      return {
        label: p.label, days: p.days,
        totalReturn: m.totalReturn, annualized: m.annualized, maxDrawdown: m.maxDrawdown,
        excess: m.excess, winRate: m.winRate, trades: m.trades,
        empty: !!r.empty
      };
    });
    const valid = rows.filter(r => !r.empty);
    const spread = function (key) {
      if (!valid.length) return null;
      const vs = valid.map(r => r[key]).filter(v => typeof v === 'number');
      if (!vs.length) return null;
      return { min: +Math.min.apply(null, vs).toFixed(2), max: +Math.max.apply(null, vs).toFixed(2) };
    };
    const allPositive = valid.length ? valid.every(r => (r.totalReturn || 0) > 0) : null;
    const allExcessPositive = valid.length ? valid.every(r => (r.excess || 0) > 0) : null;
    return {
      rows: rows,
      spreadReturn: spread('totalReturn'),
      spreadDrawdown: spread('maxDrawdown'),
      allPositive: allPositive,
      allExcessPositive: allExcessPositive,
      validCount: valid.length,
      /* 稳健性评级:各窗口均盈利且均跑赢基准 → 高;均盈利 → 中;否则 低 */
      robustness: (valid.length < 2) ? '样本不足'
        : (allPositive && allExcessPositive) ? '高'
          : allPositive ? '中' : '低'
    };
  }

  root.QP.bt = {
    backtest: backtest, PERIODS: PERIODS,
    monteCarloDrawdown: monteCarloDrawdown, periodSensitivity: periodSensitivity,
    maxDrawdownOf: maxDrawdownOf,
    LIMITS: '简化版回测:未模拟停牌/涨跌停无法成交、分红除权与极端流动性;估值类条件使用最新报告期数据。历史回测不代表未来收益。'
  };
})(typeof window !== 'undefined' ? window : globalThis);
