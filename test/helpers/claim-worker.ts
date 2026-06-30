/**
 * Worker process for the concurrent-claim test. Opens the SQLite backend at
 * the given db path and repeatedly calls `claim` on `queue` until it returns
 * null, recording every message id it claimed to stdout (one per line) so
 * the parent can check disjointness across workers.
 *
 * Invoked as:  node --import tsx test/helpers/claim-worker.ts <db> <queue> <owner>
 */
import { SqliteBackend } from '../../src/backends/sqlite.js';
import { Bus } from '../../src/bus.js';

async function run(): Promise<void> {
  const [db, queue, owner] = process.argv.slice(2);
  if (!db || !queue || !owner) {
    process.stderr.write('usage: claim-worker <db> <queue> <owner>\n');
    process.exit(64);
  }
  const backend = await SqliteBackend.open(db);
  const bus = new Bus(backend);
  for (;;) {
    const msg = await bus.claim(queue, owner);
    if (!msg) break;
    process.stdout.write(msg.id + '\n');
  }
  await backend.close();
}

run().catch((err) => {
  process.stderr.write(`claim-worker failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
