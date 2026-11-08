import { promises as fs } from 'fs';
import path from 'path';
import { ItemStatus, VideoItemSummary, SaveNoteInput, SaveNoteResult } from './types.js';
import { normalizeSegments } from './transcript.js';

export interface EpisodePaths {
  episodeDir: string;
  sourceJson: string;
  transcriptJson: string;
  transcriptSrt: string;
  framesDir: string;
  noteMd: string;
  workDir: string;
}

export function decodeJpegDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) {
    throw new Error('Not a JPEG file: missing SOI marker (0xFFD8)');
  }
  let eoiFound = false;
  for (let i = buf.length - 2; i >= 0; i--) {
    if (buf[i] === 0xFF && buf[i + 1] === 0xD9) {
      eoiFound = true;
      break;
    }
  }
  if (!eoiFound) {
    throw new Error('Corrupt or truncated JPEG: missing EOI marker (0xFFD9)');
  }

  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xFF) {
      throw new Error(`Corrupt JPEG stream: expected marker prefix 0xFF at offset ${offset}`);
    }
    const marker = buf[offset + 1];
    offset += 2;
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7)) {
      continue;
    }
    if (offset + 2 > buf.length) break;
    const len = buf.readUInt16BE(offset);
    if (marker === 0xC0 || marker === 0xC2) {
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      return { width, height };
    }
    offset += len;
  }
  throw new Error('JPEG validation failed: missing valid SOF marker (width/height not decodable)');
}

export class VideoNotesStore {
  readonly baseDataDir: string;

  constructor(baseDataDir: string) {
    this.baseDataDir = path.resolve(baseDataDir);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.baseDataDir, { recursive: true });
    await fs.mkdir(path.join(this.baseDataDir, 'episodes'), { recursive: true });
    await fs.mkdir(path.join(this.baseDataDir, 'collections'), { recursive: true });
  }

  getEpisodePaths(entryId: string): EpisodePaths {
    const safeId = entryId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const episodeDir = path.join(this.baseDataDir, 'episodes', safeId);
    return {
      episodeDir,
      sourceJson: path.join(episodeDir, 'source.json'),
      transcriptJson: path.join(episodeDir, 'transcript.json'),
      transcriptSrt: path.join(episodeDir, 'transcript.srt'),
      framesDir: path.join(episodeDir, 'frames'),
      noteMd: path.join(episodeDir, 'note.md'),
      workDir: path.join(episodeDir, 'work')
    };
  }

  async hasPreparedArtifacts(entryId: string): Promise<boolean> {
    const paths = this.getEpisodePaths(entryId);
    try {
      const sStat = await fs.stat(paths.sourceJson).catch(() => null);
      const tStat = await fs.stat(paths.transcriptJson).catch(() => null);
      const mStat = await fs.stat(path.join(paths.framesDir, 'metadata.json')).catch(() => null);
      if (!sStat || !tStat || !mStat) return false;

      const rawT = JSON.parse(await fs.readFile(paths.transcriptJson, 'utf-8'));
      const segs = normalizeSegments(rawT);
      const rawM = JSON.parse(await fs.readFile(path.join(paths.framesDir, 'metadata.json'), 'utf-8'));
      return segs.length > 0 && Array.isArray(rawM) && rawM.length > 0;
    } catch {
      return false;
    }
  }

  async getEpisodeSource(entryId: string): Promise<Record<string, any>> {
    const paths = this.getEpisodePaths(entryId);
    return JSON.parse(await fs.readFile(paths.sourceJson, 'utf-8'));
  }

  async saveEpisodeSource(entryId: string, sourceData: Record<string, unknown>): Promise<void> {
    const paths = this.getEpisodePaths(entryId);
    await fs.mkdir(paths.episodeDir, { recursive: true });
    await fs.writeFile(paths.sourceJson, JSON.stringify(sourceData, null, 2), 'utf-8');
  }

  async saveNote(input: SaveNoteInput): Promise<SaveNoteResult> {
    if (!input.entryId || typeof input.entryId !== 'string') {
      throw new Error('Valid entryId is required to save note');
    }

    const trimmedContent = (input.contentMarkdown || '').trim();
    const paths = this.getEpisodePaths(input.entryId);

    // 核心物理产物与业务状态强校验
    if (input.status === 'completed') {
      // 1. 内容实质校验
      if (trimmedContent.length < 150) {
        throw new Error(
          `Cannot mark note as 'completed': content is too short (${trimmedContent.length} chars, minimum 150 required)`
        );
      }
      if (!trimmedContent.includes('# ') || !trimmedContent.includes('## ')) {
        throw new Error("Cannot mark note as 'completed': missing essential markdown section headings (# and ##)");
      }

      // 2. 检查 source.json 实质内容
      let sourceData: any;
      try {
        sourceData = JSON.parse(await fs.readFile(paths.sourceJson, 'utf-8'));
      } catch {
        throw new Error(`Cannot mark note as 'completed': missing or invalid source.json for entry '${input.entryId}'`);
      }
      if (!sourceData.title || typeof sourceData.duration !== 'number' || sourceData.duration <= 0) {
        throw new Error(`Cannot mark note as 'completed': source.json metadata is incomplete (duration must be > 0)`);
      }

      // 3. 检查 transcript.json 实质内容
      let segments: any[];
      try {
        const rawT = JSON.parse(await fs.readFile(paths.transcriptJson, 'utf-8'));
        segments = normalizeSegments(rawT);
      } catch (err: any) {
        throw new Error(`Cannot mark note as 'completed': transcript verification failed: ${err.message}`);
      }
      if (segments.length === 0) {
        throw new Error(`Cannot mark note as 'completed': transcript contains 0 segments`);
      }
      for (const seg of segments.slice(0, 5)) {
        if (seg.start < 0 || seg.end <= seg.start || !seg.text) {
          throw new Error(`Cannot mark note as 'completed': transcript has invalid segment timestamps [${seg.start}, ${seg.end}]`);
        }
      }

      // 4. 检查 frames/metadata.json 与真实图像证据的真实可解码性
      const metaFile = path.join(paths.framesDir, 'metadata.json');
      let frameMeta: any[];
      try {
        frameMeta = JSON.parse(await fs.readFile(metaFile, 'utf-8'));
        if (!Array.isArray(frameMeta) || frameMeta.length === 0) {
          throw new Error('metadata.json is empty');
        }
      } catch {
        throw new Error(`Cannot mark note as 'completed': missing or invalid frames/metadata.json for entry '${input.entryId}'`);
      }

      // 抽查首张截图文件的真实性：必须为真正可解码的 JPEG 图像
      const sampleFrame = frameMeta[0];
      const framePath = sampleFrame.path || path.join(paths.framesDir, sampleFrame.filename);
      const frameBuf = await fs.readFile(framePath).catch(() => null);
      if (!frameBuf || frameBuf.length < 1024) {
        throw new Error(`Cannot mark note as 'completed': frame image '${framePath}' is missing or too small (${frameBuf?.length ?? 0} bytes)`);
      }
      try {
        decodeJpegDimensions(frameBuf);
      } catch (err: any) {
        throw new Error(`Cannot mark note as 'completed': frame image '${framePath}' failed JPEG decode validation: ${err.message}`);
      }

      // 5. 校验阻断性缺口
      if (input.gaps && input.gaps.some(g => g.includes('阻断') || g.includes('严重缺失') || g.includes('处理失败'))) {
        throw new Error("Cannot mark note as 'completed': unresolved critical gaps present; note must be marked 'partial'");
      }

      // 6. 核心事实回查与来源区隔核验（针对正式完整笔记）
      // 如果笔记较长（> 500字）且包含操作内容，要求包含精确时间戳与关键帧证据引用
      if (trimmedContent.length > 500) {
        const timestampMatches = trimmedContent.match(/\b\d{1,2}:\d{2}\b/g);
        if (!timestampMatches || timestampMatches.length < 2) {
          throw new Error("Cannot mark note as 'completed': note must contain explicit timestamps ([MM:SS]) for verifiable recall");
        }

        const hasFrameEvidence = /\b(帧|关键帧|frame_pts|frame_)/i.test(trimmedContent);
        if (!hasFrameEvidence) {
          throw new Error("Cannot mark note as 'completed': note must reference concrete visual keyframe evidence ([关键帧: ...])");
        }

        // 必须明确区分主观观点或推断，不能伪装为客观事实
        const hasSourceDistinction = trimmedContent.includes('观点') || trimmedContent.includes('评价') || trimmedContent.includes('主观');
        if (!hasSourceDistinction) {
          throw new Error("Cannot mark note as 'completed': note must explicitly distinguish author opinions/ratings from factual steps");
        }
      }

    } else if (input.status === 'partial') {
      if (trimmedContent.length === 0) {
        throw new Error("Cannot save empty note even under 'partial' status");
      }
    } else {
      throw new Error(`Invalid status: ${input.status}, expected 'completed' or 'partial'`);
    }

    await fs.mkdir(paths.episodeDir, { recursive: true });

    let content = trimmedContent;
    if (input.gaps && input.gaps.length > 0 && !content.includes('已知缺口')) {
      content += '\n\n## 已知缺口与待回看内容\n';
      for (const g of input.gaps) {
        content += `- ⚠️ ${g}\n`;
      }
    }

    if (input.aiNotes && !content.includes('AI 补充解释')) {
      content += '\n\n## AI 补充解释（背景拓展与术语说明）\n';
      content += input.aiNotes.trim() + '\n';
    }

    // 原子写入笔记
    const tmpNote = paths.noteMd + '.tmp';
    await fs.writeFile(tmpNote, content, 'utf-8');
    await fs.rename(tmpNote, paths.noteMd);

    const stat = await fs.stat(paths.noteMd);

    // 核心安全清理规则：只有 completed 且全部真实物理产物核验通过后，才清理 workDir
    let cleanedWorkDir = false;
    if (input.status === 'completed') {
      try {
        const workExists = await fs.stat(paths.workDir).then(() => true).catch(() => false);
        if (workExists) {
          if (paths.workDir.startsWith(this.baseDataDir) && paths.workDir.endsWith('work')) {
            await fs.rm(paths.workDir, { recursive: true, force: true });
            cleanedWorkDir = true;
          }
        }
      } catch {
        // best-effort
      }
    }

    return {
      entryId: input.entryId,
      notePath: paths.noteMd,
      status: input.status,
      bytes: stat.size,
      cleanedWorkDir,
      message: input.status === 'completed'
        ? `完整笔记已保存至 ${paths.noteMd} (${stat.size} 字节)，临时工作媒体已清理。`
        : `部分笔记已保存至 ${paths.noteMd} (${stat.size} 字节)，恢复素材与临时媒体已完整保留。`
    };
  }
}
