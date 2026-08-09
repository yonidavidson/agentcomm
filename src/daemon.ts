/**
 * The bus daemon: one background process per bus URI that polls the real
 * backend on its own clock and serves CLI processes over a unix socket.
 *
 * Reads come from a warm mirror (staleness ≤ the poll interval); writes are
 * accepted onto a durable disk outbox, applied to the mirror at once and
 * delivered to the real store on the daemon's clock, so read-your-write
 * always holds while no client waits out a remote round trip. `claim` is
 * forwarded verbatim — atomicity must come from the store, never a cache.
 *
 * The socket binds BEFORE the first poll (issue #144): warming a large bus
 * key-by-key can take minutes on round-trip-per-read stores, and a daemon
 * that is invisible until then makes every client spawn another daemon — a
 * stampede that never converges. Clients connect immediately; data ops just
 * block until the warm-up finishes.
 *
 * The protocol is newline-delimited JSON, the Backend interface verbatim:
 *   → {id, op: 'get'|'put'|'list'|'delete'|'exists'|'move'|'moveMany'|'claim'|'info'|'stop', ...}
 *   ← {id, ok: true, ...} | {id, ok: false, error, code?}
 * Buffers travel base64-encoded in `data`.
 */
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createBackend } from './backends/index.js';
import { isBatchable, isClaimable, isSnapshottable, type Backend } from './types.js';

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
  moves?: { src: string; dst: string }[];
  prefix?: string;
  queue?: string;
  owner?: string;
  data?: string; // base64
  sync?: boolean;
}

/**
 * One deferred write in the outbox. `op` is absent on entries written by
 * pre-0.21 daemons, which only ever spooled puts — treat those as puts.
 */
type SpoolEntry =
  | { op?: 'put'; key: string; data: string }
  | { op: 'move'; moves: { src: string; dst: string }[] }
  | { op: 'delete'; key: string };

export async function runDaemon(uri: string): Promise<void> {
  // github:// pays REST quota per poll (5,000/hr shared) — default gently
  const defaultPollMs = uri.startsWith('github://') ? 30_000 : 10_000;
  const pollMs = Math.max(500, Number(process.env.AGENTCOMM_POLL_MS ?? defaultPollMs));
  const idleMs = Math.max(5_000, Number(process.env.AGENTCOMM_DAEMON_IDLE_MS ?? 30 * 60_000));
  const backend: Backend = await createBackend(uri);
  const claimable = isClaimable(backend);

  let lastActivity = Date.now();
  const sockPath = socketPathFor(uri);
  await fs.mkdir(path.dirname(sockPath), { recursive: true });

  // Two instances may autostart simultaneously for the same bus. Never
  // steal a LIVE peer's socket — if someone already answers, bow out and
  // let every client share that one daemon. Only a dead socket is removed.
  const probePeer = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
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
  const bowOut = async (): Promise<never> => {
    process.stderr.write(`agentcomm daemon: another daemon already serves ${uri} — exiting\n`);
    await backend.close?.().catch(() => {});
    process.exit(0);
  };
  if (await probePeer()) await bowOut();

  // Outbox spool: writes are accepted onto disk and delivered by the flusher,
  // so `send` acks in milliseconds while delivery (a git push, an API call)
  // happens on the daemon's clock — FIFO, retried, surviving restarts.
  // Consuming reads spool too (issue #159): archiving a mailbox key-by-key
  // against a remote store is a round trip per message, which is what made
  // `inbox` time out where `peek` was instant.
  const spoolDir = sockPath + '.spool';
  await fs.mkdir(spoolDir, { recursive: true });
  let spoolSeq = 0;
  let flushFailures = 0;
  async function spoolAdd(entry: SpoolEntry): Promise<void> {
    const name = `${String(Date.now()).padStart(14, '0')}-${String(++spoolSeq).padStart(6, '0')}`;
    const tmp = path.join(spoolDir, '.' + name);
    await fs.writeFile(tmp, JSON.stringify(entry));
    await fs.rename(tmp, path.join(spoolDir, name)); // atomic appearance
  }
  async function spoolDepth(): Promise<number> {
    try {
      return (await fs.readdir(spoolDir)).filter((f) => !f.startsWith('.')).length;
    } catch {
      return 0;
    }
  }
  // One mutex serializes the flusher against spool mutations (a move/delete
  // of a not-yet-delivered key rewrites its spool entry — racing the flusher
  // there would deliver the stale key and lose the rewrite).
  let spoolChain: Promise<unknown> = Promise.resolve();
  function withSpool<T>(fn: () => Promise<T>): Promise<T> {
    const next = spoolChain.then(fn, fn);
    spoolChain = next.catch(() => {});
    return next;
  }
  /** Apply one outbox entry against the real store. */
  async function deliver(entry: SpoolEntry): Promise<void> {
    if (entry.op === 'delete') return backend.delete(entry.key);
    if (entry.op === 'move') {
      // One store operation where the backend can (a single git commit for a
      // whole mailbox); otherwise pair by pair. A pair whose source is
      // already gone was archived by someone else — not an error.
      if (isBatchable(backend) && entry.moves.length > 1) return backend.moveMany(entry.moves);
      for (const { src, dst } of entry.moves) {
        await backend.move(src, dst).catch((err: NodeJS.ErrnoException) => {
          if (err?.code !== 'ENOENT') throw err;
        });
      }
      return;
    }
    return backend.put(entry.key, Buffer.from(entry.data, 'base64'));
  }

  function flush(): Promise<void> {
    return withSpool(async () => {
      const entries = (await fs.readdir(spoolDir)).filter((f) => !f.startsWith('.')).sort();
      for (const f of entries) {
        const file = path.join(spoolDir, f);
        try {
          await deliver(JSON.parse(await fs.readFile(file, 'utf8')) as SpoolEntry);
          await fs.rm(file, { force: true });
          flushFailures = 0;
        } catch {
          flushFailures++;
          break; // keep FIFO order — retry this entry next tick
        }
      }
    });
  }
  /** If `key` is a still-spooled PUT, rewrite/remove it locally and return true. */
  function spoolTake(key: string, rewriteTo?: string): Promise<boolean> {
    return withSpool(async () => {
      for (const f of (await fs.readdir(spoolDir)).filter((x) => !x.startsWith('.')).sort()) {
        const file = path.join(spoolDir, f);
        try {
          const entry = JSON.parse(await fs.readFile(file, 'utf8')) as SpoolEntry;
          if (entry.op === 'move' || entry.op === 'delete' || entry.key !== key) continue;
          if (rewriteTo) await fs.writeFile(file, JSON.stringify({ ...entry, key: rewriteTo }));
          else await fs.rm(file, { force: true });
          return true;
        } catch { /* unreadable entry: leave for the flusher */ }
      }
      return false;
    });
  }

  // warm mirror: the full key set, plus the bodies worth holding. Message
  // blobs are immutable, so a body already held is never re-read; agent
  // records (which mutate: heartbeats) are refreshed every poll.
  //
  // What is NOT held warm is history (issue #167). A bus only grows, and
  // re-reading every archived message and telemetry batch on every poll made
  // the daemon's cost scale with all history instead of with what is hot —
  // forever, on a store where nothing but the last few messages is live.
  // Archives and events older than the window keep their KEY (so list, log,
  // purge and channel discovery see the whole store, exactly as before) and
  // their body fills on demand through the `get` passthrough.
  const historyMs = Math.max(0, Number(process.env.AGENTCOMM_MIRROR_HISTORY_MS ?? 7 * 24 * 3600_000));
  const HOT_PREFIXES = ['agents/', 'inbox/'];
  /**
   * ms timestamp encoded in an archive/event key, or null when it has none.
   * Both layouts put a zero-padded, monotonic ms prefix on the filename:
   * read/<recipient>/<ms>-<counter>_<id>.json and events/<ms>-<counter>_<id>.json.
   */
  const keyTime = (key: string): number | null => {
    const m = /^0*(\d+)-/.exec(key.slice(key.lastIndexOf('/') + 1));
    return m ? Number(m[1]) : null;
  };
  const withinWindow = (key: string): boolean => {
    const ts = keyTime(key);
    return ts === null || Date.now() - ts <= historyMs;
  };
  /** Should the mirror hold this key's body at all? */
  const worthWarming = (key: string): boolean => HOT_PREFIXES.some((p) => key.startsWith(p)) || withinWindow(key);
  /** Should THIS poll read it? Not if we already hold an immutable body. */
  const needsRead = (key: string): boolean =>
    key.startsWith('agents/') || (worthWarming(key) && !mirror.has(key));

  const mirror = new Map<string, Buffer>();
  let keys = new Set<string>();

  /** Snapshot the outbox BEFORE listing the store: a key is always in at
   * least one of the two (spool until delivered, store afterwards) — the
   * other order can miss it mid-flush for a full poll cycle. Runs under the
   * flush mutex (issue #79): reading a spool file while the flusher rm's it
   * silently dropped the key for a cycle under load. */
  function snapshotSpool(): Promise<SpoolEntry[]> {
    return withSpool(async () => {
      const spooled: SpoolEntry[] = [];
      try {
        for (const f of (await fs.readdir(spoolDir)).filter((x) => !x.startsWith('.')).sort()) {
          try {
            spooled.push(JSON.parse(await fs.readFile(path.join(spoolDir, f), 'utf8')) as SpoolEntry);
          } catch { /* entry mid-write */ }
        }
      } catch { /* spool gone (shutdown) */ }
      return spooled;
    });
  }

  /**
   * Replay the undelivered outbox over what the store currently says, in FIFO
   * order. Without this a poll would resurrect keys an accepted-but-not-yet-
   * flushed archive already consumed — the store still has them — and the
   * message would be delivered twice (issue #159).
   */
  function replaySpool(ops: SpoolEntry[], bodies: Map<string, Buffer>, present: Set<string>): void {
    for (const entry of ops) {
      if (entry.op === 'delete') {
        bodies.delete(entry.key);
        present.delete(entry.key);
      } else if (entry.op === 'move') {
        for (const { src, dst } of entry.moves) {
          const body = bodies.get(src) ?? mirror.get(src) ?? mirror.get(dst);
          bodies.delete(src);
          present.delete(src);
          if (body) bodies.set(dst, body);
          present.add(dst);
        }
      } else {
        // spooled but not delivered yet — keep the local body
        const body = bodies.get(entry.key) ?? mirror.get(entry.key) ?? Buffer.from(entry.data, 'base64');
        bodies.set(entry.key, body);
        present.add(entry.key);
      }
    }
  }

  async function doPoll(): Promise<void> {
    const spooled = await snapshotSpool();
    // Bodies this poll actually read (fresh agent records + keys we do not
    // already hold), merged onto the ones already warm.
    const fetched = new Map<string, Buffer>();
    let next: Set<string>;
    if (isSnapshottable(backend)) {
      const snap = await backend.snapshot('', { bodies: needsRead });
      next = new Set(snap.keys);
      for (const [k, v] of snap.bodies) fetched.set(k, v);
    } else {
      next = new Set(await backend.list(''));
    }
    replaySpool(spooled, fetched, next);
    for (const k of mirror.keys()) {
      // drop what the store no longer has, what a fresher read supersedes,
      // and history that has aged out of the warm window
      if (!next.has(k) || k.startsWith('agents/') || !worthWarming(k)) mirror.delete(k);
    }
    for (const [k, v] of fetched) if (next.has(k)) mirror.set(k, v);
    keys = next;
  }
  // Coalesce: timer ticks, `refresh`, and post-claim polls that overlap a
  // slow poll join it instead of stacking concurrent fetches.
  let inFlight: Promise<void> | null = null;
  function poll(): Promise<void> {
    inFlight ??= doPoll().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  // First poll starts now and runs behind the (soon-bound) socket; if it
  // fails the daemon is useless — clean up and die so clients fall back to
  // direct connections.
  let warmed = false;
  let bound = false;
  const ready: Promise<void> = poll();
  ready.then(
    () => {
      warmed = true;
    },
    (err: Error) => {
      process.stderr.write(`agentcomm daemon: warm-up failed for ${uri}: ${err.message}\n`);
      if (bound) {
        void fs.rm(sockPath, { force: true }).catch(() => {});
        void fs.rm(sockPath + '.pid', { force: true }).catch(() => {});
      }
      void backend.close?.().catch(() => {});
      setTimeout(() => process.exit(1), 100);
    },
  );

  async function handle(req: Req): Promise<Record<string, unknown>> {
    lastActivity = Date.now();
    if (req.op !== 'info' && req.op !== 'stop') await ready; // data ops wait out the warm-up
    switch (req.op) {
      case 'info':
        return {
          ok: true,
          uri,
          claimable,
          pollMs,
          pid: process.pid,
          warming: !warmed,
          outbox: await spoolDepth(),
          flushFailures,
        };
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
        if (req.sync) {
          await backend.put(req.key!, buf);
        } else {
          await spoolAdd({ op: 'put', key: req.key!, data: buf.toString('base64') }); // durable locally; flusher delivers
        }
        mirror.set(req.key!, buf);
        keys.add(req.key!);
        return { ok: true, queued: !req.sync };
      }
      case 'delete':
        if (!(await spoolTake(req.key!))) {
          if (req.sync) await backend.delete(req.key!);
          else await spoolAdd({ op: 'delete', key: req.key! });
        }
        mirror.delete(req.key!);
        keys.delete(req.key!);
        return { ok: true };
      case 'move':
      case 'moveMany': {
        // Consuming a mailbox acks from the outbox, exactly like a send
        // (issue #159): the client is not held for a remote round trip per
        // archived message. The mirror moves the keys now, and the poll
        // replays the undelivered outbox so the store's stale view cannot
        // resurrect them.
        const moves = req.op === 'move' ? [{ src: req.src!, dst: req.dst! }] : (req.moves ?? []);
        const deferred: { src: string; dst: string }[] = [];
        for (const { src, dst } of moves) {
          if (!(await spoolTake(src, dst))) deferred.push({ src, dst });
        }
        if (deferred.length > 0) {
          if (req.sync) await deliver({ op: 'move', moves: deferred });
          else await spoolAdd({ op: 'move', moves: deferred });
        }
        for (const { src, dst } of moves) {
          const body = mirror.get(src);
          mirror.delete(src);
          keys.delete(src);
          if (body) mirror.set(dst, body);
          keys.add(dst);
        }
        return { ok: true, queued: !req.sync };
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
        setTimeout(shutdown, 50);
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

  // Bind now — warm later. On EADDRINUSE the path is either a live peer that
  // bound between our probe and our listen (bow out) or a dead leftover
  // (remove and retry). Never rm first: that stole a live peer's socket.
  const listen = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const onErr = (err: Error): void => reject(err);
      server.once('error', onErr);
      server.listen(sockPath, () => {
        server.removeListener('error', onErr);
        resolve();
      });
    });
  try {
    await listen();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    if (await probePeer()) await bowOut();
    await fs.rm(sockPath, { force: true });
    await listen();
  }
  bound = true;
  await fs.writeFile(sockPath + '.pid', String(process.pid));

  const flushMs = Math.max(100, Number(process.env.AGENTCOMM_FLUSH_MS ?? 250));
  const flushTimer = setInterval(() => void flush(), flushMs);
  flushTimer.unref?.();
  void flush(); // deliver anything a previous daemon left behind

  // Housekeeping: the daemon is the bus's long-lived janitor for the read/
  // archive ONLY. Registrations are append-forever (issue #100): presence is
  // heartbeat-derived (idle = not on the bus), and telemetry events reference
  // registrations by agent/session — deleting them would orphan history.
  // Telemetry events/ are likewise never touched here: their retention is an
  // explicit repo-config opt-in (`agentcomm purge --events` honors it), and
  // the daemon has no repo context to read that consent from.
  const housekeepMs = Math.max(10_000, Number(process.env.AGENTCOMM_HOUSEKEEP_MS ?? 6 * 3600_000));
  const archiveTtl = Number(process.env.AGENTCOMM_PURGE_AFTER_MS ?? 30 * 24 * 3600_000);
  async function housekeep(): Promise<void> {
    await ready; // never stack backend calls onto an unfinished warm-up
    const now = Date.now();
    if (archiveTtl > 0) {
      for (const k of await backend.list('read/')) {
        // key layout: read/<recipient>/<zero-padded-ms-seq>-<id>.json
        const seq = /read\/[^/]+\/0*(\d+)-/.exec(k)?.[1];
        if (seq && now - Number(seq) > archiveTtl) await backend.delete(k).catch(() => {});
      }
    }
    await poll().catch(() => {});
  }
  const housekeepTimer = setInterval(() => void housekeep().catch(() => {}), housekeepMs);
  housekeepTimer.unref?.();
  setTimeout(() => void housekeep().catch(() => {}), 15_000).unref?.();

  const pollTimer = setInterval(() => void poll().catch(() => {}), pollMs);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > idleMs) shutdown();
  }, 30_000);
  pollTimer.unref?.();
  idleTimer.unref?.();

  function shutdown(): void {
    clearInterval(pollTimer);
    clearInterval(idleTimer);
    clearInterval(housekeepTimer);
    clearInterval(flushTimer);
    server.close();
    const cap = setTimeout(() => process.exit(0), 15_000); // don't hang forever on a dead remote
    cap.unref?.();
    void flush() // drain the outbox for real before dying; leftovers survive on disk anyway
      .catch(() => {})
      .finally(() => {
        void fs.rm(sockPath, { force: true }).catch(() => {});
        void fs.rm(sockPath + '.pid', { force: true }).catch(() => {});
        void backend.close?.().catch(() => {});
        setTimeout(() => process.exit(0), 100);
      });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stderr.write(`agentcomm daemon: serving ${uri} on ${sockPath} (poll ${pollMs}ms)\n`);
  // keep the event loop alive for the socket server
  await new Promise(() => {});
}
