import { loadDriver } from './lazy.js';
/**
 * GCSBackend — keys are object names under a bucket (optionally with a base
 * prefix). The Google Cloud Storage SDK is an OPTIONAL, LAZY-loaded dependency.
 *
 * As with S3, `move` is copy+delete (NOT atomic); object-store backends do not
 * offer the `claim` capability for this reason.
 */
export class GCSBackend {
    bucket;
    basePrefix;
    constructor(bucket, basePrefix) {
        this.bucket = bucket;
        this.basePrefix = basePrefix;
    }
    static async open(bucketName, basePrefix = '') {
        const sdk = await loadDriver('@google-cloud/storage', '@google-cloud/storage', 'the GCS backend');
        const storage = new sdk.Storage();
        const prefix = basePrefix && !basePrefix.endsWith('/') ? `${basePrefix}/` : basePrefix;
        return new GCSBackend(storage.bucket(bucketName), prefix);
    }
    k(key) {
        return this.basePrefix + key;
    }
    async put(key, data) {
        await this.bucket.file(this.k(key)).save(data, { resumable: false });
    }
    async get(key) {
        const [buf] = await this.bucket.file(this.k(key)).download();
        return buf;
    }
    async list(prefix) {
        const [files] = await this.bucket.getFiles({ prefix: this.k(prefix) });
        const keys = files.map((f) => f.name.slice(this.basePrefix.length));
        keys.sort();
        return keys;
    }
    async delete(key) {
        try {
            await this.bucket.file(this.k(key)).delete();
        }
        catch (err) {
            if (err.code === 404)
                return;
            throw err;
        }
    }
    async exists(key) {
        const [ok] = await this.bucket.file(this.k(key)).exists();
        return ok;
    }
    async move(src, dst) {
        // copy + delete — NOT atomic.
        await this.bucket.file(this.k(src)).copy(this.bucket.file(this.k(dst)));
        await this.delete(src);
    }
}
//# sourceMappingURL=gcs.js.map