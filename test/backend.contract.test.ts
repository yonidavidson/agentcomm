import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Backend } from '../src/types.js';
import { LocalBackend } from '../src/backends/local.js';
import { SqliteBackend } from '../src/backends/sqlite.js';

const tmpRoots: string[] = [];

async function mkTmp(): Promise<string> {
  const dir = path.join(os.tmpdir(), `agentcomm-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  tmpRoots.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpRoots.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

type Factory = () => Promise<Backend>;

const factories: Record<string, Factory> = {
  LocalBackend: async () => new LocalBackend(await mkTmp()),
  SqliteBackend: async () => SqliteBackend.open(path.join(await mkTmp(), 'bus.db')),
};

for (const [name, factory] of Object.entries(factories)) {
  describe(`Backend contract: ${name}`, () => {
    const buf = (s: string) => Buffer.from(s, 'utf8');

    it('put then get round-trips bytes', async () => {
      const b = await factory();
      await b.put('inbox/a/1.json', buf('hello'));
      expect((await b.get('inbox/a/1.json')).toString()).toBe('hello');
      await b.close?.();
    });

    it('put overwrites', async () => {
      const b = await factory();
      await b.put('k', buf('one'));
      await b.put('k', buf('two'));
      expect((await b.get('k')).toString()).toBe('two');
      await b.close?.();
    });

    it('get throws when absent', async () => {
      const b = await factory();
      await expect(b.get('nope')).rejects.toThrow();
      await b.close?.();
    });

    it('exists reflects presence', async () => {
      const b = await factory();
      expect(await b.exists('k')).toBe(false);
      await b.put('k', buf('x'));
      expect(await b.exists('k')).toBe(true);
      await b.close?.();
    });

    it('delete removes and is a no-op when absent', async () => {
      const b = await factory();
      await b.put('k', buf('x'));
      await b.delete('k');
      expect(await b.exists('k')).toBe(false);
      await expect(b.delete('k')).resolves.toBeUndefined();
      await b.close?.();
    });

    it('list returns prefix matches sorted ascending', async () => {
      const b = await factory();
      await b.put('inbox/a/003.json', buf('3'));
      await b.put('inbox/a/001.json', buf('1'));
      await b.put('inbox/a/002.json', buf('2'));
      await b.put('inbox/b/001.json', buf('x'));
      await b.put('agents/a.json', buf('reg'));
      const keys = await b.list('inbox/a/');
      expect(keys).toEqual(['inbox/a/001.json', 'inbox/a/002.json', 'inbox/a/003.json']);
      await b.close?.();
    });

    it('list prefix does not bleed into sibling prefixes', async () => {
      const b = await factory();
      await b.put('inbox/a/1.json', buf('1'));
      await b.put('inbox/ab/1.json', buf('2')); // 'inbox/a' is a prefix of 'inbox/ab'
      const keys = await b.list('inbox/a/');
      expect(keys).toEqual(['inbox/a/1.json']);
      await b.close?.();
    });

    it('move relocates a key atomically', async () => {
      const b = await factory();
      await b.put('inbox/a/1.json', buf('payload'));
      await b.move('inbox/a/1.json', 'read/a/1.json');
      expect(await b.exists('inbox/a/1.json')).toBe(false);
      expect((await b.get('read/a/1.json')).toString()).toBe('payload');
      await b.close?.();
    });
  });
}
