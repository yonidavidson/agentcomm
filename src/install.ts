/**
 * install — the harness wiring, in the cheapest form each harness offers.
 *
 * Every harness runs the same six `agentcomm hook <event>` commands; only the
 * declaration site differs, and we pick per harness rather than uniformly
 * (issue #152, verified against claude / codex-cli / opencode):
 *
 *   claude    .claude/skills/agentcomm/ — a local plugin. A folder under a
 *             skills directory carrying .claude-plugin/plugin.json loads as
 *             `agentcomm@skills-dir` with no marketplace, no install command
 *             and no cache copy, so settings.json is never touched and plugin
 *             hooks merge with the team's own.
 *   codex     .codex/hooks.json — a dedicated hooks file whose layers already
 *             accumulate rather than override. Codex's plugin route would cost
 *             two per-user CLI commands plus a version-keyed cache copy, so it
 *             buys nothing here.
 *   opencode  .opencode/plugin/agentcomm.ts — already auto-discovered ("any
 *             *.ts or *.js file in .opencode/plugin/", no config entry needed).
 *
 * The invariant that matters: what we write, we own and REWRITE. The old
 * write-once-never-again wiring meant every improvement we shipped was
 * invisible to every repo already on the bus. Foreign hooks in .codex/hooks.json
 * survive untouched; only entries running `agentcomm hook` are ours to replace.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { ownVersion } from './update-check.js';

export type Harness = 'claude' | 'codex' | 'opencode';
export const HARNESSES: readonly Harness[] = ['claude', 'codex', 'opencode'] as const;

/** The file/directory each harness's wiring lives in, repo-relative. */
export const HARNESS_TARGET: Record<Harness, string> = {
  claude: '.claude/skills/agentcomm',
  codex: '.codex/hooks.json',
  opencode: '.opencode/plugin/agentcomm.ts',
};

/** The dot-directory that says "this repo uses that harness". */
const HARNESS_DIR: Record<Harness, string> = {
  claude: '.claude',
  codex: '.codex',
  opencode: '.opencode',
};

export const HARNESS_LABEL: Record<Harness, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Post-install step the harness needs from a human, if any. */
export const HARNESS_NOTE: Record<Harness, string | null> = {
  claude:
    'Claude Code loads it as the local plugin agentcomm@skills-dir once you accept the workspace trust dialog — then /reload-plugins (start Claude at the repo root; skills-dir plugins do not walk up from a subdirectory).',
  codex: 'Codex requires explicit trust for hooks: open /hooks, review the agentcomm entries, and trust them.',
  opencode: null,
};

export type InstallState = 'written' | 'unchanged' | 'removed' | 'absent' | 'missing' | 'stale' | 'current';

export interface HarnessResult {
  harness: Harness;
  file: string;
  state: InstallState;
}

/**
 * The lifecycle wiring, per harness event — every command is the global CLI
 * (`agentcomm hook <event>`), so this config IS the whole integration. Claude
 * and Codex share the hook JSON shape; Claude reads it from the plugin, Codex
 * from its hooks file.
 */
export function hookWiring(harness: 'claude' | 'codex'): Record<string, unknown[]> {
  const cmd = (c: string, timeout: number) => ({ type: 'command', command: c, timeout });
  const config: Record<string, unknown[]> = {
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [cmd('agentcomm hook session-start', 15), cmd('agentcomm hook telemetry', 10)],
      },
    ],
    SessionEnd: [{ hooks: [cmd('agentcomm hook telemetry', 20)] }],
    Stop: [{ hooks: [cmd('agentcomm hook stop-guard', 15)] }],
    UserPromptSubmit: [{ hooks: [cmd('agentcomm hook prompt-digest', 10)] }],
    PostToolUse: [
      {
        // sh fast-path: skip spawning the CLI at all unless the 10-minute
        // midturn stamp is stale (key derivation must match hook-run.ts).
        hooks: [
          cmd(
            'sh -c \'S="${TMPDIR:-/tmp}/agentcomm-midturn-$(printf %s "${CLAUDE_PROJECT_DIR:-$PWD}" | tr -c "A-Za-z0-9" _)"; [ -n "$(find "$S" -mmin -10 2>/dev/null)" ] && exit 0; exec agentcomm hook midturn-digest\'',
            10,
          ),
        ],
      },
      { matcher: 'Skill', hooks: [cmd('agentcomm hook telemetry', 10)] },
      { matcher: 'Task|Agent', hooks: [cmd('agentcomm hook telemetry', 10)] },
      {
        matcher: 'Bash',
        hooks: [
          cmd('sh -c \'I=$(cat); case "$I" in *merge*) printf %s "$I" | agentcomm hook telemetry;; esac\'', 10),
        ],
      },
    ],
    TaskCreated: [{ hooks: [cmd('agentcomm hook task-status', 10)] }],
    TaskCompleted: [{ hooks: [cmd('agentcomm hook task-status', 10)] }],
  };
  // Codex has no task events — don't advertise hooks it can never fire.
  if (harness === 'codex') {
    delete config.TaskCreated;
    delete config.TaskCompleted;
  }
  return config;
}

const jsonFile = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

/**
 * The Claude local plugin, file by file. Version-stamped from the CLI, so a
 * plain `npm install -g` upgrade is enough to make `--check` report drift.
 */
function claudePlugin(): Record<string, string> {
  return {
    '.claude-plugin/plugin.json': jsonFile({
      name: 'agentcomm',
      description: 'Puts every Claude Code session in this repo on the agentcomm message bus.',
      version: ownVersion() ?? '0.0.0',
    }),
    'hooks/hooks.json': jsonFile({ hooks: hookWiring('claude') }),
  };
}

/**
 * The generated OpenCode plugin: shells out to the globally installed CLI
 * exactly like the Claude and Codex wiring. Regenerated on every install, so
 * it tracks the CLI instead of freezing at whatever version first wrote it.
 */
function opencodePlugin(): string {
  return `// Generated by \`agentcomm install\` (agentcomm ${ownVersion() ?? '0.0.0'}) — commit it so every
// OpenCode session in this repo joins the bus. \`agentcomm install\` rewrites
// this file, so local edits belong in a second plugin file next to it:
// OpenCode auto-loads every *.ts in .opencode/plugin/ and they compose.
//
// Drives the globally installed agentcomm CLI (npm install -g @yonidavidson/agentcomm@latest).
// Every hook fails open: a broken bus never wedges the session.
import type { Plugin } from '@opencode-ai/plugin';

export const AgentcommHooks: Plugin = async ({ directory, client, $ }) => {
  const sh = $.cwd(directory).nothrow();

  // Telemetry parity with Claude Code/Codex: normalize the harness payload
  // and hand it to the CLI, which owns the repo's telemetry.track rule
  // matching (inert without a telemetry config).
  const telemetry = (payload: Record<string, unknown>) =>
    sh\`echo \${JSON.stringify(payload)} | agentcomm hook telemetry\`.quiet();

  // Session start: register on the repo bus (auto-detected from the git
  // remote) under a session-unique alias.
  await sh\`agentcomm register --status "opencode session"\`.quiet();
  await telemetry({ hook_event_name: 'SessionStart' });

  return {
    // Tracked tool events → the CLI's rule matcher. Only the tools the rules
    // can name; bash is pre-filtered so ordinary commands never spawn a CLI.
    async 'tool.execute.after'(input) {
      const args = (input as { args?: Record<string, unknown> }).args ?? {};
      if (input.tool === 'skill' && typeof args.name === 'string') {
        await telemetry({ hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: args.name } });
      } else if (input.tool === 'task' && typeof args.subagent_type === 'string') {
        await telemetry({ hook_event_name: 'PostToolUse', tool_name: 'Task', tool_input: { subagent_type: args.subagent_type } });
      } else if (input.tool === 'bash' && typeof args.command === 'string' && args.command.includes('merge')) {
        await telemetry({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: args.command } });
      }
    },
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

    // Session end is the last chance to ship the local event spool.
    async dispose() {
      await telemetry({ hook_event_name: 'SessionEnd' });
      await sh\`agentcomm emit --flush\`.quiet();
    },
  };
};

export default AgentcommHooks;
`;
}

/** An entry is ours when the command it runs is (or wraps) `agentcomm hook`. */
const isOurs = (command: unknown): boolean => typeof command === 'string' && command.includes('agentcomm hook');

/**
 * Drop every agentcomm entry from a harness `hooks` object, leaving foreign
 * entries — and anything shaped unexpectedly — exactly as found. Groups and
 * events emptied by the removal disappear rather than linger as `[]`.
 */
function stripOurs(hooks: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      out[event] = entries;
      continue;
    }
    const kept = entries
      .map((entry) => {
        const group = entry as { hooks?: unknown[] } | null;
        if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) return entry;
        const inner = group.hooks.filter((h) => !isOurs((h as { command?: unknown } | null)?.command));
        if (inner.length === group.hooks.length) return entry;
        return inner.length ? { ...group, hooks: inner } : null;
      })
      .filter((entry) => entry !== null);
    if (kept.length) out[event] = kept;
  }
  return out;
}

/** Read a JSON file, or null when absent. Throws on unparseable — never clobber what we can't read. */
async function readJson(file: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`agentcomm: ${file} exists but is not valid JSON — fix it or remove it, then rerun`);
  }
}

/** What .codex/hooks.json should contain: everything foreign, plus our current wiring. */
function codexDesired(existing: Record<string, unknown> | null): string {
  const rest = { ...(existing ?? {}) };
  const hooks = stripOurs((rest.hooks as Record<string, unknown>) ?? {});
  for (const [event, entries] of Object.entries(hookWiring('codex'))) {
    hooks[event] = [...((hooks[event] as unknown[]) ?? []), ...entries];
  }
  return jsonFile({ ...rest, hooks });
}

/** .codex/hooks.json with our wiring gone — or null when nothing but our wiring was left. */
function codexWithoutOurs(existing: Record<string, unknown>): string | null {
  const rest = { ...existing };
  const hooks = stripOurs((rest.hooks as Record<string, unknown>) ?? {});
  if (Object.keys(hooks).length === 0) {
    delete rest.hooks;
    if (Object.keys(rest).length === 0) return null;
    return jsonFile(rest);
  }
  return jsonFile({ ...rest, hooks });
}

/** Write only when the content differs, so re-running install is a no-op on disk. */
async function writeIfChanged(file: string, content: string): Promise<'written' | 'unchanged'> {
  const current = await fs.readFile(file, 'utf8').catch(() => null);
  if (current === content) return 'unchanged';
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  return 'written';
}

/** Remove a directory that our own removal just emptied; leave anything else alone. */
async function rmdirIfEmpty(dir: string): Promise<void> {
  await fs.rmdir(dir).catch(() => {});
}

/** Which harnesses this repo visibly uses — one stat each. */
export async function detectHarnesses(cwd: string): Promise<Harness[]> {
  const found: Harness[] = [];
  for (const harness of HARNESSES) {
    const isDir = await fs
      .stat(path.join(cwd, HARNESS_DIR[harness]))
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (isDir) found.push(harness);
  }
  return found;
}

/** Write (or refresh) one harness's wiring. Ours to rewrite; foreign config is preserved. */
export async function installHarness(harness: Harness, cwd: string): Promise<HarnessResult> {
  const file = HARNESS_TARGET[harness];
  const target = path.join(cwd, file);
  let state: InstallState;
  if (harness === 'claude') {
    const states = await Promise.all(
      Object.entries(claudePlugin()).map(([rel, content]) => writeIfChanged(path.join(target, rel), content)),
    );
    state = states.includes('written') ? 'written' : 'unchanged';
  } else if (harness === 'codex') {
    state = await writeIfChanged(target, codexDesired(await readJson(target)));
  } else {
    state = await writeIfChanged(target, opencodePlugin());
  }
  return { harness, file, state };
}

/** Is the on-disk wiring what this CLI version would write? Never touches disk. */
export async function checkHarness(harness: Harness, cwd: string): Promise<HarnessResult> {
  const file = HARNESS_TARGET[harness];
  const target = path.join(cwd, file);
  const compare = async (path_: string, want: string): Promise<InstallState> => {
    const have = await fs.readFile(path_, 'utf8').catch(() => null);
    if (have === null) return 'missing';
    return have === want ? 'current' : 'stale';
  };
  let state: InstallState;
  if (harness === 'claude') {
    const states = await Promise.all(
      Object.entries(claudePlugin()).map(([rel, content]) => compare(path.join(target, rel), content)),
    );
    state = states.includes('missing') ? 'missing' : states.includes('stale') ? 'stale' : 'current';
  } else if (harness === 'codex') {
    const existing = await readJson(target);
    state = existing === null ? 'missing' : await compare(target, codexDesired(existing));
  } else {
    state = await compare(target, opencodePlugin());
  }
  return { harness, file, state };
}

/** Remove our wiring and nothing else. */
export async function uninstallHarness(harness: Harness, cwd: string): Promise<HarnessResult> {
  const file = HARNESS_TARGET[harness];
  const target = path.join(cwd, file);
  let state: InstallState = 'absent';
  if (harness === 'claude') {
    const present = await fs
      .stat(target)
      .then(() => true)
      .catch(() => false);
    if (present) {
      await fs.rm(target, { recursive: true, force: true });
      await rmdirIfEmpty(path.dirname(target)); // .claude/skills, if we emptied it
      state = 'removed';
    }
  } else if (harness === 'codex') {
    const existing = await readJson(target);
    if (existing) {
      const rest = codexWithoutOurs(existing);
      if (rest === null) {
        await fs.rm(target, { force: true });
        await rmdirIfEmpty(path.dirname(target));
      } else if ((await writeIfChanged(target, rest)) === 'unchanged') {
        return { harness, file, state: 'absent' }; // nothing of ours was in there
      }
      state = 'removed';
    }
  } else {
    const present = await fs
      .stat(target)
      .then(() => true)
      .catch(() => false);
    if (present) {
      await fs.rm(target, { force: true });
      await rmdirIfEmpty(path.dirname(target)); // .opencode/plugin, if we emptied it
      state = 'removed';
    }
  }
  return { harness, file, state };
}
