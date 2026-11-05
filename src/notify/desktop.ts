// Desktop notifications without native modules:
//   macOS   alerter (buttons, stays until clicked) → osascript fallback (no buttons)
//   Windows toast XML shown through Windows PowerShell; buttons are vscode:// links
//   Linux   notify-send (buttons when libnotify supports --action) → none
// No `vscode` import: used by the extension and the background worker alike.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export type Outcome = 'primary' | 'content' | 'later' | 'none';

export type Backend = 'alerter' | 'osascript' | 'windowsToast' | 'notifySend' | 'none';

export interface DesktopNote {
  /** One per repo: a newer notification replaces the older one. */
  group: string;
  title: string;
  subtitle?: string;
  message: string;
  primaryLabel: string;
  laterLabel: string;
  /** Windows: link opened by the primary button (toasts can't call back into us). */
  primaryUri?: string;
  /** Windows: link opened when the toast body is clicked. */
  contentUri?: string;
}

export interface NotifierOptions {
  platform?: NodeJS.Platform;
  alerterPath?: string;
  iconPath?: string;
  /** macOS bundle id to show the notification as (alerter --sender). */
  macBundleId?: string;
  /** Windows AppUserModelID; defaults to Windows PowerShell's. */
  windowsAppId?: string;
}

const POWERSHELL_APP_ID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const ALERTER_CANDIDATES = ['/opt/homebrew/bin/alerter', '/usr/local/bin/alerter'];

function run(file: string, args: string[], timeoutMs = 10_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function findAlerter(explicit?: string): string | undefined {
  if (explicit && existsSync(explicit)) return explicit;
  return ALERTER_CANDIDATES.find((p) => existsSync(p));
}

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Toast XML: "reminder" scenario keeps it on screen until a button is pressed. */
export function buildToastXml(n: DesktopNote): string {
  const launch = n.contentUri ? ` activationType="protocol" launch="${xmlEscape(n.contentUri)}"` : '';
  const primary = n.primaryUri
    ? `<action content="${xmlEscape(n.primaryLabel)}" activationType="protocol" arguments="${xmlEscape(n.primaryUri)}"/>`
    : '';
  return (
    `<toast scenario="reminder"${launch}>` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${xmlEscape(n.title)}</text>` +
    (n.subtitle ? `<text>${xmlEscape(n.subtitle)}</text>` : '') +
    `<text>${xmlEscape(n.message)}</text>` +
    `</binding></visual>` +
    `<actions>${primary}<action content="${xmlEscape(n.laterLabel)}" activationType="system" arguments="dismiss"/></actions>` +
    `</toast>`
  );
}

/**
 * PowerShell expression for a string. Data goes in as base64, never as a quoted literal: PowerShell
 * also ends single-quoted strings at the curly quotes ‘ ’ ‚ ‛, so a commit subject could break out.
 */
function psLiteral(s: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(s, 'utf8').toString('base64')}'))`;
}

export function buildToastScript(xml: string, tag: string, appId: string): string {
  return [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null',
    '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
    `$doc.LoadXml(${psLiteral(xml)})`,
    '$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)',
    `$toast.Tag = ${psLiteral(tag)}`,
    `$toast.Group = 'pushpug'`,
    `try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove(${psLiteral(tag)}, 'pushpug', ${psLiteral(appId)}) } catch {}`,
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(${psLiteral(appId)}).Show($toast)`,
  ].join('\n');
}

function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodePs(script)], 20_000);
}

export class DesktopNotifier {
  private backend: Promise<Backend> | undefined;
  private alerterModern = true;
  private notifySendActions = false;
  private readonly live = new Map<string, ChildProcess>();
  private readonly linuxIds = new Map<string, string>();
  readonly platform: NodeJS.Platform;

  constructor(private readonly opts: NotifierOptions = {}) {
    this.platform = opts.platform ?? process.platform;
  }

  /** Re-detect after the user installs alerter. */
  reset(): void {
    this.backend = undefined;
  }

  detect(): Promise<Backend> {
    this.backend ??= this.detectNow();
    return this.backend;
  }

  private async detectNow(): Promise<Backend> {
    if (this.platform === 'darwin') {
      const alerter = findAlerter(this.opts.alerterPath);
      if (alerter) {
        this.opts.alerterPath = alerter;
        const help = await run(alerter, ['--help'], 5000);
        // alerter ≥ 26 uses --long-flags; the original 1.x used -camelCase.
        this.alerterModern = /--close-label/.test(help.stdout + help.stderr);
        return 'alerter';
      }
      return 'osascript';
    }
    if (this.platform === 'win32') return 'windowsToast';
    if (this.platform === 'linux') {
      const help = await run('notify-send', ['--help'], 5000);
      if (help.code !== 0 && !help.stdout) return 'none';
      this.notifySendActions = /--action/.test(help.stdout);
      return 'notifySend';
    }
    return 'none';
  }

  /** Shows a notification. Resolves when the user responds (or immediately when we can't know). */
  async show(n: DesktopNote): Promise<Outcome> {
    const backend = await this.detect();
    switch (backend) {
      case 'alerter':
        return this.showAlerter(n);
      case 'osascript':
        await run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv) subtitle (item 3 of argv)', '-e', 'end run', n.message, n.title, n.subtitle ?? '']);
        return 'none';
      case 'windowsToast': {
        const appId = this.opts.windowsAppId || POWERSHELL_APP_ID;
        const r = await runPowerShell(buildToastScript(buildToastXml(n), n.group.slice(0, 64), appId));
        if (r.code !== 0 && appId !== POWERSHELL_APP_ID) {
          // Unknown AppUserModelID on this machine: fall back to PowerShell's.
          await runPowerShell(buildToastScript(buildToastXml(n), n.group.slice(0, 64), POWERSHELL_APP_ID));
        }
        return 'none';
      }
      case 'notifySend':
        return this.showNotifySend(n);
      default:
        return 'none';
    }
  }

  private alerterArgs(n: DesktopNote): string[] {
    const m = this.alerterModern;
    const f = (modern: string, legacy: string) => (m ? modern : legacy);
    const args = [
      f('--title', '-title'), notFlag(n.title),
      f('--message', '-message'), notFlag(n.message),
      f('--actions', '-actions'), notFlag(n.primaryLabel),
      f('--close-label', '-closeLabel'), notFlag(n.laterLabel),
      f('--group', '-group'), n.group,
      f('--timeout', '-timeout'), '0',
    ];
    if (n.subtitle) args.push(f('--subtitle', '-subtitle'), notFlag(n.subtitle));
    if (this.opts.macBundleId) args.push(f('--sender', '-sender'), this.opts.macBundleId);
    if (this.opts.iconPath) args.push(f('--app-icon', '-appIcon'), this.opts.iconPath);
    return args;
  }

  private showAlerter(n: DesktopNote): Promise<Outcome> {
    this.kill(n.group);
    return new Promise((resolve) => {
      const child = spawn(this.opts.alerterPath!, this.alerterArgs(n), { stdio: ['ignore', 'pipe', 'ignore'] });
      this.live.set(n.group, child);
      let out = '';
      child.stdout!.on('data', (d) => (out += String(d)));
      child.on('error', () => resolve('none'));
      child.on('close', () => {
        if (this.live.get(n.group) === child) this.live.delete(n.group);
        resolve(parseAlerterOutput(out, n.primaryLabel));
      });
    });
  }

  private showNotifySend(n: DesktopNote): Promise<Outcome> {
    const body = n.subtitle ? `${n.subtitle}\n${n.message}` : n.message;
    const base = ['--app-name=PushPug', '--urgency=critical'];
    if (this.opts.iconPath) base.push(`--icon=${this.opts.iconPath}`);
    if (!this.notifySendActions) {
      return run('notify-send', [...base, '--', n.title, body]).then(() => 'none');
    }
    this.kill(n.group);
    return new Promise((resolve) => {
      const args = [...base, '--print-id', '--wait', `--action=primary=${n.primaryLabel}`, `--action=later=${n.laterLabel}`, '--', n.title, body];
      const child = spawn('notify-send', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      this.live.set(n.group, child);
      let out = '';
      child.stdout!.on('data', (d) => {
        out += String(d);
        const id = out.split('\n')[0].trim();
        if (/^\d+$/.test(id)) this.linuxIds.set(n.group, id);
      });
      child.on('error', () => resolve('none'));
      child.on('close', () => {
        this.live.delete(n.group);
        const lines = out.trim().split('\n');
        const action = lines.length > 1 ? lines[lines.length - 1].trim() : '';
        resolve(action === 'primary' ? 'primary' : action === 'later' ? 'later' : 'none');
      });
    });
  }

  private kill(group: string): void {
    const child = this.live.get(group);
    if (child) {
      this.live.delete(group);
      child.kill();
    }
  }

  /** Removes a notification from the screen / notification centre (best effort). */
  async remove(group: string): Promise<void> {
    this.kill(group);
    const backend = await this.detect();
    if (backend === 'alerter') {
      await run(this.opts.alerterPath!, [this.alerterModern ? '--remove' : '-remove', group], 5000);
    } else if (backend === 'windowsToast') {
      const appId = this.opts.windowsAppId || POWERSHELL_APP_ID;
      await runPowerShell(
        [
          '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
          `try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove(${psLiteral(group.slice(0, 64))}, 'pushpug', ${psLiteral(appId)}) } catch {}`,
          `try { [Windows.UI.Notifications.ToastNotificationManager]::History.Remove(${psLiteral(group.slice(0, 64))}, 'pushpug', ${psLiteral(POWERSHELL_APP_ID)}) } catch {}`,
        ].join('\n'),
      );
    } else if (backend === 'notifySend') {
      const id = this.linuxIds.get(group);
      if (id) {
        this.linuxIds.delete(group);
        await run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications', '--object-path', '/org/freedesktop/Notifications', '--method', 'org.freedesktop.Notifications.CloseNotification', id], 5000);
      }
    }
  }
}

/**
 * Text that starts with "-" (e.g. a teammate called "-x") would be read by alerter as an option and
 * the alert dropped; an invisible zero-width space in front keeps it plain text.
 */
export function notFlag(s: string): string {
  return s.startsWith('-') ? `\u200b${s}` : s;
}

export function parseAlerterOutput(out: string, primaryLabel: string): Outcome {
  const s = out.trim();
  if (s === primaryLabel || s === '@ACTIONCLICKED') return 'primary';
  if (s === '@CONTENTCLICKED') return 'content';
  if (s.startsWith('{')) {
    // --json output
    try {
      const j = JSON.parse(s) as { activationType?: string; activationValue?: string };
      if (j.activationType === 'actionClicked' || j.activationValue === primaryLabel) return 'primary';
      if (j.activationType === 'contentsClicked') return 'content';
    } catch {
      /* fall through */
    }
  }
  return 'later';
}
