import path from 'path';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { runProcess } from './process.js';
import { VideoNotesStore } from './store.js';
import { VideoPipeline } from './pipeline.js';
import { createTools } from './tools.js';
export const name = 'dsh-video-notes';
export const inject = ['tools', 'skills', 'subprocess'];
async function fileExists(p) {
    return await fs.stat(p).then(s => s.isFile()).catch(() => false);
}
export async function hasRequiredDependencies(pythonExe) {
    if (!await fileExists(pythonExe))
        return false;
    const baseDir = path.dirname(path.dirname(pythonExe));
    const candidateSitePackages = [
        path.join(baseDir, 'Lib', 'site-packages'),
        path.join(baseDir, 'lib', 'site-packages'),
        path.join(path.dirname(pythonExe), 'Lib', 'site-packages')
    ];
    for (const sp of candidateSitePackages) {
        try {
            const entries = await fs.readdir(sp);
            const hasYtDlp = entries.some(e => e.toLowerCase().startsWith('yt_dlp'));
            const hasWhisper = entries.some(e => e.toLowerCase().startsWith('faster_whisper'));
            if (hasYtDlp && hasWhisper) {
                return true;
            }
        }
        catch {
            // ignore
        }
    }
    try {
        const res = await runProcess(pythonExe, ['-c', 'import yt_dlp, faster_whisper'], { timeoutMs: 8000 });
        return res.code === 0;
    }
    catch {
        return false;
    }
}
export async function resolvePython(configPath, pkgRoot) {
    const candidates = [];
    if (configPath) {
        candidates.push(path.resolve(configPath));
    }
    if (pkgRoot) {
        candidates.push(path.join(pkgRoot, '.venv', 'Scripts', 'python.exe'));
        candidates.push(path.join(pkgRoot, '.venv', 'bin', 'python'));
    }
    candidates.push(path.join(process.env.USERPROFILE || 'C:\\Users\\wtqweeqopt', 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.12-windows-x86_64-none', 'python.exe'), path.join(process.env.USERPROFILE || 'C:\\Users\\wtqweeqopt', 'AppData', 'Roaming', 'uv', 'python', 'cpython-3.12.13-windows-x86_64-none', 'python.exe'), path.join(process.env.DSH_HOME || 'C:\\Users\\wtqweeqopt\\.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'), 'python.exe', 'python3');
    for (const c of candidates) {
        if (await hasRequiredDependencies(c)) {
            return c;
        }
    }
    throw new Error(`No viable Python 3.12 environment with required dependencies (yt-dlp, faster-whisper) found among candidates: ${candidates.join(', ')}. Please configure pythonPath with a valid environment or install dependencies.`);
}
export async function resolveBinary(name, pkgRoot) {
    if (pkgRoot) {
        const inBin = path.join(pkgRoot, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
        if (await fileExists(inBin)) {
            return inBin;
        }
    }
    return name;
}
export async function apply(ctx, config = {}) {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgRoot = path.resolve(currentDir, '..');
    const defaultDataDir = path.resolve(pkgRoot, '..', 'video-notes-data');
    const dataDir = config.dataDir ? path.resolve(config.dataDir) : defaultDataDir;
    const pythonExe = await resolvePython(config.pythonPath, pkgRoot);
    const ffmpegExe = await resolveBinary('ffmpeg', pkgRoot);
    const ffprobeExe = await resolveBinary('ffprobe', pkgRoot);
    const transcribeScript = path.join(pkgRoot, 'python', 'transcribe.py');
    const store = new VideoNotesStore(dataDir);
    await store.init();
    const pipeline = new VideoPipeline({
        pythonExe,
        ffmpegExe,
        ffprobeExe,
        transcribeScript,
        store,
        subprocessService: ctx.subprocess,
        whisperModel: config.whisperModel || 'small',
        computeType: config.computeType || 'int8',
        baselineIntervalSec: config.baselineIntervalSec || 10,
        sceneChangeThreshold: config.sceneChangeThreshold || 0.3
    });
    const tools = createTools(pipeline, store, pythonExe, ctx.subprocess);
    const disposers = [];
    for (const t of tools) {
        if (ctx.tools && typeof ctx.tools.register === 'function') {
            const unreg = ctx.tools.register(t);
            if (typeof unreg === 'function') {
                disposers.push(unreg);
            }
        }
    }
    const skillFile = path.join(pkgRoot, 'skills', 'video-analysis', 'SKILL.md');
    try {
        const skillContent = await fs.readFile(skillFile, 'utf-8');
        if (ctx.skills && typeof ctx.skills.register === 'function') {
            const unregSkill = ctx.skills.register({
                name: 'video-analysis',
                description: '获取视频媒体、转写字幕与关键帧画面，进行多模态综合分析并生成结构化复习笔记。',
                whenToUse: '当用户提供视频链接（B站/YouTube/本地视频）、要求总结视频、复习课程内容或提取操作步骤时使用。',
                content: skillContent,
                source: 'runtime',
                invocation: {
                    modelInvocable: true,
                    userInvocable: true
                }
            });
            if (typeof unregSkill === 'function') {
                disposers.push(unregSkill);
            }
        }
    }
    catch (err) {
        // best-effort
    }
    return () => {
        for (const d of disposers) {
            try {
                d();
            }
            catch {
                // ignore
            }
        }
    };
}
//# sourceMappingURL=index.js.map