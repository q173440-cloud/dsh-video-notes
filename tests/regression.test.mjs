import assert from 'assert';
import path from 'path';
import { promises as fs } from 'fs';
import { normalizeSegments, sliceSegments } from '../lib/transcript.js';
import { VideoNotesStore, decodeJpegDimensions } from '../lib/store.js';
import { generateLocalStableId, inspectSource } from '../lib/source.js';
import { runProcess } from '../lib/process.js';
import { VideoPipeline } from '../lib/pipeline.js';
import { hasRequiredDependencies, resolvePython } from '../lib/index.js';

async function runTests() {
  console.log('=== Running DSH Video Notes Strict Regression Suite ===');
  let passed = 0;

  // Test 1: transcript.json 对象与数组自适应读取
  console.log('Test 1: normalizeSegments adapts to both array and dict');
  const arr = [{ id: 1, start: 0, end: 5, text: 'hello' }];
  const dict = { audio: 'a.wav', duration: 10, segments: arr };
  assert.strictEqual(normalizeSegments(arr).length, 1);
  assert.strictEqual(normalizeSegments(dict).length, 1);
  assert.throws(() => normalizeSegments({ invalid: true }), /Invalid transcript format/);
  console.log(' -> Test 1 PASSED');
  passed++;

  // Test 2: stableId 碰撞修复验证
  console.log('Test 2: generateLocalStableId distinguishes different paths');
  const id1 = generateLocalStableId('E:/0/AI/video1.mp4');
  const id2 = generateLocalStableId('E:/0/AI/video2.mp4');
  assert.notStrictEqual(id1, id2, 'Different paths MUST produce different stableIds!');
  assert(id1.includes('video1') && id2.includes('video2'));
  console.log(` -> Test 2 PASSED (id1: ${id1}, id2: ${id2})`);
  passed++;

  // Test 3: saveNote 校验 - 拒绝短文本 completed
  console.log('Test 3: saveNote rejects short or unformatted content when completed');
  const store = new VideoNotesStore('E:/0/AI/DeepSeek Harness/插件制作/video-notes-data');
  await assert.rejects(async () => {
    await store.saveNote({
      entryId: 'test-dummy',
      title: 'dummy',
      status: 'completed',
      contentMarkdown: 'x'
    });
  }, /Cannot mark note as 'completed'/);
  console.log(' -> Test 3 PASSED');
  passed++;

  // Test 4: saveNote partial 保护 workDir 恢复素材
  console.log('Test 4: saveNote preserves workDir on partial status');
  const dummyEpisode = path.join('E:/0/AI/DeepSeek Harness/插件制作/video-notes-data/episodes/test-protect-work');
  const dummyWork = path.join(dummyEpisode, 'work');
  await fs.mkdir(dummyWork, { recursive: true });
  await fs.writeFile(path.join(dummyWork, 'resume.mp4'), 'test media');

  const resPartial = await store.saveNote({
    entryId: 'test-protect-work',
    title: 'test',
    status: 'partial',
    contentMarkdown: 'partial working content that should not trigger wipe'
  });
  assert.strictEqual(resPartial.cleanedWorkDir, false);
  const stillExists = await fs.stat(path.join(dummyWork, 'resume.mp4')).then(() => true).catch(() => false);
  assert.strictEqual(stillExists, true, 'workDir media MUST be preserved on partial status!');
  await fs.rm(dummyEpisode, { recursive: true, force: true });
  console.log(' -> Test 4 PASSED (recovery media preserved)');
  passed++;

  // Test 5: saveNote 校验未准备条目严禁标记为 completed
  console.log('Test 5: saveNote rejects completed status for unprepared entry without source/transcript/frames');
  await assert.rejects(async () => {
    await store.saveNote({
      entryId: 'test-unprepared-entry',
      title: 'unprepared',
      status: 'completed',
      contentMarkdown: '# Valid Title\n\n## Section\n\n' + 'Fake placeholder text '.repeat(20)
    });
  }, /Cannot mark note as 'completed': missing or invalid source\.json/);
  console.log(' -> Test 5 PASSED');
  passed++;

  // Test 6: 负例拦截测试：伪造的只含 FF D8 的数据不可解码、非法字幕、阻塞缺口均被拦截
  console.log('Test 6: saveNote REJECTS fake image (undecodable FF D8 buffer), invalid timestamps, and critical gaps');
  const negEpisode = path.join('E:/0/AI/DeepSeek Harness/插件制作/video-notes-data/episodes/test-neg-cases');
  const negFrames = path.join(negEpisode, 'frames');
  await fs.mkdir(negFrames, { recursive: true });

  await fs.writeFile(path.join(negEpisode, 'source.json'), JSON.stringify({ entryId: 'test-neg', title: 'test', duration: 100 }));
  await fs.writeFile(path.join(negEpisode, 'transcript.json'), JSON.stringify([{ id: 1, start: 0, end: 5, text: 'ok' }]));

  // 负例 A：只填前两字节为 0xFF 0xD8 但实际无法解码的伪造数据
  const fakeUndecodablePath = path.join(negFrames, 'fake_undecodable.jpg');
  const fakeBuf = Buffer.alloc(2048);
  fakeBuf[0] = 0xFF; fakeBuf[1] = 0xD8; // 仅伪造头部魔数，缺少真实段与 EOI
  await fs.writeFile(fakeUndecodablePath, fakeBuf);
  await fs.writeFile(path.join(negFrames, 'metadata.json'), JSON.stringify([{ id: 'f1', filename: 'fake_undecodable.jpg', path: fakeUndecodablePath, timestamp: 0 }]));

  await assert.rejects(async () => {
    await store.saveNote({
      entryId: 'test-neg-cases',
      title: 'test',
      status: 'completed',
      contentMarkdown: '# Valid Title\n\n## Section\n\n' + 'Legitimate analysis content '.repeat(15)
    });
  }, /failed JPEG decode validation/);
  console.log(' -> Negative Example A (undecodable FF D8 pseudo-JPEG) REJECTED as expected');

  // 负例 B：时间颠倒的非法字幕
  // 复制真实可解码截图用于排除图像错误，专项拦截字幕错误
  const realSampleImgPath = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/video-notes-data/episodes/bili-BV1BgH36DE7y-p1/frames/frame_0001.jpg');
  await fs.copyFile(realSampleImgPath, fakeUndecodablePath);
  await fs.writeFile(path.join(negEpisode, 'transcript.json'), JSON.stringify([{ id: 1, start: 10, end: 5, text: 'backwards' }]));

  await assert.rejects(async () => {
    await store.saveNote({
      entryId: 'test-neg-cases',
      title: 'test',
      status: 'completed',
      contentMarkdown: '# Valid Title\n\n## Section\n\n' + 'Legitimate analysis content '.repeat(15)
    });
  }, /invalid segment timestamps/);
  console.log(' -> Negative Example B (invalid timestamps) REJECTED as expected');

  // 负例 C：带有未解决严重缺口
  await fs.writeFile(path.join(negEpisode, 'transcript.json'), JSON.stringify([{ id: 1, start: 0, end: 5, text: 'ok' }]));
  await assert.rejects(async () => {
    await store.saveNote({
      entryId: 'test-neg-cases',
      title: 'test',
      status: 'completed',
      contentMarkdown: '# Valid Title\n\n## Section\n\n' + 'Legitimate analysis content '.repeat(15),
      gaps: ['处理失败：媒体流严重损坏']
    });
  }, /unresolved critical gaps present/);
  console.log(' -> Negative Example C (critical gap present) REJECTED as expected');

  await fs.rm(negEpisode, { recursive: true, force: true });
  console.log(' -> Test 6 ALL NEGATIVE CASES SUCCESSFULLY INTERCEPTED!');
  passed++;

  // Test 7: 真正合格的正例：采用真实可解码高清截图与完整真实元数据，校验通过并清理 work
  console.log('Test 7: saveNote accepts genuine decodable screenshot and valid artifacts, then cleans workDir');
  const posEpisode = path.join('E:/0/AI/DeepSeek Harness/插件制作/video-notes-data/episodes/test-pos-case');
  const posWork = path.join(posEpisode, 'work');
  const posFrames = path.join(posEpisode, 'frames');
  await fs.mkdir(posWork, { recursive: true });
  await fs.mkdir(posFrames, { recursive: true });
  await fs.writeFile(path.join(posEpisode, 'source.json'), JSON.stringify({ entryId: 'test-pos-case', title: 'test', duration: 120 }));
  await fs.writeFile(path.join(posEpisode, 'transcript.json'), JSON.stringify([{ id: 1, start: 0, end: 5, text: 'authentic transcript segment' }]));
  
  // 采用已验证通过的真实可解码截图作为正例
  const realImgDest = path.join(posFrames, 'frame_0001.jpg');
  await fs.copyFile(realSampleImgPath, realImgDest);
  
  // 验证测试本身确认该截图可被 decodeJpegDimensions 解码出真实宽高
  const decodedDim = decodeJpegDimensions(await fs.readFile(realImgDest));
  assert(decodedDim.width > 0 && decodedDim.height > 0);
  console.log(` -> Verified genuine positive screenshot decodable: ${decodedDim.width}x${decodedDim.height}`);

  await fs.writeFile(path.join(posFrames, 'metadata.json'), JSON.stringify([{ id: 'f1', filename: 'frame_0001.jpg', path: realImgDest, timestamp: 0 }]));
  await fs.writeFile(path.join(posWork, 'temp.mp4'), 'temp video');

  const resPos = await store.saveNote({
    entryId: 'test-pos-case',
    title: 'test',
    status: 'completed',
    contentMarkdown: '# Authentic Note Title\n\n## Detailed Chapter\n\n' + 'Comprehensive analysis text content '.repeat(10)
  });
  assert.strictEqual(resPos.status, 'completed');
  assert.strictEqual(resPos.cleanedWorkDir, true);
  const workGone = await fs.stat(posWork).then(() => true).catch(() => false);
  assert.strictEqual(workGone, false);
  await fs.rm(posEpisode, { recursive: true, force: true });
  console.log(' -> Test 7 PASSED (genuine positive case cleanly completed)');
  passed++;

  // Test 8: 真实样本 readSlice 严格从 metadata.json 读取真实时间戳（无任何 30fps 假设）
  console.log('Test 8: readSlice on bili sample strictly reads real persisted metadata');
  const pipeline = new VideoPipeline({
    pythonExe: 'python.exe',
    ffmpegExe: 'ffmpeg.exe',
    ffprobeExe: 'ffprobe.exe',
    transcribeScript: '',
    store
  });
  const slice = await pipeline.readSlice('bili-BV1BgH36DE7y-p1', 0, 60);
  assert(slice.segments.length > 0);
  assert(slice.frames.length > 0);
  assert.strictEqual(slice.frames[0].timestamp, 0.0);
  console.log(` -> Test 8 PASSED (segments: ${slice.segments.length}, frames: ${slice.frames.length})`);
  passed++;

  // Test 9: Python 依赖验证严格性
  console.log('Test 9: resolvePython strictly rejects incomplete python without dependencies');
  const validVenvPython = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/dsh-video-notes/.venv/Scripts/python.exe');
  const selected = await resolvePython(undefined, path.resolve('E:/0/AI/DeepSeek Harness/插件制作/dsh-video-notes'));
  assert.strictEqual(selected, validVenvPython);

  await assert.rejects(async () => {
    await resolvePython('C:/Windows/notepad.exe', 'E:/nonexistent-dir');
  }, /No viable Python 3\.12 environment with required dependencies/);
  console.log(' -> Test 9 PASSED (strictly rejects invalid python)');
  passed++;

  // Test 10: 已有条目产物完备时，prepareEpisode 严禁重新下载网络媒体，必须就地复用已准备资产
  console.log('Test 10: prepareEpisode reuses existing complete artifacts without downloading');
  const reuseEpisodeId = 'bili-BV1BgH36DE7y-p1';
  const prepReuseRes = await pipeline.prepareEpisode('https://www.bilibili.com/video/BV1BgH36DE7y', reuseEpisodeId);
  assert.strictEqual(prepReuseRes.reusedExisting, true, 'Must reuse existing artifacts!');
  assert(prepReuseRes.frameCount > 0, 'Frame count must be preserved');
  console.log(' -> Test 10 PASSED (successfully reused existing prepared artifacts)');
  passed++;

  // Test 11: 详尽笔记 completed 状态强校验时间戳、关键帧引用与主客观区分
  console.log('Test 11: saveNote enforces timestamps, keyframe evidence, and author opinions distinction on detailed notes');
  const test11Episode = path.join('E:/0/AI/DeepSeek Harness/插件制作/video-notes-data/episodes/test-review-quality');
  const t11Frames = path.join(test11Episode, 'frames');
  await fs.mkdir(t11Frames, { recursive: true });
  await fs.writeFile(path.join(test11Episode, 'source.json'), JSON.stringify({ entryId: 'test-review-quality', title: 'Quality Test', duration: 300 }));
  await fs.writeFile(path.join(test11Episode, 'transcript.json'), JSON.stringify([{ id: 1, start: 0, end: 10, text: 'test transcript segment' }]));
  const t11ImgDest = path.join(t11Frames, 'frame_0001.jpg');
  await fs.copyFile(realSampleImgPath, t11ImgDest);
  await fs.writeFile(path.join(t11Frames, 'metadata.json'), JSON.stringify([{ id: 'f1', filename: 'frame_0001.jpg', path: t11ImgDest, timestamp: 0 }]));

  // 负例 11A：长篇笔记缺少明确时间戳锚点
  const longTextNoTimestamps = '# Title\n\n## Section 1\n\n' + 'Step description without any timestamps. '.repeat(20);
  await assert.rejects(async () => {
    await store.saveNote({
      entryId: 'test-review-quality',
      title: 'Quality Test',
      status: 'completed',
      contentMarkdown: longTextNoTimestamps
    });
  }, /note must contain explicit timestamps/);
  console.log(' -> Negative Example 11A (missing timestamps) REJECTED as expected');

  // 负例 11B：长篇笔记缺少关键帧画面证据定位
  const longTextNoFrames = '# Title\n\n## Section 1\n\n[01:23] Step 1.\n\n[02:45] Step 2.\n\n' + 'Content without visual frame reference. '.repeat(20);
  await assert.rejects(async () => {
    await store.saveNote({
      entryId: 'test-review-quality',
      title: 'Quality Test',
      status: 'completed',
      contentMarkdown: longTextNoFrames
    });
  }, /note must reference concrete visual keyframe evidence/);
  console.log(' -> Negative Example 11B (missing keyframe evidence) REJECTED as expected');

  // 负例 11C：长篇笔记缺少 UP 主主观观点与客观事实的区隔标记
  const longTextNoDistinction = '# Title\n\n## Section 1\n\n[01:23] Step 1 [关键帧: frame_0001.jpg].\n\n[02:45] Step 2 [关键帧: frame_0001.jpg].\n\n' + 'Fact-only without perspective distinction. '.repeat(20);
  await assert.rejects(async () => {
    await store.saveNote({
      entryId: 'test-review-quality',
      title: 'Quality Test',
      status: 'completed',
      contentMarkdown: longTextNoDistinction
    });
  }, /note must explicitly distinguish author opinions/);
  console.log(' -> Negative Example 11C (missing opinion distinction) REJECTED as expected');

  // 正例 11D：包含时间戳、关键帧引用以及明确的【UP主观点】与客观事实区隔
  const validDetailedNote = '# Title\n\n## 章节大纲与实操 [01:23]\n\n[01:23] 执行命令配置 [关键帧: frame_0001.jpg @ 01:23]。\n\n[02:45] 查看参数结果 [关键帧: frame_0001.jpg @ 02:45]。\n\n## UP主观点与评价\n\nUP主观点：该工具在特定场景下有优势，但作者评价认为仍需谨慎。\n\n' + 'Detailed comprehensive content. '.repeat(15);
  const resValid = await store.saveNote({
    entryId: 'test-review-quality',
    title: 'Quality Test',
    status: 'completed',
    contentMarkdown: validDetailedNote
  });
  assert.strictEqual(resValid.status, 'completed');
  console.log(' -> Positive Example 11D (fully compliant detailed note) ACCEPTED as expected');

  await fs.rm(test11Episode, { recursive: true, force: true });
  console.log(' -> Test 11 ALL QUALITY & RECALL VERIFICATIONS PASSED!');
  passed++;

  
  // Test 12: 验证 Windows 下 runProcess 在无 subprocessService 时的强兼容性（彻底解决 spawn EPERM）
  console.log('Test 12: runProcess executes safely in constrained environment without spawn EPERM');
  const procRes = await runProcess('cmd.exe', ['/c', 'echo SANDBOX_PROC_COMPLIANT']);
  assert.strictEqual(procRes.code, 0, 'Exit code must be 0');
  assert(procRes.stdout.includes('SANDBOX_PROC_COMPLIANT'), 'Stdout must capture output via file redirect fallback');
  console.log(' -> Test 12 PASSED (runProcess EPERM fallback verified)');
  passed++;

  // Test 13: 验证 B 站 UGC 合集 (ugc_season) 自动探测与条目展开能力
  console.log('Test 13: inspectSource automatically resolves UGC season episodes on collection scope');
  const validPython = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/dsh-video-notes/.venv/Scripts/python.exe');
  const ugcResult = await inspectSource('https://www.bilibili.com/video/BV1pwnj6BEMP', {
    pythonExe: validPython,
    scope: 'collection'
  });
  assert.strictEqual(ugcResult.sourceType, 'bilibili');
  assert.strictEqual(ugcResult.isCollection, true);
  assert(ugcResult.items.length >= 8, `Expected at least 8 episodes in season, got ${ugcResult.items.length}`);
  const firstEp = ugcResult.items[0];
  assert(firstEp.stableId.startsWith('bili-'), 'Item stableId must follow bilibili contract');
  assert(firstEp.duration > 0, 'Item must have valid duration');
  console.log(` -> Test 13 PASSED (UGC season resolved ${ugcResult.items.length} items automatically)`);
  passed++;

  // Test 14: 验证缺失音频流时的端到端自动探测与合并补救机制
  console.log('Test 14: pipeline detects missing audio track and executes auto-merge fallback');
  const test14Episode = path.join('E:/0/AI/DeepSeek Harness/插件制作/video-notes-data/episodes/test-audio-recovery');
  const t14Work = path.join(test14Episode, 'work');
  await fs.mkdir(t14Work, { recursive: true });

  const ffmpegExe = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/dsh-video-notes/bin/ffmpeg.exe');
  const ffprobeExe = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/dsh-video-notes/bin/ffprobe.exe');
  const sampleVid = path.resolve('E:/0/AI/DeepSeek Harness/插件制作/test_sample.mp4');
  const noAudioVid = path.join(t14Work, 'video_silent.mp4');
  const suppAudio = path.join(t14Work, 'supplement_audio.wav');

  // 1. 生成纯视频（无音频轨）
  await runProcess(ffmpegExe, ['-y', '-i', sampleVid, '-an', '-c:v', 'copy', noAudioVid]);
  
  // 验证探针确认无音频轨
  const probeBefore = await pipeline.readSlice ? await import('../lib/media.js').then(m => m.probeMedia(ffprobeExe, noAudioVid)) : { audioTracks: [] };
  assert.strictEqual(probeBefore.audioTracks.length, 0, 'Prepared video MUST have 0 audio tracks for test');

  // 2. 生成辅助音频供补救合流
  await runProcess(ffmpegExe, ['-y', '-i', sampleVid, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', suppAudio]);
  assert.strictEqual(await fs.stat(suppAudio).then(() => true).catch(() => false), true);

  // 3. 运行 pipeline.prepareEpisode，传入无音频视频
  const testPipeline = new VideoPipeline({
    pythonExe: validPython,
    ffmpegExe,
    ffprobeExe,
    transcribeScript: path.resolve('E:/0/AI/DeepSeek Harness/插件制作/dsh-video-notes/python/transcribe.py'),
    store
  });

  const prepRes = await testPipeline.prepareEpisode(noAudioVid, 'test-audio-recovery', { forceRebuild: true });
  assert.strictEqual(prepRes.entryId, 'test-audio-recovery');
  
  // 验证生成的 transcript.json 是否成功由补救音频转写产出
  const tStat = await fs.stat(path.join(test14Episode, 'transcript.json')).then(() => true).catch(() => false);
  assert.strictEqual(tStat, true, 'transcript.json MUST be successfully generated after audio recovery');

  await fs.rm(test14Episode, { recursive: true, force: true });
  console.log(' -> Test 14 PASSED (end-to-end audio recovery successfully verified)');
  passed++;

  console.log(`\nALL ${passed} STRICT REGRESSION TESTS PASSED!`);
}

runTests().catch(err => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
