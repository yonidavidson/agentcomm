/**
 * Unit tables for the telemetry precision layer: real-merge parsing (no
 * plumbing false positives), prompt path extraction for worktree-aware
 * agent refs, and event dedup (re-derivations of one occurrence collapse;
 * genuine repeats survive).
 */
import { describe, it, expect } from 'vitest';
import { parseMergeCommand, extractAbsolutePaths } from '../src/hook-run.js';
import { dedupeEvents, eventDedupKey, DEDUP_WINDOW_MS, type TelemetryEvent } from '../src/telemetry.js';

describe('parseMergeCommand', () => {
  it.each([
    ['git merge feat-x', { kind: 'git-merge', source: 'feat-x' }],
    ['git checkout main && git merge feat-x', { kind: 'git-merge', source: 'feat-x' }],
    ['git merge --no-ff -m "landing it" feat-y', { kind: 'git-merge', source: 'feat-y' }],
    ['git merge --continue', { kind: 'git-merge' }],
    ['git merge feat-x && npm test', { kind: 'git-merge', source: 'feat-x' }],
    ['gh pr merge 123 --squash', { kind: 'gh-pr-merge', pr: '123' }],
    ['gh pr merge --squash 123', { kind: 'gh-pr-merge', pr: '123' }],
    ['gh pr merge #77 --auto', { kind: 'gh-pr-merge', pr: '77' }],
    ['gh pr merge https://github.com/o/r/pull/456 --squash', { kind: 'gh-pr-merge', pr: '456' }],
    ['gh pr merge --squash', { kind: 'gh-pr-merge' }],
  ])('%s → merge', (command, expected) => {
    expect(parseMergeCommand(command)).toEqual(expected);
  });

  it.each([
    'git merge-base --fork-point main HEAD',
    'git merge-base origin/main HEAD',
    'git merge-tree A B',
    'git merge-file ours base theirs',
    'git mergetool',
    'git merge --abort',
    'git merge --quit',
    'gh pr view 123 --json state,mergeCommit,mergedAt',
    'git log --merges --oneline',
    'echo git mergetool docs',
    'echo mergeCommit',
    'git branch --merged',
  ])('%s → null (not a merge)', (command) => {
    expect(parseMergeCommand(command)).toBeNull();
  });

  it('a merge after a plumbing call in one compound line still counts', () => {
    expect(parseMergeCommand('git merge-base main HEAD; git merge feat-z')).toEqual({
      kind: 'git-merge',
      source: 'feat-z',
    });
  });
});

describe('extractAbsolutePaths', () => {
  it('extracts, strips trailing punctuation, dedupes, orders deepest-first', () => {
    const paths = extractAbsolutePaths(
      'Review /tmp/wt/src/deep/file.ts, then check /tmp/wt (the worktree). Also /tmp/wt/src/deep/file.ts again.',
    );
    expect(paths).toEqual(['/tmp/wt/src/deep/file.ts', '/tmp/wt']);
  });

  it('caps the candidate list', () => {
    const text = Array.from({ length: 20 }, (_, i) => `/p${i}/x`).join(' ');
    expect(extractAbsolutePaths(text)).toHaveLength(8);
  });

  it('ignores bare slashes and relative paths', () => {
    expect(extractAbsolutePaths('a / b and src/foo.ts here')).toEqual([]);
  });
});

describe('dedupeEvents', () => {
  const ev = (over: Partial<TelemetryEvent>): TelemetryEvent => ({
    id: Math.random().toString(36).slice(2, 10),
    ts: '2026-07-23T10:00:00.000Z',
    agent: 'a-1',
    session: 's-1',
    type: 'merged',
    attrs: { command: 'git merge feat-x' },
    ...over,
  });
  const at = (ms: number) => new Date(Date.parse('2026-07-23T10:00:00.000Z') + ms).toISOString();

  it('collapses identical twins within the window (keep-first), keeps repeats beyond it', () => {
    const twins = [ev({ ts: at(0) }), ev({ ts: at(150) })];
    expect(dedupeEvents(twins)).toHaveLength(1);
    expect(dedupeEvents(twins)[0]!.ts).toBe(at(0));

    expect(dedupeEvents([ev({ ts: at(0) }), ev({ ts: at(DEDUP_WINDOW_MS + 1) })])).toHaveLength(2);
  });

  it('a burst of N twins collapses to the earliest one', () => {
    expect(dedupeEvents([ev({ ts: at(0) }), ev({ ts: at(100) }), ev({ ts: at(9_000) })])).toHaveLength(1);
  });

  it('any identity field difference keeps both', () => {
    expect(dedupeEvents([ev({}), ev({ agent: 'a-2' })])).toHaveLength(2);
    expect(dedupeEvents([ev({}), ev({ session: 's-2' })])).toHaveLength(2);
    expect(dedupeEvents([ev({}), ev({ ref: 'feat-x' })])).toHaveLength(2);
    expect(dedupeEvents([ev({}), ev({ attrs: { command: 'git merge feat-y' } })])).toHaveLength(2);
  });

  it('distinct tool calls survive even inside the window (tool_use in attrs differs)', () => {
    const a = ev({ ts: at(0), attrs: { command: 'git merge feat-x', tool_use: 't-1' } });
    const b = ev({ ts: at(100), attrs: { command: 'git merge feat-x', tool_use: 't-2' } });
    expect(dedupeEvents([a, b])).toHaveLength(2);
  });

  it('key is insensitive to attrs key order', () => {
    const a = ev({ attrs: { x: 1, y: { b: 2, a: 3 } } });
    const b = ev({ attrs: { y: { a: 3, b: 2 }, x: 1 } });
    expect(eventDedupKey(a)).toBe(eventDedupKey(b));
  });
});
