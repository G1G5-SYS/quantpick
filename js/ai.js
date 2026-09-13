/* ============================================================================
 * QuantPick — AI 分析引擎 (启发式规则,基于结构化模拟数据)
 * 生成结构化分析报告 + 自然语言研究助手回复。
 * 所有结论均引用数据来源与数据截止时间;推测性内容明确标注「推测」。
 * ========================================================================== */
(function (root) {
  'use strict';
  const D = root.QP.data;

  const DISCLAIMER = '本内容仅用于信息整理和研究参考,基于模拟数据(Mock)自动生成,不构成投资建议。';

  /* ---------------------------- 报告生成 ---------------------------- */
  function analyze(stock) {
    const q = stock.quote, fin = stock.fin || {}, ff = stock.fundFlow, sh = stock.shareholders;
    const ind = stock.ind;
    const n = stock.kline ? stock.kline.length : 0;
    const last = n - 1;
    const annual = (fin.annual && fin.annual.length) ? fin.annual[fin.annual.length - 1] : {};
    const tpl = D.IND_TEMPLATES[stock.industry] || { pb: 3, roe: 10 };
    const A = D.DATA_TIME;
    const cite = '数据来源:东方财富(' + A + ')';
    const hasTech = !!(ind && n > 0 && ind.ma20 && ind.ma20[last] != null);

    // ---------- 基本面评分 ----------
    let F = 50;
    const fReasons = [];
    if (annual.roe != null) {
      if (annual.roe > 20) { F += 14; fReasons.push('ROE ' + annual.roe + '% 显著高于行业中枢(' + tpl.roe + '%),盈利能力强'); }
      else if (annual.roe > 12) { F += 7; fReasons.push('ROE ' + annual.roe + '% 高于行业中枢(' + tpl.roe + '%)'); }
      else { F -= 6; fReasons.push('ROE ' + annual.roe + '% 低于行业中枢(' + tpl.roe + '%)'); }
    }

    if (fin.npYoY != null) {
      if (fin.npYoY > 25) { F += 12; fReasons.push('净利润同比 +' + fin.npYoY + '%,成长性突出'); }
      else if (fin.npYoY > 8) { F += 6; fReasons.push('净利润同比 +' + fin.npYoY + '%,保持稳健增长'); }
      else if (fin.npYoY < -5) { F -= 14; fReasons.push('净利润同比 ' + fin.npYoY + '%,业绩出现下滑'); }
    }

    if (annual.netMargin != null) {
      if (annual.netMargin > 20) { F += 8; fReasons.push('净利率 ' + annual.netMargin + '%,盈利质量优秀'); }
      else if (annual.netMargin < 5) { F -= 5; fReasons.push('净利率仅 ' + annual.netMargin + '%,盈利空间有限'); }
    }

    if (annual.debtRatio != null) {
      if (annual.debtRatio < 40) { F += 6; fReasons.push('资产负债率 ' + annual.debtRatio + '%,财务结构稳健'); }
      else if (annual.debtRatio > 70) { F -= 10; fReasons.push('资产负债率 ' + annual.debtRatio + '%,杠杆水平偏高'); }
    }

    if (annual.ocf != null) {
      if (annual.ocf > 0 && annual.ocf / (annual.netProfit || 1) > 0.8) F += 5;
      else if (annual.ocf <= 0) { F -= 8; fReasons.push('经营现金流为负,盈利含金量存疑'); }
    }

    if (q.pe != null) {
      if (q.pe < tpl.pb / (tpl.roe / 100)) { F += 8; fReasons.push('PE ' + q.pe + ' 低于行业估值中枢,估值具备安全边际'); }
      else if (q.pe > tpl.pb / (tpl.roe / 100) * 1.8) { F -= 8; fReasons.push('PE ' + q.pe + ' 显著高于行业估值中枢,估值偏高'); }
    }

    if (q.dvYield != null && q.dvYield > 3) { F += 4; fReasons.push('股息率 ' + q.dvYield + '%,具备一定防御属性'); }
    if (fin.growYears != null && fin.growYears >= 3) { F += 5; fReasons.push('净利润连续 ' + fin.growYears + ' 年正增长,成长持续性较好'); }
    F = D.clamp(Math.round(F), 5, 95);

    // ---------- 技术面评分 ----------
    let T = 50;
    const tReasons = [];
    if (hasTech) {
      const p = q.price;
      const ma20v = ind.ma20[last], ma60v = ind.ma60[last];
      if (p > ma20v && ma20v > ma60v) { T += 20; tReasons.push('价格站上 MA20/MA60,均线多头排列,趋势向上'); }
      else if (p > ma20v) { T += 8; tReasons.push('价格位于 MA20 上方,短期趋势偏强'); }
      else if (p < ma20v && ma20v < ma60v) { T -= 15; tReasons.push('价格跌破 MA20/MA60,均线空头排列,趋势偏弱'); }
      else { T -= 5; tReasons.push('价格运行于均线附近,趋势方向不明'); }

      const rsi = ind.rsi[last];
      if (rsi > 75) { T -= 6; tReasons.push('RSI ' + rsi + ' 进入超买区,短线回调风险上升'); }
      else if (rsi > 60) { T += 5; tReasons.push('RSI ' + rsi + ',多头动能占优'); }
      else if (rsi < 30) { T -= 3; tReasons.push('RSI ' + rsi + ' 进入超卖区,关注企稳信号'); }
      else if (rsi < 45) { T -= 3; tReasons.push('RSI ' + rsi + ',空头动能偏强'); }

      if (ind.hist[last] > 0 && ind.hist[last - 1] <= 0) { T += 8; tReasons.push('MACD 于近期形成金叉,动量转正'); }
      else if (ind.hist[last] > 0) T += 4;
      else T -= 4;

      if (q.price >= q.high60) { T += 8; tReasons.push('价格创 60 日新高,处于突破位置'); }
      if (q.volRatio > 1.5) { T += 4; tReasons.push('量比 ' + q.volRatio + ',放量配合上涨/活跃度提升'); }
      if (q.upStreak >= 3) { T += 3; tReasons.push('连续 ' + q.upStreak + ' 日上涨'); }
      if (q.downStreak >= 3) { T -= 6; tReasons.push('连续 ' + q.downStreak + ' 日下跌'); }

      // 动量因子(近5日涨幅,真实K线计算;使评分与涨幅保持线性正相关)
      if (n > 6 && stock.kline) {
        const c5 = (stock.kline[n - 1].close / stock.kline[n - 6].close - 1) * 100;
        if (c5 > 5) { T += 8; tReasons.push('近5日涨幅 +' + c5.toFixed(2) + '%,动量强劲'); }
        else if (c5 > 0) { T += 4; tReasons.push('近5日涨幅 +' + c5.toFixed(2) + '%,短期动量向上'); }
        else if (c5 < -5) { T -= 6; tReasons.push('近5日跌幅 ' + c5.toFixed(2) + '%,短期动量向下'); }
        else if (c5 < 0) { T -= 3; tReasons.push('近5日跌幅 ' + c5.toFixed(2) + '%,短期动量偏弱'); }
      }
    } else {
      tReasons.push('技术指标数据尚未加载,技术面暂按中性评估(加载日K后更新)');
    }
    T = D.clamp(Math.round(T), 5, 95);

    // ---------- 资金面评分 ----------
    let C = 50;
    const cReasons = [];
    if (!ff) { cReasons.push('资金流数据尚未加载,资金面暂按中性评估'); }
    else {
      if (ff.mainNetPct != null) {
        if (ff.mainNetPct > 3) { C += 18; cReasons.push('主力资金净流入占比 ' + ff.mainNetPct + '%,大资金积极进场'); }
        else if (ff.mainNetPct > 0) { C += 8; cReasons.push('主力资金小幅净流入(' + ff.mainNetPct + '%)'); }
        else if (ff.mainNetPct < -3) { C -= 15; cReasons.push('主力资金净流出占比 ' + ff.mainNetPct + '%,资金面承压'); }
        else { C -= 5; cReasons.push('主力资金小幅净流出(' + ff.mainNetPct + '%)'); }
      }

      if (sh && sh.holderChgPct != null) {
        if (sh.holderChgPct < -2) { C += 8; cReasons.push('股东户数环比下降 ' + Math.abs(sh.holderChgPct) + '%,筹码趋于集中'); }
        else if (sh.holderChgPct > 5) { C -= 8; cReasons.push('股东户数环比增加 ' + sh.holderChgPct + '%,筹码趋于分散'); }
      }

      if (ff.northChgPct != null) {
        if (ff.northChgPct > 1) C += 6;
        else if (ff.northChgPct < -1) C -= 4;
      }
    }
    C = D.clamp(Math.round(C), 5, 95);

    // ---------- 新闻面评分 ----------
    let N = 50;
    const nReasons = [];
    const newsList = stock.news || [];
    let sentSum = 0;
    newsList.slice(0, 8).forEach(function (item) {
      sentSum += item.sentiment === '+' ? 1 : item.sentiment === '-' ? -1 : 0;
    });
    const avgSent = newsList.length ? sentSum / Math.min(8, newsList.length) : 0;
    if (avgSent > 0.4) { N += 18; nReasons.push('近期新闻整体偏正面(' + avgSent.toFixed(2) + '),市场关注度提升'); }
    else if (avgSent > 0) { N += 7; nReasons.push('近期新闻情绪中性偏正面'); }
    else if (avgSent < -0.3) { N -= 15; nReasons.push('近期新闻整体偏负面(' + avgSent.toFixed(2) + '),需关注事件发酵'); }
    else if (!newsList.length) { nReasons.push('暂无新闻数据,新闻面按中性评估'); }
    else { N -= 3; nReasons.push('近期新闻情绪中性'); }
    N = D.clamp(Math.round(N), 5, 95);

    // ---------- 风险评分(越高越危险) ----------
    let R = 15;
    const risks = [];
    if (stock.status === 'ST') { R += 25; risks.push('ST 风险:公司处于特别处理状态,存在退市与流动性风险'); }
    if (q.pe != null && q.pe > (tpl.pb / (tpl.roe / 100)) * 1.8) { R += 15; risks.push('估值风险:PE ' + q.pe + ' 显著高于行业中枢,估值消化需要业绩支撑'); }
    if (fin.npYoY != null && fin.npYoY < 0) { R += 12; risks.push('业绩下滑风险:净利润同比 ' + fin.npYoY + '%,增长动能减弱'); }
    if (annual.debtRatio != null && annual.debtRatio > 70) { R += 12; risks.push('债务风险:资产负债率 ' + annual.debtRatio + '%,偿债压力较大'); }
    if (annual.ocf != null && annual.ocf <= 0) { R += 10; risks.push('现金流风险:经营现金流为负,盈利含金量存疑'); }
    if (q.amplitude != null && q.amplitude > 6) { R += 6; risks.push('波动风险:当日振幅 ' + q.amplitude + '%,短线波动剧烈'); }
    if (q.downStreak >= 4) { R += 8; risks.push('趋势风险:连续 ' + q.downStreak + ' 日下跌,趋势走弱'); }
    if (q.price != null && q.high52 != null && q.price < q.high52 * 0.75) { R += 6; risks.push('价格较 52 周高点回撤超过 25%,弱势格局延续'); }
    const negNews = newsList.filter(x => x.sentiment === '-');
    if (negNews.some(x => x.type === '股东' || x.type === '监管' || x.type === '风险')) {
      R += 10; risks.push('事件风险:近期存在' + negNews[0].type + '类负面公告,需跟踪进展');
    }
    if (ff && ff.mainNetPct != null && ff.mainNetPct < -3) { R += 6; risks.push('流动性/资金风险:主力资金持续净流出'); }
    if (R > 100) R = 100;
    const riskLevel = R >= 70 ? '高' : R >= 45 ? '中' : '低';

    // ---------- 综合 ----------
    const overall = Math.round(0.30 * F + 0.28 * T + 0.17 * C + 0.10 * N + 0.15 * (100 - R));
    const trend = overall >= 75 ? '强势' : overall >= 60 ? '偏强' : overall >= 45 ? '中性' : overall >= 30 ? '偏弱' : '弱势';

    const positive = [];
    const negative = [];
    fReasons.concat(tReasons, cReasons, nReasons).forEach(function (r) {
      const isPos = /提升|优秀|稳健|占优|突破|积极|集中|正面|上行|新高|强|优秀|充足|安全|防御|持续/.test(r);
      if (isPos && positive.length < 6) positive.push(r + '(' + cite + ')');
      else if (!isPos && negative.length < 6) negative.push(r + '(' + cite + ')');
    });

    const watch = [
      '关注下一报告期营收/净利润增速能否延续(' + cite + ')',
      '关注主力资金与北向资金的持续性(' + cite + ')',
      '关注' + (newsList[0] ? newsList[0].type : '行业') + '类公告的最新进展(' + (newsList[0] ? newsList[0].date : A) + ')'
    ];
    if (q.volRatio != null && q.volRatio > 1.5) watch.push('关注放量后的量能是否延续,谨防冲高回落');
    if (stock.status === '停牌') watch.push('股票处于停牌状态,复牌时间与事件进展待公告');

    const reasoning = [
      '基本面评分 ' + F + ' 分:综合 ROE、成长性、盈利质量、杠杆与估值得出',
      '技术面评分 ' + T + ' 分:基于均线结构、RSI、MACD、量能与突破状态',
      '资金面评分 ' + C + ' 分:基于主力净流入占比与资金流向',
      '新闻面评分 ' + N + ' 分:基于最近 8 条新闻的情绪倾向(规则判定)',
      '风险评分 ' + R + ' 分(' + riskLevel + '):分数越高风险越大',
      '综合评分 = 30%×基本面 + 28%×技术面 + 17%×资金面 + 10%×新闻面 + 15%×(100-风险)'
    ];

    return {
      symbol: stock.code, name: stock.name,
      data_as_of: A, generated_at: new Date().toLocaleString('zh-CN'),
      overall_score: overall,
      fundamental_score: F, technical_score: T, capital_score: C, news_score: N, risk_score: R,
      risk_level: riskLevel, trend: trend,
      positive_factors: positive, negative_factors: negative,
      risks: risks, watch_items: watch, reasoning: reasoning,
      disclaimer: DISCLAIMER
    };
  }

  /* ---------------------------- 研究助手 ---------------------------- */
  function fmtQuote(stock) {
    return stock.name + '(' + stock.code + ') 最新价 ' + (stock.quote.price == null ? '--' : stock.quote.price) + ' 元,涨跌幅 ' +
      D.fmtPct(stock.quote.chgPct) + '。数据截止:' + D.DATA_TIME + '。';
  }

  function peerCompare(stock) {
    const { list } = D.buildAll();
    const peers = list.filter(s => s.industry === stock.industry && s.code !== stock.code)
      .slice().sort((a, b) => (b.quote.mcap || 0) - (a.quote.mcap || 0)).slice(0, 5);
    const nf = v => (v == null || isNaN(v)) ? '--' : v;
    let txt = '**' + stock.name + ' 与同行业(' + stock.industry + ')对比**(数据截止 ' + D.DATA_TIME + '):\n\n';
    txt += '| 股票 | 最新价 | PE | PB | ROE% | 股息率% |\n|---|---|---|---|---|---|\n';
    const row = function (s) {
      const fin = s.fin || {};
      const annual = (fin.annual && fin.annual.length) ? fin.annual[fin.annual.length - 1] : {};
      return '| ' + s.name + ' | ' + (s.quote.price == null ? '--' : s.quote.price) +
        ' | ' + nf(s.quote.pe) + ' | ' + nf(s.quote.pb) +
        ' | ' + nf(annual.roe) + ' | ' + nf(s.quote.dvYield) + ' |';
    };
    txt += row(stock) + '\n';
    peers.forEach(function (s) { txt += row(s) + '\n'; });
    const basePe = peers[0] ? peers[0].quote.pe : null;
    txt += '\n**解读(推测)**: ' + (stock.quote.pe != null && basePe != null && stock.quote.pe < basePe
      ? stock.name + ' 相对同业估值更低,可能存在估值修复空间;'
      : stock.name + ' 相对同业估值不低,市场可能对其成长性给予溢价;') +
      ' 横向比较时请同时关注资产质量与成长性的差异。';
    return txt;
  }

  async function chat(stock, question) {
    const q = question.trim();
    const fin = stock.fin || {}, quote = stock.quote, ff = stock.fundFlow;
    const annual = (fin.annual && fin.annual.length) ? fin.annual[fin.annual.length - 1] : {};
    const A = D.DATA_TIME;
    const C = '数据截止:' + A + '。';
    const nf = v => (v == null || isNaN(v)) ? '--' : v;
    const newsList = stock.news || [], divList = stock.dividends || [];

    // 真实模式下先补齐单只股票的数据
    const RL = root.QP.real;
    if (RL && RL.store.mode === 'real') {
      await Promise.allSettled([
        RL.ensureKline(stock.code), RL.ensureFin(stock.code), RL.ensureFflow(stock.code),
        RL.ensureNews(stock.code), RL.ensureDividends(stock.code)
      ]);
    }

    let body = '';

    if (/为什么涨|上涨原因|为什么升/.test(q)) {
      const pos = newsList.find(x => x.sentiment === '+');
      const indOk = !!(stock.ind && stock.ind.ma20);
      body = '**' + stock.name + '近期上涨的可能原因分析**(' + C + ')\n\n';
      body += '1. **技术面**: ' + (indOk
        ? '均线' + (quote.price > stock.ind.ma20[stock.ind.ma20.length - 1] ? '多头' : '震荡') + ',RSI(' + nf(stock.ind.rsi[stock.ind.rsi.length - 1]) + '),MACD ' + (stock.ind.hist[stock.ind.hist.length - 1] > 0 ? '红柱' : '绿柱') + '。'
        : '暂无日K数据,暂无法判断。') + '\n';
      body += '2. **资金面**: 主力资金当日' + (ff && ff.mainNet != null ? (ff.mainNet >= 0 ? '净流入' : '净流出') + ' ' + D.fmtMoney(ff.mainNet) : '暂无数据') + '。\n';
      body += '3. **消息面**: 近期正面新闻:『' + (pos ? pos.title : '未检索到显著正面新闻') + '』(' + (pos ? pos.date : A) + ')。\n\n';
      body += '**提示**: 以上为基于结构化数据的归因分析,部分为**推测**。短期涨跌受情绪与资金扰动大,请结合基本面验证。';
    } else if (/为什么跌|下跌原因/.test(q)) {
      const neg = newsList.find(x => x.sentiment === '-');
      const indOk = !!(stock.ind && stock.ind.ma20 && stock.ind.ma60);
      body = '**' + stock.name + '近期下跌的可能原因分析**(' + C + ')\n\n';
      body += '1. **技术面**: ' + (indOk
        ? '价格' + (quote.price < stock.ind.ma20[stock.ind.ma20.length - 1] ? '跌破 MA20' : '位于 MA20 附近') + ',均线' + (quote.price < stock.ind.ma60[stock.ind.ma60.length - 1] ? '空头' : '震荡') + '排列。'
        : '暂无日K数据,暂无法判断。') + '\n';
      body += '2. **资金面**: 主力资金' + (ff && ff.mainNet != null ? (ff.mainNet < 0 ? '净流出 ' + D.fmtMoney(ff.mainNet) : '净流入 ' + D.fmtMoney(ff.mainNet)) : '暂无数据') + '。\n';
      body += '3. **消息面**: 近期相关新闻:『' + (neg ? neg.title : '未检索到显著负面新闻') + '』(' + (neg ? neg.date : A) + ')。\n\n';
      body += '**提示**: 以上为结构化归因,**推测**成分较高;请以公司公告原文为准。';
    } else if (/估值|贵不贵|便宜/.test(q)) {
      body = '**' + stock.name + ' 估值分析**(' + C + ')\n\n';
      const tpl = D.IND_TEMPLATES[stock.industry] || { pb: 3, roe: 10 };
      const indPe = +(tpl.pb / (tpl.roe / 100)).toFixed(2);
      body += '- 市盈率(PE): **' + nf(quote.pe) + '**(行业中枢约 ' + indPe + ',本地估算)\n';
      body += '- 市净率(PB): **' + nf(quote.pb) + '**(行业中枢约 ' + tpl.pb + ')\n';
      body += '- 股息率: **' + nf(quote.dvYield) + '%**\n';
      body += '- ROE: **' + nf(annual.roe) + '%**\n\n';
      body += '**判断(推测)**: ' + (quote.pe != null && quote.pe < indPe
        ? '当前 PE 低于行业中枢,若盈利维持,估值具有一定安全边际;'
        : '当前 PE 不低于行业中枢,需成长性兑现来消化估值;') +
        '估值高低还需结合成长性(净利同比 ' + nf(fin.npYoY) + '%)综合判断。';
    } else if (/财务|质量|ROE|赚钱能力/.test(q)) {
      body = '**' + stock.name + ' 财务质量分析**(' + C + ')\n\n';
      body += '- 最新报告期: 营收 ' + nf(annual.revenue) + ' 亿,净利润 ' + nf(annual.netProfit) + ' 亿\n';
      body += '- 营收同比 ' + nf(fin.revYoY) + '%,净利润同比 ' + nf(fin.npYoY) + '%\n';
      body += '- 毛利率 ' + nf(annual.grossMargin) + '%,净利率 ' + nf(annual.netMargin) + '%\n';
      body += '- ROE ' + nf(annual.roe) + '%,资产负债率 ' + nf(annual.debtRatio) + '%\n';
      body += '- 盈利连续增长年数: ' + nf(fin.growYears) + ' 年\n\n';
      if (/ROE/.test(q)) {
        const a0 = (fin.annual && fin.annual.length) ? fin.annual[0] : {};
        body += '**关于 ROE 变化(推测)**: ROE 变动通常来自净利率、周转率与杠杆的变化。当前 ROE ' + nf(annual.roe) + '%,较' + (a0.year || '早期') + '呈' +
          (annual.roe != null && a0.roe != null && annual.roe >= a0.roe ? '上升' : '下降') + '趋势,建议核对最新季度报。';
      }
    } else if (/风险/.test(q)) {
      const rep = await analyze(stock);
      body = '**' + stock.name + ' 主要风险清单**(风险评分 ' + rep.risk_score + '/100,' + rep.risk_level + '风险,' + C + ')\n\n';
      (rep.risks.length ? rep.risks : ['当前未识别到显著风险,但仍需持续跟踪业绩与公告。']).forEach(function (r, i) {
        body += (i + 1) + '. ' + r + '\n';
      });
      body += '\n**提示**: 风险评分由规则模型计算,仅供研究参考。';
    } else if (/同行|对比|行业.*比|比较/.test(q)) {
      body = await peerCompare(stock);
    } else if (/筛选|选股|低估值|高成长|高股息|低负债/.test(q)) {
      body = await screenReply(q);
    } else if (/分红|股息/.test(q)) {
      body = '**' + stock.name + ' 分红情况**(' + C + ')\n\n';
      if (divList.length) {
        divList.slice().reverse().forEach(function (d) {
          body += '- ' + d.year + ' 年:' + (d.plan || '方案详见公告') + '(除权日 ' + (d.exDate || '--') + ')\n';
        });
      } else {
        body += '暂无分红数据(数据源未接入或未披露)。\n';
      }
      body += '\n当前股息率 ' + nf(quote.dvYield) + '%。分红历史不代表未来分红承诺。';
    } else if (/新闻|公告|消息/.test(q)) {
      body = '**' + stock.name + ' 近期新闻与公告**(' + C + ')\n\n';
      if (newsList.length) {
        newsList.slice(0, 6).forEach(function (item) {
          body += '- [' + item.date + ' ' + item.time + '][' + (item.sentiment === '+' ? '利好' : item.sentiment === '-' ? '利空' : '中性') + '][' + item.source + '] ' + item.title + '\n';
        });
      } else {
        body += '暂无新闻数据。\n';
      }
      body += '\n**提示**: 情绪标签由规则自动判定,不代表事实判断。';
    } else if (/基本面|公司怎么样|简介|主营/.test(q)) {
      body = '**' + stock.name + ' 公司概况**(' + C + ')\n\n' + stock.desc + '\n\n';
      body += '- 所属行业: ' + stock.industry + ';概念:' + (stock.concepts || []).join('、') + '\n';
      body += '- 总股本 ' + (stock.totalShares ? (stock.totalShares / 1e8).toFixed(1) + ' 亿股' : '--') + ',流通比例 ' + (stock.floatPct ? (stock.floatPct * 100).toFixed(0) + '%' : '--') + '\n';
      body += '- 最新市值 ' + D.fmtBig(quote.mcap) + ',PE ' + nf(quote.pe) + ',PB ' + nf(quote.pb) + '\n';
      body += '- 公司简介为演示文本,请以公司官方披露为准。';
    } else {
      body = '我可以基于当前股票(' + stock.name + ')的结构化数据回答以下类型的问题:\n\n' +
        '- 「分析一下这只股票最近上涨/下跌的原因」\n- 「它现在估值高不高?」\n- 「这家公司财务质量怎么样?ROE 为什么变化?」\n' +
        '- 「有哪些主要风险?」\n- 「和同行业其他公司相比怎么样?」\n- 「帮我按低估值/高成长/高股息筛选股票」\n- 「分红情况」「近期新闻」\n\n' +
        '数据截止:' + A + '。我不编造数据,无法回答的问题会明确说明。';
    }
    return body + '\n\n> ' + DISCLAIMER;
  }

  /* ---------------------------- 自然语言选股 ---------------------------- */
  async function screenReply(question) {
    const S = root.QP.screener;
    const RL = root.QP.real;
    const { list } = RL && RL.store.mode === 'real' ? { list: RL.poolList() } : D.buildAll();
    const q = question;
    const conds = [];
    const labels = [];
    if (/低估值/.test(q)) { conds.push(S.newCond('pe', { op: '<', v1: 15 }), S.newCond('pb', { op: '<', v1: 2 })); labels.push('PE<15', 'PB<2'); }
    if (/高成长/.test(q)) { conds.push(S.newCond('npYoY', { op: '>', v1: 20 }), S.newCond('revYoY', { op: '>', v1: 10 })); labels.push('净利同比>20%', '营收同比>10%'); }
    if (/高股息/.test(q)) { conds.push(S.newCond('dvYield', { op: '>', v1: 4 })); labels.push('股息率>4%'); }
    if (/低负债/.test(q)) { conds.push(S.newCond('debtRatio', { op: '<', v1: 40 })); labels.push('资产负债率<40%'); }
    if (/盈利.*连续|连续.*增长/.test(q)) { conds.push(S.newCond('growYears', { op: '>=', v1: 3 })); labels.push('连续增长≥3年'); }
    if (/放量/.test(q)) { conds.push(S.newCond('volRatio', { op: '>', v1: 1.5 })); labels.push('量比>1.5'); }
    if (/突破|新高/.test(q)) { conds.push(S.newCond('breakout20', { op: '=', v1: '是' })); labels.push('突破20日新高'); }
    if (/主力|资金净流入/.test(q)) { conds.push(S.newCond('mainNetPct', { op: '>', v1: 2 })); labels.push('主力净流入占比>2%'); }
    if (!conds.length) {
      return '我可以根据关键词筛选,例如:『帮我按低估值、高成长、低负债筛选股票』。当前仅支持:低估值 / 高成长 / 高股息 / 低负债 / 连续增长 / 放量 / 突破新高 / 主力净流入。';
    }
    // 真实模式:补齐全池历史与财务数据(首次较慢,之后走缓存)
    if (RL && RL.store.mode === 'real') {
      await Promise.all([
        RL.ensureKlineAll(list.map(s => s.code), () => {}),
        RL.ensureFinAll(list.map(s => s.code), () => {})
      ]);
    }
    const strat = { id: 'nl', name: '自然语言策略', logic: 'AND', groups: [{ id: 'g1', logic: 'AND', conds: conds }] };
    const hits = S.run(strat, list).slice(0, 8);
    let txt = '**按「' + labels.join(' + ') + '」筛选结果**(数据截止 ' + D.DATA_TIME + '):\n\n';
    if (!hits.length) {
      txt += '未筛选到同时满足条件的股票,建议放宽部分条件后重试。';
    } else {
      txt += '| 股票 | 最新价 | 涨跌幅 | PE | ROE% | 股息率% |\n|---|---|---|---|---|---|\n';
      hits.forEach(function (s) {
        const fin = s.fin || {};
        const annual = (fin.annual && fin.annual.length) ? fin.annual[fin.annual.length - 1] : {};
        txt += '| ' + s.name + ' | ' + (s.quote.price == null ? '--' : s.quote.price) + ' | ' + D.fmtPct(s.quote.chgPct) + ' | ' +
          (s.quote.pe == null ? '--' : s.quote.pe) + ' | ' + (annual.roe == null ? '--' : annual.roe) + ' | ' +
          (s.quote.dvYield == null ? '--' : s.quote.dvYield) + ' |\n';
      });
      txt += '\n共命中 ' + hits.length + ' 只。可前往「条件选股」页保存为正式策略。';
    }
    return txt + '\n\n> ' + DISCLAIMER;
  }

  /* ---------------------------- 导出 ---------------------------- */
  root.QP.ai = {
    analyze: analyze, chat: chat, screenReply: screenReply,
    peerCompare: peerCompare, DISCLAIMER: DISCLAIMER
  };
})(typeof window !== 'undefined' ? window : globalThis);
