import pg from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabasePoolConfig } from "../database-pool-config";
import { PostgresInventoryCutoverOpeningRepository } from "../modules/inventory-planning/infrastructure/inventory-cutover-opening.repository";
import { lockOpeningCaptureWorker, PostgresInventoryOpeningCaptureRepository } from "../modules/inventory-planning/infrastructure/inventory-opening-capture.repository";
import { runOpeningCapture } from "../modules/inventory-planning/application/inventory-opening-capture.worker";
import { observeInventoryCapture } from "../modules/inventory-planning/infrastructure/inventory-cutover-capture-stage";

const POLL_MS = 2_000;
const MAX_CAPTURE_MS = 10 * 60_000;
const CLEANUP_INTERVAL_MS = 60 * 60_000;
const connectionString = process.env.EXTERNAL_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("Inventory capture worker requires a database connection.");
const pool = new pg.Pool(createDatabasePoolConfig({ connectionString, max: 3,
  ssl: process.env.EXTERNAL_DATABASE_URL || connectionString.includes("amazonaws.com") ? { rejectUnauthorized: false } : undefined,
  connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, query_timeout: 65_000 }));
const log = (entry: Record<string, unknown>) => console.log(JSON.stringify(entry));
const fatal = () => { log({ event: "inventory_opening_capture_worker_stopped", code: "WORKER_INTERRUPTED" }); process.exit(1); };
// Disconnect closes the snapshot/lock; replacement workers fail interrupted
// artifacts rather than mixing old pages with a newly captured snapshot.
pool.on("error", fatal);
process.once("SIGTERM", fatal);
process.once("SIGINT", fatal);

async function main(): Promise<void> {
  const lock = await pool.connect();
  lock.on("error", fatal);
  if (!await lockOpeningCaptureWorker(lock)) {
    lock.release(); await pool.end();
    throw new Error("Another inventory capture worker owns the global lock.");
  }
  const store = new PostgresInventoryOpeningCaptureRepository(pool);
  const source = new PostgresInventoryCutoverOpeningRepository(pool);
  // The repository already validates the complete source DTO. Avoid another
  // full-census copy through the synchronous HTTP service's boundary parser.
  const service = { capture: async (_actor: string, captureId: string) => observeInventoryCapture(async (stage, metrics) => {
    if (!metrics) await store.progress(captureId,stage);
    else log({ event:"inventory_opening_capture_stage",captureId,stage,...metrics });
  }, () => source.capture(new Date())) };
  await store.recoverInterrupted();
  let beating = false;
  const beat = async () => {
    if (beating) return;
    beating = true;
    try { await store.heartbeat(); } catch { fatal(); } finally { beating = false; }
  };
  await beat();
  const heartbeat = setInterval(() => { void beat(); }, 5_000);
  let nextCleanup = performance.now() + CLEANUP_INTERVAL_MS;
  try {
    for (;;) {
      if (performance.now() >= nextCleanup) {
        await store.cleanupExpired();
        nextCleanup = performance.now() + CLEANUP_INTERVAL_MS;
      }
      // A killed/OOM worker releases its session lock and snapshot. Even if a
      // query/serialization hangs, the next worker never resumes partial data.
      const deadline = setTimeout(fatal, MAX_CAPTURE_MS);
      try { await runOpeningCapture(store, service, log); }
      finally { clearTimeout(deadline); }
      await delay(POLL_MS);
    }
  } finally { clearInterval(heartbeat); lock.release(true); await pool.end(); }
}
main().catch(() => { fatal(); });
