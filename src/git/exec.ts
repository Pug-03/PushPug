import { execFile } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitOptions {
  /** Path to the git binary. Defaults to `git` on PATH. */
  gitPath?: string;
  /** Kill git after this many ms. Network calls can hang on flaky Wi-Fi. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Written to git's stdin (e.g. for `--stdin-paths`). */
  input?: string;
}

/** Exit codes runGit uses when git itself didn't produce one. */
export const EXIT_TIMEOUT = 124; // killed after timeoutMs (usually a hanging network call)
export const EXIT_OUTPUT_TOO_LARGE = 125; // output exceeded maxBuffer; not a network problem
export const EXIT_NOT_STARTED = 127; // git couldn't be started

let defaultGitPath = 'git';

export function setDefaultGitPath(p: string | undefined): void {
  if (p) defaultGitPath = p;
}

/**
 * Runs git with an argument array (never a shell string), so file names and
 * branch names can never be interpreted as shell syntax.
 */
export function runGit(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...opts.env,
    // Never block waiting for a username/password on a hidden terminal.
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // Stable English messages so stderr can be matched reliably.
    LC_ALL: 'C',
    LANG: 'C',
  };
  return new Promise((resolve) => {
    try {
      const child = execFile(
        opts.gitPath ?? defaultGitPath,
        args,
        { cwd, env, timeout: opts.timeoutMs ?? 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          let code = 0;
          if (error) {
            const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
            if (typeof e.code === 'number') code = e.code;
            else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') code = EXIT_OUTPUT_TOO_LARGE;
            else code = e.killed ? EXIT_TIMEOUT : EXIT_NOT_STARTED;
            if (!stderr && e.message) stderr = e.message;
          }
          const done = () => resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          // Killed for a timeout or too much output: wait until git has really exited, so it no
          // longer holds files (index.lock, or the folder itself on Windows) when we go on.
          if (error && child.exitCode === null && child.signalCode === null) child.once('exit', done);
          else done();
        },
      );
      if (opts.input !== undefined) {
        // git may exit before reading everything (e.g. on a bad path); ignore EPIPE.
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(opts.input);
      }
    } catch (e) {
      // Spawning can throw synchronously (E2BIG for a huge argument list,
      // a NUL byte in an argument…): report it as a failed run, never reject.
      resolve({ code: EXIT_NOT_STARTED, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
    }
  });
}

/** Like runGit but throws on a non-zero exit code. */
export async function git(cwd: string, args: string[], opts?: GitOptions): Promise<string> {
  const r = await runGit(cwd, args, opts);
  if (r.code !== 0) throw new GitError(args, r);
  return r.stdout;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args[0]} failed (${result.code}): ${result.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
}

export function splitZ(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}
