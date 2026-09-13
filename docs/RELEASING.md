# 发布流程

面向维护者。目标：**每一次发布都有人能复现、可回滚、附件可下载。**

## 1. 准备

```bash
git checkout main
git pull
git status          # 工作区必须干净
```

确认 `CHANGELOG.md` 里待发布的内容已从 `## [Unreleased]` 移到 `## [x.y.z] - YYYY-MM-DD`。

版本号按语义化版本：

| 变更类型 | 版本位 | 例子 |
|---|---|---|
| 破坏兼容（接口字段改名、数据目录结构变化） | MAJOR | 2.0.0 |
| 新增功能（新接口、新页面、新指标） | MINOR | 1.1.0 |
| 兼容性修复（缺陷、文案、样式、性能） | PATCH | 1.0.1 |

## 2. 回归

```bash
cd _smoke
npm ci
npm test                    # 离线套件,不依赖外部数据源
npm run test:isolated       # 全量回归(独立端口 8091 + 独立数据目录)
```

也可以在 GitHub 上手动触发 CI 的 **真实数据全量回归(手动触发)** 任务
（Actions → CI → Run workflow），它会跑同一套 `run-isolated.ps1`。

> 真实数据套件会访问东方财富 / 腾讯公开接口，上游限流或改版时可能失败。
> 失败时先确认是"上游不可用"还是"代码缺陷"，再决定是否继续发布 —— 不要为了发布把断言删掉。

## 3. 构建桌面版（可选）

桌面版单文件 `.exe` **不进仓库**（`.gitignore` 已排除），只作为 Release 附件分发。
构建步骤见 [`../deploy/DESKTOP.md`](../deploy/DESKTOP.md)，产物约 35 MB。

> **附件名用 ASCII**：本地产物名是 `QuantPick桌面版.exe`，但上传到 GitHub 后中文会被去掉、
> 变成 `QuantPick.exe`（部分下载工具对中文名也会乱码）。建议上传前先重命名，保持名实一致：
> ```bash
> cp "QuantPick桌面版.exe" QuantPick.exe
> ```

## 4. 打 tag 并推送

```bash
git tag -a v1.0.0 -m "QuantPick v1.0.0"
git push origin main
git push origin v1.0.0
```

## 5. 建 Release 并上传附件

网页方式：仓库 → Releases → **Draft a new release** → 选择刚推的 tag →
标题写 `v1.0.0`，说明可从 `CHANGELOG.md` 对应小节复制 →
把 `QuantPick.exe` 拖进附件区（等进度走完）→ Publish。

命令行方式（需要 `gh` CLI 且已登录）：

```bash
gh release create v1.0.1 QuantPick.exe \
  --title "v1.0.1" \
  --notes-file CHANGELOG.md
```

> 附件上限 2 GB，35 MB 的桌面版没问题。若以后要分发更大的产物，改用外部存储并在 Release 里给链接。

## 6. 部署线上并校验

服务器上更新代码并重启（PM2 示例）：

```bash
git pull
pm2 reload quantpick        # 或 systemctl restart quantpick
```

**安全相关的修复（如静态托管守卫）必须在发布后重新部署才算生效** —— 线上跑的还是旧进程。

### 用一键脚本更新（推荐）

不需要登录服务器手敲命令，本地一条命令即可（内含：上传 → 从 pm2 探测真实应用目录 →
备份 `server.js` → 解压覆盖 → 重启 → 远程自检）：

```powershell
cd quantpick
# 先预演，确认它要执行什么（不会连服务器）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/push-update.ps1 -Server 1.2.3.4 -DryRun

# 实际执行（会提示输入两次密码：scp 一次、ssh 一次）
powershell -NoProfile -ExecutionPolicy Bypass -File deploy/push-update.ps1 -Server 1.2.3.4
```

- 脚本**不假设**应用目录是 `/opt/quantpick`，而是用 `pm2 describe` 读出真实的 `exec cwd`
- 部署前会备份为 `/root/server.js.bak-<时间戳>`，失败时脚本会直接打印回滚命令
- 想免密码：先执行一次 `ssh-copy-id root@1.2.3.4`，之后整个流程可无人值守

发布后校验清单：

- [ ] 首页可打开，四张界面预览图在 GitHub README 里正常显示（不是裂图）
- [ ] 大盘晴雨表 KPI 无 `undefined` / "占比 undefined%"
- [ ] 指数卡片有市场标签，无 `undefined`
- [ ] 服务器上跑 `node deploy/check.js` → 9 项全 PASS
- [ ] **任意机器上跑公网复核**：`node deploy/check-live.js https://<域名>` → 13 项全 PASS
      （覆盖 `/server.js`、`/.git/config`、路径穿越、`/%`、接口字段等，已带时间戳穿透 CDN 缓存；
      本机 DNS 不通时可加第二个参数指定 IP：`node deploy/check-live.js https://<域名> <IP>`）
- [ ] CI 徽章为绿色；Releases 页面能看到桌面版附件
- [ ] 官网「进入应用」按钮指向正确地址
