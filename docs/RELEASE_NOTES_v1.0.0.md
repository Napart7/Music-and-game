## GlassLyrics v1.0.0 — 六平台适配 + 全新门面

### 新增平台支持（4 个）

| 平台 | 读歌/控制 | 歌词 | 选歌搜索 | 认证 |
|---|---|---|---|---|
| **酷狗音乐** | ✅ SMTC | ✅ 公开 LRC 源（实测《孤勇者》54 行） | ✅ 15 条/页 + 封面 | 无需 |
| **汽水音乐** | ✅ SMTC | 🟡 同曲匹配 | 🟡 经网易云曲库 | 无需 |
| **Apple Music** | ✅ SMTC | 🟡 同曲匹配 + iTunes 元数据 | ✅ iTunes 目录 13 条 | 无需 |
| **Spotify** | ✅ SMTC | 🟡 同曲匹配（LRCLIB 优先） | ✅ 10 条（需自备 Client ID/Secret） | 可选 |

**统一接入层**：六个平台的「正在播放 + 播放控制」全部走 Windows SMTC，零配置零账号、不抢游戏按键。

**平台差异处理**：每个平台独立的歌词源优先级、同曲匹配降级链、URL Scheme 唤起、封面补齐（iTunes）、进程名识别规则。完整矩阵见 [docs/平台适配.md](https://github.com/Napart7/Music-and-game/blob/main/docs/平台适配.md)。

**诚实标注**：汽水 / Apple Music / Spotify 没有公开歌词接口，使用「同曲匹配」并在界面标注来源，不冒充官方歌词。Spotify 凭据由用户自备、只存本机，仓库不内置。

### 文档与仓库门面

- 新增 **平台适配说明**（能力矩阵 / 每平台详解 / 兼容性处理 / 边界 / 排障）
- **README 全面重写**：Hero 配图、徽章、六平台矩阵、功能清单、30 秒上手、折叠 FAQ、架构图
- 使用说明 / 第三方声明同步更新（酷狗、iTunes、Spotify 数据边界）

### 验证

- 回归 **162 项全绿**（providers 36 + lyrics 19 + menu 56 + autofit 22 + preview 29）
- 实测：酷狗歌词 54 行 + 封面；三平台搜索（QQ 15 / 酷狗 15 / Apple 13）走真实 IPC
- 打包版冒烟：`packaged:true`、YRC 52 行、穿透状态正常

### 下载
- **GlassLyrics Setup 1.0.0.exe** — 安装版
- **GlassLyrics-Portable.exe** — 绿色便携版
