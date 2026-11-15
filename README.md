<div align="center">

<img src="docs/preview/hero.jpg" alt="GlassLyrics — 跨游戏液态玻璃歌词覆盖层" width="100%">

# GlassLyrics

**把液态玻璃歌词，搬进任何游戏。** Windows · macOS · Linux

QQ 音乐 · 网易云音乐 · 酷狗音乐 · 汽水音乐 · Apple Music · Spotify

[![Release](https://img.shields.io/github/v/release/Napart7/Music-and-game?style=flat-square&color=6f8cff&label=Release)](https://github.com/Napart7/Music-and-game/releases)
[![License](https://img.shields.io/badge/License-MIT-9b7bff?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-4ea1ff?style=flat-square)](#平台支持)
[![Electron](https://img.shields.io/badge/Electron-45-2f6bff?style=flat-square&logo=electron&logoColor=white)](#)
[![No Injection](https://img.shields.io/badge/No%20Injection-不注入进程-2ecc9a?style=flat-square)](#合规与隐私)

[下载安装包](https://github.com/Napart7/Music-and-game/releases) ·
[使用说明](docs/使用说明.md) ·
[功能更新说明](docs/更新说明-v1.4.md) ·
[更新日志](CHANGELOG.md) ·
[参与贡献](CONTRIBUTING.md)

</div>

---

## 这是什么

GlassLyrics 是一个**独立透明置顶窗口**，把 DangoMusic 那种液态玻璃、逐字扫光、动态漂浮的歌词观感，覆盖到**任意游戏**画面上（Windows / macOS / Linux）——不注入游戏、不读内存、不抓音频，只用系统自带的媒体接口读「谁在放歌」。

- **中央永远留空**：歌词在画面左右两侧，准星区域一根线都不挡
- **自动贴合游戏窗口**：切窗口、改分辨率、换显示器，歌词跟着走（实测误差 1px）
- **零配置读歌**：六个平台的播放状态与播放控制，开箱即用
- **真逐字**：网易云 YRC 原生逐字时间轴；其他平台整行 LRC + 推算，界面如实标注，不冒充
- **快**：切歌到出歌词实测 221–345ms，7 个负载场景 60fps / 0 掉帧

> 想改成自己的样子？10 个全局热键、歌词位置、字号字重、辉光颜色、漂浮行数全都能调，配置存本机。

---

## ✨ 最近更新 · v1.4.0

| 更新 | 说明 |
|---|---|
| **歌词偏移微调热键** | `Ctrl+Alt+PageUp` 提前 / `Ctrl+Alt+PageDown` 延后 0.1 秒。蓝牙耳机、HDMI 电视的 100–300ms 延迟，在游戏里按两下就对齐，不用开菜单 |
| **屏幕轻提示** | 调偏移时屏幕下方浮出 1.7 秒提示「歌词偏移 +200 ms（更早）」，点击穿透、不挡操作 |
| **关于页说真话** | 版本 / 平台 / 架构运行时读取（之前写死 1.0.0），新增「最近更新」卡片 |
| **仓库全面翻新** | 新增 `CHANGELOG.md`（v0.9→v1.4 全量历史）、`docs/更新说明-v1.4.md`（功能地图）、`CONTRIBUTING.md`；README 改用轻量预览图（26MB → 1.3MB） |

完整历史见 **[CHANGELOG.md](CHANGELOG.md)**，能力全景见 **[docs/更新说明-v1.4.md](docs/更新说明-v1.4.md)**。

---

## 效果

<a href="docs/应用实机截图.png"><img src="docs/preview/game.jpg" alt="游戏内实机效果" width="100%"></a>

<sub>Warframe 实机：歌词浮在画面两侧，中央视野完全留空（点图看原图 2560×1600）</sub>

<table>
<tr>
<td width="50%" align="center">
  <a href="docs/主菜单实机截图.png"><img src="docs/preview/menu.jpg" alt="液态玻璃主菜单"></a>
  <br><sub>液态玻璃主菜单 · 七个分区</sub>
</td>
<td width="50%" align="center">
  <a href="docs/字形辉光预览.png"><img src="docs/preview/glow.jpg" alt="字形发散辉光"></a>
  <br><sub>辉光由字形发散 · 无矩形底板</sub>
</td>
</tr>
<tr>
<td align="center">
  <a href="docs/自适应实机截图.png"><img src="docs/preview/autofit.jpg" alt="窗口自适应"></a>
  <br><sub>自动捕捉游戏窗口并跟随</sub>
</td>
<td align="center">
  <a href="docs/平台歌歌词实机截图.png"><img src="docs/preview/lyrics.jpg" alt="平台歌词"></a>
  <br><sub>平台歌词源 · 逐字扫光</sub>
</td>
</tr>
</table>

---

## 平台支持

| | Windows 10/11 | macOS 12+ | Linux（X11） | Linux（Wayland） |
|---|---|---|---|---|
| 读歌 / 控播 | ✅ SMTC | ✅ Music / Spotify | ✅ MPRIS | ✅ MPRIS |
| 跟随游戏窗口 | ✅ Win32 | ✅ 需辅助功能权限 | ✅ xdotool | ⬜ 系统限制，退整屏 |
| 透明置顶 / 热键 | ✅ | ✅ | ✅ 需合成器 | 🟡 取决于桌面 |
| 托盘 | ✅ | ✅ | 🟡 需 AppIndicator | 🟡 同左 |

**Linux 依赖**：`playerctl`（读歌/控播）、`xdotool` + `xprop`（窗口跟随）。
Debian/Ubuntu：`sudo apt install playerctl xdotool x11-utils`；缺少时其余功能照常，只是退回整屏。
**macOS**：首次运行请允许「辅助功能」与「自动化」权限；未签名版本需右键「打开」。
完整差异、验证步骤与限制见 **[docs/跨平台适配.md](docs/跨平台适配.md)**。

## 支持的播放器

| 平台 | 读歌 / 控制 | 歌词源 | 逐字 | 选歌搜索 |
|---|---|---|---|---|
| **QQ 音乐** | ✅ SMTC | ✅ LRC + 翻译 | 推算 | ✅ |
| **网易云音乐** | ✅ SMTC | ✅ **YRC 逐字** + 翻译 | **原生** | ✅ |
| **酷狗音乐** | ✅ SMTC | ✅ 官方 LRC 链路 | 推算 | ✅ |
| **汽水音乐** | ✅ SMTC | 🟡 同曲匹配 | 推算 | 🟡 经网易云 |
| **Apple Music** | ✅ SMTC | 🟡 同曲匹配 + iTunes 元数据 | 推算 | ✅ iTunes 目录 |
| **Spotify** | ✅ SMTC | 🟡 同曲匹配（LRCLIB 优先） | 推算 | ✅ 需自备开发者凭据 |

「同曲匹配」= 用曲名 + 歌手在中文平台和 LRCLIB 找同一首歌的歌词，**不是平台官方歌词**。完整矩阵、认证方式、兼容性处理见 **[docs/平台适配.md](docs/平台适配.md)**。

---

## 功能清单

<table>
<tr><td width="33%" valign="top">

**歌词**
- 网易云 YRC 真逐字
- QQ / 酷狗 LRC + 翻译
- 制作信息自动过滤
- 时间轴校准（滑块 + 热键 ±0.1s）
- 六源并行竞速 · 本地缓存 300 条

</td><td width="33%" valign="top">

**视觉**
- 液态玻璃主菜单
- 字形发散辉光（四色可调）
- 逐字弹跳 / 摆动 / 砸入
- 漂浮歌词 3–6 行，每行独立漂移
- 左右双侧 / 居中 / 单侧布局

</td><td width="33%" valign="top">

**交互**
- 10 个全局热键可自定义
- 歌词自由拖动定位
- 侧栏宽 / 行距 / 字重 / 透明度
- 点击穿透（四重保险）
- 屏幕轻提示 · 托盘 · 开机自启

</td></tr>
<tr><td valign="top">

**平台**
- 六平台读歌 + 控播 + 搜索
- 专辑封面（含 iTunes 600px）
- 一键唤起客户端搜索
- 三平台：Win / macOS / Linux

</td><td valign="top">

**性能**
- 切歌出歌词 221ms（并行竞速）
- 7 场景 60fps / 0 掉帧
- 暂停零重绘、变化检测跳写（-97%）
- 低配模式（30 帧 + 辉光减层）

</td><td valign="top">

**安全**
- 不注入游戏进程
- 不读游戏内存
- 不抓音频 / 不破 DRM
- 不内置任何账号凭据

</td></tr>
</table>

---

## 30 秒上手

1. **下载** → [Releases](https://github.com/Napart7/Music-and-game/releases)（三平台产物由 CI 构建）

   | 平台 | 文件 |
   |---|---|
   | Windows | `GlassLyrics Setup x.y.z.exe`（安装版）· `GlassLyrics-Portable.exe`（绿色版） |
   | macOS | `GlassLyrics-x.y.z-arm64.dmg`（Apple 芯片）· `GlassLyrics-x.y.z.dmg`（Intel） |
   | Linux | `GlassLyrics-x.y.z.AppImage` · `glasslyrics_x.y.z_amd64.deb` |

2. **播放** → 打开 QQ 音乐 / 网易云 / 酷狗 / 汽水 / Apple Music / Spotify 放一首歌
3. **进游戏** → 歌词自动浮在画面两侧；独占全屏请改成「无边框全屏」
4. **需要设置** → `Ctrl + Alt + P` 唤出液态玻璃主菜单

| 默认热键 | 动作 |
|---|---|
| `Ctrl + Alt + P` | 打开 / 收起主菜单 |
| `Ctrl + Alt + H` | 显示 / 隐藏歌词 |
| `Ctrl + Alt + B` | 切换布局 |
| `Ctrl + Alt + F` | 开关窗口自适应 |
| `Ctrl + Alt + PageUp` | 歌词提前 0.1 秒（蓝牙延迟） |
| `Ctrl + Alt + PageDown` | 歌词延后 0.1 秒 |
| `Ctrl + Shift + Alt + Q` | 退出 |

> 全部热键可在「通用」页点击重绑定；播放控制热键默认空，需要就设。

---

## 常见问题

<details>
<summary><b>歌词和声音差半拍 / 差一句？</b></summary>

蓝牙耳机、无线音箱、HDMI 接电视通常有 100–300ms 音频延迟。游戏里直接按 `Ctrl + Alt + PageUp`（歌词提前）或 `Ctrl + Alt + PageDown`（歌词延后），每次 0.1 秒，屏幕下方会有提示条确认。调完不用开菜单；打开「视觉」页能看到时间轴滑块同步。
</details>

<details>
<summary><b>游戏里看不到歌词？</b></summary>

99% 是**独占全屏**（Exclusive Fullscreen）。任何普通置顶窗口在独占全屏下都不可见，请在游戏里改成「无边框全屏 / 窗口化全屏」。
</details>

<details>
<summary><b>切屏出去再回游戏，点不动游戏？</b></summary>

v0.9.1 起已修：失焦自动收起菜单、点面板外立即关闭、拖动模式点空白退出、2 秒心跳重申穿透。若仍遇到，按一下 `Ctrl+Alt+H` 隐藏再显示即可恢复。
</details>

<details>
<summary><b>Spotify 搜索提示需要凭据？</b></summary>

Spotify 官方不提供歌词接口，搜索需要你自己的开发者 App：developer.spotify.com → Create app → 复制 Client ID / Secret → 填进「通用 → Spotify 开发者凭据」。凭据只存本机，不随仓库分发。播放控制不需要凭据。
</details>

<details>
<summary><b>汽水音乐 / Apple Music 的歌词是官方的吗？</b></summary>

不是。这两个平台没有公开歌词接口，程序会用**同曲匹配**去网易云 / QQ / 酷狗 / LRCLIB 找同一首歌的歌词，界面会标注来源。中文歌命中率很高，冷门歌可能找不到。
</details>

<details>
<summary><b>会被反作弊检测吗？</b></summary>

GlassLyrics 不注入、不挂钩子、不读写游戏内存，对游戏而言只是一层普通置顶窗口。但**带反作弊的联机游戏请自行判断**是否使用覆盖层，风险自负。
</details>

<details>
<summary><b>怎么知道当前是什么版本？</b></summary>

主菜单 →「关于」页顶部：版本号、运行平台、Electron 版本都是运行时读的；下面「最近更新」卡片直接显示最近 3 个版本要点。
</details>

更多问题见 [docs/使用说明.md](docs/使用说明.md)。

---

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/使用说明.md](docs/使用说明.md) | 装、配、用、排错，从零到能玩 |
| [docs/更新说明-v1.4.md](docs/更新说明-v1.4.md) | 本版更新 + **全量功能地图** + 平台能力矩阵 + 升级指引 |
| [CHANGELOG.md](CHANGELOG.md) | v0.9.0 → v1.4.0 全量版本历史 |
| [docs/平台适配.md](docs/平台适配.md) | 六平台 × 12 项能力矩阵、认证方式、差异处理、边界 |
| [docs/跨平台适配.md](docs/跨平台适配.md) | 三端路径/换行符/依赖/权限差异与验证步骤 |
| [docs/技术方案.md](docs/技术方案.md) | 渲染管线、逐字时间轴、窗口贴合的实现说明 |
| [docs/性能自检-v1.3.md](docs/性能自检-v1.3.md) | 7 场景帧时间基准 + 连接延迟基准与前后数据 |
| [docs/自检报告-v1.2.md](docs/自检报告-v1.2.md) | 5 层自检发现的 15 项问题与修复 |
| [docs/第三方声明.md](docs/第三方声明.md) | 数据来源与使用边界 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 本地跑法、回归清单、提交与发版约定 |

---

## 技术架构

```
┌─────────────────────────────── Electron 主进程 ───────────────────────────────┐
│  透明置顶窗 (transparent + alwaysOnTop)    全局热键 / 托盘 / 配置持久化          │
│         │                                        │                            │
│  平台后端 (backends/) ──► 曲目·进度·状态 ◄── 播放控制指令                      │
│    Windows: SMTC 桥接 │ macOS: JXA │ Linux: MPRIS                             │
│         │                                        │                            │
│   窗口探针（400ms）──► 前台游戏矩形（DPI 感知）    │                            │
│         │                                        │                            │
│   歌词引擎：QQ / 网易云(YRC) / 酷狗 / LRCLIB ── 并行竞速 + 同曲匹配 + 缓存      │
└───────────────────────────────────┬───────────────────────────────────────────┘
                                    │ IPC（contextIsolation，白名单桥）
┌───────────────────────────────────▼───────────────────────────────────────────┐
│  渲染层：逐字 Glyph · 扫光 · 字形辉光 · 漂浮歌词 · 液态玻璃菜单 · 拖动定位        │
│  性能：变化检测跳写 · 扫光量化 · 帧预算 · 合成器动画（JS 零逐帧）               │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **读歌不碰播放器**：Windows 用 WinRT SMTC、macOS 用 AppleScript、Linux 用 MPRIS（playerctl），全是系统级接口，无第三方 SDK
- **贴合不碰游戏**：只读前台窗口矩形（`GetForegroundWindow` / AX API / `xdotool`），不打开游戏进程
- **歌词不落盘（除缓存）**：运行时从公开接口拉文本，缓存在本机，仓库与安装包不含任何歌词数据
- **无运行时依赖**：`dependencies` 为空，只有 Electron 本体

---

## 开发与构建

```bash
cd app
npm install          # 首次
npm start            # 开发运行
npm run dist         # 打包（NSIS + 便携 exe → ../dist）
```

**回归测试**（无需 Electron，headless Chrome/Edge + CDP，共 186 项）：

```bash
node tools/check_compliance.mjs   # 门禁：文件 / 敏感信息 / 语法 / .sh 换行符 / changelog 同步
node tools/verify_backends.mjs    # 19 项：三端后端契约（媒体 / 窗口 / 路由）
node tools/verify_providers.mjs   # 36 项：解析 / 清洗 / 平台识别 / 降级
node tools/verify_lyrics.mjs      # 19 项：歌词引擎 / 缓存
node tools/verify_menu.mjs        # 61 项：菜单 / 辉光 / 热键 / 拖动 / 漂浮 / 性能 / Toast / 关于页
node tools/verify_autofit.mjs     # 22 项：窗口自适应
node tools/verify_preview.mjs     # 29 项：预览页

node tools/bench_perf.mjs         # 性能基准：7 场景帧时间
node tools/bench_lyrics.mjs       # 基准：真实网络歌词连接延迟
node tools/gen_changelog.mjs      # 改完 CHANGELOG.md 后生成 app/changelog.json
```

发版：改 `app/package.json` 版本 + 跑 `gen_changelog.mjs` → `git tag vX.Y.Z` → push tag，GitHub Actions 自动三平台构建并发布 Release。

---

## 目录结构

```
app/                 Electron 主程序
  main.js            主进程：窗口 / 热键 / 托盘 / 自适应 / 点击穿透状态机 / IPC
  lyrics.js          歌词引擎：并行竞速 / 缓存 / 降级
  providers.js       QQ / 网易云(YRC) / 酷狗 / LRCLIB / iTunes / Spotify
  changelog.json     由 CHANGELOG.md 生成（关于页读它，勿手改）
  backends/          平台后端：路由 + 统一契约 + win/mac/linux 实现
  renderer/          渲染层（单文件：歌词 / 菜单 / 交互 / 样式）
  *.ps1              Windows：SMTC 桥接、播放控制、窗口探针
docs/                文档、实机截图与自检证据（preview/ 是 README 用的轻量图）
tools/               回归、基准、门禁、构建素材生成
```

---

## 合规与隐私

- 不注入任何进程、不读取游戏内存、不模拟全局按键、不抓取音频
- 不破解 KRC / QRC 等加密歌词，不下载歌曲、不绕过 DRM
- Spotify 凭据由用户自备，仅存本机 `config.json`，仓库不内置任何凭据
- 歌词文本仅在运行时从公开接口获取并缓存在用户本机；仓库与安装包**不含任何歌词**
- 视觉参数参考 DangoMusic（GPL-3.0）的公开渲染规格描述，**未拷贝其代码、着色器或素材**
- 详见 [docs/第三方声明.md](docs/第三方声明.md)

## License

[MIT](LICENSE) © GlassLyrics contributors

<div align="center"><sub>如果这个项目让你在游戏里听歌更爽，点个 Star 就是最大的支持</sub></div>
