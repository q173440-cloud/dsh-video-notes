import { PluginConfig } from './types.js';
export declare const name = "dsh-video-notes";
export declare const inject: string[];
export declare function hasRequiredDependencies(pythonExe: string): Promise<boolean>;
export declare function resolvePython(configPath?: string, pkgRoot?: string): Promise<string>;
export declare function resolveBinary(name: string, pkgRoot?: string): Promise<string>;
export declare function apply(ctx: any, config?: PluginConfig): Promise<() => void>;
//# sourceMappingURL=index.d.ts.map