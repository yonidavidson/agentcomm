#!/usr/bin/env node
/**
 * Deterministic telemetry capture (issue #100). Harness hooks route lifecycle
 * moments here — PostToolUse (Skill / Bash), SessionStart, SessionEnd,
 * TaskCompleted — and if the repo's .agentcomm config has a matching
 * `telemetry.track` rule, the event is recorded. No model discretion: if
 * it's in the config, it fires; without the config section, this exits
 * silently. Recording is `agentcomm emit`, which only appends to the local
 * spool (fast, offline) — batches ride the next bus write. SessionEnd adds
 * --flush as the best-effort final ship. Fails open like every hook.
 */
import { execFile } from 'node:child_process';
import { readStdinJson, onTheBus, cli } from './lib.mjs';

const input = await readStdinJson();
const cwd = input.cwd || process.cwd();
if (!(await onTheBus(cwd))) process.exit(0);

let track = [];
try {
  const { loadConventions } = await import('../dist/conventions.js');
  track = (await loadConventions(cwd))?.telemetry?.track ?? [];
} catch {
  /* no config / unreadable → not opted in */
}
if (track.length === 0) process.exit(0);

/** Exact or simple-glob ('thermo-*') rule matching against a name. */
const nameMatches = (pattern, name) => {
  if (!pattern) return true;
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return re.test(name ?? '');
};
const tracked = (on, name) => track.some((r) => r.on === on && nameMatches(r.match, name));

/** hook payload → the event to record, or null when nothing is tracked. */
function deriveEvent() {
  const hook = input.hook_event_name;
  if (hook === 'PostToolUse' && input.tool_name === 'Skill') {
    const skill = input.tool_input?.skill ?? input.tool_input?.name;
    if (skill && tracked('skill', skill)) return { type: 'skill-ran', name: skill };
    return null;
  }
  if (hook === 'PostToolUse' && input.tool_name === 'Bash') {
    const command = String(input.tool_input?.command ?? '');
    if (/(^|[\s;&|(])git\s+merge\b/.test(command) || /(^|[\s;&|(])gh\s+pr\s+merge\b/.test(command)) {
      if (tracked('merge')) {
        return { type: 'merged', attrs: { command: command.length > 120 ? command.slice(0, 119) + '…' : command } };
      }
    }
    return null;
  }
  if (hook === 'SessionStart' && tracked('session')) return { type: 'session-start' };
  // session end is the last chance to ship — flush instead of waiting for a ride
  if (hook === 'SessionEnd' && tracked('session')) return { type: 'session-end', flush: true };
  if ((hook === 'TaskCompleted' || hook === 'TaskCreated') && input.task_subject) {
    const subject = String(input.task_subject).trim();
    if (subject && tracked('task', subject)) {
      return { type: hook === 'TaskCompleted' ? 'task-completed' : 'task-created', name: subject.slice(0, 120) };
    }
    return null;
  }
  return null;
}

const event = deriveEvent();
if (!event) process.exit(0);

const ref = await new Promise((resolve) =>
  execFile('git', ['-C', cwd, 'branch', '--show-current'], (err, out) => resolve(err ? null : out.trim() || null)),
);

await cli(
  [
    'emit',
    '--type', event.type,
    ...(event.name ? ['--name', event.name] : []),
    ...(ref ? ['--ref', ref] : []),
    ...(event.attrs ? ['--attrs', JSON.stringify(event.attrs)] : []),
    ...(event.flush ? ['--flush'] : []),
    '--json',
  ],
  cwd,
  event.flush ? 20_000 : 5_000,
);
process.exit(0);
