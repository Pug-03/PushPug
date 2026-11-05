// Pure git logic for PushPug. No `vscode` imports here so it can be tested
// against real temporary repositories and reused by the background worker.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, runGit, splitZ, type GitOptions } from './exec';

export interface Commit {
  sha: string;
  author: string;
  email: string;
  /** Unix time in seconds. */
  time: number;
  subject: string;
}

export interface ConflictState {
  /**
   * merge     – our commits and theirs touch the same lines (MERGE_HEAD exists)
   * autostash – the merge was fine but re-applying uncommitted work conflicted
   * other     – unmerged files from something PushPug didn't start
   */
  kind: 'merge' | 'autostash' | 'other';
  /** Files that still contain unresolved conflicts. */
  files: string[];
  /** Sha of the autostash entry (kind === 'autostash'). */
  stashSha?: string;
  /** Git will re-apply uncommitted work after the merge commit. */
  mergeAutostash?: boolean;
}

export type RepoState = 'upToDate' | 'behind' | 'conflict' | 'noUpstream' | 'detached' | 'error';

export type ErrorCode = 'auth' | 'network' | 'identity' | 'locked' | 'notRepo' | 'other';

export interface RepoSnapshot {
  root: string;
  branch: string | null;
  upstream: string | null;
  state: RepoState;
  ahead: number;
  behind: number;
  upstreamSha: string | null;
  /** Commits on the upstream that we don't have yet (newest first). */
  incoming: Commit[];
  /** Files changed by teammates that we are also changing. */
  overlap: string[];
  conflict: ConflictState | null;
  error?: { code: ErrorCode; message: string };
  checkedAt: number;
}

const FIELD = '\x1f';
const RECORD = '\x1e';
const LOG_FORMAT = `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%at${FIELD}%s${RECORD}`;

export async function findRepoRoot(dir: string, opts?: GitOptions): Promise<string | null> {
  const r = await runGit(dir, ['rev-parse', '--show-toplevel'], opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function currentBranch(root: string, opts?: GitOptions): Promise<string | null> {
  const r = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'], opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function upstreamOf(root: string, opts?: GitOptions): Promise<string | null> {
  const r = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function remoteOfBranch(root: string, branch: string, opts?: GitOptions): Promise<string | null> {
  const r = await runGit(root, ['config', '--get', `branch.${branch}.remote`], opts);
  const remote = r.stdout.trim();
  return r.code === 0 && remote && remote !== '.' ? remote : null;
}

/** branch.<b>.remote (a real remote) and branch.<b>.merge are both set. */
async function upstreamConfigured(root: string, branch: string, opts?: GitOptions): Promise<boolean> {
  if (!(await remoteOfBranch(root, branch, opts))) return false;
  const r = await runGit(root, ['config', '--get', `branch.${branch}.merge`], opts);
  return r.code === 0 && r.stdout.trim().length > 0;
}

export async function revParse(root: string, ref: string, opts?: GitOptions): Promise<string | null> {
  const r = await runGit(root, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function classifyError(stderr: string): ErrorCode {
  const s = stderr.toLowerCase();
  if (/authentication failed|could not read username|permission denied \(publickey|terminal prompts disabled|returned error: 40[13]|access denied/.test(s)) return 'auth';
  if (/could not resolve host|unable to access|connection timed out|network is unreachable|connection refused|operation timed out|failed to connect/.test(s)) return 'network';
  if (/please tell me who you are|empty ident|unable to auto-detect email/.test(s)) return 'identity';
  if (/index\.lock|another git process/.test(s)) return 'locked';
  if (/not a git repository/.test(s)) return 'notRepo';
  return 'other';
}

function parseLog(out: string): Commit[] {
  return out
    .split(RECORD)
    .map((r) => r.replace(/^\s+/, ''))
    .filter((r) => r.length > 0)
    .map((r) => {
      const [sha, author, email, at, ...rest] = r.split(FIELD);
      return { sha, author, email, time: Number(at), subject: rest.join(FIELD).trim() };
    });
}

export async function commitsBetween(root: string, range: string, max = 50, opts?: GitOptions): Promise<Commit[]> {
  return parseLog(await git(root, ['log', `--max-count=${max}`, LOG_FORMAT, range, '--'], opts));
}

/** Recent history of a ref, used for the team timeline. */
export async function recentCommits(root: string, ref: string, max = 20, opts?: GitOptions): Promise<Commit[]> {
  const r = await runGit(root, ['log', `--max-count=${max}`, LOG_FORMAT, ref, '--'], opts);
  return r.code === 0 ? parseLog(r.stdout) : [];
}

/** Paths from `git status -z`: modified, staged, deleted, renamed and untracked. */
export async function workingTreeFiles(root: string, opts?: GitOptions): Promise<string[]> {
  const tokens = splitZ(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], opts));
  const files: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const xy = t.slice(0, 2);
    files.push(t.slice(3));
    // Renames and copies are followed by the original path.
    if (xy[0] === 'R' || xy[0] === 'C') i++;
  }
  return files;
}

export async function unmergedFiles(root: string, opts?: GitOptions): Promise<string[]> {
  const r = await runGit(root, ['diff', '--name-only', '-z', '--diff-filter=U'], opts);
  return r.code === 0 ? [...new Set(splitZ(r.stdout))] : [];
}

export async function topStash(root: string, opts?: GitOptions): Promise<{ sha: string; subject: string } | null> {
  const r = await runGit(root, ['stash', 'list', '--max-count=1', `--format=%H${FIELD}%gs`], opts);
  const line = r.stdout.trim();
  if (r.code !== 0 || !line) return null;
  const [sha, subject] = line.split(FIELD);
  return { sha, subject: subject ?? '' };
}

export async function getConflictState(root: string, opts?: GitOptions): Promise<ConflictState | null> {
  const [files, mergeHead] = await Promise.all([unmergedFiles(root, opts), revParse(root, 'MERGE_HEAD', opts)]);
  if (mergeHead) {
    const mergeAutostash = (await runGit(root, ['rev-parse', '-q', '--verify', 'MERGE_AUTOSTASH'], opts)).code === 0;
    return { kind: 'merge', files, mergeAutostash };
  }
  if (files.length === 0) return null;
  // A cherry-pick, revert or rebase stopped on a conflict: an "autostash"
  // entry on top of the stash is then a leftover, not the cause.
  if (await otherOperationInProgress(root, opts)) return { kind: 'other', files };
  const stash = await topStash(root, opts);
  if (stash && stash.subject === 'autostash') return { kind: 'autostash', files, stashSha: stash.sha };
  return { kind: 'other', files };
}

async function otherOperationInProgress(root: string, opts?: GitOptions): Promise<boolean> {
  const names = ['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];
  const r = await runGit(root, ['rev-parse', ...names.flatMap((n) => ['--git-path', n])], opts);
  if (r.code !== 0) return false;
  return r.stdout
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => existsSync(resolve(root, p)));
}

/** Our side of the comparison: uncommitted, untracked and committed-but-not-pushed files. */
export async function myChangedFiles(root: string, opts?: GitOptions): Promise<string[]> {
  const set = new Set(await workingTreeFiles(root, opts));
  const r = await runGit(root, ['diff', '--name-only', '-z', '@{u}...HEAD'], opts);
  if (r.code === 0) for (const f of splitZ(r.stdout)) set.add(f);
  return [...set];
}

export async function theirChangedFiles(root: string, opts?: GitOptions): Promise<string[]> {
  const r = await runGit(root, ['diff', '--name-only', '-z', 'HEAD...@{u}'], opts);
  return r.code === 0 ? splitZ(r.stdout) : [];
}

export async function overlappingFiles(root: string, opts?: GitOptions): Promise<string[]> {
  const [mine, theirs] = await Promise.all([myChangedFiles(root, opts), theirChangedFiles(root, opts)]);
  const mineSet = new Set(mine);
  return theirs.filter((f) => mineSet.has(f)).sort();
}

export async function fetchUpstream(root: string, opts?: GitOptions): Promise<{ ok: true } | { ok: false; code: ErrorCode; message: string }> {
  const branch = await currentBranch(root, opts);
  const remote = branch ? await remoteOfBranch(root, branch, opts) : null;
  const args = ['fetch', '--quiet', '--no-write-fetch-head'];
  if (remote) args.push(remote);
  const r = await runGit(root, args, { timeoutMs: 90_000, ...opts });
  if (r.code === 0) return { ok: true };
  // Older git (< 2.29) doesn't know --no-write-fetch-head.
  if (/unknown option/.test(r.stderr)) {
    const retry = await runGit(root, ['fetch', '--quiet', ...(remote ? [remote] : [])], { timeoutMs: 90_000, ...opts });
    if (retry.code === 0) return { ok: true };
    return { ok: false, code: classifyError(retry.stderr), message: retry.stderr.trim() };
  }
  return { ok: false, code: r.code === 124 ? 'network' : classifyError(r.stderr), message: r.stderr.trim() };
}

export interface CheckOptions extends GitOptions {
  fetch?: boolean;
}

export async function checkRepo(root: string, opts: CheckOptions = {}): Promise<RepoSnapshot> {
  const snap: RepoSnapshot = {
    root,
    branch: null,
    upstream: null,
    state: 'upToDate',
    ahead: 0,
    behind: 0,
    upstreamSha: null,
    incoming: [],
    overlap: [],
    conflict: null,
    checkedAt: Date.now(),
  };
  try {
    snap.branch = await currentBranch(root, opts);
    snap.conflict = await getConflictState(root, opts);
    if (!snap.branch) {
      snap.state = snap.conflict ? 'conflict' : 'detached';
      return snap;
    }
    snap.upstream = await upstreamOf(root, opts);
    let fetched = false;
    if (!snap.upstream && opts.fetch && (await upstreamConfigured(root, snap.branch, opts))) {
      // Tracking is configured but the remote-tracking ref doesn't exist yet
      // (e.g. a clone of an empty repo before the first push): fetch, then look again.
      const f = await fetchUpstream(root, opts);
      fetched = true;
      if (!f.ok) snap.error = { code: f.code, message: f.message };
      snap.upstream = await upstreamOf(root, opts);
    }
    if (!snap.upstream) {
      snap.state = snap.conflict ? 'conflict' : 'noUpstream';
      return snap;
    }
    if (opts.fetch && !fetched) {
      const f = await fetchUpstream(root, opts);
      if (!f.ok) snap.error = { code: f.code, message: f.message };
    }
    snap.upstreamSha = await revParse(root, '@{u}', opts);
    // No commit of our own yet (a clone of an empty repo): everything upstream is incoming.
    const unborn = !(await revParse(root, 'HEAD', opts));
    const counts = unborn
      ? ['0', (await git(root, ['rev-list', '--count', '@{u}'], opts)).trim()]
      : (await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], opts)).trim().split(/\s+/);
    snap.ahead = Number(counts[0]) || 0;
    snap.behind = Number(counts[1]) || 0;
    if (snap.behind > 0) {
      snap.incoming = await commitsBetween(root, unborn ? '@{u}' : 'HEAD..@{u}', 50, opts);
      snap.overlap = await overlappingFiles(root, opts);
    }
    if (snap.conflict) snap.state = 'conflict';
    else if (snap.error) snap.state = 'error';
    else snap.state = snap.behind > 0 ? 'behind' : 'upToDate';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    snap.state = 'error';
    snap.error = { code: classifyError(message), message };
  }
  return snap;
}

export type PullResult =
  | { kind: 'ok'; pulled: number; files: string[]; autostashed: boolean }
  | { kind: 'upToDate' }
  | { kind: 'mergeConflict'; files: string[]; mergeAutostash: boolean }
  | { kind: 'autostashConflict'; files: string[]; stashSha: string }
  | { kind: 'blocked'; conflict: ConflictState }
  | { kind: 'noUpstream' }
  | { kind: 'detached' }
  | { kind: 'untrackedInTheWay'; files: string[] }
  | { kind: 'error'; code: ErrorCode; message: string };

function filesFromOverwriteError(stderr: string): string[] {
  // "error: The following untracked working tree files would be overwritten by merge:\n\tfile\nPlease move..."
  const m = stderr.match(/would be overwritten by merge:\n([\s\S]*?)\n(?:Please|Aborting)/);
  return m ? m[1].split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * "Pull in teammates' code": `git pull --no-rebase --autostash --no-edit`.
 * Uncommitted work is stashed by git and re-applied afterwards, so it can't
 * be lost; on conflict it stays in the stash until the user resolves it.
 */
export async function pull(root: string, opts: GitOptions = {}): Promise<PullResult> {
  const existing = await getConflictState(root, opts);
  if (existing) return { kind: 'blocked', conflict: existing };
  if (!(await currentBranch(root, opts))) return { kind: 'detached' };
  if (!(await upstreamOf(root, opts))) return { kind: 'noUpstream' };

  const before = await revParse(root, 'HEAD', opts);
  const hadLocalChanges = (await workingTreeFiles(root, opts)).length > 0;
  const r = await runGit(root, ['pull', '--no-rebase', '--autostash', '--no-edit'], { timeoutMs: 120_000, ...opts });
  return interpretMergeOutcome(root, r.code, `${r.stdout}\n${r.stderr}`, before, hadLocalChanges, opts);
}

/**
 * Merge another ref (e.g. `origin/main`) into the current branch the same way
 * `pull` does: uncommitted work is autostashed and conflicts are reported.
 */
export async function mergeRef(root: string, ref: string, opts: GitOptions = {}): Promise<PullResult> {
  const existing = await getConflictState(root, opts);
  if (existing) return { kind: 'blocked', conflict: existing };
  if (!(await currentBranch(root, opts))) return { kind: 'detached' };
  const before = await revParse(root, 'HEAD', opts);
  const hadLocalChanges = (await workingTreeFiles(root, opts)).length > 0;
  const r = await runGit(root, ['merge', '--autostash', '--no-edit', ref], { timeoutMs: 120_000, ...opts });
  return interpretMergeOutcome(root, r.code, `${r.stdout}\n${r.stderr}`, before, hadLocalChanges, opts);
}

async function interpretMergeOutcome(
  root: string,
  code: number,
  output: string,
  before: string | null,
  hadLocalChanges: boolean,
  opts: GitOptions,
): Promise<PullResult> {
  const conflict = await getConflictState(root, opts);
  if (conflict?.kind === 'merge') {
    return { kind: 'mergeConflict', files: conflict.files, mergeAutostash: !!conflict.mergeAutostash };
  }
  if (conflict?.kind === 'autostash') {
    return { kind: 'autostashConflict', files: conflict.files, stashSha: conflict.stashSha! };
  }
  if (code !== 0) {
    const untracked = filesFromOverwriteError(output);
    if (untracked.length && /untracked working tree files/.test(output)) return { kind: 'untrackedInTheWay', files: untracked };
    return { kind: 'error', code: code === 124 ? 'network' : classifyError(output), message: output.trim() };
  }
  const after = await revParse(root, 'HEAD', opts);
  if (!before && after) {
    // First pull into a clone of an empty repo: every commit and file is new.
    const pulled = Number((await git(root, ['rev-list', '--count', after], opts)).trim()) || 0;
    const files = splitZ(await git(root, ['ls-tree', '-r', '--name-only', '-z', after], opts));
    return { kind: 'ok', pulled, files, autostashed: hadLocalChanges };
  }
  if (!before || before === after) return { kind: 'upToDate' };
  const pulled = Number((await git(root, ['rev-list', '--count', `${before}..${after}`], opts)).trim()) || 0;
  const files = splitZ(await git(root, ['diff', '--name-only', '-z', before, after!], opts));
  return { kind: 'ok', pulled, files, autostashed: hadLocalChanges };
}

/**
 * After an autostash conflict, once every file is staged (no unmerged
 * entries left) the stash entry is redundant: drop it — but only if the top
 * stash is still the "autostash" entry, and the one we expect when known.
 * "No conflicts left" is also what a `git reset --hard` looks like, so the
 * entry is dropped only when the working copy still carries some of the
 * stashed work (one of its files differs from HEAD); otherwise it is kept.
 */
export async function dropAutostashIfResolved(root: string, expectedSha?: string, opts?: GitOptions): Promise<boolean> {
  if ((await unmergedFiles(root, opts)).length > 0) return false;
  if (await revParse(root, 'MERGE_HEAD', opts)) return false;
  const stash = await topStash(root, opts);
  if (!stash || stash.subject !== 'autostash') return false;
  if (expectedSha && stash.sha !== expectedSha) return false;
  if (!(await stashWorkStillPresent(root, stash.sha, opts))) return false;
  const r = await runGit(root, ['stash', 'drop', '--quiet', 'stash@{0}'], opts);
  return r.code === 0;
}

/** Does any file the stash changed differ from HEAD (staged or not)? When unsure: no. */
async function stashWorkStillPresent(root: string, stashSha: string, opts?: GitOptions): Promise<boolean> {
  const stashed = await runGit(root, ['diff', '--name-only', '-z', '--no-renames', `${stashSha}^1`, stashSha], opts);
  const changed = await runGit(root, ['diff', '--name-only', '-z', '--no-renames', 'HEAD'], opts);
  if (stashed.code !== 0 || changed.code !== 0) return false;
  const changedSet = new Set(splitZ(changed.stdout));
  return splitZ(stashed.stdout).some((f) => changedSet.has(f));
}

/** Commit a merge whose conflicts are all resolved and staged. */
export async function finishMerge(root: string, opts: GitOptions = {}): Promise<PullResult> {
  const conflict = await getConflictState(root, opts);
  if (!conflict || conflict.kind !== 'merge') return { kind: 'upToDate' };
  if (conflict.files.length > 0) return { kind: 'blocked', conflict };
  const before = await revParse(root, 'ORIG_HEAD', opts);
  const r = await runGit(root, ['commit', '--no-edit'], opts);
  return interpretMergeOutcome(root, r.code, `${r.stdout}\n${r.stderr}`, before, !!conflict.mergeAutostash, opts);
}

/** Branches + tags the remote advertises on every fetch (approximated from local remote-tracking refs). */
export async function countRemoteRefs(root: string, opts?: GitOptions): Promise<number> {
  const r = await runGit(root, ['for-each-ref', '--format=x', 'refs/remotes', 'refs/tags'], opts);
  return r.code === 0 ? r.stdout.split('\n').filter(Boolean).length : 1;
}

/** URL of the remote the current branch tracks. */
export async function upstreamRemoteUrl(root: string, opts?: GitOptions): Promise<string | null> {
  const branch = await currentBranch(root, opts);
  const remote = branch ? await remoteOfBranch(root, branch, opts) : null;
  if (!remote) return null;
  const r = await runGit(root, ['remote', 'get-url', remote], opts);
  return r.code === 0 ? r.stdout.trim() : null;
}
