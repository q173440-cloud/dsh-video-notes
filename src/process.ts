import { spawn as nodeSpawn, ChildProcess } from 'child_process';
import { promises as fs, openSync, closeSync, readFileSync, unlinkSync } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

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

export function runProcess(
  executable: string,
  args: string[],
  options: RunProcessOptions = {}
): Promise<RunProcessResult> {
  // 1. 若当前环境中注册有 DSH host 的 subprocess 服务，优先调用该服务规避沙箱限制
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
          handle.stdout.on('data', (d: Buffer) => {
            const text = d.toString('utf8');
            stdoutData += text;
            if (options.onStdoutLine) options.onStdoutLine(text);
          });
        }
        if (handle.stderr) {
          handle.stderr.on('data', (d: Buffer) => {
            const text = d.toString('utf8');
            stderrData += text;
            if (options.onStderrLine) options.onStderrLine(text);
          });
        }

        handle.done.then((outcome: any) => {
          resolve({
            code: outcome.exitCode,
            signal: outcome.signal ? String(outcome.signal) : null,
            stdout: stdoutData,
            stderr: stderrData
          });
        }).catch((err: any) => reject(new Error(`Failed to execute '${executable}' via subprocessService: ${err?.message || err}`)));
      } catch (err: any) {
        reject(new Error(`Exception calling subprocessService.spawn for '${executable}': ${err?.message || err}`));
      }
    });
  }

  // 2. 在 Windows 沙箱环境下，普通进程无法创建命名管道（stdio: 'pipe' 会直接抛出 spawn EPERM）。
  // 因此使用基于系统临时文件重定向的强兼容 fallback 执行通道。
  return new Promise((resolve, reject) => {
    // 首先尝试原生 pipe，若因 EPERM 失败则无缝 fallback 到临时文件重定向
    try {
      let stdoutData = '';
      let stderrData = '';
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const child: ChildProcess = nodeSpawn(executable, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let timer: NodeJS.Timeout | undefined;
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
        child.stdout.on('data', (chunk: Buffer) => {
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
        child.stderr.on('data', (chunk: Buffer) => {
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

      child.on('error', (err: any) => {
        if (timer) clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abortHandler);
        
        // 关键拦截：若是 Windows 下的 EPERM，转入临时文件通道
        if (err?.code === 'EPERM' || String(err?.message).includes('EPERM')) {
          runWithFileRedirect(executable, args, options).then(resolve, reject);
        } else {
          reject(new Error(`Failed to execute '${executable}' via nodeSpawn: ${err?.message || err}`));
        }
      });

      child.on('close', (code, sig) => {
        if (timer) clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abortHandler);

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
    } catch (err: any) {
      if (err?.code === 'EPERM' || String(err?.message).includes('EPERM')) {
        runWithFileRedirect(executable, args, options).then(resolve, reject);
      } else {
        reject(err);
      }
    }
  });
}

function runWithFileRedirect(
  executable: string,
  args: string[],
  options: RunProcessOptions
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const randomId = crypto.randomBytes(6).toString('hex');
    const outPath = path.join(os.tmpdir(), `dsh_proc_${randomId}.out.log`);
    const errPath = path.join(os.tmpdir(), `dsh_proc_${randomId}.err.log`);

    let outFd: number | null = null;
    let errFd: number | null = null;

    try {
      outFd = openSync(outPath, 'w');
      errFd = openSync(errPath, 'w');

      const child: ChildProcess = nodeSpawn(executable, args, {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
        stdio: ['ignore', outFd, errFd]
      });

      let timer: NodeJS.Timeout | undefined;
      if (options.timeoutMs && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          killProcessTree(child);
          cleanup();
          reject(new Error(`Process timed out after ${options.timeoutMs}ms (file redirect): ${executable}`));
        }, options.timeoutMs);
      }

      const abortHandler = () => {
        killProcessTree(child);
        cleanup();
        reject(new Error(`Process aborted by signal (file redirect): ${executable}`));
      };

      if (options.signal) {
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      function cleanup() {
        if (outFd !== null) {
          try { closeSync(outFd); } catch {}
          outFd = null;
        }
        if (errFd !== null) {
          try { closeSync(errFd); } catch {}
          errFd = null;
        }
      }

      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abortHandler);
        cleanup();
        reject(new Error(`Failed to execute '${executable}' via file redirect: ${err?.message || err}`));
      });

      child.on('close', (code, sig) => {
        if (timer) clearTimeout(timer);
        if (options.signal) options.signal.removeEventListener('abort', abortHandler);
        cleanup();

        let stdout = '';
        let stderr = '';
        try {
          stdout = readFileSync(outPath, 'utf8');
          unlinkSync(outPath);
        } catch {}
        try {
          stderr = readFileSync(errPath, 'utf8');
          unlinkSync(errPath);
        } catch {}

        if (options.onStdoutLine && stdout) {
          for (const line of stdout.split('\n')) {
            options.onStdoutLine(line);
          }
        }
        if (options.onStderrLine && stderr) {
          for (const line of stderr.split('\n')) {
            options.onStderrLine(line);
          }
        }

        resolve({
          code,
          signal: sig ? String(sig) : null,
          stdout,
          stderr
        });
      });
    } catch (err) {
      if (outFd !== null) { try { closeSync(outFd); } catch {} }
      if (errFd !== null) { try { closeSync(errFd); } catch {} }
      try { unlinkSync(outPath); } catch {}
      try { unlinkSync(errPath); } catch {}
      reject(err);
    }
  });
}

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // best-effort cleanup
  }
}
