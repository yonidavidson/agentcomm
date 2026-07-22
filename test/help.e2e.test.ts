import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end();
  });
}

// The bare `--help` is the ONLY onboarding surface for an agent that meets
// the CLI with no skill, no CLAUDE.md contract, and no harness hooks
// (issues #135/#136). These assertions guard the two things a cold agent
// must be able to learn from it: how to behave on the bus, and how to stay
// current — so a future help rewrite can't silently drop either.
describe('main help', () => {
  it('opens with the agent quickstart, before the command reference', async () => {
    const res = await run(['--help']);
    expect(res.code).toBe(0);
    const help = res.stdout;

    const quickstart = help.indexOf('Agent quickstart');
    expect(quickstart).toBeGreaterThan(-1);
    expect(quickstart).toBeLessThan(help.indexOf('Commands:'));

    // Drift guard: the same flow the init-written CLAUDE.md/AGENTS.md
    // contract teaches — register+declare, drain the inbox, see the roster,
    // re-check before reporting done.
    const block = help.slice(quickstart, help.indexOf('Commands:'));
    expect(block).toContain('agentcomm register --status');
    expect(block).toContain('agentcomm inbox --json');
    expect(block).toContain('agentcomm network');
    expect(block).toMatch(/inbox before reporting/);

    // Pointers to the full contract.
    expect(block).toContain('agentcomm conventions');
    expect(block).toContain('agentcomm describe');
  });

  it('surfaces the self-update story: quickstart hint, version --json contract, Updates blurb', async () => {
    const help = (await run(['--help'])).stdout;

    // Keep-current hint rides the quickstart at the top (#135 cross-linked
    // from the #136 block).
    const block = help.slice(help.indexOf('Agent quickstart'), help.indexOf('Commands:'));
    expect(block).toContain('agentcomm version');
    expect(block).toMatch(/upgrade command/);

    // The machine contract of `version --json` is documented in its entry.
    expect(help).toContain('{version, latest, upToDate,');

    // One-place "how updates work" epilogue.
    expect(help).toContain('Updates:');
    expect(help).toMatch(/No harness auto-upgrades/);
  });
});
