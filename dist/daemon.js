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
import { isClaimable } from './types.js';
export function daemonDir() {
    return process.env.AGENTCOMM_DAEMON_DIR ?? path.join(os.homedir(), '.cache', 'agentcomm', 'd');
}
export function socketPathFor(uri) {
    return path.join(daemonDir(), createHash('sha1').update(uri).digest('hex').slice(0, 12) + '.sock');
}
export async function runDaemon(uri) {
    const pollMs = Math.max(500, Number(process.env.AGENTCOMM_POLL_MS ?? 10_000));
    const idleMs = Math.max(5_000, Number(process.env.AGENTCOMM_DAEMON_IDLE_MS ?? 30 * 60_000));
    const backend = await createBackend(uri);
    const claimable = isClaimable(backend);
    // warm mirror: full key set + bodies. Message blobs are immutable; agent
    // records mutate (heartbeats), so those are refreshed on every poll.
    const mirror = new Map();
    let keys = new Set();
    async function poll() {
        // Snapshot the outbox BEFORE listing the store: a key is always in at
        // least one of the two (spool until delivered, store afterwards) — the
        // other order can miss it mid-flush for a full poll cycle.
        const spooled = [];
        try {
            for (const f of (await fs.readdir(sockPath + '.spool')).filter((x) => !x.startsWith('.'))) {
                const { key } = JSON.parse(await fs.readFile(path.join(sockPath + '.spool', f), 'utf8'));
                spooled.push(key);
            }
        }
        catch { /* spool not created yet */ }
        const listed = await backend.list('');
        const next = new Set([...listed, ...spooled]);
        for (const k of listed) {
            if (!mirror.has(k) || k.startsWith('agents/')) {
                try {
                    mirror.set(k, await backend.get(k));
                }
                catch {
                    next.delete(k); // vanished between list and get
                }
            }
        }
        for (const k of mirror.keys())
            if (!next.has(k))
                mirror.delete(k);
        keys = next;
    }
    await poll();
    let lastActivity = Date.now();
    const sockPath = socketPathFor(uri);
    await fs.mkdir(path.dirname(sockPath), { recursive: true });
    // Two instances may autostart simultaneously for the same bus. Never
    // steal a LIVE peer's socket — if someone already answers, bow out and
    // let every client share that one daemon. Only a dead socket is removed.
    const peerAlive = await new Promise((resolve) => {
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
        await backend.close?.().catch(() => { });
        process.exit(0);
    }
    await fs.rm(sockPath, { force: true });
    async function handle(req) {
        lastActivity = Date.now();
        switch (req.op) {
            case 'info':
                return {
                    ok: true,
                    uri,
                    claimable,
                    pollMs,
                    pid: process.pid,
                    outbox: await spoolDepth(),
                    flushFailures,
                };
            case 'list':
                return { ok: true, keys: [...keys].filter((k) => k.startsWith(req.prefix ?? '')).sort() };
            case 'exists':
                return { ok: true, exists: keys.has(req.key) };
            case 'get': {
                const cached = mirror.get(req.key);
                if (cached)
                    return { ok: true, data: cached.toString('base64') };
                const fresh = await backend.get(req.key); // between-poll keys: passthrough
                mirror.set(req.key, fresh);
                keys.add(req.key);
                return { ok: true, data: fresh.toString('base64') };
            }
            case 'put': {
                const buf = Buffer.from(req.data ?? '', 'base64');
                if (req.sync) {
                    await backend.put(req.key, buf);
                }
                else {
                    await spoolAdd(req.key, buf); // durable locally; flusher delivers
                }
                mirror.set(req.key, buf);
                keys.add(req.key);
                return { ok: true, queued: !req.sync };
            }
            case 'delete':
                if (!(await spoolTake(req.key)))
                    await backend.delete(req.key);
                mirror.delete(req.key);
                keys.delete(req.key);
                return { ok: true };
            case 'move': {
                if (!(await spoolTake(req.src, req.dst))) {
                    await backend.move(req.src, req.dst);
                }
                const body = mirror.get(req.src);
                mirror.delete(req.src);
                keys.delete(req.src);
                if (body) {
                    mirror.set(req.dst, body);
                    keys.add(req.dst);
                }
                return { ok: true };
            }
            case 'claim': {
                if (!claimable)
                    return { ok: false, code: 'ENOTSUP', error: 'backend does not support claim' };
                const msg = await backend.claim(req.queue, req.owner);
                await poll().catch(() => { }); // claim moved keys under the mirror
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
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 1);
                if (!line.trim())
                    continue;
                let req;
                try {
                    req = JSON.parse(line);
                }
                catch {
                    continue;
                }
                handle(req)
                    .then((res) => sock.write(JSON.stringify({ id: req.id, ...res }) + '\n'))
                    .catch((err) => sock.write(JSON.stringify({ id: req.id, ok: false, error: err.message }) + '\n'));
            }
        });
        sock.on('error', () => { });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(sockPath, resolve);
    });
    await fs.writeFile(sockPath + '.pid', String(process.pid));
    // Outbox spool: puts are accepted onto disk and delivered by the flusher,
    // so `send` acks in milliseconds while delivery (a git push, an API call)
    // happens on the daemon's clock — FIFO, retried, surviving restarts.
    const spoolDir = sockPath + '.spool';
    await fs.mkdir(spoolDir, { recursive: true });
    let spoolSeq = 0;
    let flushFailures = 0;
    async function spoolAdd(key, data) {
        const name = `${String(Date.now()).padStart(14, '0')}-${String(++spoolSeq).padStart(6, '0')}`;
        const tmp = path.join(spoolDir, '.' + name);
        await fs.writeFile(tmp, JSON.stringify({ key, data: data.toString('base64') }));
        await fs.rename(tmp, path.join(spoolDir, name)); // atomic appearance
    }
    async function spoolDepth() {
        try {
            return (await fs.readdir(spoolDir)).filter((f) => !f.startsWith('.')).length;
        }
        catch {
            return 0;
        }
    }
    // One mutex serializes the flusher against spool mutations (a move/delete
    // of a not-yet-delivered key rewrites its spool entry — racing the flusher
    // there would deliver the stale key and lose the rewrite).
    let spoolChain = Promise.resolve();
    function withSpool(fn) {
        const next = spoolChain.then(fn, fn);
        spoolChain = next.catch(() => { });
        return next;
    }
    function flush() {
        return withSpool(async () => {
            const entries = (await fs.readdir(spoolDir)).filter((f) => !f.startsWith('.')).sort();
            for (const f of entries) {
                const file = path.join(spoolDir, f);
                try {
                    const { key, data } = JSON.parse(await fs.readFile(file, 'utf8'));
                    await backend.put(key, Buffer.from(data, 'base64'));
                    await fs.rm(file, { force: true });
                    flushFailures = 0;
                }
                catch {
                    flushFailures++;
                    break; // keep FIFO order — retry this entry next tick
                }
            }
        });
    }
    /** If `key` is still spooled, rewrite/remove it locally and return true. */
    function spoolTake(key, rewriteTo) {
        return withSpool(async () => {
            for (const f of (await fs.readdir(spoolDir)).filter((x) => !x.startsWith('.')).sort()) {
                const file = path.join(spoolDir, f);
                try {
                    const entry = JSON.parse(await fs.readFile(file, 'utf8'));
                    if (entry.key !== key)
                        continue;
                    if (rewriteTo)
                        await fs.writeFile(file, JSON.stringify({ ...entry, key: rewriteTo }));
                    else
                        await fs.rm(file, { force: true });
                    return true;
                }
                catch { /* unreadable entry: leave for the flusher */ }
            }
            return false;
        });
    }
    const flushMs = Math.max(100, Number(process.env.AGENTCOMM_FLUSH_MS ?? 250));
    const flushTimer = setInterval(() => void flush(), flushMs);
    flushTimer.unref?.();
    void flush(); // deliver anything a previous daemon left behind
    // Housekeeping: heartbeats and archives must not accrete forever. The
    // daemon is the bus's long-lived janitor: periodically trim the read/
    // archive and drop agent records whose lastSeen went stale.
    const housekeepMs = Math.max(10_000, Number(process.env.AGENTCOMM_HOUSEKEEP_MS ?? 6 * 3600_000));
    const archiveTtl = Number(process.env.AGENTCOMM_PURGE_AFTER_MS ?? 30 * 24 * 3600_000);
    const agentTtl = Number(process.env.AGENTCOMM_AGENT_TTL_MS ?? 7 * 24 * 3600_000);
    async function housekeep() {
        const now = Date.now();
        if (agentTtl > 0) {
            for (const k of await backend.list('agents/')) {
                try {
                    const rec = JSON.parse((await backend.get(k)).toString('utf8'));
                    if (rec.lastSeen && now - Date.parse(rec.lastSeen) > agentTtl)
                        await backend.delete(k);
                }
                catch { /* unreadable record: leave it */ }
            }
        }
        if (archiveTtl > 0) {
            for (const k of await backend.list('read/')) {
                // key layout: read/<recipient>/<zero-padded-ms-seq>-<id>.json
                const seq = /read\/[^/]+\/0*(\d+)-/.exec(k)?.[1];
                if (seq && now - Number(seq) > archiveTtl)
                    await backend.delete(k).catch(() => { });
            }
        }
        await poll().catch(() => { });
    }
    const housekeepTimer = setInterval(() => void housekeep().catch(() => { }), housekeepMs);
    housekeepTimer.unref?.();
    setTimeout(() => void housekeep().catch(() => { }), 15_000).unref?.();
    const pollTimer = setInterval(() => void poll().catch(() => { }), pollMs);
    const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > idleMs)
            shutdown();
    }, 30_000);
    pollTimer.unref?.();
    idleTimer.unref?.();
    function shutdown() {
        clearInterval(pollTimer);
        clearInterval(idleTimer);
        clearInterval(housekeepTimer);
        clearInterval(flushTimer);
        server.close();
        const cap = setTimeout(() => process.exit(0), 15_000); // don't hang forever on a dead remote
        cap.unref?.();
        void flush() // drain the outbox for real before dying; leftovers survive on disk anyway
            .catch(() => { })
            .finally(() => {
            void fs.rm(sockPath, { force: true }).catch(() => { });
            void fs.rm(sockPath + '.pid', { force: true }).catch(() => { });
            void backend.close?.().catch(() => { });
            setTimeout(() => process.exit(0), 100);
        });
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    process.stderr.write(`agentcomm daemon: serving ${uri} on ${sockPath} (poll ${pollMs}ms)\n`);
    // keep the event loop alive for the socket server
    await new Promise(() => { });
}
//# sourceMappingURL=daemon.js.map