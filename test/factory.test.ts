import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBackend } from '../src/backends/index.js';
import { LocalBackend, SqliteBackend, S3Backend, GCSBackend } from '../src/backends/index.js';
import { loadDriver } from '../src/backends/lazy.js';
import { MissingDriverError } from '../src/types.js';

const tmpRoots: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `agentcomm-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  tmpRoots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('createBackend URI factory', () => {
  it('file:// → LocalBackend', async () => {
    const b = await createBackend(`file://${await mkTmp()}`);
    expect(b).toBeInstanceOf(LocalBackend);
  });

  it('bare directory path → LocalBackend', async () => {
    const b = await createBackend(await mkTmp());
    expect(b).toBeInstanceOf(LocalBackend);
  });

  it('sqlite:// → SqliteBackend', async () => {
    const b = await createBackend(`sqlite://${path.join(await mkTmp(), 'x.db')}`);
    expect(b).toBeInstanceOf(SqliteBackend);
    await b.close?.();
  });

  it('bare *.db path → SqliteBackend', async () => {
    const b = await createBackend(path.join(await mkTmp(), 'x.db'));
    expect(b).toBeInstanceOf(SqliteBackend);
    await b.close?.();
  });

  it('unsupported scheme throws a clear error', async () => {
    await expect(createBackend('redis://localhost')).rejects.toThrow(/unsupported backend URI/);
  });

  // s3:// and gs:// must route to the cloud backends — never to the
  // "unsupported scheme" path. Whether the optional SDK is installed varies by
  // environment, so accept either outcome: the right backend, or a clean
  // MissingDriverError. What must NOT happen is an unsupported-scheme error.
  it('s3:// routes to S3Backend (or a clean MissingDriverError)', async () => {
    const b = await createBackend('s3://my-bucket/prefix').catch((e) => e as Error);
    if (b instanceof Error) expect(b).toBeInstanceOf(MissingDriverError);
    else expect(b).toBeInstanceOf(S3Backend);
  });

  it('gs:// routes to GCSBackend (or a clean MissingDriverError)', async () => {
    const b = await createBackend('gs://my-bucket/prefix').catch((e) => e as Error);
    if (b instanceof Error) expect(b).toBeInstanceOf(MissingDriverError);
    else expect(b).toBeInstanceOf(GCSBackend);
  });
});

// The "SDK-missing error path" (Definition of Done #7) — tested deterministically
// against the shared lazy loader so it doesn't depend on what's installed.
describe('optional driver loading', () => {
  it('a genuinely-missing driver → clear MissingDriverError', async () => {
    await expect(
      loadDriver('agentcomm-no-such-driver-xyz', 'agentcomm-no-such-driver-xyz', 'the test backend'),
    ).rejects.toBeInstanceOf(MissingDriverError);
  });

  it('MissingDriverError message tells the user what to install', async () => {
    const err = await loadDriver('agentcomm-no-such-driver-xyz', 'some-pkg', 'the test backend').catch(
      (e) => e as Error,
    );
    expect(err.message).toContain('npm install some-pkg');
    expect(err.message).toContain('the test backend');
  });

  it('an installed driver loads (better-sqlite3)', async () => {
    const mod = await loadDriver<{ default: unknown }>('better-sqlite3', 'better-sqlite3', 'sqlite');
    expect(typeof mod.default).toBe('function');
  });
});
