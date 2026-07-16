/**
 * Sync the generated harness-plugin subtrees under plugins/ from the root
 * build. Each target gets the compiled library + its shipping payload, a
 * minimal package.json (version from root), and — if it has a manifest — a
 * version stamp. Authored sources (hooks.json for Codex) are NEVER touched.
 *
 * OpenCode is NOT a subtree: OpenCode installs the plugin from the repo root
 * (`github:yonidavidson/agentcomm`, resolved via the root package's
 * `exports["./server"]` → dist/opencode-plugin.js), so it needs no generated
 * package here.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CODEX_HOOKS = [
  'lib.mjs',
  'midturn-digest.mjs',
  'prompt-digest.mjs',
  'session-start.mjs',
  'stop-inbox-guard.mjs',
  'telemetry-capture.mjs',
];

const TARGETS = [
  {
    // Codex: shells out to dist/cli.js via hooks/*.mjs (hand-maintained hooks.json).
    dir: 'agentcomm',
    pkgName: 'agentcomm-codex-plugin',
    copy: ['dist', 'bin', 'skills'],
    hooks: CODEX_HOOKS,
    manifest: '.codex-plugin/plugin.json',
    pkgExtra: {},
  },
];

const rootPkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

for (const t of TARGETS) {
  const plugin = path.join(root, 'plugins', t.dir);

  // Wipe + recopy only what we regenerate (authored hooks.json survives).
  for (const d of t.copy) await rm(path.join(plugin, d), { recursive: true, force: true });
  for (const d of t.copy) await cp(path.join(root, d), path.join(plugin, d), { recursive: true });

  if (t.hooks.length) {
    await mkdir(path.join(plugin, 'hooks'), { recursive: true });
    for (const f of await readdir(path.join(plugin, 'hooks'))) {
      if (f.endsWith('.mjs')) await rm(path.join(plugin, 'hooks', f));
    }
    for (const f of t.hooks) await cp(path.join(root, 'hooks', f), path.join(plugin, 'hooks', f));
  }

  await writeFile(
    path.join(plugin, 'package.json'),
    `${JSON.stringify(
      { name: t.pkgName, version: rootPkg.version, private: true, type: rootPkg.type, engines: rootPkg.engines, ...t.pkgExtra },
      null,
      2,
    )}\n`,
  );

  if (t.manifest) {
    const manifestPath = path.join(plugin, t.manifest);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = rootPkg.version;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
