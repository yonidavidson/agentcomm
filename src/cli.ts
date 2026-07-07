#!/usr/bin/env node
import { backendInfo, createBackend, schemeForUri } from './backends/index.js';
import { detectRepoBus } from './backends/autodetect.js';
import { discoverChannels } from './channels.js';
import { loadConventions } from './conventions.js';
import { Bus } from './bus.js';
import { parseArgs, resolveConfig, type ResolvedConfig } from './config.js';
import type { Backend, Message } from './types.js';
import { fileURLToPath } from 'node:url';

const USAGE = `agentcomm — a tiny mailbox/message bus for AI agents

Usage:
  agentcomm <command> [args] [flags]

Commands:
  init                     Put this repo on the bus: writes agent instructions
                           into CLAUDE.md (idempotent), registers you, shows the
                           roster. Commit CLAUDE.md to onboard your whole team
  register                 Register/heartbeat the calling agent (--as)
  agents                   List registered agents
  send <to> [body]         Send a message (body from arg or stdin)
  broadcast [body]         Send to every registered agent except yourself
  inbox                    Consume undelivered messages (archived under read/)
  peek                     Show undelivered messages without consuming
  wait                     Block until a message arrives (exit 0) or timeout (exit 2)
  claim                    Atomically dequeue one message from --queue (SQL backends only)
  describe                 Explain the --backend scheme: how to carve channels,
                           and its capabilities — static, never connects
  channels                 List the channels that already exist on the --backend
                           store (scans for the agentcomm key layout)
  purge                    Delete archived (read/) messages older than
                           --older-than and/or registrations idle past
                           --agents-older-than; --dry-run to preview. The
                           daemon runs both automatically (30d/7d defaults)
  log                      Read a channel's conversation (pending + archived,
                           time-ordered, non-consuming); --thread, --limit
  conventions              Print the effective team conventions (built-in
                           defaults ⊕ .agentcomm.json/.yaml override file)
  daemon run|status|stop   The bus daemon: a background poller serving this
                           bus over a local socket, so every command answers
                           immediately. Network schemes (git+ssh://, github://)
                           use it automatically

Flags:
  --backend <uri>          git+ssh:// | github:// | file:// | sqlite:// |
                           s3:// | gs:// | postgres:// | bare path. Default:
                           --backend > AGENTCOMM_BACKEND > .agentcomm config >
                           git+<origin> (probed inside a git repo — any host) >
                           github:// (token fallback) > file://./.agentcomm
  --as <name>              Acting agent (env AGENTCOMM_AGENT)
  --subject <text>         Message subject (send/broadcast)
  --thread <id>            Thread id (send/broadcast)
  --timeout <ms>           wait timeout in ms (default 30000)
  --queue <name>           Queue to claim from (claim) — same namespace as a recipient inbox
  --daemon                 Force commands through the bus daemon (autostarts it)
  --direct                 Bypass the daemon for this call
  --sync                   Wait for remote durability on writes (default: the
                           daemon acks from its disk outbox and delivers async)
  --status <text>          register: declare what you're doing — shown on the
                           roster and in other agents' digests; heartbeats
                           keep it until you change it
  --json                   Machine-readable JSON output
  --help                   Show this help

Env:
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
  if (!flags.backend && !process.env.AGENTCOMM_BACKEND) {
    const fromConfig = (await loadConventions().catch(() => null))?.backend;
    if (fromConfig) {
      cfg.backendUri = fromConfig;
      process.stderr.write(`agentcomm: using ${fromConfig} (project default from the .agentcomm config file)\n`);
    } else {
      const detected = await detectRepoBus();
      if (detected) {
        cfg.backendUri = detected;
        process.stderr.write(
          `agentcomm: using ${detected} (auto-detected from the git remote; set AGENTCOMM_BACKEND or --backend to override)\n`,
        );
      }
    }
  }

  // describe and conventions are static by design — they answer "how would I
  // connect / how does this team talk?" before the user *can* connect, so
  // they never load a driver or open the backend. Handle before createBackend().
  if (command === 'describe') return cmdDescribe(cfg);
  if (command === 'conventions') return await cmdConventions(cfg);

  if (command === 'daemon') return await cmdDaemon(cfg, positional[1]);

  const backend = await resolveTransport(cfg, flags);
  const bus = new Bus(backend);
  try {
    switch (command) {
      case 'register':
        return await cmdRegister(bus, cfg, flags.status);
      case 'init':
        return await cmdInit(bus, cfg);
      case 'agents':
        return await cmdAgents(bus, cfg);
      case 'send':
        return await cmdSend(bus, cfg, flags.subject, flags.thread, positional.slice(1));
      case 'broadcast':
        return await cmdBroadcast(bus, cfg, flags.subject, flags.thread, positional.slice(1));
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
        return await cmdPurge(backend, cfg, flags.olderThan, flags.agentsOlderThan, flags.dryRun);
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
  dryRun: boolean,
): Promise<number> {
  if (!olderThan && !agentsOlderThan) {
    fail(
      'purge requires --older-than <duration> (archive) and/or --agents-older-than <duration> (stale registrations), e.g. --older-than 30d (units: s, m, h, d)',
    );
    return 1;
  }

  // Pending inbox/ messages are undelivered mail — never purged. The archive
  // ages by the key's monotonic ms-timestamp prefix (no content reads);
  // registrations age by their lastSeen heartbeat.
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
  const staleAgents: string[] = [];
  if (agentsOlderThan) {
    const maxAgeMs = parseDuration(agentsOlderThan);
    if (maxAgeMs === null) {
      fail(`invalid --agents-older-than "${agentsOlderThan}" — use <number><unit> with unit s, m, h or d`);
      return 1;
    }
    const cutoff = Date.now() - maxAgeMs;
    for (const key of await backend.list('agents/')) {
      try {
        const rec = JSON.parse((await backend.get(key)).toString('utf8')) as { lastSeen?: string };
        if (rec.lastSeen && Date.parse(rec.lastSeen) < cutoff) staleAgents.push(key);
      } catch {
        /* unreadable record: leave it */
      }
    }
  }

  if (!dryRun) {
    for (const key of [...victims, ...staleAgents]) await backend.delete(key);
  }
  if (cfg.json) {
    emit({
      purged: !dryRun,
      dryRun,
      olderThan: olderThan ?? null,
      agentsOlderThan: agentsOlderThan ?? null,
      count: victims.length,
      agentCount: staleAgents.length,
      keys: victims,
      agentKeys: staleAgents,
    });
  } else {
    const verb = dryRun ? 'would purge' : 'purged';
    const parts = [];
    if (olderThan) parts.push(`${victims.length} archived message${victims.length === 1 ? '' : 's'} older than ${olderThan}`);
    if (agentsOlderThan) parts.push(`${staleAgents.length} stale registration${staleAgents.length === 1 ? '' : 's'} older than ${agentsOlderThan}`);
    process.stdout.write(`${verb} ${parts.join(' and ')}\n`);
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

const CLAUDE_MD_MARKER = '<!-- agentcomm -->';
const CLAUDE_MD_SNIPPET = `${CLAUDE_MD_MARKER}
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

async function cmdInit(bus: Bus, cfg: ResolvedConfig): Promise<number> {
  // One-command team activation: write the agent instructions into
  // CLAUDE.md (idempotent — marker-guarded), register the caller, prove the
  // bus works. Committing CLAUDE.md is what onboards every teammate's
  // agents; that's the user's call, so we say it rather than do it.
  const { promises: fsp } = await import('node:fs');
  const os = await import('node:os');
  const claudeMd = 'CLAUDE.md';
  let claudeMdState: 'created' | 'appended' | 'already-present';
  let existing = '';
  try {
    existing = await fsp.readFile(claudeMd, 'utf8');
  } catch {
    /* no file yet */
  }
  if (existing.includes(CLAUDE_MD_MARKER)) {
    claudeMdState = 'already-present';
  } else {
    claudeMdState = existing ? 'appended' : 'created';
    const sep = existing && !existing.endsWith('\n\n') ? (existing.endsWith('\n') ? '\n' : '\n\n') : '';
    await fsp.writeFile(claudeMd, existing + sep + CLAUDE_MD_SNIPPET);
  }

  const me = await resolveAgent(cfg);
  await registerWithCollisionCheck(bus, me);
  const roster = await bus.agents();

  if (cfg.json) {
    emit({
      backend: cfg.backendUri,
      registered: me,
      agents: roster.map((a) => a.name),
      claudeMd: claudeMdState,
    });
    return 0;
  }
  process.stdout.write(
    [
      `on the bus: ${cfg.backendUri}`,
      `registered ${me} — ${roster.length} agent${roster.length === 1 ? '' : 's'} here: ${roster.map((a) => a.name).join(', ')}`,
      claudeMdState === 'already-present'
        ? 'CLAUDE.md already has the agentcomm section.'
        : `CLAUDE.md ${claudeMdState} — commit it and every teammate's AI agent joins this bus automatically.`,
      '',
    ].join('\n'),
  );
  return 0;
}

let sessionHashMemo: string | undefined;

/**
 * A fingerprint of THIS session, stable across the many CLI invocations one
 * agent session makes: AGENTCOMM_SESSION, else the terminal session id, else
 * the harness process (grandparent pid — each command's shell is a child of
 * the long-lived session process). Suffixes derived aliases and is recorded
 * in registrations, so tooling can tell "stale me" from "someone else".
 */
async function sessionHash(): Promise<string> {
  if (sessionHashMemo !== undefined) return sessionHashMemo;
  const { createHash } = await import('node:crypto');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  let session =
    process.env.AGENTCOMM_SESSION ??
    process.env.ITERM_SESSION_ID ??
    process.env.TERM_SESSION_ID ??
    process.env.TMUX_PANE ??
    '';
  if (!session) {
    try {
      session =
        'gppid:' + (await promisify(execFile)('ps', ['-o', 'ppid=', '-p', String(process.ppid)])).stdout.trim();
    } catch {
      session = 'ppid:' + String(process.ppid);
    }
  }
  sessionHashMemo = createHash('sha1').update(session).digest('hex').slice(0, 12);
  return sessionHashMemo;
}

/** register + collision alarm: fresh lastSeen under a DIFFERENT session = two live processes on one consuming mailbox. */
async function registerWithCollisionCheck(bus: Bus, me: string, status?: string) {
  const session = await sessionHash();
  const record = await bus.register(me, session, status);
  const prev = record.previous;
  if (prev && prev.session !== session && Date.now() - Date.parse(prev.lastSeen) < 10 * 60 * 1000) {
    process.stderr.write(
      `agentcomm: WARNING — alias "${me}" was active ${Math.round((Date.now() - Date.parse(prev.lastSeen)) / 60000)}m ago from a DIFFERENT session. ` +
        'Two live processes sharing a mailbox consume each other\'s messages; if that agent is still running, re-register with a distinct --as.\n',
    );
  }
  return record;
}

async function cmdRegister(bus: Bus, cfg: ResolvedConfig, status?: string): Promise<number> {
  const me = await resolveAgent(cfg);
  const record = await registerWithCollisionCheck(bus, me, status);
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
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const os = await import('node:os');
    const sanitize = (raw: string) => raw.replace(/[^A-Za-z0-9._-]/g, '');
    let name = '';
    let source = '';
    try {
      const email = (await promisify(execFile)('git', ['config', 'user.email'])).stdout.trim();
      name = sanitize(email.split('@')[0] ?? '');
      source = 'from git config user.email';
    } catch {
      /* not a repo / no git identity */
    }
    if (!name) {
      name = sanitize(os.userInfo().username);
      source = 'OS username';
    }
    // Session suffix: multiple runners on one machine (several Claude/Cursor
    // sessions, parallel workers) must not share a mailbox — inbox reads
    // consume. The suffix is the session fingerprint (see sessionHash).
    if (name) {
      name = `${name}-${(await sessionHash()).slice(0, 4)}`;
    }
    derivedIdentity = name || null;
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
