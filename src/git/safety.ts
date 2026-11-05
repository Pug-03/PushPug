// Safety nets around pull and push. No `vscode` import; tested against real repos.
//   - undo the last pull-merge for 10 minutes, uncommitted work included
//   - push only after checking the remote, and explain a rejected push
import { createHash } from 'node:crypto';
import { runGit, splitZ, type GitOptions } from './exec';
import { isProtectedRejection } from './branches';
import { currentBranch, fetchUpstream, revParse, commitsBetween, upstreamOf, remoteOfBranch, type Commit } from './repo';

export const UNDO_WINDOW_MS = 10 * 60_000;

/**
 * Everything about the working copy that a later edit would change: HEAD,
 * staged and unstaged changes, and untracked files (names and contents).
 */
export async function fingerprint(root: string, opts: GitOptions = {}): Promise<string> {
  const h = createHash('sha1');
  h.update((await revParse(root, 'HEAD', opts)) ?? 'none');
  const stash = (await runGit(root, ['stash', 'create'], opts)).stdout.trim();
  if (stash) {
    h.update((await runGit(root, ['rev-parse', `${stash}^{tree}`, `${stash}^2^{tree}`], opts)).stdout);
  } else {
    h.update('clean');
  }
  const untracked = splitZ((await runGit(root, ['ls-files', '-o', '--exclude-standard', '-z'], opts)).stdout);
  if (untracked.length) {
    h.update(untracked.join('\0'));
    // Paths go through stdin: tens of thousands of names on the command line fail with E2BIG.
    // (--stdin-paths is line based, so a name containing a newline only counts by name.)
    const paths = untracked.filter((p) => !p.includes('\n'));
    if (paths.length) {
      const hashed = await runGit(root, ['hash-object', '--stdin-paths'], { ...opts, input: paths.join('\n') + '\n' });
      h.update(`${hashed.code}\0${hashed.stdout}`);
    }
  }
  return h.digest('hex');
}

export interface UndoRecord {
  root: string;
  /** HEAD before the pull. */
  preHead: string;
  /** `git stash create` of the uncommitted work before the pull (null = it was clean). */
  preStash: string | null;
  /** HEAD right after the merge. */
  postHead: string;
  /** Fingerprint right after the merge; any later edit changes it. */
  postFingerprint: string;
  at: number;
}

/** Call just before pulling: remembers HEAD and the uncommitted work without touching it. */
export async function captureBeforePull(root: string, opts: GitOptions = {}): Promise<{ preHead: string; preStash: string | null } | null> {
  const preHead = await revParse(root, 'HEAD', opts);
  if (!preHead) return null;
  const stash = (await runGit(root, ['stash', 'create'], opts)).stdout.trim();
  // Keep the object reachable so nothing prunes it during the undo window;
  // a clean working copy needs nothing, so drop any ref from an earlier pull.
  if (stash) await runGit(root, ['update-ref', 'refs/pushpug/undo-stash', stash], opts);
  else await runGit(root, ['update-ref', '-d', 'refs/pushpug/undo-stash'], opts);
  return { preHead, preStash: stash || null };
}

/** Call right after a successful pull. */
export async function finishUndoRecord(root: string, before: { preHead: string; preStash: string | null }, now = Date.now(), opts: GitOptions = {}): Promise<UndoRecord | null> {
  const postHead = await revParse(root, 'HEAD', opts);
  if (!postHead || postHead === before.preHead) return null;
  return { root, ...before, postHead, postFingerprint: await fingerprint(root, opts), at: now };
}

export type UndoResult =
  | { kind: 'ok' }
  | { kind: 'expired' }
  | { kind: 'committed' } // HEAD moved on since the merge
  | { kind: 'changed' } // files edited / staged since the merge
  | { kind: 'error'; message: string };

/** Can this merge still be undone? (Same checks undo makes, without changing anything.) */
export async function canUndo(rec: UndoRecord, now = Date.now(), opts: GitOptions = {}): Promise<UndoResult> {
  if (now - rec.at > UNDO_WINDOW_MS) return { kind: 'expired' };
  const head = await revParse(rec.root, 'HEAD', opts);
  if (head !== rec.postHead) return { kind: 'committed' };
  if ((await fingerprint(rec.root, opts)) !== rec.postFingerprint) return { kind: 'changed' };
  return { kind: 'ok' };
}

/**
 * Put the repo back exactly as it was before the pull: HEAD, staged changes
 * and unstaged changes. Refuses if anything happened after the merge.
 */
export async function undoMerge(rec: UndoRecord, now = Date.now(), opts: GitOptions = {}): Promise<UndoResult> {
  const check = await canUndo(rec, now, opts);
  if (check.kind !== 'ok') return check;
  const reset = await runGit(rec.root, ['reset', '--hard', rec.preHead], opts);
  if (reset.code !== 0) return { kind: 'error', message: reset.stderr.trim() };
  if (rec.preStash) {
    const apply = await runGit(rec.root, ['stash', 'apply', '--index', rec.preStash], opts);
    if (apply.code !== 0) return { kind: 'error', message: apply.stderr.trim() || apply.stdout.trim() };
  }
  await runGit(rec.root, ['update-ref', '-d', 'refs/pushpug/undo-stash'], opts);
  return { kind: 'ok' };
}

// ---------- push ----------

export type PushResult =
  | { kind: 'ok'; pushed: number }
  | { kind: 'nothing' }
  | { kind: 'behind'; behind: number; incoming: Commit[] }
  | { kind: 'rejected'; message: string }
  /** The branch only accepts pull requests (GitHub branch protection / rulesets). */
  | { kind: 'protected'; message: string }
  | { kind: 'noUpstream' }
  | { kind: 'detached' }
  | { kind: 'error'; message: string };

/**
 * Push, but fetch first: if teammates pushed in the meantime, say so instead
 * of letting git reject the push.
 */
export async function safePush(root: string, opts: GitOptions = {}): Promise<PushResult> {
  const branch = await currentBranch(root, opts);
  if (!branch) return { kind: 'detached' };
  if (!(await upstreamOf(root, opts))) return { kind: 'noUpstream' };
  const f = await fetchUpstream(root, opts);
  if (!f.ok) return { kind: 'error', message: f.message };
  const incoming = await commitsBetween(root, 'HEAD..@{u}', 20, opts);
  if (incoming.length) {
    const count = Number((await runGit(root, ['rev-list', '--count', 'HEAD..@{u}'], opts)).stdout.trim()) || incoming.length;
    return { kind: 'behind', behind: count, incoming };
  }
  const ahead = Number((await runGit(root, ['rev-list', '--count', '@{u}..HEAD'], opts)).stdout.trim()) || 0;
  if (!ahead) return { kind: 'nothing' };
  // Push explicitly to the upstream branch: a bare `git push` (push.default=simple)
  // refuses when the local branch name differs from the upstream's name.
  const remote = await remoteOfBranch(root, branch, opts);
  const merge = (await runGit(root, ['config', '--get', `branch.${branch}.merge`], opts)).stdout.trim();
  const args = remote && merge ? ['push', remote, `HEAD:${merge}`] : ['push'];
  const r = await runGit(root, args, { timeoutMs: 120_000, ...opts });
  if (r.code === 0) return { kind: 'ok', pushed: ahead };
  const out = `${r.stdout}\n${r.stderr}`.trim();
  if (isProtectedRejection(out)) return { kind: 'protected', message: out };
  if (isRejected(out)) return { kind: 'rejected', message: out };
  return { kind: 'error', message: out };
}

export function isRejected(output: string): boolean {
  return /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(output);
}
