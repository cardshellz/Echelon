import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { isCountryCode, parseCountryCode } from "@shared/country-code";

// The raw Shopify mirror is owned by another application and is deliberately excluded.
const TARGETS = {
  "oms.oms_orders": "ship_to_country",
  "wms.orders": "shipping_country",
  "wms.combined_order_groups": "shipping_country",
} as const;
const tableSchema = z.enum(["oms.oms_orders", "wms.orders", "wms.combined_order_groups"]);
const rowIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/)
  .refine(value => /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807"));
const rowSchema = z.object({
  tableName: tableSchema,
  rowId: rowIdSchema,
  beforeCountry: z.string().min(1).max(100),
  afterCountry: z.string().refine(isCountryCode),
}).strict();
const planSchema = z.object({
  version: z.literal(1),
  rows: z.array(rowSchema).max(500_000),
  unrecognized: z.array(z.object({
    tableName: tableSchema, rowId: rowIdSchema, valueHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).max(500_000),
}).strict();
export type OrderCountryRepairPlan = z.infer<typeof planSchema>;
type RepairRow = OrderCountryRepairPlan["rows"][number];
type QueryClient = Pick<PoolClient, "query">;
const BATCH_SIZE = 500;

export class OrderCountryRepairError extends Error {
  constructor(readonly code: string) { super(code); this.name = "OrderCountryRepairError"; }
}

export function validateOrderCountryRepairPlan(input: unknown): OrderCountryRepairPlan {
  const parsed = planSchema.safeParse(input);
  if (!parsed.success) throw new OrderCountryRepairError("COUNTRY_REPAIR_PLAN_INVALID");
  const seen = new Set<string>();
  for (const row of parsed.data.rows) {
    const key = `${row.tableName}:${row.rowId}`;
    if (seen.has(key) || row.beforeCountry === row.afterCountry) {
      throw new OrderCountryRepairError("COUNTRY_REPAIR_PLAN_INVALID");
    }
    seen.add(key);
    try {
      if (parseCountryCode(row.beforeCountry) !== row.afterCountry) {
        throw new OrderCountryRepairError("COUNTRY_REPAIR_PLAN_INVALID");
      }
    } catch { throw new OrderCountryRepairError("COUNTRY_REPAIR_PLAN_INVALID"); }
  }
  return parsed.data;
}

export function orderCountryRepairDigest(input: unknown): string {
  const plan = validateOrderCountryRepairPlan(input);
  // Explicit field order and stable row ordering make approval independent of JSON formatting.
  const compare = (a: { tableName: string; rowId: string }, b: { tableName: string; rowId: string }) =>
    a.tableName < b.tableName ? -1 : a.tableName > b.tableName ? 1
      : BigInt(a.rowId) < BigInt(b.rowId) ? -1 : BigInt(a.rowId) > BigInt(b.rowId) ? 1 : 0;
  return createHash("sha256").update(JSON.stringify({
    version: plan.version,
    rows: [...plan.rows].sort(compare),
    unrecognized: [...plan.unrecognized].sort(compare),
  })).digest("hex");
}

/** Reads only IDs and countries in one stable snapshot. No missing country is invented. */
export async function planOrderCountryRepair(client: QueryClient): Promise<OrderCountryRepairPlan> {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '30s'");
    const plan: OrderCountryRepairPlan = { version: 1, rows: [], unrecognized: [] };
    for (const [tableName, column] of Object.entries(TARGETS)) {
      const result = await client.query<{ id: string; country: string | null }>(
        `SELECT id::text AS id, ${column} AS country FROM ${tableName} WHERE ${column} IS NOT NULL ORDER BY id`,
      );
      for (const record of result.rows) {
        try {
          const country = parseCountryCode(record.country);
          // Missing/blank addresses remain untouched, including during historical cleanup.
          if (country && country !== record.country) plan.rows.push({
            tableName: tableSchema.parse(tableName), rowId: record.id,
            beforeCountry: record.country!, afterCountry: country,
          });
        } catch {
          plan.unrecognized.push({ tableName: tableSchema.parse(tableName), rowId: record.id,
            valueHash: createHash("sha256").update(String(record.country)).digest("hex") });
        }
      }
    }
    const validated = validateOrderCountryRepairPlan(plan);
    await client.query("COMMIT");
    return validated;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

interface ApplyOptions {
  plan: unknown;
  approvedDigest: string;
  operationKey: string;
  actor: string;
}
export interface OrderCountryRepairProgress { updated: number; alreadyCanonical: number; }

/** Each batch commits the exact country-only change and its audit together.
 * A failed later batch leaves earlier batches audited; retry the same plan/key to resume.
 */
export async function applyOrderCountryRepair(
  pool: Pick<Pool, "connect">,
  options: ApplyOptions,
): Promise<OrderCountryRepairProgress> {
  const plan = validateOrderCountryRepairPlan(options.plan);
  const digest = orderCountryRepairDigest(plan);
  if (options.approvedDigest !== digest) throw new OrderCountryRepairError("COUNTRY_REPAIR_APPROVAL_MISMATCH");
  if (plan.unrecognized.length) throw new OrderCountryRepairError("COUNTRY_REPAIR_UNRECOGNIZED_VALUES");
  for (const value of [options.operationKey, options.actor]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/ -]{0,199}$/.test(value) || value.trim() !== value) {
      throw new OrderCountryRepairError("COUNTRY_REPAIR_ATTRIBUTION_REQUIRED");
    }
  }
  const client = await pool.connect();
  const totals: OrderCountryRepairProgress = { updated: 0, alreadyCanonical: 0 };
  try {
    await inTransaction(client, async () => {
      await client.query(`INSERT INTO oms.order_country_repair_operations(operation_key,plan_digest,actor)
        VALUES($1,$2,$3) ON CONFLICT(operation_key) DO NOTHING`, [options.operationKey, digest, options.actor]);
      const operation = await client.query<{ plan_digest: string; actor: string }>(
        "SELECT plan_digest,actor FROM oms.order_country_repair_operations WHERE operation_key=$1", [options.operationKey]);
      if (operation.rows[0]?.plan_digest !== digest || operation.rows[0]?.actor !== options.actor) {
        throw new OrderCountryRepairError("COUNTRY_REPAIR_OPERATION_REUSED");
      }
    });
    for (const tableName of Object.keys(TARGETS) as Array<keyof typeof TARGETS>) {
      const rows = plan.rows.filter(row => row.tableName === tableName)
        .sort((a, b) => BigInt(a.rowId) < BigInt(b.rowId) ? -1 : 1);
      for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
        const batch = rows.slice(offset, offset + BATCH_SIZE);
        const progress = await inTransaction(client, () => applyBatch(client, tableName, batch, options));
        totals.updated += progress.updated;
        totals.alreadyCanonical += progress.alreadyCanonical;
      }
    }
    return totals;
  } finally { client.release(); }
}

async function inTransaction<T>(client: QueryClient, operation: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
}

async function applyBatch(
  client: QueryClient, tableName: keyof typeof TARGETS, batch: RepairRow[], options: ApplyOptions,
): Promise<OrderCountryRepairProgress> {
  const column = TARGETS[tableName];
  const locked = await client.query<{ id: string; country: string | null }>(
    `SELECT id::text AS id, ${column} AS country FROM ${tableName} WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
    [batch.map(row => row.rowId)],
  );
  const current = new Map(locked.rows.map(row => [row.id, row.country]));
  const changes: RepairRow[] = [];
  for (const row of batch) {
    if (!current.has(row.rowId)) throw new OrderCountryRepairError("COUNTRY_REPAIR_ROW_MISSING");
    if (current.get(row.rowId) === row.afterCountry) continue;
    if (current.get(row.rowId) !== row.beforeCountry) throw new OrderCountryRepairError("COUNTRY_REPAIR_ROW_CHANGED");
    changes.push(row);
  }
  if (!changes.length) return { updated: 0, alreadyCanonical: batch.length };
  const params = changes.flatMap(row => [row.rowId, row.beforeCountry, row.afterCountry]);
  const values = changes.map((_, index) => `($${index * 3 + 1}::bigint,$${index * 3 + 2}::text,$${index * 3 + 3}::text)`).join(",");
  const updated = await client.query(`UPDATE ${tableName} AS target SET ${column}=planned.after_country
    FROM (VALUES ${values}) AS planned(id,before_country,after_country)
    WHERE target.id=planned.id AND target.${column} IS NOT DISTINCT FROM planned.before_country RETURNING target.id`, params);
  if (updated.rowCount !== changes.length) throw new OrderCountryRepairError("COUNTRY_REPAIR_COMPARE_FAILED");
  const start = params.length;
  await client.query(`INSERT INTO oms.order_country_repairs(operation_key,table_name,row_id,before_country,after_country,actor)
    SELECT $${start + 1},$${start + 2},id,before_country,after_country,$${start + 3}
    FROM (VALUES ${values}) AS planned(id,before_country,after_country)`,
  [...params, options.operationKey, tableName, options.actor]);
  return { updated: changes.length, alreadyCanonical: batch.length - changes.length };
}
