// Task branches for the pull request workflow: start a branch from the latest
// main, move commits made on main by mistake onto a branch, push a branch,
// and go back to main once the pull request is merged. No `vscode` import;
// tested against real repos.
import { runGit, type GitOptions } from './exec';
import { currentBranch, remoteOfBranch, revParse, commitsBetween, getConflictState, classifyError, type Commit, type ErrorCode } from './repo';

export interface TaskBase {
  /** Remote the pull requests go to, usually "origin". */
  remote: string;
  /** The team's main branch on that remote, e.g. "main". */
  base: string;
  /** Remote-tracking ref of the main branch, e.g. "origin/main". */
  baseRef: string;
}

/** The current branch's remote, else "origin", else the first remote. */
export async function primaryRemote(root: string, opts?: GitOptions): Promise<string | null> {
  const branch = await currentBranch(root, opts);
  const tracked = branch ? await remoteOfBranch(root, branch, opts) : null;
  if (tracked) return tracked;
  const r = await runGit(root, ['remote'], opts);
  const remotes = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

/** The remote's default branch: `<remote>/HEAD`, else main / master. */
export async function defaultBranch(root: string, remote: string, opts?: GitOptions): Promise<string | null> {
  const r = await runGit(root, ['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`], opts);
  const head = r.stdout.trim();
  if (r.code === 0 && head.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  for (const name of ['main', 'master']) {
    if (await revParse(root, `refs/remotes/${remote}/${name}`, opts)) return name;
  }
  return null;
}

export async function taskBase(root: string, opts?: GitOptions): Promise<TaskBase | null> {
  const remote = await primaryRemote(root, opts);
  if (!remote) return null;
  const base = await defaultBranch(root, remote, opts);
  return base ? { remote, base, baseRef: `${remote}/${base}` } : null;
}

/** "Fix login page" → "task/fix-login-page"; Thai letters are kept. */
export function suggestBranchName(text: string, now = new Date()): string {
  const slug = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  if (slug) return `task/${slug}`;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `task/${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/**
 * suggestBranchName plus a free name in this repo: "task/fix-login", else
 * "task/fix-login-2", -3…; if a branch called "task" blocks every "task/…"
 * name, the same with "task-fix-login".
 */
export async function availableBranchName(root: string, text: string, opts?: GitOptions): Promise<string> {
  let base = suggestBranchName(text);
  let name = base;
  for (let i = 2; i < 1000; i++) {
    const check = await checkBranchName(root, name, opts);
    if (check === 'blocked' && base.startsWith('task/')) {
      base = `task-${base.slice('task/'.length)}`;
      name = base;
      i = 1;
      continue;
    }
    if (check !== 'exists') return name;
    name = `${base}-${i}`;
  }
  return name;
}

/**
 * exists  – a branch with this name, or one under it ("name/…"), exists:
 *           adding a suffix ("name-2") fixes it
 * blocked – a branch named like one of its parent folders exists ("task"
 *           blocks "task/fix-login"): no suffix can fix it
 */
export type NameCheck = 'ok' | 'invalid' | 'exists' | 'blocked';

export async function checkBranchName(root: string, name: string, opts?: GitOptions): Promise<NameCheck> {
  if (!name.trim() || /\s/.test(name)) return 'invalid';
  const r = await runGit(root, ['check-ref-format', '--branch', name], opts);
  if (r.code !== 0) return 'invalid';
  if (await revParse(root, `refs/heads/${name}`, opts)) return 'exists';
  const under = await runGit(root, ['for-each-ref', '--count=1', '--format=x', `refs/heads/${name}/`], opts);
  if (under.stdout.trim()) return 'exists';
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    if (await revParse(root, `refs/heads/${parts.slice(0, i).join('/')}`, opts)) return 'blocked';
  }
  return 'ok';
}

/** For BranchResult: a blocked name is reported like a taken one. */
function nameProblem(check: Exclude<NameCheck, 'ok'>): BranchResult {
  return { kind: check === 'blocked' ? 'exists' : check };
}

/** Commits on HEAD that the main branch doesn't have yet (newest first). */
export async function commitsNotOnBase(root: string, baseRef: string, opts?: GitOptions): Promise<Commit[]> {
  if (!(await revParse(root, baseRef, opts))) return [];
  return commitsBetween(root, `${baseRef}..HEAD`, 50, opts).catch(() => []);
}

export type BranchResult =
  | { kind: 'ok'; branch: string }
  | { kind: 'invalid' }
  | { kind: 'exists' }
  | { kind: 'noBase' }
  | { kind: 'conflict' }
  | { kind: 'localChanges'; files: string[] }
  | { kind: 'error'; code: ErrorCode; message: string };

function filesFromLocalChangesError(output: string): string[] {
  const m = output.match(/would be overwritten by (?:checkout|merge):\n([\s\S]*?)\n(?:Please|Aborting)/);
  return m ? m[1].split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

function failure(output: string, code: number): BranchResult {
  const files = filesFromLocalChangesError(output);
  if (files.length) return { kind: 'localChanges', files };
  return { kind: 'error', code: code === 124 ? 'network' : classifyError(output), message: output.trim() };
}

export async function fetchBase(root: string, base: TaskBase, opts?: GitOptions): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }> {
  const r = await runGit(root, ['fetch', '--quiet', base.remote], { timeoutMs: 90_000, ...opts });
  if (r.code === 0) return { ok: true };
  return { ok: false, code: r.code === 124 ? 'network' : classifyError(r.stderr), message: r.stderr.trim() };
}

/**
 * "Start a new task": fetch, then a new branch from the latest main. Uncommitted
 * work comes along (git refuses, and nothing changes, if that's impossible).
 */
export async function startTask(root: string, name: string, base: TaskBase, opts: GitOptions = {}): Promise<BranchResult> {
  const check = await checkBranchName(root, name, opts);
  if (check !== 'ok') return nameProblem(check);
  if (await getConflictState(root, opts)) return { kind: 'conflict' };
  const f = await fetchBase(root, base, opts);
  if (!f.ok) return { kind: 'error', code: f.code, message: f.message };
  if (!(await revParse(root, base.baseRef, opts))) return { kind: 'noBase' };
  const r = await runGit(root, ['checkout', '--no-track', '-b', name, base.baseRef], opts);
  if (r.code !== 0) return failure(`${r.stdout}\n${r.stderr}`, r.code);
  return { kind: 'ok', branch: name };
}

/**
 * Commits were made on main but main only accepts pull requests: put them on a
 * new branch (switching to it, uncommitted work included) and move the local
 * main back to the remote's main. Nothing is lost: the commits are on the branch.
 */
export async function moveCommitsToBranch(root: string, name: string, base: TaskBase, opts: GitOptions = {}): Promise<BranchResult> {
  const check = await checkBranchName(root, name, opts);
  if (check !== 'ok') return nameProblem(check);
  if (await getConflictState(root, opts)) return { kind: 'conflict' };
  const local = await currentBranch(root, opts);
  if (local !== base.base) return { kind: 'error', code: 'other', message: `not on ${base.base}` };
  if (!(await revParse(root, base.baseRef, opts))) return { kind: 'noBase' };
  const r = await runGit(root, ['checkout', '-b', name], opts);
  if (r.code !== 0) return failure(`${r.stdout}\n${r.stderr}`, r.code);
  // Safe now that HEAD is the new branch: main itself isn't checked out.
  await runGit(root, ['branch', '-f', base.base, base.baseRef], opts);
  return { kind: 'ok', branch: name };
}

export type PushBranchResult =
  | { kind: 'ok' }
  | { kind: 'rejected'; message: string }
  | { kind: 'protected'; message: string }
  | { kind: 'error'; code: ErrorCode; message: string };

/**
 * GitHub / GitLab refusing a push because the branch only accepts pull requests.
 * GitHub's GH013 alone isn't enough: the same code is used for other rules, e.g.
 * push protection refusing a commit that contains a password or API key.
 */
export function isProtectedRejection(output: string): boolean {
  return /GH006|protected branch|Changes must be made through a pull request|not allowed to push code to protected branches/i.test(output);
}

/** Push the task branch and make it track the remote branch. */
export async function pushBranch(root: string, remote: string, branch: string, opts: GitOptions = {}): Promise<PushBranchResult> {
  const r = await runGit(root, ['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], { timeoutMs: 120_000, ...opts });
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (r.code === 0) return { kind: 'ok' };
  if (isProtectedRejection(out)) return { kind: 'protected', message: out };
  if (/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(out)) return { kind: 'rejected', message: out };
  return { kind: 'error', code: r.code === 124 ? 'network' : classifyError(out), message: out };
}

/** Switch back to main (created from the remote's main if there's no local one). */
export async function switchToBase(root: string, base: TaskBase, opts: GitOptions = {}): Promise<BranchResult> {
  if (await getConflictState(root, opts)) return { kind: 'conflict' };
  const hasLocal = !!(await revParse(root, `refs/heads/${base.base}`, opts));
  const args = hasLocal ? ['checkout', base.base] : ['checkout', '--track', '-b', base.base, base.baseRef];
  const r = await runGit(root, args, opts);
  if (r.code !== 0) return failure(`${r.stdout}\n${r.stderr}`, r.code);
  return { kind: 'ok', branch: base.base };
}

/**
 * Delete a finished task branch (call after main has pulled the merge). It's
 * deleted only if it still points at the commit the pull request merged (a
 * squash merge leaves it "unmerged" for git) or its tip is part of HEAD, so
 * commits added after the merge are never lost. (`git branch -d` alone isn't
 * enough: it accepts any branch that is pushed to its upstream.)
 */
export async function deleteTaskBranch(root: string, branch: string, mergedSha?: string, opts: GitOptions = {}): Promise<boolean> {
  if ((await currentBranch(root, opts)) === branch) return false;
  const tip = await revParse(root, `refs/heads/${branch}`, opts);
  if (!tip) return false;
  const merged = (!!mergedSha && tip === mergedSha) || (await runGit(root, ['merge-base', '--is-ancestor', tip, 'HEAD'], opts)).code === 0;
  if (!merged) return false;
  return (await runGit(root, ['branch', '-D', branch], opts)).code === 0;
}
