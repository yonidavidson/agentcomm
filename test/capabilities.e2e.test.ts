/**
 * Capability demonstrations — each test is a complete, readable multi-agent
 * coordination scenario run end-to-end through the real CLI (spawned
 * processes, nothing in-process). Where test/cli.e2e.test.ts covers flags and
 * exit codes, this file covers *workflows*: it is the executable version of
 * the conventions documented in skills/agentcomm/SKILL.md — read it as a
 * cookbook.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');

async function mkTmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `agentcomm-cap-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

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

interface Msg {
  id: string;
  from: string;
  to: string;
  body: string;
  subject?: string;
  thread?: string;
}

describe('capability demos (CLI, end-to-end)', () => {
  it('task handoff: send with subject/thread → wait → ack → done, all correlated by thread', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const B = ['--backend', db];

    // Both agents register; planner verifies its counterpart is really there
    // before handing off (messages to unknown names raise no error).
    await run(['register', '--as', 'planner', ...B]);
    await run(['register', '--as', 'worker', ...B]);
    const agents = await run(['agents', ...B, '--json']);
    expect((JSON.parse(agents.stdout) as { name: string }[]).map((a) => a.name)).toContain('worker');

    await run(['send', 'worker', 'build the auth module', '--as', 'planner', '--subject', 'task', '--thread', 'auth-1', ...B]);

    // Worker blocks for work — exit 0 means a message arrived. NOTE: wait
    // observes without consuming; the task stays pending until `inbox`.
    const w = await run(['wait', '--as', 'worker', '--timeout', '5000', ...B, '--json']);
    expect(w.code).toBe(0);
    const [task] = JSON.parse(w.stdout) as Msg[];
    expect(task!.subject).toBe('task');
    expect(task!.thread).toBe('auth-1');

    // Ack on the SAME thread so the planner can match it to its request...
    await run(['send', 'planner', 'ack: starting auth module', '--as', 'worker', '--subject', 'ack', '--thread', task!.thread!, ...B]);

    // ... the worker "works", then drains its inbox before reporting done.
    // This consumes the task it saw via wait (wait never consumes) plus any
    // correction that arrived meanwhile.
    const drained = await run(['inbox', '--as', 'worker', ...B, '--json']);
    const drainedMsgs = JSON.parse(drained.stdout) as Msg[];
    expect(drainedMsgs.map((m) => m.subject)).toEqual(['task']);
    await run(['send', 'planner', 'done: auth module built', '--as', 'worker', '--subject', 'done', '--thread', task!.thread!, ...B]);

    // Planner sees ack then done, in order, all on thread auth-1.
    const report = await run(['inbox', '--as', 'planner', ...B, '--json']);
    const msgs = JSON.parse(report.stdout) as Msg[];
    expect(msgs.map((m) => m.subject)).toEqual(['ack', 'done']);
    expect(msgs.every((m) => m.thread === 'auth-1')).toBe(true);
  });

  it('broadcast standup: one announcement reaches every registered agent exactly once, never the sender', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const B = ['--backend', db];

    for (const name of ['lead', 'dev-1', 'dev-2']) {
      await run(['register', '--as', name, ...B]);
    }
    await run(['broadcast', 'standup in 5', '--as', 'lead', '--subject', 'status', ...B]);

    for (const name of ['dev-1', 'dev-2']) {
      const inbox = await run(['inbox', '--as', name, ...B, '--json']);
      const msgs = JSON.parse(inbox.stdout) as Msg[];
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.from).toBe('lead');
      expect(msgs[0]!.body).toBe('standup in 5');
    }
    const own = await run(['inbox', '--as', 'lead', ...B, '--json']);
    expect(JSON.parse(own.stdout)).toEqual([]);
  });

  it(
    'worker pool: N workers claim from one shared queue and report back — every task done exactly once',
    async () => {
      const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
      const B = ['--backend', db];
      const N_TASKS = 12;
      const N_WORKERS = 3;

      for (let i = 0; i < N_TASKS; i++) {
        await run(['send', 'build-queue', `task-${i}`, '--as', 'producer', '--subject', 'task', ...B]);
      }

      // Each worker is a loop of real CLI processes: claim --json until the
      // queue reports null, reporting each completed task back to the producer.
      async function workerLoop(owner: string): Promise<number> {
        let count = 0;
        for (;;) {
          const r = await run(['claim', '--queue', 'build-queue', '--as', owner, ...B, '--json']);
          expect(r.code).toBe(0);
          const msg = JSON.parse(r.stdout) as Msg | null;
          if (msg === null) return count;
          await run(['send', 'producer', `done: ${msg.body}`, '--as', owner, '--subject', 'done', ...B]);
          count++;
        }
      }
      const counts = await Promise.all(
        Array.from({ length: N_WORKERS }, (_, i) => workerLoop(`worker-${i}`)),
      );
      expect(counts.reduce((a, b) => a + b, 0)).toBe(N_TASKS);

      // Exactly one completion report per task — nothing dropped, nothing doubled.
      const reports = await run(['inbox', '--as', 'producer', ...B, '--json']);
      const bodies = (JSON.parse(reports.stdout) as Msg[]).map((m) => m.body).sort();
      expect(bodies).toEqual(
        Array.from({ length: N_TASKS }, (_, i) => `done: task-${i}`).sort(),
      );

      const empty = await run(['claim', '--queue', 'build-queue', '--as', 'late-worker', ...B, '--json']);
      expect(JSON.parse(empty.stdout)).toBeNull();
    },
    60000,
  );

  it('peek then decide: triage by subject without consuming, then consume — audit trail lands under read/', async () => {
    const root = await mkTmp();
    const B = ['--backend', `file://${root}`];

    await run(['send', 'triager', 'the build is red', '--as', 'ci-bot', '--subject', 'urgent', ...B]);
    await run(['send', 'triager', 'weekly digest', '--as', 'news-bot', '--subject', 'fyi', ...B]);

    // peek is non-destructive: same two messages visible twice in a row.
    for (let i = 0; i < 2; i++) {
      const p = await run(['peek', '--as', 'triager', ...B, '--json']);
      const subjects = (JSON.parse(p.stdout) as Msg[]).map((m) => m.subject);
      expect(subjects).toEqual(['urgent', 'fyi']);
    }

    // Having triaged from subjects alone, consume for real.
    const inbox = await run(['inbox', '--as', 'triager', ...B, '--json']);
    expect(JSON.parse(inbox.stdout)).toHaveLength(2);
    expect(await run(['peek', '--as', 'triager', ...B, '--json']).then((r) => JSON.parse(r.stdout))).toEqual([]);

    // Consumed ≠ deleted: both messages are archived under read/<recipient>/.
    const archived = await fs.readdir(path.join(root, 'read', 'triager'));
    expect(archived).toHaveLength(2);
  });

  it('timeout and recovery: wait times out (exit 2), agent re-waits instead of stalling, late reply arrives (exit 0)', async () => {
    const db = `sqlite://${path.join(await mkTmp(), 'bus.db')}`;
    const B = ['--backend', db];

    // Round 1: counterpart is silent — exit 2 is information, not an error.
    const first = await run(['wait', '--as', 'worker', '--timeout', '300', ...B]);
    expect(first.code).toBe(2);

    // The worker chooses to re-wait (bounded); the planner replies late.
    const second = run(['wait', '--as', 'worker', '--timeout', '5000', ...B, '--json']);
    await new Promise((r) => setTimeout(r, 300));
    await run(['send', 'worker', 'sorry, here is the answer', '--as', 'planner', '--thread', 'q-1', ...B]);

    const w = await second;
    expect(w.code).toBe(0);
    const msgs = JSON.parse(w.stdout) as Msg[];
    expect(msgs.map((m) => m.body)).toEqual(['sorry, here is the answer']);
  });
});
