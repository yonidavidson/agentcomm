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
import type { Backend, Message } from '../types.js';
import { socketPathFor } from '../daemon.js';

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

class Rpc {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private buf = '';

  constructor(private sock: net.Socket) {
    sock.on('data', (chunk) => {
      this.buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const res = JSON.parse(line) as { id: number } & Record<string, unknown>;
          const p = this.pending.get(res.id);
          if (p) {
            this.pending.delete(res.id);
            p.resolve(res);
          }
        } catch {
          /* skip malformed line */
        }
      }
    });
    const fail = (err?: Error) => {
      for (const p of this.pending.values()) p.reject(err ?? new Error('daemon connection closed'));
      this.pending.clear();
    };
    sock.on('error', fail);
    sock.on('close', () => fail());
  }

  call(op: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.sock.write(JSON.stringify({ id, op, ...fields }) + '\n');
    });
  }

  end(): void {
    this.sock.end();
    this.sock.destroy();
  }
}

function ok(res: Record<string, unknown>): Record<string, unknown> {
  if (res.ok) return res;
  const err = new Error(String(res.error ?? 'daemon error'));
  (err as Error & { code?: unknown }).code = res.code;
  throw err;
}

export class SocketBackend implements Backend {
  readonly pollIntervalMs = 250; // local socket polls are ~free

  private constructor(
    private rpc: Rpc,
    readonly daemonPid: number,
    readonly uri: string,
  ) {}

  /** Connect to a live daemon for `uri`, or return null (stale sockets are unlinked). */
  static async connect(uri: string): Promise<SocketBackend | null> {
    const sockPath = socketPathFor(uri);
    const sock = await new Promise<net.Socket | null>((resolve) => {
      const s = net.createConnection(sockPath);
      s.once('connect', () => resolve(s));
      s.once('error', () => resolve(null));
    });
    if (!sock) {
      await fs.rm(sockPath, { force: true }).catch(() => {}); // stale leftover
      await fs.rm(sockPath + '.pid', { force: true }).catch(() => {});
      return null;
    }
    const rpc = new Rpc(sock);
    try {
      const info = ok(await rpc.call('info'));
      const backend = new SocketBackend(rpc, Number(info.pid), uri);
      if (info.claimable) {
        (backend as SocketBackend & { claim?: unknown }).claim = async (
          queue: string,
          owner: string,
        ): Promise<Message | null> => {
          const res = ok(await backend.rpc.call('claim', { queue, owner }));
          return (res.message as Message | null) ?? null;
        };
      }
      return backend;
    } catch {
      rpc.end();
      return null;
    }
  }

  /** Connect, spawning the daemon first if none is serving `uri`. Null = fall back to direct. */
  static async connectOrSpawn(uri: string, cliPath: string): Promise<SocketBackend | null> {
    const existing = await SocketBackend.connect(uri);
    if (existing) return existing;
    try {
      const child = spawn(process.execPath, [cliPath, 'daemon', 'run', '--backend', uri], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();
    } catch {
      return null;
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const client = await SocketBackend.connect(uri);
      if (client) return client;
    }
    return null;
  }

  async put(key: string, data: Buffer): Promise<void> {
    ok(await this.rpc.call('put', { key, data: data.toString('base64') }));
  }

  async get(key: string): Promise<Buffer> {
    const res = ok(await this.rpc.call('get', { key }));
    return Buffer.from(String(res.data), 'base64');
  }

  async list(prefix: string): Promise<string[]> {
    const res = ok(await this.rpc.call('list', { prefix }));
    return res.keys as string[];
  }

  async delete(key: string): Promise<void> {
    ok(await this.rpc.call('delete', { key }));
  }

  async exists(key: string): Promise<boolean> {
    const res = ok(await this.rpc.call('exists', { key }));
    return Boolean(res.exists);
  }

  async move(src: string, dst: string): Promise<void> {
    ok(await this.rpc.call('move', { src, dst }));
  }

  async info(): Promise<Record<string, unknown>> {
    return ok(await this.rpc.call('info'));
  }

  async stop(): Promise<void> {
    ok(await this.rpc.call('stop'));
  }

  async close(): Promise<void> {
    this.rpc.end();
  }
}
