import * as vscode from 'vscode';
import { basename, dirname, join } from 'node:path';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { SharedStore, type WorkerConfig } from '../core/storage';
import { installAgent, uninstallAgent, removeLegacyAgent, isAgentInstalled, isBackgroundSupported, buildPlist, plistPath, vbsFileBytes, type AgentPaths } from '../background/agent';
import { findAlerter } from '../notify/desktop';
import { electronNodePath, productJson } from './host';
import { iconPath } from './desktopChannel';
import { currentLang } from './l10n';
import { readSettings } from './settings';
import type { RepoManager } from './repoManager';
import type { ModeController } from './modes';
import { findSignedInGh } from '../core/ghCli';

/** Keeps config.json, worker.js and the OS background job in sync with settings. */
export class Background {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: SharedStore,
    private readonly repos: RepoManager,
    private readonly log: vscode.OutputChannel,
    private readonly modes: ModeController,
  ) {}

  private paths(): AgentPaths {
    return {
      platform: process.platform,
      home: homedir(),
      storageDir: this.store.dir,
      nodeExe: electronNodePath(),
      workerFile: this.store.workerFile,
    };
  }

  /** `gh` installed and signed in (checked once per session). */
  ghFound = false;

  async detectGh(): Promise<boolean> {
    this.ghFound = !!(await findSignedInGh());
    return this.ghFound;
  }

  private baseConfig(enabled: boolean): Omit<WorkerConfig, 'repos'> {
    const s = readSettings();
    const extPath = this.context.extensionPath;
    const id = this.context.extension.id.toLowerCase();
    const folder = basename(extPath);
    return {
      version: 1,
      lang: currentLang(),
      extensionId: this.context.extension.id,
      uriScheme: vscode.env.uriScheme,
      extensionsDir: dirname(extPath),
      extensionDirPrefix: folder.toLowerCase().startsWith(`${id}-`) ? folder.slice(0, id.length + 1) : folder,
      gitPath: this.repos.gitPath,
      alerterPath: findAlerter(),
      iconPath: iconPath(this.context),
      windowsAppId: productJson().win32AppUserModelId,
      macBundleId: productJson().darwinBundleIdentifier,
      enabled,
      frequency: this.modes.config,
      quiet: { enabled: s.quietEnabled, start: s.quietStart, end: s.quietEnd },
      checksViaGh: s.actionsEnabled && this.ghFound,
    };
  }

  private legacyChecked = false;

  /** Called on activation, on any PushPug settings change and when repos are discovered. The worker re-reads config.json on every run. */
  async sync(): Promise<'enabled' | 'disabled' | 'unsupported'> {
    const enabled = readSettings().notifyBackground;
    this.store.addRepos(
      this.repos.list().map((e) => e.root),
      this.baseConfig(enabled && isBackgroundSupported(process.platform)),
    );
    const p = this.paths();
    if (!this.legacyChecked) {
      this.legacyChecked = true;
      if (await removeLegacyAgent(p)) this.log.appendLine('[background] removed the old PushPal job');
    }
    if (!enabled) {
      if (isAgentInstalled(p)) {
        await uninstallAgent(p);
        this.log.appendLine('[background] removed');
      }
      return 'disabled';
    }
    if (!isBackgroundSupported(process.platform)) return 'unsupported';

    // Copy the worker out of the extension folder so updates/uninstalls
    // never leave the scheduled job pointing at a missing file.
    const bundled = join(this.context.extensionPath, 'dist', 'worker.js');
    if (!existsSync(p.workerFile) || !sameFile(bundled, p.workerFile)) copyFileSync(bundled, p.workerFile);

    if (!isAgentInstalled(p) || this.agentOutdated(p)) {
      await installAgent(p);
      this.log.appendLine(`[background] installed (${process.platform})`);
    }
    return 'enabled';
  }

  private agentOutdated(p: AgentPaths): boolean {
    try {
      if (p.platform === 'darwin') return readFileSync(plistPath(p.home), 'utf8') !== buildPlist(p);
      if (p.platform === 'win32') return !readFileSync(join(p.storageDir, 'launcher.vbs')).equals(vbsFileBytes(p));
    } catch {
      return true;
    }
    return false;
  }
}

function sameFile(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}
