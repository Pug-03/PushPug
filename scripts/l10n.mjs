// Generates l10n/bundle.l10n.th.json for vscode.l10n from our own message
// catalogs (src/i18n/locales/*.json). vscode.l10n keys bundles by the English
// source string, so we map every English message to its Thai translation.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

export function generateL10nBundle() {
  const enPath = 'src/i18n/locales/en.json';
  const thPath = 'src/i18n/locales/th.json';
  if (!existsSync(enPath) || !existsSync(thPath)) return;
  const en = JSON.parse(readFileSync(enPath, 'utf8'));
  const th = JSON.parse(readFileSync(thPath, 'utf8'));
  const missing = Object.keys(en).filter((k) => !(k in th));
  if (missing.length) throw new Error(`th.json is missing keys: ${missing.join(', ')}`);
  const bundle = {};
  for (const [key, text] of Object.entries(en)) {
    if (key.startsWith('wv.')) continue; // webview strings are shipped separately
    // vscode.l10n looks up by the English text: one English text must have one Thai text.
    if (text in bundle && bundle[text] !== th[key]) throw new Error(`"${text}" has two different Thai texts (${key})`);
    bundle[text] = th[key];
  }
  mkdirSync('l10n', { recursive: true });
  writeFileSync('l10n/bundle.l10n.th.json', JSON.stringify(bundle, null, 2) + '\n');
}
