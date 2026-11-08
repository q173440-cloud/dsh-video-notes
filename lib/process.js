import { spawn as nodeSpawn } from 'child_process';
export function runProcess(executable, args, options = {}) {
    // 若当前环境中注册有 DSH host 的 subprocess 服务，优先调用该服务规避沙箱限制
    if (options.subprocessService && typeof options.subprocessService.spawn === 'function') {
        return new Promise((resolve, reject) => {
            try {
                let stdoutData = '';
                let stderrData = '';
                const handle = options.subprocessService.spawn({
                    argv: [executable, ...args],
                    cwd: options.cwd || process.cwd(),
                    stdio: {
                        stdin: 'ignore',
                        stdout: 'pipe',
                        stderr: 'pipe'
                    },
                    graceMs: 3000,
                    signal: options.signal,
                    env: { ...process.env, ...options.env }
                });
                if (handle.stdout) {
                    handle.stdout.on('data', (d) => {
                        const text = d.toString('utf8');
                        stdoutData += text;
                        if (options.onStdoutLine)
                            options.onStdoutLine(text);
                    });
                }
                if (handle.stderr) {
                    handle.stderr.on('data', (d) => {
                        const text = d.toString('utf8');
                        stderrData += text;
                        if (options.onStderrLine)
                            options.onStderrLine(text);
                    });
                }
                handle.done.then((outcome) => {
                    resolve({
                        code: outcome.exitCode,
                        signal: outcome.signal ? String(outcome.signal) : null,
                        stdout: stdoutData,
                        stderr: stderrData
                    });
                }).catch((err) => reject(new Error(`Failed to execute '${executable}' via subprocessService: ${err?.message || err}`)));
            }
            catch (err) {
                reject(new Error(`Exception calling subprocessService.spawn for '${executable}': ${err?.message || err}`));
            }
        });
    }
    // 默认使用 Node 标准库 spawn
    return new Promise((resolve, reject) => {
        let stdoutData = '';
        let stderrData = '';
        let stdoutBuffer = '';
        let stderrBuffer = '';
        const child = nodeSpawn(executable, args, {
            cwd: options.cwd,
            env: { ...process.env, ...options.env },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let timer;
        if (options.timeoutMs && options.timeoutMs > 0) {
            timer = setTimeout(() => {
                killProcessTree(child);
                reject(new Error(`Process timed out after ${options.timeoutMs}ms: ${executable} ${args.join(' ')}`));
            }, options.timeoutMs);
        }
        const abortHandler = () => {
            killProcessTree(child);
            reject(new Error(`Process aborted by signal: ${executable}`));
        };
        if (options.signal) {
            if (options.signal.aborted) {
                killProcessTree(child);
                return reject(new Error(`Process aborted before starting: ${executable}`));
            }
            options.signal.addEventListener('abort', abortHandler, { once: true });
        }
        if (child.stdout) {
            child.stdout.on('data', (chunk) => {
                const text = chunk.toString('utf8');
                stdoutData += text;
                if (options.onStdoutLine) {
                    stdoutBuffer += text;
                    const lines = stdoutBuffer.split('\n');
                    stdoutBuffer = lines.pop() || '';
                    for (const line of lines) {
                        options.onStdoutLine(line);
                    }
                }
            });
        }
        if (child.stderr) {
            child.stderr.on('data', (chunk) => {
                const text = chunk.toString('utf8');
                stderrData += text;
                if (options.onStderrLine) {
                    stderrBuffer += text;
                    const lines = stderrBuffer.split('\n');
                    stderrBuffer = lines.pop() || '';
                    for (const line of lines) {
                        options.onStderrLine(line);
                    }
                }
            });
        }
        child.on('error', (err) => {
            if (timer)
                clearTimeout(timer);
            if (options.signal)
                options.signal.removeEventListener('abort', abortHandler);
            reject(new Error(`Failed to execute '${executable}' via nodeSpawn: ${err?.message || err}`));
        });
        child.on('close', (code, sig) => {
            if (timer)
                clearTimeout(timer);
            if (options.signal)
                options.signal.removeEventListener('abort', abortHandler);
            if (options.onStdoutLine && stdoutBuffer.length > 0) {
                options.onStdoutLine(stdoutBuffer);
            }
            if (options.onStderrLine && stderrBuffer.length > 0) {
                options.onStderrLine(stderrBuffer);
            }
            resolve({
                code,
                signal: sig ? String(sig) : null,
                stdout: stdoutData,
                stderr: stderrData
            });
        });
    });
}
export function killProcessTree(child) {
    if (!child.pid)
        return;
    try {
        if (process.platform === 'win32') {
            nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        }
        else {
            child.kill('SIGTERM');
        }
    }
    catch {
        // best-effort cleanup
    }
}
//# sourceMappingURL=process.js.map