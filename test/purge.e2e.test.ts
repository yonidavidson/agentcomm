/**
 * e2e for `agentcomm purge` (issues #22, #100) — housekeeping through the
 * real CLI. Purge touches read/ (the archive) and, opt-in only, events/
 * (telemetry). Pending inbox mail always survives, and registrations are
 * NEVER purged: presence is heartbeat-derived, and telemetry events
 * reference registrations by agent/session.
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
async function mkTmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `agentcomm-purge-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Registered agent + one archived (consumed) and one pending message. */
async function seedStore(): Promise<{ root: string; B: string[] }> {
  const root = await mkTmp();
  const B = ['--backend', `file://${root}`];
  await run(['register', '--as', 'alice', ...B]);
  await run(['send', 'bob', 'old news', '--as', 'alice', ...B]);
  await run(['inbox', '--as', 'bob', ...B, '--json']); // consume → archives under read/
  await run(['send', 'bob', 'still pending', '--as', 'alice', ...B]);
  return { root, B };
}

describe('CLI purge (archive housekeeping)', () => {
  it('purge --older-than 0s removes archives; pending mail and registrations survive', async () => {
    const { root, B } = await seedStore();

    const r = await run(['purge', '--older-than', '0s', ...B, '--json']);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { purged: boolean; count: number; keys: string[] };
    expect(out.purged).toBe(true);
    expect(out.count).toBe(1);
    expect(out.keys[0]).toMatch(/^read\/bob\//);

    await expect(fs.readdir(path.join(root, 'read', 'bob'))).resolves.toEqual([]);
    const inbox = await run(['inbox', '--as', 'bob', ...B, '--json']);
    expect((JSON.parse(inbox.stdout) as { body: string }[]).map((m) => m.body)).toEqual(['still pending']);
    const agents = await run(['agents', ...B, '--json']);
    expect((JSON.parse(agents.stdout) as { name: string }[]).map((a) => a.name)).toEqual(['alice']);
  });

  it('fresh archives outlive --older-than 1d', async () => {
    const { B } = await seedStore();
    const r = await run(['purge', '--older-than', '1d', ...B, '--json']);
    expect(JSON.parse(r.stdout).count).toBe(0);
  });

  it('--dry-run lists victims without deleting anything', async () => {
    const { root, B } = await seedStore();
    const r = await run(['purge', '--older-than', '0s', '--dry-run', ...B, '--json']);
    const out = JSON.parse(r.stdout) as { purged: boolean; dryRun: boolean; count: number };
    expect(out).toMatchObject({ purged: false, dryRun: true, count: 1 });
    await expect(fs.readdir(path.join(root, 'read', 'bob'))).resolves.toHaveLength(1);
  });

  it('requires a well-formed --older-than', async () => {
    const { B } = await seedStore();
    const missing = await run(['purge', ...B]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/--older-than/);
    const bad = await run(['purge', '--older-than', 'fortnight', ...B]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/invalid --older-than/);
  });
});

describe('purge never touches registrations (issue #100)', () => {
  it('--agents-older-than is refused with an explanation', async () => {
    const { B } = await seedStore();
    const r = await run(['purge', '--agents-older-than', '7d', ...B]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/registrations are never purged/i);
    // and nothing was deleted
    const agents = await run(['agents', ...B, '--json']);
    expect((JSON.parse(agents.stdout) as { name: string }[]).map((a) => a.name)).toEqual(['alice']);
  });

  it('reports kept registrations and event batches for visibility', async () => {
    const { B } = await seedStore();
    const r = await run(['purge', '--older-than', '0s', ...B, '--json']);
    const out = JSON.parse(r.stdout) as { kept: { eventBatches: number; registrations: number } };
    expect(out.kept).toEqual({ eventBatches: 0, registrations: 1 });
  });
});
