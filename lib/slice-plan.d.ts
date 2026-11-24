import { VideoNotesStore } from './store.js';
export interface SliceManifestEntry {
    index: number;
    startSec: number;
    endSec: number;
    rangeLabel: string;
    segmentCount: number;
    frameCount: number;
    manifestPath: string;
}
export interface SlicePlanResult {
    entryId: string;
    title: string;
    totalDuration: number;
    sliceDurationSec: number;
    totalSegments: number;
    totalFrames: number;
    sliceCount: number;
    slicesDir: string;
    indexPath: string;
    slices: SliceManifestEntry[];
}
export declare function planEpisodeSlices(store: VideoNotesStore, entryId: string, options?: {
    durationSec?: number;
    outDir?: string;
}): Promise<SlicePlanResult>;
export declare function formatSlicePlanSummary(plan: SlicePlanResult, maxListedSlices?: number): string;
//# sourceMappingURL=slice-plan.d.ts.map