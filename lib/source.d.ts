import { VideoSourceType, ScopeMode, InspectResult } from './types.js';
export interface ResolveSourceOptions {
    pythonExe: string;
    scope?: ScopeMode;
    signal?: AbortSignal;
    subprocessService?: any;
}
export declare function detectSourceType(input: string): VideoSourceType;
export declare function generateLocalStableId(absPath: string): string;
export declare function inspectSource(input: string, options: ResolveSourceOptions): Promise<InspectResult>;
//# sourceMappingURL=source.d.ts.map