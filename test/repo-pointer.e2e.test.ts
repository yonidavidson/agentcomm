/**
 * e2e for the repo pointer (issue #117) — `--repo <dir>` / AGENTCOMM_REPO /
 * config `"repo"` resolve the bus as if the CLI ran inside another checkout:
 * its .agentcomm config, its git remote, its file:// fallback. What
 * agentcomm-arcade faked with a child-process cwd, first-class.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-repo-ptr-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function run(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      // No AGENTCOMM_BACKEND here — the repo pointer only acts when the
      // backend is NOT explicit, which is exactly the path under test.
      env: { ...process.env, AGENTCOMM_BACKEND: undefined, AGENTCOMM_NO_GIT_PROBE: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** A "bus repo": a directory whose .agentcomm.json pins a file:// backend inside it. */
async function mkBusRepo(): Promise<{ dir: string; backend: string }> {
  const dir = await mkTmp();
  const backend = `file://${path.join(dir, '.bus')}`;
  await fs.writeFile(path.join(dir, '.agentcomm.json'), JSON.stringify({ backend }));
  return { dir, backend };
}

describe('repo pointer (--repo / AGENTCOMM_REPO / config "repo")', () => {
  it('--repo resolves the target repo config and both sides see one bus', async () => {
    const { dir: busRepo, backend } = await mkBusRepo();
    const outside = await mkTmp();

    const reg = await run(['register', '--as', 'dashboard', '--repo', busRepo, '--json'], outside);
    expect(reg.code).toBe(0);
    expect(reg.stderr).toContain(`via repo pointer ${busRepo}`);

    // An agent running INSIDE the bus repo sees the outsider on its roster.
    const roster = await run(['agents', '--json'], busRepo);
    expect(roster.code).toBe(0);
    expect((JSON.parse(roster.stdout) as { name: string }[]).map((a) => a.name)).toContain('dashboard');
    expect(reg.stderr).toContain(backend);
  });

  it('AGENTCOMM_REPO env and config "repo" work; flag > env precedence holds', async () => {
    const { dir: busRepo } = await mkBusRepo();
    const { dir: otherRepo, backend: otherBackend } = await mkBusRepo();
    const outside = await mkTmp();

    const viaEnv = await run(['register', '--as', 'via-env', '--json'], outside, { AGENTCOMM_REPO: busRepo });
    expect(viaEnv.code).toBe(0);
    expect(viaEnv.stderr).toContain(`via repo pointer ${busRepo}`);

    // Flag beats env.
    const viaFlag = await run(['register', '--as', 'via-flag', '--repo', otherRepo, '--json'], outside, {
      AGENTCOMM_REPO: busRepo,
    });
    expect(viaFlag.stderr).toContain(`via repo pointer ${otherRepo}`);
    expect(viaFlag.stderr).toContain(otherBackend);

    // Config file pointer: the outer project commits `"repo"` and is on the bus.
    const project = await mkTmp();
    await fs.writeFile(path.join(project, '.agentcomm.json'), JSON.stringify({ repo: busRepo }));
    const viaConfig = await run(['register', '--as', 'via-config', '--json'], project);
    expect(viaConfig.code).toBe(0);
    expect(viaConfig.stderr).toContain(`via repo pointer ${busRepo}`);
  });

  it('falls back to the target dir file:// bus when the target has no config or remote', async () => {
    const bare = await mkTmp();
    const outside = await mkTmp();
    const r = await run(['register', '--as', 'bare-ptr', '--json'], outside, { AGENTCOMM_REPO: bare });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`file://${path.join(bare, '.agentcomm')}`);
  });

  it('rejects missing directories and pointer chains; explicit backend wins over the pointer', async () => {
    const outside = await mkTmp();
    const missing = await run(['register', '--as', 'x', '--repo', path.join(outside, 'nope')], outside);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('not a directory');

    // Chain: pointer target itself declares a pointer → hard error.
    const { dir: busRepo } = await mkBusRepo();
    const hop = await mkTmp();
    await fs.writeFile(path.join(hop, '.agentcomm.json'), JSON.stringify({ repo: busRepo }));
    const chained = await run(['register', '--as', 'x', '--repo', hop], outside);
    expect(chained.code).not.toBe(0);
    expect(chained.stderr).toContain('chains are not supported');

    // Explicit backend: pointer must not even be validated (a bogus dir is fine).
    const bus = `file://${path.join(outside, '.explicit-bus')}`;
    const explicit = await run(['register', '--as', 'x', '--repo', path.join(outside, 'nope'), '--backend', bus, '--json'], outside);
    expect(explicit.code).toBe(0);
    expect(explicit.stderr).not.toContain('repo pointer');
  });
});
