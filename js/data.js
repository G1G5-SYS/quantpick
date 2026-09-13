/* ============================================================================
 * QuantPick 智能选股终端 — 数据层 (Mock / Demo Data Layer)
 * ----------------------------------------------------------------------------
 * 所有数据均由确定性种子(股票代码)生成,刷新页面后保持一致。
 * 本层数据为演示用模拟数据(MOCK),并非真实行情,页面必须明确标注。
 * ========================================================================== */
(function (root) {
  'use strict';

  /* ---------------------------- 基础工具 ---------------------------- */
  function hashString(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRng(seedStr) { return mulberry32(hashString(seedStr)); }

  function gauss(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  function rand(rng, lo, hi) { return lo + rng() * (hi - lo); }

  function randInt(rng, lo, hi) { return Math.floor(rand(rng, lo, hi + 1)); }

  function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

  /* ---------------------------- 日期 ---------------------------- */
  // 模拟"当前交易日"。系统时间即演示时间,数据截止时间统一为最近一个交易日收盘。
  const NOW = new Date();
  const TODAY_ISO = NOW.getFullYear() + '-' +
    String(NOW.getMonth() + 1).padStart(2, '0') + '-' +
    String(NOW.getDate()).padStart(2, '0');

  function toISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  }

  // 最近 n 个交易日(跳过周末;节假日忽略,模拟数据)
  function tradingDays(n) {
    const days = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    while (days.length < n) {
      const w = d.getDay();
      if (w !== 0 && w !== 6) days.unshift(toISO(d));
      d.setDate(d.getDate() - 1);
    }
    return days;
  }

  const TRADING_DAYS = tradingDays(320);            // 320 个交易日(约 1.3 年)
  const LAST_TRADING_DAY = TRADING_DAYS[TRADING_DAYS.length - 1];
  const DATA_TIME = LAST_TRADING_DAY + ' 15:00:00';

  /* ---------------------------- 格式化 ---------------------------- */
  function fmtMoney(v) { // 元 -> "1.23亿" / "4567万"
    if (v == null || isNaN(v)) return '--';
    const abs = Math.abs(v);
    if (abs >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (abs >= 1e4) return (v / 1e4).toFixed(0) + '万';
    return v.toFixed(0);
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    return v.toFixed(digits === undefined ? 2 : digits);
  }

  function fmtPct(v, digits) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    return (v > 0 ? '+' : '') + v.toFixed(digits === undefined ? 2 : digits) + '%';
  }

  function fmtBig(v) { // 大数字: 万亿/亿
    if (v == null || isNaN(v)) return '--';
    const abs = Math.abs(v);
    if (abs >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
    if (abs >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    return v.toFixed(0);
  }

  /* ---------------------------- 行业画像 ---------------------------- */
  // roe(%) 净资产收益率 | debt(%) 资产负债率 | gross(%) 毛利率 | net(%) 净利率
  // pb 市净率中枢 | payout 分红率 | growth 营收增速中枢(%) | vol 波动率
  const IND_TEMPLATES = {
    '白酒':      { roe: 28, debt: 22, gross: 86, net: 45, pb: 8.0, payout: 0.5, growth: 14, vol: 0.018, drift: 0.0004 },
    '银行':      { roe: 11, debt: 91, gross: 38, net: 33, pb: 0.62, payout: 0.30, growth: 6, vol: 0.009, drift: 0.0002 },
    '保险':      { roe: 11, debt: 88, gross: 25, net: 10, pb: 1.2, payout: 0.35, growth: 8, vol: 0.013, drift: 0.0002 },
    '证券':      { roe: 9, debt: 79, gross: 55, net: 30, pb: 1.5, payout: 0.30, growth: 10, vol: 0.017, drift: 0.0003 },
    '半导体':    { roe: 10, debt: 34, gross: 40, net: 16, pb: 4.5, payout: 0.15, growth: 26, vol: 0.024, drift: 0.0006 },
    '计算机':    { roe: 9, debt: 36, gross: 55, net: 12, pb: 3.8, payout: 0.20, growth: 18, vol: 0.022, drift: 0.0004 },
    '通信':      { roe: 10, debt: 40, gross: 30, net: 8, pb: 2.2, payout: 0.40, growth: 9, vol: 0.014, drift: 0.0002 },
    '光伏':      { roe: 9, debt: 58, gross: 22, net: 8, pb: 2.1, payout: 0.20, growth: 17, vol: 0.026, drift: -0.0002 },
    '锂电池':    { roe: 14, debt: 55, gross: 24, net: 11, pb: 3.4, payout: 0.20, growth: 24, vol: 0.024, drift: 0.0004 },
    '汽车':      { roe: 13, debt: 59, gross: 18, net: 7, pb: 2.4, payout: 0.30, growth: 16, vol: 0.019, drift: 0.0003 },
    '医药生物':  { roe: 16, debt: 34, gross: 62, net: 22, pb: 4.2, payout: 0.35, growth: 15, vol: 0.019, drift: 0.0004 },
    '家用电器':  { roe: 21, debt: 61, gross: 26, net: 10, pb: 3.0, payout: 0.45, growth: 9, vol: 0.014, drift: 0.0002 },
    '食品饮料':  { roe: 19, debt: 32, gross: 38, net: 15, pb: 4.0, payout: 0.50, growth: 10, vol: 0.016, drift: 0.0003 },
    '传媒':      { roe: 12, debt: 38, gross: 45, net: 18, pb: 2.8, payout: 0.40, growth: 12, vol: 0.020, drift: 0.0002 },
    '基础化工':  { roe: 13, debt: 52, gross: 26, net: 10, pb: 2.0, payout: 0.35, growth: 11, vol: 0.017, drift: 0.0002 },
    '有色金属':  { roe: 14, debt: 48, gross: 20, net: 9, pb: 2.4, payout: 0.40, growth: 13, vol: 0.020, drift: 0.0004 },
    '煤炭':      { roe: 17, debt: 44, gross: 32, net: 16, pb: 1.7, payout: 0.55, growth: 7, vol: 0.016, drift: -0.0002 },
    '石油石化':  { roe: 12, debt: 46, gross: 24, net: 7, pb: 1.4, payout: 0.45, growth: 6, vol: 0.013, drift: 0.0001 },
    '国防军工':  { roe: 10, debt: 46, gross: 28, net: 9, pb: 3.2, payout: 0.25, growth: 15, vol: 0.020, drift: 0.0003 },
    '机械设备':  { roe: 13, debt: 54, gross: 26, net: 10, pb: 2.2, payout: 0.35, growth: 13, vol: 0.018, drift: 0.0002 },
    '建筑装饰':  { roe: 9, debt: 75, gross: 11, net: 3, pb: 0.8, payout: 0.30, growth: 8, vol: 0.013, drift: 0.0001 },
    '房地产':    { roe: 4, debt: 79, gross: 18, net: 3, pb: 0.6, payout: 0.20, growth: -2, vol: 0.022, drift: -0.0005 },
    '建筑材料':  { roe: 12, debt: 42, gross: 28, net: 12, pb: 1.6, payout: 0.45, growth: 6, vol: 0.016, drift: 0.0001 },
    '电力':      { roe: 10, debt: 62, gross: 28, net: 14, pb: 1.9, payout: 0.50, growth: 9, vol: 0.011, drift: 0.0003 },
    '交通运输':  { roe: 10, debt: 50, gross: 24, net: 12, pb: 1.5, payout: 0.45, growth: 8, vol: 0.013, drift: 0.0002 },
    '农林牧渔':  { roe: 8, debt: 52, gross: 16, net: 6, pb: 2.6, payout: 0.20, growth: 10, vol: 0.021, drift: 0.0001 },
    '电子':      { roe: 11, debt: 45, gross: 20, net: 7, pb: 2.8, payout: 0.25, growth: 14, vol: 0.020, drift: 0.0003 },
    '商贸零售':  { roe: 10, debt: 52, gross: 22, net: 9, pb: 1.8, payout: 0.35, growth: 9, vol: 0.016, drift: 0.0001 },
    '航空机场':  { roe: 6, debt: 68, gross: 14, net: 5, pb: 1.6, payout: 0.20, growth: 12, vol: 0.019, drift: 0.0002 },
    '钢铁':      { roe: 8, debt: 58, gross: 12, net: 4, pb: 1.0, payout: 0.35, growth: 5, vol: 0.016, drift: -0.0002 }
  };

  /* ---------------------------- 股票池 ---------------------------- */
  // market: 沪主板 | 深主板 | 创业板 | 科创板 | 北交所  size: 巨/大/中/小
  const STOCKS = [
    ['600519', '贵州茅台', '白酒', ['白酒', 'MSCI中国', '核心资产', '茅指数'], 1460, '巨'],
    ['000858', '五粮液', '白酒', ['白酒', 'MSCI中国', '核心资产'], 128, '大'],
    ['600809', '山西汾酒', '白酒', ['白酒', '国企改革'], 195, '大'],
    ['000568', '泸州老窖', '白酒', ['白酒', 'MSCI中国'], 122, '大'],
    ['002304', '洋河股份', '白酒', ['白酒'], 82, '中'],
    ['000596', '古井贡酒', '白酒', ['白酒', '地方国资'], 205, '中'],
    ['600779', '水井坊', '白酒', ['白酒'], 38, '小'],
    ['603369', '今世缘', '白酒', ['白酒'], 42, '小'],

    ['601398', '工商银行', '银行', ['银行', '中特估', '高股息'], 6.2, '巨'],
    ['601939', '建设银行', '银行', ['银行', '中特估', '高股息'], 8.3, '巨'],
    ['600036', '招商银行', '银行', ['银行', 'MSCI中国', '高股息'], 42, '巨'],
    ['601166', '兴业银行', '银行', ['银行', '高股息'], 18, '大'],
    ['000001', '平安银行', '银行', ['银行'], 11, '大'],
    ['600016', '民生银行', '银行', ['银行'], 3.6, '中'],

    ['601318', '中国平安', '保险', ['保险', 'MSCI中国'], 52, '巨'],
    ['601601', '中国太保', '保险', ['保险', '中特估'], 31, '大'],
    ['601628', '中国人寿', '保险', ['保险', '中特估'], 33, '大'],

    ['600030', '中信证券', '证券', ['证券', 'MSCI中国'], 24, '大'],
    ['300059', '东方财富', '证券', ['证券', '互联网金融'], 16, '大'],
    ['601688', '华泰证券', '证券', ['证券'], 17, '大'],
    ['600837', '海通证券', '证券', ['证券', '合并重组'], 9.6, '大'],
    ['601995', '中金公司', '证券', ['证券', '次新股'], 38, '中'],

    ['688981', '中芯国际', '半导体', ['半导体', '国产芯片', '科创50'], 92, '大'],
    ['603501', '韦尔股份', '半导体', ['半导体', '国产芯片', 'CIS'], 105, '中'],
    ['002371', '北方华创', '半导体', ['半导体', '国产芯片', '设备'], 380, '大'],
    ['688012', '中微公司', '半导体', ['半导体', '国产芯片', '设备'], 165, '中'],
    ['002049', '紫光国微', '半导体', ['半导体', '国产芯片', '军工电子'], 62, '中'],
    ['603986', '兆易创新', '半导体', ['半导体', '存储芯片'], 92, '中'],
    ['688008', '澜起科技', '半导体', ['半导体', '算力', 'AI芯片'], 62, '中'],
    ['600584', '长电科技', '半导体', ['半导体', '封测'], 28, '大'],
    ['688041', '海光信息', '半导体', ['半导体', '国产芯片', '算力', 'AI'], 128, '大'],

    ['688111', '金山办公', '计算机', ['计算机', 'AI应用', '办公软件'], 290, '中'],
    ['002230', '科大讯飞', '计算机', ['计算机', 'AI应用', '大模型'], 52, '大'],
    ['600570', '恒生电子', '计算机', ['计算机', '金融科技'], 28, '中'],
    ['600588', '用友网络', '计算机', ['计算机', '信创'], 15, '中'],
    ['603019', '中科曙光', '计算机', ['计算机', '算力', '服务器'], 58, '中'],
    ['002415', '海康威视', '计算机', ['计算机', '安防', 'AIoT'], 31, '大'],

    ['600050', '中国联通', '通信', ['通信', '中特估', '数字经济'], 5.4, '巨'],
    ['000063', '中兴通讯', '通信', ['通信', '5G', '算力'], 30, '大'],
    ['600941', '中国移动', '通信', ['通信', '中特估', '高股息'], 112, '巨'],
    ['601728', '中国电信', '通信', ['通信', '中特估'], 7.4, '巨'],

    ['601012', '隆基绿能', '光伏', ['光伏', '新能源', 'BC电池'], 18, '大'],
    ['600438', '通威股份', '光伏', ['光伏', '新能源', '硅料'], 21, '大'],
    ['300274', '阳光电源', '光伏', ['光伏', '新能源', '储能'], 85, '大'],
    ['002459', '晶澳科技', '光伏', ['光伏', '新能源'], 15, '中'],
    ['601615', '明阳智能', '光伏', ['光伏', '风电'], 10, '中'],

    ['300750', '宁德时代', '锂电池', ['锂电池', '新能源车', '储能', 'MSCI中国'], 235, '巨'],
    ['002594', '比亚迪', '锂电池', ['锂电池', '新能源车', '比亚迪概念'], 305, '巨'],
    ['002466', '天齐锂业', '锂电池', ['锂电池', '锂矿'], 38, '中'],
    ['002460', '赣锋锂业', '锂电池', ['锂电池', '锂矿'], 42, '中'],
    ['300014', '亿纬锂能', '锂电池', ['锂电池', '储能'], 48, '中'],
    ['002074', '国轩高科', '锂电池', ['锂电池', '新能源车'], 24, '中'],

    ['601633', '长城汽车', '汽车', ['汽车', '新能源车', '智能驾驶'], 30, '大'],
    ['000625', '长安汽车', '汽车', ['汽车', '新能源车', '华为汽车'], 15, '大'],
    ['601127', '赛力斯', '汽车', ['汽车', '华为汽车', '问界'], 135, '大'],
    ['600104', '上汽集团', '汽车', ['汽车'], 14, '大'],
    ['601238', '广汽集团', '汽车', ['汽车', '新能源车'], 8.5, '中'],
    ['600418', '江淮汽车', '汽车', ['汽车', '华为汽车'], 32, '中'],

    ['600276', '恒瑞医药', '医药生物', ['医药生物', '创新药', 'MSCI中国'], 52, '大'],
    ['603259', '药明康德', '医药生物', ['医药生物', 'CXO'], 62, '大'],
    ['300760', '迈瑞医疗', '医药生物', ['医药生物', '医疗器械'], 265, '大'],
    ['300015', '爱尔眼科', '医药生物', ['医药生物', '医疗服务'], 13, '大'],
    ['600436', '片仔癀', '医药生物', ['医药生物', '中药'], 225, '中'],
    ['000538', '云南白药', '医药生物', ['医药生物', '中药'], 55, '中'],
    ['300347', '泰格医药', '医药生物', ['医药生物', 'CXO'], 58, '中'],
    ['688271', '联影医疗', '医药生物', ['医药生物', '医疗器械', '科创50'], 128, '中'],
    ['600196', '复星医药', '医药生物', ['医药生物', '创新药'], 26, '中'],

    ['000333', '美的集团', '家用电器', ['家用电器', 'MSCI中国', '机器人'], 72, '巨'],
    ['000651', '格力电器', '家用电器', ['家用电器', '高股息'], 42, '大'],
    ['600690', '海尔智家', '家用电器', ['家用电器'], 28, '大'],

    ['603288', '海天味业', '食品饮料', ['食品饮料', '调味品'], 42, '大'],
    ['600887', '伊利股份', '食品饮料', ['食品饮料', '乳制品', '高股息'], 28, '大'],
    ['600600', '青岛啤酒', '食品饮料', ['食品饮料', '啤酒'], 78, '中'],

    ['603899', '晨光股份', '商贸零售', ['商贸零售', '文具'], 38, '小'],
    ['002027', '分众传媒', '传媒', ['传媒', '广告营销'], 7.2, '中'],
    ['002624', '完美世界', '传媒', ['传媒', '游戏', 'AI应用'], 11, '中'],
    ['002555', '三七互娱', '传媒', ['传媒', '游戏', 'AI应用'], 15, '中'],
    ['300413', '芒果超媒', '传媒', ['传媒', '视频', '国资'], 24, '中'],

    ['600309', '万华化学', '基础化工', ['基础化工', 'MDI', 'MSCI中国'], 78, '大'],
    ['002493', '荣盛石化', '基础化工', ['基础化工', '炼化'], 9.5, '大'],
    ['600346', '恒力石化', '基础化工', ['基础化工', '炼化'], 14, '大'],
    ['002271', '东方雨虹', '基础化工', ['基础化工', '防水'], 13, '中'],
    ['600426', '华鲁恒升', '基础化工', ['基础化工', '煤化工'], 24, '中'],

    ['601899', '紫金矿业', '有色金属', ['有色金属', '黄金', '铜', 'MSCI中国'], 18, '大'],
    ['601088', '中国神华', '煤炭', ['煤炭', '中特估', '高股息'], 38, '巨'],
    ['601225', '陕西煤业', '煤炭', ['煤炭', '高股息'], 22, '大'],
    ['600188', '兖矿能源', '煤炭', ['煤炭', '高股息'], 14, '中'],
    ['601600', '中国铝业', '有色金属', ['有色金属', '铝', '中特估'], 7.8, '大'],
    ['600362', '江西铜业', '有色金属', ['有色金属', '铜'], 25, '中'],
    ['603993', '洛阳钼业', '有色金属', ['有色金属', '铜', '钴'], 7.2, '大'],
    ['603799', '华友钴业', '有色金属', ['有色金属', '钴', '锂电材料'], 30, '中'],

    ['600760', '中航沈飞', '国防军工', ['国防军工', '大飞机', '军工电子'], 45, '中'],
    ['002179', '中航光电', '国防军工', ['国防军工', '连接器'], 40, '中'],
    ['600893', '航发动力', '国防军工', ['国防军工', '航空发动机'], 38, '大'],
    ['601989', '中国重工', '国防军工', ['国防军工', '船舶'], 4.8, '大'],
    ['600150', '中国船舶', '国防军工', ['国防军工', '船舶'], 35, '大'],

    ['600031', '三一重工', '机械设备', ['机械设备', '工程机械', '出海'], 17, '大'],
    ['000157', '中联重科', '机械设备', ['机械设备', '工程机械'], 7.6, '中'],
    ['000338', '潍柴动力', '机械设备', ['机械设备', '重卡', '氢能源'], 13, '大'],
    ['601766', '中国中车', '机械设备', ['机械设备', '高铁', '中特估'], 7.2, '大'],

    ['601668', '中国建筑', '建筑装饰', ['建筑装饰', '中特估', '基建'], 5.6, '巨'],
    ['601390', '中国中铁', '建筑装饰', ['建筑装饰', '中特估', '基建'], 6.4, '大'],
    ['600585', '海螺水泥', '建筑材料', ['建筑材料', '水泥', '高股息'], 23, '大'],
    ['600176', '中国巨石', '建筑材料', ['建筑材料', '玻纤'], 11, '中'],

    ['000002', '万科A', '房地产', ['房地产', 'MSCI中国'], 7.2, '大'],
    ['600048', '保利发展', '房地产', ['房地产', '国资'], 8.6, '大'],

    ['600900', '长江电力', '电力', ['电力', '水电', '高股息', '中特估'], 28, '巨'],
    ['600905', '三峡能源', '电力', ['电力', '风电', '光伏'], 4.6, '大'],
    ['601985', '中国核电', '电力', ['电力', '核电', '中特估'], 10, '大'],
    ['600027', '华电国际', '电力', ['电力', '火电'], 5.8, '中'],

    ['601857', '中国石油', '石油石化', ['石油石化', '中特估', '高股息'], 8.6, '巨'],
    ['600028', '中国石化', '石油石化', ['石油石化', '中特估', '高股息'], 6.4, '巨'],
    ['600938', '中国海油', '石油石化', ['石油石化', '中特估', '高股息'], 28, '巨'],

    ['601888', '中国中免', '商贸零售', ['商贸零售', '免税', '消费'], 68, '大'],
    ['600415', '小商品城', '商贸零售', ['商贸零售', '跨境电商'], 12, '中'],
    ['002714', '牧原股份', '农林牧渔', ['农林牧渔', '猪肉'], 42, '大'],
    ['000876', '新希望', '农林牧渔', ['农林牧渔', '饲料', '猪肉'], 9.6, '中'],

    ['600009', '上海机场', '航空机场', ['航空机场', '机场', '免税'], 34, '中'],
    ['601006', '大秦铁路', '交通运输', ['交通运输', '铁路', '高股息'], 6.9, '大'],
    ['600029', '南方航空', '航空机场', ['航空机场', '航空'], 6.2, '大'],
    ['601111', '中国国航', '航空机场', ['航空机场', '航空'], 7.8, '大'],

    ['002475', '立讯精密', '电子', ['电子', '果链', '消费电子'], 38, '大'],
    ['601138', '工业富联', '电子', ['电子', '算力', 'AI服务器'], 26, '大'],
    ['000725', '京东方A', '电子', ['电子', '面板', 'OLED'], 4.2, '大'],
    ['002241', '歌尔股份', '电子', ['电子', '果链', 'VR'], 24, '中']
  ].map(function (s) {
    return { code: s[0], name: s[1], industry: s[2], concepts: s[3], base: s[4], size: s[5] };
  });

  // 市场、ST、停牌状态(仅 Mock 模式使用;真实模式下以行情数据为准)
  const STATUS_RULES = {};

  function marketOf(code) {
    if (code.startsWith('688')) return '科创板';
    if (code.startsWith('300') || code.startsWith('301')) return '创业板';
    if (code.startsWith('8') || code.startsWith('4') || code.startsWith('9')) return '北交所';
    if (code.startsWith('60') || code.startsWith('900')) return '沪主板';
    return '深主板';
  }

  function pinyinOf(name) {
    // 简化的拼音首字母映射(常用汉字),用于搜索。演示数据不做完整拼音库。
    const map = {
      '贵州茅台': 'GZMT', '五粮液': 'WLY', '山西汾酒': 'SXFJ', '泸州老窖': 'LZLJ',
      '洋河股份': 'YHGF', '古井贡酒': 'GJGJ', '水井坊': 'SJF', '今世缘': 'JSY',
      '工商银行': 'GSYH', '建设银行': 'JSYH', '招商银行': 'ZSYH', '兴业银行': 'XYYH',
      '平安银行': 'PAYH', '民生银行': 'MSYH', '中国平安': 'ZGPA', '中国太保': 'ZGTB',
      '中国人寿': 'ZGRS', '中信证券': 'ZXZQ', '东方财富': 'DFCF', '华泰证券': 'HTZQ',
      '海通证券': 'HTZQ2', '中金公司': 'ZJGS', '中芯国际': 'ZXGJ', '韦尔股份': 'WEGF',
      '北方华创': 'BFHC', '中微公司': 'ZWGS', '紫光国微': 'ZGGW', '兆易创新': 'ZYCX',
      '澜起科技': 'LQKJ', '长电科技': 'CDKJ', '海光信息': 'HGXX', '金山办公': 'JSBG',
      '科大讯飞': 'KDXF', '恒生电子': 'HSDZ', '用友网络': 'YYWL', '中科曙光': 'ZKSG',
      '海康威视': 'HKWS', '中国联通': 'ZGLT', '中兴通讯': 'ZXTX', '中国移动': 'ZGYD',
      '中国电信': 'ZGDX', '隆基绿能': 'LJLN', '通威股份': 'TWGF', '阳光电源': 'YGDY',
      '晶澳科技': 'JAKJ', '明阳智能': 'MYZN', '宁德时代': 'NDSD', '比亚迪': 'BYD',
      '天齐锂业': 'TQLY', '赣锋锂业': 'GFLY', '亿纬锂能': 'YW LN'.replace(' ', ''),
      '国轩高科': 'GXGK', '长城汽车': 'CCQC', '长安汽车': 'CAQC', '赛力斯': 'SLS',
      '上汽集团': 'SQJT', '广汽集团': 'GQJT', '江淮汽车': 'JHQC', '恒瑞医药': 'HRYY',
      '药明康德': 'YMKD', '迈瑞医疗': 'MRYL', '爱尔眼科': 'AEYK', '片仔癀': 'PZH',
      '云南白药': 'YNBY', '泰格医药': 'TGYY', '联影医疗': 'LYYL', '复星医药': 'FXYY',
      '美的集团': 'MDJT', '格力电器': 'GLDQ', '海尔智家': 'HEZJ', '海天味业': 'HTWY',
      '伊利股份': 'YLGF', '青岛啤酒': 'QDPJ', '晨光股份': 'CGGF', '分众传媒': 'FZCM',
      '完美世界': 'WMSJ', '三七互娱': 'SQHY', '芒果超媒': 'MGCM', '万华化学': 'WHHX',
      '荣盛石化': 'RSSH', '恒力石化': 'HLSH', '东方雨虹': 'DFYH', '华鲁恒升': 'HLHS',
      '紫金矿业': 'ZJKY', '中国神华': 'ZGSH', '陕西煤业': 'SXMY', '兖矿能源': 'YKNY',
      '中国铝业': 'ZGLY', '江西铜业': 'JXTY', '洛阳钼业': 'LYMY', '华友钴业': 'HYGY',
      '中航沈飞': 'ZHSF', '中航光电': 'ZHGD', '航发动力': 'HFDL', '中国重工': 'ZGZG',
      '中国船舶': 'ZGCB', '三一重工': 'SYZG', '中联重科': 'ZLZK', '潍柴动力': 'WCDL',
      '中国中车': 'ZGZC', '中国建筑': 'ZGJZ', '中国中铁': 'ZGZT', '海螺水泥': 'HLSN',
      '中国巨石': 'ZGJS', '万科A': 'WKA', '保利发展': 'BLFZ', '长江电力': 'CJDL',
      '三峡能源': 'SXNY', '中国核电': 'ZGHD', '华电国际': 'HDGJ', '中国石油': 'ZGSY',
      '中国石化': 'ZGSH2', '中国海油': 'ZGHY', '中国中免': 'ZGZM', '小商品城': 'XSPC',
      '牧原股份': 'MYGF', '新希望': 'XXW', '上海机场': 'SHJC', '大秦铁路': 'DQTL',
      '南方航空': 'NFHK', '中国国航': 'ZGGH', '立讯精密': 'LXJM', '工业富联': 'GYFL',
      '京东方A': 'JDFA', '歌尔股份': 'GEGF', 'ST演示股份': 'STYS', 'ST演示二号': 'STYS2'
    };
    return map[name] || name.slice(0, 2);
  }

  /* ---------------------------- K线生成 ---------------------------- */
  function genKline(code, n, base, vol, drift) {
    const rng = makeRng(code + ':kline');
    const days = tradingDays(n);
    const bars = [];
    let price = base * (0.7 + rng() * 0.6);
    let volBase = base / price * (300000 + rng() * 600000); // 基础成交量(手)
    for (let i = 0; i < n; i++) {
      const trend = drift + (base - price) / base * 0.006; // 均值回归
      let r = gauss(rng) * vol + trend;
      if (rng() < 0.03) r += (rng() < 0.5 ? -1 : 1) * vol * (2 + rng() * 3); // 偶发跳空
      const open = price * (1 + gauss(rng) * vol * 0.4);
      const close = price * (1 + r);
      const high = Math.max(open, close) * (1 + Math.abs(gauss(rng)) * vol * 0.6);
      const low = Math.min(open, close) * (1 - Math.abs(gauss(rng)) * vol * 0.6);
      const vMult = 1 + Math.abs(r) / (vol * 2.2) * (2.2 + rng() * 1.6);
      const volume = Math.round(volBase * vMult * (0.75 + rng() * 0.5));
      const amount = Math.round(volume * 100 * (high + low) / 2);
      bars.push({
        date: days[i],
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        close: +close.toFixed(2),
        volume: volume,
        amount: amount
      });
      price = close;
    }
    return bars;
  }

  /* ---------------------------- 技术指标 ---------------------------- */
  function sma(arr, n) {
    const out = new Array(arr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      sum += arr[i];
      if (i >= n) sum -= arr[i - n];
      if (i >= n - 1) out[i] = sum / n;
    }
    return out;
  }

  function ema(arr, n) {
    const out = new Array(arr.length).fill(null);
    const k = 2 / (n + 1);
    let prev = arr[0];
    out[0] = arr[0];
    for (let i = 1; i < arr.length; i++) {
      prev = arr[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function calcIndicators(kl) {
    const closes = kl.map(b => b.close);
    const highs = kl.map(b => b.high);
    const lows = kl.map(b => b.low);
    const vols = kl.map(b => b.volume);
    const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20), ma60 = sma(closes, 60);
    const ema12 = ema(closes, 12), ema26 = ema(closes, 26);
    const dif = closes.map((c, i) => ema12[i] - ema26[i]);
    const dea = ema(dif, 9);
    const hist = dif.map((d, i) => (d - dea[i]) * 2);

    // RSI(14)
    const rsi = new Array(closes.length).fill(null);
    let g = 0, l = 0;
    for (let i = 1; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      g = (g * 13 + Math.max(ch, 0)) / 14;
      l = (l * 13 + Math.max(-ch, 0)) / 14;
      if (i >= 14) rsi[i] = l === 0 ? 100 : +(100 - 100 / (1 + g / l)).toFixed(2);
    }

    // KDJ(9,3,3)
    const kArr = new Array(closes.length).fill(50), dArr = new Array(closes.length).fill(50);
    const jArr = new Array(closes.length).fill(50);
    for (let i = 0; i < closes.length; i++) {
      const s = Math.max(0, i - 8);
      const hh = Math.max.apply(null, highs.slice(s, i + 1));
      const ll = Math.min.apply(null, lows.slice(s, i + 1));
      const rsv = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
      const k = 2 / 3 * (i ? kArr[i - 1] : 50) + 1 / 3 * rsv;
      const d = 2 / 3 * (i ? dArr[i - 1] : 50) + 1 / 3 * k;
      kArr[i] = k; dArr[i] = d; jArr[i] = 3 * k - 2 * d;
    }

    // BOLL(20,2)
    const bollMid = sma(closes, 20);
    const bollUp = new Array(closes.length).fill(null);
    const bollLo = new Array(closes.length).fill(null);
    for (let i = 19; i < closes.length; i++) {
      const seg = closes.slice(i - 19, i + 1);
      const m = bollMid[i];
      const sd = Math.sqrt(seg.reduce((a, c) => a + (c - m) * (c - m), 0) / 20);
      bollUp[i] = m + 2 * sd;
      bollLo[i] = m - 2 * sd;
    }

    // ATR(14)
    const atr = new Array(closes.length).fill(null);
    let atrV = 0;
    for (let i = 1; i < closes.length; i++) {
      const tr = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
      atrV = i === 1 ? tr : (atrV * 13 + tr) / 14;
      if (i >= 14) atr[i] = atrV;
    }

    const volMa5 = sma(vols, 5), volMa10 = sma(vols, 10), volMa20 = sma(vols, 20);

    return {
      ma5, ma10, ma20, ma60, ema12, ema26, dif, dea, hist, rsi, kdjK: kArr, kdjD: dArr, kdjJ: jArr,
      bollMid, bollUp, bollLo, atr, volMa5, volMa10, volMa20
    };
  }

  /* ---------------------------- 财务数据 ---------------------------- */
  // 以 市值=PB×净资产、净利润=ROE×净资产 为锚,推导营收与历史序列,保证各指标自洽
  function genFinancials(code, mcap, template, totalShares) {
    const rng = makeRng(code + ':fin');
    const jitter = function (v, pct) { return v * (1 + (rng() * 2 - 1) * pct); };
    const roe = jitter(template.roe, 0.3);
    const debt = clamp(jitter(template.debt, 0.12), 8, 94);
    const gross = clamp(jitter(template.gross, 0.15), 4, 92);
    const net = clamp(jitter(template.net, 0.28), 1, 55);
    const pb = clamp(jitter(template.pb, 0.28), 0.35, 12);
    const payout = clamp(template.payout * (0.8 + rng() * 0.4), 0, 0.75);
    const g0 = clamp(jitter(template.growth, 0.8), -10, 45); // 营收增速中枢

    const equity = mcap / pb;                       // 净资产(元)
    const np24 = equity * roe / 100;                // 2024 净利润(元)
    const rev24 = np24 / (net / 100);               // 2024 营收(元)

    // 从 2024 倒推 2020 的增速序列
    const gList = [], nList = [];
    let rv = rev24, nv = np24;
    for (let y = 2024; y > 2020; y--) {
      const rg = clamp(g0 * (0.6 + rng() * 0.8), -25, 60);
      const ng = clamp(rg * 0.75 + gauss(rng) * 8 + 4, -40, 90);
      rv = rv / (1 + rg / 100);
      nv = nv / (1 + ng / 100);
      gList.unshift(rg); nList.unshift(ng);
    }

    const annual = [];
    let R = rv / 1e8, N = nv / 1e8; // 转为亿元
    for (let i = 0; i < 5; i++) {
      const year = 2020 + i;
      if (i > 0) {
        R = R * (1 + gList[i - 1] / 100);
        N = N * (1 + nList[i - 1] / 100);
      }
      const ocf = N * (0.75 + rng() * 0.6);
      annual.push({
        year: year,
        revenue: +R.toFixed(2),
        revenueYoY: +(i > 0 ? gList[i - 1].toFixed(2) : 0),
        netProfit: +N.toFixed(2),
        netProfitYoY: +(i > 0 ? nList[i - 1].toFixed(2) : 0),
        kfProfit: +(N * (0.85 + rng() * 0.2)).toFixed(2),
        grossMargin: +(gross + gauss(rng) * 2.5).toFixed(2),
        netMargin: +(net + gauss(rng) * 1.5).toFixed(2),
        roe: +(roe + gauss(rng) * 2).toFixed(2),
        roa: +(roe * (1 - debt / 100) * (0.8 + rng() * 0.4)).toFixed(2),
        debtRatio: +(debt + gauss(rng) * 1.8).toFixed(2),
        currentRatio: +clamp(1.6 - debt / 45 + gauss(rng) * 0.4, 0.4, 4.5).toFixed(2),
        ocf: +ocf.toFixed(2),
        eps: +(N / totalShares).toFixed(2),
        bps: +((equity / 1e8) / totalShares).toFixed(2),
        ocfps: +(ocf / totalShares).toFixed(2)
      });
    }

    // 季度(近 10 个季度,2024Q1 → 2026Q2)
    const quarterly = [];
    const qLabels = ['2024Q1', '2024Q2', '2024Q3', '2024Q4', '2025Q1', '2025Q2', '2025Q3', '2025Q4', '2026Q1', '2026Q2'];
    const revBase = annual[4].revenue;
    const npBase = annual[4].netProfit;
    const season = [0.9, 1.05, 1.0, 1.05, 0.9, 1.05, 1.0, 1.05, 0.92, 1.08];
    const qg = Math.pow(1 + g0 / 100 / 4, 1);
    for (let i = 0; i < 10; i++) {
      const growF = Math.pow(qg, i);
      const qr = revBase / 4 * season[i] * growF * (1 + gauss(rng) * 0.06);
      const qn = npBase / 4 * season[i] * growF * (1 + gauss(rng) * 0.09);
      quarterly.push({
        quarter: qLabels[i],
        revenue: +qr.toFixed(2),
        netProfit: +qn.toFixed(2),
        grossMargin: +(gross + gauss(rng) * 3).toFixed(2),
        netMargin: +(net + gauss(rng) * 2).toFixed(2),
        roe: +(roe / 4 + gauss(rng) * 1.5).toFixed(2)
      });
    }

    // 盈利连续增长年数
    let growYears = 0;
    for (let i = 1; i < annual.length; i++) {
      if (annual[i].netProfitYoY > 0) growYears++; else break;
    }

    return {
      annual: annual, quarterly: quarterly, growYears: growYears,
      pe: +(pb / (roe / 100)).toFixed(2),
      pb: +pb.toFixed(2),
      ps: +(pb / (roe / 100) * (net / 100)).toFixed(2),
      dvYield: +(payout * roe / 100 / pb * 100).toFixed(2),
      payout: +payout.toFixed(2),
      roe: +roe.toFixed(2), debt: +debt.toFixed(2),
      revYoY: +(g0 * 0.9).toFixed(2),
      npYoY: +(g0 * 0.75 + 4).toFixed(2)
    };
  }

  /* ---------------------------- 资金流 / 股东 / 新闻 / 分红 ---------------------------- */
  function genFundFlow(code, kl, ind) {
    const rng = makeRng(code + ':ff');
    const n = Math.min(30, kl.length);
    const days = [];
    let bias = (ind.ma20[n - 1] - ind.ma20[n - 8]) / ind.ma20[n - 8] * 3;
    bias = clamp(bias, -1.2, 1.2);
    for (let i = n - 20; i < n; i++) {
      const amt = kl[i].amount;
      const ratio = clamp(gauss(rng) * 0.09 + bias * 0.08, -0.25, 0.25);
      days.push({ date: kl[i].date, mainNet: Math.round(amt * ratio) });
    }
    const last = days[days.length - 1].mainNet;
    const total = days.reduce((a, d) => a + d.mainNet, 0);
    return {
      days: days,
      mainNet: last,
      mainNet5: days.slice(-5).reduce((a, d) => a + d.mainNet, 0),
      mainNetPct: +(last / kl[kl.length - 1].amount * 100).toFixed(2),
      bigNet: Math.round(last * (0.45 + rng() * 0.3)),
      superBigNet: Math.round(last * (0.3 + rng() * 0.25)),
      retailNet: -Math.round(last * (0.55 + rng() * 0.35)),
      northChgPct: +(gauss(rng) * 3 + bias * 1.5).toFixed(2)
    };
  }

  function genShareholders(code, template) {
    const rng = makeRng(code + ':sh');
    const names = ['香港中央结算有限公司', '中国证券金融股份有限公司', '中央汇金资产管理有限责任公司',
      '易方达蓝筹精选混合型证券投资基金', '华夏上证50交易型开放式指数基金', '汇添富价值精选混合型证券投资基金',
      '全国社保基金一零一组合', '全国社保基金一一八组合', '基本养老保险基金八零二组合',
      '高瓴资本管理有限公司', '林园投资管理合伙企业', '葛卫东', '陈发树', '张坤', '刘格菘', '冯柳', '赵枫'];
    const top10 = [];
    let used = 0;
    for (let i = 0; i < 10; i++) {
      const pct = +(Math.max(0.4, 18 - i * 1.6) * (0.5 + rng() * 0.9)).toFixed(2);
      top10.push({
        name: i === 0 && template.debt > 80 ? '香港中央结算有限公司' : pick(rng, names),
        pct: pct,
        change: +(gauss(rng) * 0.6).toFixed(2)
      });
      used += pct;
    }
    return {
      holderCount: +(8 + rng() * 60).toFixed(1), // 万户
      holderChgPct: +(gauss(rng) * 5).toFixed(2),
      instPct: +(12 + rng() * 45).toFixed(2),
      fundPct: +(5 + rng() * 30).toFixed(2),
      northPct: +(2 + rng() * 18).toFixed(2),
      top10: top10
    };
  }

  const NEWS_TEMPLATES = [
    { t: '{n}:前三季度净利润同比增长{p}%,超出市场预期', s: '+', type: '业绩' },
    { t: '{n}发布公告,拟以自有资金回购股份{amt}亿元,彰显长期信心', s: '+', type: '公告' },
    { t: '多家券商发布研报,维持{n}「买入」评级,目标价上调至{v}元', s: '+', type: '研报' },
    { t: '{n}与行业龙头签署战略合作协议,拓展{kw}业务', s: '+', type: '合作' },
    { t: '{n}中标重大项目,合同金额约{amt}亿元', s: '+', type: '中标' },
    { t: '行业政策利好:{kw}产业迎来新一轮政策支持窗口', s: '+', type: '行业' },
    { t: '{n}获北向资金连续{n2}日净买入,累计净流入约{amt}亿元', s: '+', type: '资金' },
    { t: '{n}大股东承诺未来{n2}个月内不减持公司股份', s: '+', type: '股东' },
    { t: '{n}发布业绩快报:全年营收{amt}亿元,同比增长{p}%', s: '+', type: '业绩' },
    { t: '{n}回应市场关切,公司经营情况正常,订单充足', s: '+', type: '公告' },
    { t: '{n}部分股东计划减持不超过{amt}%股份', s: '-', type: '股东' },
    { t: '行业竞争加剧,{kw}环节价格持续下行,{n}毛利率承压', s: '-', type: '行业' },
    { t: '{n}收到交易所问询函,关注{kw}相关事项', s: '-', type: '监管' },
    { t: '市场担忧{n}下游需求不及预期,股价短期承压', s: '-', type: '行业' },
    { t: '{n}公告:子公司涉及诉讼事项,金额影响待评估', s: '-', type: '风险' },
    { t: '{n}限售股解禁公告,解禁市值约{amt}亿元', s: '-', type: '股东' },
    { t: '{n}:行业景气度回升,{kw}需求回暖,产能利用率提升', s: '0', type: '行业' },
    { t: '{n}召开年度股东大会,审议通过利润分配方案', s: '0', type: '公告' },
    { t: '{n}入选{kw}指数成分股,将于下月生效', s: '0', type: '公告' },
    { t: '机构调研:{n}本周接待{n2}家机构调研,聚焦{kw}业务进展', s: '0', type: '机构' }
  ];

  const NEWS_SOURCES = ['财联社', '上海证券报', '证券时报', '第一财经', '中国证券报', '公司公告', '界面新闻', '每日经济新闻'];

  function genNews(code, name, industry, concepts) {
    const rng = makeRng(code + ':news');
    const kw = concepts[0];
    const n = randInt(rng, 8, 14);
    const items = [];
    const usedTitles = {};
    for (let i = 0; i < n; i++) {
      let tpl = pick(rng, NEWS_TEMPLATES);
      let title = tpl.t
        .replace(/\{n\}/g, name)
        .replace(/\{kw\}/g, kw)
        .replace(/\{p\}/g, String(randInt(rng, 8, 85)))
        .replace(/\{amt\}/g, String(randInt(rng, 1, 60)))
        .replace(/\{v\}/g, String(randInt(rng, 20, 300)))
        .replace(/\{n2\}/g, String(randInt(rng, 3, 20)));
      if (usedTitles[title]) { i--; continue; }
      usedTitles[title] = 1;
      const daysAgo = randInt(rng, 0, 29);
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      const hh = String(randInt(rng, 8, 20)).padStart(2, '0');
      const mm = String(randInt(rng, 0, 59)).padStart(2, '0');
      items.push({
        id: code + '-n' + i,
        date: toISO(d),
        time: hh + ':' + mm,
        title: title,
        source: pick(rng, NEWS_SOURCES),
        sentiment: tpl.s,
        type: tpl.type,
        url: '#'
      });
    }
    items.sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
    return items;
  }

  function genDividends(code, profitable) {
    const rng = makeRng(code + ':div');
    const years = [2020, 2021, 2022, 2023, 2024];
    return years.map(function (y) {
      const per10 = profitable ? +(rand(rng, 1.5, 35)).toFixed(1) : 0;
      return {
        year: y,
        per10: per10,
        plan: per10 > 0 ? '每10股派' + per10 + '元(含税)' : '不派发现金红利',
        exDate: y + '-0' + randInt(rng, 5, 7) + '-' + String(randInt(rng, 10, 28)).padStart(2, '0')
      };
    });
  }

  /* ---------------------------- 个股构建 ---------------------------- */
  function buildStock(spec) {
    const code = spec.code;
    const status = STATUS_RULES[code] || '正常';
    const tpl = IND_TEMPLATES[spec.industry] || IND_TEMPLATES['食品饮料'];
    const rng = makeRng(code + ':quote');
    const sizeMcap = { '巨': 1, '大': 0.42, '中': 0.11, '小': 0.028 }[spec.size] || 0.05; // 万亿
    const totalShares = Math.round(sizeMcap * 1e12 / spec.base / 1e8); // 亿股
    const kline = genKline(code, 320, spec.base, tpl.vol, tpl.drift);
    const ind = calcIndicators(kline);
    const n = kline.length;
    const last = kline[n - 1];
    const prev = kline[n - 2];
    const suspended = status === '停牌';

    // 今日行情
    let chgPct;
    if (suspended) {
      chgPct = 0;
    } else {
      const cap = code.startsWith('688') || code.startsWith('300') ? 19.5 : 9.8;
      let c = gauss(rng) * 2.4 + tpl.drift * 250;
      if (rng() < 0.07) c = c > 0 ? c + rand(rng, 3, 9) : c - rand(rng, 3, 9);
      chgPct = clamp(c, -cap, cap);
      if (status === 'ST') chgPct = clamp(chgPct, -4.8, 4.8);
    }
    const price = +(prev.close * (1 + chgPct / 100)).toFixed(2);
    const open = suspended ? price : +(prev.close * (1 + gauss(rng) * 0.008)).toFixed(2);
    const hi = suspended ? price : +(Math.max(open, price) * (1 + Math.abs(gauss(rng)) * 0.01)).toFixed(2);
    const lo = suspended ? price : +(Math.min(open, price) * (1 - Math.abs(gauss(rng)) * 0.01)).toFixed(2);
    const vMult = 1 + Math.abs(chgPct) / 9.8 * 2.2;
    const volume = suspended ? 0 : Math.round(last.volume * vMult * (0.7 + rng() * 0.8));
    const amount = suspended ? 0 : Math.round(volume * 100 * price);
    const mcap = +(price * totalShares * 1e8).toFixed(0);
    const fin = genFinancials(code, mcap, tpl, totalShares);
    const floatPct = 0.55 + rng() * 0.4;
    const turnover = +(volume * 100 / (totalShares * 1e8 * floatPct) * 100).toFixed(2);
    const volRatio = +(volume / (ind.volMa5[n - 1] || volume)).toFixed(2);
    const amplitude = suspended ? 0 : +((hi - lo) / prev.close * 100).toFixed(2);
    const high52 = Math.max.apply(null, kline.slice(-250).map(b => b.high));
    const low52 = Math.min.apply(null, kline.slice(-250).map(b => b.low));
    const high60 = Math.max.apply(null, kline.slice(-60).map(b => b.high));

    const fundFlow = genFundFlow(code, kline, ind);
    const shareholders = genShareholders(code, tpl);
    const news = genNews(code, spec.name, spec.industry, spec.concepts);
    const dividends = genDividends(code, fin.netProfit > 0);

    // 连涨/连跌
    let upDays = 0, downDays = 0;
    for (let i = n - 1; i > 0; i--) {
      if (kline[i].close >= kline[i - 1].close) { upDays++; if (downDays) break; }
      else { downDays++; if (upDays) break; }
    }
    const upStreak = upDays > downDays ? upDays : 0;
    const downStreak = downDays >= upDays ? downDays : 0;

    const stock = {
      code: code,
      name: spec.name,
      py: pinyinOf(spec.name),
      market: marketOf(code),
      industry: spec.industry,
      concepts: spec.concepts,
      listDate: (2001 + randInt(rng, 0, 20)) + '-' + String(randInt(rng, 1, 12)).padStart(2, '0') + '-' + String(randInt(rng, 1, 28)).padStart(2, '0'),
      desc: spec.name + '是国内' + spec.industry + '行业领先企业,主营' + spec.concepts.slice(0, 3).join('、') + '相关业务,具备较强的品牌与渠道优势。(演示简介)',
      status: status,
      totalShares: totalShares,
      floatPct: +floatPct.toFixed(2),
      size: spec.size,
      quote: {
        price: price, chg: +(price - prev.close).toFixed(2), chgPct: +chgPct.toFixed(2),
        open: open, high: hi, low: lo, prevClose: prev.close,
        volume: volume, amount: amount, turnover: turnover, volRatio: volRatio,
        amplitude: amplitude, pe: fin.pe, pb: fin.pb, ps: fin.ps, dvYield: fin.dvYield,
        mcap: mcap, fcap: Math.round(mcap * floatPct),
        high52: high52, low52: low52,
        high60: high60,
        upStreak: upStreak, downStreak: downStreak,
        limitUp: chgPct >= 9.7, limitDown: chgPct <= -9.7
      },
      kline: kline,
      ind: ind,
      fin: fin,
      fundFlow: fundFlow,
      shareholders: shareholders,
      news: news,
      dividends: dividends
    };
    return stock;
  }

  /* ---------------------------- 指数 ---------------------------- */
  function buildIndices() {
    const specs = [
      ['000001', '上证指数', 3400, 0.0075, 0.00025, '沪市'],
      ['399001', '深证成指', 10500, 0.0095, 0.0002, '深市'],
      ['399006', '创业板指', 2180, 0.0115, 0.00025, '深市'],
      ['000688', '科创50', 985, 0.0130, 0.0003, '沪市'],
      ['000300', '沪深300', 3950, 0.0080, 0.0002, '跨市场'],
      ['000905', '中证500', 5650, 0.0095, 0.00015, '跨市场']
    ];
    return specs.map(function (s) {
      const rng = makeRng(s[0] + ':idx');
      const kline = genKline(s[0] + 'I', 130, s[2], s[3], s[4]);
      const last = kline[kline.length - 1], prev = kline[kline.length - 2];
      const chgPct = clamp(gauss(rng) * 0.9 + s[4] * 130, -2.5, 2.5);
      const close = +(prev.close * (1 + chgPct / 100)).toFixed(2);
      return {
        code: s[0], name: s[1], market: s[4],
        kline: kline,
        quote: {
          price: close, chg: +(close - prev.close).toFixed(2), chgPct: +chgPct.toFixed(2),
          amount: Math.round(rand(rng, 3500, 9500) * 1e8)
        }
      };
    });
  }

  /* ---------------------------- 构建全部 ---------------------------- */
  let _cache = null;

  function buildAll() {
    if (_cache) return _cache;
    const byCode = {};
    const list = STOCKS.map(buildStock);
    list.forEach(function (s) { byCode[s.code] = s; });
    const indices = buildIndices();
    _cache = { list: list, byCode: byCode, indices: indices };
    return _cache;
  }

  /* ---------------------------- 市场概览 ---------------------------- */
  function marketOverview() {
    const { list } = buildAll();
    let up = 0, down = 0, flat = 0, limitUp = 0, limitDown = 0, amount = 0, mainNet = 0;
    list.forEach(function (s) {
      if (s.status === '停牌') { flat++; return; }
      const c = s.quote.chgPct;
      if (c > 0) up++; else if (c < 0) down++; else flat++;
      if (s.quote.limitUp) limitUp++;
      if (s.quote.limitDown) limitDown++;
      amount += s.quote.amount;
      mainNet += s.fundFlow.mainNet;
    });
    const total = up + down + flat;
    return {
      up: up, down: down, flat: flat, total: total,
      upPct: +(up / total * 100).toFixed(1), downPct: +(down / total * 100).toFixed(1),
      limitUp: limitUp, limitDown: limitDown,
      amount: amount, mainNet: mainNet,
      breadth: +(up / total * 100).toFixed(1)
    };
  }

  function topRank(key, n) {
    const { list } = buildAll();
    return list.filter(s => s.status !== '停牌')
      .slice()
      .sort(function (a, b) { return b.quote[key] - a.quote[key]; })
      .slice(0, n);
  }

  function sectors() {
    const { list } = buildAll();
    const map = {};
    list.forEach(function (s) {
      if (s.status === '停牌') return;
      if (!map[s.industry]) map[s.industry] = { name: s.industry, chg: 0, count: 0, amount: 0, up: 0 };
      const sec = map[s.industry];
      sec.chg += s.quote.chgPct;
      sec.count++;
      sec.amount += s.quote.amount;
      if (s.quote.chgPct > 0) sec.up++;
    });
    return Object.keys(map).map(function (k) {
      const m = map[k];
      m.chg = +(m.chg / m.count).toFixed(2);
      return m;
    }).sort(function (a, b) { return b.chg - a.chg; });
  }

  /* ---------------------------- 搜索 ---------------------------- */
  function search(q) {
    const { list } = buildAll();
    const s = (q || '').trim().toUpperCase();
    if (!s) return [];
    return list.filter(function (st) {
      return st.code.indexOf(s) >= 0 ||
        st.name.indexOf(s) >= 0 ||
        st.py.indexOf(s) >= 0 ||
        st.industry.indexOf(s) >= 0 ||
        st.concepts.some(c => c.indexOf(s) >= 0);
    }).slice(0, 10);
  }

  function getStock(code) {
    return buildAll().byCode[code] || null;
  }

  /* ---------------------------- 导出 ---------------------------- */
  const api = {
    NOW, TODAY_ISO, DATA_TIME, LAST_TRADING_DAY, TRADING_DAYS,
    buildAll, getStock, search, marketOverview, topRank, sectors,
    buildIndices, calcIndicators,
    fmtMoney, fmtNum, fmtPct, fmtBig,
    clamp, randInt, makeRng,
    IND_TEMPLATES,
    pool: STOCKS, marketOf: marketOf,
    _setDataTime: function (t) { api.DATA_TIME = t; }
  };
  root.QP = root.QP || {};
  root.QP.data = api;
})(typeof window !== 'undefined' ? window : globalThis);
