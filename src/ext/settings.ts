import * as vscode from 'vscode';
import type { LangSetting } from '../i18n';
import { DEFAULT_CONFIG, DEFAULT_MODE, MODES, clampConfig, type Adjustment, type FrequencyConfig, type Mode } from '../core/frequency';

export type ThemeSetting = 'system' | 'light' | 'dark';
export type PrWorkflow = 'ask' | 'direct' | 'pullRequest';

export interface Settings {
  language: LangSetting;
  theme: ThemeSetting;
  notifyInVSCode: boolean;
  notifyDesktop: boolean;
  notifyBackground: boolean;
  sameFileWarning: boolean;
  actionsEnabled: boolean;
  avatarsEnabled: boolean;
  /** Tell me when checks pass too (failures are always reported). */
  checksOnPass: boolean;
  /** Whose pushes to report checks for. */
  checksFor: 'all' | 'mine' | 'team';
  /** Pull request workflow (start task, send for review, follow the pull request). */
  prEnabled: boolean;
  /** How my commits on main get to the team: ask each time, push straight to main, or always via pull request. */
  prWorkflow: PrWorkflow;
  /** Tell me when a teammate opens a pull request. */
  prNotifyTeam: boolean;
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
}

const SETTING_KEYS: Record<keyof Settings, string> = {
  language: 'language',
  theme: 'theme',
  notifyInVSCode: 'notify.inVSCode',
  notifyDesktop: 'notify.desktop',
  notifyBackground: 'notify.background',
  sameFileWarning: 'notify.sameFileWarning',
  actionsEnabled: 'actions.enabled',
  avatarsEnabled: 'avatars',
  checksOnPass: 'actions.notifyOnPass',
  checksFor: 'actions.notifyFor',
  prEnabled: 'pullRequests.enabled',
  prWorkflow: 'pullRequests.workflow',
  prNotifyTeam: 'pullRequests.notifyTeam',
  quietEnabled: 'quiet.enabled',
  quietStart: 'quiet.start',
  quietEnd: 'quiet.end',
};

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('pushpug');
  return {
    language: c.get<LangSetting>('language', 'auto'),
    theme: c.get<ThemeSetting>('theme', 'system'),
    notifyInVSCode: c.get<boolean>('notify.inVSCode', true),
    notifyDesktop: c.get<boolean>('notify.desktop', true),
    notifyBackground: c.get<boolean>('notify.background', false),
    sameFileWarning: c.get<boolean>('notify.sameFileWarning', true),
    actionsEnabled: c.get<boolean>('actions.enabled', true),
    avatarsEnabled: c.get<boolean>('avatars', true),
    checksOnPass: c.get<boolean>('actions.notifyOnPass', true),
    checksFor: c.get<'all' | 'mine' | 'team'>('actions.notifyFor', 'all'),
    prEnabled: c.get<boolean>('pullRequests.enabled', true),
    prWorkflow: c.get<PrWorkflow>('pullRequests.workflow', 'ask'),
    prNotifyTeam: c.get<boolean>('pullRequests.notifyTeam', true),
    quietEnabled: c.get<boolean>('quiet.enabled', false),
    quietStart: c.get<string>('quiet.start', '22:00'),
    quietEnd: c.get<string>('quiet.end', '08:00'),
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const c = vscode.workspace.getConfiguration('pushpug');
  for (const [k, v] of Object.entries(patch) as Array<[keyof Settings, unknown]>) {
    await c.update(SETTING_KEYS[k], v, vscode.ConfigurationTarget.Global);
  }
}

// ---------- Frequency & battery ----------

/** Setting key (under "pushpug.") for every field of FrequencyConfig. */
export const FREQUENCY_KEYS = {
  checkSeconds: 'checkIntervalSeconds',
  actionsSeconds: 'actions.intervalSeconds',
  backgroundSeconds: 'background.intervalSeconds',
  'idle.enabled': 'battery.idle.enabled',
  'idle.minutes': 'battery.idle.minutes',
  'idle.seconds': 'battery.idle.intervalSeconds',
  'lowBattery.enabled': 'battery.lowBattery.enabled',
  'lowBattery.percent': 'battery.lowBattery.percent',
  'lowBattery.seconds': 'battery.lowBattery.intervalSeconds',
  'lowPowerMode.enabled': 'battery.lowPowerMode.enabled',
  'lowPowerMode.seconds': 'battery.lowPowerMode.intervalSeconds',
  pluggedInUsesNormal: 'battery.pluggedInUsesNormal',
  'activeHours.enabled': 'activeHours.enabled',
  'activeHours.start': 'activeHours.start',
  'activeHours.end': 'activeHours.end',
} as const;
export type FrequencyField = keyof typeof FREQUENCY_KEYS;
export const FREQUENCY_SETTING_IDS = Object.values(FREQUENCY_KEYS).map((k) => `pushpug.${k}`);

export function getField(c: FrequencyConfig, field: FrequencyField): unknown {
  const [a, b] = field.split('.');
  const v = (c as unknown as Record<string, unknown>)[a];
  return b ? (v as Record<string, unknown>)[b] : v;
}

export function setField(c: FrequencyConfig, field: FrequencyField, value: unknown): void {
  const [a, b] = field.split('.');
  const rec = c as unknown as Record<string, unknown>;
  if (b) (rec[a] as Record<string, unknown>)[b] = value;
  else rec[a] = value;
}

export function readMode(): Mode {
  const m = vscode.workspace.getConfiguration('pushpug').get<string>('mode', DEFAULT_MODE);
  return (MODES as string[]).includes(m) ? (m as Mode) : DEFAULT_MODE;
}

/** Values as stored, before clamping. */
export function readRawFrequency(): FrequencyConfig {
  const c = vscode.workspace.getConfiguration('pushpug');
  const out: FrequencyConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  for (const [field, key] of Object.entries(FREQUENCY_KEYS) as Array<[FrequencyField, string]>) {
    const v = c.get(key);
    if (v !== undefined && v !== null) setField(out, field, v);
  }
  return out;
}

export function readFrequency(): { config: FrequencyConfig; adjustments: Adjustment[] } {
  return clampConfig(readRawFrequency());
}

/** Write only the fields that differ from what is stored now. */
export async function writeFrequency(next: FrequencyConfig): Promise<void> {
  const c = vscode.workspace.getConfiguration('pushpug');
  const current = readRawFrequency();
  for (const [field, key] of Object.entries(FREQUENCY_KEYS) as Array<[FrequencyField, string]>) {
    const v = getField(next, field);
    if (v !== getField(current, field)) await c.update(key, v, vscode.ConfigurationTarget.Global);
  }
}

export async function writeMode(mode: Mode): Promise<void> {
  if (readMode() !== mode) await vscode.workspace.getConfiguration('pushpug').update('mode', mode, vscode.ConfigurationTarget.Global);
}

/** Every PushPug setting back to its default (removed from User settings). */
export async function resetAllSettings(): Promise<void> {
  const c = vscode.workspace.getConfiguration('pushpug');
  const keys = ['mode', ...Object.values(SETTING_KEYS), ...Object.values(FREQUENCY_KEYS)];
  for (const k of keys) {
    if (c.inspect(k)?.globalValue !== undefined) await c.update(k, undefined, vscode.ConfigurationTarget.Global);
  }
}
