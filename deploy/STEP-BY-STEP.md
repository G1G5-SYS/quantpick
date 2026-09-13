# QuantPick 公网部署 · 逐步操作手册（路径 A：云服务器）

> **本文档适用于 Linux 服务器（Ubuntu + pm2）。**
> 如果你的服务器是 **Windows Server**，请改看 [`WINDOWS.md`](WINDOWS.md) —— 主要差别在"用计划任务守护进程"，
> 且必须避开 `start /b` 被任务回收、`taskkill /F /IM node.exe` 误杀等坑。

> 目标：让 `https://你的域名/` 直接打开软件（行情/AI预测等全部可用）。
> 适用：Ubuntu 22.04/24.04 云服务器 + Windows 本地电脑。
> 全程约 20 分钟。任何一步卡住，把终端输出截图发回即可。

---

## 第 0 步：准备（5 分钟）

| 需要 | 说明 |
|---|---|
| ☑ 云服务器 | 腾讯云轻量应用服务器 / CVM / 阿里云 ECS 均可，**最低配就够**（2C2G）。系统镜像选 **Ubuntu 22.04**。**必须国内地域**（数据源是东方财富/腾讯） |
| ☑ 域名（可选） | 若想用 `https://你的域名/` 需要域名；没有域名可先用 `http://服务器IP:8090/` 测试 |
| ☑ 部署包 | `quantpick-deploy.zip`（已生成，475KB，含全部代码，零依赖） |

**服务器安全组放行端口**（云控制台操作）：
- 必须放行：`80`（HTTP）、`443`（HTTPS）
- 测试期可临时放行：`8090`（应用端口）
- 若用腾讯云轻量，在「防火墙」页放行；阿里云在「安全组」页放行

---

## 第 1 步：上传部署包并解压（5 分钟）

### 方式 A：Windows 终端 scp（最简单，无需装软件）
打开 Windows PowerShell，执行（把 IP 换成你的服务器公网 IP）：
```powershell
scp C:\path\to\quantpick-deploy.zip root@你的服务器IP:/root/
```
输入服务器 root 密码，等待上传完成（几秒）。

### 方式 B：宝塔面板 / FileZilla
- 宝塔：文件 → 上传到 `/root/`
- FileZilla：主机填 IP，用户 root，端口 22，拖入文件

### 服务器上解压
SSH 登录服务器（Windows PowerShell 执行 `ssh root@你的服务器IP`，输入密码）：
```bash
cd /root
unzip -o quantpick-deploy.zip -d /opt/
ls /opt/quantpick          # 应看到 css js website deploy server.js index.html ...
node --version             # 若提示未找到命令,执行第 2 步的安装(脚本会自动装)
```

---

## 第 2 步：一键部署（3 分钟）

```bash
cd /opt/quantpick
sudo bash deploy/setup-ubuntu.sh
```

脚本自动完成：安装 Node 18 → 安装 pm2 → 安装 nginx → pm2 启动应用（端口 8090）→ 配置 nginx 反代 → 运行部署自检。

**预期输出（最后一段）**：
```
================ QuantPick 部署自检(http://127.0.0.1:8090) ================
PASS | Node 版本 >= 16
PASS | 数据服务 /api/ping
PASS | 应用本体 / (含 #app)
PASS | 官网 /website/
PASS | 真实行情 /api/quote(600519)
PASS | 全市场 /api/market-all
PASS | 静态守卫 /server.js 应为 403
PASS | 静态守卫 /.git/config 应为 403
PASS | 静态守卫 路径穿越 应为 403
总计:9 项,失败:0
✔ 部署正常
```

> 若 `npm i -g pm2` 报权限错误：先 `sudo -i` 进入 root 再执行脚本，或改用 `sudo npm i -g pm2`。
> 若 apt 安装慢：换国内镜像源（腾讯云/阿里云源），或稍等重试。

---

## 第 3 步：本地验证（2 分钟）

1. 浏览器打开 `http://你的服务器IP:8090/` → 应看到**登录页**（QuantPick 牛股智选），点「一键体验演示账号」进入
2. 进「大盘晴雨表」「AI 预测选股」看行情/预测是否正常（数据来自东方财富真实接口）
3. 服务器上可再跑一次自检：`cd /opt/quantpick && node deploy/check.js`

**如果 8090 打不开**：
- 确认安全组/防火墙放行了 8090（第 0 步）
- 服务器内自测：`curl http://127.0.0.1:8090/api/ping` → 返回 `{"ok":true,...}` 说明服务正常，问题在防火墙/安全组

---

## 第 4 步：绑定域名 + HTTPS（可选，推荐 5 分钟）

### 4.1 域名解析
在域名服务商（阿里云/腾讯云 DNS）添加记录：
- 类型 `A`，主机记录 `@`（及 `www`），值 = 服务器公网 IP

### 4.2 HTTPS 证书（nginx 已配置好，只需签证书）
```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名 -d www.你的域名
```
按提示选「重定向 HTTP 到 HTTPS」。证书到期自动续期（certbot 自带定时任务）。

### 4.3 验证
浏览器打开 `https://你的域名/` → 应看到软件登录页，数据正常。

---

## 第 5 步：接入 EdgeOne 加速（可选）

若想让域名走 EdgeOne（CDN 加速 + 防护）：
1. EdgeOne 控制台 → 添加站点 → 填你的域名
2. 按提示把域名 DNS 切到 EdgeOne（NS 记录改为 EdgeOne 提供的）
3. 添加「源站」：类型选 **自建源站 / 域名回源**，回源地址填 `你的服务器IP:80`
4. 等 DNS 生效（几分钟），访问 `https://你的域名/`

> ⚠️ 注意：EdgeOne Pages / COS 等平台分配的默认子域名属于**纯静态托管**，
> **不能承载 Node 数据服务**——这通常是"只能看到官网、打不开软件"的原因。软件本体必须跑在能执行 Node 的服务器上。

---

## 第 6 步：日常运维

| 操作 | 命令 |
|---|---|
| 查看应用状态 | `pm2 status` |
| 查看日志 | `pm2 logs quantpick` |
| 重启应用 | `pm2 restart quantpick` |
| 停止应用 | `pm2 stop quantpick` |
| 开机自启 | `pm2 startup`（按提示执行输出命令）+ `pm2 save` |
| 换端口（如 80） | `PORT=80 pm2 restart quantpick --update-env` |

### 更新到新版本（不用登录服务器）

在本地 `quantpick` 目录执行一条命令：它会自动上传更新包 → 从 pm2 读出真实应用目录 →
备份 `server.js` → 解压覆盖 → 重启 → 跑一次部署自检。

```powershell
# 先预演（只打印将要执行的命令，不连服务器）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/push-update.ps1 -Server 你的服务器IP -DryRun

# 真正执行（会提示输入两次密码）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/push-update.ps1 -Server 你的服务器IP
```

> 若提示 `pm2 process 'quantpick' not found`，用 `pm2 list` 看实际进程名，再加 `-Pm2Name <名字>`。
> 想免密码：`ssh-copy-id root@你的服务器IP` 执行一次即可。

---

## 常见问题排查

| 现象 | 原因与处理 |
|---|---|
| `curl http://127.0.0.1:8090/api/ping` 通，外网打不开 | 安全组/云防火墙未放行端口 |
| 页面显示"数据服务未连接" | server.js 没起来：`pm2 status` 看是否 online；`pm2 logs` 看报错 |
| 行情偶尔加载慢/失败 | 东财接口限流，系统会自动熔断切换备用源（push2delay/腾讯），稍等自动恢复 |
| 首次打开「AI 预测选股」全市场加载慢 | 首次拉取全市场 5899 只约 5~20 秒，之后走缓存（2 分钟） |
| certbot 报"域名未解析" | 先确认 DNS A 记录已生效：`nslookup 你的域名` |
| pm2 找不到命令 | `sudo npm i -g pm2` 后再 `hash -r` |

---

## 部署包文件清单（/opt/quantpick）

```
quantpick/
├─ server.js                 # 数据服务(已重构:本地运行不变,可导出给云函数)
├─ index.html / css/ / js/   # 软件本体(应用)
├─ website/                  # 官网(纯静态)
└─ deploy/
   ├─ setup-ubuntu.sh        # 一键部署脚本
   ├─ check.js               # 部署自检(6 项)
   ├─ ecosystem.config.js    # pm2 守护配置
   ├─ nginx-quantpick.conf   # Nginx 反代配置
   └─ DEPLOY.md              # 部署文档
```
