import { type Backend } from '../types.js';
/**
 * GCSBackend — keys are object names under a bucket (optionally with a base
 * prefix). The Google Cloud Storage SDK is an OPTIONAL, LAZY-loaded dependency.
 *
 * As with S3, `move` is copy+delete (NOT atomic); object-store backends do not
 * offer the `claim` capability for this reason.
 */
export declare class GCSBackend implements Backend {
    private readonly bucket;
    private readonly basePrefix;
    private constructor();
    static open(bucketName: string, basePrefix?: string): Promise<GCSBackend>;
    private k;
    put(key: string, data: Buffer): Promise<void>;
    get(key: string): Promise<Buffer>;
    list(prefix: string): Promise<string[]>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    move(src: string, dst: string): Promise<void>;
}
//# sourceMappingURL=gcs.d.ts.map