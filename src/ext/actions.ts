import * as vscode from 'vscode';
import { join } from 'node:path';
import { pull, mergeRef, finishMerge, type PullResult, type ErrorCode } from '../git/repo';
import { listFiles } from '../core/messages';
import type { RepoEntry, RepoManager } from './repoManager';
import type { Alerts } from './alerts';
import { t, currentLang } from './l10n';
import { explainGitError } from '../core/gitErrors';
import { captureBeforePull, finishUndoRecord, undoMerge, safePush, isRejected, UNDO_WINDOW_MS, type PushResult } from '../git/safety';
import { isProtectedRejection } from '../git/branches';

/** Plain-language text for a git failure: the matching explanation + how to fix it. */
export function errorText(code: ErrorCode, message: string): string {
  const key = explainGitError(message);
  if (key !== 'unknown') return `${t(`gerr.${key}.title` as 'gerr.rejected.title')} ${t(`gerr.${key}.fix` as 'gerr.rejected.fix')}`;
  if (code === 'other') return t('err.other', message.split('\n').filter(Boolean).slice(-1)[0] ?? '');
  return t(`err.${code}`);
}

/** Show a git error explained, with "Show full message" for the original text. */
export async function showGitError(message: string, code: ErrorCode = 'other'): Promise<void> {
  const full = t('btn.fullMessage');
  const choice = await vscode.window.showErrorMessage(errorText(code, message), full);
  if (choice === full) await vscode.window.showInformationMessage(t('gerr.fullTitle'), { modal: true, detail: message.trim() || '—' });
}

/** User-facing commands: pull, open conflicts, finish merge. */
export class Actions {
  /** Webview / commands can ask to reveal the team view focused on one repo. */
  revealTeam: (root?: string) => void = () => undefined;
  /** The branch only accepts pull requests: send the work for review instead. */
  onSendForReview: (root: string) => Promise<unknown> = async () => undefined;

  constructor(
    private readonly repos: RepoManager,
    private readonly alerts: Alerts,
    private readonly log: vscode.OutputChannel,
  ) {}

  async pickRepo(filter: (e: RepoEntry) => boolean): Promise<RepoEntry | undefined> {
    const candidates = this.repos.list().filter(filter);
    if (candidates.length <= 1) return candidates[0];
    const picked = await vscode.window.showQuickPick(
      candidates.map((e) => ({ label: e.name, description: e.snapshot?.upstream ?? '', detail: e.root, entry: e })),
      { placeHolder: t('pick.repo') },
    );
    return picked?.entry;
  }

  async pull(root?: string): Promise<PullResult | undefined> {
    const entry = root
      ? this.repos.get(root)
      : await this.pickRepo((e) => e.snapshot?.state === 'behind' || e.snapshot?.state === 'conflict').then(
          (e) => e ?? this.repos.list()[0],
        );
    if (!entry || entry.phase === 'pulling') return undefined;
    const target = entry.root;
    let undo: Awaited<ReturnType<typeof finishUndoRecord>> = null;
    const result = await this.repos.withLock(target, async () => {
      this.repos.setPhase(target, 'pulling');
      try {
        const before = await captureBeforePull(target).catch(() => null);
        const r = await pull(target);
        if (r.kind === 'ok' && before) undo = await finishUndoRecord(target, before).catch(() => null);
        return r;
      } finally {
        this.repos.setPhase(target, 'idle');
      }
    });
    // Only a pull that merged something replaces the undo; an up-to-date or failed one keeps the earlier undo.
    if (result.kind === 'ok') entry.undo = undo ?? undefined;
    this.log.appendLine(`[pull] ${entry.name}: ${result.kind}`);
    if (result.kind === 'autostashConflict') await this.repos.rememberAutostash(target, result.stashSha);
    this.repos.setLastResult(target, result);
    await this.repos.refresh(target, { fetch: false });
    if (result.kind === 'ok' || result.kind === 'upToDate') this.alerts.clear(target);
    await this.report(entry, result);
    return result;
  }

  /** Merge another ref (the latest main) into the current branch, reported like a pull. */
  async mergeFrom(root: string, ref: string): Promise<PullResult | undefined> {
    const entry = this.repos.get(root);
    if (!entry || entry.phase === 'pulling') return undefined;
    const result = await this.repos.withLock(root, async () => {
      this.repos.setPhase(root, 'pulling');
      try {
        return await mergeRef(root, ref);
      } finally {
        this.repos.setPhase(root, 'idle');
      }
    });
    this.log.appendLine(`[merge] ${entry.name} ← ${ref}: ${result.kind}`);
    if (result.kind === 'autostashConflict') await this.repos.rememberAutostash(root, result.stashSha);
    this.repos.setLastResult(root, result);
    await this.repos.refresh(root, { fetch: false });
    // Success is announced by the caller, which knows what comes next.
    if (result.kind !== 'ok') await this.report(entry, result);
    return result;
  }

  private async report(entry: RepoEntry, result: PullResult): Promise<void> {
    const conflictButtons = [t('btn.openMergeEditor'), t('btn.howToFix')];
    switch (result.kind) {
      case 'ok': {
        // Not awaited: callers (e.g. "merge, then push") must not wait for the message to be dismissed.
        const undo = t('btn.undoMerge');
        void vscode.window.showInformationMessage(result.autostashed ? t('pull.okLocal', result.pulled) : t('pull.ok', result.pulled), ...(entry.undo ? [undo] : [])).then((choice) => {
          if (choice === undo) void this.undo(entry.root);
        });
        return;
      }
      case 'upToDate':
        void vscode.window.showInformationMessage(t('pull.upToDate'));
        return;
      case 'mergeConflict': {
        await this.openConflictFiles(entry.root, result.files);
        const text = t('pull.mergeConflict', result.files.length) + (result.mergeAutostash ? ' ' + t('pull.mergeConflictStash') : '');
        void this.conflictPrompt(entry, result.files, text, conflictButtons);
        return;
      }
      case 'autostashConflict':
        await this.openConflictFiles(entry.root, result.files);
        void this.conflictPrompt(entry, result.files, t('pull.autostashConflict', result.files.length), conflictButtons);
        return;
      case 'blocked': {
        const c = result.conflict;
        if (c.kind === 'merge' && c.files.length === 0) {
          const choice = await vscode.window.showWarningMessage(t('pull.blockedReady'), t('btn.finishMerge'));
          if (choice) await this.finishMerge(entry.root);
          return;
        }
        await this.openConflictFiles(entry.root, c.files);
        void this.conflictPrompt(entry, c.files, t('pull.blocked', c.files.length), conflictButtons);
        return;
      }
      case 'noUpstream':
        void vscode.window.showInformationMessage(t('pull.noUpstream'));
        return;
      case 'detached':
        void vscode.window.showWarningMessage(t('pull.detached'));
        return;
      case 'untrackedInTheWay':
        void vscode.window.showWarningMessage(t('pull.untracked', listFiles(result.files, 5)));
        return;
      case 'error':
        await showGitError(result.message, result.code);
        return;
    }
  }

  private async conflictPrompt(entry: RepoEntry, files: string[], text: string, buttons: string[]): Promise<void> {
    const choice = await vscode.window.showWarningMessage(`${text} (${listFiles(files)})`, ...buttons);
    if (choice === t('btn.openMergeEditor') && files[0]) await this.openMergeEditor(entry.root, files[0]);
    else if (choice === t('btn.howToFix')) this.revealTeam(entry.root);
  }

  /** Open each conflicted file (max 5) and the Merge Editor for the first. */
  async openConflictFiles(root: string, files: string[]): Promise<void> {
    for (const f of files.slice(0, 5)) {
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(join(root, f)), { preview: false, preserveFocus: true });
      } catch (e) {
        this.log.appendLine(`[open] ${f}: ${e}`);
      }
    }
    if (files[0]) await this.openMergeEditor(root, files[0]);
  }

  async openMergeEditor(root: string, file: string): Promise<void> {
    const uri = vscode.Uri.file(join(root, file));
    try {
      await vscode.commands.executeCommand('git.openMergeEditor', uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: false });
    }
  }

  async openFile(root: string, file: string): Promise<void> {
    await vscode.window.showTextDocument(vscode.Uri.file(join(root, file)), { preview: false });
  }

  async showConflicts(root?: string): Promise<void> {
    const entry = root ? this.repos.get(root) : await this.pickRepo((e) => e.snapshot?.state === 'conflict');
    if (!entry) return this.revealTeam();
    this.revealTeam(entry.root);
    const c = entry.snapshot?.conflict;
    if (c && c.files.length) await this.openConflictFiles(entry.root, c.files);
  }

  async finishMerge(root?: string): Promise<void> {
    const entry = root
      ? this.repos.get(root)
      : await this.pickRepo((e) => e.snapshot?.conflict?.kind === 'merge');
    if (!entry) return;
    const result = await this.repos.withLock(entry.root, () => finishMerge(entry.root));
    this.log.appendLine(`[finishMerge] ${entry.name}: ${result.kind}`);
    if (result.kind === 'autostashConflict') await this.repos.rememberAutostash(entry.root, result.stashSha);
    this.repos.setLastResult(entry.root, result);
    await this.repos.refresh(entry.root, { fetch: false });
    if (result.kind === 'ok') {
      this.alerts.clear(entry.root);
      void vscode.window.showInformationMessage(t('merge.finished'));
    } else {
      await this.report(entry, result);
    }
  }

  /** "Undo the last merge": back to exactly how it was, uncommitted work included. */
  async undo(root?: string): Promise<void> {
    const entry = root ? this.repos.get(root) : this.repos.list().find((e) => e.undo && Date.now() - e.undo.at < UNDO_WINDOW_MS);
    const rec = entry?.undo;
    if (!entry || !rec) {
      void vscode.window.showInformationMessage(t('undo.none'));
      return;
    }
    const r = await this.repos.withLock(entry.root, () => undoMerge(rec));
    this.log.appendLine(`[undo] ${entry.name}: ${r.kind}`);
    if (r.kind === 'ok' || r.kind === 'expired' || r.kind === 'committed') entry.undo = undefined;
    await this.repos.refresh(entry.root, { fetch: false });
    switch (r.kind) {
      case 'ok':
        void vscode.window.showInformationMessage(t('undo.ok'));
        return;
      case 'expired':
        void vscode.window.showInformationMessage(t('undo.expired'));
        return;
      case 'committed':
        void vscode.window.showWarningMessage(t('undo.committed'));
        return;
      case 'changed':
        void vscode.window.showWarningMessage(t('undo.changed'));
        return;
      case 'error':
        await showGitError(r.message);
        return;
    }
  }

  /** Push, but check the remote first; offer "merge, then push" when teammates pushed. */
  async push(root?: string): Promise<PushResult | undefined> {
    const entry = root ? this.repos.get(root) : await this.pickRepo(() => true);
    if (!entry) return undefined;
    const r = await this.repos.withLock(entry.root, () => safePush(entry.root));
    this.log.appendLine(`[push] ${entry.name}: ${r.kind}`);
    await this.repos.refresh(entry.root, { fetch: false });
    await this.reportPush(entry, r);
    return r;
  }

  async reportPush(entry: RepoEntry, r: PushResult): Promise<void> {
    switch (r.kind) {
      case 'ok':
        void vscode.window.showInformationMessage(t('push.ok', r.pushed));
        return;
      case 'nothing':
        void vscode.window.showInformationMessage(t('push.nothing'));
        return;
      case 'behind':
        await this.offerMergeThenPush(entry, t('push.behind', r.behind, [...new Set(r.incoming.map((c) => c.author))].join(', ')));
        return;
      case 'rejected':
        await this.offerMergeThenPush(entry, t('push.rejected'), r.message);
        return;
      case 'protected':
        await this.offerSendForReview(entry, r.message);
        return;
      case 'noUpstream':
        void vscode.window.showInformationMessage(t('pull.noUpstream'));
        return;
      case 'detached':
        void vscode.window.showWarningMessage(t('pull.detached'));
        return;
      case 'error':
        await showGitError(r.message);
        return;
    }
  }

  /** Teammates' commits are on the remote: merge them in, then push. */
  async offerMergeThenPush(entry: RepoEntry, text: string, full?: string): Promise<boolean> {
    const go = t('btn.mergeThenPush');
    const buttons = full ? [go, t('btn.fullMessage')] : [go];
    const choice = await vscode.window.showWarningMessage(text, ...buttons);
    if (choice === t('btn.fullMessage') && full) {
      await vscode.window.showInformationMessage(t('gerr.fullTitle'), { modal: true, detail: full });
      return this.offerMergeThenPush(entry, text);
    }
    if (choice !== go) return false;
    const pulled = await this.pull(entry.root);
    if (pulled?.kind !== 'ok' && pulled?.kind !== 'upToDate') return false;
    await this.push(entry.root);
    return true;
  }

  /** The branch only accepts pull requests: offer to send the commits for review instead. */
  async offerSendForReview(entry: RepoEntry, full: string): Promise<void> {
    const send = t('pr.btn.sendInstead');
    const choice = await vscode.window.showWarningMessage(t('push.protected'), send, t('btn.fullMessage'));
    if (choice === send) await this.onSendForReview(entry.root);
    else if (choice === t('btn.fullMessage')) await vscode.window.showInformationMessage(t('gerr.fullTitle'), { modal: true, detail: full });
  }

  /** For VS Code's own Push / Sync: explain a rejected push and offer to fix it. */
  async handlePushError(root: string, stderr: string): Promise<boolean> {
    const entry = this.repos.get(root);
    if (!entry) return false;
    if (isProtectedRejection(stderr)) {
      void this.offerSendForReview(entry, stderr);
      return true;
    }
    if (!isRejected(stderr)) return false;
    void this.offerMergeThenPush(entry, t('push.rejected'), stderr);
    return true;
  }

  /** Seconds of undo left for a repo (for the team view). */
  undoLeft(root: string): number {
    const rec = this.repos.get(root)?.undo;
    return rec ? Math.max(0, Math.round((rec.at + UNDO_WINDOW_MS - Date.now()) / 1000)) : 0;
  }
}

export { currentLang };

