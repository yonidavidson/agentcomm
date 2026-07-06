/**
 * e2e for the plugin hooks (issue #54): session-start bus notice and the
 * stop-time inbox guard. Hooks are spawned exactly as Claude Code does —
 * stdin JSON in, stdout JSON out — against a marked temp repo on file://.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-hooks-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
});

async function markedRepo(): Promise<string> {
  const dir = await mkTmp();
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'hooky@corp.example']);
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), '<!-- agentcomm -->\n## Agent coordination (agentcomm)\n');
  return dir;
}

function runHook(
  script: string,
  stdinJson: object,
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'hooks', script)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENTCOMM_BACKEND: `file://${path.join(cwd, '.bus')}`,
        AGENTCOMM_NO_GIT_PROBE: '1',
        AGENTCOMM_SESSION: 'hook-session',
        TMPDIR: cwd, // isolate the stop-guard throttle stamp per test
      },
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(JSON.stringify(stdinJson));
  });
}

function cliSync(args: string[], cwd: string, as?: string): void {
  execFileSync(
    process.execPath,
    [path.join(root, 'dist', 'cli.js'), ...args, ...(as ? ['--as', as] : [])],
    {
      cwd,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENTCOMM_BACKEND: `file://${path.join(cwd, '.bus')}`,
        AGENTCOMM_NO_GIT_PROBE: '1',
        AGENTCOMM_SESSION: 'hook-session',
      },
    },
  );
}

describe('plugin hooks: bus discipline made mechanical', () => {
  it('session-start REGISTERS the session onto the roster and announces it', async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir, 'reviewer');

    const r = await runHook('session-start.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, dir);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('on a message bus');
    expect(ctx).toMatch(/registered as hooky-[0-9a-f]{4}/);
    expect(ctx).toContain('reviewer');

    // the register was real: the derived alias is on the roster now
    const roster = execFileSync(
      process.execPath,
      [path.join(root, 'dist', 'cli.js'), 'agents', '--json'],
      {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
          AGENTCOMM_NO_GIT_PROBE: '1',
          AGENTCOMM_SESSION: 'hook-session',
        },
      },
    ).toString();
    expect(roster).toMatch(/hooky-[0-9a-f]{4}/);
  });

  it('session-start stays silent outside opted-in repos', async () => {
    const dir = await mkTmp(); // no marker
    const r = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'hooks', 'session-start.mjs')], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: process.env.HOME }, // no AGENTCOMM_BACKEND either
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
      child.stdin.end(JSON.stringify({ cwd: dir }));
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('stop guard blocks when the derived mailbox has pending mail, and passes it clean', async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir); // derived alias, session-aligned via AGENTCOMM_SESSION
    cliSync(['register'], dir, 'sender');

    // clean mailbox → no block
    const clean = await runHook('stop-inbox-guard.mjs', { cwd: dir }, dir);
    expect(clean.code).toBe(0);
    expect(clean.stdout).toBe('');

    // note: within the 45s throttle a pending message would be missed — each
    // test uses its own TMPDIR, but inside one test we must clear the stamp
    for (const f of await fs.readdir(dir)) {
      if (f.startsWith('agentcomm-stopguard-')) await fs.rm(path.join(dir, f));
    }

    const hooky = 'hooky-'; // derived name prefix; find the real one from the roster
    const roster = JSON.parse(
      execFileSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'agents', '--json'], {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
          AGENTCOMM_NO_GIT_PROBE: '1',
          AGENTCOMM_SESSION: 'hook-session',
        },
      }).toString(),
    ) as { name: string }[];
    const me = roster.map((a) => a.name).find((n) => n.startsWith(hooky))!;
    cliSync(['send', me, 'wrap it up'], dir, 'sender');

    const blocked = await runHook('stop-inbox-guard.mjs', { cwd: dir }, dir);
    expect(blocked.code).toBe(0);
    const out = JSON.parse(blocked.stdout) as { decision: string; reason: string };
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('unread bus message');
    expect(out.reason).toContain('from: sender');
  });

  it('stop guard honors stop_hook_active (no loops) and throttles repeat checks', async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir);
    cliSync(['register'], dir, 'sender');

    const looped = await runHook('stop-inbox-guard.mjs', { cwd: dir, stop_hook_active: true }, dir);
    expect(looped.stdout).toBe('');

    // first real check writes the stamp…
    await runHook('stop-inbox-guard.mjs', { cwd: dir }, dir);
    // …so even with mail now pending, the throttled re-check stays silent
    const roster = JSON.parse(
      execFileSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'agents', '--json'], {
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
          AGENTCOMM_NO_GIT_PROBE: '1',
          AGENTCOMM_SESSION: 'hook-session',
        },
      }).toString(),
    ) as { name: string }[];
    const me = roster.map((a) => a.name).find((n) => n.startsWith('hooky-'))!;
    cliSync(['send', me, 'you have mail'], dir, 'sender');
    const throttled = await runHook('stop-inbox-guard.mjs', { cwd: dir }, dir);
    expect(throttled.stdout).toBe('');
  });
});
