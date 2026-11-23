import { promises as fs } from 'fs';
import path from 'path';
import { TranscriptSegment } from './types.js';

export interface CorrectionEntry {
  id: number | string;
  timestamp: string;
  rawText: string;
  correctedText: string;
  notes?: string;
}

export function normalizeSegments(data: unknown): TranscriptSegment[] {
  if (!data) {
    throw new Error('Transcript data is null or undefined');
  }

  let list: unknown[] | undefined;
  if (Array.isArray(data)) {
    list = data;
  } else if (typeof data === 'object' && data !== null && 'segments' in data && Array.isArray((data as any).segments)) {
    list = (data as any).segments;
  }

  if (!list) {
    throw new Error(`Invalid transcript format: expected Array or object with .segments array, got ${typeof data}`);
  }

  return list.map((item: any, idx: number) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`Invalid segment at index ${idx}: expected object`);
    }
    const start = Number(item.start);
    const end = Number(item.end);
    const text = String(item.text ?? '').trim();
    if (isNaN(start) || isNaN(end)) {
      throw new Error(`Invalid segment timestamps at index ${idx}: start=${item.start}, end=${item.end}`);
    }
    return {
      id: item.id ?? idx + 1,
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      text,
      rawText: item.rawText ? String(item.rawText).trim() : undefined,
      correctedText: item.correctedText ? String(item.correctedText).trim() : undefined,
      correctionNotes: item.correctionNotes ? String(item.correctionNotes).trim() : undefined,
      source: item.source || 'local-asr'
    };
  });
}

export function extractCorrections(segments: TranscriptSegment[]): CorrectionEntry[] {
  const result: CorrectionEntry[] = [];
  for (const seg of segments) {
    if (seg.correctedText && seg.correctedText !== (seg.rawText || seg.text)) {
      const min = Math.floor(seg.start / 60);
      const sec = Math.floor(seg.start % 60);
      result.push({
        id: seg.id,
        timestamp: `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`,
        rawText: seg.rawText || seg.text,
        correctedText: seg.correctedText,
        notes: seg.correctionNotes
      });
    }
  }
  return result;
}

export function formatSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

export function exportToSrt(segments: TranscriptSegment[]): string {
  return segments.map((seg, idx) => {
    return `${idx + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}\n`;
  }).join('\n');
}

export async function saveTranscripts(
  segments: unknown,
  outputJsonPath: string,
  outputSrtPath: string
): Promise<TranscriptSegment[]> {
  const normalized = normalizeSegments(segments);
  await fs.mkdir(path.dirname(outputJsonPath), { recursive: true });
  await fs.writeFile(outputJsonPath, JSON.stringify(normalized, null, 2), 'utf-8');

  const srtContent = exportToSrt(normalized);
  await fs.writeFile(outputSrtPath, srtContent, 'utf-8');
  return normalized;
}

export function sliceSegments(
  rawSegments: unknown,
  startSec: number,
  endSec: number
): TranscriptSegment[] {
  const segments = normalizeSegments(rawSegments);
  return segments.filter(seg => {
    return seg.end > startSec && seg.start < endSec;
  });
}

function parseSubtitleTimestamp(raw: string): number | null {
  const cleaned = raw.trim().replace(',', '.');
  const parts = cleaned.split(':');
  if (parts.length === 3) {
    const h = Number(parts[0]);
    const m = Number(parts[1]);
    const s = Number(parts[2]);
    if (!Number.isNaN(h) && !Number.isNaN(m) && !Number.isNaN(s)) {
      return h * 3600 + m * 60 + s;
    }
  } else if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (!Number.isNaN(m) && !Number.isNaN(s)) {
      return m * 60 + s;
    }
  }
  return null;
}

function cleanSubtitleText(lines: string[]): string {
  return lines
    .join(' ')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseSubtitleContent(
  content: string,
  source: 'platform-manual' | 'platform-auto'
): TranscriptSegment[] {
  const blocks = content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  const parsed: TranscriptSegment[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const head = lines[0];
    if (
      head.startsWith('WEBVTT') ||
      head.startsWith('NOTE') ||
      head.startsWith('STYLE') ||
      head.startsWith('REGION')
    ) {
      continue;
    }

    const timeLineIdx = lines.findIndex(l => l.includes('-->'));
    if (timeLineIdx < 0) continue;

    const timeLine = lines[timeLineIdx];
    const [rawStart, rawEndPart] = timeLine.split('-->');
    if (!rawStart || !rawEndPart) continue;

    const rawEnd = rawEndPart.trim().split(/\s+/)[0];
    const start = parseSubtitleTimestamp(rawStart);
    const end = parseSubtitleTimestamp(rawEnd);
    if (start === null || end === null || start < 0 || end <= start) continue;

    const text = cleanSubtitleText(lines.slice(timeLineIdx + 1));
    if (!text) continue;

    const roundedStart = Math.round(start * 1000) / 1000;
    const roundedEnd = Math.round(end * 1000) / 1000;
    if (roundedEnd <= roundedStart) continue;

    const prev = parsed[parsed.length - 1];
    if (prev && prev.text === text && roundedStart <= prev.end + 0.5) {
      prev.end = Math.max(prev.end, roundedEnd);
      continue;
    }

    parsed.push({
      id: parsed.length + 1,
      start: roundedStart,
      end: roundedEnd,
      text,
      source
    });
  }

  return parsed;
}
