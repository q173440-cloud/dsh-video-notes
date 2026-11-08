import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { runProcess } from './process.js';
export function detectSourceType(input) {
    const trimmed = input.trim().toLowerCase();
    if (trimmed.includes('bilibili.com') || trimmed.includes('b23.tv')) {
        return 'bilibili';
    }
    if (trimmed.includes('youtube.com') || trimmed.includes('youtu.be')) {
        return 'youtube';
    }
    const ext = path.extname(trimmed);
    if (['.mp4', '.mkv', '.mov', '.webm', '.flv', '.avi'].includes(ext)) {
        return 'local';
    }
    return 'other';
}
export function generateLocalStableId(absPath) {
    const normalized = path.resolve(absPath).toLowerCase().replace(/\\/g, '/');
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    const filename = path.basename(absPath, path.extname(absPath));
    const safeFilename = filename.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_').slice(0, 20);
    return `local-${safeFilename}-${hash.slice(0, 12)}`;
}
export async function inspectSource(input, options) {
    const sourceType = detectSourceType(input);
    const scope = options.scope || 'single';
    // 1. 本地视频文件直接探测
    if (sourceType === 'local') {
        const absPath = path.resolve(input);
        const stat = await fs.stat(absPath);
        if (!stat.isFile()) {
            throw new Error(`Target local path is not a file: ${input}`);
        }
        const filename = path.basename(absPath);
        const stableId = generateLocalStableId(absPath);
        return {
            source: absPath,
            sourceType: 'local',
            scope: 'single',
            isCollection: false,
            totalItems: 1,
            items: [{
                    id: '1',
                    stableId,
                    title: filename,
                    url: absPath,
                    status: 'queued'
                }],
            summary: `本地视频文件: ${filename} (条目标识: ${stableId})`
        };
    }
    // 2. 外部 URL 通过 yt-dlp 查询元数据
    const args = [
        '-m', 'yt_dlp',
        '--dump-json',
        '--no-warnings',
        '--skip-download'
    ];
    if (scope === 'single') {
        args.push('--no-playlist');
    }
    else {
        args.push('--flat-playlist');
    }
    args.push(input);
    const res = await runProcess(options.pythonExe, args, {
        timeoutMs: 60000,
        signal: options.signal,
        subprocessService: options.subprocessService
    });
    if (res.code !== 0 && !res.stdout.trim()) {
        throw new Error(`Failed to inspect video source (code ${res.code}): ${res.stderr || 'Unknown error'}`);
    }
    const lines = res.stdout.trim().split('\n').filter(l => l.trim().length > 0);
    const items = [];
    for (let i = 0; i < lines.length; i++) {
        try {
            const parsed = JSON.parse(lines[i]);
            const title = parsed.title || `Item ${i + 1}`;
            const duration = parsed.duration || undefined;
            const uploader = parsed.uploader || parsed.channel || undefined;
            const itemUrl = parsed.webpage_url || parsed.url || input;
            let stableId = parsed.id ? String(parsed.id) : `item-${i + 1}`;
            if (sourceType === 'bilibili') {
                const bvid = parsed.id || '';
                const pIndex = parsed.playlist_index ?? (i + 1);
                stableId = `bili-${bvid}-p${pIndex}`;
            }
            else if (sourceType === 'youtube') {
                stableId = `yt-${parsed.id || i + 1}`;
            }
            items.push({
                id: String(i + 1),
                stableId,
                title,
                url: itemUrl,
                duration,
                uploader,
                pIndex: parsed.playlist_index ?? (i + 1),
                status: 'queued'
            });
        }
        catch {
            // ignore
        }
    }
    if (items.length === 0) {
        throw new Error(`yt-dlp returned no valid items for: ${input}`);
    }
    const isCollection = items.length > 1;
    return {
        source: input,
        sourceType,
        scope,
        isCollection,
        totalItems: isCollection ? items.length : 1,
        items: scope === 'single' ? [items[0]] : items,
        summary: isCollection
            ? `检测到合集，共 ${items.length} 集。当前${scope === 'single' ? '仅处理首集' : '展开处理全部'}`
            : `单视频: 《${items[0].title}》(${items[0].duration ? Math.round(items[0].duration) + '秒' : '时长未知'})`
    };
}
//# sourceMappingURL=source.js.map