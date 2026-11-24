import { promises as fs } from 'fs';
import path from 'path';
import { normalizeSegments, sliceSegments } from './transcript.js';
function formatMmSs(sec) {
    const safe = Math.max(0, Math.floor(sec));
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function roundSec(val) {
    return Math.round(val * 10) / 10;
}
function formatSliceText(entryId, title, sliceIdx, totalSlices, startSec, endSec, totalDuration, segments, frames, framesDir) {
    const lines = [
        `【切片 ${String(sliceIdx).padStart(2, '0')}/${String(totalSlices).padStart(2, '0')} | ${formatMmSs(startSec)} - ${formatMmSs(endSec)} (${startSec}s -> ${endSec}s) | 总长 ${Math.round(totalDuration)}s】`,
        `条目: ${entryId} | 标题: ${title}`,
        '',
        `--- 字幕片段 (${segments.length} 条) ---`
    ];
    for (const s of segments) {
        const rawInfo = s.rawText && s.rawText !== s.text ? ` [原听写: ${s.rawText}]` : '';
        lines.push(`[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: ${s.text}${rawInfo}`);
    }
    lines.push('', `--- 关键帧证据 (${frames.length} 张，供切片子代理用 read_file 查看) ---`);
    for (const f of frames) {
        const rel = f.relativeTime || formatMmSs(f.timestamp);
        const fPath = f.path || path.join(framesDir, f.filename || '');
        lines.push(`[时间点 ${rel} (${f.timestamp}s)] ${fPath}`);
    }
    return lines.join('\n') + '\n';
}
export async function planEpisodeSlices(store, entryId, options = {}) {
    const durationSec = options.durationSec ?? 90;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
        throw new Error(`Invalid slice duration: ${durationSec} (expected a positive number)`);
    }
    const paths = store.getEpisodePaths(entryId);
    let title = entryId;
    let totalDuration = 0;
    try {
        const src = JSON.parse(await fs.readFile(paths.sourceJson, 'utf-8'));
        if (src.title)
            title = String(src.title);
        if (typeof src.duration === 'number' && src.duration > 0)
            totalDuration = src.duration;
    }
    catch {
        // 缺省 source.json 时继续尝试从字幕与帧元数据推导总时长
    }
    const rawTranscript = JSON.parse(await fs.readFile(paths.transcriptJson, 'utf-8'));
    const allSegments = normalizeSegments(rawTranscript);
    let allFrames = [];
    const metaPath = path.join(paths.framesDir, 'metadata.json');
    try {
        const rawMeta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
        if (Array.isArray(rawMeta))
            allFrames = rawMeta;
    }
    catch {
        // 无帧元数据时视为空数组
    }
    if (totalDuration <= 0 && allSegments.length > 0) {
        totalDuration = allSegments[allSegments.length - 1].end;
    }
    if (totalDuration <= 0 && allFrames.length > 0) {
        totalDuration = allFrames[allFrames.length - 1].timestamp;
    }
    const slicesDir = options.outDir ? path.resolve(options.outDir) : path.join(paths.workDir, 'slices');
    await fs.mkdir(slicesDir, { recursive: true });
    // 清理同一目录下的旧切片清单，避免更换 --duration 重跑留下陈旧文件
    const existing = await fs.readdir(slicesDir).catch(() => []);
    for (const name of existing) {
        if (/^slice_\d+\.txt$/.test(name) || name === 'index.json') {
            await fs.rm(path.join(slicesDir, name), { force: true });
        }
    }
    const windows = [];
    if (totalDuration <= 0) {
        windows.push({ start: 0, end: roundSec(durationSec) });
    }
    else {
        let cursor = 0;
        while (cursor < totalDuration - 1e-6) {
            const end = Math.min(totalDuration, cursor + durationSec);
            windows.push({ start: roundSec(cursor), end: roundSec(end) });
            cursor += durationSec;
        }
    }
    const slices = [];
    for (let i = 0; i < windows.length; i++) {
        const { start, end } = windows[i];
        const isLast = i === windows.length - 1;
        const segs = sliceSegments(allSegments, start, end);
        const frames = allFrames.filter(f => isLast ? f.timestamp >= start : (f.timestamp >= start && f.timestamp < end));
        const fileName = `slice_${String(i + 1).padStart(2, '0')}.txt`;
        const manifestPath = path.join(slicesDir, fileName);
        const text = formatSliceText(entryId, title, i + 1, windows.length, start, end, totalDuration, segs, frames, paths.framesDir);
        await fs.writeFile(manifestPath, text, 'utf-8');
        slices.push({
            index: i + 1,
            startSec: start,
            endSec: end,
            rangeLabel: `${formatMmSs(start)}-${formatMmSs(end)}`,
            segmentCount: segs.length,
            frameCount: frames.length,
            manifestPath
        });
    }
    const indexPath = path.join(slicesDir, 'index.json');
    const plan = {
        entryId,
        title,
        totalDuration: roundSec(totalDuration),
        sliceDurationSec: durationSec,
        totalSegments: allSegments.length,
        totalFrames: allFrames.length,
        sliceCount: slices.length,
        slicesDir,
        indexPath,
        slices
    };
    await fs.writeFile(indexPath, JSON.stringify(plan, null, 2), 'utf-8');
    return plan;
}
export function formatSlicePlanSummary(plan, maxListedSlices = 20) {
    const lines = [
        `【切片索引已生成】条目: ${plan.entryId} | 总时长: ${Math.round(plan.totalDuration)}s | 字幕: ${plan.totalSegments} 句 | 关键帧: ${plan.totalFrames} 张 | 切片数: ${plan.sliceCount} (每片 ${plan.sliceDurationSec}s)`,
        `切片清单目录: ${plan.slicesDir}`
    ];
    const formatEntry = (s) => `- Slice ${String(s.index).padStart(2, '0')} [${s.rangeLabel}] (${s.startSec}s-${s.endSec}s): ${s.segmentCount} 句字幕, ${s.frameCount} 帧 -> ${s.manifestPath}`;
    if (plan.slices.length <= maxListedSlices) {
        for (const s of plan.slices)
            lines.push(formatEntry(s));
    }
    else {
        const headCount = 10;
        const tailCount = 5;
        for (const s of plan.slices.slice(0, headCount))
            lines.push(formatEntry(s));
        lines.push(`... (省略 ${plan.slices.length - headCount - tailCount} 片，完整清单见 ${plan.indexPath})`);
        for (const s of plan.slices.slice(-tailCount))
            lines.push(formatEntry(s));
    }
    lines.push(`索引文件: ${plan.indexPath}`);
    lines.push('请将各 slice_XX.txt 路径并行派发给 research 子代理读取与看图核验（主会话勿直接全量读图或 read-slice）。');
    return lines.join('\n');
}
//# sourceMappingURL=slice-plan.js.map