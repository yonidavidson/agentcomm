/**
 * Full end-to-end for the OpenCode integration: drives the REAL `opencode`
 * binary against a file:// bus and a local mock model, with the shipping
 * wiring — the generated hooks file (`agentcomm hooks --harness opencode` →
 * `.opencode/plugin/agentcomm.ts`) shelling out to the `agentcomm` CLI on
 * PATH (what `npm install -g <release .tgz>` provides; here the repo's own
 * bin/ shim over dist/).
 *
 * The in-process plugin was retired: the CLI + generated hooks ARE the
 * OpenCode story, so that is what gets regression coverage.
 *
 * Self-skips unless `opencode` is on PATH AND AGENTCOMM_TEST_OPENCODE is set —
 * so the normal `test` job stays green; CI's `e2e-harness` job installs the
 * binary and sets the flag (mirrors the github/s3/gcs suite convention).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const cli = path.join(root, 'dist', 'cli.js');
// The global-install stand-in: bin/agentcomm resolves dist/cli.js relative to
// itself, exactly like the `bin` entry of an `npm install -g` layout.
const binDir = path.join(root, 'bin');

const opencodePresent = spawnSync('opencode', ['--version'], { stdio: 'ignore' }).status === 0;
const RUN = opencodePresent && !!process.env.AGENTCOMM_TEST_OPENCODE;

/** Minimal OpenAI-compatible mock: streams a canned completion; counts hits. */
function startMock(): Promise<{ port: number; hits: () => number; close: () => void }> {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    if (req.url?.includes('/chat/completions')) {
      hits++;
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o-mini', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: 'ok' }, null));
        res.write(chunk({}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
      });
    } else if (req.url?.includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini', object: 'model', owned_by: 'openai' }] }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
  });
  return new Promise((resolve) =>
    srv.listen(0, '127.0.0.1', () =>
      resolve({ port: (srv.address() as { port: number }).port, hits: () => hits, close: () => srv.close() }),
    ),
  );
}

describe.skipIf(!RUN)('OpenCode generated hooks — real `opencode run`', () => {
  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore' });
  }, 120_000);

  it('the hooks file written by `agentcomm hooks` registers the session via the CLI on PATH', async () => {
    const mock = await startMock();
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-oc-hooks-')));
    const cfgDir = path.join(dir, 'xdg', 'opencode');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '<!-- agentcomm -->\n');
    // No plugin entry — the project-local generated hooks are the wiring.
    await fs.writeFile(
      path.join(cfgDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        provider: {
          openai: {
            options: { baseURL: `http://127.0.0.1:${mock.port}/v1`, apiKey: 'sk-mock' },
            models: { 'gpt-4o-mini': { name: 'mock' } },
          },
        },
      }),
    );

    const env = {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      XDG_CONFIG_HOME: path.join(dir, 'xdg'),
      AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
      AGENTCOMM_NO_GIT_PROBE: '1',
      AGENTCOMM_AGENT: 'ci-hooks',
    };

    // Generate the hooks exactly the way a user (or auto-provisioning) does.
    execFileSync(process.execPath, [cli, 'hooks', '--harness', 'opencode'], { cwd: dir, env });
    await fs.access(path.join(dir, '.opencode', 'plugin', 'agentcomm.ts'));

    // Drive one real, non-interactive session (mock model → no external calls).
    await new Promise<void>((resolve) => {
      const child = spawn('opencode', ['run', 'hi', '--model', 'openai/gpt-4o-mini'], {
        cwd: dir,
        env,
        stdio: 'ignore',
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('close', () => {
        clearTimeout(killer);
        resolve();
      });
    });

    // The generated hook ran `agentcomm register`: ci-hooks is on the bus.
    const roster = JSON.parse(
      execFileSync(process.execPath, [cli, 'agents', '--json'], { env, encoding: 'utf8' }),
    ) as { name: string }[];
    mock.close();
    await fs.rm(dir, { recursive: true, force: true });
    expect(roster.map((a) => a.name)).toContain('ci-hooks');
  }, 90_000);
});
