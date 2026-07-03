/**
 * e2e for `agentcomm describe` — the self-describing-backend command
 * (issue #7). describe is static by contract: it must work with no driver
 * loaded, no credentials, and no connection, because its job is answering
 * "how would I connect?" before the caller can connect.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { BackendInfo } from '../src/backends/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: env ?? process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

interface DescribeOut {
  uri: string;
  scheme: string;
  info: BackendInfo | null;
  security: string;
}

async function describeJson(backend: string, env?: NodeJS.ProcessEnv): Promise<DescribeOut> {
  const r = await run(['describe', '--backend', backend, '--json'], env);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as DescribeOut;
}

describe('CLI describe (static backend self-description)', () => {
  it('sqlite: channel = the .db file, claim yes, push no', async () => {
    const d = await describeJson('sqlite:///tmp/whatever/bus.db');
    expect(d.scheme).toBe('sqlite');
    expect(d.info!.capabilities).toEqual({ claim: true, push: false });
    expect(d.info!.channel.template).toContain('<channel>.db');
  });

  it('s3: works with no credentials and no SDK loaded; channel = key prefix; no claim', async () => {
    const d = await describeJson('s3://acme-bus/team-a');
    expect(d.scheme).toBe('s3');
    expect(d.info!.kind).toBe('object-store');
    expect(d.info!.capabilities).toEqual({ claim: false, push: false });
    expect(d.info!.channel.template).toBe('s3://<bucket>/<channel>');
  });

  it('gs: same shape as s3 with its own template', async () => {
    const d = await describeJson('gs://acme-bus/team-a');
    expect(d.info!.channel.template).toBe('gs://<bucket>/<channel>');
  });

  it('postgres: never connects — describing an unreachable server succeeds instantly', async () => {
    const t0 = Date.now();
    const d = await describeJson('postgres://nobody@nowhere.invalid:1/x');
    expect(Date.now() - t0).toBeLessThan(5000); // a connection attempt would hang/retry
    expect(d.info!.capabilities).toEqual({ claim: true, push: true });
  });

  it('bare paths resolve like createBackend: *.db → sqlite, directory → file', async () => {
    expect((await describeJson('./some/dir')).scheme).toBe('file');
    expect((await describeJson('./some/bus.db')).scheme).toBe('sqlite');
  });

  it('human output carries the security note and channel example', async () => {
    const r = await run(['describe', '--backend', 's3://acme-bus']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/namespacing, not security/);
    expect(r.stdout).toMatch(/example: {2}s3:\/\/acme-bus\/team-a/);
  });

  it('every JSON response includes the security note', async () => {
    const d = await describeJson('file:///tmp/x');
    expect(d.security).toMatch(/namespacing, not security/);
  });

  it('unknown scheme fails with the registered-schemes list', async () => {
    const r = await run(['describe', '--backend', 'redis://localhost']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Known schemes: file, gs, postgres, postgresql, s3, sqlite/);
  });

  it('a plugin scheme registered WITH info is fully described; one WITHOUT info gets the honest fallback', async () => {
    const root = path.join(os.tmpdir(), `agentcomm-describe-${randomUUID()}`);
    await fs.mkdir(root, { recursive: true });
    const pluginPath = path.join(root, 'plugin.mjs');
    const indexUrl = pathToFileURL(path.join(here, '..', 'src', 'backends', 'index.ts')).href;
    const localUrl = pathToFileURL(path.join(here, '..', 'src', 'backends', 'local.ts')).href;
    await fs.writeFile(
      pluginPath,
      [
        `import { registerBackend } from ${JSON.stringify(indexUrl)};`,
        `import { LocalBackend } from ${JSON.stringify(localUrl)};`,
        `registerBackend('descfs', async () => new LocalBackend(${JSON.stringify(root)}), {`,
        `  kind: 'demo-store',`,
        `  capabilities: { claim: false, push: true },`,
        `  channel: { rule: 'one room per path', template: 'descfs://<room>', example: 'descfs://lobby' },`,
        `});`,
        `registerBackend('mutefs', async () => new LocalBackend(${JSON.stringify(root)}));`,
      ].join('\n'),
    );
    const env = { ...process.env, AGENTCOMM_BACKEND_PLUGINS: pathToFileURL(pluginPath).href };

    const described = await describeJson('descfs://lobby', env);
    expect(described.info!.kind).toBe('demo-store');
    expect(described.info!.capabilities.push).toBe(true);

    const mute = await describeJson('mutefs://anything', env);
    expect(mute.info).toBeNull();
    const human = await run(['describe', '--backend', 'mutefs://anything'], env);
    expect(human.stdout).toMatch(/published no description/);

    await fs.rm(root, { recursive: true, force: true });
  });
});
