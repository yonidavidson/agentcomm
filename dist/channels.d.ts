import type { Backend } from './types.js';
/** One discovered channel: its key prefix within the store, and how many agents are registered there. */
export interface ChannelSummary {
    /** '' is the store root; otherwise a slash-joined prefix like 'team-a' or 'team-a/sub'. */
    prefix: string;
    agents: number;
}
/**
 * Discover the channels that exist on a store by scanning its keys for the
 * agentcomm layout. A prefix P is a channel iff real layout lives under it:
 * `P/agents/<name>.json`, `P/inbox/<recipient>/<file>` or
 * `P/read/<recipient>/<file>`. The store root counts (prefix ''); nested
 * channels each count on their own; unrelated keys in a shared store are
 * ignored.
 *
 * v1 does one full `list('')` sweep — fine for buses, not for data lakes.
 */
export declare function discoverChannels(backend: Backend): Promise<ChannelSummary[]>;
//# sourceMappingURL=channels.d.ts.map