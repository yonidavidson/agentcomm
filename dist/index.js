/** Library entry point. Import these to embed agentcomm in another program. */
export { Bus } from './bus.js';
export { createBackend, registerBackend, registeredSchemes, LocalBackend, SqliteBackend, S3Backend, GCSBackend, } from './backends/index.js';
export { isClaimable, isWaitable, MissingDriverError } from './types.js';
export { resolveConfig, parseArgs } from './config.js';
//# sourceMappingURL=index.js.map