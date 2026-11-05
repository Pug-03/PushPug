import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam, write, read, commitAll, commitAndPush, editLine, type Team } from './helpers';
import { git, runGit, EXIT_OUTPUT_TOO_LARGE, EXIT_TIMEOUT } from '../src/git/exec';
import {
  checkRepo,
  pull,
  getConflictState,
  dropAutostashIfResolved,
  finishMerge,
  topStash,
  overlappingFiles,
  classifyError,
} from '../src/git/repo';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let t: Team;
beforeEach(async () => {
  t = await makeTeam();
});
afterEach(() => t.cleanup());

describe('checkRepo', () => {
  test('up to date right after clone', async () => {
    const s = await checkRepo(t.bob, { fetch: true });
    assert.equal(s.state, 'upToDate');
    assert.equal(s.behind, 0);
    assert.equal(s.upstream, 'origin/main');
  });

  test('reports who pushed, how many commits and the latest message', async () => {
    write(t.alice, 'a.txt', 'one');
    await commitAndPush(t.alice, 'Add a');
    write(t.alice, 'b.txt', 'two');
    await commitAndPush(t.alice, 'Add login page');
    const s = await checkRepo(t.bob, { fetch: true });
    assert.equal(s.state, 'behind');
    assert.equal(s.behind, 2);
    assert.equal(s.incoming.length, 2);
    assert.equal(s.incoming[0].subject, 'Add login page');
    assert.equal(s.incoming[0].author, 'Alice Lee');
    assert.ok(Math.abs(s.incoming[0].time * 1000 - Date.now()) < 60_000);
    assert.equal(s.upstreamSha, (await git(t.alice, ['rev-parse', 'HEAD'])).trim());
  });

  test('without fetch it does not see new remote commits', async () => {
    write(t.alice, 'a.txt', 'one');
    await commitAndPush(t.alice, 'Add a');
    const s = await checkRepo(t.bob, { fetch: false });
    assert.equal(s.behind, 0);
  });

  test('repo without upstream', async () => {
    await git(t.bob, ['checkout', '-q', '-b', 'feature']);
    const s = await checkRepo(t.bob, { fetch: true });
    assert.equal(s.state, 'noUpstream');
    assert.equal(await pull(t.bob).then((r) => r.kind), 'noUpstream');
  });

  test('repo with no remote at all', async () => {
    const solo = t.dir + '/solo';
    await git(t.dir, ['init', '-q', '-b', 'main', solo]);
    const s = await checkRepo(solo, { fetch: true });
    assert.equal(s.state, 'noUpstream');
  });

  test('unreachable remote gives a classified error, not a hang', async () => {
    await git(t.bob, ['remote', 'set-url', 'origin', t.dir + '/does-not-exist.git']);
    const s = await checkRepo(t.bob, { fetch: true });
    assert.equal(s.state, 'error');
    assert.ok(s.error);
  });
});

describe('same-file warning (overlap)', () => {
  test('uncommitted, committed-unpushed and new files all count as ours', async () => {
    editLine(t.alice, 'app.txt', 1, 'alice 1');
    write(t.alice, 'readme.md', '# changed by alice\n');
    write(t.alice, 'new.txt', 'alice new');
    write(t.alice, 'only-alice.txt', 'x');
    await commitAndPush(t.alice, 'Alice changes');

    editLine(t.bob, 'app.txt', 5, 'bob 5'); // committed, not pushed
    await commitAll(t.bob, 'Bob local');
    write(t.bob, 'readme.md', '# changed by bob\n'); // uncommitted
    write(t.bob, 'new.txt', 'bob new'); // untracked new file

    const s = await checkRepo(t.bob, { fetch: true });
    assert.equal(s.state, 'behind');
    assert.deepEqual(s.overlap, ['app.txt', 'new.txt', 'readme.md']);
  });

  test('no overlap when we edit different files', async () => {
    write(t.alice, 'a.txt', 'a');
    await commitAndPush(t.alice, 'a');
    write(t.bob, 'b.txt', 'b');
    await git(t.bob, ['fetch', '-q']);
    assert.deepEqual(await overlappingFiles(t.bob), []);
  });
});

describe('pull: "ดึงโค้ดมารวม"', () => {
  test('no local work: fast-forward', async () => {
    write(t.alice, 'feature.txt', 'hello');
    await commitAndPush(t.alice, 'Feature');
    const r = await pull(t.bob);
    assert.equal(r.kind, 'ok');
    if (r.kind !== 'ok') return;
    assert.equal(r.pulled, 1);
    assert.deepEqual(r.files, ['feature.txt']);
    assert.equal(read(t.bob, 'feature.txt'), 'hello');
    assert.equal((await checkRepo(t.bob)).state, 'upToDate');
  });

  test('nothing to pull', async () => {
    assert.equal((await pull(t.bob)).kind, 'upToDate');
  });

  test('uncommitted work in a different file is kept', async () => {
    write(t.alice, 'feature.txt', 'hello');
    await commitAndPush(t.alice, 'Feature');
    editLine(t.bob, 'app.txt', 2, 'bob wip');
    write(t.bob, 'draft.txt', 'untracked draft');
    const r = await pull(t.bob);
    assert.equal(r.kind, 'ok');
    assert.match(read(t.bob, 'app.txt'), /bob wip/);
    assert.equal(read(t.bob, 'draft.txt'), 'untracked draft');
    assert.equal(read(t.bob, 'feature.txt'), 'hello');
    assert.equal(await topStash(t.bob), null, 'autostash must be popped');
  });

  test('same file, different lines, uncommitted: merged cleanly', async () => {
    editLine(t.alice, 'app.txt', 1, 'alice line 1');
    await commitAndPush(t.alice, 'Alice edits line 1');
    editLine(t.bob, 'app.txt', 5, 'bob line 5');
    const r = await pull(t.bob);
    assert.equal(r.kind, 'ok');
    const content = read(t.bob, 'app.txt');
    assert.match(content, /alice line 1/);
    assert.match(content, /bob line 5/);
    const status = await git(t.bob, ['status', '--porcelain']);
    assert.match(status, /^ M app\.txt/m, 'bob change stays uncommitted');
  });

  test('same file, different lines, both committed: merge commit, no conflict', async () => {
    editLine(t.alice, 'app.txt', 1, 'alice line 1');
    await commitAndPush(t.alice, 'Alice edits line 1');
    editLine(t.bob, 'app.txt', 5, 'bob line 5');
    await commitAll(t.bob, 'Bob edits line 5');
    const r = await pull(t.bob);
    assert.equal(r.kind, 'ok');
    const content = read(t.bob, 'app.txt');
    assert.match(content, /alice line 1/);
    assert.match(content, /bob line 5/);
  });

  test('same line, uncommitted: autostash conflict, work safe in stash, auto-drop after staging', async () => {
    editLine(t.alice, 'app.txt', 3, 'alice line 3');
    await commitAndPush(t.alice, 'Alice edits line 3');
    editLine(t.bob, 'app.txt', 3, 'bob line 3');

    const r = await pull(t.bob);
    assert.equal(r.kind, 'autostashConflict');
    if (r.kind !== 'autostashConflict') return;
    assert.deepEqual(r.files, ['app.txt']);

    // Teammate's commit is in, and our work is both in the file and in the stash.
    const content = read(t.bob, 'app.txt');
    assert.match(content, /alice line 3/);
    assert.match(content, /bob line 3/);
    assert.match(content, /<<<<<<< /);
    const stash = await topStash(t.bob);
    assert.equal(stash?.subject, 'autostash');
    assert.equal(stash?.sha, r.stashSha);
    assert.match(await git(t.bob, ['stash', 'show', '-p', 'stash@{0}']), /bob line 3/);

    const c = await getConflictState(t.bob);
    assert.equal(c?.kind, 'autostash');

    // Before staging nothing is dropped.
    assert.equal(await dropAutostashIfResolved(t.bob, r.stashSha), false);
    // Resolve: keep both, stage.
    editLine(t.bob, 'app.txt', 3, 'merged line 3');
    write(t.bob, 'app.txt', read(t.bob, 'app.txt').replace(/<<<<<<< .*\n|=======\n|>>>>>>> .*\n|alice line 3\n|bob line 3\n/g, ''));
    await git(t.bob, ['add', 'app.txt']);
    assert.equal(await getConflictState(t.bob), null);
    assert.equal(await dropAutostashIfResolved(t.bob, r.stashSha), true);
    assert.equal(await topStash(t.bob), null);
  });

  test('autostash drop refuses when the top stash is not "autostash"', async () => {
    editLine(t.alice, 'app.txt', 3, 'alice line 3');
    await commitAndPush(t.alice, 'Alice edits line 3');
    editLine(t.bob, 'app.txt', 3, 'bob line 3');
    const r = await pull(t.bob);
    assert.equal(r.kind, 'autostashConflict');
    write(t.bob, 'app.txt', 'resolved\n');
    await git(t.bob, ['add', 'app.txt']);
    // The user stashes something of their own on top.
    write(t.bob, 'mine.txt', 'precious');
    await git(t.bob, ['add', 'mine.txt']);
    await git(t.bob, ['stash', 'push', '-q', '-m', 'my own stash']);
    assert.equal(await dropAutostashIfResolved(t.bob), false);
    assert.match(await git(t.bob, ['stash', 'list']), /my own stash/);
    assert.match(await git(t.bob, ['stash', 'list']), /autostash/);
  });

  test('same line, committed: merge conflict, then finishMerge commits', async () => {
    editLine(t.alice, 'app.txt', 3, 'alice line 3');
    await commitAndPush(t.alice, 'Alice edits line 3');
    editLine(t.bob, 'app.txt', 3, 'bob line 3');
    await commitAll(t.bob, 'Bob edits line 3');
    write(t.bob, 'notes.txt', 'uncommitted notes'); // untracked work survives
    editLine(t.bob, 'readme.md', 1, '# bob wip'); // tracked uncommitted work survives

    const r = await pull(t.bob);
    assert.equal(r.kind, 'mergeConflict');
    if (r.kind !== 'mergeConflict') return;
    assert.deepEqual(r.files, ['app.txt']);
    assert.equal(r.mergeAutostash, true);
    assert.equal((await checkRepo(t.bob)).state, 'conflict');

    // Not resolved yet → finishMerge refuses.
    assert.equal((await finishMerge(t.bob)).kind, 'blocked');

    write(t.bob, 'app.txt', 'line 1\nline 2\nalice+bob line 3\nline 4\nline 5\n');
    await git(t.bob, ['add', 'app.txt']);
    const f = await finishMerge(t.bob);
    assert.equal(f.kind, 'ok');
    assert.equal(read(t.bob, 'notes.txt'), 'uncommitted notes');
    assert.match(read(t.bob, 'readme.md'), /# bob wip/);
    assert.equal((await checkRepo(t.bob)).state, 'upToDate');
    assert.equal((await checkRepo(t.bob)).ahead, 2);
  });

  test('pressing pull again while a conflict is unresolved is refused without running git pull', async () => {
    editLine(t.alice, 'app.txt', 3, 'alice line 3');
    await commitAndPush(t.alice, 'Alice edits line 3');
    editLine(t.bob, 'app.txt', 3, 'bob line 3');
    await commitAll(t.bob, 'Bob edits line 3');
    assert.equal((await pull(t.bob)).kind, 'mergeConflict');

    // Alice pushes again meanwhile.
    write(t.alice, 'later.txt', 'later');
    await commitAndPush(t.alice, 'Later');
    const head = (await git(t.bob, ['rev-parse', 'HEAD'])).trim();
    const again = await pull(t.bob);
    assert.equal(again.kind, 'blocked');
    if (again.kind === 'blocked') assert.deepEqual(again.conflict.files, ['app.txt']);
    assert.equal((await git(t.bob, ['rev-parse', 'HEAD'])).trim(), head);
    assert.ok((await runGit(t.bob, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).code === 0);
  });

  test('pull again during an autostash conflict is refused', async () => {
    editLine(t.alice, 'app.txt', 3, 'alice line 3');
    await commitAndPush(t.alice, 'Alice edits line 3');
    editLine(t.bob, 'app.txt', 3, 'bob line 3');
    assert.equal((await pull(t.bob)).kind, 'autostashConflict');
    const again = await pull(t.bob);
    assert.equal(again.kind, 'blocked');
    if (again.kind === 'blocked') assert.equal(again.conflict.kind, 'autostash');
  });

  test('untracked file in the way is reported, nothing lost', async () => {
    write(t.alice, 'config.json', '{"alice":true}');
    await commitAndPush(t.alice, 'Add config');
    write(t.bob, 'config.json', '{"bob":true}');
    const r = await pull(t.bob);
    assert.equal(r.kind, 'untrackedInTheWay');
    if (r.kind === 'untrackedInTheWay') assert.deepEqual(r.files, ['config.json']);
    assert.equal(read(t.bob, 'config.json'), '{"bob":true}');
  });

  test('file names with spaces and Thai characters', async () => {
    write(t.alice, 'งาน ใหม่.txt', 'สวัสดี');
    await commitAndPush(t.alice, 'เพิ่มไฟล์ภาษาไทย');
    write(t.bob, 'งาน ใหม่.txt', 'bob');
    const s = await checkRepo(t.bob, { fetch: true });
    assert.deepEqual(s.overlap, ['งาน ใหม่.txt']);
    assert.equal(s.incoming[0].subject, 'เพิ่มไฟล์ภาษาไทย');
  });
});

describe('edge cases found in review', () => {
  test('autostash conflict thrown away with reset --hard: the stash is kept, not dropped', async () => {
    editLine(t.alice, 'app.txt', 3, 'alice line 3');
    await commitAndPush(t.alice, 'Alice edits line 3');
    editLine(t.bob, 'app.txt', 3, 'bob precious line 3');
    const r = await pull(t.bob);
    assert.equal(r.kind, 'autostashConflict');
    if (r.kind !== 'autostashConflict') return;
    await git(t.bob, ['reset', '-q', '--hard']);
    assert.equal(await getConflictState(t.bob), null);
    assert.equal(await dropAutostashIfResolved(t.bob, r.stashSha), false);
    const stash = await topStash(t.bob);
    assert.equal(stash?.sha, r.stashSha);
    assert.match(await git(t.bob, ['stash', 'show', '-p', 'stash@{0}']), /bob precious line 3/);
  });

  test('a stale autostash entry does not make a cherry-pick conflict look like an autostash conflict', async () => {
    editLine(t.alice, 'app.txt', 2, 'alice line 2');
    await commitAndPush(t.alice, 'Alice edits line 2');
    editLine(t.bob, 'app.txt', 2, 'bob line 2');
    assert.equal((await pull(t.bob)).kind, 'autostashConflict');
    await git(t.bob, ['reset', '-q', '--hard']); // the autostash entry stays behind
    await git(t.bob, ['checkout', '-q', '-b', 'side', 'HEAD~1']);
    editLine(t.bob, 'app.txt', 2, 'side line 2');
    await commitAll(t.bob, 'side');
    await git(t.bob, ['checkout', '-q', 'main']);
    assert.notEqual((await runGit(t.bob, ['cherry-pick', 'side'])).code, 0);
    const c = await getConflictState(t.bob);
    assert.equal(c?.kind, 'other');
    assert.deepEqual(c?.files, ['app.txt']);
  });

  test('clone of an empty remote sees the first push', async () => {
    const d = mkdtempSync(join(tmpdir(), 'pushpug-empty-'));
    const remote = join(d, 'r.git');
    await git(d, ['init', '-q', '--bare', '-b', 'main', remote]);
    await git(d, ['clone', '-q', remote, join(d, 'bob')]);
    await git(d, ['clone', '-q', remote, join(d, 'alice')]);
    const a = join(d, 'alice');
    await git(a, ['config', 'user.email', 'a@example.com']);
    await git(a, ['config', 'user.name', 'A']);
    write(a, 'x.txt', 'x');
    await commitAll(a, 'first');
    await git(a, ['push', '-q', 'origin', 'main']);
    const s = await checkRepo(join(d, 'bob'), { fetch: true });
    assert.equal(s.upstream, 'origin/main');
    assert.equal(s.state, 'behind');
    assert.equal(s.behind, 1);
    assert.equal(s.incoming[0]?.subject, 'first');
    assert.deepEqual(await pull(join(d, 'bob')), { kind: 'ok', pulled: 1, files: ['x.txt'], autostashed: false });
    rmSync(d, { recursive: true, force: true });
  });

  test('"403" inside a repo URL is not an auth error; an HTTP 403 is', () => {
    assert.equal(classifyError("fatal: unable to access 'https://github.com/acme/web403.git/': Could not resolve host: github.com"), 'network');
    assert.equal(classifyError("fatal: unable to access 'https://github.com/acme/web.git/': The requested URL returned error: 403"), 'auth');
  });

  test('runGit resolves (never rejects) when git cannot be started', async () => {
    const r = await runGit(t.bob, ['status', 'bad\0arg']);
    assert.notEqual(r.code, 0);
  });

  test('runGit output too large is not reported with the timeout/network code', async () => {
    // A stand-in "git" that prints more than runGit keeps (32 MB). A real git is a wrapper process on
    // Windows: killing it leaves the real git holding the temp folder, so the test couldn't clean up.
    const r = await runGit(t.bob, ['-e', "process.stdout.write('x'.repeat(40 * 1024 * 1024))"], { gitPath: process.execPath });
    assert.equal(r.code, EXIT_OUTPUT_TOO_LARGE);
    assert.notEqual(r.code, EXIT_TIMEOUT);
  });
});
