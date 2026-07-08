#!/usr/bin/env node
/**
 * TaskCreated / TaskCompleted hook: mirror the agent's own task into its bus
 * status — a REAL, self-authored "what I'm doing" that needs no extra action.
 * "implement auth endpoints" beats "on main". Fires only in opted-in repos;
 * silent on any failure; the write is async through the daemon outbox (~0.2s).
 */
import { readStdinJson, onTheBus, cli } from './lib.mjs';

const input = await readStdinJson();
const cwd = input.cwd || process.cwd();
if (!(await onTheBus(cwd))) process.exit(0);

const subject = (input.task_subject ?? '').trim();
if (!subject) process.exit(0);

const status =
  input.hook_event_name === 'TaskCompleted' ? `done: ${subject}` : subject;
const clipped = status.length > 80 ? status.slice(0, 79) + '…' : status;

await cli(['register', '--status', clipped], cwd, 3_000);
process.exit(0);
