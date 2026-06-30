#!/usr/bin/env node
import { createBackend } from './backends/index.js';
import { Bus } from './bus.js';
import { parseArgs, resolveConfig, type ResolvedConfig } from './config.js';
import type { Message } from './types.js';

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

Flags:
  --backend <uri>          file:// | sqlite:// | s3:// | gs:// | bare path
                           (env AGENTCOMM_BACKEND; default file://./.agentcomm)
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
      default:
        fail(`unknown command "${command}". Run with --help.`);
        return 1;
    }
  } finally {
    await backend.close?.();
  }
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdRegister(bus: Bus, cfg: ResolvedConfig): Promise<number> {
  const me = requireAgent(cfg);
  const record = await bus.register(me);
  if (cfg.json) emit(record);
  else process.stdout.write(`registered ${record.name}\n`);
  return 0;
}

async function cmdAgents(bus: Bus, cfg: ResolvedConfig): Promise<number> {
  const list = await bus.agents();
  if (cfg.json) {
    emit(list);
  } else if (list.length === 0) {
    process.stdout.write('(no agents registered)\n');
  } else {
    for (const a of list) process.stdout.write(`${a.name}\tlast seen ${a.lastSeen}\n`);
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
  const me = requireAgent(cfg);
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
  const me = requireAgent(cfg);
  const body = rest.length > 0 ? rest.join(' ') : await readStdin();
  const sent = await bus.broadcast({ from: me, body, subject, thread });
  if (cfg.json) emit(sent);
  else process.stdout.write(`broadcast to ${sent.length} agent(s)\n`);
  return 0;
}

async function cmdInbox(bus: Bus, cfg: ResolvedConfig): Promise<number> {
  const me = requireAgent(cfg);
  const messages = await bus.inbox(me);
  printMessages(messages, cfg);
  return 0;
}

async function cmdPeek(bus: Bus, cfg: ResolvedConfig): Promise<number> {
  const me = requireAgent(cfg);
  const messages = await bus.peek(me);
  printMessages(messages, cfg);
  return 0;
}

async function cmdWait(bus: Bus, cfg: ResolvedConfig, timeoutMs: number): Promise<number> {
  const me = requireAgent(cfg);
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
  const me = requireAgent(cfg);
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

function requireAgent(cfg: ResolvedConfig): string {
  if (!cfg.agent) {
    fail('no acting agent. Pass --as <name> or set AGENTCOMM_AGENT.');
  }
  return cfg.agent;
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
  return Buffer.concat(chunks).toString('utf8').trim();
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
