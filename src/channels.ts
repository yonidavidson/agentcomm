import type { Backend } from './types.js';

/** One discovered channel: its key prefix within the store, and how many agents are registered there. */
export interface ChannelSummary {
  /** '' is the store root; otherwise a slash-joined prefix like 'team-a' or 'team-a/sub'. */
  prefix: string;
  agents: number;
}

const MARKERS = new Set(['agents', 'inbox', 'read']);

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
export async function discoverChannels(backend: Backend): Promise<ChannelSummary[]> {
  const keys = await backend.list('');
  const prefixes = new Set<string>();

  for (const key of keys) {
    const segs = key.split('/');
    for (let i = 0; i < segs.length - 1; i++) {
      if (!MARKERS.has(segs[i]!)) continue;
      const after = segs.length - 1 - i; // segments following the marker
      const shape =
        segs[i] === 'agents'
          ? after === 1 && segs[segs.length - 1]!.endsWith('.json')
          : after === 2;
      if (!shape) continue;
      const prefix = segs.slice(0, i);
      // A channel's own path may not contain a marker segment — that's how
      // we reject e.g. 'inbox' as a "channel" when a recipient is literally
      // named 'agents' (key inbox/agents/0001.json).
      if (prefix.some((s) => MARKERS.has(s))) continue;
      prefixes.add(prefix.join('/'));
    }
  }

  const out: ChannelSummary[] = [];
  for (const p of [...prefixes].sort()) {
    const agentsDir = (p ? `${p}/` : '') + 'agents/';
    const agents = keys.filter((k) => {
      if (!k.startsWith(agentsDir)) return false;
      const rest = k.slice(agentsDir.length);
      return rest.length > 0 && !rest.includes('/') && rest.endsWith('.json');
    }).length;
    out.push({ prefix: p, agents });
  }
  return out;
}
