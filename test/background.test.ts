import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTeam, write, commitAndPush, type Team } from './helpers';
import { git } from '../src/git/exec';
import { installAgent, uninstallAgent, isAgentInstalled, isBackgroundSupported, plistPath, windowsTaskName, type AgentPaths, type Runner } from '../src/background/agent';
import { SharedStore, type WorkerConfig } from '../src/core/storage';
import { presetConfig, type FrequencyConfig } from '../src/core/frequency';

function fakeRunner() {
  const calls: Array<{ file: string; args: string[] }> = [];
  const run: Runner = async (file, args) => {
    calls.push({ file, args });
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

describe('background job registration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pushpug-agent-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const paths = (platform: NodeJS.Platform): AgentPaths => ({
    platform,
    home: join(dir, 'home'),
    storageDir: join(dir, 'storage dir'),
    nodeExe: '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
    workerFile: join(dir, 'storage dir', 'worker.js'),
  });

  test('macOS: writes a LaunchAgent that runs every 60 s with VS Code’s Node, then removes it', async () => {
    const p = paths('darwin');
    const { calls, run } = fakeRunner();
    await installAgent(p, run);
    const plist = readFileSync(plistPath(p.home), 'utf8');
    assert.match(plist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
    assert.match(plist, /<key>ELECTRON_RUN_AS_NODE<\/key>\s*<string>1<\/string>/);
    assert.match(plist, /<string>\/Applications\/Visual Studio Code\.app\/Contents\/MacOS\/Code<\/string>/);
    assert.match(plist, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
    assert.ok(calls.some((c) => c.file === 'launchctl' && c.args[0] === 'bootstrap'));
    assert.equal(isAgentInstalled(p), true);

    calls.length = 0;
    await uninstallAgent(p, run);
    assert.equal(existsSync(plistPath(p.home)), false);
    assert.ok(calls.some((c) => c.file === 'launchctl' && c.args[0] === 'bootout'));
    assert.equal(isAgentInstalled(p), false);
  });

  test('Windows: creates a hidden every-minute task through a wscript launcher, then deletes it', async () => {
    const p = { ...paths('win32'), nodeExe: 'C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' };
    const { calls, run } = fakeRunner();
    await installAgent(p, run);
    const vbsBuf = readFileSync(join(p.storageDir, 'launcher.vbs'));
    assert.deepEqual([...vbsBuf.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 LE with a BOM, so non-ASCII paths survive');
    const vbs = vbsBuf.subarray(2).toString('utf16le');
    assert.match(vbs, /ELECTRON_RUN_AS_NODE"\) = "1"/);
    assert.match(vbs, /, 0, False/); // 0 = hidden window
    const xmlBuf = readFileSync(join(p.storageDir, 'task.xml'));
    assert.deepEqual([...xmlBuf.subarray(0, 2)], [0xff, 0xfe]);
    const xml = xmlBuf.subarray(2).toString('utf16le');
    assert.match(xml, /<Interval>PT1M<\/Interval>/);
    assert.match(xml, /<Hidden>true<\/Hidden>/);
    assert.match(xml, /<DisallowStartIfOnBatteries>false/);
    const create = calls.find((c) => c.file === 'schtasks.exe');
    assert.deepEqual(create?.args.slice(0, 4), ['/Create', '/F', '/TN', windowsTaskName()]);
    assert.equal(isAgentInstalled(p), true);

    calls.length = 0;
    await uninstallAgent(p, run);
    assert.deepEqual(calls[0].args, ['/Delete', '/F', '/TN', windowsTaskName()]);
    assert.equal(isAgentInstalled(p), false);
  });
});

describe('background worker', () => {
  let t: Team;
  let storage: string;
  let extensionsDir: string;
  let home: string;
  let logFile: string;
  const workerBundle = join(__dirname, 'worker.cjs');

  beforeEach(async () => {
    t = await makeTeam();
    storage = join(t.dir, 'globalStorage');
    extensionsDir = join(t.dir, 'extensions');
    home = join(t.dir, 'home');
    logFile = join(t.dir, 'worker-test.log');
    mkdirSync(join(extensionsDir, 'pushpug.pushpug-1.0.0'), { recursive: true });
    mkdirSync(home, { recursive: true });
    const store = new SharedStore(storage);
    const cfg: WorkerConfig = {
      version: 1,
      lang: 'th',
      repos: [t.bob],
      extensionId: 'pushpug.pushpug',
      uriScheme: 'vscode',
      extensionsDir,
      extensionDirPrefix: 'pushpug.pushpug-',
      enabled: true,
    };
    store.writeConfig(cfg);
    writeFileSync(store.workerFile, '// copy');
  });
  afterEach(() => t.cleanup());

  function runWorker(env: Record<string, string> = {}) {
    execFileSync(process.execPath, [workerBundle, storage], {
      env: { ...process.env, PUSHPUG_TEST_LOG: logFile, HOME: home, USERPROFILE: home, ...env },
      timeout: 60_000,
    });
  }
  function events(type?: string): any[] {
    if (!existsSync(logFile)) return [];
    const all = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return type ? all.filter((e) => e.type === type) : all;
  }

  test('notifies once per new commit, in the chosen language, and never pulls', async () => {
    runWorker();
    assert.equal(events('notify').length, 0, 'nothing new yet');

    write(t.alice, 'x.txt', 'x');
    await commitAndPush(t.alice, 'เพิ่มหน้า login');
    const bobHead = (await git(t.bob, ['rev-parse', 'HEAD'])).trim();
    runWorker();
    const n = events('notify');
    assert.equal(n.length, 1);
    assert.equal(n[0].title, 'Alice Lee push โค้ดใหม่มาแล้ว');
    assert.match(n[0].message, /เพิ่มหน้า login/);
    assert.equal((await git(t.bob, ['rev-parse', 'HEAD'])).trim(), bobHead, 'worker must not pull');

    runWorker();
    runWorker();
    assert.equal(events('notify').length, 1, 'no repeat for the same commit');

    write(t.alice, 'y.txt', 'y');
    await commitAndPush(t.alice, 'Second push');
    runWorker();
    assert.equal(events('notify').length, 2, 'a newer commit is announced again');
  });

  test('takes its alert off the screen once the new commits were pulled', async () => {
    write(t.alice, 'x.txt', 'x');
    await commitAndPush(t.alice, 'new page');
    runWorker();
    assert.equal(events('notify').length, 1);
    runWorker();
    assert.equal(events('remove').length, 0, 'still behind: the alert stays');
    await git(t.bob, ['pull']);
    runWorker();
    assert.equal(events('remove').length, 1);
    runWorker();
    assert.equal(events('remove').length, 1, 'removed only once');
  });

  test('stays quiet while VS Code has the repo open (fresh heartbeat)', async () => {
    new SharedStore(storage).writeHeartbeat('window-1', [t.bob]);
    write(t.alice, 'x.txt', 'x');
    await commitAndPush(t.alice, 'While open');
    runWorker();
    assert.equal(events('notify').length, 0);
    assert.equal(events('skipOpen').length, 1);
    assert.equal((await git(t.bob, ['rev-parse', '--verify', '-q', 'origin/main'])).trim(), (await git(t.bob, ['rev-parse', 'HEAD'])).trim(), 'did not even fetch');

    // Heartbeat goes stale (VS Code closed / crashed) → notify.
    new SharedStore(storage).writeHeartbeat('window-1', [t.bob], Date.now() - 5 * 60_000);
    runWorker();
    assert.equal(events('notify').length, 1);
  });

  test('does nothing when disabled', async () => {
    const store = new SharedStore(storage);
    store.writeConfig({ ...store.readConfig()!, enabled: false });
    write(t.alice, 'x.txt', 'x');
    await commitAndPush(t.alice, 'x');
    runWorker();
    assert.equal(events('notify').length, 0);
  });

  test('removes itself when the extension was uninstalled', async () => {
    rmSync(join(extensionsDir, 'pushpug.pushpug-1.0.0'), { recursive: true });
    runWorker();
    assert.equal(events('selfDestruct').length, 1);
    if (isBackgroundSupported(process.platform)) {
      assert.ok(events('exec').some((e) => e.file === 'launchctl' || e.file === 'schtasks.exe'));
    }
    assert.equal(existsSync(join(storage, 'worker.js')), false);
    assert.equal(existsSync(join(storage, 'config.json')), false);
  });

  test('treats an extension marked obsolete (pending uninstall) as removed', async () => {
    writeFileSync(join(extensionsDir, '.obsolete'), JSON.stringify({ 'pushpug.pushpug-1.0.0': true }));
    runWorker();
    assert.equal(events('selfDestruct').length, 1);
  });

  test('do-not-disturb hours and snooze: no notification, announced afterwards', async () => {
    const store = new SharedStore(storage);
    const h = new Date().getHours();
    const pad = (n: number) => String(n).padStart(2, '0');
    store.writeConfig({ ...store.readConfig()!, quiet: { enabled: true, start: `${pad(h)}:00`, end: `${pad((h + 1) % 24)}:00` } });
    write(t.alice, 'q.txt', 'q');
    await commitAndPush(t.alice, 'During quiet hours');
    runWorker();
    assert.equal(events('notify').length, 0);
    assert.equal(events('quiet').length, 1);

    // Quiet hours over, but snoozed for an hour.
    store.writeConfig({ ...store.readConfig()!, quiet: { enabled: false, start: '22:00', end: '08:00' } });
    store.setSnooze(Date.now() + 60 * 60_000);
    runWorker();
    assert.equal(events('notify').length, 0);
    store.setSnooze(0);
    runWorker();
    assert.equal(events('notify').length, 1, 'announced once it is no longer quiet');
  });

  describe('schedule from config.json', () => {
    const setFrequency = (f: FrequencyConfig) => {
      const store = new SharedStore(storage);
      store.writeConfig({ ...store.readConfig()!, frequency: f });
    };
    const lastCheck = (msAgo: number) => writeFileSync(new SharedStore(storage).stateFile, JSON.stringify({ lastCheckAt: Date.now() - msAgo }));
    const last = () => events().filter((e) => e.type === 'run' || e.type === 'skip').pop();
    const allDay = (h: number) => {
      // A one-hour window that is certainly not "now".
      const s = (h + 2) % 24;
      return { enabled: true, start: `${String(s).padStart(2, '0')}:00`, end: `${String((s + 1) % 24).padStart(2, '0')}:00` };
    };

    test('runs when due, skips until the background interval has passed', () => {
      setFrequency(presetConfig('balanced')); // background every 120 s
      runWorker();
      assert.equal(last().type, 'run');
      runWorker();
      assert.deepEqual(last(), { type: 'skip', reason: 'notDue' });
      lastCheck(125_000);
      runWorker();
      assert.equal(last().type, 'run');
    });

    test('a new interval in config.json applies on the very next run', () => {
      setFrequency({ ...presetConfig('balanced'), backgroundSeconds: 3600 });
      lastCheck(200_000);
      runWorker();
      assert.deepEqual(last(), { type: 'skip', reason: 'notDue' });
      setFrequency({ ...presetConfig('balanced'), backgroundSeconds: 120 }); // what the extension writes when the user changes it
      runWorker();
      assert.equal(last().type, 'run');
    });

    test('pauses outside the checking hours', () => {
      setFrequency({ ...presetConfig('balanced'), activeHours: allDay(new Date().getHours()) });
      lastCheck(3600_000);
      runWorker();
      assert.deepEqual(last(), { type: 'skip', reason: 'outsideHours' });
    });

    test('battery rules slow the background job down too', () => {
      const f = { ...presetConfig('balanced'), lowBattery: { enabled: true, percent: 20, seconds: 600 }, lowPowerMode: { enabled: true, seconds: 900 } };
      setFrequency(f);
      lastCheck(130_000);
      runWorker({ PUSHPUG_TEST_POWER: JSON.stringify({ onAC: false, percent: 10 }) });
      assert.deepEqual(last(), { type: 'skip', reason: 'lowBattery' });
      runWorker({ PUSHPUG_TEST_POWER: JSON.stringify({ onAC: true, percent: 10 }) });
      assert.deepEqual(last(), { type: 'run', reason: 'pluggedIn' }, 'plugged in → normal interval');
      lastCheck(130_000);
      runWorker({ PUSHPUG_TEST_POWER: JSON.stringify({ onAC: false, lowPowerMode: true }) });
      assert.deepEqual(last(), { type: 'skip', reason: 'lowPowerMode' });
      runWorker({ PUSHPUG_TEST_POWER: JSON.stringify({ onAC: false, percent: 90, lowPowerMode: false }) });
      assert.deepEqual(last(), { type: 'run', reason: 'normal' });
    });

    test('configs written by 1.0.0 (no frequency) keep running every time', () => {
      runWorker();
      runWorker();
      assert.deepEqual(events('run').map((e) => e.reason), ['legacy', 'legacy']);
    });
  });
});

test('shared storage recreates its folder if it was deleted while running', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pushpug-store-'));
  const store = new SharedStore(join(dir, 'storage'));
  rmSync(store.dir, { recursive: true, force: true });
  store.writeHeartbeat('w1', ['/tmp/repo']);
  assert.ok(existsSync(join(store.heartbeatDir, 'w1.json')));
  rmSync(dir, { recursive: true, force: true });
});
