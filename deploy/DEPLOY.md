# QuantPick 公网部署指南（让 https 链接直接打开软件）

## 0. 为什么"只能看到网站，不能打开软件"？

- **官网**（`website/`）是纯静态页面 —— 任何静态托管（EdgeOne Pages、COS、GitHub Pages…）都能显示 ✅
- **软件本体**（`/` 的 index.html）是 **Node 数据服务驱动的应用**：它依赖 `server.js` 提供的 `/api/*` 接口
  （行情 / K线 / 财务 / 资金 / 新闻，实时代理到东方财富 + 腾讯）。
  纯静态托管**无法运行 Node 服务**，所以应用打开后要么 404、要么显示"数据服务未连接" ❌

**结论：要让公网链接打开软件，必须把应用部署到能运行 Node.js 的环境（国内地域，因为数据源是东方财富/腾讯）。**

---

## 方案 A（推荐）：云服务器部署完整应用 + EdgeOne 反代

任何国内云服务器（腾讯云轻量应用服务器 / CVM、阿里云 ECS 均可，最便宜套餐就够）。

### 步骤 1：上传代码并安装 Node
```bash
# 服务器上（以 Ubuntu/CentOS 为例）
curl -fsSL https://deb.nodesource.com/setup_18.x | bash - && apt-get install -y nodejs
# 或访问 https://nodejs.org 下载 Linux 二进制解压

# 上传 quantpick 目录到服务器,如 /opt/quantpick
scp -r quantpick root@你的服务器IP:/opt/
cd /opt/quantpick
node --version   # 应 >= 16
```

### 步骤 2：pm2 守护运行（崩溃自动重启）
```bash
npm i -g pm2
pm2 start deploy/ecosystem.config.js
pm2 save && pm2 startup   # 开机自启(按提示执行输出命令)
```
默认监听 `8090`（可用 `PORT=80 pm2 start ...` 改端口）。

> 💡 **一键部署（Ubuntu）**：`sudo bash deploy/setup-ubuntu.sh` 自动完成 安装 Node/pm2/nginx → pm2 启动 → Nginx 反代 → 部署自检。
> 绑定域名: `sudo DOMAIN=your-domain.com bash deploy/setup-ubuntu.sh`

### 步骤 3：部署自检（可重复执行）
```bash
node deploy/check.js                 # 默认检查 http://127.0.0.1:8090
node deploy/check.js http://127.0.0.1:PORT
```
9 项全 PASS 即部署正常（Node 版本 / 数据服务 / 应用本体 / 官网 / 真实行情 / 全市场 /
静态守卫三项）。最后三项是**公网部署必查项**，应全部为 403：

| 检查 | 期望 | 说明 |
|---|---|---|
| `/server.js` | 403 | 服务器源码不外泄 |
| `/.git/config` | 403 | 版本库元数据不外泄（否则可还原完整提交历史） |
| `/..%2f..%2fetc%2fpasswd` | 403 | 拒绝路径穿越 |

若这三项返回 200，说明跑的还是旧版 `server.js`，请更新后重启：`pm2 restart quantpick`。

### 步骤 4：Nginx 反代（绑定域名 / HTTPS 证书）
```bash
apt-get install -y nginx
cp deploy/nginx-quantpick.conf /etc/nginx/conf.d/quantpick.conf
# 编辑该文件,把 server_name 换成你的域名
nginx -t && systemctl reload nginx
# 证书可用 certbot: apt-get install -y certbot python3-certbot-nginx && certbot --nginx -d 你的域名
```

### 步骤 4：EdgeOne 指向源站（可选，用你自己的 EdgeOne 域名）
在 EdgeOne 控制台把域名源站配置为「**源站类型: 自建源站 / 域名回源**」→ 回源地址填 `你的服务器IP:80`（或 443）。
之后 `https://你的域名/` 就是**软件本体**，`https://你的域名/website/` 是官网。

### 验证
```
curl http://127.0.0.1:8090/api/ping   # 服务器上应返回 {"ok":true,...}
浏览器打开 https://你的域名/          # 应看到登录页/应用,数据正常
```

---

## 方案 B：Vercel（免费，海外节点——数据源可能受限，不推荐国内行情）

server.js 已重构为可导入：`const { handle } = require('./server.js')`。
```js
// api/[...path].js (Vercel)
const { handle } = require('../server.js');
module.exports = async (req, res) => { await handle(req, res); };
```
> ⚠️ Vercel 函数在海外执行，访问东方财富/腾讯接口可能超时或失败，国内行情数据不建议用 Vercel。

## 方案 C：腾讯云函数 SCF / EdgeOne 边缘函数（国内地域，进阶）
把 `server.js` 部署为函数（API 网关触发），前端静态部署到 COS/EdgeOne Pages。
需要把 API 网关事件转换为 `(req, res)` 再调用 `handle`（见 SCF 文档"API 网关自定义集成响应"）。
> 若函数执行时间受限（首次拉全市场约 5~20 秒），建议用「事件+预热的并发实例」或改用轻量服务器（方案 A 最省事）。

---

## 端口 / 防火墙速查
| 场景 | 端口 |
|---|---|
| 本地运行 | 8090（默认，无需改） |
| 服务器直跑 | `PORT=80 node server.js` 或 pm2 配置 |
| Nginx 反代 | 8090 仅监听 127.0.0.1；对外 80/443 |
| 云安全组 | 放行 80/443（及测试用的 8090） |

## 已提供文件
- `deploy/ecosystem.config.js` — pm2 守护配置
- `deploy/nginx-quantpick.conf` — Nginx 反代示例（含 /website 说明）
- `server.js` — 已重构:本地 `node server.js` 不变,同时 `module.exports = { handle, startServer }` 供云函数复用
