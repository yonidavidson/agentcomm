/**
 * Network-free tests for the github:// backend: URI parsing, token
 * resolution, and the HTTP edge cases (404→ENOENT, 409 retry, rate-limit
 * error) against a mocked global fetch. The live suite is test/github.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBackend, backendInfo, GithubBackend } from '../src/backends/index.js';
import { resolveGithubToken } from '../src/backends/github.js';

const ENV_KEYS = ['AGENTCOMM_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.AGENTCOMM_GITHUB_TOKEN = 'unit-test-token';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
});

function jsonRes(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe('github:// URI parsing (factory)', () => {
  it('requires owner/repo', async () => {
    await expect(createBackend('github://just-owner')).rejects.toThrow(/needs at least owner\/repo/);
  });

  it('accepts owner/repo, a channel prefix, and ?branch=', async () => {
    expect(await createBackend('github://acme/webapp')).toBeInstanceOf(GithubBackend);
    expect(await createBackend('github://acme/webapp/team-a/sub')).toBeInstanceOf(GithubBackend);
    expect(await createBackend('github://acme/webapp?branch=my-bus')).toBeInstanceOf(GithubBackend);
  });

  it('rejects ?channel= with the append-a-path hint, and unknown params', async () => {
    await expect(createBackend('github://acme/webapp?channel=x')).rejects.toThrow(/carves channels by path/);
    await expect(createBackend('github://acme/webapp?brnch=x')).rejects.toThrow(/unsupported query parameter/);
  });

  it('registers BackendInfo: no claim, no push, path-carved channels', () => {
    const info = backendInfo('github')!;
    expect(info.capabilities).toEqual({ claim: false, push: false });
    expect(info.channel.template).toBe('github://<owner>/<repo>/<channel>');
  });
});

describe('github token resolution', () => {
  it('prefers AGENTCOMM_GITHUB_TOKEN over GITHUB_TOKEN over GH_TOKEN', async () => {
    process.env.GITHUB_TOKEN = 'b';
    process.env.GH_TOKEN = 'c';
    expect(await resolveGithubToken()).toBe('unit-test-token');
    delete process.env.AGENTCOMM_GITHUB_TOKEN;
    expect(await resolveGithubToken()).toBe('b');
    delete process.env.GITHUB_TOKEN;
    expect(await resolveGithubToken()).toBe('c');
  });
});

describe('github HTTP behavior (mocked fetch)', () => {
  it('get maps 404 to the standard key-not-found error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(404, { message: 'Not Found' })));
    const b = await GithubBackend.open('acme', 'webapp');
    await expect(b.get('nope')).rejects.toThrow(/key not found: nope/);
  });

  it('list returns [] when the bus branch does not exist yet', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonRes(404)));
    const b = await GithubBackend.open('acme', 'webapp');
    expect(await b.list('')).toEqual([]);
  });

  it('put retries through a 409 commit race and succeeds', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push(`${method} ${url.includes('?ref=') ? 'stat' : 'write'}`);
        if (method === 'GET') return jsonRes(404); // key absent both times
        return calls.filter((c) => c.startsWith('PUT')).length === 1
          ? jsonRes(409, { message: 'is at ... but expected ...' })
          : jsonRes(201, { content: { sha: 'x' } });
      }),
    );
    const b = await GithubBackend.open('acme', 'webapp');
    await expect(b.put('inbox/a/1.json', Buffer.from('hi'))).resolves.toBeUndefined();
    expect(calls.filter((c) => c.startsWith('PUT')).length).toBe(2);
  });

  it('an exhausted rate limit surfaces a pointed error with the reset horizon', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonRes(
          403,
          { message: 'API rate limit exceeded' },
          {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
          },
        ),
      ),
    );
    const b = await GithubBackend.open('acme', 'webapp');
    await expect(b.get('k')).rejects.toThrow(/rate limit exhausted.*poll gently/s);
  });
});
