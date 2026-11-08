import { VideoNotesStore } from './store.js';
import { PrepareResult, SliceResult } from './types.js';
export interface PipelineOptions {
    pythonExe: string;
    ffmpegExe: string;
    ffprobeExe: string;
    transcribeScript: string;
    store: VideoNotesStore;
    subprocessService?: any;
    whisperModel?: string;
    computeType?: string;
    baselineIntervalSec?: number;
    sceneChangeThreshold?: number;
}
export interface PrepareOptions {
    signal?: AbortSignal;
    forceRebuild?: boolean;
}
export declare class VideoPipeline {
    readonly options: PipelineOptions;
    constructor(options: PipelineOptions);
    prepareEpisode(inputUrlOrPath: string, entryId: string, signalOrOptions?: AbortSignal | PrepareOptions): Promise<PrepareResult>;
    readSlice(entryId: string, startTimeSec: number, durationSec: number): Promise<SliceResult>;
}
//# sourceMappingURL=pipeline.d.ts.map