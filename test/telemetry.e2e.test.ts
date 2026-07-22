/**
 * e2e for the telemetry event lane (issue #100) through the real CLI.
 *
 * The contract under test:
 *  - opt-in: without a `telemetry` section in the config, `emit` is an
 *    announced no-op — nothing is ever collected;
 *  - capture is local: `emit` only spools, the bus sees nothing yet;
 *  - piggyback: the spool ships as ONE events/ batch blob on the next bus
 *    write the CLI makes anyway (register/send/broadcast);
 *  - `events` reads it back with filters;
 *  - retention is opt-in: purge ages events only via --events or the
 *    config's telemetry.retention, and never touches registrations.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');

const tmpRoots: string[] = [];
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface Ctx {
  dir: string;
  run: (args: string[], extraEnv?: Record<string, string>) => Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * Isolated world per test: its own bus, its own TMPDIR (so event spools
 * never leak across tests), and optionally a telemetry-enabled config file
 * wired via AGENTCOMM_CONFIG.
 */
async function mkCtx(telemetry?: object): Promise<Ctx> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `agentcomm-telemetry-${randomUUID().slice(0, 8)}-`)));
  tmpRoots.push(dir);
  const env: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: dir, // the spool lives in tmpdir — keep it inside this test's world
    AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
    AGENTCOMM_NO_GIT_PROBE: '1',
    AGENTCOMM_SESSION: 'telemetry-e2e',
  };
  if (telemetry !== undefined) {
    const cfg = path.join(dir, 'config.json');
    await fs.writeFile(cfg, JSON.stringify({ telemetry }));
    env.AGENTCOMM_CONFIG = cfg;
  }
  const run = (args: string[], extraEnv: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ...extraEnv }, // cwd stays the repo root so tsx resolves; the bus URI is absolute
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
  return { dir, run };
}

const eventBlobs = async (dir: string): Promise<string[]> => {
  try {
    return (await fs.readdir(path.join(dir, '.bus', 'events'))).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
};

describe('telemetry events (issue #100)', () => {
  it('emit without a telemetry config section is an announced no-op', async () => {
    const { dir, run } = await mkCtx(); // no config at all
    const r = await run(['emit', '--type', 'skill-ran', '--name', 'x', '--as', 'alice', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ spooled: false, reason: 'telemetry-not-enabled' });

    await run(['register', '--as', 'alice']); // a write happens — still nothing to ship
    expect(await eventBlobs(dir)).toEqual([]);
  });

  it('emit spools locally; the batch rides the next bus write; events reads it back', async () => {
    const { dir, run } = await mkCtx({ track: [{ on: 'skill', match: 'review', record: 'found bugs?' }] });

    const e1 = await run([
      'emit', '--type', 'skill-ran', '--name', 'review', '--ref', 'feat/x', '--as', 'alice', '--json',
    ]);
    expect(e1.code).toBe(0);
    expect(JSON.parse(e1.stdout)).toMatchObject({ spooled: true, flushed: 0 });
    const e2 = await run([
      'emit', '--type', 'skill-outcome', '--name', 'review', '--ref', 'feat/x',
      '--attrs', '{"found_bugs":true,"findings":3}', '--as', 'alice', '--json',
    ]);
    expect(e2.code).toBe(0);
    expect(await eventBlobs(dir)).toEqual([]); // capture is local — the bus saw NOTHING

    const reg = await run(['register', '--as', 'alice', '--json']);
    expect(reg.code).toBe(0);
    expect(reg.stderr).toMatch(/shipped 2 spooled telemetry event/);
    expect(await eventBlobs(dir)).toHaveLength(1); // one flush = ONE batch blob

    const q = await run(['events', '--json', '--as', 'alice']);
    const events = JSON.parse(q.stdout) as {
      type: string; name?: string; ref?: string; agent: string; session?: string; ts: string;
      attrs?: Record<string, unknown>;
    }[];
    expect(events.map((e) => e.type)).toEqual(['skill-ran', 'skill-outcome']);
    expect(events[1]).toMatchObject({
      name: 'review',
      ref: 'feat/x',
      agent: 'alice',
      attrs: { found_bugs: true, findings: 3 },
    });
    expect(events[0]!.session).toBeTruthy(); // the join key to agents/
    expect(Date.parse(events[0]!.ts)).toBeGreaterThan(0);

    // filters
    const byType = await run(['events', '--type', 'skill-outcome', '--json', '--as', 'alice']);
    expect((JSON.parse(byType.stdout) as unknown[]).length).toBe(1);
    const byRef = await run(['events', '--ref', 'other-branch', '--json', '--as', 'alice']);
    expect(JSON.parse(byRef.stdout)).toEqual([]);
  });

  it('emit --flush ships immediately without waiting for a ride', async () => {
    const { dir, run } = await mkCtx({ track: [{ on: 'session' }] });
    const r = await run(['emit', '--type', 'session-start', '--flush', '--as', 'bob', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ spooled: true, flushed: 1 });
    expect(await eventBlobs(dir)).toHaveLength(1);
  });

  it('bare emit --flush ships the spool without recording a new event', async () => {
    const { dir, run } = await mkCtx({ track: [{ on: 'skill' }] });
    await run(['emit', '--type', 'skill-ran', '--name', 's', '--as', 'bob', '--json']);
    expect(await eventBlobs(dir)).toHaveLength(0); // spooled only, nothing shipped yet

    const r = await run(['emit', '--flush', '--as', 'bob', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ spooled: false, flushed: 1 });
    expect(await eventBlobs(dir)).toHaveLength(1);

    // an empty spool flushes to nothing, still exit 0
    const again = await run(['emit', '--flush', '--as', 'bob', '--json']);
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ spooled: false, flushed: 0 });
  });

  it('emit validates its inputs', async () => {
    const { run } = await mkCtx({ track: [] });
    const noType = await run(['emit', '--name', 'x', '--as', 'alice']);
    expect(noType.code).toBe(1);
    expect(noType.stderr).toMatch(/--type/);
    const badJson = await run(['emit', '--type', 't', '--attrs', '{nope', '--as', 'alice']);
    expect(badJson.code).toBe(1);
    expect(badJson.stderr).toMatch(/invalid --attrs/);
    const notObject = await run(['emit', '--type', 't', '--attrs', '[1,2]', '--as', 'alice']);
    expect(notObject.code).toBe(1);
    expect(notObject.stderr).toMatch(/JSON object/);
  });

  it('purge: events keep forever by default; --events ages them; registrations always survive', async () => {
    const { dir, run } = await mkCtx({ track: [{ on: 'skill' }] });
    await run(['register', '--as', 'alice']);
    await run(['emit', '--type', 'skill-ran', '--flush', '--as', 'alice', '--json']);
    expect(await eventBlobs(dir)).toHaveLength(1);

    // an archive-only purge leaves events alone and reports what it kept
    const keepAll = await run(['purge', '--older-than', '0s', '--json', '--as', 'alice']);
    expect(keepAll.code).toBe(0);
    expect(JSON.parse(keepAll.stdout).kept).toMatchObject({ eventBatches: 1 });
    expect(await eventBlobs(dir)).toHaveLength(1);

    // explicit opt-in retention ages them out; the registration survives
    const aged = await run(['purge', '--events', '0s', '--json', '--as', 'alice']);
    expect(aged.code).toBe(0);
    expect(JSON.parse(aged.stdout)).toMatchObject({ eventCount: 1 });
    expect(await eventBlobs(dir)).toEqual([]);
    const roster = await run(['agents', '--json', '--as', 'alice']);
    expect((JSON.parse(roster.stdout) as { name: string }[]).map((a) => a.name)).toContain('alice');
  });

  it('telemetry.retention from the config applies when purge runs', async () => {
    const { dir, run } = await mkCtx({ track: [{ on: 'skill' }], retention: '0s' });
    await run(['emit', '--type', 'skill-ran', '--flush', '--as', 'alice', '--json']);
    expect(await eventBlobs(dir)).toHaveLength(1);

    const r = await run(['purge', '--older-than', '30d', '--json', '--as', 'alice']);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/telemetry\.retention/);
    expect(await eventBlobs(dir)).toEqual([]);
  });
});
