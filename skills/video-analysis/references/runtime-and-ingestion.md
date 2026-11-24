# 运行环境、鉴权与媒体采集细则

> **读取角色与时机**：仅由主会话在**处理在线链接（B 站 / YouTube）、遇到 Cookie 鉴权报错、处理本地分离音视频目录、或需要调整抽帧采样参数**时按需读取。纯常规本地单视频分析无需载入本文件。

## 1. 隔离工具链说明

- **项目工具入口**：`./dsh-video-notes/bin/video-notes`
- 内部自动调用项目隔离的便携 Node v22、`.venv` Python 3.12、`bin/ffmpeg`、`bin/ffprobe`，以及预缓存于 `./video-notes-data/models` 的 Whisper `small` 模型。

## 2. 沙盒与联网规则

- **本地视频（含分离音视频目录）**：全程在标准沙盒内离线完成（含无损合流、模型加载与 ASR 转写）。
- **在线链接（B 站 / YouTube）**：
  1. 先按标准沙盒方式执行命令；
  2. 若沙盒网络被拒，**仅对需要联网下载的 `inspect` / `prepare` 步骤**请求 `BypassSandbox: true`（重试时保持 `toolSummary` 与前次完全一致）；
  3. 之后的 `plan-slices`、`read-slice`、`read_file`、`save-note` 全部切回标准沙盒执行。

## 3. 多平台 Cookies 自动读取与鲜度体检 (`doctor`)

- **自动发现规则**：将浏览器扩展 **Get cookies.txt LOCALLY** 导出的 Netscape 格式 Cookie 文件直接放入 `./video-notes-data/cookies/`（支持 `bilibili.txt`、`www.bilibili.com_cookies.txt` 或任意 UUID 随机文件名），工具会按文件内域名自动归类并优先取最新一份，无需每次传 `--cookies`（显式 `--cookies <path>` 仍拥有最高优先级）。
- **在线前或鉴权失败自检**：
  ```bash
  ./dsh-video-notes/bin/video-notes doctor
  ```
- 若提示 B 站 / YouTube Cookie 缺失、缺少关键字段或可能过期（默认超过 168h 提示），引导用户用 Windows Chrome/Edge 的 **Get cookies.txt LOCALLY** 导出并直接拖入 `./video-notes-data/cookies/`。

## 4. 本地分离音视频自动配对与无损合流

- 若浏览器（如猫抓等扩展）保存出分离的纯视频文件与纯音频文件，只需将二者放在同一文件夹并直接传入该**目录路径**或**纯视频文件路径**。
- 工具会自动按 `vid:` 元数据标签、同前缀或唯一配对规则识别伴生音频，并在条目 `work/` 目录内完成无损合流（**绝不改动原存放目录文件**）。
- 在 `inspect` 阶段若检测到自动配对音频，向用户确认配对的音频文件名。

## 5. `inspect` 与 `prepare` 参数策略

- **范围控制 (`inspect`)**：
  ```bash
  ./dsh-video-notes/bin/video-notes inspect --url "<url_or_local_path>" --scope single
  ```
  - 仅当用户明确要求处理整套合集/全部分 P 时，才传 `--scope collection`；单视频默认只处理当前集或指定分 P。
  - 若传入包含多个无关完整视频的目录，工具会明确列出候选文件名并要求用户指定具体路径。
  - 记下返回的 `stableId`，向用户简要说明视频标题、时长与待处理范围。
- **字幕与转写 (`prepare`)**：
  ```bash
  ./dsh-video-notes/bin/video-notes prepare --url "<url_or_local_path>" --entry-id "<stableId>"
  ```
  - 优先获取平台字幕（或本地视频同目录同名 `.srt`/`.vtt`）；若无可用字幕，自动抽取音轨并调用本地 `faster-whisper` (`small`, CPU `int8`, `--language auto`) 转写。
- **抽帧密度建议**：
  - 默认抽帧基线为 `10` 秒、场景阈值 `0.3`。
  - 处理切换频繁的**快节奏短视频或界面操作教程**时，按需附加 `--baseline-interval 4 --scene-threshold 0.2` 提高抽帧密度。
- **资产就地复用与重建**：
  - 若该条目已有完整 `source.json`、`transcript.json` 与 `frames/metadata.json`，默认就地复用，不重复下载或转写。
  - 仅当用户明确要求重跑或更换抽帧密度时传 `--force-rebuild`（会自动清理旧帧并重新生成）。
