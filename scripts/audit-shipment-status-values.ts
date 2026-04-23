/**
 * Audit: pre-migration gate for `wms.outbound_shipments.status` values.
 *
 * Plan reference: shipstation-flow-refactor-plan.md §4.3, §6 Group A Commit 4.
 *
 * Purpose:
 *   Migration 060_outbound_shipments_expand.sql converts
 *   `wms.outbound_shipments.status` from a free-form varchar(20) into the
 *   new PG enum `wms.shipment_status`. The enum cast will FAIL at ALTER
 *   TABLE time if any existing row holds a status value that does not map
 *   cleanly into the new enum set.
 *
 *   Known in-use values today (per
 *   shared/schema/orders.schema.ts:~348 inline comment):
 *     pending, packed, shipped, delivered
 *
 *   Mapping applied by migration 060 (Phase 2b):
 *     pending    -> planned
 *     packed     -> queued
 *     shipped    -> shipped   (unchanged)
 *     delivered  -> shipped   (plan decision — we don't yet track
 *                              delivered as a terminal state; a separate
 *                              column/table will capture delivery later)
 *
 *   New enum members (migration 060 Phase 2a):
 *     planned, queued, labeled, shipped,
 *     on_hold, voided, cancelled, returned, lost
 *
 *   Any row whose current `status` is OUTSIDE
 *   {pending, packed, shipped, delivered} has no defined mapping and would
 *   either fail the enum cast or land in a nonsensical target state. This
 *   script refuses the migration in that case.
 *
 * Safety:
 *   - Read-only. No writes. No `--execute` flag. No flags at all.
 *   - Idempotent: running it repeatedly is safe and side-effect free.
 *   - Exits 0 if the table's status distribution is fully mappable.
 *   - Exits 1 if any unknown status is found, with a BLOCKING banner.
 *
 * Run command (Heroku):
 *
 *   heroku run -a cardshellz-echelon -- "npx tsx scripts/audit-shipment-status-values.ts"
 */

import { db } from "../server/db";
import { sql } from "drizzle-orm";

const KNOWN_STATUSES = new Set<string>([
  "pending",
  "packed",
  "shipped",
  "delivered",
]);

interface StatusRow {
  status: string | null;
  n: number;
}

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("=== Audit: wms.outbound_shipments.status distribution ===");
  // eslint-disable-next-line no-console
  console.log("Plan ref: shipstation-flow-refactor-plan.md §4.3, §6 Commit 4");
  // eslint-disable-next-line no-console
  console.log("");

  const result = await db.execute<StatusRow>(sql`
    SELECT status, COUNT(*)::int AS n
    FROM wms.outbound_shipments
    GROUP BY status
    ORDER BY n DESC
  `);

  const rows: StatusRow[] = (result.rows ?? []).map((r: any) => ({
    status: r.status,
    n: Number(r.n),
  }));

  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log("(no rows in wms.outbound_shipments)");
    // eslint-disable-next-line no-console
    console.log("Result: CLEAN — migration 060 is safe to run.");
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log("status                        |         count");
  // eslint-disable-next-line no-console
  console.log("------------------------------+--------------");
  for (const r of rows) {
    const s = (r.status ?? "(NULL)").padEnd(30, " ");
    const n = String(r.n).padStart(13, " ");
    // eslint-disable-next-line no-console
    console.log(`${s}|${n}`);
  }
  // eslint-disable-next-line no-console
  console.log("");

  const unknown = rows.filter((r) => !(r.status !== null && KNOWN_STATUSES.has(r.status)));

  if (unknown.length === 0) {
    // eslint-disable-next-line no-console
    console.log(
      "Result: CLEAN — every status maps cleanly into wms.shipment_status.",
    );
    // eslint-disable-next-line no-console
    console.log("        Migration 060 is safe to run.");
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.error("");
  // eslint-disable-next-line no-console
  console.error(
    "BLOCKING: migration 060 will fail. Found unknown status value(s):",
  );
  for (const r of unknown) {
    const s = r.status === null ? "(NULL)" : JSON.stringify(r.status);
    // eslint-disable-next-line no-console
    console.error(`  - ${s}  (count=${r.n})`);
  }
  // eslint-disable-next-line no-console
  console.error("");
  // eslint-disable-next-line no-console
  console.error(
    "Resolve these rows (normalise their status, or add the value to the enum AND the mapping in migration 060) before running the migration.",
  );
  process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("audit-shipment-status-values.ts: fatal error");
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(2);
});
