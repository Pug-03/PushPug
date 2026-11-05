// Installs / removes the background job that runs worker.js every minute:
//   macOS   ~/Library/LaunchAgents/com.pushpug.watcher.plist (launchd, StartInterval 60)
//   Windows Task Scheduler task (repeats every minute, hidden, via wscript launcher)
// No `vscode` import: shared by the extension, the worker (self-removal) and
// the uninstall hook. Commands go through an injectable runner for tests.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';

export const MAC_LABEL = 'com.pushpug.watcher';
const LEGACY_MAC_LABEL = 'com.pushpal.watcher';

export interface AgentPaths {
  platform: NodeJS.Platform;
  home: string;
  /** globalStorage folder holding worker.js and config.json. */
  storageDir: string;
  /** Electron binary run with ELECTRON_RUN_AS_NODE=1. */
  nodeExe: string;
  workerFile: string;
}

export type Runner = (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realRunner: Runner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function isBackgroundSupported(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function plistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
}

export function windowsTaskName(): string {
  let user = 'user';
  try {
    user = userInfo().username.replace(/[^\w.-]/g, '_');
  } catch {
    /* ignore */
  }
  return `PushPug Watcher - ${user}`;
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildPlist(p: AgentPaths): string {
  const path = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(p.nodeExe)}</string>
    <string>${xml(p.workerFile)}</string>
    <string>${xml(p.storageDir)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ELECTRON_RUN_AS_NODE</key>
    <string>1</string>
    <key>PATH</key>
    <string>${path}</string>
  </dict>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

/**
 * launcher.vbs as written to disk: UTF-16 LE with a BOM. wscript reads a file without a BOM in the
 * system code page, which garbles non-ASCII paths (e.g. a Thai Windows user name).
 */
export function vbsFileBytes(p: AgentPaths): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildVbs(p), 'utf16le')]);
}

/** VBScript launcher: sets ELECTRON_RUN_AS_NODE and starts the worker with no window. */
export function buildVbs(p: AgentPaths): string {
  const q = (s: string) => `""${s.replace(/"/g, '""')}""`;
  return [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Environment("Process")("ELECTRON_RUN_AS_NODE") = "1"',
    `sh.Run "${q(p.nodeExe)} ${q(p.workerFile)} ${q(p.storageDir)}", 0, False`,
    '',
  ].join('\r\n');
}

export function buildTaskXml(vbsPath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>PushPug: checks your git projects for teammates' new commits every minute (git fetch only, never changes your files).</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT1M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2024-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B //Nologo "${xml(vbsPath)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function guiDomain(): string {
  return `gui/${process.getuid ? process.getuid() : 501}`;
}

export async function installAgent(p: AgentPaths, run: Runner = realRunner): Promise<void> {
  if (p.platform === 'darwin') {
    const file = plistPath(p.home);
    mkdirSync(join(p.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(file, buildPlist(p));
    await run('launchctl', ['bootout', `${guiDomain()}/${MAC_LABEL}`]);
    const r = await run('launchctl', ['bootstrap', guiDomain(), file]);
    if (r.code !== 0) {
      const legacy = await run('launchctl', ['load', '-w', file]);
      if (legacy.code !== 0) throw new Error((r.stderr || legacy.stderr).trim() || 'launchctl failed');
    }
    return;
  }
  if (p.platform === 'win32') {
    mkdirSync(p.storageDir, { recursive: true });
    const vbs = join(p.storageDir, 'launcher.vbs');
    writeFileSync(vbs, vbsFileBytes(p));
    const taskXml = join(p.storageDir, 'task.xml');
    // Task Scheduler wants UTF-16 LE with a BOM.
    writeFileSync(taskXml, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(buildTaskXml(vbs), 'utf16le')]));
    const r = await run('schtasks.exe', ['/Create', '/F', '/TN', windowsTaskName(), '/XML', taskXml]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || 'schtasks failed');
    writeFileSync(join(p.storageDir, 'agent-installed'), windowsTaskName());
    return;
  }
  throw new Error('unsupported platform');
}

export async function uninstallAgent(p: Pick<AgentPaths, 'platform' | 'home' | 'storageDir'>, run: Runner = realRunner): Promise<void> {
  if (p.platform === 'darwin') {
    const file = plistPath(p.home);
    const r = await run('launchctl', ['bootout', `${guiDomain()}/${MAC_LABEL}`]);
    if (r.code !== 0 && existsSync(file)) await run('launchctl', ['unload', '-w', file]);
    rmSync(file, { force: true });
  } else if (p.platform === 'win32') {
    await run('schtasks.exe', ['/Delete', '/F', '/TN', windowsTaskName()]);
    for (const f of ['launcher.vbs', 'task.xml', 'agent-installed']) rmSync(join(p.storageDir, f), { force: true });
  }
}

/** Removes the job installed by versions named PushPal (label com.pushpal.watcher / task "PushPal Watcher"). */
export async function removeLegacyAgent(p: Pick<AgentPaths, 'platform' | 'home'>, run: Runner = realRunner): Promise<boolean> {
  if (p.platform === 'darwin') {
    const file = join(p.home, 'Library', 'LaunchAgents', `${LEGACY_MAC_LABEL}.plist`);
    if (!existsSync(file)) return false;
    await run('launchctl', ['bootout', `${guiDomain()}/${LEGACY_MAC_LABEL}`]);
    rmSync(file, { force: true });
    return true;
  }
  if (p.platform === 'win32') {
    const r = await run('schtasks.exe', ['/Delete', '/F', '/TN', windowsTaskName().replace('PushPug', 'PushPal')]);
    return r.code === 0;
  }
  return false;
}

export function isAgentInstalled(p: Pick<AgentPaths, 'platform' | 'home' | 'storageDir'>): boolean {
  if (p.platform === 'darwin') return existsSync(plistPath(p.home));
  if (p.platform === 'win32') return existsSync(join(p.storageDir, 'agent-installed'));
  return false;
}

export function defaultHome(): string {
  return homedir();
}
