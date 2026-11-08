import { VideoFrameEvidence } from './types.js';
export interface MediaProbeInfo {
    duration: number;
    width: number;
    height: number;
    fps: number;
    audioTracks: Array<{
        index: number;
        codec: string;
        channels: number;
        sampleRate: number;
    }>;
}
export declare function probeMedia(ffprobeExe: string, videoPath: string, options?: {
    signal?: AbortSignal;
    subprocessService?: any;
}): Promise<MediaProbeInfo>;
export declare function extractAudioWav(ffmpegExe: string, videoPath: string, outputPath: string, options?: {
    trackIndex?: number;
    signal?: AbortSignal;
    subprocessService?: any;
}): Promise<string>;
export declare function extractKeyframes(ffmpegExe: string, ffprobeExe: string, videoPath: string, outputDir: string, options?: {
    baselineIntervalSec?: number;
    sceneChangeThreshold?: number;
    signal?: AbortSignal;
    subprocessService?: any;
}): Promise<VideoFrameEvidence[]>;
//# sourceMappingURL=media.d.ts.map