import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTeam, write, read, commitAll, commitAndPush, editLine, type Team } from './helpers';
import { git, runGit } from '../src/git/exec';
import { pull } from '../src/git/repo';
import { captureBeforePull, finishUndoRecord, undoMerge, canUndo, safePush, fingerprint, UNDO_WINDOW_MS, type UndoRecord } from '../src/git/safety';
import { explainGitError } from '../src/core/gitErrors';

const head = async (repo: string) => (await git(repo, ['rev-parse', 'HEAD'])).trim();
const status = async (repo: string) => (await git(repo, ['status', '--porcelain=v1'])).trim();

/** Pull the way PushPug does, keeping an undo record. */
async function pullWithUndo(repo: string): Promise<UndoRecord> {
  const before = await captureBeforePull(repo);
  const r = await pull(repo);
  assert.equal(r.kind, 'ok');
  const rec = await finishUndoRecord(repo, before!);
  assert.ok(rec, 'undo record');
  return rec!;
}

describe('undo the last merge', () => {
  let t: Team;
  beforeEach(async () => {
    t = await makeTeam();
    write(t.alice, 'alice.txt', 'from alice\n');
    await commitAndPush(t.alice, 'Alice adds a file');
  });
  afterEach(() => t.cleanup());

  test('clean working copy: back to the old HEAD, the teammate file is gone again', async () => {
    const before = await head(t.bob);
    const rec = await pullWithUndo(t.bob);
    assert.ok(existsSync(join(t.bob, 'alice.txt')));
    assert.deepEqual(await undoMerge(rec), { kind: 'ok' });
    assert.equal(await head(t.bob), before);
    assert.equal(existsSync(join(t.bob, 'alice.txt')), false);
    assert.equal(await status(t.bob), '');
    const ref = await runGit(t.bob, ['show-ref', '--verify', '--quiet', 'refs/pushpug/undo-stash']);
    assert.notEqual(ref.code, 0, 'no leftover undo ref in the user repo');
  });

  test('with uncommitted work (staged, unstaged and new files): all of it comes back exactly', async () => {
    editLine(t.bob, 'app.txt', 2, 'bob staged');
    await git(t.bob, ['add', 'app.txt']);
    editLine(t.bob, 'app.txt', 4, 'bob unstaged');
    write(t.bob, 'notes.txt', 'bob new file\n');
    const before = await head(t.bob);
    const statusBefore = await status(t.bob);
    const appBefore = read(t.bob, 'app.txt');
    const rec = await pullWithUndo(t.bob);
    assert.deepEqual(await undoMerge(rec), { kind: 'ok' });
    assert.equal(await head(t.bob), before);
    assert.equal(await status(t.bob), statusBefore, 'same staged / unstaged / untracked state');
    assert.equal(read(t.bob, 'app.txt'), appBefore);
    assert.equal(read(t.bob, 'notes.txt'), 'bob new file\n');
  });

  test('refused after a new commit', async () => {
    const rec = await pullWithUndo(t.bob);
    write(t.bob, 'more.txt', 'x');
    await commitAll(t.bob, 'Bob commits after the merge');
    const h = await head(t.bob);
    assert.deepEqual(await undoMerge(rec), { kind: 'committed' });
    assert.equal(await head(t.bob), h, 'nothing changed');
  });

  test('refused after editing, staging or adding files', async () => {
    let rec = await pullWithUndo(t.bob);
    editLine(t.bob, 'app.txt', 1, 'edited after merge');
    assert.deepEqual(await canUndo(rec), { kind: 'changed' });
    assert.deepEqual(await undoMerge(rec), { kind: 'changed' });
    assert.equal(read(t.bob, 'app.txt').split('\n')[0], 'edited after merge', 'edit kept');

    // A brand-new file counts too.
    await git(t.bob, ['checkout', '--', 'app.txt']);
    rec = { ...rec, postFingerprint: (await finishUndoRecord(t.bob, { preHead: rec.preHead, preStash: null }))!.postFingerprint };
    write(t.bob, 'scratch.txt', 'new');
    assert.deepEqual(await canUndo(rec), { kind: 'changed' });
  });

  test('refused after 10 minutes', async () => {
    const rec = await pullWithUndo(t.bob);
    assert.deepEqual(await undoMerge(rec, rec.at + UNDO_WINDOW_MS + 1), { kind: 'expired' });
    assert.ok(existsSync(join(t.bob, 'alice.txt')), 'merge still there');
  });
});

describe('push with a check first', () => {
  let t: Team;
  beforeEach(async () => (t = await makeTeam()));
  afterEach(() => t.cleanup());

  test('remote has new commits: does not push, says how many', async () => {
    write(t.alice, 'a.txt', 'a');
    await commitAndPush(t.alice, 'Alice pushes first');
    write(t.bob, 'b.txt', 'b');
    await commitAll(t.bob, 'Bob wants to push');
    const r = await safePush(t.bob);
    assert.equal(r.kind, 'behind');
    if (r.kind === 'behind') {
      assert.equal(r.behind, 1);
      assert.equal(r.incoming[0].subject, 'Alice pushes first');
    }
    const remoteHead = (await git(t.alice, ['ls-remote', 'origin', 'main'])).split('\t')[0];
    assert.notEqual(remoteHead, await head(t.bob), 'nothing was pushed');

    // "Merge, then push for me".
    assert.equal((await pull(t.bob)).kind, 'ok');
    const r2 = await safePush(t.bob);
    assert.deepEqual(r2, { kind: 'ok', pushed: 2 });
  });

  test('nothing to push / normal push', async () => {
    assert.deepEqual(await safePush(t.bob), { kind: 'nothing' });
    write(t.bob, 'b.txt', 'b');
    await commitAll(t.bob, 'Bob');
    assert.deepEqual(await safePush(t.bob), { kind: 'ok', pushed: 1 });
  });

  test('no upstream and detached HEAD are reported, not pushed', async () => {
    await git(t.bob, ['checkout', '-q', '-b', 'feature']);
    assert.deepEqual(await safePush(t.bob), { kind: 'noUpstream' });
    await git(t.bob, ['checkout', '-q', '--detach']);
    assert.deepEqual(await safePush(t.bob), { kind: 'detached' });
  });

  test('pushes when the local branch name differs from its upstream branch', async () => {
    await git(t.bob, ['checkout', '-q', '-b', 'feature', 'origin/main']);
    write(t.bob, 'f.txt', 'f');
    await commitAll(t.bob, 'Feature');
    assert.deepEqual(await safePush(t.bob), { kind: 'ok', pushed: 1 });
    const remoteHead = (await git(t.alice, ['ls-remote', 'origin', 'main'])).split('\t')[0];
    assert.equal(remoteHead, await head(t.bob));
    assert.equal((await git(t.bob, ['rev-parse', 'origin/main'])).trim(), await head(t.bob));
  });

  test('a rejected push (someone pushed in between) is recognised', async () => {
    write(t.alice, 'a.txt', 'a');
    await commitAndPush(t.alice, 'Alice');
    write(t.bob, 'b.txt', 'b');
    await commitAll(t.bob, 'Bob');
    // Push directly (without the check) to get git's own rejection text.
    const r = await runGit(t.bob, ['push']);
    assert.notEqual(r.code, 0);
    const out = r.stderr;
    assert.equal(explainGitError(out), 'rejected');
  });
});

describe('fingerprint with very many untracked files', () => {
  let t: Team;
  beforeEach(async () => (t = await makeTeam()));
  afterEach(() => t.cleanup());

  test('works (no E2BIG) and still notices an edit', async () => {
    const dir = join(t.bob, 'generated-output-folder-with-a-rather-long-name');
    mkdirSync(dir);
    for (let i = 0; i < 20000; i++) writeFileSync(join(dir, `some-fairly-long-generated-file-name-number-${i}.txt`), String(i));
    const f1 = await fingerprint(t.bob);
    assert.equal(await fingerprint(t.bob), f1);
    writeFileSync(join(dir, 'some-fairly-long-generated-file-name-number-5.txt'), 'changed');
    assert.notEqual(await fingerprint(t.bob), f1);
  });
});

describe('git error explanations', () => {
  const cases: Array<[string, string]> = [
    [' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 'rejected'],
    ['Updates were rejected because the tip of your current branch is behind', 'rejected'],
    ['fatal: Authentication failed for \'https://github.com/a/b.git/\'', 'auth'],
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'auth'],
    ['git@github.com: Permission denied (publickey).', 'auth'],
    ['remote: Repository not found.\nfatal: repository \'https://github.com/a/b.git/\' not found', 'repoNotFound'],
    ['fatal: The current branch feature has no upstream branch.', 'noUpstream'],
    ['There is no tracking information for the current branch.', 'noUpstream'],
    ['fatal: You are not currently on a branch.', 'detached'],
    ['fatal: You have not concluded your merge (MERGE_HEAD exists).', 'mergeInProgress'],
    ['error: Merging is not possible because you have unmerged files.', 'mergeInProgress'],
    ['error: Your local changes to the following files would be overwritten by merge:', 'localChanges'],
    ['error: The following untracked working tree files would be overwritten by merge:', 'untrackedOverwritten'],
    ['fatal: refusing to merge unrelated histories', 'unrelatedHistories'],
    ['hint: Need to specify how to reconcile divergent branches.', 'diverged'],
    ['*** Please tell me who you are.', 'identity'],
    ["fatal: Unable to create '/x/.git/index.lock': File exists.", 'locked'],
    ['fatal: unable to access \'https://github.com/\': Could not resolve host: github.com', 'network'],
    ['fatal: not a git repository (or any of the parent directories): .git', 'notRepo'],
    ['something completely different', 'unknown'],
  ];
  for (const [text, key] of cases) {
    test(`${key}: ${text.slice(0, 40)}`, () => assert.equal(explainGitError(text), key));
  }
});
