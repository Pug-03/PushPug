import * as vscode from 'vscode';
import { runGit } from '../git/exec';
import { workingTreeFiles, getConflictState } from '../git/repo';
import {
  taskBase,
  availableBranchName,
  commitsNotOnBase,
  startTask,
  moveCommitsToBranch,
  pushBranch,
  fetchBase,
  switchToBase,
  deleteTaskBranch,
  type TaskBase,
  type BranchResult,
} from '../git/branches';
import {
  findPullRequest,
  createPullRequest,
  listOpenPullRequests,
  currentLogin,
  compareUrl,
  prTitle,
  prBody,
  type PullRequest,
} from '../core/pullRequests';
import type { Requester } from '../core/checks';
import { githubSlug } from '../core/ciRuns';
import { listFiles } from '../core/messages';
import { repoKey } from '../core/storage';
import { readSettings, type PrWorkflow } from './settings';
import { t } from './l10n';
import { showGitError, type Actions } from './actions';
import { fetchRequester, type ChecksWatcher } from './checks';
import type { Alerts } from './alerts';
import type { RepoEntry, RepoManager } from './repoManager';

/** Own pull request: looked up at most this often (and right after PushPug's own actions). */
const OWN_PR_GAP_MS = 60_000;
/** Teammates' new pull requests: looked up at most this often. */
const TEAM_PR_GAP_MS = 120_000;
const SEEN_KEY = 'pushpug.prSeen';
const ANNOUNCED_KEY = 'pushpug.prAnnounced';
const TITLES_KEY = 'pushpug.taskTitles';

interface RepoPr {
  base: TaskBase | null;
  slug: string | null;
  branch: string | null;
  /** Commits on this branch that main doesn't have. */
  unpushed: number;
  pr: PullRequest | null;
  /** Branch the pull request above belongs to. */
  prBranch: string | null;
  /** Branch last looked up, and when the next lookup is allowed. */
  lookedBranch: string | null;
  nextLookAt: number;
}

/** What the team view shows about the current task. */
export interface PrView {
  base: string;
  branch: string;
  onBase: boolean;
  unpushed: number;
  github: boolean;
  workflow: PrWorkflow;
  pr: { number: number; title: string; url: string; status: PullRequest['status'] } | null;
}

/**
 * The pull request workflow: start a task on its own branch, send it for
 * review (push + open the pull request), follow it (merged, closed, conflicts
 * with main), and go back to main afterwards. Also tells you when a teammate
 * opens a pull request.
 */
export class PullRequests implements vscode.Disposable {
  private readonly state = new Map<string, RepoPr>();
  private readonly teamLookedAt = new Map<string, number>();
  /** Repos whose check is running: checks can overlap now that they don't hold the repo lock. */
  private readonly busy = new Set<string>();
  /** Checks asked for while one was running (value: whether any of them was forced). */
  private readonly again = new Map<string, boolean>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  /** Signed-in GitHub login; only a successful answer is kept. */
  private login: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly actions: Actions,
    private readonly alerts: Alerts,
    private readonly ci: ChecksWatcher,
    private readonly log: vscode.OutputChannel,
  ) {
    repos.onDidCheck((entry) => void this.onCheck(entry));
  }

  get enabled(): boolean {
    return readSettings().prEnabled;
  }

  private async request(): Promise<Requester | null> {
    const token = await this.ci.githubToken();
    return token ? fetchRequester(token) : null;
  }

  private async slugOf(root: string, base: TaskBase | null): Promise<string | null> {
    if (!base) return null;
    const r = await runGit(root, ['remote', 'get-url', base.remote]);
    return r.code === 0 ? githubSlug(r.stdout.trim()) : null;
  }

  /** After every check of a repo: where the task stands, and its pull request. */
  private async onCheck(entry: RepoEntry, force = false): Promise<void> {
    if (!this.enabled) return;
    const key = repoKey(entry.root);
    if (this.busy.has(key)) {
      // A check is running (maybe for the branch we just left): run once more when it's done.
      this.again.set(key, (this.again.get(key) ?? false) || force);
      return;
    }
    this.busy.add(key);
    try {
      await this.check(entry, key, force);
    } finally {
      this.busy.delete(key);
    }
    const again = this.again.get(key);
    if (again !== undefined) {
      this.again.delete(key);
      await this.onCheck(entry, again);
    }
  }

  private async check(entry: RepoEntry, key: string, force: boolean): Promise<void> {
    const base = await taskBase(entry.root).catch(() => null);
    const slug = await this.slugOf(entry.root, base);
    const branch = entry.snapshot?.branch ?? null;
    const unpushed = base ? (await commitsNotOnBase(entry.root, base.baseRef)).length : 0;
    const prev = this.state.get(key);
    const sameBranch = prev?.lookedBranch === branch;
    const s: RepoPr = {
      base,
      slug,
      branch,
      unpushed,
      pr: prev && prev.prBranch === branch ? prev.pr : null,
      prBranch: prev && prev.prBranch === branch ? prev.prBranch : null,
      lookedBranch: sameBranch ? prev!.lookedBranch : null,
      nextLookAt: sameBranch ? prev!.nextLookAt : 0,
    };
    this.state.set(key, s);
    const request = slug ? await this.request() : null;
    if (request && slug && base && branch && branch !== base.base && (force || Date.now() >= s.nextLookAt)) {
      s.lookedBranch = branch;
      s.nextLookAt = Date.now() + OWN_PR_GAP_MS;
      const found = await findPullRequest(request, slug, branch);
      if (found.kind === 'ok') {
        s.pr = found.pr;
        s.prBranch = branch;
        if (found.pr) void this.onOwnPr(entry, slug, found.pr);
      } else {
        // Rate limited: wait for GitHub's reset instead of asking again every minute.
        if (found.kind === 'rateLimited') s.nextLookAt = Math.max(s.nextLookAt, found.resetAt ?? Date.now() + 15 * 60_000);
        this.log.appendLine(`[pr] ${entry.name}: lookup ${found.kind}`);
      }
    }
    this.emitter.fire();
    if (request && slug && readSettings().prNotifyTeam && Date.now() - (this.teamLookedAt.get(slug) ?? 0) >= TEAM_PR_GAP_MS) {
      this.teamLookedAt.set(slug, Date.now());
      void this.checkTeamPrs(entry, request, slug);
    }
  }

  private announced(id: string): boolean {
    const all = this.context.globalState.get<string[]>(ANNOUNCED_KEY, []);
    if (all.includes(id)) return true;
    void this.context.globalState.update(ANNOUNCED_KEY, [...all, id].slice(-200));
    return false;
  }

  /** Say so when my pull request gets merged, closed, or starts to conflict with main. */
  private async onOwnPr(entry: RepoEntry, slug: string, pr: PullRequest): Promise<void> {
    // Quiet hours / snooze: don't mark it as told; it's announced on the first check afterwards.
    // (announced() remembers what was told, so later checks don't repeat it.)
    if (this.alerts.isQuiet()) return;
    const id = `${slug}#${pr.number}`;
    if (pr.status === 'merged') {
      if (this.announced(`${id}:merged`)) return;
      const back = t('pr.btn.backToMain');
      const choice = await this.alerts.announce({ root: entry.root, level: 'info', title: t('pr.merged', pr.number), body: pr.title, buttons: [back], desktop: true, desktopPrimary: 'show' });
      if (choice === back) await this.finishTask(entry.root);
    } else if (pr.status === 'closed') {
      if (this.announced(`${id}:closed`)) return;
      const open = t('pr.btn.open');
      const choice = await this.alerts.announce({ root: entry.root, level: 'warn', title: t('pr.closed', pr.number), body: pr.title, buttons: [open] });
      if (choice === open) await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    } else if (pr.status === 'conflict') {
      if (this.announced(`${id}:conflict:${pr.headSha}`)) return;
      const update = t('pr.btn.updateFromMain');
      const choice = await this.alerts.announce({ root: entry.root, level: 'warn', title: t('pr.conflict', pr.number, pr.base), body: t('pr.conflictBody'), buttons: [update], desktop: true, desktopPrimary: 'show' });
      if (choice === update) await this.updateFromMain(entry.root);
    }
  }

  /** A teammate opened a pull request: tell once per pull request. The first look only remembers what's there. */
  private async checkTeamPrs(entry: RepoEntry, request: Requester, slug: string): Promise<void> {
    const open = await listOpenPullRequests(request, slug);
    if (!open) return;
    // Without knowing who "me" is, my own pull requests would look like a teammate's.
    this.login ??= (await currentLogin(request)) ?? undefined;
    if (!this.login) return;
    const all = this.context.globalState.get<Record<string, number[]>>(SEEN_KEY, {});
    const firstLook = !all[slug];
    const seen = new Set(all[slug] ?? []);
    const fresh = open.filter((p) => !seen.has(p.number) && p.author !== this.login);
    // Quiet hours / snooze: leave them unseen so they're announced afterwards.
    if (!firstLook && fresh.length && this.alerts.isQuiet()) return;
    all[slug] = [...new Set([...seen, ...open.map((p) => p.number)])].slice(-300);
    await this.context.globalState.update(SEEN_KEY, all);
    if (firstLook) return;
    for (const pr of fresh.slice(0, 3)) {
      const view = t('pr.btn.open');
      const choice = await this.alerts.announce({ root: entry.root, level: 'info', title: t('pr.teamOpened', pr.author, pr.number), body: pr.title, buttons: [view] });
      if (choice === view) await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    }
  }

  // ---------- commands ----------

  private async entryFor(root?: string): Promise<{ entry: RepoEntry; base: TaskBase } | undefined> {
    const entry = root ? this.repos.get(root) : await this.actions.pickRepo(() => true);
    if (!entry) return undefined;
    const base = await taskBase(entry.root);
    if (!base) {
      void vscode.window.showWarningMessage(t('pr.noBase'));
      return undefined;
    }
    return { entry, base };
  }

  private titles(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(TITLES_KEY, {});
  }

  private async rememberTitle(root: string, branch: string, title: string): Promise<void> {
    const all = this.titles();
    all[`${repoKey(root)}|${branch}`] = title;
    await this.context.workspaceState.update(TITLES_KEY, all);
  }

  /** Ask for a short description of the task; the branch name is made from it. */
  private async askBranch(root: string, value = ''): Promise<{ name: string; title: string } | undefined> {
    const title = await vscode.window.showInputBox({ title: t('pr.start.title'), prompt: t('pr.start.prompt'), placeHolder: t('pr.start.placeholder'), value, ignoreFocusOut: true });
    if (title === undefined) return undefined;
    const name = await availableBranchName(root, title);
    return { name, title: title.trim() };
  }

  private async reportBranchResult(r: BranchResult): Promise<boolean> {
    switch (r.kind) {
      case 'ok':
        return true;
      case 'invalid':
        void vscode.window.showWarningMessage(t('pr.badName'));
        return false;
      case 'exists':
        void vscode.window.showWarningMessage(t('pr.nameExists'));
        return false;
      case 'noBase':
        void vscode.window.showWarningMessage(t('pr.noBase'));
        return false;
      case 'conflict':
        void vscode.window.showWarningMessage(t('pr.conflictFirst'));
        return false;
      case 'localChanges':
        void vscode.window.showWarningMessage(t('pr.localChanges', listFiles(r.files)));
        return false;
      case 'error':
        await showGitError(r.message, r.code);
        return false;
    }
  }

  /** "Start a new task": a new branch from the latest main. */
  async startTask(root?: string): Promise<void> {
    const ctx = await this.entryFor(root);
    if (!ctx) return;
    const { entry, base } = ctx;
    const onBase = entry.snapshot?.branch === base.base;
    const waiting = onBase ? await commitsNotOnBase(entry.root, base.baseRef) : [];
    let move = false;
    if (waiting.length) {
      // Commits already made on main: they belong in this task, or they'd be stuck on the local main.
      const yes = t('pr.btn.moveCommits');
      const choice = await vscode.window.showWarningMessage(t('pr.start.hasCommits', waiting.length, base.base), { modal: true }, yes);
      if (choice !== yes) return;
      move = true;
    }
    const picked = await this.askBranch(entry.root, move && waiting.length === 1 ? waiting[0].subject : '');
    if (!picked) return;
    const r = await this.repos.withLock(entry.root, () => (move ? moveCommitsToBranch(entry.root, picked.name, base) : startTask(entry.root, picked.name, base)));
    this.log.appendLine(`[pr] ${entry.name}: start ${picked.name} → ${r.kind}`);
    if (!(await this.reportBranchResult(r))) return;
    if (picked.title) await this.rememberTitle(entry.root, picked.name, picked.title);
    await this.repos.refresh(entry.root, { fetch: false });
    const send = t('pr.btn.send');
    const choice = await vscode.window.showInformationMessage(move ? t('pr.start.movedOk', picked.name, base.base) : t('pr.start.ok', picked.name, base.base), ...(move ? [send] : []));
    if (choice === send) await this.sendForReview(entry.root);
  }

  /** "Send for review": push the task branch and open (or update) its pull request. */
  async sendForReview(root?: string): Promise<void> {
    const ctx = await this.entryFor(root);
    if (!ctx) return;
    const { entry, base } = ctx;
    if (await getConflictState(entry.root)) {
      void vscode.window.showWarningMessage(t('pr.conflictFirst'));
      return;
    }
    let branch = entry.snapshot?.branch ?? null;
    if (!branch) {
      void vscode.window.showWarningMessage(t('pull.detached'));
      return;
    }
    const uncommitted = await workingTreeFiles(entry.root);
    if (uncommitted.length) {
      const commit = t('pr.btn.commitFirst');
      const anyway = t('pr.btn.sendAnyway');
      const choice = await vscode.window.showWarningMessage(t('pr.send.uncommitted', uncommitted.length), commit, anyway);
      if (choice === commit) await vscode.commands.executeCommand('workbench.view.scm');
      if (choice !== anyway) return;
    }
    await this.repos.withLock(entry.root, () => fetchBase(entry.root, base));
    let commits = await commitsNotOnBase(entry.root, base.baseRef);
    if (!commits.length) {
      const start = t('pr.btn.startTask');
      const choice = await vscode.window.showInformationMessage(t('pr.send.nothing', base.base), ...(branch === base.base ? [start] : []));
      if (choice === start) await this.startTask(entry.root);
      return;
    }
    if (branch === base.base) {
      // Committed straight on main: move the commits to a task branch first.
      const picked = await this.askBranch(entry.root, commits.length === 1 ? commits[0].subject : '');
      if (!picked) return;
      const moved = await this.repos.withLock(entry.root, () => moveCommitsToBranch(entry.root, picked.name, base));
      this.log.appendLine(`[pr] ${entry.name}: move to ${picked.name} → ${moved.kind}`);
      if (!(await this.reportBranchResult(moved))) return;
      if (picked.title) await this.rememberTitle(entry.root, picked.name, picked.title);
      branch = picked.name;
      commits = await commitsNotOnBase(entry.root, base.baseRef);
    }
    const target = branch;
    const pushed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('pr.send.progress', target) }, () =>
      this.repos.withLock(entry.root, () => pushBranch(entry.root, base.remote, target)),
    );
    this.log.appendLine(`[pr] ${entry.name}: push ${target} → ${pushed.kind}`);
    await this.repos.refresh(entry.root, { fetch: false });
    if (pushed.kind === 'rejected') {
      await this.actions.offerMergeThenPush(entry, t('pr.send.rejected'), pushed.message);
      return;
    }
    if (pushed.kind !== 'ok') {
      await showGitError(pushed.message, pushed.kind === 'error' ? pushed.code : 'other');
      return;
    }
    const slug = await this.slugOf(entry.root, base);
    if (!slug) {
      void vscode.window.showInformationMessage(t('pr.send.pushedOnly', target));
      return;
    }
    let request = await this.request();
    if (!request && (await this.ci.signIn())) request = await this.request();
    const title = this.titles()[`${repoKey(entry.root)}|${target}`] || prTitle(commits, target);
    const fallback = async (why: string) => {
      this.log.appendLine(`[pr] ${entry.name}: opening the GitHub page instead (${why})`);
      const open = t('pr.btn.finishOnGitHub');
      const choice = await vscode.window.showInformationMessage(t('pr.send.finishOnGitHub', target), open);
      if (choice === open) await vscode.env.openExternal(vscode.Uri.parse(compareUrl(slug, base.base, target)));
    };
    if (!request) return fallback('not signed in');
    const existing = await findPullRequest(request, slug, target);
    if (existing.kind === 'ok' && existing.pr && (existing.pr.status === 'open' || existing.pr.status === 'draft' || existing.pr.status === 'conflict')) {
      await this.afterSend(entry, existing.pr, t('pr.send.updated', commits.length, existing.pr.number));
      return;
    }
    const created = await createPullRequest(request, slug, { title, body: prBody(commits), head: target, base: base.base });
    this.log.appendLine(`[pr] ${entry.name}: create → ${created.kind}${created.kind === 'error' ? ` ${created.status} ${created.message ?? ''}` : ''}`);
    if (created.kind === 'created' || created.kind === 'exists') await this.afterSend(entry, created.pr, t('pr.send.opened', created.pr.number));
    else if (created.kind === 'noCommits') void vscode.window.showInformationMessage(t('pr.send.nothing', base.base));
    else await fallback(created.kind);
  }

  private async afterSend(entry: RepoEntry, pr: PullRequest, text: string): Promise<void> {
    const s = this.state.get(repoKey(entry.root));
    if (s) {
      s.pr = pr;
      s.prBranch = pr.head;
      s.lookedBranch = pr.head;
      s.nextLookAt = Date.now() + OWN_PR_GAP_MS;
    }
    this.emitter.fire();
    const open = t('pr.btn.open');
    const choice = await vscode.window.showInformationMessage(text, open);
    if (choice === open) await vscode.env.openExternal(vscode.Uri.parse(pr.url));
  }

  /** "Get the latest main": merge main into the task branch so the pull request stops conflicting. */
  async updateFromMain(root?: string): Promise<void> {
    const ctx = await this.entryFor(root);
    if (!ctx) return;
    const { entry, base } = ctx;
    if (entry.snapshot?.branch === base.base) return void this.actions.pull(entry.root);
    const f = await this.repos.withLock(entry.root, () => fetchBase(entry.root, base));
    if (!f.ok) return showGitError(f.message, f.code);
    const r = await this.actions.mergeFrom(entry.root, base.baseRef);
    if (r?.kind !== 'ok') return;
    const send = t('pr.btn.send');
    const choice = await vscode.window.showInformationMessage(t('pr.updated', base.base), send);
    if (choice === send) await this.sendForReview(entry.root);
  }

  /** "Back to main": after the merge, switch to main, pull, and delete the finished branch. */
  async finishTask(root?: string): Promise<void> {
    const ctx = await this.entryFor(root);
    if (!ctx) return;
    const { entry, base } = ctx;
    const branch = entry.snapshot?.branch;
    if (!branch || branch === base.base) {
      void vscode.window.showInformationMessage(t('pr.finish.onBase', base.base));
      return;
    }
    const s = this.state.get(repoKey(entry.root));
    const pr = s?.prBranch === branch ? s.pr : null;
    if (pr?.status !== 'merged') {
      const go = t('pr.btn.switchAnyway');
      const choice = await vscode.window.showWarningMessage(t('pr.finish.notMerged', base.base, branch), { modal: true }, go);
      if (choice !== go) return;
    }
    const r = await this.repos.withLock(entry.root, () => switchToBase(entry.root, base));
    this.log.appendLine(`[pr] ${entry.name}: back to ${base.base} → ${r.kind}`);
    if (!(await this.reportBranchResult(r))) return;
    await this.repos.refresh(entry.root, { fetch: false });
    const pulled = await this.actions.pull(entry.root);
    const pullOk = pulled?.kind === 'ok' || pulled?.kind === 'upToDate' || pulled?.kind === 'noUpstream';
    const deleted = pr?.status === 'merged' && pullOk && (await this.repos.withLock(entry.root, () => deleteTaskBranch(entry.root, branch, pr.headSha)));
    if (deleted) {
      const titles = this.titles();
      delete titles[`${repoKey(entry.root)}|${branch}`];
      await this.context.workspaceState.update(TITLES_KEY, titles);
    }
    await this.repos.refresh(entry.root, { fetch: false });
    void vscode.window.showInformationMessage(deleted ? t('pr.finish.ok', base.base, branch) : t('pr.finish.kept', base.base, branch));
  }

  async openPullRequest(root?: string): Promise<void> {
    const ctx = await this.entryFor(root);
    if (!ctx) return;
    const s = this.state.get(repoKey(ctx.entry.root));
    const branch = ctx.entry.snapshot?.branch;
    const slug = s?.slug ?? (await this.slugOf(ctx.entry.root, ctx.base));
    if (s?.pr && s.prBranch === branch) await vscode.env.openExternal(vscode.Uri.parse(s.pr.url));
    else if (slug && branch && branch !== ctx.base.base) await vscode.env.openExternal(vscode.Uri.parse(compareUrl(slug, ctx.base.base, branch)));
    else if (slug) await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/${slug}/pulls`));
  }

  /** Look again right now (e.g. the team view became visible). */
  async refresh(root: string): Promise<void> {
    const entry = this.repos.get(root);
    if (entry) await this.onCheck(entry, true);
  }

  view(root: string): PrView | null {
    const s = this.state.get(repoKey(root));
    if (!this.enabled || !s?.base || !s.branch) return null;
    const pr = s.pr && s.prBranch === s.branch ? s.pr : null;
    return {
      base: s.base.base,
      branch: s.branch,
      onBase: s.branch === s.base.base,
      unpushed: s.unpushed,
      github: !!s.slug,
      workflow: readSettings().prWorkflow,
      pr: pr ? { number: pr.number, title: pr.title, url: pr.url, status: pr.status } : null,
    };
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
