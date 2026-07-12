/**
 * Session identity derivation — shared by the CLI and by in-process harness
 * plugins (OpenCode, Pi) that import the library instead of shelling out.
 *
 * The acting name is an ALIAS (addressing, not authentication). The default is
 * the git identity's email local-part (else OS username), suffixed with a
 * per-session fingerprint so concurrent runners on one machine never share a
 * consuming mailbox.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import * as os from 'node:os';

const execFileP = promisify(execFile);

let sessionHashMemo: string | undefined;

/**
 * A fingerprint of THIS session, stable across the many invocations one agent
 * session makes: AGENTCOMM_SESSION, else the terminal session id, else the
 * harness process (grandparent pid). Suffixes derived aliases and is recorded
 * in registrations, so tooling can tell "stale me" from "someone else".
 */
export async function sessionHash(): Promise<string> {
  if (sessionHashMemo !== undefined) return sessionHashMemo;
  let session =
    process.env.AGENTCOMM_SESSION ??
    process.env.ITERM_SESSION_ID ??
    process.env.TERM_SESSION_ID ??
    process.env.TMUX_PANE ??
    '';
  if (!session) {
    try {
      session = 'gppid:' + (await execFileP('ps', ['-o', 'ppid=', '-p', String(process.ppid)])).stdout.trim();
    } catch {
      session = 'ppid:' + String(process.ppid);
    }
  }
  sessionHashMemo = createHash('sha1').update(session).digest('hex').slice(0, 12);
  return sessionHashMemo;
}

const sanitize = (raw: string) => raw.replace(/[^A-Za-z0-9._-]/g, '');

/**
 * The honest default alias + its source, WITHOUT any stderr announce or memo —
 * callers (the CLI's resolveAgent, harness plugins) layer those on. Returns
 * `{ name: null }` only when neither a git identity nor an OS username exists.
 */
export async function deriveIdentity(): Promise<{ name: string | null; source: string }> {
  let name = '';
  let source = '';
  try {
    const email = (await execFileP('git', ['config', 'user.email'])).stdout.trim();
    name = sanitize(email.split('@')[0] ?? '');
    source = 'from git config user.email';
  } catch {
    /* not a repo / no git identity */
  }
  if (!name) {
    name = sanitize(os.userInfo().username);
    source = 'OS username';
  }
  if (name) name = `${name}-${(await sessionHash()).slice(0, 4)}`;
  return { name: name || null, source };
}
