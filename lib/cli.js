import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'node:util';
import { resolvePython, resolveBinary } from './index.js';
import { inspectSource } from './source.js';
import { VideoNotesStore } from './store.js';
import { VideoPipeline } from './pipeline.js';
import { runProcess } from './process.js';
import { inspectAllCookies } from './cookies.js';
function getPkgRoot() {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(currentDir, '..');
}
function printUsage() {
    const text = `Usage: video-notes <command> [options]

Commands:
  doctor      Verify local runtime dependencies (python, yt-dlp, faster-whisper, ffmpeg, models)
  inspect     Probe video URL or local file metadata and collection episodes
  prepare     Download/reuse media, fetch subtitles or run local ASR, and extract keyframes
  read-slice  Read transcript segments and keyframe image paths for a time range
  save-note   Validate and save episode Markdown review note (and clean work cache if completed)

Common options:
  --data-dir <dir>   Override video-notes-data directory
  --model-dir <dir>  Override Whisper model cache directory
  --python <path>    Override Python executable path
  --json             Output raw JSON result
  --help             Show help

Prepare options:
  --baseline-interval <sec>  Keyframe baseline interval in seconds (default: 10)
  --scene-threshold <0-1>    Keyframe scene-change threshold in (0, 1] (default: 0.3)
`;
    console.log(text);
}
async function resolveGaps(gapsJson) {
    if (!gapsJson)
        return undefined;
    const trimmed = gapsJson.trim();
    if (!trimmed)
        return undefined;
    const isFile = await fs.stat(trimmed).then(s => s.isFile()).catch(() => false);
    const raw = isFile ? await fs.readFile(trimmed, 'utf-8') : trimmed;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
        throw new Error('--gaps-json must resolve to a JSON array of strings');
    }
    return parsed.map(String);
}
async function readStdinText() {
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString('utf-8');
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
        printUsage();
        return;
    }
    const command = argv[0];
    const { values } = parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
            'data-dir': { type: 'string' },
            'model-dir': { type: 'string' },
            python: { type: 'string' },
            url: { type: 'string' },
            scope: { type: 'string' },
            cookies: { type: 'string' },
            'entry-id': { type: 'string' },
            'force-rebuild': { type: 'boolean', default: false },
            language: { type: 'string' },
            'whisper-model': { type: 'string' },
            'baseline-interval': { type: 'string' },
            'scene-threshold': { type: 'string' },
            start: { type: 'string' },
            duration: { type: 'string' },
            title: { type: 'string' },
            status: { type: 'string' },
            content: { type: 'string' },
            'content-file': { type: 'string' },
            'gaps-json': { type: 'string' },
            'ai-notes': { type: 'string' },
            json: { type: 'boolean', default: false },
            help: { type: 'boolean', short: 'h', default: false }
        }
    });
    if (values.help) {
        printUsage();
        return;
    }
    const pkgRoot = getPkgRoot();
    const dataDir = path.resolve(values['data-dir'] || process.env.VIDEO_NOTES_DATA_DIR || path.resolve(pkgRoot, '..', 'video-notes-data'));
    const modelDir = path.resolve(values['model-dir'] || path.join(dataDir, 'models'));
    const jsonOutput = Boolean(values.json);
    const pythonExe = await resolvePython(values.python, pkgRoot);
    const ffmpegExe = await resolveBinary('ffmpeg', pkgRoot);
    const ffprobeExe = await resolveBinary('ffprobe', pkgRoot);
    const transcribeScript = path.join(pkgRoot, 'python', 'transcribe.py');
    if (command === 'doctor') {
        const ffRes = await runProcess(ffmpegExe, ['-version'], { timeoutMs: 5000 });
        const fpRes = await runProcess(ffprobeExe, ['-version'], { timeoutMs: 5000 });
        const pyRes = await runProcess(pythonExe, ['-c', 'import yt_dlp, faster_whisper; print(yt_dlp.version.__version__)'], { timeoutMs: 10000 });
        const scriptExists = await fs.stat(transcribeScript).then(s => s.isFile()).catch(() => false);
        const modelFiles = await fs.readdir(modelDir).catch(() => []);
        const cookieStatus = await inspectAllCookies(dataDir);
        const report = {
            ok: ffRes.code === 0 && fpRes.code === 0 && pyRes.code === 0 && scriptExists,
            nodeVersion: process.version,
            pythonExe,
            ytDlpVersion: pyRes.stdout.trim(),
            ffmpegOk: ffRes.code === 0,
            ffprobeOk: fpRes.code === 0,
            transcribeScriptExists: scriptExists,
            dataDir,
            modelDir,
            cachedModelEntries: modelFiles,
            cookiesDir: cookieStatus.cookiesDir,
            cookies: cookieStatus.platforms
        };
        if (jsonOutput) {
            console.log(JSON.stringify(report, null, 2));
        }
        else {
            console.log('【环境自检报告】');
            console.log(`状态: ${report.ok ? '就绪' : '异常'}`);
            console.log(`Node: ${report.nodeVersion}`);
            console.log(`Python: ${report.pythonExe} (yt-dlp ${report.ytDlpVersion})`);
            console.log(`FFmpeg: ${ffmpegExe} (${report.ffmpegOk ? 'OK' : 'FAIL'})`);
            console.log(`FFprobe: ${ffprobeExe} (${report.ffprobeOk ? 'OK' : 'FAIL'})`);
            console.log(`Transcribe脚本: ${transcribeScript} (${report.transcribeScriptExists ? 'OK' : 'MISSING'})`);
            console.log(`数据目录: ${dataDir}`);
            console.log(`模型缓存目录: ${modelDir} (${modelFiles.length} 项)`);
            console.log(`Cookies目录: ${cookieStatus.cookiesDir}`);
            for (const p of ['bilibili', 'youtube']) {
                const c = cookieStatus.platforms[p];
                if (!c.exists) {
                    console.log(`  - ${p}: 未配置 (缺失关键字段: ${c.missingKeys.join(', ')})`);
                }
                else {
                    const freshness = c.possiblyExpired ? `可能过期 (${c.ageHours}h > ${c.maxAgeHours}h)` : `新鲜 (${c.ageHours}h)`;
                    const keyState = c.hasRequiredKeys
                        ? `关键字段就绪: ${c.foundKeys.join(', ')}`
                        : `缺少关键字段: ${c.missingKeys.join(', ')}`;
                    console.log(`  - ${p}: ${path.basename(c.filePath || '')} | ${freshness} | ${c.cookieCount} 条 | ${keyState}`);
                }
            }
        }
        if (!report.ok)
            process.exitCode = 1;
        return;
    }
    const baselineIntervalSec = values['baseline-interval'] !== undefined
        ? Number(values['baseline-interval'])
        : undefined;
    if (baselineIntervalSec !== undefined && (!Number.isFinite(baselineIntervalSec) || baselineIntervalSec <= 0)) {
        throw new Error(`Invalid --baseline-interval: ${values['baseline-interval']} (expected a positive number)`);
    }
    const sceneChangeThreshold = values['scene-threshold'] !== undefined
        ? Number(values['scene-threshold'])
        : undefined;
    if (sceneChangeThreshold !== undefined && (!Number.isFinite(sceneChangeThreshold) || sceneChangeThreshold <= 0 || sceneChangeThreshold > 1)) {
        throw new Error(`Invalid --scene-threshold: ${values['scene-threshold']} (expected a number in (0, 1])`);
    }
    const store = new VideoNotesStore(dataDir);
    await store.init();
    const pipeline = new VideoPipeline({
        pythonExe,
        ffmpegExe,
        ffprobeExe,
        transcribeScript,
        store,
        modelDir,
        whisperModel: values['whisper-model'] || 'small',
        computeType: 'int8',
        language: values.language || 'auto',
        cookies: values.cookies,
        baselineIntervalSec,
        sceneChangeThreshold
    });
    if (command === 'inspect') {
        const url = values.url;
        if (!url)
            throw new Error('Missing required option: --url');
        const scope = (values.scope === 'collection' ? 'collection' : 'single');
        const res = await inspectSource(url, {
            pythonExe,
            scope,
            cookies: values.cookies,
            dataDir,
            ffprobeExe
        });
        if (jsonOutput) {
            console.log(JSON.stringify(res, null, 2));
        }
        else {
            console.log(`【视频探测结果】\n来源类型: ${res.sourceType}\n概括: ${res.summary}`);
            if (res.items.length > 0) {
                console.log(`条目列表 (共 ${res.items.length} 条):`);
                for (const item of res.items) {
                    const dur = item.duration ? `${Math.round(item.duration)}秒` : '时长未知';
                    console.log(`- [${item.stableId}] 《${item.title}》 (${dur}) -> ${item.url}`);
                }
            }
        }
        return;
    }
    if (command === 'prepare') {
        const url = values.url;
        const entryId = values['entry-id'];
        if (!url || !entryId)
            throw new Error('Both --url and --entry-id are required');
        const res = await pipeline.prepareEpisode(url, entryId, {
            forceRebuild: Boolean(values['force-rebuild']),
            language: values.language,
            cookies: values.cookies
        });
        if (jsonOutput) {
            console.log(JSON.stringify(res, null, 2));
        }
        else {
            console.log(`【准备就绪】\n${res.message}`);
            console.log(`字幕数据: ${res.transcriptPath}`);
            console.log(`SRT字幕: ${res.srtPath}`);
            console.log(`关键帧目录: ${res.framesDir} (共 ${res.frameCount} 张)`);
            console.log(`产物模式: ${res.reusedExisting ? '复用已有完整资产' : '新生成并入库'}`);
        }
        return;
    }
    if (command === 'read-slice') {
        const entryId = values['entry-id'];
        if (!entryId)
            throw new Error('Missing required option: --entry-id');
        const startSec = Number(values.start ?? 0);
        const durSec = Number(values.duration ?? 120);
        const res = await pipeline.readSlice(entryId, startSec, durSec);
        if (jsonOutput) {
            console.log(JSON.stringify(res, null, 2));
        }
        else {
            console.log(`【时间切片: ${res.timeRange[0]}s -> ${res.timeRange[1]}s (总长 ${Math.round(res.totalDuration)}s)】`);
            console.log(`\n--- 字幕片段 (${res.segments.length} 条) ---`);
            for (const s of res.segments) {
                console.log(`[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: ${s.text}`);
            }
            console.log(`\n--- 关键帧证据 (${res.frames.length} 张，请用 read_file 查看以下图片) ---`);
            for (const f of res.frames) {
                console.log(`[时间点 ${f.relativeTime} (${f.timestamp}s)] ${f.path}`);
            }
            if (res.hasMore && res.nextRange) {
                const nextDur = Math.round((res.nextRange[1] - res.nextRange[0]) * 10) / 10;
                console.log(`\n后续分段: --start ${res.nextRange[0]} --duration ${nextDur}`);
            }
            else {
                console.log('\n已到达视频结尾。');
            }
        }
        return;
    }
    if (command === 'save-note') {
        const entryId = values['entry-id'];
        const status = values.status;
        if (!entryId)
            throw new Error('Missing required option: --entry-id');
        if (status !== 'completed' && status !== 'partial') {
            throw new Error("Invalid --status: expected 'completed' or 'partial'");
        }
        let contentMarkdown = values.content || '';
        if (values['content-file']) {
            contentMarkdown = values['content-file'] === '-'
                ? await readStdinText()
                : await fs.readFile(path.resolve(values['content-file']), 'utf-8');
        }
        if (!contentMarkdown.trim()) {
            throw new Error('Missing note content: provide --content or --content-file');
        }
        const gaps = await resolveGaps(values['gaps-json']);
        const res = await store.saveNote({
            entryId,
            title: values.title,
            status,
            contentMarkdown,
            gaps,
            aiNotes: values['ai-notes']
        });
        if (jsonOutput) {
            console.log(JSON.stringify(res, null, 2));
        }
        else {
            console.log(`【笔记保存结果】\n条目: ${res.entryId}\n状态: ${res.status}\n路径: ${res.notePath}`);
            console.log(`大小: ${res.bytes} 字节\n临时视频清理: ${res.cleanedWorkDir ? '已安全清除' : '未清理（保留恢复素材）'}`);
            console.log(res.message);
        }
        return;
    }
    throw new Error(`Unknown command: ${command}`);
}
main().catch((err) => {
    console.error(`Error: ${err?.message || err}`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map