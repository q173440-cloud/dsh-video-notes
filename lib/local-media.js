import { promises as fs } from 'fs';
import path from 'path';
import { runProcess } from './process.js';
const MEDIA_EXTS = new Set([
    '.mp4', '.mkv', '.mov', '.webm', '.flv', '.avi', '.m4v',
    '.m4a', '.aac', '.mp3', '.ogg', '.opus', '.flac', '.wav'
]);
const IGNORED_WORK_FILES = new Set([
    'supplement_audio.wav',
    'audio_16k.wav',
    'video_merged.mp4',
    'temp_audio.m4a'
]);
function extractVidTag(tags) {
    if (!tags || typeof tags !== 'object')
        return undefined;
    for (const [k, v] of Object.entries(tags)) {
        if (k.toLowerCase() === 'comment' && typeof v === 'string') {
            const m = v.match(/\bvid:([a-zA-Z0-9_-]+)/i);
            if (m)
                return m[1].toLowerCase();
        }
    }
    return undefined;
}
function normalizeBasePrefix(filePath) {
    const rawStem = path.basename(filePath, path.extname(filePath));
    const stripped = rawStem
        .replace(/(?:\s*[-_.\s]\s*(?:video|audio|vid|aud|v|a|f\d+|\d+)|\s*\(\d+\))+$/i, '')
        .trim();
    return (stripped || rawStem).toLowerCase();
}
function withinDurationTolerance(d1, d2) {
    if (d1 > 0 && d2 > 0) {
        return Math.abs(d1 - d2) <= 3;
    }
    return true;
}
async function probeFileStreams(ffprobeExe, filePath, opts = {}) {
    const res = await runProcess(ffprobeExe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath], {
        signal: opts.signal,
        timeoutMs: 30000,
        subprocessService: opts.subprocessService
    });
    if (res.code !== 0) {
        throw new Error(`ffprobe failed for ${filePath} (code ${res.code}): ${res.stderr}`);
    }
    const data = JSON.parse(res.stdout || '{}');
    const format = data.format || {};
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const hasVideo = streams.some(s => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
    const hasAudio = streams.some(s => s.codec_type === 'audio');
    const streamDur = streams.find(s => Number(s.duration) > 0)?.duration;
    const duration = Number(format.duration || streamDur || 0);
    const kind = hasVideo && hasAudio ? 'av' : hasVideo ? 'video-only' : hasAudio ? 'audio-only' : 'other';
    return {
        filePath,
        fileName: path.basename(filePath),
        kind,
        duration: Number.isFinite(duration) ? duration : 0,
        vidTag: extractVidTag(format.tags)
    };
}
async function scanDirectoryMedia(dirPath, ffprobeExe, opts = {}) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const results = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile())
            continue;
        if (entry.name.startsWith('.'))
            continue;
        if (IGNORED_WORK_FILES.has(entry.name.toLowerCase()))
            continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!MEDIA_EXTS.has(ext))
            continue;
        const fullPath = path.join(dirPath, entry.name);
        try {
            results.push(await probeFileStreams(ffprobeExe, fullPath, opts));
        }
        catch {
            // Ignore unreadable non-target files during directory scan
        }
    }
    return results;
}
function findCompanionAudio(videoEntry, audioEntries, totalVideoOnlyCount) {
    if (audioEntries.length === 0)
        return undefined;
    const sortByDurDiff = (list) => [...list].sort((a, b) => Math.abs(a.duration - videoEntry.duration) - Math.abs(b.duration - videoEntry.duration));
    if (videoEntry.vidTag) {
        const tagMatches = audioEntries.filter(a => a.vidTag === videoEntry.vidTag);
        if (tagMatches.length > 0) {
            return { audio: sortByDurDiff(tagMatches)[0], reason: 'vid-tag' };
        }
    }
    const vPrefix = normalizeBasePrefix(videoEntry.filePath);
    const prefixMatches = audioEntries.filter(a => normalizeBasePrefix(a.filePath) === vPrefix && withinDurationTolerance(videoEntry.duration, a.duration));
    if (prefixMatches.length > 0) {
        return { audio: sortByDurDiff(prefixMatches)[0], reason: 'name-prefix' };
    }
    if (totalVideoOnlyCount === 1 &&
        audioEntries.length === 1 &&
        withinDurationTolerance(videoEntry.duration, audioEntries[0].duration)) {
        return { audio: audioEntries[0], reason: 'unique-pair' };
    }
    return undefined;
}
export async function resolveLocalTarget(inputPath, ffprobeExe, opts = {}) {
    const absPath = path.resolve(inputPath);
    const st = await fs.stat(absPath);
    if (st.isFile()) {
        const probed = await probeFileStreams(ffprobeExe, absPath, opts);
        if (probed.kind !== 'av' && probed.kind !== 'video-only') {
            throw new Error(`Target local file does not contain a video stream: ${absPath}`);
        }
        if (probed.kind === 'av') {
            return {
                inputPath: absPath,
                videoPath: absPath,
                displayTitle: probed.fileName,
                duration: probed.duration
            };
        }
        const dirMedia = await scanDirectoryMedia(path.dirname(absPath), ffprobeExe, opts);
        const totalVideoOnly = dirMedia.filter(m => m.kind === 'video-only').length || 1;
        const audioCandidates = dirMedia.filter(m => m.kind === 'audio-only' && m.filePath !== absPath);
        const match = findCompanionAudio(probed, audioCandidates, totalVideoOnly);
        return {
            inputPath: absPath,
            videoPath: absPath,
            companionAudioPath: match?.audio.filePath,
            displayTitle: probed.fileName,
            matchReason: match?.reason,
            duration: probed.duration
        };
    }
    if (!st.isDirectory()) {
        throw new Error(`Target local path is neither a file nor a directory: ${absPath}`);
    }
    const mediaFiles = await scanDirectoryMedia(absPath, ffprobeExe, opts);
    const avFiles = mediaFiles.filter(m => m.kind === 'av');
    const videoOnlyFiles = mediaFiles.filter(m => m.kind === 'video-only');
    const audioOnlyFiles = mediaFiles.filter(m => m.kind === 'audio-only');
    const usedAudio = new Set();
    const pairs = [];
    for (const v of videoOnlyFiles) {
        const availAudio = audioOnlyFiles.filter(a => !usedAudio.has(a.filePath));
        const match = findCompanionAudio(v, availAudio, videoOnlyFiles.length);
        if (match) {
            usedAudio.add(match.audio.filePath);
            pairs.push({ video: v, audio: match.audio, reason: match.reason });
        }
    }
    if (avFiles.length > 1) {
        throw new Error(`目录中存在多个完整视频文件，请指定具体文件路径: ${avFiles.map(f => f.fileName).join(', ')}`);
    }
    if (pairs.length > 1) {
        throw new Error(`目录中存在多组分离音视频，请指定具体视频文件路径: ${pairs.map(p => p.video.fileName).join(', ')}`);
    }
    if (avFiles.length === 1 && videoOnlyFiles.length === 0) {
        return {
            inputPath: absPath,
            videoPath: avFiles[0].filePath,
            displayTitle: avFiles[0].fileName,
            duration: avFiles[0].duration
        };
    }
    if (pairs.length === 1 && avFiles.length === 0) {
        const p = pairs[0];
        return {
            inputPath: absPath,
            videoPath: p.video.filePath,
            companionAudioPath: p.audio.filePath,
            displayTitle: p.video.fileName,
            matchReason: p.reason,
            duration: p.video.duration
        };
    }
    if (avFiles.length === 1 && videoOnlyFiles.length > 0) {
        const names = [...avFiles.map(f => f.fileName), ...videoOnlyFiles.map(f => f.fileName)];
        throw new Error(`目录中同时存在完整视频与分离视频文件，请指定具体文件路径: ${names.join(', ')}`);
    }
    if (videoOnlyFiles.length === 1 && audioOnlyFiles.length === 0) {
        return {
            inputPath: absPath,
            videoPath: videoOnlyFiles[0].filePath,
            displayTitle: videoOnlyFiles[0].fileName,
            duration: videoOnlyFiles[0].duration
        };
    }
    throw new Error(`目录中未找到可唯一定位的视频文件或可配对音视频 (${absPath})：完整视频 ${avFiles.length} 个，纯视频 ${videoOnlyFiles.length} 个，纯音频 ${audioOnlyFiles.length} 个`);
}
export async function remuxVideoAndAudio(ffmpegExe, videoPath, audioPath, outputPath, opts = {}) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const procOpts = {
        signal: opts.signal,
        timeoutMs: 300000,
        subprocessService: opts.subprocessService
    };
    const copyRes = await runProcess(ffmpegExe, [
        '-y',
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath
    ], procOpts);
    const copyOk = copyRes.code === 0 &&
        (await fs.stat(outputPath).then(s => s.isFile() && s.size > 0).catch(() => false));
    if (copyOk) {
        return outputPath;
    }
    const transcodeRes = await runProcess(ffmpegExe, [
        '-y',
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        outputPath
    ], procOpts);
    const transcodeOk = transcodeRes.code === 0 &&
        (await fs.stat(outputPath).then(s => s.isFile() && s.size > 0).catch(() => false));
    if (!transcodeOk) {
        throw new Error(`FFmpeg remux failed (code ${transcodeRes.code}): ${transcodeRes.stderr || copyRes.stderr}`);
    }
    return outputPath;
}
//# sourceMappingURL=local-media.js.map