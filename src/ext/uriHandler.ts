import * as vscode from 'vscode';
import { join } from 'node:path';
import { readJson, writeJsonAtomic, repoKey, type SharedStore } from '../core/storage';
import type { RepoManager } from './repoManager';

export type UriAction = 'pull' | 'show' | 'open';

interface Pending {
  repo: string;
  action: UriAction;
  ts: number;
}

const PENDING_MAX_AGE_MS = 3 * 60_000;

/**
 * Handles vscode://<publisher>.pushpug/<action>?repo=<path> links coming from
 * desktop notifications (Windows toast buttons, the background worker).
 * If the repo isn't open in this window, the folder is opened and the action
 * is handed to that window through a small "pending" file.
 */
export class PushPugUriHandler implements vscode.UriHandler {
  constructor(
    private readonly store: SharedStore,
    private readonly repos: RepoManager,
    private readonly run: (root: string, action: UriAction) => Promise<void>,
  ) {}

  private get pendingFile() {
    return join(this.store.dir, 'pending.json');
  }

  async handleUri(uri: vscode.Uri): Promise<void> {
    const action = uri.path.replace(/^\//, '') as UriAction;
    if (!['pull', 'show', 'open'].includes(action)) return;
    await this.repos.discover();
    const repo = this.knownRepo(uri.query);
    if (!repo) return;
    if (this.repos.get(repo)) {
      await this.run(this.repos.get(repo)!.root, action);
      return;
    }
    writeJsonAtomic(this.pendingFile, { repo, action, ts: Date.now() } satisfies Pending);
    const emptyWindow = !vscode.workspace.workspaceFolders?.length;
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(repo), { forceNewWindow: !emptyWindow });
  }

  /**
   * The repo a link points at — only a repo PushPug already watches, so a crafted link can't
   * open or pull an arbitrary folder. VS Code hands over the query already decoded; decoding it
   * again (URLSearchParams) would turn "+" into a space and cut paths at "&", so the rest of the
   * query after "repo=" is the path as-is (an encoded form is accepted too).
   */
  private knownRepo(query: string): string | undefined {
    const m = /(?:^|&)repo=(.*)$/s.exec(query);
    if (!m) return undefined;
    const candidates = [m[1]];
    try {
      candidates.push(decodeURIComponent(m[1]));
    } catch {
      // not encoded
    }
    const watched = new Set([...this.repos.list().map((e) => repoKey(e.root)), ...(this.store.readConfig()?.repos ?? []).map(repoKey)]);
    return candidates.find((c) => watched.has(repoKey(c)));
  }

  /** Called on activation and whenever the window gains focus. */
  async consumePending(): Promise<void> {
    const p = readJson<Pending | null>(this.pendingFile, null);
    if (!p || Date.now() - p.ts > PENDING_MAX_AGE_MS) return;
    await this.repos.discover();
    const entry = this.repos.list().find((e) => repoKey(e.root) === repoKey(p.repo));
    if (!entry) return;
    writeJsonAtomic(this.pendingFile, null);
    await this.run(entry.root, p.action);
  }
}
