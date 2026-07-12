/**
 * The harness lifecycle core (src/harness.ts) — the in-process bus behaviors
 * that back the OpenCode and Pi plugins. Fast, always-on regression coverage
 * that doesn't need a harness binary; the real-binary drive is in
 * test/opencode.e2e.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  openBusSession,
  onTheBus,
  sessionStartContext,
  inboxGuardReason,
  midTurnContext,
} from '../src/harness.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(root, '..', 'dist', 'cli.js');

const tmps: string[] = [];
async function markedRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-harness-')));
  tmps.push(dir);
  await fs.writeFile(path.join(dir, 'AGENTS.md'), '<!-- agentcomm -->\n');
  return dir;
}
function busEnv(dir: string) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
    AGENTCOMM_NO_GIT_PROBE: '1',
  } as NodeJS.ProcessEnv;
}
/** Seed the bus via the real CLI (as another agent). */
function seed(dir: string, args: string[]) {
  execFileSync(process.execPath, [cli, ...args], { cwd: dir, env: busEnv(dir), stdio: 'ignore' });
}
/** Run a harness call with the session env applied (mirrors what a plugin's process sees). */
async function withEnv<T>(dir: string, alias: string, fn: () => Promise<T>): Promise<T> {
  const prev = { ...process.env };
  Object.assign(process.env, busEnv(dir), { AGENTCOMM_AGENT: alias });
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, prev);
  }
}

afterEach(async () => {
  for (const d of tmps.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

describe('harness lifecycle core', () => {
  it('onTheBus honors the AGENTS.md marker and AGENTCOMM_BACKEND', async () => {
    const dir = await markedRepo();
    expect(await onTheBus(dir)).toBe(true);
    const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-bare-')));
    tmps.push(bare);
    const prev = process.env.AGENTCOMM_BACKEND;
    delete process.env.AGENTCOMM_BACKEND;
    try {
      expect(await onTheBus(bare)).toBe(false);
    } finally {
      if (prev) process.env.AGENTCOMM_BACKEND = prev;
    }
  });

  it('session start registers on the bus and briefs roster + waiting mail + asks', async () => {
    const dir = await markedRepo();
    seed(dir, ['register', '--as', 'planner', '--status', 'blocked: need the schema']);
    seed(dir, ['send', 'oc-agent', 'take the auth task', '--as', 'planner', '--subject', 'task']);

    const ctx = await withEnv(dir, 'oc-agent', async () => {
      const s = await openBusSession(dir);
      expect(s).not.toBeNull();
      const c = await sessionStartContext(s!);
      await s!.close();
      return c;
    });
    expect(ctx).toContain('registered as oc-agent');
    expect(ctx).toContain('1 message(s) already waiting');
    expect(ctx).toContain('call to action — planner is asking: "blocked: need the schema"');

    // the register was real: the roster now lists oc-agent
    const roster = execFileSync(process.execPath, [cli, 'agents', '--json'], {
      cwd: dir,
      env: busEnv(dir),
      encoding: 'utf8',
    });
    expect((JSON.parse(roster) as { name: string }[]).map((a) => a.name)).toContain('oc-agent');
  });

  it('inbox guard returns a reason only when unread mail exists', async () => {
    const dir = await markedRepo();
    await withEnv(dir, 'oc-agent', async () => {
      const s = (await openBusSession(dir))!;
      await sessionStartContext(s); // register
      expect(await inboxGuardReason(s)).toBeNull(); // clean
      seed(dir, ['send', 'oc-agent', 'wrap it up', '--as', 'boss']);
      const reason = await inboxGuardReason(s);
      expect(reason).toContain('1 unread bus message(s) for oc-agent');
      expect(reason).toContain('from: boss');
      await s.close();
    });
  });

  it('mid-turn surfaces unread mail and active asks, else stays silent', async () => {
    const dir = await markedRepo();
    seed(dir, ['register', '--as', 'worker', '--status', 'need: a reviewer']);
    const [quiet, loud] = await withEnv(dir, 'oc-agent', async () => {
      const s = (await openBusSession(dir))!;
      const q = await midTurnContext(s); // asks present → not silent (worker is asking)
      seed(dir, ['send', 'oc-agent', 'ping', '--as', 'worker']);
      const l = await midTurnContext(s);
      await s.close();
      return [q, l];
    });
    expect(quiet).toContain('worker is asking');
    expect(loud).toContain('unread message(s) for oc-agent');
  });
});
