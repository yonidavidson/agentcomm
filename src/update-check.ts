/**
 * "Update available" nudge — shared across every harness (omp/pi-style).
 *
 * None of the harnesses auto-upgrade an installed plugin: OpenCode caches the
 * tarball by URL forever, and Claude Code / Codex pin the installed commit and
 * never re-check (there is no built-in "plugin outdated" notice — see
 * anthropics/claude-code#31462). So the plugin itself compares its installed
 * version to the latest GitHub release once a day and, when behind, surfaces a
 * one-line notice telling the user how to upgrade for their harness. Everything
 * fails open and is network-capped — it never blocks a session.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO = 'yonidavidson/agentcomm';
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

/**
 * The registry-less fallback install artifact: every release attaches a copy
 * of the CLI tarball under this constant name, and GitHub's `releases/latest`
 * redirect keeps the URL pointing at the newest one. Environments that can't
 * reach the npm registry `npm install -g` this URL instead.
 */
export const LATEST_ARTIFACT_URL = `https://github.com/${REPO}/releases/latest/download/agentcomm-latest.tgz`;

/**
 * THE upgrade command, quoted verbatim by the update notice, `agentcomm
 * version`, the help, and the docs. The npm registry is the canonical
 * distribution; LATEST_ARTIFACT_URL stays as the registry-less fallback.
 */
export const INSTALL_COMMAND = 'npm install -g @yonidavidson/agentcomm@latest';

export type Harness = 'opencode' | 'claude' | 'codex';

/** One upgrade story for every harness: reinstall the global CLI from the registry. */
const HOW_TO_UPGRADE = (): string => `Upgrade: ${INSTALL_COMMAND}`;

/** Numeric semver-ish compare of dotted versions: >0 if a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Build the user-facing notice, or null if `latest` is not newer than `mine`. */
export function updateMessage(mine: string, latestTag: string, _harness: Harness): string | null {
  if (compareVersions(latestTag, mine) <= 0) return null;
  const v = mine.replace(/^v/, '');
  return (
    `agentcomm update available: v${v} → ${latestTag}. ` +
    `${HOW_TO_UPGRADE()} ` +
    `(latest: https://github.com/${REPO}/releases/latest)`
  );
}

/** This package's installed version, read from its own package.json (dist/ is one level down). */
export function ownVersion(): string | null {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url)); // <pkg>/dist
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Latest release tag on GitHub, or null on any failure (offline, rate-limit,
 * timeout). GitHub stays the version source of truth even though installs go
 * through the npm registry: the release workflow tags and publishes in one
 * motion, so tag == npm version, and the check keeps working in environments
 * where only github.com is reachable.
 */
export async function fetchLatestTag(timeoutMs: number = FETCH_TIMEOUT_MS): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentcomm' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown };
    return typeof body.tag_name === 'string' ? body.tag_name : null;
  } catch {
    return null;
  }
}

/**
 * Returns an "update available" notice string, or null. Throttled to one network
 * check per day per harness via a temp-file cache; always fails open.
 */
export async function updateNotice(harness: Harness): Promise<string | null> {
  const mine = ownVersion();
  if (!mine) return null;

  const cache = path.join(os.tmpdir(), `agentcomm-update-${harness}.json`);

  // Day-throttle: reuse a recent result rather than hitting GitHub every session.
  try {
    const c = JSON.parse(readFileSync(cache, 'utf8')) as { at?: number; forVersion?: string; notice?: string | null };
    if (typeof c.at === 'number' && Date.now() - c.at < DAY_MS) {
      return c.forVersion === mine ? (c.notice ?? null) : null;
    }
  } catch {
    /* no/invalid cache — fall through to a fresh check */
  }

  const tag = await fetchLatestTag();
  const notice = tag ? updateMessage(mine, tag, harness) : null;
  try {
    writeFileSync(cache, JSON.stringify({ at: Date.now(), forVersion: mine, notice }));
  } catch {
    /* best effort */
  }
  return notice;
}
