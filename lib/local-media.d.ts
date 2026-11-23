export type MatchReason = 'vid-tag' | 'name-prefix' | 'unique-pair';
export interface LocalMediaTarget {
    inputPath: string;
    videoPath: string;
    companionAudioPath?: string;
    displayTitle: string;
    matchReason?: MatchReason;
    duration?: number;
}
export declare function resolveLocalTarget(inputPath: string, ffprobeExe: string, opts?: {
    signal?: AbortSignal;
    subprocessService?: any;
}): Promise<LocalMediaTarget>;
export declare function remuxVideoAndAudio(ffmpegExe: string, videoPath: string, audioPath: string, outputPath: string, opts?: {
    signal?: AbortSignal;
    subprocessService?: any;
}): Promise<string>;
//# sourceMappingURL=local-media.d.ts.map