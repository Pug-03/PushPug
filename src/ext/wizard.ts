import * as vscode from 'vscode';
import { webviewStrings, type Lang } from '../i18n';
import { renderPage } from './webview';
import { readSettings, saveSettings, type ThemeSetting, type Settings } from './settings';
import { currentLang } from './l10n';
import { isBackgroundSupported } from '../background/agent';
import type { ExtensionDesktopChannel } from './desktopChannel';
import { sendTestNotification, installAlerter } from './desktopSetup';
import { frequencyModel, type FrequencyDeps } from './settingsPage';
import type { Mode } from '../core/frequency';

export const SETUP_SHOWN_KEY = 'pushpug.setupShown';

type FromWizard =
  | { type: 'setLang'; lang: Lang }
  | { type: 'setTheme'; theme: ThemeSetting }
  | { type: 'setNotify'; key: 'notifyInVSCode' | 'notifyDesktop' | 'notifyBackground'; value: boolean }
  | { type: 'setMode'; mode: Mode }
  | { type: 'setSetting'; key: 'quietEnabled' | 'quietStart' | 'quietEnd' | 'checksOnPass' | 'checksFor'; value: unknown }
  | { type: 'signIn' }
  | { type: 'openSettings' }
  | { type: 'test' }
  | { type: 'installAlerter' }
  | { type: 'finish' }
  | { type: 'close' };

/** Full-page, multi-step setup wizard (one instance at a time). */
export class SetupWizard {
  private static current: SetupWizard | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(
    context: vscode.ExtensionContext,
    desktop: ExtensionDesktopChannel,
    applyBackground: (want: boolean | undefined) => Promise<string>,
    onDone: () => void,
    freq: FrequencyDeps,
  ): void {
    if (SetupWizard.current) {
      SetupWizard.current.panel.reveal();
      return;
    }
    void context.globalState.update(SETUP_SHOWN_KEY, true);
    SetupWizard.current = new SetupWizard(context, desktop, applyBackground, onDone, freq);
  }

  static postTheme(theme: ThemeSetting): void {
    void SetupWizard.current?.panel.webview.postMessage({ type: 'theme', theme });
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly desktop: ExtensionDesktopChannel,
    private readonly applyBackground: (want: boolean | undefined) => Promise<string>,
    private readonly onDone: () => void,
    private readonly freq: FrequencyDeps,
  ) {
    const lang = currentLang();
    this.panel = vscode.window.createWebviewPanel('pushpug.setup', lang === 'th' ? 'ตั้งค่า PushPug' : 'PushPug Setup', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
    // The panel can be closed while render() is still waiting; setting its html then throws.
    void this.render(lang).catch(() => undefined);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((m: FromWizard) => void this.onMessage(m), null, this.disposables);
    freq.modes.onDidChange(() => void this.postFreq(), null, this.disposables);
  }

  private async postFreq(): Promise<void> {
    this.send({ type: 'freq', freq: await frequencyModel(this.freq) });
  }

  private async render(lang: Lang): Promise<void> {
    const s = readSettings();
    const backend = await this.desktop.backend();
    this.panel.webview.html = renderPage(this.panel.webview, this.context.extensionUri, {
      title: 'PushPug',
      lang,
      theme: s.theme,
      surface: 'panel',
      styles: ['controls.css', 'wizard.css'],
      scripts: ['modes.js', 'wizard.js'],
      init: {
        lang,
        theme: s.theme,
        strings: { th: webviewStrings('th'), en: webviewStrings('en') },
        platform: process.platform,
        backend,
        bgSupported: isBackgroundSupported(process.platform),
        notify: { notifyInVSCode: s.notifyInVSCode, notifyDesktop: s.notifyDesktop, notifyBackground: s.notifyBackground },
        freq: await frequencyModel(this.freq),
        quiet: { enabled: s.quietEnabled, start: s.quietStart, end: s.quietEnd },
        github: { signedIn: this.freq.ci.signedIn, gh: this.freq.ghFound?.() ?? false, onPass: s.checksOnPass, for: s.checksFor },
      },
    });
  }

  private async onMessage(m: FromWizard): Promise<void> {
    switch (m.type) {
      case 'setLang':
        await saveSettings({ language: m.lang });
        this.panel.title = m.lang === 'th' ? 'ตั้งค่า PushPug' : 'PushPug Setup';
        return;
      case 'setTheme':
        await saveSettings({ theme: m.theme });
        return;
      case 'setNotify':
        // Background is applied on "finish" so toggling doesn't install/remove repeatedly.
        if (m.key !== 'notifyBackground') await saveSettings({ [m.key]: m.value });
        else this.wantBackground = m.value;
        return;
      case 'setMode':
        await this.freq.modes.setMode(m.mode);
        return;
      case 'setSetting':
        await saveSettings({ [m.key]: m.value } as Partial<Settings>);
        return;
      case 'signIn': {
        const ok = await this.freq.ci.signIn();
        this.send({ type: 'signedIn', ok });
        return;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('pushpug.openSettings', 'frequency');
        return;
      case 'test': {
        const backend = await sendTestNotification(this.desktop);
        this.send({ type: 'testResult', backend });
        return;
      }
      case 'installAlerter':
        installAlerter(this.desktop);
        return;
      case 'finish': {
        let result: string;
        try {
          result = await this.applyBackground(this.wantBackground);
        } catch (e) {
          result = 'failed:' + (e instanceof Error ? e.message : String(e));
        }
        this.send({ type: 'finished', background: result });
        return;
      }
      case 'close':
        this.panel.dispose();
        this.onDone();
        return;
    }
  }

  private wantBackground: boolean | undefined;

  private disposed = false;

  /** postMessage throws once the panel is closed (e.g. an async result arrives late). */
  private send(msg: unknown): void {
    if (this.disposed) return;
    try {
      void this.panel.webview.postMessage(msg);
    } catch {
      /* panel closed */
    }
  }

  private dispose(): void {
    this.disposed = true;
    SetupWizard.current = undefined;
    for (const d of this.disposables) d.dispose();
  }
}
