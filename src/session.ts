/**
 * Sticky session identity (issue #157).
 *
 * The session fingerprint suffixes the derived alias, so it decides WHICH
 * mailbox a bare command reads. Deriving it fresh from one fixed ancestor
 * ("the grandparent pid") made it drift: the same session invokes the CLI
 * sometimes as a direct child, sometimes under `sh -c`, sometimes from a hook
 * or a `timeout`/background wrapper, and every extra process layer shifted
 * which pid "the grandparent" named. A drifted fingerprint is a DIFFERENT,
 * empty mailbox — mail keeps arriving at the old one, `inbox` prints `[]`, and
 * nothing about that looks wrong from the read side.
 *
 * The fix is to stop re-deriving and start remembering. The first invocation
 * of a session writes a small state file recording its fingerprint plus the
 * nearest few ancestor pids (its "anchors"); later invocations from anywhere
 * in that process tree recognise a shared anchor and adopt the SAME
 * fingerprint, however deep they happen to run. The file also carries the
 * alias last used, so a change is announced instead of silently splitting.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

/** How long a recorded session stays adoptable. */
const TTL_MS = Number(process.env.AGENTCOMM_SESSION_TTL_MS ?? 12 * 3600_000);
/** How long its file survives at all (opportunistic pruning). */
const PRUNE_MS = 4 * TTL_MS;
/**
 * How far up the process tree to anchor. Deep enough to survive a couple of
 * wrapper processes (`sh -c`, `timeout`, a hook shell), shallow enough that
 * the anchors stay inside one agent session rather than reaching the terminal
 * or the desktop app every session on the machine shares.
 */
const ANCHOR_DEPTH = 3;

export interface Anchor {
  pid: number;
  /** argv[0]/comm of that pid — guards against a recycled pid matching. */
  comm: string;
}

export interface SessionState {
  session: string;
  /** Last alias a bare (derived) command acted as — the drift check. */
  alias?: string;
  updatedAt: string;
  anchors: Anchor[];
}

export function stateDir(): string {
  return (
    process.env.AGENTCOMM_STATE_DIR ??
    path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'agentcomm', 'sessions')
  );
}

/** One `ps` call, then walk: the nearest `depth` ancestors of this process. */
export async function ancestry(depth = ANCHOR_DEPTH): Promise<Anchor[]> {
  let table: string;
  try {
    table = await new Promise<string>((resolve, reject) =>
      execFile('ps', ['-Ao', 'pid=,ppid=,comm='], { maxBuffer: 8 * 1024 * 1024 }, (err, out) =>
        err ? reject(err) : resolve(out),
      ),
    );
  } catch {
    return [];
  }
  const tree = new Map<number, { ppid: number; comm: string }>();
  for (const line of table.split('\n')) {
    // "  1234   5678 /usr/bin/some command" — comm is the remainder, spaces and all
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) tree.set(Number(m[1]), { ppid: Number(m[2]), comm: m[3]!.trim() });
  }
  const out: Anchor[] = [];
  let pid = process.ppid;
  while (out.length < depth && pid > 1) {
    const node = tree.get(pid);
    if (!node) break;
    out.push({ pid, comm: node.comm });
    pid = node.ppid;
  }
  return out;
}

const sameAnchor = (a: Anchor, b: Anchor): boolean => a.pid === b.pid && a.comm === b.comm;

async function readStates(): Promise<{ file: string; state: SessionState }[]> {
  const dir = stateDir();
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: { file: string; state: SessionState }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const state = JSON.parse(await fs.readFile(file, 'utf8')) as SessionState;
      const age = Date.now() - Date.parse(state.updatedAt);
      if (!(age >= 0)) continue; // unparseable timestamp
      if (age > PRUNE_MS) {
        await fs.rm(file, { force: true }).catch(() => {});
        continue;
      }
      if (state.session && Array.isArray(state.anchors)) out.push({ file, state });
    } catch {
      /* half-written or foreign file — ignore */
    }
  }
  return out;
}

async function writeState(state: SessionState): Promise<void> {
  const dir = stateDir();
  const file = path.join(dir, `${state.session}.json`);
  const tmp = path.join(dir, `.${state.session}.${randomUUID().slice(0, 8)}`);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state));
    await fs.rename(tmp, file); // atomic replace — a concurrent reader sees one or the other
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {});
    /* state is an optimization: never fail a command over it */
  }
}

/** Merge new anchors into the recorded ones, newest first, bounded. */
const mergeAnchors = (recorded: Anchor[], seen: Anchor[]): Anchor[] =>
  [...seen, ...recorded.filter((r) => !seen.some((s) => sameAnchor(r, s)))].slice(0, ANCHOR_DEPTH * 2);

/**
 * The session fingerprint for THIS process: adopt the one recorded for a
 * shared ancestor when there is one, else record a new one. `fallback`
 * supplies the seed for a brand-new session (the historical derivation), so
 * behavior is unchanged the very first time a session is seen.
 */
export async function stickySession(fallback: () => Promise<string>): Promise<string> {
  const anchors = await ancestry();
  if (anchors.length === 0) return hash(await fallback()); // no process table — old behavior

  const fresh = (await readStates()).filter((s) => Date.now() - Date.parse(s.state.updatedAt) <= TTL_MS);
  const match = fresh.find((s) => s.state.anchors.some((a) => anchors.some((mine) => sameAnchor(a, mine))));
  if (match) {
    await writeState({
      ...match.state,
      updatedAt: new Date().toISOString(),
      anchors: mergeAnchors(match.state.anchors, anchors),
    });
    return match.state.session;
  }

  const session = hash(await fallback());
  await writeState({ session, updatedAt: new Date().toISOString(), anchors });
  return session;
}

/**
 * Record the alias a bare command is acting as, and report the DIFFERENT one
 * this session used before, if any. That prior name is where the mail is —
 * the caller says so on stderr rather than letting an empty inbox pass for
 * "no mail".
 */
export async function recordAlias(session: string, alias: string): Promise<string | null> {
  const anchors = await ancestry();
  const entry = (await readStates()).find((s) => s.state.session === session);
  const previous = entry?.state.alias && entry.state.alias !== alias ? entry.state.alias : null;
  await writeState({
    session,
    alias,
    updatedAt: new Date().toISOString(),
    anchors: mergeAnchors(entry?.state.anchors ?? [], anchors),
  });
  return previous;
}

function hash(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

// ── mailbox leases (issue #161) ─────────────────────────────────────────────

/**
 * A subagent inherits its parent's git identity and process tree, so it
 * derives the parent's alias — and since reads consume, one `agentcomm inbox`
 * from a subagent drains the mailbox its parent is waiting on. Identity stays
 * per-session on purpose (a session IS a mailbox; see the sticky fingerprint
 * above), so what is needed is not a different name but VISIBILITY: while a
 * process is acting as an alias it leaves a lease behind, and anything
 * destructive done to a leased mailbox by another live process says so.
 *
 * Leases are local files: the case they cover — two processes of one agent
 * session on one machine — is exactly the local case.
 */
export interface Lease {
  alias: string;
  pid: number;
  /** What that process is doing, for a message a human can act on. */
  command: string;
  since: string;
}

/** Leases older than this are ignored even if the pid is somehow still alive. */
const LEASE_TTL_MS = 30 * 60_000;

const leaseFile = (alias: string, pid: number): string => path.join(stateDir(), `lease-${alias}-${pid}.json`);

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Take a lease on `alias` for this process and return the OTHER live holders.
 * Callers decide what to say about them — a consuming read on a mailbox
 * another process is holding is worth a loud warning; a heartbeat is not.
 */
export async function leaseMailbox(alias: string, command: string): Promise<Lease[]> {
  const others: Lease[] = [];
  const dir = stateDir();
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    /* no state yet */
  }
  for (const name of names) {
    if (!name.startsWith(`lease-${alias}-`) || !name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const lease = JSON.parse(await fs.readFile(file, 'utf8')) as Lease;
      const stale = Date.now() - Date.parse(lease.since) > LEASE_TTL_MS;
      if (lease.pid === process.pid) continue;
      if (stale || !pidAlive(lease.pid)) {
        await fs.rm(file, { force: true }).catch(() => {});
        continue;
      }
      if (lease.alias === alias) others.push(lease);
    } catch {
      await fs.rm(file, { force: true }).catch(() => {});
    }
  }
  const mine: Lease = { alias, pid: process.pid, command, since: new Date().toISOString() };
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(leaseFile(alias, process.pid), JSON.stringify(mine));
  } catch {
    /* a lease is advisory — never fail a command over it */
  }
  return others;
}

/** Drop this process's lease. Called when the command ends. */
export async function releaseMailbox(alias: string): Promise<void> {
  await fs.rm(leaseFile(alias, process.pid), { force: true }).catch(() => {});
}
