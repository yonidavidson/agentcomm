/** Library entry point. Import these to embed agentcomm in another program. */
export { Bus } from './bus.js';
export { createBackend, registerBackend, registeredSchemes, backendInfo, schemeForUri, LocalBackend, SqliteBackend, S3Backend, GCSBackend, GithubBackend, } from './backends/index.js';
export { resolveGithubToken } from './backends/github.js';
export { discoverChannels } from './channels.js';
export { loadConventions, DEFAULT_CONVENTIONS } from './conventions.js';
export { isClaimable, isWaitable, MissingDriverError } from './types.js';
export { resolveConfig, parseArgs } from './config.js';
//# sourceMappingURL=index.js.map