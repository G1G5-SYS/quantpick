# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与
[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- **安全**：静态托管路径越界读取。路径守卫原用字符串前缀判断（`fp.startsWith(ROOT)`），
  兄弟路径会被误判为合法，`GET /..%2fquantpick-*.zip` 曾能读到**应用目录之外**的文件；
  现要求 `fp === ROOT` 或以 `ROOT + 路径分隔符` 开头。
- **安全**：`.git` 元数据对外可读（`/.git/config`、`/.git/objects/*`），可被用于还原完整提交历史；
  静态托管现屏蔽 `.git/`、`.env`、`.npmrc` 及 `deploy/`、`*.sh`、`*.zip` 等部署产物。
- 畸形请求路径（如 `GET /%`）不再返回 500，改为明确的 400。
- `/api/overview` 缺少 `upPct` / `downPct`，导致大盘 KPI 显示"占比 undefined%"。
- `/api/indices` 缺少 `market` 字段，导致指数卡片右上角显示 `undefined`。

### 新增

- `_smoke/static-guard.js`：静态资源安全守卫回归测试（越界读取、`.git` 暴露、畸形编码）。
- `_smoke/api-fields.js`：接口字段契约测试，把"界面会渲染的字段"固化为断言。
- `.github/workflows/ci.yml`：push / PR 自动跑离线套件（不依赖外部数据源）；
  真实数据全量回归可手动触发。
- `CONTRIBUTING.md`、`SECURITY.md`、`.github` Issue / PR 模板、`.editorconfig`。
- `docs/RELEASING.md`：发布流程（打 tag、上传桌面版到 Releases、部署校验）。

### 变更

- `_smoke/package.json`：补全描述与 `license: MIT`，修正 `npm test`（原为脚手架默认的
  `exit 1`，谁跑谁失败）；新增 `test:offline` / `test:isolated`。
- README：修正 clone 地址占位符、补全测试套件说明与 Node 版本要求、补 CI 徽章、
  说明桌面版二进制通过 Releases 分发。

## [1.0.0] - 2026-09-13

首次开源。

### 特性

- **行情与榜单**：大盘晴雨表（指数 / 涨跌家数 / 涨停跌停 / 成交额 / 主力净流入 / 市场温度 / 板块涨跌）、
  榜单中心（涨跌幅 / 成交额 / 换手 / 量比 Top200 + AI 评估榜）、行情中心（全市场行情表）
- **条件选股**：AND / OR / NOT 组合、40 余个字段、策略保存与 CSV 导出
- **AI 智能分析**：预测选股（上涨概率 P5/P10/P20、预期收益、超额收益、预期回撤、综合评分）
  + 个股六维评分诊断 + AI 对话
- **回测与复盘**：策略回测（含蒙特卡洛回撤分布、窗口稳健性分析）、预测台账与累计胜率
- **其它**：自选股分组管理、消息提醒（价格与涨跌预警）、系统设置（红涨绿跌切换、数据源状态）

### 技术特点

- 零依赖：后端只用 Node 内置模块，无 `package.json`、无 `node_modules`、无构建、无数据库
- 只用真实数据：东方财富 + 腾讯公开接口，接口不可用时明确报错，不展示模拟数据
- 多源兜底 + 熔断；全市场磁盘快照（冷启动 4.5s → 73ms）；gzip 与 ETag/304
- 预测按真实交易日历锁定、快照存服务端、收盘后自动复盘
- 自带回归测试（jsdom 驱动真实页面与数据服务）

[Unreleased]: https://github.com/G1G5-SYS/quantpick/commits/main
[1.0.0]: https://github.com/G1G5-SYS/quantpick/releases/tag/v1.0.0
