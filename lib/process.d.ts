import { ChildProcess } from 'child_process';
export interface RunProcessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
    subprocessService?: any;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
}
export interface RunProcessResult {
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
}
export declare function runProcess(executable: string, args: string[], options?: RunProcessOptions): Promise<RunProcessResult>;
export declare function killProcessTree(child: ChildProcess): void;
//# sourceMappingURL=process.d.ts.map