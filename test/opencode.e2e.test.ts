/**
 * Full end-to-end for the OpenCode plugin: installs nothing, but drives the
 * REAL `opencode` binary with our plugin loaded against a file:// bus and a
 * local mock model, asserting the plugin registered the session on the bus.
 *
 * The plugin is loaded from the PACKAGE ROOT — the same resolution
 * (`package.json` → `exports["./server"]` → dist/opencode-plugin.js) that
 * `"plugin": ["github:yonidavidson/agentcomm"]` uses once OpenCode has cloned
 * the repo. So this covers the github-install path minus the git clone itself.
 *
 * Self-skips unless `opencode` is on PATH AND AGENTCOMM_TEST_OPENCODE is set —
 * so the normal `test` job stays green; CI's `e2e-harness` job installs the
 * binary and sets the flag (mirrors the github/s3/gcs suite convention).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import http from 'node:http';
import { promises as fs, createReadStream } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url)) + '/..';
const cli = path.join(root, 'dist', 'cli.js');
// OpenCode resolves the plugin from the package root via exports["./server"] —
// the same path a `github:yonidavidson/agentcomm` install takes.
const pluginDir = root;

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

describe.skipIf(!RUN)('OpenCode plugin — real `opencode run`', () => {
  beforeAll(() => {
    // ensure dist + the plugin's synced dist are fresh
    execFileSync('npm', ['run', 'plugin:sync'], { cwd: root, stdio: 'ignore' });
  }, 120_000);

  it('registers the session on the bus when driven by the real binary', async () => {
    const mock = await startMock();
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-oc-')));
    const cfgDir = path.join(dir, 'xdg', 'opencode');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '<!-- agentcomm -->\n');
    await fs.writeFile(
      path.join(cfgDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        plugin: [pluginDir],
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
      XDG_CONFIG_HOME: path.join(dir, 'xdg'),
      AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
      AGENTCOMM_NO_GIT_PROBE: '1',
      AGENTCOMM_AGENT: 'ci-oc',
    };
    // seed pending mail for the session's mailbox
    spawnSync(process.execPath, [cli, 'send', 'ci-oc', 'wrap it up', '--as', 'seeder'], { env });

    // drive one real, non-interactive session (mock model → no external calls)
    await new Promise<void>((resolve) => {
      const child = spawn('opencode', ['run', 'hi', '--model', 'openai/gpt-4o-mini'], {
        cwd: dir,
        env,
        stdio: 'ignore',
      });
      const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      child.on('close', () => {
        clearTimeout(killer);
        resolve();
      });
    });

    // the plugin's factory ran register(): ci-oc is on the bus
    const roster = JSON.parse(
      execFileSync(process.execPath, [cli, 'agents', '--json'], { env, encoding: 'utf8' }),
    ) as { name: string }[];
    mock.close();
    await fs.rm(dir, { recursive: true, force: true });
    expect(roster.map((a) => a.name)).toContain('ci-oc');
  }, 60_000);

  // The real shipping path: OpenCode installs the plugin from a remote .tgz URL
  // (a GitHub Release asset) — no git clone. `npm pack` here produces exactly
  // the artifact release.yml attaches; we serve it over http and assert a real
  // `opencode run` installs + registers from the URL.
  it('installs from a tarball URL and registers on the bus', async () => {
    // pack the dist-only tarball (same as `npm pack` / release.yml)
    const packOut = execFileSync('npm', ['pack', '--silent'], { cwd: root, encoding: 'utf8' }).trim().split('\n').pop()!;
    const tgz = path.join(root, packOut);

    const mock = await startMock();
    // a second server just for the tarball asset
    const assetSrv = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/gzip' });
      createReadStream(tgz).pipe(res);
    });
    const assetPort: number = await new Promise((r) =>
      assetSrv.listen(0, '127.0.0.1', () => r((assetSrv.address() as { port: number }).port)),
    );
    const tarballUrl = `http://127.0.0.1:${assetPort}/agentcomm-opencode.tgz`;

    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-tgz-')));
    const cfgDir = path.join(dir, 'xdg', 'opencode');
    await fs.mkdir(cfgDir, { recursive: true });
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '<!-- agentcomm -->\n');
    await fs.writeFile(
      path.join(cfgDir, 'opencode.json'),
      JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        plugin: [tarballUrl],
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
      XDG_CONFIG_HOME: path.join(dir, 'xdg'),
      AGENTCOMM_BACKEND: `file://${path.join(dir, '.bus')}`,
      AGENTCOMM_NO_GIT_PROBE: '1',
      AGENTCOMM_AGENT: 'ci-tgz',
    };

    await new Promise<void>((resolve) => {
      const child = spawn('opencode', ['run', 'hi', '--model', 'openai/gpt-4o-mini'], { cwd: dir, env, stdio: 'ignore' });
      const killer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.on('close', () => {
        clearTimeout(killer);
        resolve();
      });
    });

    const roster = JSON.parse(
      execFileSync(process.execPath, [cli, 'agents', '--json'], { env, encoding: 'utf8' }),
    ) as { name: string }[];
    mock.close();
    assetSrv.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(tgz, { force: true });
    expect(roster.map((a) => a.name)).toContain('ci-tgz');
  }, 90_000);
});
