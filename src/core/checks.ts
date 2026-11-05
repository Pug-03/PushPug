// GitHub checks for a commit: check runs (GitHub Actions and other apps) plus
// classic commit statuses, the way GitHub's "Some checks were not successful"
// box shows them. No `vscode` import: the extension calls GitHub with fetch,
// the background worker through the `gh` CLI.

export type CheckState = 'pending' | 'success' | 'failure' | 'skipped' | 'cancelled';

export interface CheckItem {
  id: string;
  name: string;
  state: CheckState;
  /** Raw GitHub conclusion / state, e.g. "timed_out". */
  conclusion: string | null;
  startedAt?: number;
  completedAt?: number;
  url?: string;
  /** GitHub Actions job id (check run id) when logs can be fetched. */
  jobId?: number;
}

export type Overall = 'none' | 'pending' | 'success' | 'failure';

export interface CheckSummary {
  state: Overall;
  total: number;
  passed: number;
  pending: number;
  failed: CheckItem[];
  items: CheckItem[];
}

/** Answer from GitHub, through fetch or the gh CLI. */
export interface ApiResponse {
  status: number;
  json?: unknown;
  text?: string;
  /** x-ratelimit-remaining / x-ratelimit-reset (epoch seconds), when known. */
  remaining?: number;
  resetAt?: number;
}
export type Requester = (path: string, opts?: { raw?: boolean; method?: 'GET' | 'POST'; body?: unknown }) => Promise<ApiResponse>;

const PENDING_RUN = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

function runState(status: string, conclusion: string | null): CheckState {
  if (PENDING_RUN.has(status) || !conclusion) return 'pending';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'skipped' || conclusion === 'neutral' || conclusion === 'stale') return 'skipped';
  if (conclusion === 'cancelled') return 'cancelled';
  return 'failure'; // failure, timed_out, action_required, startup_failure
}

function statusState(state: string): CheckState {
  if (state === 'success') return 'success';
  if (state === 'pending') return 'pending';
  return 'failure'; // failure, error
}

const time = (s?: string | null) => (s ? Date.parse(s) : undefined);

interface ApiCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string;
  details_url?: string;
  app?: { slug?: string };
  check_suite?: { id?: number } | null;
}
interface ApiStatus {
  id: number;
  context: string;
  state: string;
  description?: string | null;
  target_url?: string | null;
  created_at?: string;
  updated_at?: string;
}

export function parseCheckRuns(json: unknown): CheckItem[] {
  const runs = ((json as { check_runs?: ApiCheckRun[] })?.check_runs ?? []) as ApiCheckRun[];
  // A re-run shows up as a second run with the same name in the same check
  // suite: keep the newest. Two workflows (suites) or apps can each have a
  // job called e.g. "test"; those stay separate so one can't hide the other.
  const byName = new Map<string, ApiCheckRun>();
  for (const r of runs) {
    const group = r.check_suite?.id != null ? `suite:${r.check_suite.id}` : `app:${r.app?.slug ?? ''}`;
    const key = `${group}\0${r.name}`;
    const prev = byName.get(key);
    if (!prev || r.id > prev.id) byName.set(key, r);
  }
  return [...byName.values()].map((r) => ({
    id: `run-${r.id}`,
    name: r.name,
    state: runState(r.status, r.conclusion),
    conclusion: r.conclusion ?? r.status,
    startedAt: time(r.started_at),
    completedAt: time(r.completed_at),
    url: r.html_url ?? r.details_url,
    jobId: r.app?.slug === 'github-actions' ? r.id : undefined,
  }));
}

export function parseStatuses(json: unknown): CheckItem[] {
  // The combined status lists the latest status per context.
  const list = ((json as { statuses?: ApiStatus[] })?.statuses ?? []) as ApiStatus[];
  return list.map((s) => ({
    id: `status-${s.id}`,
    name: s.context,
    state: statusState(s.state),
    conclusion: s.state,
    startedAt: time(s.created_at),
    completedAt: s.state === 'pending' ? undefined : time(s.updated_at),
    url: s.target_url ?? undefined,
  }));
}

/** Skipped, neutral and cancelled checks don't count as failures. */
export function summarize(items: CheckItem[]): CheckSummary {
  const failed = items.filter((i) => i.state === 'failure');
  const pending = items.filter((i) => i.state === 'pending').length;
  const passed = items.filter((i) => i.state === 'success').length;
  const state: Overall = items.length === 0 ? 'none' : pending ? 'pending' : failed.length ? 'failure' : 'success';
  const order: Record<CheckState, number> = { failure: 0, pending: 1, cancelled: 2, success: 3, skipped: 4 };
  const sorted = [...items].sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name));
  return { state, total: items.filter((i) => i.state !== 'skipped').length, passed, pending, failed, items: sorted };
}

export type ChecksResult =
  | { kind: 'ok'; summary: CheckSummary; remaining?: number; resetAt?: number }
  | { kind: 'rateLimited'; resetAt?: number }
  | { kind: 'needsAuth' }
  | { kind: 'notFound' }
  | { kind: 'error'; status: number };

/** Check runs + commit statuses of one commit: two requests. */
export async function fetchChecks(request: Requester, slug: string, sha: string): Promise<ChecksResult> {
  let runs: ApiResponse;
  let statuses: ApiResponse;
  try {
    [runs, statuses] = await Promise.all([
      request(`/repos/${slug}/commits/${sha}/check-runs?per_page=100`),
      request(`/repos/${slug}/commits/${sha}/status?per_page=100`),
    ]);
  } catch {
    return { kind: 'error', status: 0 };
  }
  for (const r of [runs, statuses]) {
    if ((r.status === 403 || r.status === 429) && r.remaining === 0) return { kind: 'rateLimited', resetAt: r.resetAt };
    if (r.status === 401) return { kind: 'needsAuth' };
    if (r.status === 404) return { kind: 'notFound' };
    if (r.status >= 400) return { kind: 'error', status: r.status };
  }
  const items = [...parseCheckRuns(runs.json), ...parseStatuses(statuses.json)];
  const remaining = Math.min(runs.remaining ?? Infinity, statuses.remaining ?? Infinity);
  return {
    kind: 'ok',
    summary: summarize(items),
    remaining: Number.isFinite(remaining) ? remaining : undefined,
    resetAt: runs.resetAt ?? statuses.resetAt,
  };
}

// ---------- why did it fail? ----------

export type FailureKind = 'tests' | 'install' | 'lint' | 'timeout' | 'build';

export interface FailureDetail {
  step?: string;
  /** Last lines of the job log (timestamps and colour codes removed). */
  log: string[];
  kind?: FailureKind;
  url?: string;
}

/** Plain-language category for a failing step, when it's a common one. */
export function explainFailure(step: string | undefined, log: string[], conclusion?: string | null): FailureKind | undefined {
  const s = (step ?? '').toLowerCase();
  const text = log.join('\n');
  if (conclusion === 'timed_out' || /exceeded the maximum execution time|timed out after|has timed out|The job running on runner .* has exceeded/i.test(text)) return 'timeout';
  if (/install|dependenc|setup|npm ci|pip|bundle|restore/.test(s) || /npm ERR!|ERESOLVE|ETARGET|Could not find a version|No matching distribution|Could not resolve dependencies|yarn install|error: failed to download/i.test(text)) return 'install';
  if (/lint|eslint|prettier|format|ruff|flake8|stylelint|clippy/.test(s) || /\d+ problems? \(\d+ errors?|Code style issues found|would reformat|eslint/i.test(text)) return 'lint';
  if (/\btest|spec|jest|pytest|vitest|mocha/.test(s) || /\b\d+ (failing|failed)\b|AssertionError|Tests?:\s+\d+ failed|FAILED |not ok \d|✖|FAIL /i.test(text)) return 'tests';
  if (/build|compile|tsc|typecheck/.test(s) || /error TS\d+|compilation failed|Build failed|cannot find symbol/i.test(text)) return 'build';
  return undefined;
}

/** Strip "2026-10-22T05:45:06.4605659Z " prefixes and ANSI colours; keep the last `n` useful lines. */
export function tailLog(raw: string, n = 30): string[] {
  let lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/\u001b\[[0-9;]*m/g, '').replace(/^##\[(group|endgroup)\].*$/, ''))
    .filter((l) => l.trim() && !/^##\[(debug|warning)\]/.test(l));
  // Stop at the error that failed the job: what follows is clean-up noise.
  let last = -1;
  lines.forEach((l, i) => {
    if (/^##\[error\]/.test(l)) last = i;
  });
  if (last >= 0) lines = lines.slice(0, last + 1);
  else lines = lines.filter((l) => !/^Post job cleanup|^Cleaning up orphan processes/.test(l));
  return lines.slice(-n);
}

/** The failed step and the end of its log (GitHub Actions jobs only). */
export async function fetchFailureDetail(request: Requester, slug: string, item: CheckItem): Promise<FailureDetail> {
  if (!item.jobId) return { log: [], url: item.url };
  const job = await request(`/repos/${slug}/actions/jobs/${item.jobId}`).catch(() => ({ status: 0 }) as ApiResponse);
  const steps = ((job.json as { steps?: Array<{ name: string; conclusion: string | null }> })?.steps ?? []);
  const step = steps.find((s) => s.conclusion === 'failure')?.name;
  const logs = await request(`/repos/${slug}/actions/jobs/${item.jobId}/logs`, { raw: true }).catch(() => ({ status: 0 }) as ApiResponse);
  const log = logs.status === 200 && logs.text ? tailLog(logs.text) : [];
  return { step, log, kind: explainFailure(step, log, item.conclusion), url: item.url };
}
