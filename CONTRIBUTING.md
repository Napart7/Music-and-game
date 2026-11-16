# 参与贡献 / 本地开发

GlassLyrics 的全部代码都在这个仓库里，运行时依赖只有 Electron。下面是本地跑起来、跑回归和发版的步骤。

---

## 一、环境要求

| 项目 | 要求 |
|---|---|
| Node.js | ≥ 18（CI 用 22，本地实测 22.x） |
| npm | 随 Node 附带 |
| 系统 | Windows 10/11、macOS 12+、Linux（X11；Wayland 仅部分能力） |
| 可选依赖 | Linux：`playerctl` `xdotool` `x11-utils`；macOS：无需额外安装 |
| 回归测试用浏览器 | Chrome / Edge / Chromium 任一（可用 `EDGE_PATH` / `CHROME_PATH` 指定） |

---

## 二、跑起来

```bash
cd app
npm install
npm start          # 开发模式启动覆盖层
```

首次启动会编译一个小的 C# 窗口探针（Windows，约 2 秒），属正常现象。

**只想改视觉/渲染**：`app/renderer/index.html` 可以直接用浏览器打开，
没有 Electron 时会自动进入演示模式（假数据、真渲染），调 CSS 特别快。

---

## 三、改完必须跑的检查

在仓库根目录执行（不需要 Electron）：

```bash
node tools/check_compliance.mjs   # 合规门禁：必需文件 / 敏感信息 / 语法 / .sh 换行符 / changelog 同步
node tools/verify_classify.mjs    # 窗口分类 51 项（游戏 / 桌面应用 / 覆盖层 / 启动器）
node tools/verify_backends.mjs    # 三端后端契约、SMTC 状态枚举与自愈 37 项
node tools/verify_providers.mjs   # 歌词源解析与清洗 36 项
node tools/verify_lyrics.mjs      # 歌词引擎、时间轴与热路径 24 项
```

UI 回归（需要 Chrome/Edge，用无头模式 + CDP）：

```bash
node tools/verify_menu.mjs        # 主菜单 / 热键 / 穿透 / 性能 / Toast / 关于页 61 项
node tools/verify_autofit.mjs     # 窗口自适配 22 项
node tools/verify_preview.mjs     # 独立预览页 29 项
node tools/verify_tray_panel.mjs  # 常驻托盘面板 IPC 契约 10 项
node tools/verify_shatter.mjs     # 换行破碎飞散 12 项
```

改性能相关代码时再跑基准：

```bash
node tools/bench_perf.mjs         # 9 个场景各 2 秒：fps / p95 / 掉帧率（含破碎开 / 关对照）
GL_LONGRUN_MIN=60 node tools/bench_longrun.mjs  # 加速长跑（默认 60 虚拟分钟）
node tools/bench_lyrics.mjs       # 真实网络的连接延迟
```

> 全部通过时的总项数是 **326 项**。数字对不上说明有断言被跳过，请检查输出里的 FAIL。

---

## 四、目录结构

```
app/
  main.js              主进程：窗口、热键、托盘、穿透状态机、IPC、配置
  preload.js           contextBridge 白名单（渲染层拿不到 Node）
  lyrics.js            歌词引擎：缓存、优先级、并行竞速
  providers.js         各平台歌词/搜索/元数据请求与解析
  changelog.json       由 CHANGELOG.md 生成，关于页读它（勿手改）
  backends/            平台抽象层：index(路由) / parse(契约) / mac / linux
  renderer/index.html  渲染层（单文件：歌词、菜单、交互、样式）
  *.ps1                Windows：SMTC 桥接、播放控制、窗口探针
tools/                 回归、基准、合规门禁、构建素材生成
docs/                  使用说明 / 平台适配 / 跨平台适配 / 自检报告 / 更新说明
```

---

## 五、提交约定

- 一个提交做一件事；提交信息用中文，前缀类型：`feat:` / `perf:` / `fix:` / `docs:` / `ci:`
- **不要提交** `config.json`、歌词缓存、`dist/`（已在 `.gitignore`）
- 改 `CHANGELOG.md` 后必须跑 `node tools/gen_changelog.mjs`（否则合规门禁会红）
- 新增 POSIX 脚本必须是 LF 换行 + shebang（Windows 上写文件容易变成 CRLF，`node tools/check_compliance.mjs` 会抓）

---

## 六、发版流程（维护者）

```bash
# 1) 改版本号并同步 changelog
sed -i 's/"version": "x.y.z"/"version": "a.b.c"/' app/package.json
node tools/gen_changelog.mjs

# 2) 提交 + 打 tag（tag 会触发三平台构建）
git add -A && git commit -m "release: vX.Y.Z"
git tag vX.Y.Z && git push origin main && git push origin vX.Y.Z
```

CI（`.github/workflows/build-all.yml`）会做：合规 + 契约 + 三端 UI 回归 → Windows / macOS / Linux 构建 → 汇总到同一个 Release。

---

## 七、提 Issue 时请附上

1. 系统版本（Windows 11 24H2 / macOS 14.5 / Ubuntu 24.04 …）
2. 播放器与歌曲（或说明「本地文件」）
3. 覆盖层「关于」页的版本号
4. 复现步骤与预期/实际结果
5. 有控制台输出的话贴关键几行（`npm start` 启动的窗口）

---

## 八、边界

- 本项目**不注入**任何游戏进程、不读游戏内存、不模拟按键、不抓取音频、不保存账号或 Cookie。
- 歌词只在运行时从公开接口拉取并缓存在本地，仓库与安装包**不含**任何歌词数据。
- 不会为了「支持更多平台」去逆向加密格式（如 KRC/QRC 的二进制加密）或绕过平台鉴权。
