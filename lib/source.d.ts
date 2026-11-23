import { VideoSourceType, ScopeMode, InspectResult } from './types.js';
export interface ResolveSourceOptions {
    pythonExe: string;
    scope?: ScopeMode;
    cookies?: string;
    dataDir?: string;
    ffprobeExe?: string;
    signal?: AbortSignal;
    subprocessService?: any;
}
export declare function extractUrlFromInput(input: string): string | undefined;
export declare function normalizeInputUrl(input: string): string;
export declare function detectSourceType(input: string): VideoSourceType;
export declare function generateLocalStableId(absPath: string): string;
export declare function getYtDlpExtraArgs(sourceType: VideoSourceType): string[];
export declare function inspectSource(input: string, options: ResolveSourceOptions): Promise<InspectResult>;
//# sourceMappingURL=source.d.ts.map