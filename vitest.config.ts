import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Most suites here are REAL e2e: they spawn the CLI as child processes
    // (tsx boot ≈ 0.5–2s each) and several chain 10+ spawns per test. The
    // 5s default is margin-less on a loaded runner or laptop; unit tests
    // don't care about the extra headroom.
    testTimeout: 30000,
    fileParallelism: false,
    // A CLI spawned without an explicit cwd inherits THIS repo's — and this
    // repo is on its own bus, so connect-time provisioning would rewrite our
    // committed harness wiring mid-run. Off by default; the suite that covers
    // provisioning turns it back on per spawn.
    env: { AGENTCOMM_NO_AUTO_HOOKS: '1' },
  },
});
