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
