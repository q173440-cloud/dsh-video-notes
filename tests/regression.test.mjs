import assert from 'assert';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { normalizeSegments, parseSubtitleContent } from '../lib/transcript.js';
import { VideoNotesStore, decodeJpegDimensions } from '../lib/store.js';
import {
  generateLocalStableId,
  inspectSource,
  extractUrlFromInput,
  detectSourceType,
  normalizeInputUrl,
  getYtDlpExtraArgs
} from '../lib/source.js';
import {
  resolveCookiesPath,
  inspectCookiesFile,
  inspectAllCookies
} from '../lib/cookies.js';
import { resolveLocalTarget } from '../lib/local-media.js';
import { runProcess } from '../lib/process.js';
import { VideoPipeline } from '../lib/pipeline.js';
import { extractKeyframes, probeMedia } from '../lib/media.js';
import { resolveBinary, resolvePython } from '../lib/index.js';

const __filename = fileURLToPath(import.meta.url);
const pkgRoot = path.resolve(path.dirname(__filename), '..');
const defaultModelDir = path.resolve(pkgRoot, '..', 'video-notes-data', 'models');

async function runTests() {
  console.log('=== Running DSH Video Notes Cross-Platform Strict Regression Suite ===');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-video-notes-test-'));
  const dataDir = path.join(tempRoot, 'data');
  const store = new VideoNotesStore(dataDir);
  await store.init();

  let passed = 0;

  try {
    const ffmpegExe = await resolveBinary('ffmpeg', pkgRoot);
    const ffprobeExe = await resolveBinary('ffprobe', pkgRoot);
    const validPython = await resolvePython(undefined, pkgRoot);
    const transcribeScript = path.join(pkgRoot, 'python', 'transcribe.py');

    // Generate genuine test media assets (24fps video + 440Hz tone + authentic JPEG frame)
    const fixturesDir = path.join(tempRoot, 'fixtures');
    await fs.mkdir(fixturesDir, { recursive: true });
    const sampleVid = path.join(fixturesDir, 'sample_24fps.mp4');
    const realSampleImgPath = path.join(fixturesDir, 'real_frame.jpg');

    const genVid = await runProcess(ffmpegExe, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2.5:size=320x240:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2.5:sample_rate=16000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      sampleVid
    ]);
    assert.strictEqual(genVid.code, 0, `ffmpeg fixture generation failed: ${genVid.stderr}`);

    const genImg = await runProcess(ffmpegExe, [
      '-y', '-i', sampleVid, '-frames:v', '1', '-q:v', '3', realSampleImgPath
    ]);
    assert.strictEqual(genImg.code, 0, `ffmpeg sample JPEG generation failed: ${genImg.stderr}`);

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
    const id1 = generateLocalStableId(path.join(tempRoot, 'video1.mp4'));
    const id2 = generateLocalStableId(path.join(tempRoot, 'video2.mp4'));
    assert.notStrictEqual(id1, id2, 'Different paths MUST produce different stableIds!');
    assert(id1.includes('video1') && id2.includes('video2'));
    console.log(` -> Test 2 PASSED (id1: ${id1}, id2: ${id2})`);
    passed++;

    // Test 3: saveNote 校验 - 拒绝短文本 completed
    console.log('Test 3: saveNote rejects short or unformatted content when completed');
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
    const ep4 = store.getEpisodePaths('test-protect-work');
    await fs.mkdir(ep4.workDir, { recursive: true });
    await fs.writeFile(path.join(ep4.workDir, 'resume.mp4'), 'test media');

    const resPartial = await store.saveNote({
      entryId: 'test-protect-work',
      title: 'test',
      status: 'partial',
      contentMarkdown: 'partial working content that should not trigger wipe'
    });
    assert.strictEqual(resPartial.cleanedWorkDir, false);
    const stillExists = await fs.stat(path.join(ep4.workDir, 'resume.mp4')).then(() => true).catch(() => false);
    assert.strictEqual(stillExists, true, 'workDir media MUST be preserved on partial status!');
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
    console.log('Test 6: saveNote REJECTS fake image, invalid timestamps, and critical gaps');
    const ep6 = store.getEpisodePaths('test-neg-cases');
    await fs.mkdir(ep6.framesDir, { recursive: true });
    await fs.writeFile(ep6.sourceJson, JSON.stringify({ entryId: 'test-neg-cases', title: 'test', duration: 100 }));
    await fs.writeFile(ep6.transcriptJson, JSON.stringify([{ id: 1, start: 0, end: 5, text: 'ok' }]));

    const fakeUndecodablePath = path.join(ep6.framesDir, 'fake_undecodable.jpg');
    const fakeBuf = Buffer.alloc(2048);
    fakeBuf[0] = 0xFF; fakeBuf[1] = 0xD8;
    await fs.writeFile(fakeUndecodablePath, fakeBuf);
    await fs.writeFile(
      path.join(ep6.framesDir, 'metadata.json'),
      JSON.stringify([{ id: 'f1', filename: 'fake_undecodable.jpg', path: fakeUndecodablePath, timestamp: 0 }])
    );

    await assert.rejects(async () => {
      await store.saveNote({
        entryId: 'test-neg-cases',
        title: 'test',
        status: 'completed',
        contentMarkdown: '# Valid Title\n\n## Section\n\n' + 'Legitimate analysis content '.repeat(15)
      });
    }, /failed JPEG decode validation/);
    console.log(' -> Negative Example A (undecodable FF D8 pseudo-JPEG) REJECTED as expected');

    await fs.copyFile(realSampleImgPath, fakeUndecodablePath);
    await fs.writeFile(ep6.transcriptJson, JSON.stringify([{ id: 1, start: 10, end: 5, text: 'backwards' }]));

    await assert.rejects(async () => {
      await store.saveNote({
        entryId: 'test-neg-cases',
        title: 'test',
        status: 'completed',
        contentMarkdown: '# Valid Title\n\n## Section\n\n' + 'Legitimate analysis content '.repeat(15)
      });
    }, /invalid segment timestamps/);
    console.log(' -> Negative Example B (invalid timestamps) REJECTED as expected');

    await fs.writeFile(ep6.transcriptJson, JSON.stringify([{ id: 1, start: 0, end: 5, text: 'ok' }]));
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
    passed++;

    // Test 7: 真正合格的正例：采用真实可解码截图与完整元数据，校验通过并清理 work
    console.log('Test 7: saveNote accepts genuine decodable screenshot and valid artifacts, then cleans workDir');
    const ep7 = store.getEpisodePaths('test-pos-case');
    await fs.mkdir(ep7.workDir, { recursive: true });
    await fs.mkdir(ep7.framesDir, { recursive: true });
    await fs.writeFile(ep7.sourceJson, JSON.stringify({ entryId: 'test-pos-case', title: 'test', duration: 120 }));
    await fs.writeFile(ep7.transcriptJson, JSON.stringify([{ id: 1, start: 0, end: 5, text: 'authentic transcript segment' }]));

    const realImgDest = path.join(ep7.framesDir, 'frame_0001.jpg');
    await fs.copyFile(realSampleImgPath, realImgDest);
    const decodedDim = decodeJpegDimensions(await fs.readFile(realImgDest));
    assert(decodedDim.width > 0 && decodedDim.height > 0);
    console.log(` -> Verified genuine positive screenshot decodable: ${decodedDim.width}x${decodedDim.height}`);

    await fs.writeFile(
      path.join(ep7.framesDir, 'metadata.json'),
      JSON.stringify([{ id: 'f1', filename: 'frame_0001.jpg', path: realImgDest, timestamp: 0 }])
    );
    await fs.writeFile(path.join(ep7.workDir, 'temp.mp4'), 'temp video');

    const resPos = await store.saveNote({
      entryId: 'test-pos-case',
      title: 'test',
      status: 'completed',
      contentMarkdown: '# Authentic Note Title\n\n## Detailed Chapter\n\n' + 'Comprehensive analysis text content '.repeat(10)
    });
    assert.strictEqual(resPos.status, 'completed');
    assert.strictEqual(resPos.cleanedWorkDir, true);
    const workGone = await fs.stat(ep7.workDir).then(() => true).catch(() => false);
    assert.strictEqual(workGone, false);
    console.log(' -> Test 7 PASSED (genuine positive case cleanly completed)');
    passed++;

    // Test 8: 真实 24fps 样本抽帧与 readSlice 严格读取真实持久化 PTS（无 30fps 假设）
    console.log('Test 8: extractKeyframes + readSlice strictly persist and read real 24fps metadata');
    const ep8 = store.getEpisodePaths('test-pts-24fps');
    await fs.mkdir(ep8.episodeDir, { recursive: true });
    const frames8 = await extractKeyframes(ffmpegExe, ffprobeExe, sampleVid, ep8.framesDir, {
      baselineIntervalSec: 1,
      sceneChangeThreshold: 0.3
    });
    assert(frames8.length >= 2, `Expected >= 2 keyframes from 2.5s video, got ${frames8.length}`);
    assert.strictEqual(frames8[0].timestamp, 0);
    await store.saveEpisodeSource('test-pts-24fps', {
      entryId: 'test-pts-24fps',
      title: '24fps Sample',
      duration: 2.5
    });
    await fs.writeFile(ep8.transcriptJson, JSON.stringify([
      { id: 1, start: 0, end: 1.5, text: 'first segment', source: 'local-asr' },
      { id: 2, start: 1.5, end: 2.5, text: 'second segment', source: 'local-asr' }
    ]));

    const pipeline = new VideoPipeline({
      pythonExe: validPython,
      ffmpegExe,
      ffprobeExe,
      transcribeScript,
      store,
      modelDir: defaultModelDir
    });
    const slice = await pipeline.readSlice('test-pts-24fps', 0, 2);
    assert(slice.segments.length >= 1);
    assert(slice.frames.length >= 1);
    assert.strictEqual(slice.frames[0].timestamp, 0);
    console.log(` -> Test 8 PASSED (24fps frames: ${frames8.length}, slice segments: ${slice.segments.length})`);
    passed++;

    // Test 9: Python 依赖验证严格性
    console.log('Test 9: resolvePython selects valid venv python and rejects incomplete python');
    const selected = await resolvePython(undefined, pkgRoot);
    assert.strictEqual(path.resolve(selected), path.resolve(validPython));

    await assert.rejects(async () => {
      await resolvePython('/nonexistent-dir/not-python', '/nonexistent-pkg-root');
    }, /No viable Python 3\.12 environment with required dependencies/);
    console.log(' -> Test 9 PASSED (strictly rejects invalid python)');
    passed++;

    // Test 10: 已有条目产物完备时，prepareEpisode 严禁重新下载或转写，必须就地复用
    console.log('Test 10: prepareEpisode reuses existing complete artifacts without downloading');
    const prepReuseRes = await pipeline.prepareEpisode('https://example.com/nonexistent-video', 'test-pts-24fps');
    assert.strictEqual(prepReuseRes.reusedExisting, true, 'Must reuse existing artifacts!');
    assert(prepReuseRes.frameCount >= 2, 'Frame count must be preserved');
    console.log(' -> Test 10 PASSED (successfully reused existing prepared artifacts)');
    passed++;

    // Test 11: 详尽笔记 completed 状态强校验时间戳、关键帧引用与主客观区分
    console.log('Test 11: saveNote enforces timestamps, keyframe evidence, and author opinions distinction');
    const ep11 = store.getEpisodePaths('test-review-quality');
    await fs.mkdir(ep11.framesDir, { recursive: true });
    await fs.writeFile(ep11.sourceJson, JSON.stringify({ entryId: 'test-review-quality', title: 'Quality Test', duration: 300 }));
    await fs.writeFile(ep11.transcriptJson, JSON.stringify([{ id: 1, start: 0, end: 10, text: 'test transcript segment' }]));
    const t11ImgDest = path.join(ep11.framesDir, 'frame_0001.jpg');
    await fs.copyFile(realSampleImgPath, t11ImgDest);
    await fs.writeFile(
      path.join(ep11.framesDir, 'metadata.json'),
      JSON.stringify([{ id: 'f1', filename: 'frame_0001.jpg', path: t11ImgDest, timestamp: 0 }])
    );

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

    const validDetailedNote = '# Title\n\n## 章节大纲与实操 [01:23]\n\n[01:23] 执行命令配置 [关键帧: frame_0001.jpg @ 01:23]。\n\n[02:45] 查看参数结果 [关键帧: frame_0001.jpg @ 02:45]。\n\n## UP主观点与评价\n\nUP主观点：该工具在特定场景下有优势，但作者评价认为仍需谨慎。\n\n' + 'Detailed comprehensive content. '.repeat(15);
    const resValid = await store.saveNote({
      entryId: 'test-review-quality',
      title: 'Quality Test',
      status: 'completed',
      contentMarkdown: validDetailedNote
    });
    assert.strictEqual(resValid.status, 'completed');
    console.log(' -> Positive Example 11D (fully compliant detailed note) ACCEPTED as expected');
    passed++;

    // Test 12: runProcess 跨平台执行测试
    console.log('Test 12: runProcess executes safely in current environment');
    const procRes = await runProcess(process.execPath, ['-e', "console.log('SANDBOX_PROC_COMPLIANT')"]);
    assert.strictEqual(procRes.code, 0, 'Exit code must be 0');
    assert(procRes.stdout.includes('SANDBOX_PROC_COMPLIANT'), 'Stdout must capture output');
    console.log(' -> Test 12 PASSED (runProcess verified)');
    passed++;

    // Test 13: 平台字幕解析器（SRT/VTT）与可选在线 UGC 合集探测
    console.log('Test 13: parseSubtitleContent handles SRT/VTT deduplication & local sidecar subtitle reuse');
    const sampleVtt = `WEBVTT
Kind: captions
Language: zh-Hans

00:00:01.000 --> 00:00:03.000 align:start position:0%
{\\an8}<c>你好</c> 世界

00:00:03.200 --> 00:00:05.000
你好 世界

00:00:05.500 --> 00:00:07.800
第二句 <b>测试</b>
`;
    const parsedSubs = parseSubtitleContent(sampleVtt, 'platform-auto');
    assert.strictEqual(parsedSubs.length, 2, 'Consecutive duplicate auto-caption cues must be merged');
    assert.strictEqual(parsedSubs[0].text, '你好 世界');
    assert.strictEqual(parsedSubs[0].end, 5);
    assert.strictEqual(parsedSubs[1].text, '第二句 测试');

    const sidecarVid = path.join(fixturesDir, 'sidecar_demo.mp4');
    const sidecarSrt = path.join(fixturesDir, 'sidecar_demo.srt');
    await fs.copyFile(sampleVid, sidecarVid);
    await fs.writeFile(sidecarSrt, '1\n00:00:00,000 --> 00:00:02,000\n本地外挂字幕测试\n');
    const sidecarInspect = await inspectSource(sidecarVid, { pythonExe: validPython });
    const sidecarId = sidecarInspect.items[0].stableId;
    const sidecarPrep = await pipeline.prepareEpisode(sidecarVid, sidecarId, { forceRebuild: true });
    assert.strictEqual(sidecarPrep.transcriptSource, 'platform-manual');
    assert.strictEqual(sidecarPrep.hasPlatformSubtitle, true);

    if (process.env.RUN_ONLINE_TESTS === '1') {
      const ugcResult = await inspectSource('https://www.bilibili.com/video/BV1pwnj6BEMP', {
        pythonExe: validPython,
        scope: 'collection'
      });
      assert.strictEqual(ugcResult.sourceType, 'bilibili');
      assert.strictEqual(ugcResult.isCollection, true);
      assert(ugcResult.items.length >= 8);
      console.log(` -> Test 13 PASSED (subtitles + online UGC season ${ugcResult.items.length} items)`);
    } else {
      console.log(' -> Test 13 PASSED (subtitles & local sidecar reuse; set RUN_ONLINE_TESTS=1 for live bilibili probe)');
    }
    passed++;

    // Test 14: 缺失音频轨自动探测与补救合流 + 真实本地 ASR 转写路径
    console.log('Test 14: pipeline detects missing audio track, merges supplement audio, and invokes ASR');
    const ep14 = store.getEpisodePaths('test-audio-recovery');
    await fs.mkdir(ep14.workDir, { recursive: true });

    const noAudioVid = path.join(ep14.workDir, 'video_silent.mp4');
    const suppAudio = path.join(ep14.workDir, 'supplement_audio.wav');
    await runProcess(ffmpegExe, ['-y', '-i', sampleVid, '-an', '-c:v', 'copy', noAudioVid]);
    const probeBefore = await probeMedia(ffprobeExe, noAudioVid);
    assert.strictEqual(probeBefore.audioTracks.length, 0, 'Prepared video MUST have 0 audio tracks for test');

    await runProcess(ffmpegExe, ['-y', '-i', sampleVid, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', suppAudio]);
    assert.strictEqual(await fs.stat(suppAudio).then(() => true).catch(() => false), true);

    const hasModelCache = await fs.readdir(defaultModelDir).then(list => list.length > 0).catch(() => false);
    assert(hasModelCache, `Expected pre-downloaded Whisper model in ${defaultModelDir}`);
    const prepRes = await pipeline.prepareEpisode(noAudioVid, 'test-audio-recovery', { forceRebuild: true });
    assert.strictEqual(prepRes.entryId, 'test-audio-recovery');
    assert.strictEqual(await fs.stat(ep14.transcriptJson).then(() => true).catch(() => false), true);
    assert.strictEqual(await fs.stat(path.join(ep14.framesDir, 'metadata.json')).then(() => true).catch(() => false), true);
    console.log(' -> Test 14 PASSED (audio recovery + offline faster-whisper ASR verified)');
    passed++;

    // Test 15: VFR 变帧率视频使用 showinfo 精确提取 pts_time，避免 r_frame_rate 漂移
    console.log('Test 15: extractKeyframes extracts accurate pts_time via showinfo for VFR video');
    const vfrVid = path.join(fixturesDir, 'sample_vfr.mp4');
    const vfrGen = await runProcess(ffmpegExe, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
      '-vf', "setpts='if(lt(T,0.5),PTS,4*PTS)'",
      '-fps_mode', 'vfr',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      vfrVid
    ]);
    assert.strictEqual(vfrGen.code, 0, `ffmpeg VFR fixture generation failed: ${vfrGen.stderr}`);
    const vfrProbe = await probeMedia(ffprobeExe, vfrVid);
    assert(vfrProbe.duration > 6.0, `Expected VFR stretched duration > 6.0s, got ${vfrProbe.duration}`);
    const vfrFramesDir = path.join(fixturesDir, 'vfr_frames');
    const vfrFrames = await extractKeyframes(ffmpegExe, ffprobeExe, vfrVid, vfrFramesDir, {
      baselineIntervalSec: 2,
      sceneChangeThreshold: 0.9
    });
    assert(vfrFrames.length >= 3, `Expected >= 3 VFR keyframes, got ${vfrFrames.length}`);
    const lastVfrTs = vfrFrames[vfrFrames.length - 1].timestamp;
    assert(lastVfrTs >= 4.0 && lastVfrTs <= vfrProbe.duration + 0.2, `Expected accurate VFR timestamp >= 4.0s and <= ${vfrProbe.duration}, got ${lastVfrTs}`);
    console.log(` -> Test 15 PASSED (VFR duration=${vfrProbe.duration.toFixed(2)}s, frames=${vfrFrames.map(f => f.timestamp).join(',')})`);
    passed++;

    // Test 16: CLI 透传抽帧密度参数与 --force-rebuild 清理旧帧
    console.log('Test 16: CLI sampling options validation and --force-rebuild frame refresh');
    const cliPath = path.join(pkgRoot, 'lib', 'cli.js');
    const t16Vid = path.join(fixturesDir, 'cli_sampling_demo.mp4');
    const t16Srt = path.join(fixturesDir, 'cli_sampling_demo.srt');
    const t16Gen = await runProcess(ffmpegExe, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5:sample_rate=16000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      t16Vid
    ]);
    assert.strictEqual(t16Gen.code, 0, `ffmpeg Test 16 fixture generation failed: ${t16Gen.stderr}`);
    await fs.writeFile(t16Srt, '1\n00:00:00,000 --> 00:00:04,500\nCLI 抽帧参数测试字幕\n');

    const badIntervalRes = await runProcess(process.execPath, [
      cliPath, 'prepare', '--data-dir', dataDir, '--url', t16Vid, '--entry-id', 'cli-sampling-t16', '--baseline-interval', '0'
    ]);
    assert.notStrictEqual(badIntervalRes.code, 0, 'Invalid --baseline-interval 0 must be rejected');
    assert(badIntervalRes.stderr.includes('Invalid --baseline-interval'), `Unexpected stderr: ${badIntervalRes.stderr}`);

    const badThreshRes = await runProcess(process.execPath, [
      cliPath, 'prepare', '--data-dir', dataDir, '--url', t16Vid, '--entry-id', 'cli-sampling-t16', '--scene-threshold', '1.5'
    ]);
    assert.notStrictEqual(badThreshRes.code, 0, 'Invalid --scene-threshold 1.5 must be rejected');
    assert(badThreshRes.stderr.includes('Invalid --scene-threshold'), `Unexpected stderr: ${badThreshRes.stderr}`);

    const prepCoarse = await runProcess(process.execPath, [
      cliPath, 'prepare', '--data-dir', dataDir, '--url', t16Vid, '--entry-id', 'cli-sampling-t16',
      '--baseline-interval', '10', '--scene-threshold', '0.95', '--json'
    ]);
    assert.strictEqual(prepCoarse.code, 0, `Coarse CLI prepare failed: ${prepCoarse.stderr}`);
    const coarseJson = JSON.parse(prepCoarse.stdout);
    assert.strictEqual(coarseJson.frameCount, 1, `Expected 1 frame at 10s interval on 5s video, got ${coarseJson.frameCount}`);

    const staleFrame = path.join(store.getEpisodePaths('cli-sampling-t16').framesDir, 'frame_pts_99999999.jpg');
    await fs.writeFile(staleFrame, 'stale');

    const prepFine = await runProcess(process.execPath, [
      cliPath, 'prepare', '--data-dir', dataDir, '--url', t16Vid, '--entry-id', 'cli-sampling-t16',
      '--force-rebuild', '--baseline-interval', '1', '--scene-threshold', '0.95', '--json'
    ]);
    assert.strictEqual(prepFine.code, 0, `Fine CLI --force-rebuild failed: ${prepFine.stderr}`);
    const fineJson = JSON.parse(prepFine.stdout);
    assert.strictEqual(fineJson.reusedExisting, false, 'Expected reusedExisting=false on --force-rebuild');
    assert(fineJson.frameCount >= 4, `Expected >= 4 frames at 1s interval on 5s video, got ${fineJson.frameCount}`);
    const staleExists = await fs.stat(staleFrame).then(() => true).catch(() => false);
    assert.strictEqual(staleExists, false, 'Stale frame_pts file MUST be removed on --force-rebuild');
    console.log(` -> Test 16 PASSED (coarse=${coarseJson.frameCount} frame -> rebuilt=${fineJson.frameCount} frames, stale cleaned)`);
    passed++;

    // Test 17: 分享文案 URL 提取、来源识别、输入规范化与 YouTube JS 运行时参数
    console.log('Test 17: Share text URL extraction, source detection, input normalization, and yt-dlp extra args');
    const biliShareText = '【Re:从零开始的AI学习】点击观看 https://www.bilibili.com/video/BV1pwnj6BEMP?p=1，超实用！';
    assert.strictEqual(
      extractUrlFromInput(biliShareText),
      'https://www.bilibili.com/video/BV1pwnj6BEMP?p=1'
    );
    assert.strictEqual(
      extractUrlFromInput('推荐：https://youtu.be/jNQXAC9IVRw。'),
      'https://youtu.be/jNQXAC9IVRw'
    );
    assert.strictEqual(extractUrlFromInput(sampleVid), undefined);

    assert.strictEqual(detectSourceType('https://www.bilibili.com/video/BV1pwnj6BEMP'), 'bilibili');
    assert.strictEqual(detectSourceType('https://b23.tv/abc123'), 'bilibili');
    assert.strictEqual(detectSourceType(biliShareText), 'bilibili');
    assert.strictEqual(detectSourceType('https://www.youtube.com/watch?v=jNQXAC9IVRw'), 'youtube');
    assert.strictEqual(detectSourceType('https://youtu.be/jNQXAC9IVRw'), 'youtube');
    assert.strictEqual(detectSourceType(fixturesDir), 'local');
    assert.strictEqual(detectSourceType(sampleVid), 'local');

    assert.strictEqual(
      normalizeInputUrl('推荐视频 https://www.youtube.com/watch?v=jNQXAC9IVRw。'),
      'https://www.youtube.com/watch?v=jNQXAC9IVRw'
    );
    assert.strictEqual(normalizeInputUrl(`  ${sampleVid}  `), sampleVid);

    assert.deepStrictEqual(getYtDlpExtraArgs('bilibili'), []);
    assert.deepStrictEqual(getYtDlpExtraArgs('local'), []);
    const ytExtraArgs = getYtDlpExtraArgs('youtube');
    assert(ytExtraArgs.includes('--remote-components') && ytExtraArgs.includes('ejs:github'));
    const rtIdx = ytExtraArgs.indexOf('--js-runtimes');
    assert(rtIdx !== -1 && ytExtraArgs[rtIdx + 1]?.startsWith('node:'));

    console.log(' -> Test 17 PASSED (URL extraction, detection, normalization, and yt-dlp extra args verified)');
    passed++;

    // Test 18: B 站/YouTube Cookie 优先级发现、UUID 域名自动匹配、鲜度检查、doctor 展示与零泄密校验
    console.log('Test 18: Cookie priority resolution, UUID domain matching, freshness, doctor report, and zero leakage');
    const t18DataDir = path.join(tempRoot, 't18-data');
    const t18CookiesDir = path.join(t18DataDir, 'cookies');
    await fs.mkdir(t18CookiesDir, { recursive: true });
    const SENTINEL = 'SECRET_COOKIE_VAL_DO_NOT_LEAK';
    const makeBiliCookieTxt = (suffix) => [
      '# Netscape HTTP Cookie File',
      `#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t1893456000\tSESSDATA\t${SENTINEL}_bili_${suffix}`,
      `.bilibili.com\tTRUE\t/\tFALSE\t1893456000\tbili_jct\t${SENTINEL}_jct_${suffix}`
    ].join('\n');
    const makeYtCookieTxt = (suffix) => [
      '# Netscape HTTP Cookie File',
      `.youtube.com\tTRUE\t/\tFALSE\t1893456000\tSID\t${SENTINEL}_yt1_${suffix}`,
      `.youtube.com\tTRUE\t/\tFALSE\t1893456000\tSAPISID\t${SENTINEL}_yt2_${suffix}`,
      `#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-1PSID\t${SENTINEL}_yt3_${suffix}`
    ].join('\n');

    assert.strictEqual(await resolveCookiesPath('bilibili', { dataDir: t18DataDir }), undefined);
    await assert.rejects(
      () => resolveCookiesPath('bilibili', {
        explicitCookies: path.join(tempRoot, 'missing_cookies.txt'),
        dataDir: t18DataDir
      }),
      /Explicit cookies file not found/
    );

    const genericCookies = path.join(t18CookiesDir, 'cookies.txt');
    await fs.writeFile(genericCookies, makeBiliCookieTxt('generic'));
    assert.strictEqual(await resolveCookiesPath('bilibili', { dataDir: t18DataDir }), genericCookies);

    const dynOld = path.join(t18CookiesDir, 'bilibili_export_old.txt');
    const dynNew = path.join(t18CookiesDir, 'bilibili_export_new.txt');
    await fs.writeFile(dynOld, makeBiliCookieTxt('old'));
    await fs.writeFile(dynNew, makeBiliCookieTxt('new'));
    const nowSec = Date.now() / 1000;
    await fs.utimes(dynOld, nowSec - 200 * 3600, nowSec - 200 * 3600);
    await fs.utimes(dynNew, nowSec - 3600, nowSec - 3600);
    assert.strictEqual(await resolveCookiesPath('bilibili', { dataDir: t18DataDir }), dynNew);

    const wwwCookies = path.join(t18CookiesDir, 'www.bilibili.com_cookies.txt');
    await fs.writeFile(wwwCookies, makeBiliCookieTxt('www'));
    assert.strictEqual(await resolveCookiesPath('bilibili', { dataDir: t18DataDir }), wwwCookies);

    const bilibiliTxt = path.join(t18CookiesDir, 'bilibili.txt');
    await fs.writeFile(bilibiliTxt, makeBiliCookieTxt('primary'));
    assert.strictEqual(await resolveCookiesPath('bilibili', { dataDir: t18DataDir }), bilibiliTxt);

    const explicitCookies = path.join(tempRoot, 'explicit_bilibili.txt');
    await fs.writeFile(explicitCookies, makeBiliCookieTxt('explicit'));
    assert.strictEqual(
      await resolveCookiesPath('bilibili', { explicitCookies, dataDir: t18DataDir }),
      explicitCookies
    );

    const freshInspect = await inspectCookiesFile(bilibiliTxt, 'bilibili');
    assert.strictEqual(freshInspect.exists, true);
    assert.strictEqual(freshInspect.possiblyExpired, false);
    assert.strictEqual(freshInspect.hasRequiredKeys, true);
    assert.strictEqual(freshInspect.cookieCount, 2);
    assert(freshInspect.foundKeys.includes('SESSDATA'));
    assert.strictEqual(freshInspect.missingKeys.length, 0);

    const staleInspect = await inspectCookiesFile(dynOld, 'bilibili');
    assert.strictEqual(staleInspect.possiblyExpired, true);
    assert(typeof staleInspect.ageHours === 'number' && staleInspect.ageHours > 168);

    const allInspect = await inspectAllCookies(t18DataDir);
    assert.strictEqual(allInspect.cookiesDir, t18CookiesDir);
    assert.strictEqual(allInspect.platforms.bilibili.exists, true);
    assert.strictEqual(allInspect.platforms.youtube.exists, false);

    const docTextRes = await runProcess(process.execPath, [cliPath, 'doctor', '--data-dir', t18DataDir]);
    assert.strictEqual(docTextRes.code, 0, `doctor text failed: ${docTextRes.stderr}`);
    assert(docTextRes.stdout.includes(t18CookiesDir), 'doctor output must show cookiesDir');
    assert(docTextRes.stdout.includes('bilibili'), 'doctor output must show bilibili status');
    assert(docTextRes.stdout.includes('youtube'), 'doctor output must show youtube status');

    const docJsonRes = await runProcess(process.execPath, [cliPath, 'doctor', '--data-dir', t18DataDir, '--json']);
    assert.strictEqual(docJsonRes.code, 0, `doctor --json failed: ${docJsonRes.stderr}`);
    const docJson = JSON.parse(docJsonRes.stdout);
    assert.strictEqual(docJson.cookiesDir, t18CookiesDir);
    assert.strictEqual(docJson.cookies.bilibili.exists, true);
    assert.strictEqual(docJson.cookies.youtube.exists, false);

    for (const payload of [
      JSON.stringify(freshInspect),
      JSON.stringify(allInspect),
      docTextRes.stdout + docTextRes.stderr,
      docJsonRes.stdout + docJsonRes.stderr
    ]) {
      assert(!payload.includes(SENTINEL), 'Cookie value MUST NEVER appear in inspect/doctor output!');
    }

    const t18UuidDataDir = path.join(tempRoot, 't18-uuid-data');
    const t18UuidCookiesDir = path.join(t18UuidDataDir, 'cookies');
    await fs.mkdir(t18UuidCookiesDir, { recursive: true });
    const uuidBiliOld = path.join(t18UuidCookiesDir, '11111111-1111-1111-1111-111111111111.txt');
    const uuidBiliNew = path.join(t18UuidCookiesDir, 'fd800243-ebaa-4ee4-bac4-7ccf953ad744.txt');
    const uuidYt = path.join(t18UuidCookiesDir, 'd2b15b8b-51ed-4205-b325-eda5cd109bff.txt');
    await fs.writeFile(uuidBiliOld, makeBiliCookieTxt('uuid-old'));
    await fs.writeFile(uuidBiliNew, makeBiliCookieTxt('uuid-new'));
    await fs.writeFile(uuidYt, makeYtCookieTxt('uuid-yt'));
    await fs.writeFile(`${uuidBiliNew}:Zone.Identifier`, '[ZoneTransfer]\nZoneId=3\n');
    await fs.writeFile(`${uuidYt}:Zone.Identifier`, '[ZoneTransfer]\nZoneId=3\n');
    await fs.utimes(uuidBiliOld, nowSec - 200 * 3600, nowSec - 200 * 3600);
    await fs.utimes(uuidBiliNew, nowSec - 1800, nowSec - 1800);

    assert.strictEqual(await resolveCookiesPath('bilibili', { dataDir: t18UuidDataDir }), uuidBiliNew);
    assert.strictEqual(await resolveCookiesPath('youtube', { dataDir: t18UuidDataDir }), uuidYt);

    const uuidAllInspect = await inspectAllCookies(t18UuidDataDir);
    assert.strictEqual(uuidAllInspect.platforms.bilibili.exists, true);
    assert.strictEqual(uuidAllInspect.platforms.bilibili.filePath, uuidBiliNew);
    assert.strictEqual(uuidAllInspect.platforms.bilibili.hasRequiredKeys, true);
    assert.strictEqual(uuidAllInspect.platforms.youtube.exists, true);
    assert.strictEqual(uuidAllInspect.platforms.youtube.filePath, uuidYt);
    assert.strictEqual(uuidAllInspect.platforms.youtube.hasRequiredKeys, true);
    assert(uuidAllInspect.platforms.youtube.foundKeys.includes('SID'));
    assert(uuidAllInspect.platforms.youtube.foundKeys.includes('SAPISID'));
    assert(uuidAllInspect.platforms.youtube.foundKeys.includes('__Secure-1PSID'));
    assert(!JSON.stringify(uuidAllInspect).includes(SENTINEL), 'UUID inspection must never leak cookie values!');
    console.log(' -> Test 18 PASSED (priority chain, UUID domain auto-match, freshness, doctor output, and zero cookie leakage verified)');
    passed++;

    // Test 19: 分离音视频目录与纯视频单文件自动配对、work/ 无损合流及歧义拦截
    console.log('Test 19: Split video/audio directory & single-file pairing, work/ remux, and ambiguity guard');
    const pairDir = path.join(tempRoot, 't19-pair');
    await fs.mkdir(pairDir, { recursive: true });
    const demo3Path = path.join(pairDir, 'demo_3.mp4');
    const demo4Path = path.join(pairDir, 'demo_4.mp4');
    const demo3Srt = path.join(pairDir, 'demo_3.srt');

    const genVOnly = await runProcess(ffmpegExe, [
      '-y', '-i', sampleVid, '-an', '-c:v', 'copy', '-metadata', 'comment=vid:testvid123', demo3Path
    ]);
    assert.strictEqual(genVOnly.code, 0, `video-only fixture failed: ${genVOnly.stderr}`);
    const genAOnly = await runProcess(ffmpegExe, [
      '-y', '-i', sampleVid, '-vn', '-c:a', 'copy', '-metadata', 'comment=vid:testvid123', demo4Path
    ]);
    assert.strictEqual(genAOnly.code, 0, `audio-only fixture failed: ${genAOnly.stderr}`);
    await fs.writeFile(demo3Srt, '1\n00:00:00,000 --> 00:00:02,000\n分离音视频配对字幕测试\n');

    const snapBefore = await Promise.all(
      (await fs.readdir(pairDir)).sort().map(async (f) => {
        const st = await fs.stat(path.join(pairDir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
    );

    const dirInspect = await inspectSource(pairDir, { pythonExe: validPython, ffprobeExe });
    assert.strictEqual(dirInspect.sourceType, 'local');
    assert.strictEqual(dirInspect.items.length, 1);
    assert.strictEqual(dirInspect.items[0].url, path.resolve(demo3Path));
    assert(dirInspect.summary.includes('demo_4.mp4'), `Summary should mention paired audio: ${dirInspect.summary}`);

    const dirEntryId = dirInspect.items[0].stableId;
    const prepDir = await pipeline.prepareEpisode(pairDir, dirEntryId, { forceRebuild: true });
    assert.strictEqual(prepDir.transcriptSource, 'platform-manual');
    const mergedDirVid = path.join(store.getEpisodePaths(dirEntryId).workDir, 'video_merged.mp4');
    assert.strictEqual(await fs.stat(mergedDirVid).then(() => true).catch(() => false), true);
    const mergedDirProbe = await probeMedia(ffprobeExe, mergedDirVid);
    assert(mergedDirProbe.audioTracks.length >= 1, 'Merged video in workDir must contain audio track');

    const saveDirRes = await store.saveNote({
      entryId: dirEntryId,
      title: 'T19 Pair Dir Test',
      status: 'completed',
      contentMarkdown: validDetailedNote
    });
    assert.strictEqual(saveDirRes.cleanedWorkDir, true);
    assert.strictEqual(
      await fs.stat(store.getEpisodePaths(dirEntryId).workDir).then(() => true).catch(() => false),
      false
    );

    const fileInspect = await inspectSource(demo3Path, { pythonExe: validPython, ffprobeExe });
    assert.strictEqual(fileInspect.items[0].stableId, dirEntryId);
    assert(fileInspect.summary.includes('demo_4.mp4'));
    const fileEntryId = 't19-single-file-pair';
    const prepFile = await pipeline.prepareEpisode(demo3Path, fileEntryId, { forceRebuild: true });
    assert.strictEqual(prepFile.transcriptSource, 'platform-manual');
    const mergedFileVid = path.join(store.getEpisodePaths(fileEntryId).workDir, 'video_merged.mp4');
    assert.strictEqual(await fs.stat(mergedFileVid).then(() => true).catch(() => false), true);
    const saveFileRes = await store.saveNote({
      entryId: fileEntryId,
      title: 'T19 Single File Pair Test',
      status: 'completed',
      contentMarkdown: validDetailedNote
    });
    assert.strictEqual(saveFileRes.cleanedWorkDir, true);

    const snapAfter = await Promise.all(
      (await fs.readdir(pairDir)).sort().map(async (f) => {
        const st = await fs.stat(path.join(pairDir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
    );
    assert.deepStrictEqual(snapAfter, snapBefore, 'Original source directory MUST remain completely unmodified');

    const ambigDir = path.join(tempRoot, 't19-ambig');
    await fs.mkdir(ambigDir, { recursive: true });
    await fs.copyFile(sampleVid, path.join(ambigDir, 'alpha.mp4'));
    await fs.copyFile(sampleVid, path.join(ambigDir, 'beta.mp4'));
    await assert.rejects(
      () => resolveLocalTarget(ambigDir, ffprobeExe),
      /alpha\.mp4[\s\S]*beta\.mp4|beta\.mp4[\s\S]*alpha\.mp4/
    );
    await assert.rejects(
      () => inspectSource(ambigDir, { pythonExe: validPython, ffprobeExe }),
      /alpha\.mp4[\s\S]*beta\.mp4|beta\.mp4[\s\S]*alpha\.mp4/
    );
    console.log(' -> Test 19 PASSED (dir & single-file pairing, work/ remux cleanup, and ambiguity guard verified)');
    passed++;

    console.log(`\nALL ${passed} STRICT REGRESSION TESTS PASSED!`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

runTests().catch(err => {
  console.error('TEST SUITE FAILED:', err);
  process.exit(1);
});
