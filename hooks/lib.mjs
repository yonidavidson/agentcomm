/**
 * Shared plumbing for the plugin hooks. Hooks must NEVER break a session:
 * every export fails open (returns null / false) on any error.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI = path.join(here, '..', 'dist', 'cli.js');

export async function readStdinJson() {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** The consent gate: only act where the team put the repo on the bus. */
export async function onTheBus(cwd) {
  if (process.env.AGENTCOMM_BACKEND) return true;
  let dir = cwd || process.cwd();
  for (;;) {
    try {
      const md = await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8');
      if (md.includes('<!-- agentcomm -->')) return true;
    } catch {
      /* keep walking */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Align the derived alias with the agent's own Bash commands. Both inherit
 * the terminal-session env, so usually nothing is needed; in the gppid
 * fallback the agent's CLI lands on the harness pid — our ancestor too.
 */
async function sessionEnv() {
  if (
    process.env.AGENTCOMM_SESSION ||
    process.env.ITERM_SESSION_ID ||
    process.env.TERM_SESSION_ID ||
    process.env.TMUX_PANE
  ) {
    return {};
  }
  try {
    const ps = (pid, field) =>
      new Promise((res, rej) =>
        execFile('ps', ['-o', `${field}=`, '-p', String(pid)], (e, out) => (e ? rej(e) : res(out.trim()))),
      );
    const parent = process.ppid;
    const comm = await ps(parent, 'comm');
    // hooks run as `sh -c node …` or as a direct child of the harness;
    // the harness process is the first non-shell ancestor
    const harness = /(^|\/)(sh|bash|zsh|dash)$/.test(comm) ? await ps(parent, 'ppid') : String(parent);
    return { AGENTCOMM_SESSION: `gppid:${harness}` };
  } catch {
    return {};
  }
}

/** Run the CLI, JSON out + stderr notices. Null on any failure or timeout. */
export async function cli(args, cwd, timeoutMs = 10_000) {
  try {
    const env = { ...process.env, ...(await sessionEnv()) };
    return await new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [CLI, ...args],
        { cwd, env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return resolve(null);
          try {
            resolve({ json: JSON.parse(stdout), stderr });
          } catch {
            resolve(null);
          }
        },
      );
      child.on('error', () => resolve(null));
    });
  } catch {
    return null;
  }
}

export function busUriFrom(stderr) {
  const m = /agentcomm: using (\S+)/.exec(stderr ?? '');
  return m?.[1] ?? process.env.AGENTCOMM_BACKEND ?? null;
}

/**
 * What moved on the bus since this hook last looked: recent messages
 * (including between OTHER agents — the bus is a shared, trusted space),
 * excluding our own sends. High-water mark kept in stateFile. First run
 * primes the mark silently — no history dump on fresh sessions.
 */
export async function activitySince(cwd, me, stateFile, cap = 4) {
  const res = await cli(['log', '--limit', '30', '--json'], cwd, 3_000);
  if (!res || !Array.isArray(res.json)) return { lines: [] };
  const msgs = res.json;
  let lastTs = 0;
  let first = true;
  try {
    const st = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    if (typeof st?.lastTs === 'number') {
      lastTs = st.lastTs;
      first = false;
    }
  } catch { /* first run */ }
  const newest = msgs.reduce((m, x) => Math.max(m, Date.parse(x.ts) || 0), lastTs);
  await fs.writeFile(stateFile, JSON.stringify({ lastTs: newest })).catch(() => {});
  if (first) return { lines: [] };
  const fresh = msgs.filter((m) => (Date.parse(m.ts) || 0) > lastTs && m.from !== me);
  return {
    lines: fresh.slice(-cap).map((m) => {
      const body = m.body.length > 70 ? m.body.slice(0, 70) + '…' : m.body;
      return `${m.from} → ${m.to}${m.subject ? ` [${m.subject}]` : ''}: "${body}"`;
    }),
  };
}

/** Current git branch (mechanical, non-prompt), or null. */
export async function gitBranch(cwd) {
  try {
    // symbolic-ref works on unborn branches too (rev-parse HEAD needs a commit)
    const b = await new Promise((res, rej) =>
      execFile('git', ['-C', cwd, 'symbolic-ref', '--short', 'HEAD'], (e, out) =>
        e ? rej(e) : res(out.trim()),
      ),
    );
    return b && b !== 'HEAD' ? b : null;
  } catch {
    return null;
  }
}

/**
 * Extra register args that give the board a mechanical default status —
 * "on <branch>" — WITHOUT clobbering a status the agent actually declared.
 * Set it only when the record has no status, or when the existing status is
 * itself a branch-default (so it follows branch switches). A real declared
 * status (anything not matching the branch pattern) is left untouched.
 */
export function branchStatusArgs(currentStatus, branch) {
  if (!branch) return [];
  const isBranchDefault = currentStatus == null || /^on \S+$/.test(currentStatus);
  if (!isBranchDefault) return [];
  if (currentStatus === `on ${branch}`) return []; // already correct, no write
  return ['--status', `on ${branch}`];
}

export function aliasFrom(stderr) {
  const m = /acting as (\S+)/.exec(stderr ?? '');
  return m?.[1] ?? null;
}
