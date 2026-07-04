import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveGithubToken } from './github.js';

const execFileP = promisify(execFile);

/**
 * The "already on the network" default: inside a git work tree whose
 * `origin` points at github.com — with a resolvable token — the repo itself
 * is the natural bus, so `github://owner/repo` beats the file:// fallback.
 * Only consulted when nothing explicit chose a backend (flag, env, config
 * file); returns null whenever any prerequisite is missing, which restores
 * the classic `file://./.agentcomm` default.
 */
export async function detectRepoBus(cwd = process.cwd()): Promise<string | null> {
  let originUrl: string;
  try {
    const inTree = await execFileP('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree']);
    if (inTree.stdout.trim() !== 'true') return null;
    originUrl = (await execFileP('git', ['-C', cwd, 'remote', 'get-url', 'origin'])).stdout.trim();
  } catch {
    return null; // no git, not a repo, or no origin remote
  }

  const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(originUrl);
  if (!m) return null; // origin isn't github.com (gitlab/bitbucket/private → file fallback)

  try {
    await resolveGithubToken();
  } catch {
    return null; // no way to talk to the API — don't select a backend that can't open
  }
  return `github://${m[1]}/${m[2]}`;
}
