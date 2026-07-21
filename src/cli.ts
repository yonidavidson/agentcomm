#!/usr/bin/env node
import { backendInfo, createBackend, schemeForUri } from './backends/index.js';
import { detectRepoBus } from './backends/autodetect.js';
import { discoverChannels } from './channels.js';
import { loadConventions } from './conventions.js';
import { Bus } from './bus.js';
import { parseArgs, resolveConfig, type ParsedFlags, type ResolvedConfig } from './config.js';
import type { Backend, Message } from './types.js';
import { fileURLToPath } from 'node:url';
import { deriveIdentity, sessionHash } from './identity.js';
import {
  EVENTS_PREFIX,
  batchTimestamp,
  flushEvents,
  listEvents,
  materializeEvent,
  spoolDepth,
  spoolEvents,
} from './telemetry.js';

const USAGE = `agentcomm — a tiny mailbox/message bus for AI agents

Usage:
  agentcomm <command> [args] [flags]

Commands:
  init                     Put this repo on the bus: writes agent instructions
                           for --harness claude|codex|opencode|agents
                           (default: claude; all but claude write AGENTS.md),
                           registers you, and shows the roster
  hooks                    Generate the harness hook wiring that drives the
                           globally installed CLI: --harness opencode writes
                           .opencode/plugin/agentcomm.ts (register at session
                           start, inbox nudge on idle); claude|codex point at
                           their marketplace plugins. Static — never connects
  register                 Register/heartbeat the calling agent (--as)
  agents                   List registered agents
  network                  Situation report: who is on the bus and what
                           they're doing (active/idle + recent activity)
  send <to> [body]         Send a message (body from arg or stdin)
  broadcast [body]         Send to every registered agent except yourself
  inbox                    Consume undelivered messages (archived under read/)
  peek                     Show undelivered messages without consuming
  wait                     Block until a message arrives (exit 0) or timeout (exit 2)
  claim                    Atomically dequeue one message from --queue (SQL backends only)
  emit                     Record a telemetry event (--type, --name, --ref,
                           --attrs '<json>'). Spools locally — batches ride
                           the next bus write (register/send/broadcast), or
                           --flush ships now. Inert unless the repo config
                           has a telemetry section (opt-in)
  events                   Read telemetry events (--type/--name/--ref/--since
                           <dur>/--limit filters, --json for analysis)
  describe                 Explain the --backend scheme: how to carve channels,
                           and its capabilities — static, never connects
  channels                 List the channels that already exist on the --backend
                           store (scans for the agentcomm key layout)
  purge                    Delete archived (read/) messages older than
                           --older-than, and/or telemetry events older than
                           --events <dur> (or the config's telemetry.retention);
                           --dry-run to preview. Registrations are NEVER purged
                           (presence is heartbeat-derived; events reference
                           them). The daemon trims the archive automatically
                           (30d default)
  log                      Read a channel's conversation (pending + archived,
                           time-ordered, non-consuming); --thread, --limit
  conventions              Print the effective team conventions (built-in
                           defaults ⊕ .agentcomm.json/.yaml override file)
  daemon run|status|stop   The bus daemon: a background poller serving this
                           bus over a local socket, so every command answers
                           immediately. Network schemes (git+ssh://, github://)
                           use it automatically
  version                  Installed version + the latest GitHub release,
                           compared — prints the npm install -g one-liner
                           when an update exists (also -v / --version).
                           Agents: run this once per session to stay current

Flags:
  --backend <uri>          git+ssh:// | github:// | file:// | sqlite:// |
                           s3:// | gs:// | postgres:// | bare path. Default:
                           --backend > AGENTCOMM_BACKEND > .agentcomm config >
                           git+<origin> (probed inside a git repo — any host) >
                           github:// (token fallback) > file://./.agentcomm
  --repo <dir>             Resolve the bus as if running inside <dir> — its
                           .agentcomm config, its git remote, its file://
                           fallback. For tools that live OUTSIDE the bus repo
                           (dashboards, cron jobs, sibling projects). Also
                           AGENTCOMM_REPO or "repo" in the .agentcomm config
                           (one hop; an explicit backend always wins)
  --as <name>              Acting agent (env AGENTCOMM_AGENT)
  --subject <text>         Message subject (send/broadcast)
  --thread <id>            Thread id (send/broadcast)
  --timeout <ms>           wait timeout in ms (default 30000)
  --queue <name>           Queue to claim from (claim) — same namespace as a recipient inbox
  --daemon                 Force commands through the bus daemon (autostarts it)
  --direct                 Bypass the daemon for this call
  --sync                   Wait for remote durability on writes (default: the
                           daemon acks from its disk outbox and delivers async)
  --status <text>          register: declare what you're doing (explicit,
                           sticky) — shown on the roster and in digests
  --status-auto <text>     register: set an automatic status (task list) that
                           yields to any explicit --status declaration
  --harness <name>         init: claude (CLAUDE.md); codex|opencode|agents (AGENTS.md)
  --type <text>            emit/events: the event type (skill-ran, skill-outcome, …)
  --name <text>            emit/events: what the event is about (a skill/tool name)
  --ref <text>             emit/events: correlation handle (branch, PR#, run id)
  --attrs <json>           emit: free-form JSON payload for the event
  --flush                  emit: ship the spool now instead of riding the next write
  --since <dur>            events: only events newer than e.g. 30d, 12h
  --events <dur>           purge: age out telemetry events older than this
  --json                   Machine-readable JSON output
  -v, --version            Installed version + latest-release check
  --help                   Show this help

Env:
  AGENTCOMM_REPO             Repo pointer — same as --repo
  AGENTCOMM_DAEMON=1|0       Default all commands through / away from the daemon
  AGENTCOMM_POLL_MS          Daemon remote-poll interval (default 10000)
  AGENTCOMM_BACKEND_PLUGINS  comma/whitespace-separated module specifiers to
                             import before resolving --backend, so a
                             third-party package can register a new URI
                             scheme via registerBackend() (see README)

Examples:
  agentcomm register --as alice --backend sqlite:///tmp/bus.db
  agentcomm send bob "ship it" --as alice --backend sqlite:///tmp/bus.db
  agentcomm inbox --as bob --backend sqlite:///tmp/bus.db --json
`;

async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);
  const cfg = resolveConfig(flags, process.env);
  const positional = flags._;
  const command = positional[0];

  // version is static and network-optional: print the installed version and
  // compare against the latest GitHub release. Handled before everything else
  // so `-v`/`--version` behave like every other CLI's.
  if (flags.version || command === 'version' || command === '-v') return await cmdVersion(cfg);

  if (!command || command === '--help' || positional.includes('--help')) {
    process.stdout.write(USAGE);
    return command ? 0 : 1;
  }

  await loadBackendPlugins();

  // Backend resolution beyond flag/env: a project config file may pin one,
  // and inside a git repo with a github origin (+ resolvable token) the repo
  // itself is the default bus — agents are on the network just by running.
  // Explicit choices always win; both auto paths announce themselves on
  // stderr so nobody talks on a bus they didn't know they picked.
  //
  // A repo POINTER (--repo / AGENTCOMM_REPO / config `repo`, issue #117)
  // redirects that resolution to another checkout, so tools living outside
  // the bus repo — dashboards, cron jobs, sibling projects — talk on its bus
  // without cwd tricks. One hop only; an explicit backend still wins.
  if (!flags.backend && !process.env.AGENTCOMM_BACKEND) {
    const localCfg = await loadConventions().catch(() => null);
    const pointer = flags.repo ?? process.env.AGENTCOMM_REPO ?? localCfg?.repo;
    let busDir: string | undefined;
    let busCfg = localCfg;
    if (pointer) {
      const { expandTilde } = await import('./conventions.js');
      const { resolve } = await import('node:path');
      busDir = resolve(expandTilde(pointer));
      const { promises: fsp } = await import('node:fs');
      const isDir = await fsp
        .stat(busDir)
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (!isDir) fail(`repo pointer ${busDir} is not a directory (--repo / AGENTCOMM_REPO / config "repo")`);
      busCfg = await loadConventions(busDir).catch(() => null);
      if (busCfg?.repo) {
        fail(`repo pointer target ${busDir} declares a repo pointer of its own — chains are not supported`);
      }
    }
    const via = busDir ? `; via repo pointer ${busDir}` : '';
    if (busCfg?.backend) {
      cfg.backendUri = busCfg.backend;
      process.stderr.write(`agentcomm: using ${busCfg.backend} (project default from the .agentcomm config file${via})\n`);
    } else {
      const detected = await detectRepoBus(busDir);
      if (detected) {
        cfg.backendUri = detected;
        process.stderr.write(
          `agentcomm: using ${detected} (auto-detected from the git remote${via}; set AGENTCOMM_BACKEND or --backend to override)\n`,
        );
      } else if (busDir) {
        // Even off-git, the pointer's meaning holds: the bus lives THERE.
        const { join } = await import('node:path');
        cfg.backendUri = `file://${join(busDir, '.agentcomm')}`;
        process.stderr.write(`agentcomm: using ${cfg.backendUri} (via repo pointer ${busDir})\n`);
      }
    }
  }

  // describe and conventions are static by design — they answer "how would I
  // connect / how does this team talk?" before the user *can* connect, so
  // they never load a driver or open the backend. Handle before createBackend().
  if (command === 'describe') return cmdDescribe(cfg);
  if (command === 'conventions') return await cmdConventions(cfg);
  // hooks writes local harness wiring — file output only, no bus.
  if (command === 'hooks') return await cmdHooks(cfg, flags.harness);

  if (command === 'daemon') return await cmdDaemon(cfg, positional[1]);

  // emit is capture, not transport: it appends to the local spool and
  // returns — no backend connection, no network, unless --flush ships now.
  if (command === 'emit') return await cmdEmit(cfg, flags);

  const backend = await resolveTransport(cfg, flags);
  const bus = new Bus(backend);
  try {
    switch (command) {
      case 'register': {
        const code = await cmdRegister(bus, cfg, flags.status, flags.statusAuto);
        await piggybackFlush(backend, cfg);
        return code;
      }
      case 'init':
        return await cmdInit(bus, cfg, flags.harness);
      case 'agents':
        return await cmdAgents(bus, cfg);
      case 'network':
        return await cmdNetwork(bus, backend, cfg);
      case 'send': {
        const code = await cmdSend(bus, cfg, flags.subject, flags.thread, positional.slice(1));
        await piggybackFlush(backend, cfg);
        return code;
      }
      case 'broadcast': {
        const code = await cmdBroadcast(bus, cfg, flags.subject, flags.thread, positional.slice(1));
        await piggybackFlush(backend, cfg);
        return code;
      }
      case 'inbox':
        return await cmdInbox(bus, cfg);
      case 'peek':
        return await cmdPeek(bus, cfg);
      case 'wait':
        return await cmdWait(bus, cfg, flags.timeout ?? 30000);
      case 'claim':
        return await cmdClaim(bus, cfg, flags.queue);
      case 'channels':
        return await cmdChannels(backend, cfg);
      case 'purge':
        return await cmdPurge(backend, cfg, flags.olderThan, flags.agentsOlderThan, flags.events, flags.dryRun);
      case 'events':
        return await cmdEvents(backend, cfg, flags);
      case 'log':
        return await cmdLog(backend, cfg, flags.thread, flags.limit);
      default:
        fail(`unknown command "${command}". Run with --help.`);
        return 1;
    }
  } finally {
    await backend.close?.();
  }
}

// ── commands ────────────────────────────────────────────────────────────────

const CHANNEL_SECURITY_NOTE =
  'Channels are namespacing, not security: everyone on this store shares its credentials. ' +
  "Isolation is enforced by the backend's own access controls (IAM policies, database grants, file permissions). " +
  'Agent names are aliases (addressing, not authentication) — on git backends the commit author in git log is the verifiable identity.';

/** Schemes where a cold open is a network round-trip — daemon pays off. */
const SLOW_SCHEMES = new Set(['git+ssh', 'git+http', 'git+https', 'github']);

/**
 * The daemon is transparent under the Backend seam: same commands, flags and
 * exit codes either way. --daemon forces (and autostarts) it, --direct or
 * AGENTCOMM_DAEMON=0 bypasses, and network-remote schemes use it by default.
 * Any daemon failure falls back to a direct connection — never worse, only
 * faster.
 */
async function resolveTransport(
  cfg: ResolvedConfig,
  flags: { daemon?: boolean; direct?: boolean; sync?: boolean },
): Promise<Backend> {
  const envPref = process.env.AGENTCOMM_DAEMON;
  const want =
    !flags.direct &&
    envPref !== '0' &&
    (flags.daemon || envPref === '1' || SLOW_SCHEMES.has(schemeForUri(cfg.backendUri)));
  if (want) {
    const { SocketBackend } = await import('./backends/socket.js');
    const viaDaemon = await SocketBackend.connectOrSpawn(cfg.backendUri, fileURLToPath(import.meta.url));
    if (viaDaemon) {
      viaDaemon.syncWrites = flags.sync === true || process.env.AGENTCOMM_SYNC === '1';
      return viaDaemon;
    }
    process.stderr.write('agentcomm: daemon unavailable — using a direct connection\n');
  }
  return createBackend(cfg.backendUri);
}

async function cmdDaemon(cfg: ResolvedConfig, action?: string): Promise<number> {
  const { SocketBackend } = await import('./backends/socket.js');
  switch (action) {
    case 'run': {
      const { runDaemon } = await import('./daemon.js');
      await runDaemon(cfg.backendUri);
      return 0;
    }
    case 'status': {
      const client = await SocketBackend.connect(cfg.backendUri);
      if (!client) {
        if (cfg.json) emit({ running: false, uri: cfg.backendUri });
        else process.stdout.write(`no daemon for ${cfg.backendUri}\n`);
        return 2;
      }
      const info = await client.info();
      await client.close();
      if (cfg.json) emit({ running: true, ...info });
      else
        process.stdout.write(
          `daemon pid ${info.pid} serving ${info.uri} (poll ${info.pollMs}ms, claim ${info.claimable ? 'yes' : 'no'})\n`,
        );
      return 0;
    }
    case 'stop': {
      const client = await SocketBackend.connect(cfg.backendUri);
      if (!client) {
        process.stdout.write(`no daemon for ${cfg.backendUri}\n`);
        return 2;
      }
      await client.stop();
      await client.close();
      process.stdout.write('daemon stopped\n');
      return 0;
    }
    default:
      fail('usage: agentcomm daemon run|status|stop [--backend <uri>]');
      return 1;
  }
}

function cmdDescribe(cfg: ResolvedConfig): number {
  const scheme = schemeForUri(cfg.backendUri);
  const info = backendInfo(scheme); // throws the known-schemes error for unregistered schemes

  if (cfg.json) {
    emit({ uri: cfg.backendUri, scheme, info: info ?? null, security: CHANNEL_SECURITY_NOTE });
    return 0;
  }
  if (!info) {
    process.stdout.write(
      `scheme "${scheme}" is registered but published no description — consult the plugin's own docs.\n`,
    );
    return 0;
  }
  const cap = (on: boolean, yes: string, no: string) => (on ? `yes — ${yes}` : `no — ${no}`);
  process.stdout.write(
    [
      `backend    ${cfg.backendUri}`,
      `scheme     ${scheme} (${info.kind})`,
      `claim      ${cap(info.capabilities.claim, 'atomic shared-queue dequeue', 'give each consumer its own inbox')}`,
      `push wait  ${cap(info.capabilities.push, 'wait resolves on arrival', 'wait polls')}`,
      `channel    ${info.channel.rule}`,
      `           template: ${info.channel.template}`,
      `           example:  ${info.channel.example}`,
      ...(info.notes ?? []).map((n, i) => `${i === 0 ? 'notes      ' : '           '}- ${n}`),
      `security   ${CHANNEL_SECURITY_NOTE}`,
      '',
    ].join('\n'),
  );
  return 0;
}

async function cmdChannels(backend: Awaited<ReturnType<typeof createBackend>>, cfg: ResolvedConfig): Promise<number> {
  const found = await discoverChannels(backend);
  const scheme = schemeForUri(cfg.backendUri);
  // Path-carved schemes append the prefix; param-carved schemes (SQL + git+)
  // address carved channels via ?channel=<name> (keys under channels/<name>/).
  const sqlScheme =
    scheme === 'sqlite' || scheme === 'postgres' || scheme === 'postgresql' || scheme.startsWith('git+');
  const sqlChannelUri = (prefix: string): string | null => {
    const m = /^channels\/([^/]+)$/.exec(prefix);
    if (!m) return null; // manually nested beyond the ?channel= convention
    return `${cfg.backendUri}${cfg.backendUri.includes('?') ? '&' : '?'}channel=${m[1]}`;
  };
  const rows = found.map(({ prefix, agents }) => ({
    prefix,
    agents,
    uri:
      prefix === ''
        ? cfg.backendUri
        : sqlScheme
          ? sqlChannelUri(prefix)
          : `${cfg.backendUri.replace(/\/+$/, '')}/${prefix}`,
  }));

  if (cfg.json) {
    emit(rows);
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write('no channels found (no agentcomm layout under this URI)\n');
    return 0;
  }
  process.stdout.write(`channels on ${cfg.backendUri} (${rows.length})\n`);
  for (const r of rows) {
    const label = r.uri ?? `<prefix: ${r.prefix}> — not addressable on this backend yet`;
    process.stdout.write(`  ${label}  — ${r.agents} agent${r.agents === 1 ? '' : 's'}\n`);
  }
  return 0;
}

async function cmdPurge(
  backend: Awaited<ReturnType<typeof createBackend>>,
  cfg: ResolvedConfig,
  olderThan: string | undefined,
  agentsOlderThan: string | undefined,
  eventsOlderThan: string | undefined,
  dryRun: boolean,
): Promise<number> {
  // Registrations are append-forever (issue #100): presence is heartbeat-
  // derived, so an idle agent is already "not on the bus" without deleting
  // anything — and telemetry events reference registrations by agent/session,
  // so deleting them orphans history. Nothing internal can know which
  // records are still needed; registration lifecycle is not agentcomm's job.
  if (agentsOlderThan) {
    fail(
      'registrations are never purged: presence is heartbeat-derived (idle = not on the bus), and telemetry events reference registrations. --agents-older-than was removed.',
    );
  }

  // Telemetry retention is opt-in: an explicit --events wins; otherwise the
  // repo config's telemetry.retention (when set to a duration) applies.
  let effectiveEvents = eventsOlderThan;
  if (!effectiveEvents) {
    const retention = (await loadConventions().catch(() => null))?.telemetry?.retention;
    if (retention && retention !== 'none') {
      effectiveEvents = retention;
      process.stderr.write(`agentcomm: applying telemetry.retention ${retention} from the config file\n`);
    }
  }

  if (!olderThan && !effectiveEvents) {
    fail(
      'purge requires --older-than <duration> (mail archive) and/or --events <duration> (telemetry events; telemetry.retention in the config also applies), e.g. --older-than 30d (units: s, m, h, d)',
    );
    return 1;
  }

  // Pending inbox/ messages are undelivered mail — never purged. The archive
  // and event batches age by their keys' monotonic ms-timestamp prefix (no
  // content reads). A batch's key time is its flush time, ≥ every capture
  // time inside it, so aging whole batches is conservative.
  const victims: string[] = [];
  if (olderThan) {
    const maxAgeMs = parseDuration(olderThan);
    if (maxAgeMs === null) {
      fail(`invalid --older-than "${olderThan}" — use <number><unit> with unit s, m, h or d (e.g. 30d, 12h)`);
      return 1;
    }
    const cutoff = Date.now() - maxAgeMs;
    victims.push(
      ...(await backend.list('read/')).filter((key) => {
        const ts = messageTimestamp(key);
        return ts !== null && ts < cutoff;
      }),
    );
  }
  const eventVictims: string[] = [];
  if (effectiveEvents) {
    const maxAgeMs = parseDuration(effectiveEvents);
    if (maxAgeMs === null) {
      fail(`invalid events retention "${effectiveEvents}" — use <number><unit> with unit s, m, h or d`);
      return 1;
    }
    const cutoff = Date.now() - maxAgeMs;
    eventVictims.push(
      ...(await backend.list(EVENTS_PREFIX)).filter((key) => {
        const ts = batchTimestamp(key);
        return ts !== null && ts < cutoff;
      }),
    );
  }

  if (!dryRun) {
    for (const key of [...victims, ...eventVictims]) await backend.delete(key);
  }

  // Growth stays visible even when nothing ages out: report what is kept.
  const keptEventBatches = (await backend.list(EVENTS_PREFIX)).filter((k) => k.endsWith('.json')).length;
  const keptRegistrations = (await backend.list('agents/')).filter((k) => k.endsWith('.json')).length;

  if (cfg.json) {
    emit({
      purged: !dryRun,
      dryRun,
      olderThan: olderThan ?? null,
      eventsOlderThan: effectiveEvents ?? null,
      count: victims.length,
      keys: victims,
      eventCount: eventVictims.length,
      eventKeys: eventVictims,
      kept: { eventBatches: keptEventBatches, registrations: keptRegistrations },
    });
  } else {
    const verb = dryRun ? 'would purge' : 'purged';
    const parts = [];
    if (olderThan) parts.push(`${victims.length} archived message${victims.length === 1 ? '' : 's'} older than ${olderThan}`);
    if (effectiveEvents)
      parts.push(`${eventVictims.length} telemetry event batch${eventVictims.length === 1 ? '' : 'es'} older than ${effectiveEvents}`);
    process.stdout.write(`${verb} ${parts.join(' and ')}\n`);
    process.stdout.write(
      `kept: ${keptEventBatches} event batch${keptEventBatches === 1 ? '' : 'es'}, ${keptRegistrations} registration${keptRegistrations === 1 ? '' : 's'} (registrations are never purged)\n`,
    );
  }
  return 0;
}

/** "45s" | "30m" | "12h" | "30d" → milliseconds, or null when malformed. */
function parseDuration(spec: string): number | null {
  const m = /^(\d+)(s|m|h|d)$/.exec(spec);
  if (!m) return null;
  const n = Number(m[1]);
  return n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2] as 's' | 'm' | 'h' | 'd'];
}

/** ms timestamp from an archive key's zero-padded seq prefix, or null. */
function messageTimestamp(key: string): number | null {
  const file = key.slice(key.lastIndexOf('/') + 1);
  const m = /^0*(\d+)-/.exec(file);
  return m ? Number(m[1]) : null;
}

async function cmdConventions(cfg: ResolvedConfig): Promise<number> {
  const { conventions, backend, source } = await loadConventions();
  if (cfg.json) {
    emit({ source, backend: backend ?? null, conventions });
    return 0;
  }
  process.stdout.write(
    [
      `source     ${source ?? 'built-in defaults (override with .agentcomm.json or .agentcomm.yaml)'}`,
      ...(backend ? [`backend    ${backend} (project default from config file)`] : []),
      `lobby      ${conventions.lobby} — register there, announce which topic channels you're joining`,
      `topics     ${conventions.topicStyle} — "work on x" ⇒ channel x in that style`,
      `artifacts  issue → ${conventions.artifactChannels.issue}, pr → ${conventions.artifactChannels.pr}`,
      `subjects   ${conventions.subjects.join(', ')}`,
      '',
    ].join('\n'),
  );
  return 0;
}

async function cmdLog(
  backend: Awaited<ReturnType<typeof createBackend>>,
  cfg: ResolvedConfig,
  thread: string | undefined,
  limit = 50,
): Promise<number> {
  // The conversation = pending inbox mail + the read/ archive, across ALL
  // recipients, in send order. Timestamps come from the keys' seq prefix, so
  // sorting and --limit slicing happen BEFORE any message body is fetched —
  // a catch-up read costs O(limit) gets, not O(history).
  const entries: { key: string; state: 'pending' | 'archived'; ts: number }[] = [];
  for (const [prefix, state] of [
    ['inbox/', 'pending'],
    ['read/', 'archived'],
  ] as const) {
    for (const key of await backend.list(prefix)) {
      if (!key.endsWith('.json')) continue;
      const ts = messageTimestamp(key);
      if (ts !== null) entries.push({ key, state, ts });
    }
  }
  entries.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));

  const out: (Message & { state: 'pending' | 'archived' })[] = [];
  // Over-fetch only when filtering by thread (we can't know a message's
  // thread from its key); otherwise slice strictly to the limit.
  const candidates = thread ? entries : entries.slice(-Math.max(0, limit));
  for (const { key, state } of candidates) {
    try {
      const msg = JSON.parse((await backend.get(key)).toString('utf8')) as Message;
      if (thread && msg.thread !== thread) continue;
      out.push({ ...msg, state });
    } catch {
      continue;
    }
  }
  const shown = out.slice(-Math.max(0, limit));

  if (cfg.json) {
    emit(shown);
    return 0;
  }
  if (shown.length === 0) {
    process.stdout.write(thread ? `(no messages on thread ${thread})\n` : '(no messages on this channel)\n');
    return 0;
  }
  for (const m of shown) {
    const subj = m.subject ? ` [${m.subject}]` : '';
    const thr = m.thread ? ` (thread ${m.thread})` : '';
    process.stdout.write(`${m.state === 'pending' ? '●' : '○'} ${m.ts}  ${m.from} → ${m.to}${subj}${thr}\n`);
    process.stdout.write(`  ${m.body.split('\n').join('\n  ')}\n`);
  }
  process.stdout.write(`— ${shown.length} message${shown.length === 1 ? '' : 's'} (● pending, ○ archived)\n`);
  return 0;
}

const AGENT_INSTRUCTIONS_MARKER = '<!-- agentcomm -->';
const AGENT_INSTRUCTIONS_SNIPPET = `${AGENT_INSTRUCTIONS_MARKER}
## Agent coordination (agentcomm)

This repo has a message bus for AI agents. When working here:

- At session start: \`agentcomm register\` — the default alias is
  \`<git-user>-<session-id>\`, a mailbox unique to THIS session (concurrent
  runners never share one; inbox reads consume, so a shared address means
  stolen mail). If others must address you by name — reviewer, worker-1 —
  register that role with \`--as\` and keep it stable.
- Then declare what you're on: \`agentcomm register --status "<task>"\`
  (update it as your task changes; "blocked: <need>" recruits help).
- Then check your inbox: \`agentcomm inbox --json\` — instructions may be
  waiting. Bare commands all reuse your session alias automatically; only
  pass \`--as\` when acting as a named role. The bus is auto-detected from
  this repo; \`agentcomm describe\` explains it, \`agentcomm conventions\`
  has the rules.
- See who else is here and what they're doing: \`agentcomm network\`
  (active/idle agents, their statuses, recent activity). In Claude Code the
  \`/agentcomm:network\` command shows the same board.
- Coordinate with other agents via \`send\`/\`wait\` (subjects: task, ack,
  done, question, status; reply on the sender's --thread).
- Always check your inbox before reporting work done.
- Stuck? Declare it: \`agentcomm register --status "blocked: <what you
  need>"\` — other agents' digests will recruit help. If a digest shows
  someone else blocked and you KNOW the answer, send it without asking
  the user; otherwise stay on your task.
- If your harness has subagents, prefer a background listener subagent for
  \`wait\`/inbox management (one actor per mailbox — it owns the alias or
  uses \`--as <you>-bus\`); keep quick sends inline.
`;

async function cmdInit(bus: Bus, cfg: ResolvedConfig, requestedHarness?: string): Promise<number> {
  const harness = requestedHarness ?? 'claude';
  // Claude Code reads CLAUDE.md; everyone else (Codex, OpenCode, and any harness
  // that honors the AGENTS.md standard) reads AGENTS.md. `agents` is the neutral
  // alias for that file, so no harness has to init "as" another one.
  const HARNESS_FILE: Record<string, string> = {
    claude: 'CLAUDE.md',
    codex: 'AGENTS.md',
    opencode: 'AGENTS.md',
    agents: 'AGENTS.md',
  };
  const guidanceFile = HARNESS_FILE[harness];
  if (!guidanceFile) {
    throw new Error(
      `agentcomm: --harness must be one of ${Object.keys(HARNESS_FILE).join(', ')} (received ${harness})`,
    );
  }
  const harnessLabel =
    harness === 'claude' ? 'Claude Code' : harness === 'opencode' ? 'OpenCode' : harness === 'codex' ? 'Codex' : 'AGENTS.md';

  // One-command team activation: write instructions for the selected harness,
  // register the caller, and prove the bus works.
  const { promises: fsp } = await import('node:fs');
  const os = await import('node:os');
  type InstructionState = 'created' | 'appended' | 'already-present';
  const writeInstructions = async (filename: string): Promise<InstructionState> => {
    let existing = '';
    try {
      existing = await fsp.readFile(filename, 'utf8');
    } catch {
      /* no file yet */
    }
    if (existing.includes(AGENT_INSTRUCTIONS_MARKER)) return 'already-present';
    const state = existing ? 'appended' : 'created';
    const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
    await fsp.writeFile(filename, existing + sep + AGENT_INSTRUCTIONS_SNIPPET);
    return state;
  };
  const guidanceState = await writeInstructions(guidanceFile);

  const me = await resolveAgent(cfg);
  await registerWithCollisionCheck(bus, me);
  const roster = await bus.agents();

  if (cfg.json) {
    emit({
      backend: cfg.backendUri,
      registered: me,
      agents: roster.map((a) => a.name),
      harness,
      guidanceFile,
      guidance: guidanceState,
      claudeMd: guidanceFile === 'CLAUDE.md' ? guidanceState : 'not-selected',
      agentsMd: guidanceFile === 'AGENTS.md' ? guidanceState : 'not-selected',
    });
    return 0;
  }
  process.stdout.write(
    [
      `on the bus: ${cfg.backendUri}`,
      `registered ${me} — ${roster.length} agent${roster.length === 1 ? '' : 's'} here: ${roster.map((a) => a.name).join(', ')}`,
      `agent guidance: ${guidanceFile} ${guidanceState}.`,
      `Commit ${guidanceFile} and every ${harnessLabel} teammate joins this bus automatically.`,
      '',
    ].join('\n'),
  );
  return 0;
}

/**
 * version — the installed version, plus a live comparison against the latest
 * GitHub release (the release artifact IS the distribution, so "latest
 * release" == "latest version"). Explicit ask → no day-throttle cache, just a
 * short network cap; offline it still prints the installed version.
 */
async function cmdVersion(cfg: ResolvedConfig): Promise<number> {
  const { ownVersion, fetchLatestTag, compareVersions } = await import('./update-check.js');
  const mine = ownVersion();
  const latest = (await fetchLatestTag(3000))?.replace(/^v/, '') ?? null;
  const behind = mine !== null && latest !== null && compareVersions(latest, mine) > 0;
  const install = behind
    ? `npm install -g https://github.com/yonidavidson/agentcomm/releases/download/v${latest}/agentcomm-${latest}.tgz`
    : undefined;
  if (cfg.json) {
    emit({
      version: mine ?? 'unknown',
      latest,
      upToDate: mine !== null && latest !== null ? !behind : null,
      ...(install ? { install } : {}),
    });
    return 0;
  }
  const v = mine ?? 'unknown';
  if (latest === null) {
    process.stdout.write(`agentcomm ${v} (could not reach GitHub to check the latest release)\n`);
  } else if (behind) {
    process.stdout.write(
      [
        `agentcomm ${v} — update available: v${latest}`,
        'Upgrade the global install:',
        `  ${install}`,
        '(Claude Code plugin users: /plugin update agentcomm instead)',
        '',
      ].join('\n'),
    );
  } else {
    process.stdout.write(`agentcomm ${v} (latest)\n`);
  }
  return 0;
}

const OPENCODE_HOOKS_FILE = '.opencode/plugin/agentcomm.ts';
/**
 * The generated OpenCode hooks: a minimal local plugin that shells out to the
 * globally installed CLI (npm install -g <release .tgz>). Deliberately the
 * simple sibling of the full in-process plugin (src/opencode-plugin.ts) —
 * readable, editable, zero library imports.
 */
const OPENCODE_HOOKS_TEMPLATE = `// Generated by \`agentcomm hooks --harness opencode\` — commit it so every
// OpenCode session in this repo joins the bus. Safe to edit; regenerating
// never overwrites an existing file.
//
// Drives the globally installed agentcomm CLI
// (npm install -g <the .tgz on https://github.com/yonidavidson/agentcomm/releases>).
// Every hook fails open: a broken bus never wedges the session.
import type { Plugin } from '@opencode-ai/plugin';

export const AgentcommHooks: Plugin = async ({ directory, client, $ }) => {
  const sh = $.cwd(directory).nothrow();

  // Session start: register on the repo bus (auto-detected from the git
  // remote) under a session-unique alias.
  await sh\`agentcomm register --status "opencode session"\`.quiet();

  return {
    // OpenCode's session.idle can't block, so the inbox guard degrades to a
    // nudge: unread mail re-prompts the session instead of holding it open.
    async event({ event }) {
      if (event.type !== 'session.idle') return;
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID;
      if (!sessionID) return;
      const peek = await sh\`agentcomm peek --json\`.quiet();
      let unread: unknown[] = [];
      try {
        unread = JSON.parse(peek.text() || '[]');
      } catch {
        return; // off the bus, or the CLI is missing — fail open
      }
      if (!Array.isArray(unread) || unread.length === 0) return;
      await client.session
        .prompt({
          path: { id: sessionID },
          body: {
            parts: [
              {
                type: 'text',
                text: \`agentcomm: \${unread.length} unread message(s) — run "agentcomm inbox --json", handle them, then continue.\`,
              },
            ],
          },
        })
        .catch(() => {});
    },
  };
};

export default AgentcommHooks;
`;

/**
 * hooks — generate the wiring that connects a harness's lifecycle to the
 * globally installed CLI. Claude Code and Codex ship full marketplace plugins,
 * so for them this prints the install instead of duplicating it as files.
 */
async function cmdHooks(cfg: ResolvedConfig, requestedHarness?: string): Promise<number> {
  const MARKETPLACE_POINTERS: Record<string, string[]> = {
    claude: [
      'Claude Code has a full plugin — install it from the marketplace instead of wiring hooks by hand:',
      '  /plugin marketplace add yonidavidson/agentcomm',
      '  /plugin install agentcomm@yonidavidson-plugins',
    ],
    codex: [
      'Codex has a full plugin — install it from the marketplace instead of wiring hooks by hand:',
      '  codex plugin marketplace add yonidavidson/agentcomm',
      '  codex plugin add agentcomm@yonidavidson-plugins',
      'Review and trust its hooks with /hooks, then start a new thread.',
    ],
  };
  const harness = requestedHarness;
  if (!harness) {
    fail('hooks requires --harness <claude|codex|opencode>');
  }
  const pointer = MARKETPLACE_POINTERS[harness];
  if (pointer) {
    if (cfg.json) emit({ harness, hooks: 'marketplace-plugin', install: pointer.slice(1).map((l) => l.trim()) });
    else process.stdout.write(pointer.join('\n') + '\n');
    return 0;
  }
  if (harness !== 'opencode') {
    fail(`hooks: --harness must be one of claude, codex, opencode (received ${harness})`);
  }

  const { promises: fsp } = await import('node:fs');
  const path = await import('node:path');
  let state: 'created' | 'already-present' = 'created';
  try {
    await fsp.access(OPENCODE_HOOKS_FILE);
    state = 'already-present'; // the user may have edited it — never clobber
  } catch {
    await fsp.mkdir(path.dirname(OPENCODE_HOOKS_FILE), { recursive: true });
    await fsp.writeFile(OPENCODE_HOOKS_FILE, OPENCODE_HOOKS_TEMPLATE);
  }
  if (cfg.json) {
    emit({ harness, file: OPENCODE_HOOKS_FILE, hooks: state });
    return 0;
  }
  process.stdout.write(
    state === 'created'
      ? [
          `hooks: ${OPENCODE_HOOKS_FILE} created.`,
          'It shells out to the global CLI — make sure it is installed:',
          '  npm install -g <the agentcomm-X.Y.Z.tgz on https://github.com/yonidavidson/agentcomm/releases>',
          `Commit ${OPENCODE_HOOKS_FILE} and every OpenCode session in this repo joins the bus.`,
          '',
        ].join('\n')
      : `hooks: ${OPENCODE_HOOKS_FILE} already present — left untouched (delete it to regenerate).\n`,
  );
  return 0;
}

/** register + collision alarm: fresh lastSeen under a DIFFERENT session = two live processes on one consuming mailbox. */
async function registerWithCollisionCheck(bus: Bus, me: string, status?: string, statusAuto?: boolean) {
  const session = await sessionHash();
  const record = await bus.register(me, session, status, statusAuto);
  const prev = record.previous;
  if (prev && prev.session !== session && Date.now() - Date.parse(prev.lastSeen) < 10 * 60 * 1000) {
    process.stderr.write(
      `agentcomm: WARNING — alias "${me}" was active ${Math.round((Date.now() - Date.parse(prev.lastSeen)) / 60000)}m ago from a DIFFERENT session. ` +
        'Two live processes sharing a mailbox consume each other\'s messages; if that agent is still running, re-register with a distinct --as.\n',
    );
  }
  return record;
}

async function cmdRegister(
  bus: Bus,
  cfg: ResolvedConfig,
  status?: string,
  statusAuto?: boolean,
): Promise<number> {
  const me = await resolveAgent(cfg);
  const record = await registerWithCollisionCheck(bus, me, status, statusAuto);
  if (cfg.json) emit(record);
  else process.stdout.write(`registered ${record.name}\n`);
  return 0;
}

async function cmdAgents(bus: Bus, cfg: ResolvedConfig): Promise<number> {
  const list = await bus.agents();
  const mySession = await sessionHash();
  const isActive = (a: { lastSeen: string }) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000;
  if (cfg.json) {
    emit(list.map((a) => ({ ...a, thisSession: a.session === mySession, active: isActive(a) })));
  } else if (list.length === 0) {
    process.stdout.write('(no agents registered)\n');
  } else {
    for (const a of list) {
      const mine = a.session === mySession ? '  (this session)' : '';
      const live = isActive(a) ? '  · active' : '';
      const doing = a.status ? `  — ${a.status}` : '';
      process.stdout.write(`${a.name}\tlast seen ${a.lastSeen}${live}${mine}${doing}\n`);
    }
  }
  return 0;
}

/** Compact relative time from an ISO timestamp, for the board. */
function relTime(iso: string): string {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m)) return '';
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/**
 * The situation report: who is on the bus and what they are doing, in one
 * glance. Active agents (seen < 10m) first with their status, idle below,
 * plus the last few messages. Cross-harness — the same view backs the Claude
 * Code and Codex `network` commands and a plain `agentcomm network` in a
 * terminal.
 */
async function cmdNetwork(
  bus: Bus,
  backend: Awaited<ReturnType<typeof createBackend>>,
  cfg: ResolvedConfig,
): Promise<number> {
  const list = await bus.agents();
  const mySession = await sessionHash();
  const isActive = (a: { lastSeen: string }) => Date.now() - Date.parse(a.lastSeen) < 10 * 60_000;
  const active = list.filter(isActive).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const idle = list.filter((a) => !isActive(a)).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  const recent = await recentMessages(backend, 5);

  if (cfg.json) {
    emit({
      bus: cfg.backendUri,
      active: active.map((a) => ({ ...a, thisSession: a.session === mySession, active: true })),
      idle: idle.map((a) => ({ ...a, thisSession: a.session === mySession, active: false })),
      recent,
    });
    return 0;
  }

  const line = (a: (typeof list)[number]): string => {
    const mine = a.session === mySession ? ' (you)' : '';
    const doing = a.status ? a.status : '—';
    return `  ${(a.name + mine).padEnd(24)} ${doing.padEnd(42).slice(0, 42)} ${relTime(a.lastSeen)}`;
  };

  process.stdout.write(`bus  ${cfg.backendUri}\n\n`);
  if (list.length === 0) {
    process.stdout.write('(no agents on the bus yet)\n');
    return 0;
  }
  if (active.length) {
    process.stdout.write(`active (${active.length})\n${active.map(line).join('\n')}\n\n`);
  }
  if (idle.length) {
    process.stdout.write(`idle (${idle.length})\n${idle.map(line).join('\n')}\n\n`);
  }
  if (recent.length) {
    process.stdout.write('recent\n');
    for (const m of recent) {
      const subj = m.subject ? ` [${m.subject}]` : '';
      const body = m.body.length > 48 ? `${m.body.slice(0, 47)}…` : m.body;
      process.stdout.write(`  ${(`${m.from} → ${m.to}${subj}`).padEnd(32)} "${body}" ${relTime(m.ts)}\n`);
    }
  }
  return 0;
}

/** Most-recent N messages across the channel (pending + archived), oldest→newest. */
async function recentMessages(
  backend: Awaited<ReturnType<typeof createBackend>>,
  limit: number,
): Promise<Message[]> {
  const entries: { key: string; ts: number }[] = [];
  for (const prefix of ['inbox/', 'read/']) {
    for (const key of await backend.list(prefix)) {
      if (!key.endsWith('.json')) continue;
      const ts = messageTimestamp(key);
      if (ts !== null) entries.push({ key, ts });
    }
  }
  entries.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
  const out: Message[] = [];
  for (const { key } of entries.slice(-Math.max(0, limit))) {
    try {
      out.push(JSON.parse((await backend.get(key)).toString('utf8')) as Message);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

async function cmdSend(
  bus: Bus,
  cfg: ResolvedConfig,
  subject: string | undefined,
  thread: string | undefined,
  rest: string[],
): Promise<number> {
  const me = await resolveAgent(cfg);
  const to = rest[0];
  if (!to) {
    fail('send requires a recipient: agentcomm send <to> [body]');
    return 1;
  }
  const body = rest.length > 1 ? rest.slice(1).join(' ') : await readStdin();
  const msg = await bus.send({ from: me, to, body, subject, thread });
  if (cfg.json) emit(msg);
  else process.stdout.write(`sent ${msg.id} → ${to}\n`);
  return 0;
}

async function cmdBroadcast(
  bus: Bus,
  cfg: ResolvedConfig,
  subject: string | undefined,
  thread: string | undefined,
  rest: string[],
): Promise<number> {
  const me = await resolveAgent(cfg);
  const body = rest.length > 0 ? rest.join(' ') : await readStdin();
  const sent = await bus.broadcast({ from: me, body, subject, thread });
  if (cfg.json) emit(sent);
  else process.stdout.write(`broadcast to ${sent.length} agent(s)\n`);
  return 0;
}

async function cmdInbox(bus: Bus, cfg: ResolvedConfig): Promise<number> {
  const me = await resolveAgent(cfg);
  const messages = await bus.inbox(me);
  printMessages(messages, cfg);
  return 0;
}

async function cmdPeek(bus: Bus, cfg: ResolvedConfig): Promise<number> {
  const me = await resolveAgent(cfg);
  const messages = await bus.peek(me);
  printMessages(messages, cfg);
  return 0;
}

async function cmdWait(bus: Bus, cfg: ResolvedConfig, timeoutMs: number): Promise<number> {
  const me = await resolveAgent(cfg);
  const messages = await bus.wait(me, timeoutMs);
  if (messages.length === 0) {
    if (cfg.json) emit([]);
    else process.stderr.write(`wait: timed out after ${timeoutMs}ms\n`);
    return 2; // timeout
  }
  printMessages(messages, cfg);
  return 0; // delivered
}

async function cmdClaim(bus: Bus, cfg: ResolvedConfig, queue: string | undefined): Promise<number> {
  const me = await resolveAgent(cfg);
  if (!queue) {
    fail('claim requires --queue <name>');
  }
  const msg = await bus.claim(queue, me);
  if (cfg.json) {
    emit(msg);
  } else if (!msg) {
    process.stdout.write('(queue empty)\n');
  } else {
    const subj = msg.subject ? ` [${msg.subject}]` : '';
    process.stdout.write(`claimed ${msg.id} from ${msg.from}${subj}\n  ${msg.body}\n`);
  }
  return 0;
}

// ── telemetry (issue #100) ─────────────────────────────────────────────────

/**
 * Record a telemetry event. Capture is LOCAL — append to the tmpdir spool
 * and return; the batch rides the next bus write (see piggybackFlush), or
 * --flush ships it immediately. Gated on the repo config's `telemetry`
 * section: without that opt-in the command is an announced no-op, so agents
 * can be instructed to emit unconditionally and only opted-in repos collect.
 */
async function cmdEmit(cfg: ResolvedConfig, flags: ParsedFlags): Promise<number> {
  const { telemetry } = await loadConventions().catch(() => ({ telemetry: undefined }));
  if (!telemetry) {
    if (cfg.json) emit({ spooled: false, reason: 'telemetry-not-enabled' });
    else
      process.stderr.write(
        'agentcomm: telemetry is not enabled for this repo — event dropped. Opt in with a "telemetry" section in .agentcomm.json/.yaml.\n',
      );
    return 0;
  }
  if (!flags.type) {
    fail('emit requires --type <event-type>, e.g. emit --type skill-outcome --name my-skill --attrs \'{"found_bugs":true}\'');
  }
  let attrs: Record<string, unknown> | undefined;
  if (flags.attrs !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.attrs);
    } catch (err) {
      fail(`invalid --attrs JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      fail('--attrs must be a JSON object, e.g. --attrs \'{"found_bugs":true,"findings":3}\'');
    }
    attrs = parsed as Record<string, unknown>;
  }
  const me = await resolveAgent(cfg);
  const event = materializeEvent({
    agent: me,
    session: await sessionHash(),
    type: flags.type!,
    name: flags.name,
    ref: flags.ref,
    attrs,
  });
  if (!(await spoolEvents(cfg.backendUri, me, [event]))) {
    fail('could not write the local event spool');
  }
  if (flags.flush) {
    const backend = await resolveTransport(cfg, flags);
    try {
      const shipped = await flushEvents(backend, cfg.backendUri, me);
      if (cfg.json) emit({ spooled: true, flushed: shipped, event });
      else process.stdout.write(`emitted ${event.type} — shipped ${shipped} event(s)\n`);
    } finally {
      await backend.close?.();
    }
    return 0;
  }
  if (cfg.json) emit({ spooled: true, flushed: 0, event });
  else process.stdout.write(`spooled ${event.type} — ships with the next bus write (or \`emit --flush\`)\n`);
  return 0;
}

/** Read telemetry events — the analysis surface is `events --json` piped into whoever asks the question. */
async function cmdEvents(backend: Backend, cfg: ResolvedConfig, flags: ParsedFlags): Promise<number> {
  let sinceMs: number | undefined;
  if (flags.since) {
    const d = parseDuration(flags.since);
    if (d === null) {
      fail(`invalid --since "${flags.since}" — use <number><unit> with unit s, m, h or d (e.g. 30d, 12h)`);
    }
    sinceMs = Date.now() - d!;
  }
  const all = await listEvents(backend, { type: flags.type, name: flags.name, ref: flags.ref, sinceMs });
  const limit = flags.limit ?? 200;
  const shown = all.slice(-Math.max(0, limit));
  if (cfg.json) {
    emit(shown);
    return 0;
  }
  if (shown.length === 0) {
    process.stdout.write('(no events)\n');
    return 0;
  }
  for (const e of shown) {
    const bits = [
      e.type + (e.name ? `(${e.name})` : ''),
      e.ref ? `ref=${e.ref}` : null,
      `by ${e.agent}`,
      e.attrs ? JSON.stringify(e.attrs) : null,
    ].filter(Boolean);
    process.stdout.write(`${e.ts}  ${bits.join('  ')}\n`);
  }
  process.stdout.write(
    `— ${shown.length} event(s)${all.length > shown.length ? ` (of ${all.length}; raise --limit for more)` : ''}\n`,
  );
  return 0;
}

/**
 * Telemetry batches ride bus writes the CLI already makes (register, send,
 * broadcast) — same write cadence as before, just fatter payloads. Strictly
 * fail-open: a telemetry hiccup must never fail the primary write, and on a
 * failed put the events go back on the spool for the next ride.
 */
async function piggybackFlush(backend: Backend, cfg: ResolvedConfig): Promise<void> {
  try {
    const me = await resolveAgent(cfg);
    if ((await spoolDepth(cfg.backendUri)) === 0) return;
    const shipped = await flushEvents(backend, cfg.backendUri, me);
    if (shipped > 0) process.stderr.write(`agentcomm: shipped ${shipped} spooled telemetry event(s) with this write\n`);
  } catch {
    /* fail open — events stay spooled */
  }
}

/**
 * Import every module listed in AGENTCOMM_BACKEND_PLUGINS so its
 * registerBackend() side effect runs before --backend is resolved.
 */
async function loadBackendPlugins(): Promise<void> {
  const spec = process.env.AGENTCOMM_BACKEND_PLUGINS;
  if (!spec) return;
  for (const mod of spec.split(/[,\s]+/).filter(Boolean)) {
    try {
      await import(mod);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`agentcomm: failed to load backend plugin "${mod}": ${reason}`);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function printMessages(messages: Message[], cfg: ResolvedConfig): void {
  if (cfg.json) {
    emit(messages);
    return;
  }
  if (messages.length === 0) {
    process.stdout.write('(no messages)\n');
    return;
  }
  for (const m of messages) {
    const subj = m.subject ? ` [${m.subject}]` : '';
    const thr = m.thread ? ` (thread ${m.thread})` : '';
    process.stdout.write(`from ${m.from} at ${m.ts}${subj}${thr}\n  ${m.body}\n`);
  }
}

let derivedIdentity: string | null | undefined; // memo: undefined = not derived yet

/**
 * The acting name is an ALIAS — addressing, not authentication (on git
 * backends the commit author in `git log` is the verifiable identity).
 * Explicit --as / AGENTCOMM_AGENT wins; otherwise derive an honest default:
 * the git identity's email local-part, then the OS username. Announced on
 * stderr the first time it's used.
 */
async function resolveAgent(cfg: ResolvedConfig): Promise<string> {
  if (cfg.agent) return cfg.agent;
  if (derivedIdentity === undefined) {
    const { name, source } = await deriveIdentity();
    derivedIdentity = name;
    if (derivedIdentity) {
      process.stderr.write(
        `agentcomm: acting as ${derivedIdentity} (${source} + session; --as or AGENTCOMM_AGENT overrides)\n`,
      );
    }
  }
  if (!derivedIdentity) {
    fail('no acting agent. Pass --as <name> or set AGENTCOMM_AGENT.');
  }
  return derivedIdentity!;
}

function emit(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(message: string): never {
  process.stderr.write(`agentcomm: ${message}\n`);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  // Strip only the trailing newline a shell pipe appends — leading whitespace
  // is content (preformatted bodies like ASCII art must arrive intact).
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    // Errors raised by Bus/backends are already prefixed; don't double it.
    process.stderr.write(`${message.startsWith('agentcomm: ') ? '' : 'agentcomm: '}${message}\n`);
    process.exitCode = 1;
  });
