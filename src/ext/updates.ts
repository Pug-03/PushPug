import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isNewer, parseRelease, repoSlug, type Release } from '../core/updates';
import { t } from './l10n';

const LAST_CHECK_KEY = 'pushpug.updates.lastCheck';
const SKIPPED_KEY = 'pushpug.updates.skipped';
const DAY_MS = 24 * 60 * 60 * 1000;
/** First look a little after start-up, so it never competes with the first fetch. */
const FIRST_CHECK_DELAY_MS = 30_000;

/**
 * Tells you when a newer PushPug is on GitHub and installs it for you.
 * Copies installed from the Marketplace / Open VSX are skipped: VS Code updates those itself.
 */
export class Updates implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    this.timer = setTimeout(() => void this.check(false), FIRST_CHECK_DELAY_MS);
  }

  private get current(): string {
    return String(this.context.extension.packageJSON.version ?? '0.0.0');
  }

  /**
   * Installed from the Marketplace / Open VSX. VS Code records where each extension came from
   * ("gallery" or "vsix") in extensions.json next to the installed extension folders.
   */
  private get fromStore(): boolean {
    if (this.store === undefined) {
      this.store = false;
      try {
        const list = JSON.parse(readFileSync(join(dirname(this.context.extension.extensionPath), 'extensions.json'), 'utf8')) as Array<{ identifier?: { id?: string }; metadata?: { source?: string } }>;
        const me = this.context.extension.id.toLowerCase();
        this.store = list.find((e) => e.identifier?.id?.toLowerCase() === me)?.metadata?.source === 'gallery';
      } catch {
        // Unknown (development host, unusual layout): treat as a .vsix copy.
      }
    }
    return this.store;
  }
  private store: boolean | undefined;

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('pushpug').get<boolean>('updates.check', true);
  }

  private async latest(): Promise<Release | null> {
    const slug = repoSlug(this.context.extension.packageJSON.repository?.url);
    if (!slug) return null;
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PushPug-VSCode' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      this.log.appendLine(`[updates] GitHub answered ${res.status}`);
      return null;
    }
    return parseRelease(await res.json());
  }

  /** `manual`: from the command — always looks, and says so when there's nothing new. */
  async check(manual: boolean): Promise<void> {
    if (this.busy) return;
    if (!manual) {
      if (!this.enabled() || this.fromStore) return;
      const last = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
      if (Date.now() - last < DAY_MS) return;
    }
    this.busy = true;
    try {
      await this.context.globalState.update(LAST_CHECK_KEY, Date.now());
      const release = await this.latest().catch((e) => {
        this.log.appendLine(`[updates] ${e}`);
        return null;
      });
      if (!release) {
        if (manual) void vscode.window.showWarningMessage(t('upd.failed'));
        return;
      }
      if (!isNewer(release.version, this.current)) {
        if (manual) void vscode.window.showInformationMessage(t('upd.upToDate', this.current));
        return;
      }
      if (!manual && this.context.globalState.get<string>(SKIPPED_KEY) === release.version) return;
      await this.offer(release, manual);
    } finally {
      this.busy = false;
    }
  }

  private async offer(release: Release, manual: boolean): Promise<void> {
    const install = t('upd.btn.install');
    const notes = t('upd.btn.notes');
    const skip = t('upd.btn.skip');
    const buttons = this.fromStore || !release.vsixUrl ? [notes] : [install, notes];
    if (!manual) buttons.push(skip);
    const text = this.fromStore ? t('upd.availableStore', release.version, this.current) : t('upd.available', release.version, this.current);
    const choice = await vscode.window.showInformationMessage(text, ...buttons);
    if (choice === notes) await vscode.env.openExternal(vscode.Uri.parse(release.url));
    else if (choice === skip) await this.context.globalState.update(SKIPPED_KEY, release.version);
    else if (choice === install) await this.install(release);
  }

  private async install(release: Release): Promise<void> {
    const url = release.vsixUrl;
    if (!url) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('upd.installing', release.version) }, async () => {
        const res = await fetch(url, { headers: { 'User-Agent': 'PushPug-VSCode' }, signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
        const dir = vscode.Uri.joinPath(this.context.globalStorageUri, 'updates');
        await vscode.workspace.fs.createDirectory(dir);
        const file = vscode.Uri.joinPath(dir, `pushpug-${release.version}.vsix`);
        await vscode.workspace.fs.writeFile(file, new Uint8Array(await res.arrayBuffer()));
        await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
      });
    } catch (e) {
      this.log.appendLine(`[updates] install failed: ${e}`);
      const open = t('upd.btn.notes');
      const choice = await vscode.window.showErrorMessage(t('upd.installFailed'), open);
      if (choice === open) await vscode.env.openExternal(vscode.Uri.parse(release.url));
      return;
    }
    const reload = t('upd.btn.reload');
    const choice = await vscode.window.showInformationMessage(t('upd.installed', release.version), reload);
    if (choice === reload) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
