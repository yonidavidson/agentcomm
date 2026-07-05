/**
 * e2e for identity resolution (issue #38): the acting name is an ALIAS.
 * Explicit --as > AGENTCOMM_AGENT > git identity (user.email local-part,
 * sanitized) > OS username — announced on stderr when derived.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-id-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function repoWithEmail(email: string): Promise<string> {
  const dir = await mkTmp();
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', email]);
  return dir;
}

function run(
  args: string[],
  cwd: string,
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child_env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTCOMM_BACKEND: `file://${path.join(cwd, '.bus')}`,
    AGENTCOMM_NO_GIT_PROBE: '1',
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete child_env[k];
    else child_env[k] = v;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: child_env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('identity: the acting name is an alias with an honest default', () => {
  it('derives the alias from git user.email local-part, with a stderr notice', async () => {
    const dir = await repoWithEmail('yoni.davidson@corp.example');
    const r = await run(['register'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('registered yoni.davidson');
    expect(r.stderr).toMatch(/acting as yoni\.davidson \(from git config user\.email; --as overrides\)/);
  });

  it('--as beats everything; AGENTCOMM_AGENT beats the git identity — both silently', async () => {
    const dir = await repoWithEmail('yoni.davidson@corp.example');

    const flag = await run(['register', '--as', 'explicit-name'], dir, { AGENTCOMM_AGENT: 'env-name' });
    expect(flag.stdout).toContain('registered explicit-name');
    expect(flag.stderr).not.toMatch(/acting as/);

    const env = await run(['register'], dir, { AGENTCOMM_AGENT: 'env-name' });
    expect(env.stdout).toContain('registered env-name');
    expect(env.stderr).not.toMatch(/acting as/);
  });

  it('sanitizes hostile emails to the name charset', async () => {
    const dir = await repoWithEmail('we!rd $name+x@corp.example');
    const r = await run(['register'], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('registered werdnamex');
  });

  it('outside a git repo, falls back to the OS username', async () => {
    const dir = await mkTmp(); // not a git repo
    const r = await run(['register'], dir, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' });
    expect(r.code).toBe(0);
    const expected = os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, '');
    expect(r.stdout).toContain(`registered ${expected}`);
    expect(r.stderr).toMatch(/acting as .*OS username/);
  });
});
