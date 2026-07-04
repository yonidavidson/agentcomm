#!/usr/bin/env node
import { backendInfo, createBackend, schemeForUri } from './backends/index.js';
import { detectRepoBus } from './backends/autodetect.js';
import { discoverChannels } from './channels.js';
import { loadConventions } from './conventions.js';
import { Bus } from './bus.js';
import { parseArgs, resolveConfig } from './config.js';
const USAGE = `agentcomm — a tiny mailbox/message bus for AI agents

Usage:
  agentcomm <command> [args] [flags]

Commands:
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
                           --older-than (e.g. 30d, 12h); --dry-run to preview
  log                      Read a channel's conversation (pending + archived,
                           time-ordered, non-consuming); --thread, --limit
  conventions              Print the effective team conventions (built-in
                           defaults ⊕ .agentcomm.json/.yaml override file)

Flags:
  --backend <uri>          file:// | github:// | sqlite:// | s3:// | gs:// |
                           postgres:// | bare path. Default resolution:
                           --backend > AGENTCOMM_BACKEND > .agentcomm config >
                           github://owner/repo (auto-detected inside a git repo
                           with a github origin + token) > file://./.agentcomm
  --as <name>              Acting agent (env AGENTCOMM_AGENT)
  --subject <text>         Message subject (send/broadcast)
  --thread <id>            Thread id (send/broadcast)
  --timeout <ms>           wait timeout in ms (default 30000)
  --queue <name>           Queue to claim from (claim) — same namespace as a recipient inbox
  --json                   Machine-readable JSON output
  --help                   Show this help

Env:
  AGENTCOMM_BACKEND_PLUGINS  comma/whitespace-separated module specifiers to
                             import before resolving --backend, so a
                             third-party package can register a new URI
                             scheme via registerBackend() (see README)

Examples:
  agentcomm register --as alice --backend sqlite:///tmp/bus.db
  agentcomm send bob "ship it" --as alice --backend sqlite:///tmp/bus.db
  agentcomm inbox --as bob --backend sqlite:///tmp/bus.db --json
`;
async function main(argv) {
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
        }
        else {
            const detected = await detectRepoBus();
            if (detected) {
                cfg.backendUri = detected;
                process.stderr.write(`agentcomm: using ${detected} (auto-detected from the git remote; set AGENTCOMM_BACKEND or --backend to override)\n`);
            }
        }
    }
    // describe and conventions are static by design — they answer "how would I
    // connect / how does this team talk?" before the user *can* connect, so
    // they never load a driver or open the backend. Handle before createBackend().
    if (command === 'describe')
        return cmdDescribe(cfg);
    if (command === 'conventions')
        return await cmdConventions(cfg);
    const backend = await createBackend(cfg.backendUri);
    const bus = new Bus(backend);
    try {
        switch (command) {
            case 'register':
                return await cmdRegister(bus, cfg);
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
                return await cmdPurge(backend, cfg, flags.olderThan, flags.dryRun);
            case 'log':
                return await cmdLog(backend, cfg, flags.thread, flags.limit);
            default:
                fail(`unknown command "${command}". Run with --help.`);
                return 1;
        }
    }
    finally {
        await backend.close?.();
    }
}
// ── commands ────────────────────────────────────────────────────────────────
const CHANNEL_SECURITY_NOTE = 'Channels are namespacing, not security: everyone on this store shares its credentials. ' +
    "Isolation is enforced by the backend's own access controls (IAM policies, database grants, file permissions).";
function cmdDescribe(cfg) {
    const scheme = schemeForUri(cfg.backendUri);
    const info = backendInfo(scheme); // throws the known-schemes error for unregistered schemes
    if (cfg.json) {
        emit({ uri: cfg.backendUri, scheme, info: info ?? null, security: CHANNEL_SECURITY_NOTE });
        return 0;
    }
    if (!info) {
        process.stdout.write(`scheme "${scheme}" is registered but published no description — consult the plugin's own docs.\n`);
        return 0;
    }
    const cap = (on, yes, no) => (on ? `yes — ${yes}` : `no — ${no}`);
    process.stdout.write([
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
    ].join('\n'));
    return 0;
}
async function cmdChannels(backend, cfg) {
    const found = await discoverChannels(backend);
    const scheme = schemeForUri(cfg.backendUri);
    // Path-carved schemes append the prefix; SQL schemes address carved
    // channels via ?channel=<name> (their keys live under channels/<name>/).
    const sqlScheme = scheme === 'sqlite' || scheme === 'postgres' || scheme === 'postgresql';
    const sqlChannelUri = (prefix) => {
        const m = /^channels\/([^/]+)$/.exec(prefix);
        if (!m)
            return null; // manually nested beyond the ?channel= convention
        return `${cfg.backendUri}${cfg.backendUri.includes('?') ? '&' : '?'}channel=${m[1]}`;
    };
    const rows = found.map(({ prefix, agents }) => ({
        prefix,
        agents,
        uri: prefix === ''
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
async function cmdPurge(backend, cfg, olderThan, dryRun) {
    if (!olderThan) {
        fail('purge requires --older-than <duration>, e.g. --older-than 30d (units: s, m, h, d)');
        return 1;
    }
    const maxAgeMs = parseDuration(olderThan);
    if (maxAgeMs === null) {
        fail(`invalid --older-than "${olderThan}" — use <number><unit> with unit s, m, h or d (e.g. 30d, 12h)`);
        return 1;
    }
    const cutoff = Date.now() - maxAgeMs;
    // Only the archive is ever purged: pending inbox/ messages are undelivered
    // mail and agents/ registrations are live state. Message age comes from the
    // key's monotonic ms-timestamp prefix — no content reads needed.
    const victims = (await backend.list('read/')).filter((key) => {
        const ts = messageTimestamp(key);
        return ts !== null && ts < cutoff;
    });
    if (!dryRun) {
        for (const key of victims)
            await backend.delete(key);
    }
    if (cfg.json) {
        emit({ purged: !dryRun, dryRun, olderThan, count: victims.length, keys: victims });
    }
    else {
        const verb = dryRun ? 'would purge' : 'purged';
        process.stdout.write(`${verb} ${victims.length} archived message${victims.length === 1 ? '' : 's'} older than ${olderThan}\n`);
    }
    return 0;
}
/** "45s" | "30m" | "12h" | "30d" → milliseconds, or null when malformed. */
function parseDuration(spec) {
    const m = /^(\d+)(s|m|h|d)$/.exec(spec);
    if (!m)
        return null;
    const n = Number(m[1]);
    return n * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
}
/** ms timestamp from an archive key's zero-padded seq prefix, or null. */
function messageTimestamp(key) {
    const file = key.slice(key.lastIndexOf('/') + 1);
    const m = /^0*(\d+)-/.exec(file);
    return m ? Number(m[1]) : null;
}
async function cmdConventions(cfg) {
    const { conventions, backend, source } = await loadConventions();
    if (cfg.json) {
        emit({ source, backend: backend ?? null, conventions });
        return 0;
    }
    process.stdout.write([
        `source     ${source ?? 'built-in defaults (override with .agentcomm.json or .agentcomm.yaml)'}`,
        ...(backend ? [`backend    ${backend} (project default from config file)`] : []),
        `lobby      ${conventions.lobby} — register there, announce which topic channels you're joining`,
        `topics     ${conventions.topicStyle} — "work on x" ⇒ channel x in that style`,
        `artifacts  issue → ${conventions.artifactChannels.issue}, pr → ${conventions.artifactChannels.pr}`,
        `subjects   ${conventions.subjects.join(', ')}`,
        '',
    ].join('\n'));
    return 0;
}
async function cmdLog(backend, cfg, thread, limit = 50) {
    // The conversation = pending inbox mail + the read/ archive, across ALL
    // recipients, in send order. Timestamps come from the keys' seq prefix, so
    // sorting and --limit slicing happen BEFORE any message body is fetched —
    // a catch-up read costs O(limit) gets, not O(history).
    const entries = [];
    for (const [prefix, state] of [
        ['inbox/', 'pending'],
        ['read/', 'archived'],
    ]) {
        for (const key of await backend.list(prefix)) {
            if (!key.endsWith('.json'))
                continue;
            const ts = messageTimestamp(key);
            if (ts !== null)
                entries.push({ key, state, ts });
        }
    }
    entries.sort((a, b) => a.ts - b.ts || a.key.localeCompare(b.key));
    const out = [];
    // Over-fetch only when filtering by thread (we can't know a message's
    // thread from its key); otherwise slice strictly to the limit.
    const candidates = thread ? entries : entries.slice(-Math.max(0, limit));
    for (const { key, state } of candidates) {
        try {
            const msg = JSON.parse((await backend.get(key)).toString('utf8'));
            if (thread && msg.thread !== thread)
                continue;
            out.push({ ...msg, state });
        }
        catch {
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
async function cmdRegister(bus, cfg) {
    const me = requireAgent(cfg);
    const record = await bus.register(me);
    if (cfg.json)
        emit(record);
    else
        process.stdout.write(`registered ${record.name}\n`);
    return 0;
}
async function cmdAgents(bus, cfg) {
    const list = await bus.agents();
    if (cfg.json) {
        emit(list);
    }
    else if (list.length === 0) {
        process.stdout.write('(no agents registered)\n');
    }
    else {
        for (const a of list)
            process.stdout.write(`${a.name}\tlast seen ${a.lastSeen}\n`);
    }
    return 0;
}
async function cmdSend(bus, cfg, subject, thread, rest) {
    const me = requireAgent(cfg);
    const to = rest[0];
    if (!to) {
        fail('send requires a recipient: agentcomm send <to> [body]');
        return 1;
    }
    const body = rest.length > 1 ? rest.slice(1).join(' ') : await readStdin();
    const msg = await bus.send({ from: me, to, body, subject, thread });
    if (cfg.json)
        emit(msg);
    else
        process.stdout.write(`sent ${msg.id} → ${to}\n`);
    return 0;
}
async function cmdBroadcast(bus, cfg, subject, thread, rest) {
    const me = requireAgent(cfg);
    const body = rest.length > 0 ? rest.join(' ') : await readStdin();
    const sent = await bus.broadcast({ from: me, body, subject, thread });
    if (cfg.json)
        emit(sent);
    else
        process.stdout.write(`broadcast to ${sent.length} agent(s)\n`);
    return 0;
}
async function cmdInbox(bus, cfg) {
    const me = requireAgent(cfg);
    const messages = await bus.inbox(me);
    printMessages(messages, cfg);
    return 0;
}
async function cmdPeek(bus, cfg) {
    const me = requireAgent(cfg);
    const messages = await bus.peek(me);
    printMessages(messages, cfg);
    return 0;
}
async function cmdWait(bus, cfg, timeoutMs) {
    const me = requireAgent(cfg);
    const messages = await bus.wait(me, timeoutMs);
    if (messages.length === 0) {
        if (cfg.json)
            emit([]);
        else
            process.stderr.write(`wait: timed out after ${timeoutMs}ms\n`);
        return 2; // timeout
    }
    printMessages(messages, cfg);
    return 0; // delivered
}
async function cmdClaim(bus, cfg, queue) {
    const me = requireAgent(cfg);
    if (!queue) {
        fail('claim requires --queue <name>');
    }
    const msg = await bus.claim(queue, me);
    if (cfg.json) {
        emit(msg);
    }
    else if (!msg) {
        process.stdout.write('(queue empty)\n');
    }
    else {
        const subj = msg.subject ? ` [${msg.subject}]` : '';
        process.stdout.write(`claimed ${msg.id} from ${msg.from}${subj}\n  ${msg.body}\n`);
    }
    return 0;
}
/**
 * Import every module listed in AGENTCOMM_BACKEND_PLUGINS so its
 * registerBackend() side effect runs before --backend is resolved.
 */
async function loadBackendPlugins() {
    const spec = process.env.AGENTCOMM_BACKEND_PLUGINS;
    if (!spec)
        return;
    for (const mod of spec.split(/[,\s]+/).filter(Boolean)) {
        try {
            await import(mod);
        }
        catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            throw new Error(`agentcomm: failed to load backend plugin "${mod}": ${reason}`);
        }
    }
}
// ── helpers ─────────────────────────────────────────────────────────────────
function printMessages(messages, cfg) {
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
function requireAgent(cfg) {
    if (!cfg.agent) {
        fail('no acting agent. Pass --as <name> or set AGENTCOMM_AGENT.');
    }
    return cfg.agent;
}
function emit(value) {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
function fail(message) {
    process.stderr.write(`agentcomm: ${message}\n`);
    // eslint-disable-next-line no-process-exit
    process.exit(1);
}
async function readStdin() {
    if (process.stdin.isTTY)
        return '';
    const chunks = [];
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
//# sourceMappingURL=cli.js.map