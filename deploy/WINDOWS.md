# Windows 服务器部署与更新

`STEP-BY-STEP.md` / `DEPLOY.md` 讲的是 Linux（apt + pm2 + `/opt/quantpick`）。
**如果在 Windows Server 上部署，请按本文档操作** —— 两者最大的差别是"进程怎么被守护"，踩错会直接导致网站打不开。

## 一、先理解这套拓扑

```
公网 80/443 ──> gateway.js ──> 127.0.0.1:8090  server.js ──> 东方财富 / 腾讯
                  (证书在 cert\;转发)
```

- **应用根目录 = `server.js` 所在目录**（代码里 `ROOT = __dirname`），静态文件、`cert/`、`.cache/` 都在这一层
- 典型布局：

```
C:\quantpick\deploy-app\        <- 应用根(server.js / index.html / css / js / website / gateway.js / cert / .cache)
C:\quantpick\logs\              <- server.log / gateway.log / startup.log
C:\node\node-vXX-win-x64\node.exe   <- 便携版 Node(不必装到系统 PATH)
```

- `gateway.js` 监听 **80 与 443**（HTTPS 证书从 `__dirname\cert\` 自动探测），把请求转发到 `127.0.0.1:8090`
- 想确认谁在监听哪个端口：`netstat -ano | findstr ":80 :443 :8090"`，再用 `Get-Process -Id <PID>` 对回进程

## 二、一次性安装：注册两个计划任务（推荐做法）

**用"任务的动作 = node 本身"**，不要用 `cmd /c start /b`。原因见第三节。

```powershell
$node = 'C:\node\node-v22.12.0-win-x64\node.exe'   # 换成你的 node 路径
$app  = 'C:\quantpick\deploy-app'                  # 换成你的应用根目录

$set  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
          -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
          -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$prin = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$trig = New-ScheduledTaskTrigger -AtStartup

Register-ScheduledTask -TaskName 'QuantPickServer' `
  -Action (New-ScheduledTaskAction -Execute $node -Argument "$app\server.js" -WorkingDirectory $app) `
  -Trigger $trig -Settings $set -Principal $prin -Force

Register-ScheduledTask -TaskName 'QuantPickGateway' `
  -Action (New-ScheduledTaskAction -Execute $node -Argument "$app\gateway.js" -WorkingDirectory $app) `
  -Trigger $trig -Settings $set -Principal $prin -Force
```

三个参数不能省：

| 参数 | 为什么 |
|---|---|
| `-ExecutionTimeLimit ([TimeSpan]::Zero)` | 任务默认**最多跑 3 天就被强杀**，不设这个网站会周期性挂掉 |
| `-RestartCount 3 -RestartInterval 1min` | 进程崩了自动拉起 |
| `-WorkingDirectory $app` | 保证相对路径解析一致（代码用 `__dirname`，但设了更稳） |

启动 / 停止 / 查状态：

```powershell
Start-ScheduledTask -TaskName QuantPickServer, QuantPickGateway
Stop-ScheduledTask  -TaskName QuantPickServer, QuantPickGateway
Get-ScheduledTask   -TaskName QuantPickServer, QuantPickGateway | Select-Object TaskName, State
```

## 三、两个必须避开的坑（真实事故）

### 坑 1：`cmd /c start "" /b node server.js` + 计划任务 → 进程被回收

计划任务运行期间，它拉起的进程属于该任务的 **job 对象**；任务实例一结束（bat 跑完就结束），
Windows 会**回收整棵进程树**。表现为：日志里明明有"服务已启动"，但几秒后 `netstat` 里端口全没了、网站打不开。

- ✅ 正确：任务的动作直接是 node（本文档第二节）
- ⚠️ 如果你在 **RDP 交互式会话**里手动跑 bat，进程属于你的登录会话，不会被执行任务回收 —— 但**注销/重启会终止它们**

### 坑 2：启动脚本里 `taskkill /F /IM node.exe`

这行会杀掉机器上**所有** node 进程。如果这台服务器还跑别的 node 服务，会被一起带走。
要重启本服务，请用：

```powershell
Stop-ScheduledTask -TaskName QuantPickServer, QuantPickGateway
Start-ScheduledTask -TaskName QuantPickServer, QuantPickGateway
```

## 四、更新到新版本

### 1) 把新文件放到服务器

任选其一：

- **RDP 复制粘贴**：本机复制更新包 → 服务器桌面粘贴（注意粘贴完成后确认文件真的存在、大小对得上）
- **scp**：本机 `scp <包> Administrator@<IP>:C:/Users/Administrator/`（需服务器已启用 OpenSSH 服务端）
- **服务器直接拉取**：国内服务器访问 `raw.githubusercontent.com` 常不通，可用 jsDelivr 的**固定提交**地址（不要用 `@main`，CDN 可能给你旧缓存）：

  ```powershell
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12   # PS 5.1 必须加
  $s = 'https://cdn.jsdelivr.net/gh/<owner>/<repo>@<commit>/'   # 例: .../quantpick@7d7ce70/
  Invoke-WebRequest "$s/server.js" -OutFile "$APP\server.js"
  ```

### 2) 备份 → 覆盖 → 核对（**核对不过就不要重启**）

```powershell
$APP = 'C:\quantpick\deploy-app'
cd $APP

Copy-Item server.js "server.js.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"      # 备份
Expand-Archive -Path 'C:\quantpick-1.0.1-update.zip' -DestinationPath $APP -Force

(Get-Item server.js).Length                                                  # 与发布说明里的字节数比对
(Get-FileHash server.js -Algorithm SHA256).Hash                              # 与发布说明里的 SHA256 比对
Test-Path deploy\check.js                                                    # 新增文件是否就位
```

> 更新包只覆盖包内同名文件，`gateway.js`、`cert\`、`.cache\` 不受影响。

### 3) 重启并验证

```powershell
Restart-ScheduledTask -TaskName QuantPickServer, QuantPickGateway   # 若无此命令则 Stop 后 Start
Start-Sleep 5

netstat -ano | findstr ":80 :443 :8090"     # 三个端口都应 LISTENING
Get-Process node | Select-Object Id, StartTime

& "C:\node\node-v22.12.0-win-x64\node.exe" "$APP\deploy\check.js"   # 期望:总计 9 项,失败 0
```

### 4) 回滚

```powershell
Copy-Item "$APP\server.js.bak-<时间戳>" "$APP\server.js" -Force
Stop-ScheduledTask -TaskName QuantPickServer, QuantPickGateway
Start-ScheduledTask -TaskName QuantPickServer, QuantPickGateway
```

## 五、排障速查

| 现象 | 先查什么 |
|---|---|
| 网站打不开 | `netstat -ano \| findstr ":80 :443 :8090"` → 端口不在 = 进程没了；再看 `logs\server.log`、`logs\gateway.log` |
| 日志有"已启动"但端口没了 | 见坑 1：进程被任务回收，改用第二节的注册方式 |
| `gateway.log` 提示未检测到证书 | 证书不在 `deploy-app\cert\fullchain.pem` + `privkey.pem`，HTTPS 不会启用（仅 80 可用） |
| 页面提示"数据服务未连接" | `server.js` 没起来，或 8090 被占用：`netstat -ano \| findstr ":8090"` |
| `node` 命令找不到 | 便携版没进 PATH，用全路径 `C:\node\...\node.exe` |
| 改完文件却看不到变化 | 服务没重启；或浏览器/CDN 缓存（加 `?t=123` 试） |
| 重启服务器后服务没起来 | 任务是否被禁用、是否设了 `-AtStartup` 触发、是否用 SYSTEM 账户注册 |
