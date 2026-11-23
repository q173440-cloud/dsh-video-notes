import { promises as fs, statSync } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { runProcess } from './process.js';
import { resolveCookiesPath } from './cookies.js';
import { resolveLocalTarget } from './local-media.js';
export function extractUrlFromInput(input) {
    const m = input.match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/i);
    if (!m)
        return undefined;
    const cleaned = m[0].replace(/[，。！？；：、）】》」』”’.,!?;:)\]]+$/u, '');
    return /^https?:\/\//i.test(cleaned) ? cleaned : undefined;
}
export function normalizeInputUrl(input) {
    const sourceType = detectSourceType(input);
    if (sourceType === 'local') {
        return input.trim();
    }
    return extractUrlFromInput(input) || input.trim();
}
export function detectSourceType(input) {
    const trimmed = input.trim();
    const url = extractUrlFromInput(trimmed);
    if (url) {
        const lower = url.toLowerCase();
        if (lower.includes('bilibili.com') || lower.includes('b23.tv')) {
            return 'bilibili';
        }
        if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
            return 'youtube';
        }
        return 'other';
    }
    try {
        const st = statSync(trimmed);
        if (st.isFile() || st.isDirectory()) {
            return 'local';
        }
    }
    catch {
        // ignore non-existent path
    }
    const ext = path.extname(trimmed.toLowerCase());
    if (['.mp4', '.mkv', '.mov', '.webm', '.flv', '.avi', '.m4v'].includes(ext)) {
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
export function getYtDlpExtraArgs(sourceType) {
    if (sourceType !== 'youtube')
        return [];
    const args = ['--remote-components', 'ejs:github'];
    if (process.execPath) {
        args.push('--js-runtimes', `node:${process.execPath}`);
    }
    return args;
}
export async function inspectSource(input, options) {
    const sourceType = detectSourceType(input);
    const scope = options.scope || 'single';
    // 1. 本地视频文件或目录探测（支持分离音视频自动配对）
    if (sourceType === 'local') {
        const absPath = path.resolve(input);
        const stat = await fs.stat(absPath);
        if (stat.isDirectory() && !options.ffprobeExe) {
            throw new Error(`Directory inspection requires ffprobeExe: ${absPath}`);
        }
        if (options.ffprobeExe) {
            const target = await resolveLocalTarget(absPath, options.ffprobeExe, {
                signal: options.signal,
                subprocessService: options.subprocessService
            });
            const filename = path.basename(target.videoPath);
            const stableId = generateLocalStableId(target.videoPath);
            const pairHint = target.companionAudioPath
                ? `，已自动配对音频: ${path.basename(target.companionAudioPath)}`
                : '';
            return {
                source: target.videoPath,
                sourceType: 'local',
                scope: 'single',
                isCollection: false,
                totalItems: 1,
                items: [{
                        id: '1',
                        stableId,
                        title: filename,
                        url: target.videoPath,
                        duration: target.duration && target.duration > 0 ? target.duration : undefined,
                        status: 'queued'
                    }],
                summary: `本地视频文件: ${filename} (条目标识: ${stableId}${pairHint})`
            };
        }
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
    // 2. 外部 URL 先提取规范化并自动发现 Cookie，再通过 yt-dlp 查询元数据
    const normalizedUrl = normalizeInputUrl(input);
    const resolvedCookies = await resolveCookiesPath(sourceType, {
        explicitCookies: options.cookies,
        dataDir: options.dataDir
    });
    const args = [
        '-m', 'yt_dlp',
        '--dump-json',
        '--no-warnings',
        '--skip-download',
        scope === 'single' ? '--no-playlist' : '--flat-playlist',
        ...getYtDlpExtraArgs(sourceType)
    ];
    if (resolvedCookies) {
        args.push('--cookies', resolvedCookies);
    }
    args.push(normalizedUrl);
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
    // 增强探测：对于 B 站链接，尝试获取 UGC season 完整合集信息
    if (sourceType === 'bilibili' && scope === 'collection') {
        const bvidMatch = normalizedUrl.match(/(BV[a-zA-Z0-9]+)/);
        if (bvidMatch) {
            const bvid = bvidMatch[1];
            try {
                const { stdout: apiOut } = await runProcess(options.pythonExe, [
                    '-c',
                    'import sys, urllib.request, json; req = urllib.request.Request(f"https://api.bilibili.com/x/web-interface/view?bvid={sys.argv[1]}", headers={"User-Agent": "Mozilla/5.0"}); print(json.dumps(json.loads(urllib.request.urlopen(req, timeout=15).read().decode("utf-8")).get("data", {}).get("ugc_season", {}).get("sections", [])))',
                    bvid
                ], {
                    timeoutMs: 30000,
                    signal: options.signal,
                    subprocessService: options.subprocessService
                });
                const sections = JSON.parse(apiOut);
                if (sections && sections.length > 0) {
                    let count = 0;
                    for (const sec of sections) {
                        for (const ep of sec.episodes) {
                            items.push({
                                id: String(++count),
                                stableId: `bili-${ep.bvid}-p1`,
                                title: ep.title,
                                url: `https://www.bilibili.com/video/${ep.bvid}`,
                                duration: ep.arc.duration,
                                uploader: '',
                                pIndex: count,
                                status: 'queued'
                            });
                        }
                    }
                }
            }
            catch (e) {
                console.warn('UGC season API fetch failed, falling back to playlist:', e);
            }
        }
    }
    if (items.length === 0) {
        for (let i = 0; i < lines.length; i++) {
            try {
                const parsed = JSON.parse(lines[i]);
                const title = parsed.title || `Item ${i + 1}`;
                const duration = parsed.duration || undefined;
                const uploader = parsed.uploader || parsed.channel || undefined;
                const itemUrl = parsed.webpage_url || parsed.url || normalizedUrl;
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
    }
    if (items.length === 0) {
        throw new Error(`yt-dlp returned no valid items for: ${normalizedUrl}`);
    }
    const isCollection = items.length > 1;
    return {
        source: normalizedUrl,
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