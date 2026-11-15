## GlassLyrics v1.1.1 — Windows / macOS / Linux 三平台

### 新增：跨平台后端抽象层

把「读媒体 / 控播放 / 探窗口」拆成可替换的 OS 后端，主进程不再写任何平台分支：

| 能力 | Windows | macOS | Linux（X11） |
|---|---|---|---|
| 读歌 / 进度 | WinRT SMTC | AppleScript（Music / Spotify） | MPRIS（playerctl） |
| 播放控制 | SMTC | AppleScript | `playerctl play-pause/next/previous` |
| 窗口跟随 | Win32 API | System Events | xdotool + xprop |
| 开机自启 | 注册表登录项 | 登录项 | XDG autostart（`~/.config/autostart`） |

三端后端输出**同一份 JSON 契约**（`app/backends/parse.js` 归一），UI、歌词、外观、性能逻辑完全共享。

### 平台差异处理

- **路径**：统一 `path.join`，资源走 `process.resourcesPath`，配置走 `app.getPath('userData')`（三端各自规范路径）
- **换行符**：新增 `.gitattributes`，仓库存 LF；`.ps1` 检出 CRLF、`.sh` 强制 LF（CI 会检测 CRLF 并失败）
- **脚本权限**：Linux 脚本通过 `bash script.sh` 调用（不依赖 +x），git 记录 100755
- **环境变量**：`ELECTRON_MIRROR`（CI）、`XDG_CONFIG_HOME` / `XDG_SESSION_TYPE`（Linux autostart / Wayland 判定）、`DISPLAY`（X11）
- **打包**：`mac`（dmg + zip，x64/arm64）、`linux`（AppImage + deb），图标统一 1024px PNG；mac 跳过签名
- **CI**：三平台构建矩阵 + 统一 Release 汇总（避免并发写冲突）

### 新增验证

- `tools/verify_backends.mjs`：17 项契约测试（三端媒体行 / 窗口行 / 动作归一 / 路由 / 路径语义）—— **普通 Node 即可跑，无需 Electron**
- `tools/check_compliance.mjs`：跨平台合规与语法门禁（替代只能在 Windows 跑的旧检查）
- 全量回归 **179 项全绿**；Windows 打包版冒烟通过（`Tencent.QQMusic` / YRC / 穿透正常）

### Linux 依赖（缺少时自动降级，不崩溃）

```bash
sudo apt install playerctl xdotool x11-utils
```

### 已知限制

- **Wayland**：系统不提供跨客户端窗口几何，窗口跟随不可用，自动退回整屏（读歌/控播正常）
- **macOS**：需授权辅助功能与自动化；未签名/未公证，首次需右键「打开」
- **macOS/Linux 未在真机做完整交互验证**：已通过契约测试 + CI 构建，首次使用如遇问题请附控制台日志提 issue

### 下载

| 平台 | 文件 |
|---|---|
| Windows | `GlassLyrics Setup 1.1.1.exe` / `GlassLyrics-Portable.exe` |
| macOS | `GlassLyrics-1.1.1-arm64.dmg` / `-x64.dmg`（CI 构建） |
| Linux | `GlassLyrics-1.1.1.AppImage` / `glasslyrics_1.1.1_amd64.deb`（CI 构建） |
