---
name: video-analysis
description: >-
  获取 B 站、YouTube 或本地视频/分离音视频目录的字幕（优先平台/外挂字幕，缺失时调用本地 faster-whisper ASR）与 FFmpeg 关键帧，通过分片子代理多模态看图生成结构化复习笔记并落盘到 video-notes-data。当用户提供视频链接、本地视频/分离音视频目录路径，或要求总结视频、提取操作步骤与整理学习笔记时使用；普通非视频闲聊、纯代码开发或一般文档问答不触发。
---

# 视频多模态分析与结构化笔记工作流

指导 Agent 使用 `./dsh-video-notes/bin/video-notes` 与并行 `research` 子代理完成视频采集、分片多模态核图与结构化笔记落盘，兼顾低主会话上下文占用与高质量交付。

## 核心红线

- **工具入口**：`./dsh-video-notes/bin/video-notes`（自动使用项目隔离 Node/Python/FFmpeg 与缓存模型）。
- **质量零降级**：严禁削减抽帧质量或删减笔记章节、时间戳与关键帧引用；必须严格区分客观事实、原声听写与主观观点。
- **重度读图隔离**：主会话**严禁**直接调用 `read-slice` 读取全量原始 ASR，或直接批量 `read_file` 查看全片关键帧截图。批量看图与 ASR 校对必须下沉到按时间切片派发的 `research` 子代理；主会话仅消费每片 1–2 KB 的结构化摘要，必要时仅点读 1–2 张疑难帧复核。
- **沙盒策略**：本地视频全程标准沙盒离线执行；在线链接先标准沙盒执行，仅在联网被拒时对 `inspect`/`prepare` 使用 `BypassSandbox: true`（保持 `toolSummary` 不变），其余命令与看图全部切回标准沙盒。

## 按需读取路由表（严禁开局一次性全读）

| 参考文档 | 读取角色 | 精确读取时机 |
|---|---|---|
| [runtime-and-ingestion.md](./references/runtime-and-ingestion.md) | 主会话 | 仅在处理在线链接、Cookie 报错、分离音视频目录或需调抽帧参数时读取 |
| [multimodal-review-rubric.md](./references/multimodal-review-rubric.md) | `research` 子代理 | **仅由切片子代理读取**，主会话全程不读 |
| [note-template.md](./references/note-template.md) | 主会话 | 所有切片摘要回齐、准备撰写草稿与执行 `save-note` 时读取 |
| [fact-check-policy.md](./references/fact-check-policy.md) | 主会话 | 仅在撰写独立“AI 补充解释/联网核查”章节时读取 |

## 执行流程

1. **探测元信息 (`inspect`)**：
   - 如遇在线链接鉴权疑虑或需自检环境，先读 [runtime-and-ingestion.md](./references/runtime-and-ingestion.md) 并按需执行 `./dsh-video-notes/bin/video-notes doctor`。
   - 执行探测（单视频默认 `--scope single`，仅明确要求全集/全分 P 时传 `--scope collection`）：
     ```bash
     ./dsh-video-notes/bin/video-notes inspect --url "<url_or_local_path>" --scope single
     ```
   - 记下 `stableId`，向用户简要确认视频标题、时长、范围及自动配对音轨（若有）。

2. **媒体获取、字幕/ASR 与抽帧 (`prepare`)**：
   - 执行预处理（优先复用已有 `source.json`/`transcript.json`/`frames/metadata.json`；重跑或换密度时加 `--force-rebuild`）：
     ```bash
     ./dsh-video-notes/bin/video-notes prepare --url "<url_or_local_path>" --entry-id "<stableId>"
     ```
   - 快节奏短视频或界面操作教程建议附加 `--baseline-interval 4 --scene-threshold 0.2`。

3. **生成切片清单与派发多模态子代理 (`plan-slices` + `research`)**：
   - 执行低输出切片索引命令（将各段 ASR 与帧路径落盘至 `work/slices/slice_XX.txt`，`stdout` 恒 ≤ 30 行）：
     ```bash
     ./dsh-video-notes/bin/video-notes plan-slices --entry-id "<stableId>" --duration 90
     ```
   - 对摘要中的每个 `slice_XX.txt`，并行调用 `invoke_subagent`（`TypeName: "research"`），在 `Prompt` 中明确要求子代理：
     1. 先读取 `.agents/skills/video-analysis/references/multimodal-review-rubric.md` 与分配的 `slice_XX.txt`；
     2. 按两阶段核图规则用 `read_file` 查看关键帧并与 ASR 交叉校对；
     3. 严格按契约仅回传 1–2 KB 结构化摘要（禁止把整段原始 ASR 贴回主会话）。
   - 等待所有切片子代理回传；仅当子代理明确标出模糊或口径冲突的疑难帧时，主会话才点读该 1–2 张截图复核。（`read-slice` 命令仅保留作单段排错兼容。）

4. **汇总编写笔记并门禁落盘 (`save-note`)**：
   - 所有切片摘要收齐后，读取 [note-template.md](./references/note-template.md)（若需补充联网核查对照，按需读取 [fact-check-policy.md](./references/fact-check-policy.md)）。
   - 先用 `write_file` 写临时草稿（如 `./video-notes-data/episodes/<entryId>/note.draft.md`），再校验落盘：
     ```bash
     ./dsh-video-notes/bin/video-notes save-note --entry-id "<stableId>" --status completed --title "<视频标题>" --content-file "<草稿文件路径>"
     ```
   - 保存成功后删除 `.draft.md`（`completed` 会自动清理 `work/` 含 `work/slices/`）；若有无法弥补的遮挡或音轨缺失，改用 `--status partial --gaps-json` 保留恢复素材。

5. **合集索引与交付**：
   - 合集/多分 P 逐集完成后在 `./video-notes-data/collections/<collectionId>/index.md` 整理总览链接；向用户汇报核心结论与可点击笔记路径。
