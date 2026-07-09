/**
 * The plugin ships bin/agentcomm so Claude Code (which adds each plugin's
 * bin/ to PATH) lets agents run bare `agentcomm ...` — exactly what the
 * init-written CLAUDE.md tells them to do. This proves the wrapper resolves
 * the prebuilt CLI and runs from an unrelated cwd.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const shim = path.join(root, 'bin', 'agentcomm');

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
});

describe('bin/agentcomm launcher', () => {
  it('is executable and runs the CLI from an unrelated working directory', async () => {
    const st = await fs.stat(shim);
    expect(st.mode & 0o111).toBeTruthy(); // has an exec bit

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-shim-'));
    try {
      const r = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        const child = spawn(shim, ['register', '--as', 'shimtest', '--json'], {
          cwd: dir,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
            AGENTCOMM_NO_GIT_PROBE: '1',
          },
        });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
      });
      expect(r.code).toBe(0);
      expect((JSON.parse(r.stdout) as { name: string }).name).toBe('shimtest');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
