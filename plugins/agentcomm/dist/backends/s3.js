import { loadDriver } from './lazy.js';
/**
 * S3Backend — keys are object keys under a bucket (optionally with a base
 * prefix). The AWS SDK is an OPTIONAL, LAZY-loaded dependency.
 *
 * `move` is copy+delete (NOT atomic) — which is exactly why object-store
 * backends do not offer the `claim` capability. Single-consumer-per-inbox is
 * what keeps them race-free without locks.
 */
export class S3Backend {
    client;
    sdk;
    bucket;
    basePrefix;
    constructor(client, sdk, bucket, basePrefix) {
        this.client = client;
        this.sdk = sdk;
        this.bucket = bucket;
        this.basePrefix = basePrefix;
    }
    static async open(bucket, basePrefix = '') {
        const sdk = await loadDriver('@aws-sdk/client-s3', '@aws-sdk/client-s3', 'the S3 backend');
        // Endpoint, credentials and region flow in via the standard AWS env vars
        // (AWS_ENDPOINT_URL_S3, AWS_ACCESS_KEY_ID, ...). Path-style addressing has
        // no standard env var, but S3-compatible servers (Garage, MinIO, ...)
        // usually require it — hence this one escape hatch.
        const client = new sdk.S3Client(process.env.AGENTCOMM_S3_FORCE_PATH_STYLE ? { forcePathStyle: true } : {});
        const prefix = basePrefix && !basePrefix.endsWith('/') ? `${basePrefix}/` : basePrefix;
        return new S3Backend(client, sdk, bucket, prefix);
    }
    k(key) {
        return this.basePrefix + key;
    }
    async put(key, data) {
        await this.client.send(new this.sdk.PutObjectCommand({ Bucket: this.bucket, Key: this.k(key), Body: data }));
    }
    async get(key) {
        const res = await this.client.send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
        return streamToBuffer(res.Body);
    }
    async list(prefix) {
        const keys = [];
        let token;
        const full = this.k(prefix);
        do {
            const res = await this.client.send(new this.sdk.ListObjectsV2Command({
                Bucket: this.bucket,
                Prefix: full,
                ContinuationToken: token,
            }));
            for (const obj of res.Contents ?? []) {
                if (obj.Key)
                    keys.push(obj.Key.slice(this.basePrefix.length));
            }
            token = res.IsTruncated ? res.NextContinuationToken : undefined;
        } while (token);
        keys.sort();
        return keys;
    }
    async delete(key) {
        await this.client.send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
    }
    async exists(key) {
        try {
            await this.client.send(new this.sdk.HeadObjectCommand({ Bucket: this.bucket, Key: this.k(key) }));
            return true;
        }
        catch (err) {
            if (isNotFound(err))
                return false;
            throw err;
        }
    }
    async move(src, dst) {
        // copy + delete — NOT atomic. Object stores deliberately don't get claims.
        await this.client.send(new this.sdk.CopyObjectCommand({
            Bucket: this.bucket,
            CopySource: `${this.bucket}/${this.k(src)}`,
            Key: this.k(dst),
        }));
        await this.delete(src);
    }
}
function isNotFound(err) {
    const name = err.name;
    const status = err.$metadata?.httpStatusCode;
    return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}
async function streamToBuffer(body) {
    if (!body)
        return Buffer.alloc(0);
    // Node streams (and SDK Blob-like bodies) expose async iteration.
    const chunks = [];
    for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
//# sourceMappingURL=s3.js.map