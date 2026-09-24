/** Read-only cross-system preview. No enqueue/apply mode exists in this script.
 * Credentials are supplied through ECHELON_PREVIEW_DATABASE_URL and
 * ARCHON_PREVIEW_DATABASE_URL; only IDs and monetary evidence leave the process. */
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { loadArchonSnapshot } from "../server/modules/oms/archon-order-delivery";
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      Number.isFinite(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
  );
const cents = z.coerce.number().int().nonnegative().safe();
function pool(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  // Heroku URLs can reference a Linux CA file. This operator-only read preview
  // uses the explicit Node TLS configuration below on Windows as well.
  for (const option of ["sslmode", "sslrootcert", "sslcert", "sslkey"])
    url.searchParams.delete(option);
  return new Pool({
    connectionString: url.href,
    max: 1,
    connectionTimeoutMillis: 10000,
    query_timeout: 15000,
    ssl: local
      ? undefined
      : {
          rejectUnauthorized:
            process.env.PREVIEW_ALLOW_UNVERIFIED_TLS !== "true",
        },
  });
}
interface PreviewRow {
 archonId:number; echelonId?:number; providerOrderId?:string; before:Record<string,number|null>;after?:Record<string,number>;
 sourceRevision?:string|null;receivedRevision?:string|null;status:"missing_echelon_link"|"reconciled"|"awaiting_provider_breakdown";
 changedFields?:string[];financials?:unknown;existingEvidence?:boolean;
}
async function main() {
  const [startArg, endArg, workspaceArg, output] = process.argv.slice(2);
  const start = date.parse(startArg),
    end = date.parse(endArg),
    workspace = z.coerce.number().int().positive().parse(workspaceArg);
  if (
    !output ||
    Date.parse(end) < Date.parse(start) ||
    Date.parse(end) - Date.parse(start) > 31 * 86400000
  )
    throw new Error(
      "Provide start/end dates (maximum 31 days), workspace ID and output file",
    );
  const archon = pool("ARCHON_PREVIEW_DATABASE_URL"),
    echelon = pool("ECHELON_PREVIEW_DATABASE_URL");
  try {
    let a: PoolClient | undefined, e: PoolClient | undefined;
    try {
      console.log("Connecting to read-only sources...");
      a = await archon.connect();
      e = await echelon.connect();
      await a.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await e.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await a.query("SET LOCAL statement_timeout='10s'");
      await e.query("SET LOCAL statement_timeout='10s'");
      const found = await a.query(
        `SELECT id,echelon_order_id,source,external_order_id,total_cents,subtotal_cents,shipping_cents,tax_cents,discount_cents,refund_cents,echelon_revision,discount_evidence
 FROM public.customer_orders WHERE workspace_id=$1 AND currency='USD' AND financial_status IN ('paid','partially_refunded','refunded') AND total_cents IS NOT NULL
 AND ordered_at>=($2::date::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC'
 AND ordered_at<(($3::date+1)::timestamp AT TIME ZONE 'America/New_York') AT TIME ZONE 'UTC' ORDER BY id LIMIT 1001`,
        [workspace, start, end],
      );
      if (found.rows.length > 1000)
        throw new Error("Preview exceeds 1000 orders; narrow the dates");
      console.log(`Previewing ${found.rows.length} orders (read only)...`);
      const rows:PreviewRow[] = [];
      const fields = [
        "total_cents",
        "subtotal_cents",
        "shipping_cents",
        "tax_cents",
        "discount_cents",
        "refund_cents",
      ] as const;
      for (const row of found.rows) {
        const before = Object.fromEntries(
          fields.map((k) => [k, row[k] === null ? null : cents.parse(row[k])]),
        );
        if (!row.echelon_order_id) {
          rows.push({
            archonId: row.id,
            status: "missing_echelon_link",
            before,
          });
          continue;
        }
        const revision = await e.query(
          "SELECT revision::text FROM oms.archon_order_outbox WHERE order_id=$1",
          [row.echelon_order_id],
        );
        const snapshot = await loadArchonSnapshot(
          e,
          Number(row.echelon_order_id),
          revision.rows[0]?.revision ?? "1",
        );
        const f = snapshot.order.discount_evidence?.financials;
        const after = Object.fromEntries(
          fields.map((k) => [k, snapshot.order[k]]),
        );
        rows.push({
          archonId: row.id,
          echelonId: Number(row.echelon_order_id),
          providerOrderId: row.external_order_id,
          before,
          after,
          sourceRevision: revision.rows[0]?.revision ?? null,
          receivedRevision: row.echelon_revision,
          status: f ? "reconciled" : "awaiting_provider_breakdown",
          changedFields: fields.filter((k) => before[k] !== after[k]),
          financials: f ?? null,
          existingEvidence: row.discount_evidence !== null,
        });
      }
      const sum = (side: "before" | "after", field: string) =>
        rows
          .reduce((total, row) => {
            const value = (
              side === "after" && "after" in row ? row.after : row.before
            )?.[field];
            if (value === null || value === undefined)
              throw new Error("Unknown amount cannot form a total");
            return total + BigInt(value);
          }, BigInt(0))
          .toString();
      const result = {
        readOnly: true,
        workspace,
        start,
        end,
        currency: "USD",
        orders: rows.length,
        reconciled: rows.filter((r) => r.status === "reconciled").length,
        changedOrders: rows.filter(
          (r) => (r.changedFields?.length ?? 0) > 0,
        ).length,
        oldTotalCents: sum("before", "total_cents"),
        proposedTotalCents: sum("after", "total_cents"),
        oldRefundCents: sum("before", "refund_cents"),
        proposedRefundCents: sum("after", "refund_cents"),
        fingerprint: createHash("sha256")
          .update(JSON.stringify(rows))
          .digest("hex"),
        rows,
      };
      await a.query("ROLLBACK");
      await e.query("ROLLBACK");
      await writeFile(output, JSON.stringify(result, null, 2));
      console.log(
        JSON.stringify({ ...result, rows: undefined, output }, null, 2),
      );
    } finally {
      await a?.query("ROLLBACK").catch(() => {});
      await e?.query("ROLLBACK").catch(() => {});
      a?.release();
      e?.release();
    }
  } finally {
    await archon.end();
    await echelon.end();
  }
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Preview failed");
  process.exitCode = 1;
});
