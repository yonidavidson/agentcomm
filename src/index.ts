/** Library entry point. Import these to embed agentcomm in another program. */
export { Bus } from './bus.js';
export type { SendInput, AgentRecord } from './bus.js';
export {
  createBackend,
  registerBackend,
  registeredSchemes,
  backendInfo,
  schemeForUri,
  LocalBackend,
  SqliteBackend,
  S3Backend,
  GCSBackend,
  GithubBackend,
} from './backends/index.js';
export { resolveGithubToken } from './backends/github.js';
export type { BackendFactory, BackendInfo } from './backends/index.js';
export { discoverChannels } from './channels.js';
export type { ChannelSummary } from './channels.js';
export { loadConventions, DEFAULT_CONVENTIONS } from './conventions.js';
export type { Conventions, LoadedConfig } from './conventions.js';
export type { Backend, Message, Claimable, Waitable } from './types.js';
export { isClaimable, isWaitable, MissingDriverError } from './types.js';
export { resolveConfig, parseArgs } from './config.js';
export type { ResolvedConfig, ParsedFlags } from './config.js';
