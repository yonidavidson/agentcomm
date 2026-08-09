/**
 * e2e for the sticky session fingerprint (issue #157).
 *
 * The alias suffix decides WHICH mailbox a bare command reads. Deriving it
 * from one fixed ancestor made it drift the moment a wrapper process added a
 * level — the agent silently moved to a different, empty mailbox while mail
 * kept arriving at the old one. These tests run the CLI at DIFFERENT process
 * depths from one "session" (this test process, the shared ancestor) and
 * assert every depth lands on the same alias.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-sticky-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI with NO pinned session, so the sticky path is exercised.
 * `depth` extra `sh -c` wrappers simulate what actually caused the drift:
 * hooks, `timeout`, backgrounding — each one shifting "the grandparent".
 */
function run(args: string[], cwd: string, stateDir: string, depth = 0, extraEnv: Record<string, string> = {}): Promise<Run> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTCOMM_BACKEND: `file://${path.join(cwd, '.bus')}`,
    AGENTCOMM_NO_GIT_PROBE: '1',
    AGENTCOMM_STATE_DIR: stateDir,
    ...extraEnv,
  };
  const argv = [process.execPath, '--import', tsx, cli, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const [cmd, cmdArgs] =
    depth === 0
      ? [process.execPath, ['--import', tsx, cli, ...args]]
      : ['sh', ['-c', 'sh -c '.repeat(depth - 1) + (depth > 1 ? `"${argv}"` : argv)]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

async function repo(): Promise<string> {
  const dir = await mkTmp();
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'sticky@corp.example']);
  return dir;
}

const aliasOf = (r: Run): string => /registered (\S+)/.exec(r.stdout)?.[1] ?? '';

describe('sticky session identity (issue #157)', () => {
  it('resolves the same alias however deep in the process tree the CLI runs', async () => {
    const dir = await repo();
    const state = await mkTmp();

    const shallow = await run(['register'], dir, state, 0);
    expect(shallow.code).toBe(0);
    const alias = aliasOf(shallow);
    expect(alias).toMatch(/^sticky-[0-9a-f]{4}$/);

    // Same session, two extra process levels — the case that used to mint a
    // brand-new (empty) mailbox.
    const deep = await run(['register'], dir, state, 2);
    expect(aliasOf(deep)).toBe(alias);

    // and mail sent to the alias is readable from the deep invocation
    await run(['send', alias, 'ping', '--as', 'someone-else'], dir, state, 0);
    const inbox = await run(['inbox', '--json'], dir, state, 2);
    const msgs = JSON.parse(inbox.stdout) as { body: string }[];
    expect(msgs.map((m) => m.body)).toEqual(['ping']);
  });

  it('an explicitly pinned session still wins and never touches the state dir', async () => {
    const dir = await repo();
    const state = await mkTmp();
    const r = await run(['register'], dir, state, 0, { AGENTCOMM_SESSION: 'pinned-session' });
    expect(r.code).toBe(0);
    expect(await fs.readdir(state)).toEqual([]);
  });

  it('an empty mailbox names the alias it read', async () => {
    const dir = await repo();
    const state = await mkTmp();
    const r = await run(['inbox'], dir, state, 0);
    expect(r.stdout).toMatch(/\(no messages for sticky-[0-9a-f]{4}\)/);
  });

  it('warns when the derived alias changes underneath a session', async () => {
    const dir = await repo();
    const state = await mkTmp();
    const first = await run(['register'], dir, state, 0);
    const alias = aliasOf(first);
    expect(first.stderr).not.toMatch(/NOTE/);

    // the git identity changes mid-session: same session, different alias
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'renamed@corp.example']);
    const second = await run(['inbox'], dir, state, 0);
    expect(second.stderr).toMatch(new RegExp(`previously acted as ${alias}`));
    expect(second.stderr).toMatch(new RegExp(`--as ${alias}`));
  });
});
