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

## 4. 打 tag 并推送

```bash
git tag -a v1.0.0 -m "QuantPick v1.0.0"
git push origin main
git push origin v1.0.0
```

## 5. 建 Release 并上传附件

网页方式：仓库 → Releases → **Draft a new release** → 选择刚推的 tag →
标题写 `v1.0.0`，说明可从 `CHANGELOG.md` 对应小节复制 →
把 `QuantPick桌面版.exe` 拖进附件区 → Publish。

命令行方式（需要 `gh` CLI 且已登录）：

```bash
gh release create v1.0.0 "QuantPick桌面版.exe" \
  --title "v1.0.0" \
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

发布后校验清单：

- [ ] 首页可打开，四张界面预览图在 GitHub README 里正常显示（不是裂图）
- [ ] 大盘晴雨表 KPI 无 `undefined` / "占比 undefined%"
- [ ] 指数卡片有市场标签，无 `undefined`
- [ ] `curl -i https://<域名>/server.js` 返回 403
- [ ] `curl -i https://<域名>/.git/config` 返回 403
- [ ] `curl -i "https://<域名>/..%2f..%2fetc%2fpasswd"` 返回 403
- [ ] CI 徽章为绿色；Releases 页面能看到桌面版附件
- [ ] 官网「进入应用」按钮指向正确地址
