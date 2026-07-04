/**
 * e2e for `agentcomm log` (channel-wide, non-consuming conversation reader)
 * and `agentcomm conventions` (built-in rules ⊕ .agentcomm.json/.yaml
 * override) — issue #25, all through the real CLI.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
// Some tests spawn the CLI from a temp cwd, where a bare '--import tsx'
// specifier can't resolve — pin tsx by absolute URL instead.
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `agentcomm-logconv-${randomUUID()}`);
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

function run(args: string[], cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: cwd ?? process.cwd(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

interface LoggedMsg {
  from: string;
  to: string;
  body: string;
  thread?: string;
  state: 'pending' | 'archived';
}

describe('CLI log (read a channel conversation)', () => {
  it('shows pending + archived messages across recipients in send order, without consuming, no --as needed', async () => {
    const B = ['--backend', `file://${await mkTmp()}`];
    await run(['send', 'bob', 'first', '--as', 'alice', '--thread', 't1', ...B]);
    await run(['send', 'carol', 'second', '--as', 'alice', ...B]);
    await run(['inbox', '--as', 'bob', ...B, '--json']); // 'first' → archived
    await run(['send', 'bob', 'third', '--as', 'carol', '--thread', 't1', ...B]);

    const r = await run(['log', ...B, '--json']);
    expect(r.code).toBe(0);
    const msgs = JSON.parse(r.stdout) as LoggedMsg[];
    expect(msgs.map((m) => m.body)).toEqual(['first', 'second', 'third']);
    expect(msgs.map((m) => m.state)).toEqual(['archived', 'pending', 'pending']);

    // Non-consuming: pending mail is still deliverable afterwards.
    const inbox = await run(['inbox', '--as', 'carol', ...B, '--json']);
    expect((JSON.parse(inbox.stdout) as { body: string }[]).map((m) => m.body)).toEqual(['second']);
  }, 30000);

  it('--thread filters and --limit keeps the most recent N in chronological order', async () => {
    const B = ['--backend', `file://${await mkTmp()}`];
    for (let i = 1; i <= 5; i++) {
      await run(['send', 'bob', `t-msg ${i}`, '--as', 'alice', '--thread', 'topic-1', ...B]);
      await run(['send', 'bob', `other ${i}`, '--as', 'alice', ...B]);
    }

    const threaded = JSON.parse((await run(['log', '--thread', 'topic-1', ...B, '--json'])).stdout) as LoggedMsg[];
    expect(threaded.map((m) => m.body)).toEqual(['t-msg 1', 't-msg 2', 't-msg 3', 't-msg 4', 't-msg 5']);

    const limited = JSON.parse((await run(['log', '--limit', '3', ...B, '--json'])).stdout) as LoggedMsg[];
    expect(limited.map((m) => m.body)).toEqual(['other 4', 't-msg 5', 'other 5']);
  }, 30000); // ~12 sequential CLI spawns — generous for a loaded CI runner

  it('empty channel logs cleanly, exit 0', async () => {
    const r = await run(['log', '--backend', `file://${await mkTmp()}`]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no messages/);
  });

  it('human output marks pending vs archived and threads', async () => {
    const B = ['--backend', `file://${await mkTmp()}`];
    await run(['send', 'bob', 'hello there', '--as', 'alice', '--subject', 'task', '--thread', 'x-1', ...B]);
    const r = await run(['log', ...B]);
    expect(r.stdout).toMatch(/● .*alice → bob \[task\] \(thread x-1\)/);
    expect(r.stdout).toContain('  hello there');
  });
});

describe('CLI conventions (defaults ⊕ override file)', () => {
  it('prints built-in defaults when no config file exists (run from an isolated dir)', async () => {
    const dir = await mkTmp();
    const r = await run(['conventions', '--json'], dir);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { source: string | null; conventions: { lobby: string; subjects: string[] } };
    expect(out.source).toBeNull();
    expect(out.conventions.lobby).toBe('lobby');
    expect(out.conventions.subjects).toContain('ack');
  });

  it('.agentcomm.json overrides defaults per-field and is found upward from cwd', async () => {
    const root = await mkTmp();
    const nested = path.join(root, 'a', 'b');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(
      path.join(root, '.agentcomm.json'),
      JSON.stringify({ backend: 'github://acme/webapp', conventions: { lobby: 'commons', subjects: ['plan', 'done'] } }),
    );

    const r = await run(['conventions', '--json'], nested);
    const out = JSON.parse(r.stdout) as {
      source: string;
      backend: string;
      conventions: { lobby: string; topicStyle: string; subjects: string[] };
    };
    // macOS tmpdir is a symlink (/var → /private/var) — compare realpaths.
    expect(await fs.realpath(out.source)).toBe(await fs.realpath(path.join(root, '.agentcomm.json')));
    expect(out.backend).toBe('github://acme/webapp');
    expect(out.conventions.lobby).toBe('commons');
    expect(out.conventions.subjects).toEqual(['plan', 'done']);
    expect(out.conventions.topicStyle).toBe('kebab-case'); // untouched fields keep defaults
  });

  it('.agentcomm.yaml works via the optional yaml driver', async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, '.agentcomm.yaml'), 'conventions:\n  lobby: town-square\n');
    const r = await run(['conventions', '--json'], dir);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { conventions: { lobby: string } }).conventions.lobby).toBe('town-square');
  });

  it('a malformed JSON config fails with a pointed error', async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, '.agentcomm.json'), '{ not json');
    const r = await run(['conventions'], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid JSON in .*\.agentcomm\.json/);
  });
});
