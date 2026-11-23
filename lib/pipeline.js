import { promises as fs } from 'fs';
import path from 'path';
import { runProcess } from './process.js';
import { probeMedia, extractAudioWav, extractKeyframes } from './media.js';
import { saveTranscripts, sliceSegments, normalizeSegments, parseSubtitleContent } from './transcript.js';
import { resolveCookiesPath } from './cookies.js';
import { resolveLocalTarget, remuxVideoAndAudio } from './local-media.js';
import { detectSourceType, normalizeInputUrl, getYtDlpExtraArgs } from './source.js';
const SUBTITLE_LANG_PRIORITY = ['zh-hans', 'zh-cn', 'zh-sg', 'zh', 'zh-hant', 'zh-tw', 'en', 'en-us', 'en-orig'];
function pickBestSubtitleFile(files) {
    const candidates = files.filter(f => {
        const lower = f.toLowerCase();
        return (lower.endsWith('.srt') || lower.endsWith('.vtt')) && !lower.includes('danmaku');
    });
    if (candidates.length === 0)
        return undefined;
    const score = (name) => {
        const lower = name.toLowerCase();
        for (let i = 0; i < SUBTITLE_LANG_PRIORITY.length; i++) {
            if (lower.includes(`.${SUBTITLE_LANG_PRIORITY[i]}.`)) {
                return i * 2 + (lower.endsWith('.srt') ? 0 : 1);
            }
        }
        return 100 + (lower.endsWith('.srt') ? 0 : 1);
    };
    return candidates.sort((a, b) => score(a) - score(b))[0];
}
export class VideoPipeline {
    options;
    constructor(options) {
        this.options = options;
    }
    async prepareEpisode(inputUrlOrPath, entryId, signalOrOptions) {
        const opts = (signalOrOptions && 'aborted' in signalOrOptions)
            ? { signal: signalOrOptions, forceRebuild: false }
            : (signalOrOptions || {});
        const signal = opts.signal;
        const forceRebuild = opts.forceRebuild ?? false;
        const language = opts.language ?? this.options.language ?? 'auto';
        const cookies = opts.cookies ?? this.options.cookies;
        const { pythonExe, ffmpegExe, ffprobeExe, store, subprocessService } = this.options;
        const procOpts = { signal, subprocessService };
        const paths = store.getEpisodePaths(entryId);
        await fs.mkdir(paths.episodeDir, { recursive: true });
        // 核心优化：已有产物完整性核验与就地复用机制（问题4）
        const hasExistingArtifacts = await store.hasPreparedArtifacts(entryId);
        if (hasExistingArtifacts && !forceRebuild) {
            let sourceData = {};
            try {
                sourceData = await store.getEpisodeSource(entryId);
            }
            catch {
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
                status: sourceData.status || 'queued',
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
        const sourceType = detectSourceType(inputUrlOrPath);
        const isLocal = sourceType === 'local';
        const targetInput = isLocal ? inputUrlOrPath : normalizeInputUrl(inputUrlOrPath);
        const resolvedCookies = isLocal
            ? undefined
            : await resolveCookiesPath(sourceType, { explicitCookies: cookies, dataDir: store.baseDataDir });
        const ytDlpExtra = isLocal ? [] : getYtDlpExtraArgs(sourceType);
        let title = entryId;
        let duration = 0;
        let hasPlatformSubtitle = false;
        let transcriptSource = 'local-asr';
        const manualSubLangs = new Set();
        let videoFile = '';
        let sourceVideoFile = '';
        if (isLocal) {
            const localTarget = await resolveLocalTarget(inputUrlOrPath, ffprobeExe, procOpts);
            sourceVideoFile = localTarget.videoPath;
            videoFile = localTarget.videoPath;
            title = localTarget.displayTitle;
            if (localTarget.companionAudioPath) {
                const mergedVideo = path.join(paths.workDir, 'video_merged.mp4');
                videoFile = await remuxVideoAndAudio(ffmpegExe, videoFile, localTarget.companionAudioPath, mergedVideo, procOpts);
            }
            let probe = await probeMedia(ffprobeExe, videoFile, procOpts);
            duration = probe.duration;
            // 若本地视频缺失音频轨，并且 workDir 提供了辅助音频或同名音频，执行自动合流修复
            if (!probe.audioTracks || probe.audioTracks.length === 0) {
                console.warn(`[Pipeline] 本地视频 ${title} 缺少音频轨，检查是否存在可复用的辅助音频...`);
                const candidateAudio = path.join(paths.workDir, 'supplement_audio.wav');
                if (await fs.stat(candidateAudio).then(() => true).catch(() => false)) {
                    const mergedVideo = path.join(paths.workDir, 'video_merged.mp4');
                    await runProcess(ffmpegExe, [
                        '-y', '-i', videoFile, '-i', candidateAudio, '-c:v', 'copy', '-c:a', 'aac', mergedVideo
                    ], procOpts);
                    videoFile = mergedVideo;
                    probe = await probeMedia(ffprobeExe, videoFile, procOpts);
                    duration = probe.duration || duration;
                    console.log(`[Pipeline] 本地视频音频轨合流补救成功！现包含 ${probe.audioTracks.length} 个音频轨。`);
                }
            }
        }
        else {
            // 1. 获取元数据
            const metaArgs = ['-m', 'yt_dlp', '--dump-json', '--no-playlist', '--no-warnings', ...ytDlpExtra];
            if (resolvedCookies) {
                metaArgs.push('--cookies', resolvedCookies);
            }
            metaArgs.push(targetInput);
            const metaRes = await runProcess(pythonExe, metaArgs, { ...procOpts, timeoutMs: 60000 });
            if (metaRes.code === 0 && metaRes.stdout.trim()) {
                try {
                    const parsed = JSON.parse(metaRes.stdout.trim().split('\n')[0]);
                    title = parsed.title || title;
                    duration = parsed.duration || 0;
                    const subs = parsed.subtitles || {};
                    const autoSubs = parsed.automatic_captions || {};
                    for (const lang of Object.keys(subs)) {
                        if (lang.toLowerCase() !== 'danmaku') {
                            manualSubLangs.add(lang.toLowerCase());
                        }
                    }
                    if (subs['zh-Hans'] || subs['zh-CN'] || subs['zh'] || subs['en']) {
                        hasPlatformSubtitle = true;
                        transcriptSource = 'platform-manual';
                    }
                    else if (autoSubs['zh-Hans'] || autoSubs['zh-CN'] || autoSubs['zh'] || autoSubs['en']) {
                        hasPlatformSubtitle = true;
                        transcriptSource = 'platform-auto';
                    }
                }
                catch {
                    // fallback
                }
            }
            // 2. 下载单集视频副本到 workDir
            const workVideoPattern = path.join(paths.workDir, 'video.%(ext)s');
            const dlArgs = ['-m', 'yt_dlp', '--no-playlist', ...ytDlpExtra];
            if (ffmpegExe.includes('/') || ffmpegExe.includes('\\')) {
                dlArgs.push('--ffmpeg-location', path.dirname(ffmpegExe));
            }
            if (resolvedCookies) {
                dlArgs.push('--cookies', resolvedCookies);
            }
            dlArgs.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best', '--merge-output-format', 'mp4', '-o', workVideoPattern, targetInput);
            const dlRes = await runProcess(pythonExe, dlArgs, { ...procOpts, timeoutMs: 600000 });
            if (dlRes.code !== 0) {
                throw new Error(`Failed to download video with yt-dlp (code ${dlRes.code}): ${dlRes.stderr}`);
            }
            const workFiles = await fs.readdir(paths.workDir);
            const vf = workFiles.find(f => f.startsWith('video.') && !f.endsWith('.part') && !f.endsWith('.log'));
            if (!vf) {
                throw new Error('Downloaded video file not found in work directory');
            }
            videoFile = path.join(paths.workDir, vf);
            const probe = await probeMedia(ffprobeExe, videoFile, procOpts);
            duration = probe.duration || duration;
            // 健壮性自愈防线：严格校验下载的媒体文件是否包含有效音频轨
            if (!probe.audioTracks || probe.audioTracks.length === 0) {
                console.warn(`[Pipeline] 下载的媒体 ${vf} 缺少音频轨，正在执行独立音频补抓与自动流合并...`);
                const audioFile = path.join(paths.workDir, 'temp_audio.m4a');
                const dlAudioArgs = ['-m', 'yt_dlp', '--no-playlist', ...ytDlpExtra];
                if (resolvedCookies) {
                    dlAudioArgs.push('--cookies', resolvedCookies);
                }
                dlAudioArgs.push('-f', '30232/30280/30216/bestaudio', '-o', audioFile, targetInput);
                const dlAudioRes = await runProcess(pythonExe, dlAudioArgs, procOpts);
                if (dlAudioRes.code === 0 && await fs.stat(audioFile).then(() => true).catch(() => false)) {
                    const mergedVideo = path.join(paths.workDir, 'video_merged.mp4');
                    const mergeRes = await runProcess(ffmpegExe, [
                        '-y', '-i', videoFile, '-i', audioFile, '-c:v', 'copy', '-c:a', 'aac', mergedVideo
                    ], procOpts);
                    if (mergeRes.code === 0 && await fs.stat(mergedVideo).then(() => true).catch(() => false)) {
                        videoFile = mergedVideo;
                        const reProbe = await probeMedia(ffprobeExe, videoFile, procOpts);
                        duration = reProbe.duration || duration;
                        console.log(`[Pipeline] 音频流合并自愈成功！媒体现包含 ${reProbe.audioTracks.length} 个音频轨。`);
                    }
                }
            }
        }
        // 3. 准备字幕（优先复用平台字幕或本地同名外挂字幕，否则回退至本地 faster-whisper ASR）
        let segments = [];
        const transcriptExists = await fs.stat(paths.transcriptJson).then(() => true).catch(() => false);
        if (transcriptExists && !forceRebuild) {
            const content = await fs.readFile(paths.transcriptJson, 'utf-8');
            const parsed = JSON.parse(content);
            segments = normalizeSegments(parsed);
        }
        else {
            if (!isLocal) {
                const subsDir = path.join(paths.workDir, 'subs');
                await fs.mkdir(subsDir, { recursive: true });
                const subArgs = [
                    '-m', 'yt_dlp', '--skip-download', '--no-playlist', '--no-warnings', ...ytDlpExtra,
                    '--write-subs', '--write-auto-subs',
                    '--sub-langs', 'zh-Hans,zh-CN,zh,zh-TW,en,en-US,en-orig',
                    '--convert-subs', 'srt',
                    '-o', path.join(subsDir, 'sub.%(ext)s')
                ];
                if (ffmpegExe.includes('/') || ffmpegExe.includes('\\')) {
                    subArgs.push('--ffmpeg-location', path.dirname(ffmpegExe));
                }
                if (resolvedCookies) {
                    subArgs.push('--cookies', resolvedCookies);
                }
                subArgs.push(targetInput);
                try {
                    await runProcess(pythonExe, subArgs, { ...procOpts, timeoutMs: 60000 });
                    const subFiles = await fs.readdir(subsDir).catch(() => []);
                    const picked = pickBestSubtitleFile(subFiles);
                    if (picked) {
                        const pickedLower = picked.toLowerCase();
                        const isManual = Array.from(manualSubLangs).some(lang => pickedLower.includes(`.${lang}.`));
                        const resolvedSubSource = isManual
                            ? 'platform-manual'
                            : (transcriptSource === 'platform-manual' ? 'platform-manual' : 'platform-auto');
                        const rawSub = await fs.readFile(path.join(subsDir, picked), 'utf-8');
                        const parsedSubs = parseSubtitleContent(rawSub, resolvedSubSource);
                        if (parsedSubs.length > 0) {
                            segments = await saveTranscripts(parsedSubs, paths.transcriptJson, paths.transcriptSrt);
                            hasPlatformSubtitle = true;
                            transcriptSource = resolvedSubSource;
                        }
                    }
                }
                catch (err) {
                    console.warn('[Pipeline] 平台字幕下载或解析失败，将回退至本地 ASR 转写:', err);
                }
            }
            else {
                // 本地视频同目录外挂字幕检测（如 video.srt / video.vtt）
                const subBase = sourceVideoFile || videoFile;
                const videoDir = path.dirname(subBase);
                const videoStem = path.basename(subBase, path.extname(subBase));
                for (const ext of ['.srt', '.vtt', '.zh.srt', '.zh-CN.srt']) {
                    const candidateSub = path.join(videoDir, `${videoStem}${ext}`);
                    if (await fs.stat(candidateSub).then(s => s.isFile()).catch(() => false)) {
                        const rawSub = await fs.readFile(candidateSub, 'utf-8');
                        const parsedSubs = parseSubtitleContent(rawSub, 'platform-manual');
                        if (parsedSubs.length > 0) {
                            segments = await saveTranscripts(parsedSubs, paths.transcriptJson, paths.transcriptSrt);
                            hasPlatformSubtitle = true;
                            transcriptSource = 'platform-manual';
                            break;
                        }
                    }
                }
            }
            if (segments.length === 0) {
                transcriptSource = 'local-asr';
                const audioWav = path.join(paths.workDir, 'audio_16k.wav');
                await extractAudioWav(ffmpegExe, videoFile, audioWav, { ...procOpts, trackIndex: 0 });
                const asrArgs = [
                    this.options.transcribeScript,
                    '--audio', audioWav,
                    '--model', this.options.whisperModel || 'small',
                    '--device', 'cpu',
                    '--compute-type', this.options.computeType || 'int8',
                    '--language', language,
                    '--output', paths.transcriptJson
                ];
                if (this.options.modelDir) {
                    asrArgs.push('--model-dir', this.options.modelDir);
                }
                const asrRes = await runProcess(pythonExe, asrArgs, { ...procOpts, timeoutMs: 900000 });
                if (asrRes.code !== 0) {
                    throw new Error(`ASR transcription failed (code ${asrRes.code}): ${asrRes.stderr}`);
                }
                const rawJsonText = asrRes.stdout.trim()
                    ? asrRes.stdout
                    : await fs.readFile(paths.transcriptJson, 'utf-8');
                const asrData = JSON.parse(rawJsonText);
                segments = await saveTranscripts(asrData, paths.transcriptJson, paths.transcriptSrt);
            }
        }
        // 4. 关键帧抽取与场景采样（元数据驱动）
        let frameList = [];
        const metaFile = path.join(paths.framesDir, 'metadata.json');
        const metaExists = await fs.stat(metaFile).then(() => true).catch(() => false);
        if (metaExists && !forceRebuild) {
            try {
                const rawMeta = JSON.parse(await fs.readFile(metaFile, 'utf-8'));
                if (Array.isArray(rawMeta) && rawMeta.length > 0) {
                    frameList = rawMeta;
                }
            }
            catch {
                // fallback
            }
        }
        if (frameList.length === 0) {
            if (forceRebuild) {
                const oldFiles = await fs.readdir(paths.framesDir).catch(() => []);
                for (const f of oldFiles) {
                    if ((f.startsWith('frame_pts_') && f.endsWith('.jpg')) || f === 'metadata.json') {
                        await fs.rm(path.join(paths.framesDir, f), { force: true });
                    }
                }
            }
            frameList = await extractKeyframes(ffmpegExe, ffprobeExe, videoFile, paths.framesDir, {
                ...procOpts,
                baselineIntervalSec: this.options.baselineIntervalSec || 10,
                sceneChangeThreshold: this.options.sceneChangeThreshold || 0.3
            });
        }
        // 保存条目 source.json
        await store.saveEpisodeSource(entryId, {
            entryId,
            title,
            duration,
            inputUrlOrPath: targetInput,
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
    async readSlice(entryId, startTimeSec, durationSec) {
        const paths = this.options.store.getEpisodePaths(entryId);
        let totalDuration = 0;
        let title = entryId;
        const sourceExists = await fs.stat(paths.sourceJson).then(() => true).catch(() => false);
        if (sourceExists) {
            try {
                const sourceData = JSON.parse(await fs.readFile(paths.sourceJson, 'utf-8'));
                totalDuration = sourceData.duration || 0;
                title = sourceData.title || entryId;
            }
            catch {
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
        let allFrames = [];
        const metaExists = await fs.stat(metaFile).then(() => true).catch(() => false);
        if (metaExists) {
            try {
                const rawM = JSON.parse(await fs.readFile(metaFile, 'utf-8'));
                if (Array.isArray(rawM)) {
                    allFrames = rawM;
                }
            }
            catch {
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
//# sourceMappingURL=pipeline.js.map