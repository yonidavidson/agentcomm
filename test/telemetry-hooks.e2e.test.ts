/**
 * e2e for the deterministic telemetry capture layer (issue #100): harness
 * hooks route lifecycle moments to telemetry-capture.mjs, which records an
 * event iff the repo's .agentcomm config tracks it — spawned exactly as the
 * harness does (stdin JSON in), against a marked temp repo on file://.
 * Also covers the semantic layer: session-start injects the config's
 * `record:` instructions so the model knows what to self-report.
 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
});

const tmpRoots: string[] = [];
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const TELEMETRY = {
  telemetry: {
    track: [
      { on: 'skill', match: 'thermo-*', record: 'whether it uncovered bugs and the findings count' },
      { on: 'merge' },
      { on: 'session' },
    ],
  },
};

/** Marked repo on a branch, opted into telemetry via .agentcomm.json. */
async function trackedRepo(config: object | null = TELEMETRY): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-telhooks-')));
  tmpRoots.push(dir);
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'hooky@corp.example']);
  execFileSync('git', ['-C', dir, 'symbolic-ref', 'HEAD', 'refs/heads/feat-x']); // a branch name without commits
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), '<!-- agentcomm -->\n');
  if (config) await fs.writeFile(path.join(dir, '.agentcomm.json'), JSON.stringify(config));
  return dir;
}

function hookEnv(cwd: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTCOMM_BACKEND: `file://${path.join(cwd, '.bus')}`,
    AGENTCOMM_NO_GIT_PROBE: '1',
    AGENTCOMM_SESSION: 'telhook-session',
    TMPDIR: cwd, // the event spool lives in tmpdir — isolate it per test
  };
}

function runHook(script: string, stdinJson: object, cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'hooks', script)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd,
      env: hookEnv(cwd),
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
    child.stdin.end(JSON.stringify(stdinJson));
  });
}

function cliJson<T>(args: string[], cwd: string): T {
  return JSON.parse(
    execFileSync(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args, '--json'], {
      cwd,
      env: hookEnv(cwd),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString(),
  ) as T;
}

interface Ev {
  type: string;
  name?: string;
  ref?: string;
  agent: string;
  attrs?: Record<string, unknown>;
}

describe('telemetry capture hooks (issue #100)', () => {
  it('a tracked Skill run is recorded (glob match), spooled, and rides the next write', async () => {
    const dir = await trackedRepo();
    const r = await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'thermo-nuclear-code-review' } },
      dir,
    );
    expect(r.code).toBe(0);

    // capture is local — nothing on the bus until a write gives it a ride
    expect(cliJson<Ev[]>(['events'], dir)).toEqual([]);
    cliJson(['register', '--as', 'rider'], dir);

    const events = cliJson<Ev[]>(['events'], dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'skill-ran', name: 'thermo-nuclear-code-review', ref: 'feat-x' });
  });

  it('an untracked skill is NOT recorded', async () => {
    const dir = await trackedRepo();
    await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'unrelated-skill' } },
      dir,
    );
    cliJson(['register', '--as', 'rider'], dir);
    expect(cliJson<Ev[]>(['events'], dir)).toEqual([]);
  });

  it('a merge command through Bash is recorded when tracked', async () => {
    const dir = await trackedRepo();
    await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'git checkout main && git merge feat-x' } },
      dir,
    );
    // a plain command is not mistaken for a merge
    await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'echo git mergetool docs' } },
      dir,
    );
    cliJson(['register', '--as', 'rider'], dir);
    const events = cliJson<Ev[]>(['events'], dir);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'merged', ref: 'feat-x' });
    expect(String(events[0]!.attrs?.command)).toContain('git merge feat-x');
  });

  it('session start spools; session end flushes without waiting for a ride', async () => {
    const dir = await trackedRepo();
    await runHook('telemetry-capture.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, dir);
    expect(cliJson<Ev[]>(['events'], dir)).toEqual([]); // spooled only

    await runHook('telemetry-capture.mjs', { cwd: dir, hook_event_name: 'SessionEnd' }, dir);
    const events = cliJson<Ev[]>(['events'], dir);
    expect(events.map((e) => e.type)).toEqual(['session-start', 'session-end']);
  });

  it('without a telemetry config section the capture hook is inert', async () => {
    const dir = await trackedRepo(null);
    const r = await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'thermo-nuclear-code-review' } },
      dir,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    cliJson(['register', '--as', 'rider'], dir);
    expect(cliJson<Ev[]>(['events'], dir)).toEqual([]);
  });

  it('session-start briefing injects the record: instructions (semantic layer)', async () => {
    const dir = await trackedRepo();
    const r = await runHook('session-start.mjs', { cwd: dir, hook_event_name: 'SessionStart' }, dir);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('YOU self-report');
    expect(ctx).toContain('after skill "thermo-*": record whether it uncovered bugs');
    expect(ctx).toContain('agentcomm emit --type skill-outcome --name thermo-*');
  });
});
