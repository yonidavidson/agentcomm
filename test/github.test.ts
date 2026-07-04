/**
 * Live e2e for the github:// backend — the repo IS the bus, and in CI the
 * test target is this very repository: a scratch branch written with the
 * workflow's own GITHUB_TOKEN, deleted afterwards.
 *
 * Gate: AGENTCOMM_TEST_GITHUB_REPO (owner/repo you can push to) + a
 * resolvable token. Locally:
 *   AGENTCOMM_TEST_GITHUB_REPO=you/yourrepo npm test   # gh auth suffices
 * Self-skips (never fails) when the gate is absent or the token can't write
 * — fork PRs get a read-only GITHUB_TOKEN and must skip cleanly.
 *
 * API budget note: this suite is deliberately small (~35 calls/run) — the
 * REST quota is shared account-wide.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { GithubBackend } from '../src/backends/github.js';
import { resolveGithubToken } from '../src/backends/github.js';
import { discoverChannels } from '../src/channels.js';
import { Bus } from '../src/bus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.ts');

const REPO = process.env.AGENTCOMM_TEST_GITHUB_REPO ?? '';
const [OWNER = '', NAME = ''] = REPO.split('/');
const BRANCH = `bus-test-${randomUUID().slice(0, 8)}`;

let available = Boolean(OWNER && NAME);
let token = '';
let skipReason = 'AGENTCOMM_TEST_GITHUB_REPO not set (owner/repo)';
if (available) {
  try {
    token = await resolveGithubToken();
    // Probe with a real WRITE — read-only tokens (fork PRs) must skip, not fail.
    const probe = await GithubBackend.open(OWNER, NAME, `probe-${randomUUID().slice(0, 8)}`, BRANCH);
    await probe.put('probe.json', Buffer.from('{}'));
  } catch (err) {
    available = false;
    skipReason = `cannot write to ${REPO}: ${(err as Error).message}`;
  }
}
const maybeDescribe = available ? describe : describe.skip;
if (!available && REPO) {
  // eslint-disable-next-line no-console
  console.warn(`\nSkipping test/github.test.ts — ${skipReason}\n`);
}

afterAll(async () => {
  if (!available) return;
  // One ref delete removes the whole scratch branch (best effort — the next
  // run uses a fresh name either way).
  await fetch(`https://api.github.com/repos/${OWNER}/${NAME}/git/refs/heads/${BRANCH}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'agentcomm',
    },
  }).catch(() => {});
});

async function freshBackend(prefix: string): Promise<GithubBackend> {
  return GithubBackend.open(OWNER, NAME, prefix, BRANCH);
}

maybeDescribe('GithubBackend (requires a writable repo — in CI: this one)', () => {
  it('Backend contract: round-trip, overwrite, exists, delete no-op, missing-key error', async () => {
    const b = await freshBackend(`t-${randomUUID().slice(0, 8)}`);

    await b.put('inbox/a/1.json', Buffer.from('hello'));
    expect((await b.get('inbox/a/1.json')).toString()).toBe('hello');

    await b.put('inbox/a/1.json', Buffer.from('hello v2'));
    expect((await b.get('inbox/a/1.json')).toString()).toBe('hello v2');

    expect(await b.exists('inbox/a/1.json')).toBe(true);
    expect(await b.exists('nope')).toBe(false);
    await expect(b.get('nope')).rejects.toThrow(/key not found/);

    await b.delete('inbox/a/1.json');
    expect(await b.exists('inbox/a/1.json')).toBe(false);
    await expect(b.delete('inbox/a/1.json')).resolves.toBeUndefined();
  }, 120000);

  it('list is prefix-scoped without sibling bleed; move relocates (copy+commit)', async () => {
    const b = await freshBackend(`t-${randomUUID().slice(0, 8)}`);
    await b.put('inbox/a/001.json', Buffer.from('1'));
    await b.put('inbox/a/002.json', Buffer.from('2'));
    await b.put('inbox/ab/001.json', Buffer.from('x')); // 'inbox/a' is a prefix of 'inbox/ab'
    expect(await b.list('inbox/a/')).toEqual(['inbox/a/001.json', 'inbox/a/002.json']);

    await b.move('inbox/a/001.json', 'read/a/001.json');
    expect(await b.exists('inbox/a/001.json')).toBe(false);
    expect((await b.get('read/a/001.json')).toString()).toBe('1');
  }, 120000);

  it('Bus semantics: send → inbox in order with read/ archive; claim refused', async () => {
    const bus = new Bus(await freshBackend(`t-${randomUUID().slice(0, 8)}`));
    await bus.send({ from: 'alice', to: 'bob', body: 'one' });
    await bus.send({ from: 'alice', to: 'bob', body: 'two' });
    expect((await bus.inbox('bob')).map((m) => m.body)).toEqual(['one', 'two']);
    expect(await bus.inbox('bob')).toHaveLength(0);
    await expect(bus.claim('q', 'w')).rejects.toThrow(/does not support claim/);
  }, 180000);

  it('channel discovery finds carved prefixes on the bus branch', async () => {
    const base = `disc-${randomUUID().slice(0, 8)}`;
    const teamA = new Bus(await freshBackend(`${base}/team-a`));
    await teamA.register('alice');
    const found = await discoverChannels(await freshBackend(base));
    expect(found).toEqual([{ prefix: 'team-a', agents: 1 }]);
  }, 120000);

  it('the CLI path works end-to-end: register → send → wait exit 0', async () => {
    const uri = `github://${OWNER}/${NAME}/cli-${randomUUID().slice(0, 8)}?branch=${BRANCH}`;
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.on('error', reject);
        child.on('exit', (code) => resolve({ code: code ?? -1, stdout }));
      });

    expect((await run(['register', '--as', 'ci-agent', '--backend', uri])).code).toBe(0);
    await run(['send', 'ci-agent', 'the repo is the bus', '--as', 'laptop-agent', '--backend', uri]);
    const w = await run(['wait', '--as', 'ci-agent', '--timeout', '30000', '--backend', uri, '--json']);
    expect(w.code).toBe(0);
    expect(w.stdout).toContain('the repo is the bus');
  }, 180000);
});
