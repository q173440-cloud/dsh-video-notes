import { promises as fs } from 'fs';
import path from 'path';
import { runProcess } from './process.js';
import { VideoFrameEvidence } from './types.js';

export interface MediaProbeInfo {
  duration: number;
  width: number;
  height: number;
  fps: number;
  audioTracks: Array<{ index: number; codec: string; channels: number; sampleRate: number }>;
}

export async function probeMedia(
  ffprobeExe: string,
  videoPath: string,
  options: { signal?: AbortSignal; subprocessService?: any } = {}
): Promise<MediaProbeInfo> {
  const args = [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    videoPath
  ];

  const res = await runProcess(ffprobeExe, args, {
    signal: options.signal,
    timeoutMs: 30000,
    subprocessService: options.subprocessService
  });

  if (res.code !== 0) {
    throw new Error(`ffprobe failed (code ${res.code}): ${res.stderr}`);
  }

  const data = JSON.parse(res.stdout);
  const format = data.format || {};
  const streams = data.streams || [];

  const videoStream = streams.find((s: any) => s.codec_type === 'video') || {};
  const audioStreams = streams.filter((s: any) => s.codec_type === 'audio');

  const duration = Number(format.duration || videoStream.duration || 0);
  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);

  let fps = 30;
  if (videoStream.r_frame_rate) {
    const parts = String(videoStream.r_frame_rate).split('/');
    if (parts.length === 2 && Number(parts[1]) > 0) {
      fps = Number(parts[0]) / Number(parts[1]);
    } else if (!isNaN(Number(videoStream.r_frame_rate))) {
      fps = Number(videoStream.r_frame_rate);
    }
  }

  const audioTracks = audioStreams.map((s: any, idx: number) => ({
    index: s.index ?? idx,
    codec: s.codec_name || 'unknown',
    channels: Number(s.channels || 1),
    sampleRate: Number(s.sample_rate || 16000)
  }));

  return {
    duration,
    width,
    height,
    fps: fps > 0 ? fps : 30,
    audioTracks
  };
}

export async function extractAudioWav(
  ffmpegExe: string,
  videoPath: string,
  outputPath: string,
  options: { trackIndex?: number; signal?: AbortSignal; subprocessService?: any } = {}
): Promise<string> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const trackIdx = options.trackIndex ?? 0;
  const args = [
    '-y',
    '-i', videoPath,
    '-map', `0:a:${trackIdx}?`,
    '-vn',
    '-acodec', 'pcm_s16le',
    '-ar', '16000',
    '-ac', '1',
    outputPath
  ];

  const res = await runProcess(ffmpegExe, args, {
    signal: options.signal,
    timeoutMs: 300000,
    subprocessService: options.subprocessService
  });

  if (res.code !== 0) {
    throw new Error(`FFmpeg audio extraction failed (code ${res.code}): ${res.stderr}`);
  }

  return outputPath;
}

export async function extractKeyframes(
  ffmpegExe: string,
  ffprobeExe: string,
  videoPath: string,
  outputDir: string,
  options: {
    baselineIntervalSec?: number;
    sceneChangeThreshold?: number;
    signal?: AbortSignal;
    subprocessService?: any;
  } = {}
): Promise<VideoFrameEvidence[]> {
  await fs.mkdir(outputDir, { recursive: true });

  const baselineSec = options.baselineIntervalSec || 10;
  const threshold = options.sceneChangeThreshold || 0.3;

  // 1. 探测真实帧率与时间基准（透传 subprocessService）
  const probe = await probeMedia(ffprobeExe, videoPath, {
    signal: options.signal,
    subprocessService: options.subprocessService
  });
  const fps = probe.fps;

  // 2. 使用 -frame_pts 1 确保输出图片文件名直接包含该帧在媒体中的真实 PTS
  const selectExpr = `isnan(prev_selected_t)+gte(t-prev_selected_t\\,${baselineSec})+gt(scene\\,${threshold})`;
  const framePattern = path.join(outputDir, 'frame_pts_%08d.jpg');

  const args = [
    '-y',
    '-i', videoPath,
    '-vf', `select='${selectExpr}'`,
    '-fps_mode', 'vfr',
    '-frame_pts', '1',
    '-q:v', '3',
    framePattern
  ];

  const res = await runProcess(ffmpegExe, args, {
    signal: options.signal,
    timeoutMs: 600000,
    subprocessService: options.subprocessService
  });

  if (res.code !== 0) {
    throw new Error(`FFmpeg keyframe extraction failed (code ${res.code}): ${res.stderr}`);
  }

  // 3. 读取生成的文件并从真实 PTS 计算精确的媒体时间戳
  const files = await fs.readdir(outputDir);
  const jpgFiles = files.filter(f => f.startsWith('frame_pts_') && f.endsWith('.jpg')).sort();

  const evidences: VideoFrameEvidence[] = [];
  for (let i = 0; i < jpgFiles.length; i++) {
    const fName = jpgFiles[i];
    const fullPath = path.join(outputDir, fName);

    const m = fName.match(/frame_pts_(\d+)\.jpg/);
    if (!m) continue;
    const pts = parseInt(m[1], 10);
    const realSec = Math.round((pts / fps) * 10) / 10;

    const min = Math.floor(realSec / 60);
    const sec = Math.floor(realSec % 60);
    const relTime = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

    evidences.push({
      id: `frame-${i + 1}`,
      timestamp: realSec,
      path: fullPath,
      relativeTime: relTime
    });
  }

  const metadataPath = path.join(outputDir, 'metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify(evidences, null, 2), 'utf-8');

  return evidences;
}
