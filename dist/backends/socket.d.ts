import type { Backend } from '../types.js';
export declare class SocketBackend implements Backend {
    private rpc;
    readonly daemonPid: number;
    readonly uri: string;
    readonly pollIntervalMs = 250;
    private constructor();
    /** Connect to a live daemon for `uri`, or return null (stale sockets are unlinked). */
    static connect(uri: string): Promise<SocketBackend | null>;
    /** Connect, spawning the daemon first if none is serving `uri`. Null = fall back to direct. */
    static connectOrSpawn(uri: string, cliPath: string): Promise<SocketBackend | null>;
    put(key: string, data: Buffer): Promise<void>;
    get(key: string): Promise<Buffer>;
    list(prefix: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    move(src: string, dst: string): Promise<void>;
    info(): Promise<Record<string, unknown>>;
    stop(): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=socket.d.ts.map