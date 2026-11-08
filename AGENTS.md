# dsh-video-notes 工程规则与拦截机制

## 规则与拦截机制

| 规则 | 由什么拦住 |
|---|---|
| `transcript.json` 必须兼容对象格式与数组格式 | `src/transcript.ts` 中的 `normalizeSegments` 强校验 + `pnpm test` (Test 1) |
| 本地视频 `stableId` 必须基于规范化路径 SHA-256 唯一生成，严禁截断碰撞 | `src/source.ts` 中的 `generateLocalStableId` + `pnpm test` (Test 2) |
| `saveNote` 在 `partial` 状态严禁删除 `workDir`，保护恢复素材 | `src/store.ts` 状态分支判断 + `pnpm test` (Test 4) |
| 未准备条目严禁标记为 `completed` | `src/store.ts` 物理产物核验 + `pnpm test` (Test 5) |
| 伪造图片文件（非合法 JPEG 魔数/大小不足）严禁标记为 `completed` | `src/store.ts` JPEG 二进制头核验 + `pnpm test` (Test 6A 负例) |
| 时间戳单调性颠倒的非法字幕严禁标记为 `completed` | `src/store.ts` 字段与时间单调性核验 + `pnpm test` (Test 6B 负例) |
| 带有阻断性严重未解决缺口的条目严禁标记为 `completed` | `src/store.ts` gaps 阻断词核验 + `pnpm test` (Test 6C 负例) |
| 抽帧、持久化与切片必须使用真实媒体时间戳，严禁假设 30fps | `src/media.ts` `-frame_pts 1` + `metadata.json` + `pnpm test` (Test 8) |
| 依赖验证失败后严禁返回残缺 Python 解释器 | `src/index.ts` `hasRequiredDependencies` + `pnpm test` (Test 9) |
| 已有条目产物完备时严禁重复下载网络媒体，必须就地复用 | `src/pipeline.ts` `hasPreparedArtifacts` + `pnpm test` (Test 10) |
| completed 完整笔记严禁缺少精确时间戳回查、关键帧定位与主客观来源区分 | `src/store.ts` 事实回查与来源区隔核验 + `pnpm test` (Test 11 负例与正例) |
| 交差前必须跑通测试套件，通过全部正负例回归测试 | `pnpm test` (全部测试通过) |
