/* 测试隔离辅助:统一解析被测服务地址。
 * 目的:UI 测试会真实创建/推送预测快照,若指向共享实例会污染台账并造成测试间干扰。
 * 用法:先以独立数据目录启动测试实例,再设置 QP_TEST_BASE 运行测试。
 *   $env:QP_DATA_DIR="...\_smoke\_data"; $env:PORT=8091; node server.js
 *   $env:QP_TEST_BASE="http://127.0.0.1:8091"; node predict-ui.js
 */
'use strict';
module.exports = {
  BASE: process.env.QP_TEST_BASE || 'http://127.0.0.1:8090',
  /* 是否处于隔离实例(用于测试中跳过会污染共享台账的写操作) */
  ISOLATED: !!process.env.QP_TEST_BASE
};
