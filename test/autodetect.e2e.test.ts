/**
 * e2e for the repo-bus auto-default (issue #27): inside a git repo with a
 * github origin (+ token), the default backend is github://owner/repo — the
 * agents are on the network just by running. Explicit choices always win.
 * `describe` is the probe: it reports the resolved URI without connecting.
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
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-auto-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** A minimal env: token by default, never AGENTCOMM_BACKEND. */
function busEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTCOMM_GITHUB_TOKEN: 'dummy-token-for-detection',
  };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function gitRepo(originUrl: string): Promise<string> {
  const dir = await mkTmp();
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', originUrl]);
  return dir;
}

async function describedUri(cwd: string, env: NodeJS.ProcessEnv): Promise<{ uri: string; stderr: string }> {
  const r = await run(['describe', '--json'], cwd, env);
  expect(r.code).toBe(0);
  return { uri: (JSON.parse(r.stdout) as { uri: string }).uri, stderr: r.stderr };
}

describe('repo-bus auto-default (backend resolution chain)', () => {
  it('a git repo with a github origin auto-selects github://owner/repo, with a stderr notice', async () => {
    for (const origin of ['git@github.com:acme/webapp.git', 'https://github.com/acme/webapp']) {
      const dir = await gitRepo(origin);
      const { uri, stderr } = await describedUri(dir, busEnv());
      expect(uri).toBe('github://acme/webapp');
      expect(stderr).toMatch(/auto-detected from the git remote.*override/);
    }
  });

  it('AGENTCOMM_BACKEND wins over the git repo, silently', async () => {
    const dir = await gitRepo('git@github.com:acme/webapp.git');
    const { uri, stderr } = await describedUri(dir, busEnv({ AGENTCOMM_BACKEND: 'file:///tmp/elsewhere' }));
    expect(uri).toBe('file:///tmp/elsewhere');
    expect(stderr).toBe('');
  });

  it('a .agentcomm.json backend wins over the git remote', async () => {
    const dir = await gitRepo('git@github.com:acme/webapp.git');
    await fs.writeFile(path.join(dir, '.agentcomm.json'), JSON.stringify({ backend: 'sqlite:///tmp/pinned.db' }));
    const { uri, stderr } = await describedUri(dir, busEnv());
    expect(uri).toBe('sqlite:///tmp/pinned.db');
    expect(stderr).toMatch(/project default from the \.agentcomm config file/);
  });

  it('outside a git repo, and with a non-github origin, the classic file:// default stands', async () => {
    const plain = await mkTmp();
    expect((await describedUri(plain, busEnv())).uri).toBe('file://./.agentcomm');

    const gitlab = await gitRepo('git@gitlab.com:acme/webapp.git');
    expect((await describedUri(gitlab, busEnv())).uri).toBe('file://./.agentcomm');
  });

  it('without any resolvable token, the github origin is NOT auto-selected', async () => {
    const dir = await gitRepo('git@github.com:acme/webapp.git');
    const empty = await mkTmp();
    const env = busEnv({
      AGENTCOMM_GITHUB_TOKEN: undefined,
      GITHUB_TOKEN: undefined,
      GH_TOKEN: undefined,
      // Point gh at an empty config so `gh auth token` cannot succeed either.
      GH_CONFIG_DIR: empty,
      HOME: empty,
      XDG_CONFIG_HOME: empty,
    });
    expect((await describedUri(dir, env)).uri).toBe('file://./.agentcomm');
  });
});
