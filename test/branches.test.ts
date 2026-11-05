import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam, write, read, commitAll, commitAndPush, editLine, type Team } from './helpers';
import { git, runGit } from '../src/git/exec';
import { currentBranch, mergeRef, pull } from '../src/git/repo';
import {
  taskBase,
  defaultBranch,
  suggestBranchName,
  checkBranchName,
  availableBranchName,
  commitsNotOnBase,
  startTask,
  moveCommitsToBranch,
  pushBranch,
  switchToBase,
  deleteTaskBranch,
  isProtectedRejection,
  type TaskBase,
} from '../src/git/branches';
import { safePush } from '../src/git/safety';
import { explainGitError } from '../src/core/gitErrors';

const rev = async (repo: string, ref: string) => (await git(repo, ['rev-parse', ref])).trim();
const BASE: TaskBase = { remote: 'origin', base: 'main', baseRef: 'origin/main' };

describe('branch names', () => {
  test('a description becomes a branch name; Thai is kept', () => {
    assert.equal(suggestBranchName('Fix login page!'), 'task/fix-login-page');
    assert.equal(suggestBranchName('แก้หน้า login'), 'task/แก้หน้า-login');
    assert.equal(suggestBranchName('  --  ', new Date(2026, 9, 23, 9, 5)), 'task/20261023-0905');
    assert.equal(suggestBranchName('', new Date(2026, 9, 23, 9, 5)), 'task/20261023-0905');
    assert.ok(suggestBranchName('a'.repeat(100)).length <= 45);
  });
});

describe('task branches', () => {
  let t: Team;
  beforeEach(async () => {
    t = await makeTeam();
  });
  afterEach(() => t.cleanup());

  test('finds the main branch, with or without origin/HEAD', async () => {
    assert.deepEqual(await taskBase(t.bob), BASE);
    await git(t.bob, ['remote', 'set-head', 'origin', '-d']);
    assert.equal(await defaultBranch(t.bob, 'origin'), 'main');
  });

  test('name check: invalid, taken, ok', async () => {
    assert.equal(await checkBranchName(t.bob, 'a..b'), 'invalid');
    assert.equal(await checkBranchName(t.bob, 'has space'), 'invalid');
    assert.equal(await checkBranchName(t.bob, 'main'), 'exists');
    assert.equal(await checkBranchName(t.bob, 'task/new'), 'ok');
  });

  test('name check: a branch that is a path prefix (or under the name) blocks it', async () => {
    await git(t.bob, ['branch', 'task']);
    assert.equal(await checkBranchName(t.bob, 'task/fix-login'), 'blocked');
    assert.equal((await startTask(t.bob, 'task/fix-login', BASE)).kind, 'exists');
    await git(t.bob, ['branch', 'feature/login/part-1']);
    assert.equal(await checkBranchName(t.bob, 'feature/login'), 'exists');
    assert.equal(await checkBranchName(t.bob, 'feature/login-2'), 'ok');
  });

  test('a free branch name is found even when "task" itself is a branch', async () => {
    assert.equal(await availableBranchName(t.bob, 'Fix login'), 'task/fix-login');
    await git(t.bob, ['branch', 'task/fix-login']);
    assert.equal(await availableBranchName(t.bob, 'Fix login'), 'task/fix-login-2');
    await git(t.bob, ['branch', '-D', 'task/fix-login']);
    await git(t.bob, ['branch', 'task']);
    assert.equal(await availableBranchName(t.bob, 'Fix login'), 'task-fix-login');
    assert.equal((await startTask(t.bob, 'task-fix-login', BASE)).kind, 'ok');
  });

  test('start a task: new branch from the latest main, uncommitted work comes along', async () => {
    write(t.alice, 'alice.txt', 'hi\n');
    await commitAndPush(t.alice, 'Alice adds a file');
    write(t.bob, 'notes.txt', 'draft\n');
    const r = await startTask(t.bob, 'task/notes', BASE);
    assert.deepEqual(r, { kind: 'ok', branch: 'task/notes' });
    assert.equal(await currentBranch(t.bob), 'task/notes');
    assert.equal(await rev(t.bob, 'HEAD'), await rev(t.alice, 'HEAD'), 'made from the remote main, not the old local one');
    assert.equal(read(t.bob, 'notes.txt'), 'draft\n');
    // Not tracking main: a later push goes to its own branch.
    assert.equal((await runGit(t.bob, ['rev-parse', '--abbrev-ref', '@{u}'])).code !== 0, true);
  });

  test('start a task refuses a taken name and changes nothing', async () => {
    const r = await startTask(t.bob, 'main', BASE);
    assert.equal(r.kind, 'exists');
    assert.equal(await currentBranch(t.bob), 'main');
  });

  test('commits made on main move to a branch; main goes back to the remote main', async () => {
    const remoteMain = await rev(t.bob, 'origin/main');
    write(t.bob, 'a.txt', 'a\n');
    await commitAll(t.bob, 'Add a');
    write(t.bob, 'b.txt', 'b\n');
    await commitAll(t.bob, 'Add b');
    const tip = await rev(t.bob, 'HEAD');
    write(t.bob, 'wip.txt', 'not committed\n');
    assert.equal((await commitsNotOnBase(t.bob, 'origin/main')).length, 2);

    const r = await moveCommitsToBranch(t.bob, 'task/a-and-b', BASE);
    assert.equal(r.kind, 'ok');
    assert.equal(await currentBranch(t.bob), 'task/a-and-b');
    assert.equal(await rev(t.bob, 'HEAD'), tip);
    assert.equal(await rev(t.bob, 'main'), remoteMain);
    assert.equal(read(t.bob, 'wip.txt'), 'not committed\n');
  });

  test('push a branch: it gets an upstream and lands on the remote', async () => {
    await startTask(t.bob, 'task/x', BASE);
    write(t.bob, 'x.txt', 'x\n');
    await commitAll(t.bob, 'Add x');
    assert.deepEqual(await pushBranch(t.bob, 'origin', 'task/x'), { kind: 'ok' });
    assert.equal((await git(t.bob, ['rev-parse', '--abbrev-ref', '@{u}'])).trim(), 'origin/task/x');
    assert.equal(await rev(t.remote, 'refs/heads/task/x'), await rev(t.bob, 'HEAD'));
  });

  test('push a branch someone else updated: rejected, not forced', async () => {
    await startTask(t.bob, 'task/shared', BASE);
    write(t.bob, 'x.txt', 'x\n');
    await commitAll(t.bob, 'Add x');
    await pushBranch(t.bob, 'origin', 'task/shared');
    await git(t.alice, ['fetch', '-q']);
    await git(t.alice, ['checkout', '-q', '-b', 'task/shared', 'origin/task/shared']);
    write(t.alice, 'y.txt', 'y\n');
    await commitAll(t.alice, 'Add y');
    await git(t.alice, ['push', '-q', 'origin', 'task/shared']);
    write(t.bob, 'z.txt', 'z\n');
    await commitAll(t.bob, 'Add z');
    assert.equal((await pushBranch(t.bob, 'origin', 'task/shared')).kind, 'rejected');
  });

  test('main moved and touched the same lines: merging main into the task reports the conflict', async () => {
    await startTask(t.bob, 'task/edit', BASE);
    editLine(t.bob, 'app.txt', 2, 'bob');
    await commitAll(t.bob, 'Bob edits line 2');
    editLine(t.alice, 'app.txt', 2, 'alice');
    await commitAndPush(t.alice, 'Alice edits line 2');
    await git(t.bob, ['fetch', '-q']);
    const r = await mergeRef(t.bob, 'origin/main');
    assert.equal(r.kind, 'mergeConflict');
  });

  test('merging main without conflicts keeps uncommitted work', async () => {
    await startTask(t.bob, 'task/edit', BASE);
    write(t.alice, 'alice.txt', 'hi\n');
    await commitAndPush(t.alice, 'Alice adds a file');
    editLine(t.bob, 'app.txt', 5, 'bob wip');
    await git(t.bob, ['fetch', '-q']);
    const r = await mergeRef(t.bob, 'origin/main');
    assert.equal(r.kind, 'ok');
    assert.equal(read(t.bob, 'alice.txt'), 'hi\n');
    assert.match(read(t.bob, 'app.txt'), /bob wip/);
  });

  test('after the merge: back to main, pull, and the finished branch is deleted', async () => {
    await startTask(t.bob, 'task/done', BASE);
    write(t.bob, 'done.txt', 'done\n');
    await commitAll(t.bob, 'Done');
    await pushBranch(t.bob, 'origin', 'task/done');
    const prHead = await rev(t.bob, 'HEAD');
    // "GitHub" squash-merges it: main gets a new commit with the same change.
    await git(t.alice, ['pull', '-q']);
    write(t.alice, 'done.txt', 'done\n');
    await commitAndPush(t.alice, 'Done (#1)');

    assert.equal((await switchToBase(t.bob, BASE)).kind, 'ok');
    assert.equal((await pull(t.bob)).kind, 'ok');
    assert.equal(await deleteTaskBranch(t.bob, 'task/done', prHead), true);
    assert.equal((await runGit(t.bob, ['rev-parse', '--verify', '-q', 'refs/heads/task/done'])).code !== 0, true);
  });

  test('a branch with commits added after the merge is kept', async () => {
    await startTask(t.bob, 'task/more', BASE);
    write(t.bob, 'one.txt', '1\n');
    await commitAll(t.bob, 'One');
    await pushBranch(t.bob, 'origin', 'task/more');
    const prHead = await rev(t.bob, 'HEAD');
    write(t.bob, 'two.txt', '2\n');
    await commitAll(t.bob, 'Two, after the merge');
    await pushBranch(t.bob, 'origin', 'task/more');
    await switchToBase(t.bob, BASE);
    assert.equal(await deleteTaskBranch(t.bob, 'task/more', prHead), false);
    assert.ok(await rev(t.bob, 'refs/heads/task/more'));
  });

  test("switching back to main refuses to overwrite uncommitted work", async () => {
    await startTask(t.bob, 'task/wip', BASE);
    editLine(t.bob, 'app.txt', 1, 'branch version');
    await commitAll(t.bob, 'Branch edit');
    editLine(t.bob, 'app.txt', 1, 'uncommitted');
    const r = await switchToBase(t.bob, BASE);
    assert.equal(r.kind, 'localChanges');
    assert.equal(await currentBranch(t.bob), 'task/wip');
    assert.match(read(t.bob, 'app.txt'), /uncommitted/);
  });
});

describe('protected branches', () => {
  const GITHUB = [
    'remote: error: GH013: Repository rule violations found for refs/heads/main.',
    'remote: - Changes must be made through a pull request.',
    'To https://github.com/Pug-03/PushPug.git',
    ' ! [remote rejected] main -> main (push declined due to repository rule violations)',
    "error: failed to push some refs to 'https://github.com/Pug-03/PushPug.git'",
  ].join('\n');

  test('GitHub rulesets and classic protection are recognised', () => {
    assert.equal(isProtectedRejection(GITHUB), true);
    assert.equal(isProtectedRejection('remote: error: GH006: Protected branch update failed for refs/heads/main.'), true);
    assert.equal(isProtectedRejection(' ! [rejected] main -> main (fetch first)'), false);
    assert.equal(explainGitError(GITHUB), 'protectedBranch');
  });

  test('other repository rules (a secret in the code) are not "only accepts pull requests"', () => {
    const secret = [
      'remote: error: GH013: Repository rule violations found for refs/heads/main.',
      'remote: - GITHUB PUSH PROTECTION',
      'remote:   Push cannot contain secrets',
      ' ! [remote rejected] main -> main (push declined due to repository rule violations)',
    ].join('\n');
    assert.equal(isProtectedRejection(secret), false);
    assert.equal(explainGitError(secret), 'ruleViolation');
  });

  test('safePush reports a protected branch (pre-receive hook)', async () => {
    const t = await makeTeam();
    try {
      write(t.remote, 'hooks/pre-receive', '#!/bin/sh\necho "remote: error: GH013: Repository rule violations found for refs/heads/main." >&2\necho "remote: - Changes must be made through a pull request." >&2\nexit 1\n');
      await git(t.remote, ['config', 'core.hooksPath', 'hooks']);
      const { chmodSync } = await import('node:fs');
      chmodSync(`${t.remote}/hooks/pre-receive`, 0o755);
      write(t.bob, 'b.txt', 'b\n');
      await commitAll(t.bob, 'On main');
      const r = await safePush(t.bob);
      assert.equal(r.kind, 'protected');
    } finally {
      t.cleanup();
    }
  });
});
