# dsh-video-notes (v1.0.0)

跨平台视频多模态分析 CLI 与 Antigravity 渐进式披露 Skill 套件，支持 B 站、YouTube 与本地视频（含分离音视频目录），通过本地 `faster-whisper` 离线转写、FFmpeg 真实 PTS 抽帧及分片子代理看图架构，在保持笔记深度与多模态核图质量零降级的前提下，大幅降低主会话上下文占用。

## v1.0.0 核心能力

- **多来源统一探测与采集**：支持 B 站（单视频、指定分 P、UGC 合集）、YouTube（自动注入便携 Node JS 运行时与 `ejs:github`）及本地视频文件/目录。
- **多平台 Cookies 自动发现与鲜度体检 (`doctor`)**：将 `Get cookies.txt LOCALLY` 导出的 Netscape Cookie 文件直接放入 `video-notes-data/cookies/`（支持标准命名或随机 UUID 文件名），按域名自动匹配并优先选取最新文件，超过 168 小时自动提示可能过期，且全程零密钥泄露。
- **本地分离音视频自动配对与无损合流**：支持纯视频 + 纯音频文件目录（按 `vid:` 元数据、同前缀或唯一配对自动识别），在条目 `work/` 内完成无损合流，绝不改动原存放目录文件。
- **字幕优先 + 本地离线 ASR**：优先复用平台字幕或本地同目录外挂 `.srt`/`.vtt`；无可用字幕时自动抽取音轨并调用 `faster-whisper`（`small`, CPU `int8`）离线转写。
- **真实 PTS 抽帧与复用机制**：基于 FFmpeg `showinfo` 提取真实媒体 `pts_time`（兼容 VFR 变帧率），支持自定义 `--baseline-interval` 与 `--scene-threshold`；已有完整产物默认就地复用，仅 `--force-rebuild` 时重建。
- **低上下文分片架构 (`plan-slices` + 渐进式 Skill)**：
  - 新增 `plan-slices` 命令，将各时间切片的完整字幕与关键帧路径落盘至 `work/slices/slice_XX.txt` + `index.json`，终端 `stdout` 恒控制在 `<= 30` 行；
  - 配套的 `skills/video-analysis/` 采用渐进式披露拆分（精简 `SKILL.md` + 4 个按需读取 `references/*.md`），将批量看图与原始 ASR 校对下沉至并行 `research` 子代理，主会话仅消费每片 1–2 KB 结构化摘要；
  - `save-note --status completed` 强制执行门禁校验后原子落盘 `note.md`，并自动安全清理 `work/`（含 `video_merged.mp4` 与 `work/slices/`）。

## CLI 命令总览

入口脚本：`./bin/video-notes`（支持 `--json` 结构化输出、`--data-dir`、`--model-dir`、`--python` 覆盖）

| 命令 | 用途 | 核心参数 |
|---|---|---|
| `doctor` | 检查 Node、Python、`yt-dlp`、`faster-whisper`、FFmpeg、模型缓存与 Cookie 状态 | `[--data-dir <dir>]` |
| `inspect` | 探测视频/目录元信息、合集分 P 并生成稳定 `stableId` | `--url <url_or_path> [--scope single\|collection]` |
| `prepare` | 下载/合流媒体、获取字幕或执行本地 ASR、抽取关键帧并保存 `metadata.json` | `--url <url_or_path> --entry-id <id> [--baseline-interval 4 --scene-threshold 0.2] [--force-rebuild]` |
| `plan-slices` | 生成按时间窗口拆分的 `slice_XX.txt` 与 `index.json`，终端仅输出 `<= 30` 行摘要 | `--entry-id <id> [--duration 90] [--out-dir <dir>]` |
| `read-slice` | 兼容命令：直接按时间窗口读取单个切片字幕与关键帧路径 | `--entry-id <id> [--start 0] [--duration 120]` |
| `save-note` | 执行结构化门禁校验（时间戳、关键帧引用、主客观分离）并原子保存 `note.md` | `--entry-id <id> --status completed\|partial --title <title> --content-file <path>` |

## 目录结构

```text
dsh-video-notes/
├── AGENTS.md                  # 工程规则与拦截机制映射表
├── README.md                  # 项目说明文档
├── package.json               # v1.0.0 元数据与脚本入口
├── bin/
│   └── video-notes            # CLI 跨平台启动封装（使用项目隔离 Node 运行时）
├── python/
│   └── transcribe.py          # faster-whisper 本地离线 ASR 脚本
├── skills/
│   └── video-analysis/        # Antigravity 渐进式披露 Skill（可直接复制到 .agents/skills/）
│       ├── SKILL.md
│       └── references/
│           ├── runtime-and-ingestion.md
│           ├── multimodal-review-rubric.md
│           ├── note-template.md
│           └── fact-check-policy.md
├── src/                       # TypeScript 源码（cli, slice-plan, pipeline, store, media 等）
├── lib/                       # 编译输出 JS / 类型声明
└── tests/
    └── regression.test.mjs    # 20 项严格正负例端到端回归测试
```

数据目录默认位于同级 `../video-notes-data/`（不纳入 Git 追踪）：
- `cookies/`：平台 Netscape Cookie 文件
- `models/`：本地 Whisper 模型缓存
- `episodes/<entryId>/`：单集 `source.json`、`transcript.json/.srt`、`frames/`、`note.md`（及临时 `work/`）
- `collections/<collectionId>/`：合集清单与索引

## 编译与回归测试

```bash
# 编译 TypeScript
npm run build

# 运行全量 20 项严格回归测试（退出码 0 即全部通过）
npm test
```
