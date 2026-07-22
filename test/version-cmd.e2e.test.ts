/**
 * e2e for `agentcomm version` / `-v` / `--version` — prints the installed
 * version and compares it against the latest GitHub release (the release
 * artifact is the distribution). Network-tolerant: offline/rate-limited runs
 * must still print the installed version, so assertions accept latest=null.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const pkgVersion = (JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version: string })
  .version;

function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENTCOMM_NO_GIT_PROBE: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('CLI version (installed + latest-release comparison)', () => {
  it('--json reports the package version and a latest/upToDate verdict', async () => {
    const r = await run(['version', '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { version: string; latest: string | null; upToDate: boolean | null; install?: string };
    expect(out.version).toBe(pkgVersion);
    if (out.latest === null) {
      expect(out.upToDate).toBeNull(); // offline / rate-limited — verdict unknowable
    } else {
      expect(out.latest).toMatch(/^\d+\.\d+\.\d+/);
      expect(typeof out.upToDate).toBe('boolean');
      // The upgrade one-liner appears exactly when an update exists, and
      // points at the registry's always-newest dist-tag.
      if (out.upToDate) expect(out.install).toBeUndefined();
      else expect(out.install).toBe('npm install -g agentcomm@latest');
    }
  });

  it('-v and --version print a human line and never touch the backend', async () => {
    for (const args of [['-v'], ['--version'], ['version']]) {
      const r = await run(args);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(new RegExp(`^agentcomm ${pkgVersion.replace(/\./g, '\\.')}`));
      // Static command: no backend banner, no bus connection.
      expect(r.stderr).not.toContain('using ');
    }
  });
});
