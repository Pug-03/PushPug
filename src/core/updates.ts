// New-version check for copies installed from a GitHub .vsix (the Marketplace
// updates its own copies). No vscode import: tested on its own.

export interface Release {
  version: string;
  /** Release page on GitHub. */
  url: string;
  /** Download link of the .vsix asset, if the release has one. */
  vsixUrl: string | null;
  notes: string;
}

/** "v1.2.3" / "1.2.3-beta.1" → [1, 2, 3]; null when it isn't a version. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is a newer version than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** "https://github.com/Owner/Repo.git" → "Owner/Repo". */
export function repoSlug(url: string | undefined): string | null {
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url ?? '');
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Reads GitHub's "latest release" answer; null for drafts, pre-releases and anything malformed. */
export function parseRelease(json: unknown): Release | null {
  if (!json || typeof json !== 'object') return null;
  const r = json as { tag_name?: unknown; html_url?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
  if (r.draft || r.prerelease || typeof r.tag_name !== 'string' || typeof r.html_url !== 'string') return null;
  if (!parseVersion(r.tag_name)) return null;
  const assets = Array.isArray(r.assets) ? (r.assets as Array<{ name?: unknown; browser_download_url?: unknown }>) : [];
  const vsix = assets.find((a) => typeof a.name === 'string' && a.name.endsWith('.vsix') && typeof a.browser_download_url === 'string');
  const vsixUrl = vsix && /^https:\/\/github\.com\//.test(vsix.browser_download_url as string) ? (vsix.browser_download_url as string) : null;
  return {
    version: r.tag_name.replace(/^v/, ''),
    url: r.html_url,
    vsixUrl,
    notes: typeof r.body === 'string' ? r.body : '',
  };
}
