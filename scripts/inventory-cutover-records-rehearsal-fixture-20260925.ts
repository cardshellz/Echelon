/** Disposable fixture only: production DDL, reviewed operational fields, synthetic private/cost data. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg, { type PoolClient } from "pg";
import { z } from "zod";
import { buildProposal, readInputs } from "./inventory-cutover-records-proposal-20260925";
import { canonicalHash, captureCleanupTriggerHash, type CleanupRequest } from "./inventory-cutover-records-execution-20260925";

export const SCHEMA_FILE = "records-schema-2026-09-26T01-39-16-013Z.json";
export const SCHEMA_SHA = "e98b4d6f4f44807c2c0224e965d105478cd6592f9207730ca367ac5431e6beb1";
const NOW = "2026-09-25T21:00:00.000Z";
const columnSchema = z.object({ schema: z.string(), table: z.string(), name: z.string(), ordinal: z.number(),
  type: z.string(), not_null: z.boolean(), identity: z.string(), generated: z.string(), default_expression: z.string().nullable() });
const schemaSchema = z.object({ tables: z.array(z.string()), columns: z.array(columnSchema),
  constraints: z.array(z.object({ table: z.string(), name: z.string(), type: z.string(), definition: z.string() })),
  indexes: z.array(z.object({ table: z.string(), name: z.string(), definition: z.string() })),
  triggers: z.array(z.object({ table: z.string(), name: z.string(), definition: z.string(), function_definition: z.string(),
    function_id: z.string(), enabled: z.string() })),
  enums: z.array(z.object({ schema: z.string(), name: z.string(), values: z.union([z.array(z.string()), z.string()]) })),
  triggerHash: z.string(), authority: z.array(z.object({ authority: z.literal("legacy"), revision: z.string() })).length(1),
});
type SchemaCapture = z.infer<typeof schemaSchema>;
type Row = Record<string, unknown>;
const contextSchema = z.object({ orders: z.array(z.record(z.unknown())), lines: z.array(z.record(z.unknown())),
  wmsOrders: z.array(z.record(z.unknown())), wmsItems: z.array(z.record(z.unknown())),
  adjustments: z.array(z.record(z.unknown())), receipts: z.array(z.record(z.unknown())),
  outbound: z.array(z.record(z.unknown())), reviews: z.array(z.record(z.unknown())),
}).passthrough();
export const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const name = (value: string): string => value.split(".").map(quote).join(".");
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export function readSchema(): SchemaCapture {
  const content = readFileSync(resolve("artifacts/inventory-cutover-20260924", SCHEMA_FILE), "utf8");
  assert.equal(createHash("sha256").update(content).digest("hex"), SCHEMA_SHA, "Captured schema hash changed");
  return schemaSchema.parse(JSON.parse(content));
}

async function createTables(client: PoolClient, schema: SchemaCapture): Promise<void> {
  assert.equal((await client.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")).rows[0].count, 0);
  for (const namespace of new Set([...schema.columns.map(column => column.schema), "catalog", "channels"])) {
    await client.query(`CREATE SCHEMA ${quote(namespace)}`);
  }
  for (const item of schema.enums) {
    // pg's name[] aggregate is returned as PostgreSQL array text; use its parser, not string splitting.
    const labels = z.array(z.string()).min(1).parse(Array.isArray(item.values) ? item.values : pg.types.getTypeParser(1009)(item.values));
    await client.query(`CREATE TYPE ${name(`${item.schema}.${item.name}`)} AS ENUM (${labels.map(literal).join(",")})`);
  }
  for (const table of schema.tables) {
    const columns = schema.columns.filter(column => `${column.schema}.${column.table}` === table);
    const definitions: string[] = [];
    for (const column of columns) {
      let suffix = "";
      if (column.generated) suffix = ` GENERATED ALWAYS AS (${column.default_expression}) STORED`;
      else if (column.identity) suffix = ` GENERATED ${column.identity === "a" ? "ALWAYS" : "BY DEFAULT"} AS IDENTITY`;
      else if (column.default_expression) {
        const sequence = /nextval\('([^']+)'::regclass\)/.exec(column.default_expression)?.[1];
        if (sequence) await client.query(`CREATE SEQUENCE IF NOT EXISTS ${name(sequence)}`);
        suffix = ` DEFAULT ${column.default_expression}`;
      }
      definitions.push(`${quote(column.name)} ${column.type}${suffix}${column.not_null ? " NOT NULL" : ""}`);
    }
    await client.query(`CREATE TABLE ${name(table)} (${definitions.join(",")})`);
  }
}

function fixtureRows(context: z.infer<typeof contextSchema>): Record<string, Row[]> {
  const rows: Record<string, Row[]> = {
    "inventory.cutover_admission_fence": [{ singleton_key: true, epoch: "1" }],
    "inventory.availability_runtime_authority": [{ singleton_key: true, authority: "legacy", revision: "1",
      changed_by: "local-rehearsal", change_reason: "Synthetic fixture only" }],
    "oms.oms_orders": context.orders.map(row => ({ ...row, ordered_at: NOW, raw_payload: { fixture: true } })),
    "oms.oms_order_lines": context.lines.map(row => ({ ...row, title: `Fixture ${row.id}`, raw_payload: { fixture: true } })),
    "oms.order_line_adjustments": context.adjustments,
    "oms.channel_order_intakes": context.orders.map(row => ({ provider: row.channel_id === 36 ? "shopify" : row.channel_id === 67 ? "ebay" : "walmart",
      external_order_id: row.external_order_id, channel_id: row.channel_id, oms_order_id: row.id, status: "ingested",
      first_observation_method: "rehearsal", last_observation_method: "rehearsal", is_shippable: false })),
    "oms.oms_order_events": context.orders.map(row => ({ order_id: row.id, event_type: "rehearsal_prior_history", details: { fixture: true } })),
    "oms.oms_order_line_authority_events": context.lines.map(row => ({ event_key: `prior:${row.id}`, event_type: "line_updated",
      order_id: row.order_id, order_line_id: row.id, source_topic: "rehearsal/prior", channel_observed_quantity: row.channel_observed_quantity,
      paid_quantity: row.paid_quantity, authority_fulfillable_quantity: row.authority_fulfillable_quantity,
      authorization_status: row.authorization_status, cancelled_quantity: row.cancelled_quantity, refunded_quantity: row.refunded_quantity })),
    "wms.orders": context.wmsOrders.map(row => ({ ...row, customer_name: "Synthetic rehearsal customer", fulfillment_partition_key: "primary" })),
    "wms.order_items": context.wmsItems.map(row => ({ ...row, name: `Fixture ${row.id}` })),
    "wms.outbound_shipments": context.outbound,
    "oms.channel_fulfillment_receipts": context.receipts.map(row => ({ ...row, receipt_key: `rehearsal:${row.id}`,
      request_hash: "a".repeat(64), event_kind: "updated", source: "rehearsal" })),
    "wms.reconciliation_exceptions": context.reviews.map(row => ({ ...row, source: "rehearsal", classification: "manual_review", summary: "Fixture" })),
  };
  const variantIds = [...new Set(context.lines.flatMap(row => row.product_variant_id == null ? [] : [Number(row.product_variant_id)]))];
  rows["inventory.inventory_levels"] = variantIds.map((variant, index) => ({ id: index + 1, product_variant_id: variant,
    warehouse_location_id: 1, variant_qty: 100, reserved_qty: 2, picked_qty: 3, packed_qty: 4 }));
  rows["inventory.inventory_lots"] = variantIds.map((variant, index) => ({ id: index + 1, lot_number: `REHEARSAL-${index + 1}`,
    product_variant_id: variant, warehouse_location_id: 1, received_at: NOW, qty_on_hand: 100, qty_reserved: 2, qty_picked: 3, qty_packed: 4,
    unit_cost_cents: "123", total_unit_cost_mills: "1230" }));
  rows["inventory.inventory_transactions"] = variantIds.map((variant, index) => ({ id: index + 1, product_variant_id: variant,
    transaction_type: "adjustment", variant_qty_delta: 100, variant_qty_before: 0, variant_qty_after: 100, inventory_lot_id: index + 1 }));
  const firstItem = context.wmsItems.find(row => variantIds.includes(Number(row.product_id)))!;
  assert.ok(firstItem, "A protected stock/cost fixture requires an exact scoped variant");
  rows["oms.order_item_costs"] = [{ id: 1, order_id: firstItem.order_id, order_item_id: firstItem.id,
    inventory_lot_id: variantIds.indexOf(Number(firstItem.product_id)) + 1, product_variant_id: firstItem.product_id,
    qty: 1, unit_cost_cents: "123", total_cost_cents: "123", unit_cost_mills: "1230", total_cost_mills: "1230" }];
  rows["wms.outbound_shipment_items"] = context.outbound.map(row => {
    const item = context.wmsItems.find(item => item.order_id === row.order_id);
    return { shipment_id: row.id, order_item_id: item?.id ?? null, product_variant_id: item?.product_id ?? null,
      qty: 1, shipment_item_purpose: item ? "customer_fulfillment" : "unclassified" };
  });
  rows["oms.channel_fulfillment_pushes"] = context.orders.map((row, index) => ({ oms_order_id: row.id,
    physical_shipment_id: index + 1, channel_provider: "shopify", channel_fulfillment_scope_key: `scope-${index}`,
    command_key: `rehearsal:${index}`, push_status: "review" }));
  return rows;
}

export async function seedFixture(client: PoolClient, schema: SchemaCapture): Promise<{
  request: CleanupRequest; omittedForeignKeys: string[]; tableCounts: Record<string, number>;
}> {
  const { context: rawContext, facts, sources } = readInputs();
  const context = contextSchema.parse(rawContext);
  await createTables(client, schema);
  const rows = fixtureRows(context);
  for (const [table, entries] of Object.entries(rows)) {
    const columns = new Set(schema.columns.filter(column => `${column.schema}.${column.table}` === table && !column.generated).map(column => column.name));
    for (const row of entries) {
      const fields = Object.keys(row).filter(field => columns.has(field));
      await client.query(`INSERT INTO ${name(table)} (${fields.map(quote).join(",")}) OVERRIDING SYSTEM VALUE
        VALUES (${fields.map((_, index) => `$${index + 1}`).join(",")})`, fields.map(field => row[field]));
    }
  }
  for (const column of schema.columns.filter(column => column.identity || column.default_expression?.includes("nextval("))) {
    const table = `${column.schema}.${column.table}`;
    const sequence = column.identity
      ? (await client.query("SELECT pg_get_serial_sequence($1,$2) AS name", [table, column.name])).rows[0].name
      : /nextval\('([^']+)'::regclass\)/.exec(column.default_expression!)![1];
    await client.query(`SELECT setval($1::regclass,COALESCE((SELECT MAX(${quote(column.name)})+100 FROM ${name(table)}),100),false)`, [sequence]);
  }
  for (const constraint of schema.constraints.filter(item => ["p", "u", "c", "x"].includes(item.type))) {
    await client.query(`ALTER TABLE ${name(constraint.table)} ADD CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`);
  }
  const constraintNames = new Set(schema.constraints.map(item => `${item.table.split(".")[0]}.${item.name}`));
  for (const index of schema.indexes) {
    if (!constraintNames.has(`${index.table.split(".")[0]}.${index.name}`)) await client.query(index.definition);
  }
  const omittedForeignKeys: string[] = [];
  for (const constraint of schema.constraints.filter(item => item.type === "f")) {
    const reference = /REFERENCES\s+([a-z_]+\.[a-z_]+)/i.exec(constraint.definition)?.[1];
    if (!reference || !schema.tables.includes(reference)) {
      omittedForeignKeys.push(`${constraint.table}:${constraint.name}`);
      continue;
    }
    // Scoped historical fixture: NOT VALID skips old rows but enforces actual FKs on new/changed keys.
    await client.query(`ALTER TABLE ${name(constraint.table)} ADD CONSTRAINT ${quote(constraint.name)} ${constraint.definition.replace(/ NOT VALID$/i, "")} NOT VALID`);
  }
  const installed = new Set<string>();
  for (const trigger of schema.triggers) {
    assert.equal(trigger.enabled, "O", "Nonstandard trigger mode requires review");
    if (!installed.has(trigger.function_id)) { await client.query(trigger.function_definition); installed.add(trigger.function_id); }
    await client.query(trigger.definition);
  }
  assert.equal(await captureCleanupTriggerHash(client), schema.triggerHash, "Rehearsal trigger definitions differ from production");
  for (const [property, table] of [["orders", "oms.oms_orders"], ["lines", "oms.oms_order_lines"], ["adjustments", "oms.order_line_adjustments"]] as const) {
    const hashes = (await client.query(`SELECT id::text,encode(sha256(convert_to(to_jsonb(row)::text,'UTF8')),'hex') AS hash FROM ${name(table)} row`)).rows;
    context[property] = context[property].map(row => ({ ...row, row_hash: hashes.find(hash => hash.id === String(row.id))?.hash }));
  }
  const request: CleanupRequest = { context, facts, expectedPlanHash: canonicalHash(buildProposal(context, facts)),
    sourceHashes: { context: sources.context.sha256, shopify: sources.shopify.sha256, marketplace: sources.marketplace.sha256 },
    actor: "local-rehearsal-not-production", reason: "Rehearse approved records-only cleanup with synthetic protected values",
    occurredAt: NOW, expectedAuthorityRevision: "1", expectedTriggerHash: schema.triggerHash };
  const tableCounts: Record<string, number> = {};
  for (const table of schema.tables) tableCounts[table] = (await client.query(`SELECT count(*)::int AS count FROM ${name(table)}`)).rows[0].count;
  return { request, omittedForeignKeys, tableCounts };
}

/** All fixture rows, not merely the subset protected by the execution command. Excludes nontransactional sequences. */
export async function snapshot(client: PoolClient, tables: readonly string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const table of tables) {
    const rows = (await client.query(`SELECT to_jsonb(row) AS value FROM ${name(table)} row ORDER BY to_jsonb(row)::text`)).rows;
    result[table] = canonicalHash(rows);
  }
  return result;
}
