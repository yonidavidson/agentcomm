import { describe, it, expect } from 'vitest';
import { compareVersions, updateMessage } from '../src/update-check.js';

describe('update check', () => {
  it('compares dotted versions numerically (not lexically)', () => {
    expect(compareVersions('0.16.10', '0.16.9')).toBe(1); // 10 > 9, not "10" < "9"
    expect(compareVersions('0.17.0', '0.16.9')).toBe(1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.16.9', '0.16.9')).toBe(0);
    expect(compareVersions('0.16.8', '0.16.9')).toBe(-1);
  });

  it('tolerates a leading v and differing segment counts', () => {
    expect(compareVersions('v0.16.10', '0.16.9')).toBe(1);
    expect(compareVersions('0.16', '0.16.0')).toBe(0);
    expect(compareVersions('0.16.1', '0.16')).toBe(1);
  });

  it('produces a notice only when the release is newer', () => {
    expect(updateMessage('0.16.9', 'v0.16.9', 'claude')).toBeNull(); // same
    expect(updateMessage('0.16.9', 'v0.16.8', 'claude')).toBeNull(); // older release
    const msg = updateMessage('0.16.9', 'v0.17.0', 'claude');
    expect(msg).toContain('update available');
    expect(msg).toContain('v0.16.9 → v0.17.0');
  });

  it('gives every harness the same hardcoded registry upgrade command', () => {
    const opencode = updateMessage('0.16.9', 'v0.17.0', 'opencode');
    const claude = updateMessage('0.16.9', 'v0.17.0', 'claude');
    const codex = updateMessage('0.16.9', 'v0.17.0', 'codex');
    // One story everywhere: reinstall the global CLI from the registry —
    // no version interpolation, so scripts can hardcode it too.
    for (const m of [opencode, claude, codex]) {
      expect(m).toContain('npm install -g @yonidavidson/agentcomm@latest');
      expect(m).toContain('v0.16.9 → v0.17.0');
    }
  });
});
