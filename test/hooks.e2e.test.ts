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


function rosterJson(dir: string): { name: string; status?: string }[] {
  return JSON.parse(
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
  ) as { name: string; status?: string }[];
}

async function derivedAlias(dir: string): Promise<string> {
  return rosterJson(dir)
    .map((a) => a.name)
    .find((n) => n.startsWith('hooky-'))!;
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

  it('the digest heartbeats: a backdated registration gets a fresh lastSeen at prompt time', async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir);

    const agentsDir = path.join(dir, '.bus', 'agents');
    const recFile = (await fs.readdir(agentsDir)).find((f) => f.startsWith('hooky-'))!;
    const rec = JSON.parse(await fs.readFile(path.join(agentsDir, recFile), 'utf8')) as {
      lastSeen: string;
    };
    const old = new Date(Date.now() - 3600_000).toISOString();
    await fs.writeFile(path.join(agentsDir, recFile), JSON.stringify({ ...rec, lastSeen: old }));

    await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    const after = JSON.parse(await fs.readFile(path.join(agentsDir, recFile), 'utf8')) as {
      lastSeen: string;
    };
    expect(Date.parse(after.lastSeen)).toBeGreaterThan(Date.parse(old)); // heartbeat bumped it

    // the stop guard, by contrast, is read-only now: backdate again, run it, unchanged
    await fs.writeFile(path.join(agentsDir, recFile), JSON.stringify({ ...rec, lastSeen: old }));
    await runHook('stop-inbox-guard.mjs', { cwd: dir }, dir);
    const untouched = JSON.parse(await fs.readFile(path.join(agentsDir, recFile), 'utf8')) as {
      lastSeen: string;
    };
    expect(untouched.lastSeen).toBe(old);
  });

  it('prompt digest: news-only, throttled, silent when quiet', async () => {
    const dir = await markedRepo();
    cliSync(['register', '--status', 'quiet work'], dir); // status declared → no nudge; quiet means quiet
    cliSync(['register'], dir, 'sender');

    // quiet bus (roster snapshot primes on first run) → silence
    const first = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    expect(first.stdout).toBe('');

    // clear the digest throttle, add news: pending mail + a new rider
    for (const f of await fs.readdir(dir)) {
      if (f.startsWith('agentcomm-digest-') && !f.includes('roster')) await fs.rm(path.join(dir, f));
    }
    const me = await derivedAlias(dir);
    cliSync(['send', me, 'digest me'], dir, 'sender');
    cliSync(['register'], dir, 'newcomer');

    const news = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    const out = JSON.parse(news.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(out.hookSpecificOutput.additionalContext).toContain('1 unread message(s)');
    expect(out.hookSpecificOutput.additionalContext).toContain('new on the bus: newcomer');

    // immediately again (throttled) → silence even though news persists
    const throttled = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    expect(throttled.stdout).toBe('');
  });

  it('statuses: written with --status, preserved by heartbeats, surfaced in the digest', async () => {
    const dir = await markedRepo();
    cliSync(['register', '--status', 'building the auth module'], dir);
    cliSync(['register'], dir, 'sender');

    cliSync(['register'], dir); // heartbeat: no --status must NOT erase it
    const me = await derivedAlias(dir);
    const roster = rosterJson(dir);
    expect(roster.find((a) => a.name === me)!.status).toBe('building the auth module');

    cliSync(['send', me, 'news'], dir, 'sender');
    const news = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    const out = JSON.parse(news.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toContain('building the auth module');
  });

  it('an ask-status becomes a call to action in others\' digests (and stops when cleared)', async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir);
    cliSync(['register', '--status', 'blocked: need the auth schema', '--as', 'worker-1'], dir);

    const news = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    const out = JSON.parse(news.stdout) as { hookSpecificOutput: { additionalContext: string } };
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('call to action — worker-1 is asking: "blocked: need the auth schema"');
    expect(ctx).toContain('agentcomm send worker-1');
    expect(ctx).not.toContain('working — worker-1'); // an ask is a CTA, not a fact line

    // unblocked: plain status again → next digest (throttle cleared) has no CTA and is silent
    cliSync(['register', '--status', 'building auth', '--as', 'worker-1'], dir);
    for (const f of await fs.readdir(dir)) {
      if (f.startsWith('agentcomm-digest-') && !f.includes('roster')) await fs.rm(path.join(dir, f));
    }
    const quiet = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    expect(quiet.stdout).toBe('');
  });

  it('session-start surfaces active asks as calls to action', async () => {
    const dir = await markedRepo();
    // the asker must be ANOTHER session — own asks are not self-recruiting
    execFileSync(
      process.execPath,
      [path.join(root, 'dist', 'cli.js'), 'register', '--status', 'need: someone to review PR 7', '--as', 'reviewer-seeker'],
      {
        cwd: dir,
        stdio: 'ignore',
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
          AGENTCOMM_NO_GIT_PROBE: '1',
          AGENTCOMM_SESSION: 'someone-elses-session',
        },
      },
    );

    const r = await runHook('session-start.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, dir);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toContain(
      'call to action — reviewer-seeker is asking: "need: someone to review PR 7"',
    );
  });

  it('mid-turn digest: surfaces unread + asks during long turns, throttled, quiet otherwise', async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir);
    cliSync(['register', '--status', 'blocked: need prod credentials', '--as', 'stuck-worker'], dir);

    const me = await derivedAlias(dir);
    cliSync(['send', me, 'mid-task news'], dir, 'stuck-worker');

    const first = await runHook('midturn-digest.mjs', { cwd: dir, tool_name: 'Bash' }, dir);
    const out = JSON.parse(first.stdout) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('1 unread message(s)');
    expect(out.hookSpecificOutput.additionalContext).toContain('stuck-worker is asking');
    expect(out.hookSpecificOutput.additionalContext).toContain('do not derail');

    // immediately again → throttled silence (this is the every-tool-call path)
    const throttled = await runHook('midturn-digest.mjs', { cwd: dir, tool_name: 'Read' }, dir);
    expect(throttled.stdout).toBe('');

    // clear throttle + quiet bus → silence
    cliSync(['inbox', '--json'], dir);
    cliSync(['register', '--status', 'working again', '--as', 'stuck-worker'], dir);
    for (const f of await fs.readdir(dir)) {
      if (f.startsWith('agentcomm-midturn-')) await fs.rm(path.join(dir, f));
    }
    const quiet = await runHook('midturn-digest.mjs', { cwd: dir, tool_name: 'Bash' }, dir);
    expect(quiet.stdout).toBe('');
  });

  it('mid-turn fast path: a fresh stamp short-circuits in shell — node never spawns', async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir);
    cliSync(['send', (await derivedAlias(dir)), 'pending news', '--as', 'sender'], dir);

    const hooksJson = JSON.parse(await fs.readFile(path.join(root, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: { PostToolUse: { hooks: { command: string }[] }[] };
    };
    const guardCmd = hooksJson.hooks.PostToolUse[0].hooks[0].command;

    // fresh stamp, exactly as the node script writes it
    const key = dir.replace(/[^A-Za-z0-9]/g, '_');
    await fs.writeFile(path.join(dir, `agentcomm-midturn-${key}`), '');

    const started = Date.now();
    const r = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const child = spawn('sh', ['-c', guardCmd.replace(/^sh -c '/, '').replace(/'$/, '')], {
        stdio: ['pipe', 'pipe', 'ignore'],
        cwd: dir,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
          AGENTCOMM_NO_GIT_PROBE: '1',
          AGENTCOMM_SESSION: 'hook-session',
          TMPDIR: dir,
          CLAUDE_PROJECT_DIR: dir,
          CLAUDE_PLUGIN_ROOT: root,
        },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
      child.stdin.end(JSON.stringify({ cwd: dir }));
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(''); // news exists, but the guard never reached node
    expect(Date.now() - started).toBeLessThan(500); // shell path, not node startup + bus reads
  });

  it("digest carries a bus-activity feed: other agents traffic since last digest", async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir);
    cliSync(['register'], dir, 'planner');
    cliSync(['register'], dir, 'worker-1');

    // prime: first digest sets the high-water mark silently (send self mail so it fires)
    const me = await derivedAlias(dir);
    cliSync(['send', me, 'wake up', '--as', 'planner'], dir);
    await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    cliSync(['inbox', '--json'], dir); // consume own mail

    // traffic BETWEEN OTHERS after the mark
    cliSync(['send', 'worker-1', 'auth module is done, tests green', '--as', 'planner', '--subject', 'done'], dir);
    for (const f of await fs.readdir(dir)) {
      if (f.startsWith('agentcomm-digest-') && !f.includes('acts') && !f.includes('roster'))
        await fs.rm(path.join(dir, f));
    }
    const news = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    const out = JSON.parse(news.stdout) as { hookSpecificOutput: { additionalContext: string } };
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('bus activity since last digest');
    expect(ctx).toContain('planner → worker-1 [done]: "auth module is done, tests green"');
  });

  it('digest nudges an agent that carries no status (once per 30min)', async () => {
    const dir = await markedRepo();
    cliSync(['register'], dir); // no --status

    const first = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    const out = JSON.parse(first.stdout) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext).toContain('You carry no bus status');

    // declared → clear throttles → no nudge, and (quiet bus) full silence
    cliSync(['register', '--status', 'building the feed'], dir);
    for (const f of await fs.readdir(dir)) {
      if (f.startsWith('agentcomm-digest-') && !f.includes('roster') && !f.includes('acts'))
        await fs.rm(path.join(dir, f));
      if (f.startsWith('agentcomm-nudge-')) await fs.rm(path.join(dir, f));
    }
    const second = await runHook('prompt-digest.mjs', { cwd: dir }, dir);
    expect(second.stdout).toBe('');
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
