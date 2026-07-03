import { type Backend } from '../types.js';
import { loadDriver } from './lazy.js';

/**
 * GCSBackend — keys are object names under a bucket (optionally with a base
 * prefix). The Google Cloud Storage SDK is an OPTIONAL, LAZY-loaded dependency.
 *
 * As with S3, `move` is copy+delete (NOT atomic); object-store backends do not
 * offer the `claim` capability for this reason.
 */
export class GCSBackend implements Backend {
  private constructor(
    private readonly bucket: GcsBucketLike,
    private readonly basePrefix: string,
  ) {}

  static async open(bucketName: string, basePrefix = ''): Promise<GCSBackend> {
    const sdk = await loadDriver<GcsSdk>(
      '@google-cloud/storage',
      '@google-cloud/storage',
      'the GCS backend',
    );
    // The standard STORAGE_EMULATOR_HOST env var is half-broken in the Node
    // SDK (JSON ops use the host verbatim while uploads append a different
    // path); the apiEndpoint option resolves both consistently — hence this
    // escape hatch for pointing at emulators like fake-gcs-server.
    const endpoint = process.env.AGENTCOMM_GCS_API_ENDPOINT;
    const storage = new sdk.Storage(endpoint ? { apiEndpoint: endpoint } : undefined);
    const prefix = basePrefix && !basePrefix.endsWith('/') ? `${basePrefix}/` : basePrefix;
    return new GCSBackend(storage.bucket(bucketName), prefix);
  }

  private k(key: string): string {
    return this.basePrefix + key;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.bucket.file(this.k(key)).save(data, { resumable: false });
  }

  async get(key: string): Promise<Buffer> {
    const [buf] = await this.bucket.file(this.k(key)).download();
    return buf;
  }

  async list(prefix: string): Promise<string[]> {
    const [files] = await this.bucket.getFiles({ prefix: this.k(prefix) });
    const keys = files.map((f) => f.name.slice(this.basePrefix.length));
    keys.sort();
    return keys;
  }

  async delete(key: string): Promise<void> {
    try {
      await this.bucket.file(this.k(key)).delete();
    } catch (err) {
      if ((err as { code?: number }).code === 404) return;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    const [ok] = await this.bucket.file(this.k(key)).exists();
    return ok;
  }

  async move(src: string, dst: string): Promise<void> {
    // copy + delete — NOT atomic.
    await this.bucket.file(this.k(src)).copy(this.bucket.file(this.k(dst)));
    await this.delete(src);
  }
}

// Structural types for the lazily-imported GCS SDK.
interface GcsFileLike {
  save(data: Buffer, opts?: unknown): Promise<unknown>;
  download(): Promise<[Buffer]>;
  delete(): Promise<unknown>;
  exists(): Promise<[boolean]>;
  copy(dest: GcsFileLike): Promise<unknown>;
  name: string;
}
interface GcsBucketLike {
  file(name: string): GcsFileLike;
  getFiles(opts: { prefix: string }): Promise<[GcsFileLike[]]>;
}
interface GcsStorageLike {
  bucket(name: string): GcsBucketLike;
}
interface GcsSdk {
  Storage: new (options?: { apiEndpoint: string }) => GcsStorageLike;
}
