/**
 * Worker process for the concurrent-claim test against PostgresBackend.
 * Mirrors test/helpers/claim-worker.ts but takes a Postgres connection URI
 * instead of a SQLite file path.
 *
 * Invoked as:  node --import tsx test/helpers/postgres-claim-worker.ts <pgUrl> <queue> <owner>
 */
import { PostgresBackend } from '../../src/backends/postgres.js';
import { Bus } from '../../src/bus.js';

async function run(): Promise<void> {
  const [pgUrl, queue, owner] = process.argv.slice(2);
  if (!pgUrl || !queue || !owner) {
    process.stderr.write('usage: postgres-claim-worker <pgUrl> <queue> <owner>\n');
    process.exit(64);
  }
  const backend = await PostgresBackend.open(pgUrl);
  const bus = new Bus(backend);
  for (;;) {
    const msg = await bus.claim(queue, owner);
    if (!msg) break;
    process.stdout.write(msg.id + '\n');
  }
  await backend.close();
}

run().catch((err) => {
  process.stderr.write(`postgres-claim-worker failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
