/**
 * The bus daemon: one background process per bus URI that polls the real
 * backend on its own clock and serves CLI processes over a unix socket.
 *
 * Reads come from a warm mirror (staleness ≤ the poll interval); writes go
 * through to the real backend immediately and update the mirror, so
 * read-your-write always holds. `claim` is forwarded verbatim — atomicity
 * must come from the store, never from a cache.
 *
 * The protocol is newline-delimited JSON, the Backend interface verbatim:
 *   → {id, op: 'get'|'put'|'list'|'delete'|'exists'|'move'|'claim'|'info'|'stop', ...}
 *   ← {id, ok: true, ...} | {id, ok: false, error, code?}
 * Buffers travel base64-encoded in `data`.
 */
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createBackend } from './backends/index.js';
import { isClaimable, type Backend } from './types.js';

export function daemonDir(): string {
  return process.env.AGENTCOMM_DAEMON_DIR ?? path.join(os.homedir(), '.cache', 'agentcomm', 'd');
}

export function socketPathFor(uri: string): string {
  return path.join(daemonDir(), createHash('sha1').update(uri).digest('hex').slice(0, 12) + '.sock');
}

interface Req {
  id: number;
  op: string;
  key?: string;
  src?: string;
  dst?: string;
  prefix?: string;
  queue?: string;
  owner?: string;
  data?: string; // base64
}

export async function runDaemon(uri: string): Promise<void> {
  const pollMs = Math.max(500, Number(process.env.AGENTCOMM_POLL_MS ?? 10_000));
  const idleMs = Math.max(5_000, Number(process.env.AGENTCOMM_DAEMON_IDLE_MS ?? 30 * 60_000));
  const backend: Backend = await createBackend(uri);
  const claimable = isClaimable(backend);

  // warm mirror: full key set + bodies. Message blobs are immutable; agent
  // records mutate (heartbeats), so those are refreshed on every poll.
  const mirror = new Map<string, Buffer>();
  let keys = new Set<string>();

  async function poll(): Promise<void> {
    const listed = await backend.list('');
    const next = new Set(listed);
    for (const k of listed) {
      if (!mirror.has(k) || k.startsWith('agents/')) {
        try {
          mirror.set(k, await backend.get(k));
        } catch {
          next.delete(k); // vanished between list and get
        }
      }
    }
    for (const k of mirror.keys()) if (!next.has(k)) mirror.delete(k);
    keys = next;
  }

  await poll();

  let lastActivity = Date.now();
  const sockPath = socketPathFor(uri);
  await fs.mkdir(path.dirname(sockPath), { recursive: true });

  // Two instances may autostart simultaneously for the same bus. Never
  // steal a LIVE peer's socket — if someone already answers, bow out and
  // let every client share that one daemon. Only a dead socket is removed.
  const peerAlive = await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(sockPath);
    const timer = setTimeout(() => {
      probe.destroy();
      resolve(false);
    }, 1000);
    probe.once('connect', () => {
      clearTimeout(timer);
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
  if (peerAlive) {
    process.stderr.write(`agentcomm daemon: another daemon already serves ${uri} — exiting
`);
    await backend.close?.().catch(() => {});
    process.exit(0);
  }
  await fs.rm(sockPath, { force: true });

  async function handle(req: Req): Promise<Record<string, unknown>> {
    lastActivity = Date.now();
    switch (req.op) {
      case 'info':
        return { ok: true, uri, claimable, pollMs, pid: process.pid };
      case 'list':
        return { ok: true, keys: [...keys].filter((k) => k.startsWith(req.prefix ?? '')).sort() };
      case 'exists':
        return { ok: true, exists: keys.has(req.key!) };
      case 'get': {
        const cached = mirror.get(req.key!);
        if (cached) return { ok: true, data: cached.toString('base64') };
        const fresh = await backend.get(req.key!); // between-poll keys: passthrough
        mirror.set(req.key!, fresh);
        keys.add(req.key!);
        return { ok: true, data: fresh.toString('base64') };
      }
      case 'put': {
        const buf = Buffer.from(req.data ?? '', 'base64');
        await backend.put(req.key!, buf);
        mirror.set(req.key!, buf);
        keys.add(req.key!);
        return { ok: true };
      }
      case 'delete':
        await backend.delete(req.key!);
        mirror.delete(req.key!);
        keys.delete(req.key!);
        return { ok: true };
      case 'move': {
        await backend.move(req.src!, req.dst!);
        const body = mirror.get(req.src!);
        mirror.delete(req.src!);
        keys.delete(req.src!);
        if (body) {
          mirror.set(req.dst!, body);
          keys.add(req.dst!);
        }
        return { ok: true };
      }
      case 'claim': {
        if (!claimable) return { ok: false, code: 'ENOTSUP', error: 'backend does not support claim' };
        const msg = await (backend as Backend & { claim(q: string, o: string): Promise<unknown> }).claim(
          req.queue!,
          req.owner!,
        );
        await poll().catch(() => {}); // claim moved keys under the mirror
        return { ok: true, message: msg };
      }
      case 'refresh':
        await poll();
        return { ok: true };
      case 'stop':
        setTimeout(() => process.exit(0), 50);
        return { ok: true, stopping: true };
      default:
        return { ok: false, error: `unknown op ${req.op}` };
    }
  }

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let req: Req;
        try {
          req = JSON.parse(line) as Req;
        } catch {
          continue;
        }
        handle(req)
          .then((res) => sock.write(JSON.stringify({ id: req.id, ...res }) + '\n'))
          .catch((err: Error) =>
            sock.write(JSON.stringify({ id: req.id, ok: false, error: err.message }) + '\n'),
          );
      }
    });
    sock.on('error', () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  await fs.writeFile(sockPath + '.pid', String(process.pid));

  const pollTimer = setInterval(() => void poll().catch(() => {}), pollMs);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > idleMs) shutdown();
  }, 30_000);
  pollTimer.unref?.();
  idleTimer.unref?.();

  function shutdown(): void {
    clearInterval(pollTimer);
    clearInterval(idleTimer);
    server.close();
    void fs.rm(sockPath, { force: true }).catch(() => {});
    void fs.rm(sockPath + '.pid', { force: true }).catch(() => {});
    void backend.close?.().catch(() => {});
    setTimeout(() => process.exit(0), 100);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stderr.write(`agentcomm daemon: serving ${uri} on ${sockPath} (poll ${pollMs}ms)\n`);
  // keep the event loop alive for the socket server
  await new Promise(() => {});
}
