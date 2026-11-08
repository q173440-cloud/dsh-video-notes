import { promises as fs } from 'fs';
import path from 'path';
import { runProcess } from './process.js';
import { probeMedia, extractAudioWav, extractKeyframes } from './media.js';
import { saveTranscripts, sliceSegments, normalizeSegments } from './transcript.js';
import { VideoNotesStore, EpisodePaths } from './store.js';
import {
  PrepareResult,
  SliceResult,
  TranscriptSegment,
  VideoFrameEvidence,
  ItemStatus
} from './types.js';

export interface PipelineOptions {
  pythonExe: string;
  ffmpegExe: string;
  ffprobeExe: string;
  transcribeScript: string;
  store: VideoNotesStore;
  subprocessService?: any;
  whisperModel?: string;
  computeType?: string;
  baselineIntervalSec?: number;
  sceneChangeThreshold?: number;
}

export interface PrepareOptions {
  signal?: AbortSignal;
  forceRebuild?: boolean;
}

export class VideoPipeline {
  constructor(readonly options: PipelineOptions) {}

  async prepareEpisode(
    inputUrlOrPath: string,
    entryId: string,
    signalOrOptions?: AbortSignal | PrepareOptions
  ): Promise<PrepareResult> {
    const opts: PrepareOptions = (signalOrOptions && 'aborted' in signalOrOptions)
      ? { signal: signalOrOptions as AbortSignal, forceRebuild: false }
      : ((signalOrOptions as PrepareOptions) || {});

    const signal = opts.signal;
    const forceRebuild = opts.forceRebuild ?? false;

    const paths = this.options.store.getEpisodePaths(entryId);
    await fs.mkdir(paths.episodeDir, { recursive: true });

    // 核心优化：已有产物完整性核验与就地复用机制（问题4）
    const hasExistingArtifacts = await this.options.store.hasPreparedArtifacts(entryId);
    if (hasExistingArtifacts && !forceRebuild) {
      let sourceData: any = {};
      try {
        sourceData = await this.options.store.getEpisodeSource(entryId);
      } catch {
        // fallback
      }
      const rawTranscript = JSON.parse(await fs.readFile(paths.transcriptJson, 'utf-8'));
      const segments = normalizeSegments(rawTranscript);
      const rawMeta = JSON.parse(await fs.readFile(path.join(paths.framesDir, 'metadata.json'), 'utf-8'));

      return {
        entryId,
        stableId: entryId,
        title: sourceData.title || entryId,
        duration: sourceData.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0),
        status: (sourceData.status as ItemStatus) || 'queued',
        hasPlatformSubtitle: Boolean(sourceData.hasPlatformSubtitle),
        transcriptSource: sourceData.transcriptSource || 'local-asr',
        transcriptPath: paths.transcriptJson,
        srtPath: paths.transcriptSrt,
        frameCount: rawMeta.length,
        framesDir: paths.framesDir,
        episodeDir: paths.episodeDir,
        reusedExisting: true,
        message: `复用已有产物：单集《${sourceData.title || entryId}》已有字幕 ${segments.length} 句（来源: ${sourceData.transcriptSource || 'local-asr'}），关键帧 ${rawMeta.length} 张，跳过媒体下载与转写。`
      };
    }

    await fs.mkdir(paths.workDir, { recursive: true });

    let title = entryId;
    let duration = 0;
    let hasPlatformSubtitle = false;
    let transcriptSource: 'platform-manual' | 'platform-auto' | 'local-asr' = 'local-asr';
    const isLocal = !inputUrlOrPath.startsWith('http://') && !inputUrlOrPath.startsWith('https://');

    let videoFile = '';

    if (isLocal) {
      videoFile = path.resolve(inputUrlOrPath);
      let probe = await probeMedia(this.options.ffprobeExe, videoFile, {
        signal,
        subprocessService: this.options.subprocessService
      });
      duration = probe.duration;
      title = path.basename(videoFile);

      // 若本地视频缺失音频轨，并且 workDir 提供了辅助音频或同名音频，执行自动合流修复
      if (!probe.audioTracks || probe.audioTracks.length === 0) {
        console.warn(`[Pipeline] 本地视频 ${title} 缺少音频轨，检查是否存在可复用的辅助音频...`);
        const candidateAudio = path.join(paths.workDir, 'supplement_audio.wav');
        if (await fs.stat(candidateAudio).then(() => true).catch(() => false)) {
          const mergedVideo = path.join(paths.workDir, 'video_merged.mp4');
          await runProcess(this.options.ffmpegExe, [
            '-y', '-i', videoFile, '-i', candidateAudio, '-c:v', 'copy', '-c:a', 'aac', mergedVideo
          ], { signal, subprocessService: this.options.subprocessService });
          videoFile = mergedVideo;
          probe = await probeMedia(this.options.ffprobeExe, videoFile, {
            signal,
            subprocessService: this.options.subprocessService
          });
          duration = probe.duration || duration;
          console.log(`[Pipeline] 本地视频音频轨合流补救成功！现包含 ${probe.audioTracks.length} 个音频轨。`);
        }
      }
    } else {
      // 1. 获取元数据
      const metaRes = await runProcess(this.options.pythonExe, [
        '-m', 'yt_dlp',
        '--dump-json',
        '--no-playlist',
        '--no-warnings',
        inputUrlOrPath
      ], {
        signal,
        timeoutMs: 60000,
        subprocessService: this.options.subprocessService
      });

      if (metaRes.code === 0 && metaRes.stdout.trim()) {
        try {
          const parsed = JSON.parse(metaRes.stdout.trim().split('\n')[0]);
          title = parsed.title || title;
          duration = parsed.duration || 0;
          const subs = parsed.subtitles || {};
          const autoSubs = parsed.automatic_captions || {};
          if (subs['zh-Hans'] || subs['zh-CN'] || subs['zh'] || subs['en']) {
            hasPlatformSubtitle = true;
            transcriptSource = 'platform-manual';
          } else if (autoSubs['zh-Hans'] || autoSubs['zh-CN'] || autoSubs['zh'] || autoSubs['en']) {
            hasPlatformSubtitle = true;
            transcriptSource = 'platform-auto';
          }
        } catch {
          // fallback
        }
      }

      // 2. 下载单集视频副本到 workDir


      const workVideoPattern = path.join(paths.workDir, 'video.%(ext)s');
      const dlRes = await runProcess(this.options.pythonExe, [
        '-m', 'yt_dlp',
        '--no-playlist',
        '--ffmpeg-location', path.dirname(this.options.ffmpegExe),
        '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best',
        '--merge-output-format', 'mp4',
        '-o', workVideoPattern,
        inputUrlOrPath
      ], {
        signal,
        timeoutMs: 600000,
        subprocessService: this.options.subprocessService
      });

      if (dlRes.code !== 0) {
        throw new Error(`Failed to download video with yt-dlp (code ${dlRes.code}): ${dlRes.stderr}`);
      }

      const workFiles = await fs.readdir(paths.workDir);
      const vf = workFiles.find(f => f.startsWith('video.') && !f.endsWith('.part') && !f.endsWith('.log'));
      if (!vf) {
        throw new Error('Downloaded video file not found in work directory');
      }
      videoFile = path.join(paths.workDir, vf);

      const probe = await probeMedia(this.options.ffprobeExe, videoFile, {
        signal,
        subprocessService: this.options.subprocessService
      });
      duration = probe.duration || duration;

      // 健壮性自愈防线：严格校验下载的媒体文件是否包含有效音频轨
      if (!probe.audioTracks || probe.audioTracks.length === 0) {
        console.warn(`[Pipeline] 下载的媒体 ${vf} 缺少音频轨，正在执行独立音频补抓与自动流合并...`);
        const audioFile = path.join(paths.workDir, 'temp_audio.m4a');
        const dlAudioRes = await runProcess(this.options.pythonExe, [
          '-m', 'yt_dlp',
          '--no-playlist',
          '-f', '30232/30280/30216/bestaudio',
          '-o', audioFile,
          inputUrlOrPath
        ], { signal, subprocessService: this.options.subprocessService });

        if (dlAudioRes.code === 0 && await fs.stat(audioFile).then(() => true).catch(() => false)) {
          const mergedVideo = path.join(paths.workDir, 'video_merged.mp4');
          const mergeRes = await runProcess(this.options.ffmpegExe, [
            '-y',
            '-i', videoFile,
            '-i', audioFile,
            '-c:v', 'copy',
            '-c:a', 'aac',
            mergedVideo
          ], { signal, subprocessService: this.options.subprocessService });

          if (mergeRes.code === 0 && await fs.stat(mergedVideo).then(() => true).catch(() => false)) {
            videoFile = mergedVideo;
            const reProbe = await probeMedia(this.options.ffprobeExe, videoFile, {
              signal,
              subprocessService: this.options.subprocessService
            });
            duration = reProbe.duration || duration;
            console.log(`[Pipeline] 音频流合并自愈成功！媒体现包含 ${reProbe.audioTracks.length} 个音频轨。`);
          }
        }
      }
    }

    // 3. 准备字幕 / ASR 转写
    let segments: TranscriptSegment[] = [];
    const transcriptExists = await fs.stat(paths.transcriptJson).then(() => true).catch(() => false);

    if (transcriptExists) {
      const content = await fs.readFile(paths.transcriptJson, 'utf-8');
      const parsed = JSON.parse(content);
      segments = normalizeSegments(parsed);
    } else {
      const audioWav = path.join(paths.workDir, 'audio_16k.wav');
      await extractAudioWav(this.options.ffmpegExe, videoFile, audioWav, {
        trackIndex: 0,
        signal,
        subprocessService: this.options.subprocessService
      });

      const asrRes = await runProcess(this.options.pythonExe, [
        this.options.transcribeScript,
        '--audio', audioWav,
        '--model', this.options.whisperModel || 'small',
        '--device', 'cpu',
        '--compute-type', this.options.computeType || 'int8',
        '--language', 'zh',
        '--output', paths.transcriptJson
      ], {
        signal,
        timeoutMs: 900000,
        subprocessService: this.options.subprocessService
      });

      if (asrRes.code !== 0) {
        throw new Error(`ASR transcription failed (code ${asrRes.code}): ${asrRes.stderr}`);
      }

      const asrData = JSON.parse(asrRes.stdout);
      segments = await saveTranscripts(asrData, paths.transcriptJson, paths.transcriptSrt);
    }

    // 4. 关键帧抽取与场景采样（元数据驱动）
    let frameList: VideoFrameEvidence[] = [];
    const metaFile = path.join(paths.framesDir, 'metadata.json');
    const metaExists = await fs.stat(metaFile).then(() => true).catch(() => false);

    if (metaExists) {
      try {
        const rawMeta = JSON.parse(await fs.readFile(metaFile, 'utf-8'));
        if (Array.isArray(rawMeta) && rawMeta.length > 0) {
          frameList = rawMeta;
        }
      } catch {
        // fallback
      }
    }

    if (frameList.length === 0) {
      frameList = await extractKeyframes(
        this.options.ffmpegExe,
        this.options.ffprobeExe,
        videoFile,
        paths.framesDir,
        {
          baselineIntervalSec: this.options.baselineIntervalSec || 10,
          sceneChangeThreshold: this.options.sceneChangeThreshold || 0.3,
          signal,
          subprocessService: this.options.subprocessService
        }
      );
    }

    // 保存条目 source.json
    await this.options.store.saveEpisodeSource(entryId, {
      entryId,
      title,
      duration,
      inputUrlOrPath,
      hasPlatformSubtitle,
      transcriptSource,
      frameCount: frameList.length,
      createdAt: new Date().toISOString()
    });

    return {
      entryId,
      stableId: entryId,
      title,
      duration,
      status: 'queued',
      hasPlatformSubtitle,
      transcriptSource,
      transcriptPath: paths.transcriptJson,
      srtPath: paths.transcriptSrt,
      frameCount: frameList.length,
      framesDir: paths.framesDir,
      episodeDir: paths.episodeDir,
      reusedExisting: false,
      message: `单集《${title}》准备完成：时长 ${Math.round(duration)} 秒，字幕 ${segments.length} 句（来源: ${transcriptSource}），抽帧 ${frameList.length} 张。`
    };
  }

  async readSlice(
    entryId: string,
    startTimeSec: number,
    durationSec: number
  ): Promise<SliceResult> {
    const paths = this.options.store.getEpisodePaths(entryId);
    let totalDuration = 0;
    let title = entryId;

    const sourceExists = await fs.stat(paths.sourceJson).then(() => true).catch(() => false);
    if (sourceExists) {
      try {
        const sourceData = JSON.parse(await fs.readFile(paths.sourceJson, 'utf-8'));
        totalDuration = sourceData.duration || 0;
        title = sourceData.title || entryId;
      } catch {
        // fallback
      }
    }

    const rawContent = JSON.parse(await fs.readFile(paths.transcriptJson, 'utf-8'));
    const allSegments = normalizeSegments(rawContent);

    if (totalDuration === 0 && allSegments.length > 0) {
      totalDuration = allSegments[allSegments.length - 1].end;
    }

    const endTimeSec = Math.min(totalDuration || (startTimeSec + durationSec), startTimeSec + durationSec);
    const slicedSegments = sliceSegments(allSegments, startTimeSec, endTimeSec);

    const metaFile = path.join(paths.framesDir, 'metadata.json');
    let allFrames: VideoFrameEvidence[] = [];
    const metaExists = await fs.stat(metaFile).then(() => true).catch(() => false);
    if (metaExists) {
      try {
        const rawM = JSON.parse(await fs.readFile(metaFile, 'utf-8'));
        if (Array.isArray(rawM)) {
          allFrames = rawM;
        }
      } catch {
        // fallback
      }
    }

    const slicedFrames = allFrames.filter(f => f.timestamp >= startTimeSec && f.timestamp < endTimeSec);
    const hasMore = endTimeSec < totalDuration;

    return {
      entryId,
      title,
      timeRange: [startTimeSec, endTimeSec],
      totalDuration,
      segments: slicedSegments,
      frames: slicedFrames,
      hasMore,
      nextRange: hasMore ? [endTimeSec, Math.min(totalDuration, endTimeSec + durationSec)] : undefined
    };
  }
}
