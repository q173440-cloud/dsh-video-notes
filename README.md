# dsh-video-notes

DeepSeek Harness (Windows) 视频总结与多模态分析插件。

## 功能特性

- **多来源支持**：支持 B 站（单视频、指定分 P、多分 P 合集）、YouTube 链接及本地主流视频格式（mp4/mkv/mov）。
- **字幕与本地 ASR**：优先提取原平台字幕；无字幕时自动调用项目内 faster-whisper（medium/small CPU int8 模型）高精度转写，不产生额外云端 ASR 费用。
- **画面多模态闭环**：基于 FFmpeg 场景变化与时间基线智能抽帧，将代码、参数、图表等画面关键事实纳入分析流程。
- **结构化笔记交付**：按集生成规范 Markdown 复习笔记，包含章节大纲、时间戳证据、已知缺口与独立的 AI 补充解释。
- **合集知识脉络**：合集自动生成索引导航，逐集保存并安全清理下载的媒体临时工作副本。

## 目录结构与数据

- 插件代码目录：`dsh-video-notes`
- 数据保存目录：`video-notes-data`
  - `models/`：本地 ASR 模型缓存
  - `collections/<collectionId>/`：合集总清单与知识索引
  - `episodes/<entryId>/`：单集 source、字幕（JSON/SRT）、关键帧截图、Markdown 笔记

## 工具列表

1. `video_inspect`: 视频链接探测与单集/合集目录识别。
2. `video_prepare`: 媒体下载、字幕/ASR 转写与关键帧抽取。
3. `video_read_slice`: 按时间范围切片读取字幕与关键帧画面。
4. `video_save_note`: 保存单集结构化笔记，安全清理媒体工作缓存。

## 限制说明

- 本首版优先使用 CPU int8 进行本地 ASR，确保无需额外安装复杂 GPU 驱动或 CUDA 运行时。
- 单视频链接默认仅处理首集或指定分 P；仅当明确指定 `scope: "collection"` 时展开整套合集。
