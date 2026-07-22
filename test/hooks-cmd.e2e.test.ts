/**
 * e2e for `agentcomm hooks` — generates the harness hook wiring that drives
 * the globally installed CLI (issue #114). OpenCode gets a generated local
 * plugin file; Claude Code / Codex get pointed at their marketplace plugins.
 * Static like `describe`: never connects to a backend.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-hooks-cmd-')));
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

function run(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsx, cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd,
      env: { ...process.env, AGENTCOMM_NO_GIT_PROBE: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const OPENCODE_FILE = '.opencode/plugin/agentcomm.ts';

describe('CLI hooks (harness hook generation)', () => {
  it('--harness opencode writes the local plugin that shells out to the CLI', async () => {
    const dir = await mkTmp();
    const r = await run(['hooks', '--harness', 'opencode', '--json'], dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ harness: 'opencode', file: OPENCODE_FILE, hooks: 'created' });

    const content = await fs.readFile(path.join(dir, OPENCODE_FILE), 'utf8');
    // The hooks drive the global CLI: register at session start, peek on idle.
    expect(content).toContain('agentcomm register');
    expect(content).toContain('agentcomm peek --json');
    expect(content).toContain("event.type !== 'session.idle'");
    expect(content).toContain("from '@opencode-ai/plugin'");
    // Telemetry parity (#115): tool events feed the CLI's rule matcher, and
    // dispose ships the spool. Matching stays CLI-side — the template only
    // normalizes payloads.
    expect(content).toContain('agentcomm hook telemetry');
    expect(content).toContain("'tool.execute.after'");
    for (const tool of ['skill', 'task', 'bash']) expect(content).toContain(`input.tool === '${tool}'`);
    expect(content).toContain('agentcomm emit --flush');
    expect(content).toContain('async dispose()');
  });

  it('never overwrites an existing (possibly user-edited) hooks file', async () => {
    const dir = await mkTmp();
    const target = path.join(dir, OPENCODE_FILE);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, '// my edited hooks\n');

    const r = await run(['hooks', '--harness', 'opencode', '--json'], dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ hooks: 'already-present' });
    expect(await fs.readFile(target, 'utf8')).toBe('// my edited hooks\n');
  });

  it('--harness claude writes project settings hooks that drive the CLI', async () => {
    const dir = await mkTmp();
    const r = await run(['hooks', '--harness', 'claude', '--json'], dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ harness: 'claude', file: '.claude/settings.json', hooks: 'created' });

    const settings = JSON.parse(await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    // The whole lifecycle, every command the global CLI:
    for (const event of ['SessionStart', 'SessionEnd', 'Stop', 'UserPromptSubmit', 'PostToolUse', 'TaskCreated', 'TaskCompleted']) {
      expect(settings.hooks[event], event).toBeDefined();
    }
    expect(JSON.stringify(settings)).toContain('agentcomm hook session-start');
    expect(JSON.stringify(settings)).toContain('agentcomm hook stop-guard');
  });

  it('--harness claude merges into existing settings without clobbering, once', async () => {
    const dir = await mkTmp();
    const file = path.join(dir, '.claude', 'settings.json');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] }, hooks: { Stop: [{ hooks: [] }] } }));

    const r = await run(['hooks', '--harness', 'claude', '--json'], dir);
    expect(JSON.parse(r.stdout)).toMatchObject({ hooks: 'merged' });
    const merged = JSON.parse(await fs.readFile(file, 'utf8')) as {
      permissions: unknown;
      hooks: { Stop: unknown[] };
    };
    expect(merged.permissions).toEqual({ allow: ['Bash(ls:*)'] }); // untouched
    expect(merged.hooks.Stop.length).toBe(2); // theirs + ours

    // Second run: the wiring is present — nothing changes.
    const again = await run(['hooks', '--harness', 'claude', '--json'], dir);
    expect(JSON.parse(again.stdout)).toMatchObject({ hooks: 'already-present' });
  });

  it('--harness codex writes .codex/hooks.json without the Claude-only task events', async () => {
    const dir = await mkTmp();
    const r = await run(['hooks', '--harness', 'codex', '--json'], dir);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ harness: 'codex', file: '.codex/hooks.json', hooks: 'created' });
    const cfg = JSON.parse(await fs.readFile(path.join(dir, '.codex', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, unknown[]>;
    };
    expect(cfg.hooks.SessionStart).toBeDefined();
    expect(cfg.hooks.TaskCreated).toBeUndefined(); // Codex has no task events
  });

  it('fails with a usage error when --harness is missing or unknown', async () => {
    const dir = await mkTmp();
    const missing = await run(['hooks'], dir);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain('--harness');

    const unknown = await run(['hooks', '--harness', 'cursor'], dir);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('cursor');
  });
});
