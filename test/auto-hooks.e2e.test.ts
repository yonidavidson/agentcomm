/**
 * e2e for connect-time hook provisioning (issue #122) — a bus command run in
 * an opted-in repo that uses OpenCode but lacks the agentcomm hooks writes
 * .opencode/plugin/agentcomm.ts (same file as `hooks --harness opencode`),
 * notifies on stderr, then connects. Every missing signal is a no-op.
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

const HOOKS_FILE = '.opencode/plugin/agentcomm.ts';

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-auto-hooks-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function run(
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: {
        ...process.env,
        AGENTCOMM_BACKEND: `file://${path.join(cwd, '.bus')}`, // explicit backend = consent
        AGENTCOMM_NO_GIT_PROBE: '1',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** An opted-in OpenCode project: .opencode/ dir present, no hooks yet. */
async function mkOpencodeRepo(): Promise<string> {
  const dir = await mkTmp();
  await fs.mkdir(path.join(dir, '.opencode'));
  return dir;
}

describe('auto-provisioned hooks on connect', () => {
  it('register in a hook-less OpenCode repo writes the hooks, notifies, and still connects', async () => {
    const dir = await mkOpencodeRepo();
    const r = await run(['register', '--as', 'alice', '--json'], dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ name: 'alice' }); // stdout stays pure JSON
    expect(r.stderr).toContain(`wrote ${HOOKS_FILE}`);
    const content = await fs.readFile(path.join(dir, HOOKS_FILE), 'utf8');
    expect(content).toContain('agentcomm register'); // same template as `hooks --harness opencode`
  });

  it('is silent and writes nothing once wired — generated file or opencode.json plugin entry', async () => {
    // Already generated: second run is a no-op.
    const dir = await mkOpencodeRepo();
    await run(['register', '--as', 'alice'], dir);
    const before = await fs.readFile(path.join(dir, HOOKS_FILE), 'utf8');
    const again = await run(['register', '--as', 'alice'], dir);
    expect(again.stderr).not.toContain('hooks were missing');
    expect(await fs.readFile(path.join(dir, HOOKS_FILE), 'utf8')).toBe(before);

    // In-process plugin in opencode.json counts as wired — no shell-out hooks on top.
    const viaPlugin = await mkOpencodeRepo();
    await fs.writeFile(
      path.join(viaPlugin, 'opencode.json'),
      JSON.stringify({ plugin: ['https://github.com/yonidavidson/agentcomm/releases/download/v0.17.3/agentcomm-opencode-0.17.3.tgz'] }),
    );
    const r = await run(['register', '--as', 'bob'], viaPlugin);
    expect(r.code).toBe(0);
    await expect(fs.access(path.join(viaPlugin, HOOKS_FILE))).rejects.toThrow();
  });

  it('does nothing without the harness signal or with the opt-out set', async () => {
    // No .opencode/ dir → not an OpenCode project → no files invented.
    const plain = await mkTmp();
    const r1 = await run(['register', '--as', 'carol'], plain);
    expect(r1.code).toBe(0);
    await expect(fs.access(path.join(plain, '.opencode'))).rejects.toThrow();

    // Opt-out wins even when every other signal fires.
    const optOut = await mkOpencodeRepo();
    const r2 = await run(['register', '--as', 'dave'], optOut, { AGENTCOMM_NO_AUTO_HOOKS: '1' });
    expect(r2.code).toBe(0);
    await expect(fs.access(path.join(optOut, HOOKS_FILE))).rejects.toThrow();
  });

  it('requires repo consent: no marker, no config, no explicit backend → no write', async () => {
    const dir = await mkOpencodeRepo();
    const bus = `file://${path.join(dir, '.bus')}`;
    // Backend passed as a FLAG (explicit transport choice) but env consent absent:
    // the flag path skips auto-detection consent signals entirely... still counts
    // as explicit. Instead simulate the no-consent case: no env, no flag, so the
    // CLI falls back to file://./.agentcomm in an un-opted-in dir.
    const child = await new Promise<{ code: number; stderr: string }>((resolve, reject) => {
      const p = spawn(process.execPath, ['--import', tsx, cli, 'register', '--as', 'eve', '--backend', bus], {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: dir,
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'AGENTCOMM_BACKEND')), AGENTCOMM_NO_GIT_PROBE: '1' },
      });
      let stderr = '';
      p.stderr.on('data', (d) => (stderr += d.toString()));
      p.on('error', reject);
      p.on('exit', (code) => resolve({ code: code ?? -1, stderr }));
    });
    expect(child.code).toBe(0);
    // --backend flag alone is not the repo opting in (no marker, no config, no env).
    await expect(fs.access(path.join(dir, HOOKS_FILE))).rejects.toThrow();
  });
});
