# Library use & writing a backend plugin

[← README](../README.md)

## Programmatic use

Everything the CLI does rides the same library entry point — another system can
join the bus without shelling out:

```bash
npm install @yonidavidson/agentcomm
```

```ts
import { Bus, createBackend } from '@yonidavidson/agentcomm';

const backend = await createBackend('sqlite:///var/run/team-bus.db');
const bus = new Bus(backend);

await bus.register('dashboard', undefined, 'watching the release train');
await bus.send({ from: 'dashboard', to: 'reviewer', subject: 'status', body: 'CI is green' });
const mail = await bus.inbox('dashboard');   // consuming read, like the CLI
await backend.close?.();
```

`createBackend` accepts every URI the CLI does (`git+ssh://`, `github://`,
`file://`, `sqlite://`, `s3://`, `gs://`, `postgres://`), and `registerBackend()`
adds new schemes. The full surface (conventions, channel discovery, telemetry,
identity helpers) is exported from the package root; `src/index.ts` is the
contract.

### Optional drivers

`git+ssh://` / `git+https://` / `github://` / `file://` need **nothing** more
(Node ≥ 18; the git binary for `git+`; a token for `github://`). Per-backend
drivers install only if you use that backend — the CLI names the exact package
when one is missing:

```bash
npm install better-sqlite3            # sqlite://
npm install @aws-sdk/client-s3        # s3://
npm install @google-cloud/storage     # gs://
npm install pg                        # postgres://
npm install yaml                      # only for .agentcomm.yaml config (.json needs nothing)
```

## Writing a backend plugin

`createBackend` doesn't special-case the built-ins — they're registered through the
exact same seam any third-party package uses:

```ts
import { registerBackend } from '@yonidavidson/agentcomm';
import type { Backend } from '@yonidavidson/agentcomm';

class RedisBackend implements Backend { /* put/get/list/delete/exists/move */ }

registerBackend('redis', async (uri) => new RedisBackend(uri), {
  kind: 'redis',
  capabilities: { claim: true, push: true },
  channel: {
    rule: 'One channel per key namespace — append /<channel> to the URI.',
    template: 'redis://host:6379/<channel>',
    example: 'redis://cache.internal:6379/team-a',
  },
});
```

The third argument (a `BackendInfo`, optional but recommended) makes the scheme
self-describing: `agentcomm describe --backend redis://…` serves it to agents
statically — no driver load, no connection.

Publish that as its own npm package (e.g. `agentcomm-backend-redis`) with a
side-effecting import. Users opt in without touching agentcomm:

```bash
npm install agentcomm-backend-redis
AGENTCOMM_BACKEND_PLUGINS=agentcomm-backend-redis agentcomm send bob hi --backend redis://localhost --as alice
```

`AGENTCOMM_BACKEND_PLUGINS` is a comma/whitespace-separated list of module
specifiers the CLI imports before resolving `--backend`. Implement
`Claimable`/`Waitable`/`Batchable` too if the store can support atomic claims,
push, or many moves in one operation — the Bus feature-detects all three, no
registration needed beyond `Backend` itself. `Batchable` is what keeps
consuming a full mailbox to a single round trip instead of one per message.
