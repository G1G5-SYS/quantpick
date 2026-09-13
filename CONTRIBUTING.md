# 参与贡献

感谢你对 QuantPick 感兴趣。这是一个**跑起来只要 `node server.js`** 的 A 股研究工具，
所以贡献方式也围绕这个定位展开。

## 两条硬约束

提交代码前请先确认这两条 —— 它们不是偏好，是项目的立身之本：

1. **应用本体零依赖**：`server.js` 只用 Node 内置模块（`http` / `fs` / `path` / `zlib` / `dns` / `crypto`），
   前端只用浏览器原生 API（图表库 ECharts 已内置在 `js/vendor/`）。
   **不接受**为应用本体引入任何运行时 npm 包 —— 一旦引入，`git clone && node server.js` 就不再成立。
   测试依赖（`_smoke/` 下的 jsdom）不受此限制。
2. **只用真实数据**：数据来自东方财富 / 腾讯公开接口。接口不可用时页面必须**明确报错**，
   **绝不允许**退化成模拟数据、随机数据或"演示数据"。这条比"页面好看"重要得多。

## 环境要求

| 用途 | 要求 |
|---|---|
| 运行应用本体 | Node.js 16+ |
| 运行测试 | Node.js 22.22.2+ / 24.15+（jsdom 30 的运行时要求） |

## 本地跑起来

```bash
git clone https://github.com/G1G5-SYS/quantpick.git
cd quantpick
node server.js          # 浏览器打开 http://127.0.0.1:8090
```

Windows 上也可以双击 `start.bat`。**必须通过 `server.js` 访问**（它同时托管前端并代理数据接口），
直接双击 `index.html` 无法连接数据服务。

`test.html` 是开发辅助页：它预置了登录会话与设置，方便直接调试某个页面而不必每次走登录流程。

## 目录职责

| 路径 | 职责 |
|---|---|
| `server.js` | 零依赖数据服务：静态托管 + `/api/*` 聚合代理 + 交易日历 + 预测台账 |
| `js/data.js` | 数据层与格式化 |
| `js/real.js` | 真实数据接入（行情 / 榜单 / 全市场 / K线缓存 / 日历 / 台账同步） |
| `js/screener.js` | 条件选股引擎 |
| `js/ai.js` | 六维评分引擎 |
| `js/predict.js` | 预测引擎 + 快照 + 复盘 + 累计胜率 |
| `js/backtest.js` | 回测引擎 + 蒙特卡洛 + 窗口稳健性 |
| `js/app.js` | 应用外壳：路由 / 页面 / 图表 / 交互 |
| `css/style.css` | 设计系统（深海蓝金主题） |
| `website/index.html` | 官网（纯静态，可与应用同域部署） |
| `deploy/` | 部署文档与脚本 |
| `_smoke/` | 回归测试 |

## 测试

```bash
cd _smoke
npm ci                    # 只装 jsdom

npm test                  # 离线套件(不依赖数据服务,任何环境都能跑)
npm run test:isolated     # 全量回归:独立端口 8091 + 独立数据目录,自动启停被测服务
```

- 隔离运行器会**另起一个实例**（端口 8091 + `_smoke/_data`），不会碰你正在用的预测台账；
  只想跑几个套件时用 `-Suites`：
  ```powershell
  powershell -ExecutionPolicy Bypass -File run-isolated.ps1 -Suites "run.js,api-fields.js"
  ```
- 改 `_smoke/` 下的脚本时注意：**`.ps1` 必须是纯 ASCII**（Windows PowerShell 5.1 会把无 BOM 的 .ps1 当 ANSI 读，
  中文注释会导致解析失败）。`run-isolated.ps1` 头部有同样的提示。

### 两类必须补测试的改动

1. **界面会渲染的接口字段有增减** → 补 `_smoke/api-fields.js` 的字段契约断言。
   背景：界面会把接口字段直接拼进 HTML，字段一缺就显示 `undefined`（历史上出现过
   `占比 undefined%` 与指数卡片 `undefined`）。
2. **静态托管 / 路径处理有改动** → 补 `_smoke/static-guard.js` 的断言。
   背景：曾出现越界读取（`/..%2f` 可读到应用目录之外的文件）与 `.git` 元数据暴露。

## 代码风格

- 原生 JavaScript，无构建步骤、无框架、无转译；浏览器端代码要能直接 `eval` 进 jsdom 跑测试。
- 2 空格缩进；注释用中文，说明**为什么**这么做，而不是复述代码在做什么。
- 页面结构目前由 `js/app.js` 里的字符串模板生成，样式优先写进 `css/style.css`（设计系统），
  布局类内联样式保持最少。
- 新增文案请与现有语气一致；涉及 A 股习惯的颜色必须保持**红涨绿跌**（可在设置中切换）。

## 数据源相关改动

- 保持"多主机兜底 + 熔断"的既有结构，新增接口请沿用 `fetchText` / `fetchJSON` 的重试与主机列表参数。
- 不要提高抓取频率；新接口请走 `cached()` 缓存，注意各接口既有 TTL。
- 新字段可能缺失：渲染前必须兜底（显示 `--`），不要让 `undefined` 出现在界面上。

## 提交信息

沿用现有风格：`type(scope): 说明`，说明用中文。

```
feat(predict): 新增 P20 概率分档展示
fix(api): /api/ranks 缺字段导致表头显示 undefined
docs(readme): 补充桌面版发布说明
chore(ci): 增加离线套件工作流
```

## PR

请使用 PR 模板里的自查清单。涉及界面改动请附截图；涉及数据接口变动请说明验证方式
（是否在真实数据下跑过 `npm run test:isolated`）。

## 不要提交的内容

`.cache/`、`_smoke/_data/`、证书与私钥（`*.pem` / `*.key` / `cert/`）、桌面版二进制
（`*.exe` / `desktop.zip` —— 它们走 GitHub Releases，不进仓库）。`.gitignore` 已经覆盖这些。
