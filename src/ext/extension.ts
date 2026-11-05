import * as vscode from 'vscode';
import { RepoManager } from './repoManager';
import { StatusBar } from './statusBar';
import { Actions } from './actions';
import { Alerts } from './alerts';
import { SharedStore, HEARTBEAT_INTERVAL_MS } from '../core/storage';
import { readSettings, saveSettings } from './settings';
import { t } from './l10n';
import { ExtensionDesktopChannel } from './desktopChannel';
import { sendTestNotification } from './desktopSetup';
import { PushPugUriHandler, type UriAction } from './uriHandler';
import { focusThisWindow } from './host';
import { Background } from './background';
import { SetupWizard, SETUP_SHOWN_KEY } from './wizard';
import { TeamViewProvider } from './teamView';
import { ModeController } from './modes';
import { Scheduler } from './scheduler';
import { ChecksWatcher } from './checks';
import { PullRequests } from './pullRequests';
import { SettingsPage, type FrequencyDeps } from './settingsPage';
import { Avatars } from './avatars';
import { Updates } from './updates';
import { MODES, type Mode } from '../core/frequency';

/** The setup wizard announces background changes itself. */
let suppressBackgroundAnnounce = false;
export function setSuppressBackgroundAnnounce(v: boolean): void {
  suppressBackgroundAnnounce = v;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('PushPug');
  const store = new SharedStore(context.globalStorageUri.fsPath);
  const repos = new RepoManager(context, log);
  const alerts = new Alerts(store, log);
  const actions = new Actions(repos, alerts, log);
  const modes = new ModeController(log);
  const scheduler = new Scheduler(repos, modes, log);
  const ci = new ChecksWatcher(context, repos, scheduler, alerts, log);
  const prs = new PullRequests(context, repos, actions, alerts, ci, log);
  actions.onSendForReview = (root) => prs.sendForReview(root);
  const status = new StatusBar(repos, () => ({ mode: modes.mode, effective: scheduler.effective }));
  scheduler.onDidChange(() => status.update());
  modes.onDidChange(() => status.update());
  repos.canAutoFetch = () => !scheduler.paused;
  const freqDeps: FrequencyDeps = { modes, repos, scheduler, ci, ghFound: () => background.ghFound, snoozeUntil: () => store.snoozeUntil() };
  context.subscriptions.push(log, repos, status, modes, scheduler, ci, prs);

  const desktop = new ExtensionDesktopChannel(context);
  alerts.desktop = desktop;
  alerts.onFocusWindow = focusThisWindow;
  alerts.onPull = (root) => actions.pull(root);
  alerts.onFinishMerge = (root) => actions.finishMerge(root);
  alerts.onReveal = (root) => actions.revealTeam(root);
  alerts.checksLine = (entry) => ci.quickLine(entry);
  repos.onDidCheck((entry, prev) => alerts.onCheck(entry, prev));
  repos.onPushError = (root, stderr) => actions.handlePushError(root, stderr);
  repos.onAutostashDropped = () => void vscode.window.showInformationMessage(t('autostash.dropped'));
  const team = new TeamViewProvider(context, repos, actions);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(TeamViewProvider.id, team));
  actions.revealTeam = (root) => team.reveal(root);
  team.ciState = (root) => ci.stateFor(root);
  team.log = (line) => log.appendLine(line);
  const avatars = new Avatars(context, () => ci.githubToken(), log);
  context.subscriptions.push(avatars);
  team.avatarFor = (email) => avatars.urlFor(email);
  repos.onDidCheck((entry) => avatars.refresh(entry));
  avatars.onDidChange(() => team.refresh());
  ci.onDidChange(() => team.refresh());
  prs.onDidChange(() => team.refresh());
  team.prFor = (root) => prs.view(root);
  team.prs = prs;
  ci.onPull = (root) => actions.pull(root);
  ci.onReveal = (root, sha) => team.reveal(root, sha);
  team.checksFor = (sha) => ci.badge(sha);
  team.checkDetail = (root, sha, id) => ci.detail(root, sha, id);
  team.undoLeft = (root) => actions.undoLeft(root);
  alerts.onQuietChange = () => SettingsPage.refresh();

  repos.onDidChange(() => {
    const hasConflict = repos.list().some((e) => e.snapshot?.state === 'conflict');
    void vscode.commands.executeCommand('setContext', 'pushpug.hasConflict', hasConflict);
  });

  const cmd = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('pushpug.pull', (root?: string) => actions.pull(typeof root === 'string' ? root : undefined));
  cmd('pushpug.checkNow', () => repos.refreshAll({ fetch: true }));
  cmd('pushpug.showConflicts', () => actions.showConflicts());
  cmd('pushpug.finishMerge', () => actions.finishMerge());
  cmd('pushpug.showTeam', () => actions.revealTeam());
  cmd('pushpug.push', (root?: string) => actions.push(typeof root === 'string' ? root : undefined));
  const rootArg = (root?: unknown) => (typeof root === 'string' ? root : undefined);
  cmd('pushpug.startTask', (root?: string) => prs.startTask(rootArg(root)));
  cmd('pushpug.sendForReview', (root?: string) => prs.sendForReview(rootArg(root)));
  cmd('pushpug.updateFromMain', (root?: string) => prs.updateFromMain(rootArg(root)));
  cmd('pushpug.finishTask', (root?: string) => prs.finishTask(rootArg(root)));
  cmd('pushpug.openPullRequest', (root?: string) => prs.openPullRequest(rootArg(root)));
  cmd('pushpug.undoMerge', (root?: string) => actions.undo(typeof root === 'string' ? root : undefined));
  cmd('pushpug.showChecks', (root?: string, sha?: string) => team.reveal(root, sha));
  cmd('pushpug.snooze', () => alerts.snooze());
  cmd('pushpug.unsnooze', () => alerts.unsnooze());
  cmd('pushpug.testNotification', () => sendTestNotification(desktop));
  const updates = new Updates(context, log);
  context.subscriptions.push(updates);
  cmd('pushpug.checkForUpdates', () => updates.check(true));
  // Not in the Command Palette: lets the smoke test see what the team view reported.
  cmd('pushpug._diag', () => team.diag);
  cmd('pushpug.openSettings', (section?: string) => SettingsPage.show(context, freqDeps, desktop, typeof section === 'string' ? section : undefined));
  cmd('pushpug.switchMode', async () => {
    const current = modes.mode;
    const items = MODES.map((m) => ({
      label: `${t(`mode.icon.${m}` as 'mode.icon.fast')} ${t(`mode.${m}` as 'mode.fast')}`,
      description: m === current ? t('mode.current') : '',
      detail: t(`mode.${m}.detail` as 'mode.fast.detail'),
      mode: m,
    }));
    const pick = await vscode.window.showQuickPick(items, { title: t('mode.pickTitle'), placeHolder: t('mode.pickPlaceholder') });
    if (!pick) return;
    if (pick.mode === 'custom') {
      await modes.setMode('custom');
      SettingsPage.show(context, freqDeps, desktop, 'frequency');
    } else await modes.setMode(pick.mode as Mode);
  });

  // Heartbeat: tells the background worker this window watches these repos.
  const beat = () => {
    try {
      store.writeHeartbeat(vscode.env.sessionId, repos.list().map((e) => e.root));
    } catch (e) {
      log.appendLine(`[heartbeat] ${e}`);
    }
  };
  const hb = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  repos.onDidChange(beat);
  context.subscriptions.push({ dispose: () => (clearInterval(hb), store.removeHeartbeat(vscode.env.sessionId)) });

  const background = new Background(context, store, repos, log, modes);
  const syncBackground = async (announce: boolean) => {
    try {
      const r = await background.sync();
      if (!announce) return;
      if (r === 'enabled') void vscode.window.showInformationMessage(t('bg.enabled'));
      else if (r === 'disabled') void vscode.window.showInformationMessage(t('bg.disabled'));
      else void vscode.window.showWarningMessage(t('bg.unsupported'));
    } catch (e) {
      log.appendLine(`[background] ${e}`);
      void vscode.window.showErrorMessage(t('bg.failed', e instanceof Error ? e.message : String(e)));
    }
  };
  let bgTimer: NodeJS.Timeout | undefined;
  repos.onDidChange(() => {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(() => void syncBackground(false), 3000);
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('pushpug')) return;
      if (e.affectsConfiguration('pushpug.language')) {
        status.update();
        team.render();
      }
      if (e.affectsConfiguration('pushpug.notify.background') && !suppressBackgroundAnnounce) void syncBackground(true);
      else {
        // Any other change (interval, battery rules, active hours, language…) goes
        // into config.json right away; the worker reads it on its next run.
        clearTimeout(bgTimer);
        bgTimer = setTimeout(() => void syncBackground(false), 300);
      }
      if (e.affectsConfiguration('pushpug.avatars')) team.refresh();
      if (e.affectsConfiguration('pushpug.pullRequests')) void repos.refreshAll({ fetch: false });
      if (e.affectsConfiguration('pushpug.theme')) {
        SetupWizard.postTheme(readSettings().theme);
        SettingsPage.postTheme(readSettings().theme);
        team.setTheme();
      }
    }),
  );

  const runUriAction = async (root: string, action: UriAction) => {
    actions.revealTeam(root);
    if (action === 'pull') await actions.pull(root);
    else await repos.refresh(root, { fetch: true });
  };
  const uriHandler = new PushPugUriHandler(store, repos, runUriAction);
  context.subscriptions.push(
    vscode.window.registerUriHandler(uriHandler),
    vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) void uriHandler.consumePending();
    }),
  );

  const openWizard = () =>
    SetupWizard.show(
      context,
      desktop,
      async (want) => {
        suppressBackgroundAnnounce = true;
        try {
          if (want !== undefined && want !== readSettings().notifyBackground) await saveSettings({ notifyBackground: want });
          return await background.sync();
        } finally {
          setTimeout(() => (suppressBackgroundAnnounce = false), 500);
        }
      },
      () => actions.revealTeam(),
      freqDeps,
    );
  cmd('pushpug.setup', openWizard);
  if (!context.globalState.get<boolean>(SETUP_SHOWN_KEY)) openWizard();

  await modes.init();
  await repos.init();
  scheduler.start();
  beat();
  void background.detectGh().then(() => syncBackground(false));
  void uriHandler.consumePending();
}

export function deactivate(): void {
  // Disposables registered on the context clean everything up.
}
