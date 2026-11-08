import { TranscriptSegment } from './types.js';
export interface CorrectionEntry {
    id: number | string;
    timestamp: string;
    rawText: string;
    correctedText: string;
    notes?: string;
}
export declare function normalizeSegments(data: unknown): TranscriptSegment[];
export declare function extractCorrections(segments: TranscriptSegment[]): CorrectionEntry[];
export declare function formatSrtTime(seconds: number): string;
export declare function exportToSrt(segments: TranscriptSegment[]): string;
export declare function saveTranscripts(segments: unknown, outputJsonPath: string, outputSrtPath: string): Promise<TranscriptSegment[]>;
export declare function sliceSegments(rawSegments: unknown, startSec: number, endSec: number): TranscriptSegment[];
//# sourceMappingURL=transcript.d.ts.map