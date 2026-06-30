/**
 * Worker process for the concurrent-append test. Opens the SQLite backend at
 * the given db path and sends `count` messages from `from` to `to`, then exits.
 *
 * Invoked as:  node --import tsx test/helpers/append-worker.ts <db> <from> <to> <count>
 */
import { SqliteBackend } from '../../src/backends/sqlite.js';
import { Bus } from '../../src/bus.js';

async function run(): Promise<void> {
  const [db, from, to, countStr] = process.argv.slice(2);
  if (!db || !from || !to || !countStr) {
    process.stderr.write('usage: append-worker <db> <from> <to> <count>\n');
    process.exit(64);
  }
  const count = Number(countStr);
  const backend = await SqliteBackend.open(db);
  const bus = new Bus(backend);
  for (let i = 0; i < count; i++) {
    await bus.send({ from, to, body: `${from}-${i}`, subject: String(i) });
  }
  await backend.close();
}

run().catch((err) => {
  process.stderr.write(`append-worker failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
