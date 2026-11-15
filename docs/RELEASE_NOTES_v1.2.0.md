## GlassLyrics v1.2.0 — 全量自检排错 + 三端一致性优化

本次不新增功能，专注**修 bug、补边界、降开销**。完整报告见 [docs/自检报告-v1.2.md](https://github.com/Napart7/Music-and-game/blob/main/docs/自检报告-v1.2.md)。

### 修掉的 3 个功能性缺陷

| 问题 | 影响 | 修复 |
|---|---|---|
| 封面字段名不匹配（`coverUrl` vs `cover`） | **macOS / Linux 封面永远不显示** | 渲染层改读归一后的 `cover`，同值去重 |
| JXA 的 `console.log` 不保证进 stdout | macOS 媒体链路可能**完全收不到数据** | 改用 `NSFileHandle` 显式写 stdout，console 兜底 |
| 未知播放状态被当成「正在播放」 | 后端异常时疯狂拉歌词 | 白名单校验：未知状态 → `UNKNOWN` + 不触发请求 |

### 稳定性与性能

- **Linux 窗口探针：27 → 7.5 子进程/秒（-72%）** — 一次 xprop 读 4 属性 + 纯 bash 解析
- **覆盖层隐藏时帧循环彻底停止**（原先 60fps 空转）— 隐藏即 return，恢复无跳帧
- **后端崩溃指数退避**（1.5s→3s→6s→12s，上限 15s），错误日志去重（原先每 400ms 刷一次）
- **autofit IPC 与 DOM 写入去重**：静止时 0 次 IPC / 0 次样式写
- **mac 属性读取 6 → 2 次 AppleEvent/tick**（`properties()` 批量 + 回退）
- **Linux 无 AppIndicator 时不再崩溃**（Tray 创建容错，热键仍可用）
- 托盘图标升级为 1024px（mac/Linux HiDPI 清晰）
- `config.json` 含 Spotify secret 时 POSIX 下 `chmod 0600`

### 边界与兼容

- Linux 补 `WM_NAME` 兜底（部分 Java 游戏不设 `_NET_WM_NAME`）
- Spotify 401/403 明确提示「凭据无效」，不再笼统报搜索失败
- 启动/恢复显示使用 `showInactive` 语义，不抢游戏焦点
- 自检中发现并回滚了一个自己引入的回归：`show:false` 会让 Chromium 挂起 rAF，导致歌词冻结

### 三端一致性

| 维度 | 状态 |
|---|---|
| 媒体/窗口/动作契约 | 三端同一份归一器，19 项契约测试 |
| 渲染层 | 同一份 HTML/CSS/JS；字体栈覆盖三端 CJK（Noto / 苹方 / 雅黑） |
| UI 回归 | Windows 本地 + **CI 新增 Linux UI 回归**（headless Chrome） |
| 构建 | CI 三平台矩阵（Windows / macOS / Linux） |

### 验证

- 本地 **181 项全绿**（compliance + 契约 19 + providers 36 + lyrics 19 + menu 56 + autofit 22 + preview 29）
- 打包版冒烟：`netease-yrc 52 行 / clickThrough:true / 双平台搜索 15 条`
- CI：verify（Windows）+ verify-linux（Linux UI）+ 三平台 build

### 下载

| 平台 | 文件 |
|---|---|
| Windows | `GlassLyrics Setup 1.2.0.exe` / `GlassLyrics-Portable.exe` |
| macOS | `GlassLyrics-1.2.0-arm64.dmg` / `-x64.dmg` |
| Linux | `GlassLyrics-1.2.0.AppImage` / `glasslyrics_1.2.0_amd64.deb` |
