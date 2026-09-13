# QuantPick 桌面版构建说明

`QuantPick桌面版.exe` = 自解压启动器(stub) + ZIP(内置 node.exe 与全部程序文件)。

## 原理

1. **stub.exe**(C# 编译,6KB):读取自身末尾追加的 ZIP → 解压到 `%LOCALAPPDATA%\QuantPick`
   (可用环境变量 `QUANTPICK_HOME` 覆盖解压目录)→ 启动 `run.cmd`。
2. **desktop.zip**:项目全部文件 + `node.exe`(官方运行时,未篡改,签名有效)。
3. 合并:`copy /b stub.exe + desktop.zip = QuantPick桌面版.exe`。

> 为什么不直接用 Node SEA 单文件?
> 签名后的 node.exe 被注入会触发系统拒绝运行(Access denied);故采用"自解压 + 原样 node.exe"方案,稳定可靠。

## 重新构建(Windows, 零下载)

```powershell
cd quantpick

# 1. 准备解压目录(复制 node.exe + 项目文件 + run.cmd)
New-Item -ItemType Directory -Force dist-desktop | Out-Null
Copy-Item (Get-Command node).Source dist-desktop\node.exe
Copy-Item server.js, index.html dist-desktop\
Copy-Item css, js, website dist-desktop\ -Recurse
# run.cmd 见仓库内 dist-desktop 或参考下方

# 2. 编译 stub(.NET Framework 自带 csc)
$csc = "$env:windir\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
& $csc /nologo /target:exe /out:stub.exe `
  /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll deploy\SelfExtract.cs

# 3. 打包 zip + 合并
Compress-Archive dist-desktop\* desktop.zip -CompressionLevel Optimal
cmd /c "copy /b stub.exe + desktop.zip QuantPick桌面版.exe"
```

## run.cmd(解压后自动执行)

```bat
@echo off
chcp 65001 >nul
title QuantPick 桌面版(真实数据服务)
cd /d "%~dp0"
netstat -ano | findstr ":8090.*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  start "" http://127.0.0.1:8090
  echo 检测到 QuantPick 已在运行,直接打开浏览器。
  timeout /t 3 /nobreak >nul
  exit /b 0
)
start "" http://127.0.0.1:8090
"%~dp0node.exe" server.js
pause
```

## 文件清单

- `deploy/SelfExtract.cs` — 自解压启动器源码
- `dist-desktop/` — 解压内容源目录(构建输入)
- `QuantPick桌面版.exe` — 最终桌面版
