import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'plugins', 'agentcomm');

await rm(path.join(plugin, 'dist'), { recursive: true, force: true });
await rm(path.join(plugin, 'bin'), { recursive: true, force: true });
await rm(path.join(plugin, 'skills'), { recursive: true, force: true });
await mkdir(path.join(plugin, 'hooks'), { recursive: true });
for (const file of await readdir(path.join(plugin, 'hooks'))) {
  if (file.endsWith('.mjs')) await rm(path.join(plugin, 'hooks', file));
}

await cp(path.join(root, 'dist'), path.join(plugin, 'dist'), { recursive: true });
await cp(path.join(root, 'bin'), path.join(plugin, 'bin'), { recursive: true });
await cp(path.join(root, 'skills'), path.join(plugin, 'skills'), { recursive: true });

for (const file of ['lib.mjs', 'midturn-digest.mjs', 'prompt-digest.mjs', 'session-start.mjs', 'stop-inbox-guard.mjs']) {
  await cp(path.join(root, 'hooks', file), path.join(plugin, 'hooks', file));
}

const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const manifestPath = path.join(plugin, '.codex-plugin', 'plugin.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = packageJson.version;
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
