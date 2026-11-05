import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, parseCheckRuns, parseStatuses, fetchChecks, explainFailure, tailLog, fetchFailureDetail, type ApiResponse, type Requester } from '../src/core/checks';
import { ChecksTracker, type WatchMeta } from '../src/core/checksTracker';
import { githubSlug } from '../src/core/ciRuns';
import { isQuiet } from '../src/core/quiet';

// ---------- a fake GitHub ----------

type Run = { name: string; status?: string; conclusion?: string | null; id?: number };
function fakeGitHub() {
  const state = {
    runs: new Map<string, Run[]>(),
    statuses: new Map<string, Array<{ context: string; state: string }>>(),
    remaining: 4000 as number | undefined,
    resetAt: 1_900_000_000,
    calls: [] as string[],
    unauthorized: false,
  };
  const request: Requester = async (path) => {
    state.calls.push(path);
    const head = { remaining: state.remaining, resetAt: state.resetAt };
    if (state.unauthorized) return { status: 401, ...head };
    if (state.remaining === 0) return { status: 403, ...head };
    if (state.remaining !== undefined) state.remaining--;
    const sha = /commits\/([^/]+)\//.exec(path)?.[1] ?? '';
    if (path.includes('/check-runs')) {
      const runs = (state.runs.get(sha) ?? []).map((r, i) => ({
        id: r.id ?? i + 1,
        name: r.name,
        status: r.status ?? 'completed',
        conclusion: r.conclusion === undefined ? 'success' : r.conclusion,
        app: { slug: 'github-actions' },
        started_at: '2026-10-22T05:00:00Z',
        completed_at: r.status && r.status !== 'completed' ? null : '2026-10-22T05:01:30Z',
      }));
      return { status: 200, json: { check_runs: runs }, ...head };
    }
    return { status: 200, json: { statuses: (state.statuses.get(sha) ?? []).map((s, i) => ({ id: i + 1, ...s })) }, ...head };
  };
  return { state, request };
}

const meta = (over: Partial<WatchMeta> = {}): WatchMeta => ({ mine: true, author: 'Bob', head: true, branch: 'main', ...over });

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('check results', () => {
  test('skipped, neutral and cancelled do not count as failures', () => {
    const items = parseCheckRuns({
      check_runs: [
        { id: 1, name: 'Test', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'Deploy', status: 'completed', conclusion: 'skipped' },
        { id: 3, name: 'Optional', status: 'completed', conclusion: 'neutral' },
        { id: 4, name: 'Old', status: 'completed', conclusion: 'cancelled' },
      ],
    });
    const s = summarize(items);
    assert.equal(s.state, 'success');
    assert.equal(s.failed.length, 0);
  });

  test('timed out and failing statuses count; re-runs keep the newest', () => {
    const s = summarize([
      ...parseCheckRuns({ check_runs: [{ id: 1, name: 'Test', status: 'completed', conclusion: 'failure' }, { id: 9, name: 'Test', status: 'completed', conclusion: 'success' }, { id: 2, name: 'Slow', status: 'completed', conclusion: 'timed_out' }] }),
      ...parseStatuses({ statuses: [{ id: 1, context: 'ci/legacy', state: 'error' }] }),
    ]);
    assert.equal(s.state, 'failure');
    assert.deepEqual(s.failed.map((f) => f.name).sort(), ['Slow', 'ci/legacy']);
    assert.equal(s.items[0].state, 'failure', 'failures listed first');
  });

  test('same job name in two workflows: a failure in one is not hidden by the other', () => {
    const s = summarize(
      parseCheckRuns({
        check_runs: [
          { id: 1, name: 'test', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' }, check_suite: { id: 100 } },
          { id: 2, name: 'test', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 200 } },
          // A re-run inside the same suite still replaces the older run.
          { id: 3, name: 'lint', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' }, check_suite: { id: 100 } },
          { id: 4, name: 'lint', status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 100 } },
        ],
      }),
    );
    assert.equal(s.state, 'failure');
    assert.equal(s.total, 3);
    assert.deepEqual(s.failed.map((f) => f.name), ['test']);
  });

  test('no checks at all', () => assert.equal(summarize([]).state, 'none'));
});

describe('following a commit until its checks finish', () => {
  test('running → all passed: one "pending" event, then one result', async () => {
    const gh = fakeGitHub();
    const c = clock();
    const tr = new ChecksTracker(gh.request, c.now);
    gh.state.runs.set('abc', [{ name: 'Test (ubuntu)', status: 'in_progress' }, { name: 'Lint' }]);
    tr.watch('repo', 'a/b', 'abc', meta());
    const e1 = await tr.tick();
    assert.deepEqual(e1.map((e) => e.type), ['pending']);
    assert.equal(tr.nextDelay(), 20_000, 'asks again in 20 s');
    gh.state.runs.set('abc', [{ name: 'Test (ubuntu)' }, { name: 'Lint' }]);
    c.advance(20_000);
    const e2 = await tr.tick();
    assert.equal(e2.length, 1);
    assert.equal(e2[0].type, 'result');
    if (e2[0].type === 'result') {
      assert.equal(e2[0].summary.state, 'success');
      assert.equal(e2[0].summary.passed, 2);
      assert.equal(e2[0].wasPending, true);
    }
    assert.equal(tr.nextDelay(), null, 'stops asking once finished');
    const calls = gh.state.calls.length;
    c.advance(60_000);
    assert.deepEqual(await tr.tick(), []);
    assert.equal(gh.state.calls.length, calls, 'no more API calls');
  });

  test('running → one failed: reported with the failing check', async () => {
    const gh = fakeGitHub();
    const c = clock();
    const tr = new ChecksTracker(gh.request, c.now);
    gh.state.runs.set('abc', [{ name: 'Test (ubuntu-latest)', status: 'queued' }, { name: 'Test (macos-latest)', status: 'queued' }]);
    tr.watch('repo', 'a/b', 'abc', meta());
    await tr.tick();
    gh.state.runs.set('abc', [{ name: 'Test (ubuntu-latest)', conclusion: 'failure' }, { name: 'Test (macos-latest)' }]);
    c.advance(20_000);
    const [ev] = await tr.tick();
    assert.equal(ev.type, 'result');
    if (ev.type === 'result') {
      assert.equal(ev.summary.state, 'failure');
      assert.equal(ev.summary.total, 2);
      assert.deepEqual(ev.summary.failed.map((f) => f.name), ['Test (ubuntu-latest)']);
    }
  });

  test('only skipped checks → passes, no failure', async () => {
    const gh = fakeGitHub();
    const tr = new ChecksTracker(gh.request, clock().now);
    gh.state.runs.set('abc', [{ name: 'Deploy', conclusion: 'skipped' }, { name: 'Build' }]);
    tr.watch('repo', 'a/b', 'abc', meta());
    const [ev] = await tr.tick();
    assert.equal(ev.type, 'result');
    if (ev.type === 'result') assert.equal(ev.summary.state, 'success');
  });

  test('failed → a newer commit passes: "fixed, safe to pull"', async () => {
    const gh = fakeGitHub();
    const c = clock();
    const tr = new ChecksTracker(gh.request, c.now);
    gh.state.runs.set('bad', [{ name: 'Test', conclusion: 'failure' }]);
    tr.watch('repo', 'a/b', 'bad', meta({ mine: false, author: 'Boss' }));
    assert.deepEqual((await tr.tick()).map((e) => e.type), ['result']);
    gh.state.runs.set('good', [{ name: 'Test', status: 'in_progress' }]);
    tr.watch('repo', 'a/b', 'good', meta({ mine: false, author: 'Boss' }));
    c.advance(1);
    await tr.tick();
    gh.state.runs.set('good', [{ name: 'Test' }]);
    c.advance(20_000);
    const evs = await tr.tick();
    assert.deepEqual(evs.map((e) => e.type), ['result', 'recovered']);
    const rec = evs[1];
    if (rec.type === 'recovered') assert.equal(rec.previousSha, 'bad');
  });

  test('not signed in: no API calls, one request to sign in', async () => {
    const tr = new ChecksTracker(null, clock().now);
    tr.watch('repo', 'a/b', 'abc', meta());
    assert.deepEqual(await tr.tick(), [{ type: 'needsAuth' }]);
    assert.deepEqual(await tr.tick(), [], 'asked once');
    assert.equal(tr.nextDelay(), null);
  });

  test('token rejected (401): stops and asks to sign in', async () => {
    const gh = fakeGitHub();
    gh.state.unauthorized = true;
    const tr = new ChecksTracker(gh.request, clock().now);
    tr.watch('repo', 'a/b', 'abc', meta());
    assert.deepEqual((await tr.tick()).map((e) => e.type), ['needsAuth']);
    assert.equal(tr.nextDelay(), null);
  });

  test('rate limit: waits until reset; low remaining → polls 4× slower', async () => {
    const gh = fakeGitHub();
    const c = clock(1_000_000);
    const tr = new ChecksTracker(gh.request, c.now);
    gh.state.runs.set('abc', [{ name: 'Test', status: 'in_progress' }]);
    gh.state.remaining = 20;
    tr.watch('repo', 'a/b', 'abc', meta());
    await tr.tick();
    assert.equal(tr.nextDelay(), 80_000, 'slowed down');
    gh.state.remaining = 0;
    gh.state.resetAt = 1_000_000 + 600_000;
    c.advance(80_000);
    assert.deepEqual((await tr.tick()).map((e) => e.type), ['rateLimited']);
    assert.equal(tr.nextDelay(), 1_600_000 - c.now(), 'waits for the reset time');
    const calls = gh.state.calls.length;
    c.advance(1000);
    await tr.tick();
    assert.equal(gh.state.calls.length, calls, 'no calls while limited');
  });

  test('remote not on GitHub: nothing is watched', async () => {
    const gh = fakeGitHub();
    const tr = new ChecksTracker(gh.request, clock().now);
    tr.watch('repo', githubSlug('https://gitlab.com/a/b.git'), 'abc', meta());
    assert.deepEqual(await tr.tick(), []);
    assert.equal(gh.state.calls.length, 0);
    assert.equal(tr.nextDelay(), null);
  });

  test('a commit with no checks yet is asked about for 3 minutes, then left alone', async () => {
    const gh = fakeGitHub();
    const c = clock();
    const tr = new ChecksTracker(gh.request, c.now);
    tr.watch('repo', 'a/b', 'abc', meta());
    await tr.tick();
    assert.equal(tr.nextDelay(), 20_000);
    c.advance(3 * 60_000 + 1);
    await tr.tick();
    assert.equal(tr.nextDelay(), null);
  });
});

describe('fetchChecks / failure details', () => {
  test('two requests: check runs and statuses', async () => {
    const gh = fakeGitHub();
    gh.state.statuses.set('abc', [{ context: 'netlify', state: 'pending' }]);
    const r = await fetchChecks(gh.request, 'a/b', 'abc');
    assert.equal(r.kind, 'ok');
    if (r.kind === 'ok') assert.equal(r.summary.state, 'pending');
    assert.deepEqual(gh.state.calls, ['/repos/a/b/commits/abc/check-runs?per_page=100', '/repos/a/b/commits/abc/status?per_page=100']);
  });

  test('log tail: timestamps and colours removed, last 30 lines', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `2026-10-22T05:45:06.4605659Z \u001b[31mline ${i}\u001b[0m`).join('\n');
    const tail = tailLog(raw);
    assert.equal(tail.length, 30);
    assert.equal(tail[29], 'line 49');
  });

  test('log tail stops at the error that failed the job', () => {
    const raw = ['2026-10-22T05:45:00Z ✖ login test', '2026-10-22T05:45:01Z ##[error]Process completed with exit code 1.', '2026-10-22T05:45:02Z Post job cleanup.', '2026-10-22T05:45:03Z Cleaning up orphan processes', '2026-10-22T05:45:04Z ##[warning]Node.js 20 is deprecated'].join('\n');
    assert.deepEqual(tailLog(raw), ['✖ login test', '##[error]Process completed with exit code 1.']);
  });

  test('known failure kinds', () => {
    assert.equal(explainFailure('Run npm test', ['  3 failing']), 'tests');
    assert.equal(explainFailure('Install dependencies', ['npm ERR! ERESOLVE unable to resolve dependency tree']), 'install');
    assert.equal(explainFailure('Lint', ['✖ 4 problems (4 errors, 0 warnings)']), 'lint');
    assert.equal(explainFailure('Build', ['##[error]The job running on runner X has exceeded the maximum execution time of 10 minutes.']), 'timeout');
    assert.equal(explainFailure('Typecheck', ['src/a.ts(1,1): error TS2322: nope']), 'build');
    assert.equal(explainFailure('Deploy', ['something odd']), undefined);
  });

  test('failed step + log of a GitHub Actions job', async () => {
    const request: Requester = async (path) => {
      if (path.endsWith('/logs')) return { status: 200, text: '2026-10-22T05:45:06Z Run npm test\n2026-10-22T05:45:07Z   2 failing' } as ApiResponse;
      return { status: 200, json: { steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'Run npm test', conclusion: 'failure' }] } };
    };
    const d = await fetchFailureDetail(request, 'a/b', { id: 'run-7', name: 'Test', state: 'failure', conclusion: 'failure', jobId: 7, url: 'https://github.com/x' });
    assert.equal(d.step, 'Run npm test');
    assert.deepEqual(d.log, ['Run npm test', '  2 failing']);
    assert.equal(d.kind, 'tests');
  });
});

describe('do not disturb', () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 22, h, m);
  const q = { enabled: true, start: '22:00', end: '08:00' };
  test('quiet inside the hours (across midnight), not outside', () => {
    assert.equal(isQuiet(q, undefined, at(23)), true);
    assert.equal(isQuiet(q, undefined, at(7, 59)), true);
    assert.equal(isQuiet(q, undefined, at(8)), false);
    assert.equal(isQuiet(q, undefined, at(14)), false);
    assert.equal(isQuiet({ ...q, enabled: false }, undefined, at(23)), false);
  });
  test('snooze for an hour', () => {
    const now = at(14);
    assert.equal(isQuiet(undefined, now.getTime() + 60_000, now), true);
    assert.equal(isQuiet(undefined, now.getTime() - 1, now), false);
  });
});
