import { type Backend } from '../types.js';
/**
 * S3Backend — keys are object keys under a bucket (optionally with a base
 * prefix). The AWS SDK is an OPTIONAL, LAZY-loaded dependency.
 *
 * `move` is copy+delete (NOT atomic) — which is exactly why object-store
 * backends do not offer the `claim` capability. Single-consumer-per-inbox is
 * what keeps them race-free without locks.
 */
export declare class S3Backend implements Backend {
    private readonly client;
    private readonly sdk;
    private readonly bucket;
    private readonly basePrefix;
    private constructor();
    static open(bucket: string, basePrefix?: string): Promise<S3Backend>;
    private k;
    put(key: string, data: Buffer): Promise<void>;
    get(key: string): Promise<Buffer>;
    list(prefix: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    move(src: string, dst: string): Promise<void>;
}
//# sourceMappingURL=s3.d.ts.map