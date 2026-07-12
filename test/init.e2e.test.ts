/**
 * e2e for `agentcomm init` — one-command team activation: writes the agent
 * instructions for one selected harness, registers the caller, and reports the roster.
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
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-init-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function run(args: string[], cwd: string, bus: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env, AGENTCOMM_BACKEND: bus, AGENTCOMM_NO_GIT_PROBE: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe('CLI init (one-command team activation)', () => {
  it('defaults to Claude Code guidance, registers, and reports the roster', async () => {
    const dir = await mkTmp();
    const bus = `file://${path.join(dir, '.bus')}`;

    const r = await run(['init', '--as', 'alice', '--json'], dir, bus);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout) as { registered: string; agents: string[]; harness: string; guidanceFile: string; guidance: string };
    expect(out).toMatchObject({
      registered: 'alice',
      agents: ['alice'],
      harness: 'claude',
      guidanceFile: 'CLAUDE.md',
      guidance: 'created',
      claudeMd: 'created',
      agentsMd: 'not-selected',
    });

    const md = await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).toContain('<!-- agentcomm -->');
    expect(md).toContain('check your inbox before reporting work done');
    await expect(fs.stat(path.join(dir, 'AGENTS.md'))).rejects.toThrow();

    const agents = await run(['agents', '--json'], dir, bus);
    expect((JSON.parse(agents.stdout) as { name: string }[]).map((a) => a.name)).toEqual(['alice']);
  });

  it('is idempotent — a rerun never duplicates the section', async () => {
    const dir = await mkTmp();
    const bus = `file://${path.join(dir, '.bus')}`;
    await run(['init', '--as', 'alice'], dir, bus);
    const r2 = await run(['init', '--as', 'alice', '--json'], dir, bus);
    expect(JSON.parse(r2.stdout)).toMatchObject({ harness: 'claude', guidance: 'already-present' });

    const md = await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(md.split('<!-- agentcomm -->')).toHaveLength(2); // exactly one marker
  });

  it('writes only AGENTS.md when Codex is selected', async () => {
    const dir = await mkTmp();
    const bus = `file://${path.join(dir, '.bus')}`;

    const r = await run(['init', '--harness', 'codex', '--as', 'alice', '--json'], dir, bus);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      harness: 'codex',
      guidanceFile: 'AGENTS.md',
      guidance: 'created',
      claudeMd: 'not-selected',
      agentsMd: 'created',
    });
    expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('<!-- agentcomm -->');
    await expect(fs.stat(path.join(dir, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('writes AGENTS.md for OpenCode (its own harness, no "as Codex" detour)', async () => {
    const dir = await mkTmp();
    const bus = `file://${path.join(dir, '.bus')}`;

    const r = await run(['init', '--harness', 'opencode', '--as', 'alice', '--json'], dir, bus);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      harness: 'opencode',
      guidanceFile: 'AGENTS.md',
      guidance: 'created',
      claudeMd: 'not-selected',
      agentsMd: 'created',
    });
    expect(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8')).toContain('<!-- agentcomm -->');
    await expect(fs.stat(path.join(dir, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('rejects an unsupported harness', async () => {
    const dir = await mkTmp();
    const bus = `file://${path.join(dir, '.bus')}`;
    const r = await run(['init', '--harness', 'gemini'], dir, bus);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('--harness must be one of');
  });

  it('appends to an existing CLAUDE.md without touching its content', async () => {
    const dir = await mkTmp();
    const bus = `file://${path.join(dir, '.bus')}`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# My project\n\nHouse rules here.\n');

    const r = await run(['init', '--as', 'bob', '--json'], dir, bus);
    expect((JSON.parse(r.stdout) as { guidance: string }).guidance).toBe('appended');
    const md = await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
    expect(md.startsWith('# My project')).toBe(true);
    expect(md).toContain('House rules here.');
    expect(md).toContain('<!-- agentcomm -->');
  });

  it(`derives an identity when --as is omitted (git identity, then OS username)`, async () => {
    const dir = await mkTmp();
    const bus = `file://${path.join(dir, '.bus')}`;
    const r = await run(['init', '--json'], dir, bus);
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout) as { registered: string }).registered).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});
