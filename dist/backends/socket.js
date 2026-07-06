/**
 * SocketBackend: the client half of the bus daemon. Implements the exact
 * Backend seam over a unix socket, so the Bus and every CLI command keep
 * their regular semantics — only the transport underneath gets faster.
 * `claim` is attached only when the daemon's real backend supports it, so
 * capability detection (isClaimable) behaves identically to a direct
 * connection.
 */
import * as net from 'node:net';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { socketPathFor } from '../daemon.js';
class Rpc {
    sock;
    seq = 0;
    pending = new Map();
    buf = '';
    constructor(sock) {
        this.sock = sock;
        sock.on('data', (chunk) => {
            this.buf += chunk.toString('utf8');
            let nl;
            while ((nl = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, nl);
                this.buf = this.buf.slice(nl + 1);
                if (!line.trim())
                    continue;
                try {
                    const res = JSON.parse(line);
                    const p = this.pending.get(res.id);
                    if (p) {
                        this.pending.delete(res.id);
                        p.resolve(res);
                    }
                }
                catch {
                    /* skip malformed line */
                }
            }
        });
        const fail = (err) => {
            for (const p of this.pending.values())
                p.reject(err ?? new Error('daemon connection closed'));
            this.pending.clear();
        };
        sock.on('error', fail);
        sock.on('close', () => fail());
    }
    call(op, fields = {}) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.sock.write(JSON.stringify({ id, op, ...fields }) + '\n');
        });
    }
    end() {
        this.sock.end();
        this.sock.destroy();
    }
}
function ok(res) {
    if (res.ok)
        return res;
    const err = new Error(String(res.error ?? 'daemon error'));
    err.code = res.code;
    throw err;
}
export class SocketBackend {
    rpc;
    daemonPid;
    uri;
    pollIntervalMs = 250; // local socket polls are ~free
    constructor(rpc, daemonPid, uri) {
        this.rpc = rpc;
        this.daemonPid = daemonPid;
        this.uri = uri;
    }
    /** Connect to a live daemon for `uri`, or return null (stale sockets are unlinked). */
    static async connect(uri) {
        const sockPath = socketPathFor(uri);
        const sock = await new Promise((resolve) => {
            const s = net.createConnection(sockPath);
            s.once('connect', () => resolve(s));
            s.once('error', () => resolve(null));
        });
        if (!sock) {
            await fs.rm(sockPath, { force: true }).catch(() => { }); // stale leftover
            await fs.rm(sockPath + '.pid', { force: true }).catch(() => { });
            return null;
        }
        const rpc = new Rpc(sock);
        try {
            const info = ok(await rpc.call('info'));
            const backend = new SocketBackend(rpc, Number(info.pid), uri);
            if (info.claimable) {
                backend.claim = async (queue, owner) => {
                    const res = ok(await backend.rpc.call('claim', { queue, owner }));
                    return res.message ?? null;
                };
            }
            return backend;
        }
        catch {
            rpc.end();
            return null;
        }
    }
    /** Connect, spawning the daemon first if none is serving `uri`. Null = fall back to direct. */
    static async connectOrSpawn(uri, cliPath) {
        const existing = await SocketBackend.connect(uri);
        if (existing)
            return existing;
        try {
            const child = spawn(process.execPath, [cliPath, 'daemon', 'run', '--backend', uri], {
                detached: true,
                stdio: 'ignore',
                env: process.env,
            });
            child.unref();
        }
        catch {
            return null;
        }
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const client = await SocketBackend.connect(uri);
            if (client)
                return client;
        }
        return null;
    }
    async put(key, data) {
        ok(await this.rpc.call('put', { key, data: data.toString('base64') }));
    }
    async get(key) {
        const res = ok(await this.rpc.call('get', { key }));
        return Buffer.from(String(res.data), 'base64');
    }
    async list(prefix) {
        const res = ok(await this.rpc.call('list', { prefix }));
        return res.keys;
    }
    async delete(key) {
        ok(await this.rpc.call('delete', { key }));
    }
    async exists(key) {
        const res = ok(await this.rpc.call('exists', { key }));
        return Boolean(res.exists);
    }
    async move(src, dst) {
        ok(await this.rpc.call('move', { src, dst }));
    }
    async info() {
        return ok(await this.rpc.call('info'));
    }
    async stop() {
        ok(await this.rpc.call('stop'));
    }
    async close() {
        this.rpc.end();
    }
}
//# sourceMappingURL=socket.js.map