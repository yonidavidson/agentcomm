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
      { on: 'agent', match: 'code-review-*' },
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

// The hook events now live in the CLI (`agentcomm hook <event>`).
const HOOK_EVENTS: Record<string, string> = {
  'session-start.mjs': 'session-start',
  'telemetry-capture.mjs': 'telemetry',
  'task-status.mjs': 'task-status',
};

function runHook(script: string, stdinJson: object, cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'dist', 'cli.js'), 'hook', HOOK_EVENTS[script]!], {
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

  it('a tracked subagent spawn (Task/Agent tool) is recorded; untracked and typeless ones are not', async () => {
    const dir = await trackedRepo();
    // the same subagent skill is unreachable via the Skill tool when it sets
    // disable-model-invocation — the Task/Agent spawn is the only signal
    // distinct tool_use ids: two separate spawns, as the harness reports them
    await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Task', tool_use_id: 't-1', tool_input: { subagent_type: 'code-review-nuclear' } },
      dir,
    );
    await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 't-2', tool_input: { subagent_type: 'code-review-nuclear' } },
      dir,
    );
    await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose' } },
      dir,
    );
    await runHook(
      'telemetry-capture.mjs',
      { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { prompt: 'no subagent_type at all' } },
      dir,
    );
    cliJson(['register', '--as', 'rider'], dir);
    const events = cliJson<Ev[]>(['events'], dir);
    expect(events).toHaveLength(2); // both tool spellings fire; untracked/typeless do not
    for (const e of events)
      expect(e).toMatchObject({
        type: 'agent-ran',
        name: 'code-review-nuclear',
        ref: 'feat-x',
        attrs: { ref_source: 'cwd' },
      });
  });

  it('agent-ran resolves its ref from a worktree path in the prompt, not the session cwd', async () => {
    const dir = await trackedRepo(); // session cwd: a checkout on feat-x
    const wt = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-telwt-')));
    tmpRoots.push(wt);
    execFileSync('git', ['-C', wt, 'init', '-q']);
    execFileSync('git', ['-C', wt, 'symbolic-ref', 'HEAD', 'refs/heads/review-branch-1']);
    await fs.mkdir(path.join(wt, 'src'), { recursive: true });
    await fs.writeFile(path.join(wt, 'src', 'foo.ts'), 'export {};\n');

    await runHook(
      'telemetry-capture.mjs',
      {
        cwd: dir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Task',
        tool_use_id: 't-wt',
        tool_input: {
          subagent_type: 'code-review-nuclear',
          prompt: `Review the changes in ${wt}/src/foo.ts and report findings.`,
        },
      },
      dir,
    );
    cliJson(['register', '--as', 'rider'], dir);
    const events = cliJson<Ev[]>(['events'], dir);
    expect(events).toHaveLength(1);
    // reverting the worktree-aware resolution turns this red: cwd gives feat-x
    expect(events[0]).toMatchObject({
      type: 'agent-ran',
      ref: 'review-branch-1',
      attrs: { ref_source: 'prompt-path' },
    });
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

  it('git plumbing and merge-unwinding commands are NOT recorded as merges', async () => {
    const dir = await trackedRepo();
    for (const command of [
      'git merge-base --fork-point origin/main HEAD',
      'git merge-tree A B',
      'git merge-file ours base theirs',
      'git merge --abort',
      'gh pr view 123 --json state,mergeCommit,mergedAt',
    ]) {
      await runHook(
        'telemetry-capture.mjs',
        { cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command } },
        dir,
      );
    }
    cliJson(['register', '--as', 'rider'], dir);
    expect(cliJson<Ev[]>(['events'], dir)).toEqual([]);
  });

  it('merged events carry the source branch or PR number, and a clearly-failed call is skipped', async () => {
    const dir = await trackedRepo();
    await runHook(
      'telemetry-capture.mjs',
      {
        cwd: dir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 't-m1',
        tool_input: { command: 'git merge --no-ff -m "landing" feat-y' },
        tool_response: { stdout: 'Merge made by the ort strategy.' }, // unknown-good shape → emits
      },
      dir,
    );
    await runHook(
      'telemetry-capture.mjs',
      {
        cwd: dir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 't-m2',
        tool_input: { command: 'gh pr merge 123 --squash' },
      },
      dir,
    );
    await runHook(
      'telemetry-capture.mjs',
      {
        cwd: dir,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_use_id: 't-m3',
        tool_input: { command: 'git merge feat-z' },
        tool_response: { is_error: true }, // explicit failure → no event
      },
      dir,
    );
    cliJson(['register', '--as', 'rider'], dir);
    const events = cliJson<Ev[]>(['events'], dir);
    expect(events).toHaveLength(2);
    expect(events[0]!.attrs).toMatchObject({ source: 'feat-y' });
    expect(events[1]!.attrs).toMatchObject({ pr: '123' });
  });

  it('the same tool call double-hooked (two settings scopes) records ONE event; distinct calls record two', async () => {
    const dir = await trackedRepo();
    const payload = {
      cwd: dir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 't-dup',
      tool_input: { command: 'git merge feat-x' },
    };
    await runHook('telemetry-capture.mjs', payload, dir); // scope 1
    await runHook('telemetry-capture.mjs', payload, dir); // scope 2, same tool call
    cliJson(['register', '--as', 'rider'], dir);
    expect(cliJson<Ev[]>(['events'], dir)).toHaveLength(1);

    // a genuinely distinct call moments later still counts
    await runHook('telemetry-capture.mjs', { ...payload, tool_use_id: 't-dup2' }, dir);
    cliJson(['register', '--as', 'rider2'], dir);
    expect(cliJson<Ev[]>(['events'], dir)).toHaveLength(2);
  });

  it('double-hooked twins split across two flushes still read as ONE event', async () => {
    const dir = await trackedRepo();
    const payload = {
      cwd: dir,
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 't-x',
      tool_input: { command: 'git merge feat-x' },
    };
    await runHook('telemetry-capture.mjs', payload, dir);
    cliJson(['register', '--as', 'rider'], dir); // twin 1 ships in batch 1
    await runHook('telemetry-capture.mjs', payload, dir);
    cliJson(['register', '--as', 'rider2'], dir); // twin 2 ships in batch 2
    expect(cliJson<Ev[]>(['events'], dir)).toHaveLength(1); // read-time dedup spans batches
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
    expect(ctx).toContain('if a script already reported it, do not emit a duplicate');
  });
});
