/**
 * A daemon backlogged behind a slow op (its outbox flusher queued under heavy contention,
 * e.g. many processes sharing one git+https bus) used to leave a client call pending
 * forever: no error, no way to tell a hang apart from ordinary latency (every CLI command
 * routed through a daemon shares this risk, not just one op). This drives SocketBackend
 * against a fake daemon that never answers a `get`, and asserts the client fails loudly
 * instead of hanging.
 *
 * RPC_TIMEOUT_MS is read from the env once at module load, so each test sets
 * AGENTCOMM_RPC_TIMEOUT_MS and then resets the module registry before importing
 * SocketBackend fresh -- setting the env var alone would not affect an already-evaluated
 * constant.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as net from 'node:net';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { socketPathFor } from '../src/daemon.js';
import type { SocketBackend as SocketBackendType } from '../src/backends/socket.js';

const URI = 'git+https://example.test/owner/repo.git';
const servers: net.Server[] = [];
const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  await Promise.all(tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  delete process.env.AGENTCOMM_RPC_TIMEOUT_MS;
  vi.resetModules();
});

/** A fake daemon that answers `info` (so `connect()` succeeds) and then goes silent. */
async function startUnresponsiveDaemon(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentcomm-rpc-timeout-'));
  tmpDirs.push(dir);
  process.env.AGENTCOMM_DAEMON_DIR = dir;
  const sockPath = socketPathFor(URI);
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const req = JSON.parse(line) as { id: number; op: string };
        if (req.op === 'info') {
          sock.write(JSON.stringify({ id: req.id, ok: true, pid: process.pid, claimable: false }) + '\n');
        }
        // Every other op: never respond -- the backlog this reproduces.
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(sockPath, resolve));
}

/** A fresh module registration, so the timeout constant it froze at import time
 * reflects AGENTCOMM_RPC_TIMEOUT_MS as set by this test, not an earlier one. */
async function freshSocketBackend(): Promise<typeof SocketBackendType> {
  vi.resetModules();
  const mod = await import('../src/backends/socket.js');
  return mod.SocketBackend;
}

describe('SocketBackend RPC timeout', () => {
  it('fails a call the daemon never answers instead of hanging forever', async () => {
    process.env.AGENTCOMM_RPC_TIMEOUT_MS = '150';
    await startUnresponsiveDaemon();
    const SocketBackend = await freshSocketBackend();
    const backend = await SocketBackend.connect(URI);
    expect(backend).not.toBeNull();
    await expect(backend!.get('some/key')).rejects.toThrow(/did not respond to "get"/);
    await backend!.close();
  });

  it('does not hold the process open once every call has resolved or timed out', async () => {
    process.env.AGENTCOMM_RPC_TIMEOUT_MS = '150';
    await startUnresponsiveDaemon();
    const SocketBackend = await freshSocketBackend();
    const backend = await SocketBackend.connect(URI);
    await backend!.get('some/key').catch(() => {});
    // The unref'd timer must not appear as an active handle once it has fired and been
    // cleared -- this is what previously kept a CLI invocation alive indefinitely.
    const timers = process
      ._getActiveHandles()
      .filter((h: { constructor: { name: string } }) => h.constructor.name === 'Timeout');
    expect(timers).toHaveLength(0);
    await backend!.close();
  });
});
