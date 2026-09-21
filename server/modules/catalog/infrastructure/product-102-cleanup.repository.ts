import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type {
  Product102CleanupRepositoryPort,
  Product102CleanupTransactionPort,
  StoredCleanupReceipt,
} from "../application/product-102-cleanup.service";
import { lockInventoryCostGraph } from "../../inventory/infrastructure/cost-evidence.repository";
import { correctProduct102CountIdentity } from "../../inventory/infrastructure/product-102-count-identity.repository";
import {
  correctProduct102PurchasingIdentity,
  recordProduct102PurchasingCleanupAudit,
} from "../../procurement/product-102-identity-cleanup.repository";
import {
  PRODUCT_102_CLEANUP_KEY,
  PRODUCT_102_COUNT_IDS,
  PRODUCT_102_UNRELATED_ORDER_IDS,
  cleanupRequire,
  product102CleanupResultSchema,
  type CleanupReference,
  type CleanupSnapshot,
  type Product102CleanupCommand,
  type Product102CleanupResult,
} from "../domain/product-102-cleanup";

const guardedTables = [
  "catalog.products",
  "catalog.product_variants",
  "catalog.product_line_products",
  "catalog.forecast_product_identities",
  "catalog.product_cleanup_receipts",
  "procurement.vendor_products",
  "procurement.purchase_orders",
  "procurement.purchase_order_lines",
  "procurement.po_events",
  "inventory.cycle_count_items",
  "procurement.vendor_invoices",
  "procurement.vendor_invoice_lines",
  "procurement.purchase_forecast_observations",
  "procurement.purchase_forecast_evaluations",
  "public.audit_events",
];
const requiredGuards: Record<string, readonly string[]> = {
  "catalog.forecast_product_identities": [
    "forecast_identity_immutable",
    "forecast_identity_no_truncate",
    "forecast_identity_registration",
  ],
  "catalog.product_cleanup_receipts": [
    "product_cleanup_receipt_immutable",
    "product_cleanup_receipt_no_truncate",
    "product_cleanup_receipt_admission",
    "product_cleanup_completion",
  ],
  "catalog.products": [
    "product_history_removal",
    "product_history_no_truncate",
    "retired_product_id_reuse",
  ],
  "procurement.purchase_forecast_observations": [
    "forecast_register_identity",
    "purchase_forecast_observations_update_guard_trg",
    "purchase_forecast_observations_delete_guard_trg",
  ],
  "procurement.purchase_forecast_evaluations": [
    "purchase_forecast_evaluations_update_guard_trg",
    "purchase_forecast_evaluations_delete_guard_trg",
  ],
};

export class Product102CleanupTransaction
  implements Product102CleanupTransactionPort
{
  constructor(private readonly client: PoolClient) {}

  async schemaReady(): Promise<boolean> {
    return (
      await this.client.query<{
        ready: boolean;
      }>(`SELECT to_regclass('catalog.forecast_product_identities') IS NOT NULL
      AND to_regclass('catalog.product_cleanup_receipts') IS NOT NULL AS ready`)
    ).rows[0].ready;
  }

  private async references(
    parent: string,
    id: number,
  ): Promise<CleanupReference[]> {
    const result = await this.client.query<{
      schema: string;
      table: string;
      column: string;
      constraint: string;
      definition: string;
      count_sql: string;
      total: number;
    }>(
      `
      SELECT n.nspname AS schema,t.relname AS table,a.attname AS column,c.conname AS constraint,
        pg_get_constraintdef(c.oid) AS definition,
        (SELECT count(*)::int FROM pg_constraint WHERE contype='f' AND confrelid=$1::regclass) AS total,
        format('SELECT count(*)::text FROM %I.%I WHERE %I=$1',n.nspname,t.relname,a.attname) AS count_sql
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN LATERAL unnest(c.conkey,c.confkey) k(local_num,foreign_num) ON true
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.local_num
      JOIN pg_attribute p ON p.attrelid=c.confrelid AND p.attnum=k.foreign_num AND p.attname='id'
      WHERE c.contype='f' AND c.confrelid=$1::regclass ORDER BY n.nspname,t.relname,c.conname`,
      [parent],
    );
    cleanupRequire(
      result.rows.length > 0 && result.rows[0].total === result.rows.length,
      "CLEANUP_REFERENCE_SCHEMA_UNSUPPORTED",
      `Missing or non-ID foreign-key inventory for ${parent}.`,
    );
    // PostgreSQL quotes the identifiers; only the fixed parent ID is a bound value.
    const counts = (
      await this.client.query<Record<string, string>>(
        `SELECT ${result.rows
          .map((row, index) => `(${row.count_sql}) AS count_${index}`)
          .join(",")}`,
        [id],
      )
    ).rows[0];
    return result.rows.map(({ count_sql, total, ...row }, index) => ({
      ...row,
      parent,
      id,
      count: z
        .string()
        .regex(/^[0-9]+$/)
        .parse(counts[`count_${index}`]),
    }));
  }

  async capture(): Promise<CleanupSnapshot> {
    const schemaReady = await this.schemaReady();
    const references: CleanupReference[] = [];
    for (const [relation, id] of [
      ["catalog.products", 102],
      ["procurement.vendor_products", 25],
      ["procurement.purchase_order_lines", 39],
      ["procurement.purchase_order_lines", 221],
    ] as const) {
      references.push(...(await this.references(relation, id)));
    }
    const manifest = (
      await this.client.query<{ value: string }>(
        `SELECT jsonb_build_object(
      'references',$1::jsonb,'schemaReady',$2::boolean,
      'triggers',COALESCE((SELECT jsonb_agg(jsonb_build_object('relation',n.nspname||'.'||t.relname,
        'name',g.tgname,'enabled',g.tgenabled,'definition',pg_get_triggerdef(g.oid),'function',pg_get_functiondef(g.tgfoid))
        ORDER BY n.nspname,t.relname,g.tgname)
        FROM pg_trigger g JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE NOT g.tgisinternal AND n.nspname||'.'||t.relname=ANY($3::text[])),'[]'::jsonb),
      'constraints',COALESCE((SELECT jsonb_agg(jsonb_build_object('relation',n.nspname||'.'||t.relname,
        'name',c.conname,'validated',c.convalidated,'definition',pg_get_constraintdef(c.oid)) ORDER BY n.nspname,t.relname,c.conname)
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE n.nspname||'.'||t.relname=ANY($3::text[])),'[]'::jsonb),
      'indexes',COALESCE((SELECT jsonb_agg(jsonb_build_object('relation',schemaname||'.'||tablename,'name',indexname,'definition',indexdef)
        ORDER BY schemaname,tablename,indexname) FROM pg_indexes WHERE schemaname||'.'||tablename=ANY($3::text[])),'[]'::jsonb)
      )::text AS value`,
        [JSON.stringify(references), schemaReady, guardedTables],
      )
    ).rows[0].value;
    const parsed = z
      .object({
        triggers: z.array(
          z.object({
            relation: z.string(),
            name: z.string(),
            enabled: z.string(),
          }),
        ),
        constraints: z.array(
          z.object({
            relation: z.string(),
            name: z.string(),
            validated: z.boolean(),
            definition: z.string(),
          }),
        ),
      })
      .parse(JSON.parse(manifest));
    const guardProblems: string[] = [];
    for (const [relation, names] of Object.entries(requiredGuards))
      for (const name of names) {
        if (
          !parsed.triggers.some(
            (row) =>
              row.relation === relation &&
              row.name === name &&
              row.enabled === "O",
          )
        )
          guardProblems.push(`Missing enabled ${relation}.${name}`);
      }
    const historyFk = parsed.constraints.find(
      (row) =>
        row.relation === "procurement.purchase_forecast_observations" &&
        row.name === "purchase_forecast_observations_product_id_fkey",
    );
    if (
      !historyFk?.validated ||
      !historyFk.definition.includes(
        "REFERENCES catalog.forecast_product_identities(product_id)",
      )
    ) {
      guardProblems.push(
        "Validated historical forecast identity FK is missing",
      );
    }
    const data = (
      await this.client.query<{ value: string }>(
        `SELECT jsonb_build_object(
      'sourceProduct',(SELECT to_jsonb(p) FROM catalog.products p WHERE id=102),
      'products',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM catalog.products p WHERE id IN (5,50)),'[]'::jsonb),
      'variants',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM catalog.product_variants v WHERE product_id IN (5,102) OR id=102),'[]'::jsonb),
      'poHeaders',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM procurement.purchase_orders p WHERE id IN (7,113,134)),'[]'::jsonb),
      'poLines',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM procurement.purchase_order_lines l
        WHERE product_id IN (5,102) OR vendor_product_id IN (25,125) OR id IN (39,153,221)),'[]'::jsonb),
      'suppliers',COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM procurement.vendor_products v WHERE id IN (25,125) OR product_id=102),'[]'::jsonb),
      'invoiceLines',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM procurement.vendor_invoice_lines l
        WHERE purchase_order_line_id IN (39,221) OR id=43),'[]'::jsonb),
      'invoices',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM procurement.vendor_invoices i WHERE id=9 OR id IN
        (SELECT vendor_invoice_id FROM procurement.vendor_invoice_lines WHERE purchase_order_line_id IN (39,221))),'[]'::jsonb),
      'memberships',COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM catalog.product_line_products m WHERE product_id IN (5,102)),'[]'::jsonb),
      'counts',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM inventory.cycle_count_items c WHERE product_id=102 OR id=ANY($1::int[])),'[]'::jsonb),
      'orderItems',COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM wms.order_items i WHERE product_id=102 OR id=ANY($2::int[])),'[]'::jsonb),
      'levels',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM inventory.inventory_levels l WHERE product_variant_id IN
        (SELECT id FROM catalog.product_variants WHERE product_id IN (5,102) OR id=102)),'[]'::jsonb),
      'lots',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM inventory.inventory_lots l WHERE product_variant_id IN
        (SELECT id FROM catalog.product_variants WHERE product_id IN (5,102) OR id=102)),'[]'::jsonb),
      'inventoryTransactionFingerprint',(SELECT md5(COALESCE(string_agg(md5(to_jsonb(t)::text),'' ORDER BY id),''))
        FROM inventory.inventory_transactions t WHERE product_variant_id IN
        (SELECT id FROM catalog.product_variants WHERE product_id IN (5,102) OR id=102)),
      'observations',COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM procurement.purchase_forecast_observations o WHERE product_id IN (5,102)),'[]'::jsonb),
      'evaluations',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM procurement.purchase_forecast_evaluations e WHERE observation_id IN
        (SELECT id FROM procurement.purchase_forecast_observations WHERE product_id IN (5,102))),'[]'::jsonb),
      'contributions',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM procurement.purchase_forecast_overlay_contributions c WHERE observation_id IN
        (SELECT id FROM procurement.purchase_forecast_observations WHERE product_id IN (5,102))),'[]'::jsonb),
      'historyIdentities',${schemaReady ? "COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY product_id) FROM catalog.forecast_product_identities h WHERE product_id IN (5,102)),'[]'::jsonb)" : "'[]'::jsonb"},
      'authority',(SELECT to_jsonb(a) FROM inventory.availability_runtime_authority a WHERE singleton_key=true),
      'fence',(SELECT to_jsonb(f) FROM inventory.cutover_admission_fence f WHERE singleton_key=true),
      'freezes',COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY activation_run_id) FROM inventory.availability_activation_freezes f WHERE released_at IS NULL),'[]'::jsonb),
      'openings',COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM inventory.quantity_ledger_opening o),'[]'::jsonb)
      )::text AS value`,
        [PRODUCT_102_COUNT_IDS, PRODUCT_102_UNRELATED_ORDER_IDS],
      )
    ).rows[0].value;
    return { data, manifest, schemaReady, references, guardProblems };
  }

  async lock(): Promise<void> {
    const fence = await this.client.query(
      "SELECT epoch FROM inventory.cutover_admission_fence WHERE singleton_key=true FOR SHARE NOWAIT",
    );
    const authority = await this.client.query(
      "SELECT singleton_key FROM inventory.availability_runtime_authority WHERE singleton_key=true FOR SHARE",
    );
    cleanupRequire(
      fence.rowCount === 1 && authority.rowCount === 1,
      "CLEANUP_ADMISSION_MISSING",
      "Cutover admission or authority is missing.",
    );
    await this.client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      PRODUCT_102_CLEANUP_KEY,
    ]);
    await lockInventoryCostGraph(drizzle(this.client));
    await this.client.query(
      "SELECT id FROM procurement.purchase_orders WHERE id IN (7,113,134) ORDER BY id FOR UPDATE",
    );
    await this.client.query(
      "SELECT id FROM procurement.purchase_order_lines WHERE purchase_order_id IN (7,113,134) ORDER BY id FOR UPDATE",
    );
    await this.client.query(
      "SELECT id FROM procurement.vendor_invoices WHERE id=9 ORDER BY id FOR SHARE",
    );
    await this.client.query(
      "SELECT id FROM procurement.vendor_invoice_lines WHERE id=43 OR purchase_order_line_id IN (39,221) ORDER BY id FOR SHARE",
    );
    await this.client.query(
      "SELECT id FROM catalog.products WHERE id IN (5,50,102) ORDER BY id FOR UPDATE",
    );
    await this.client.query(
      "SELECT id FROM catalog.product_variants WHERE product_id IN (5,102) OR id=102 ORDER BY id FOR UPDATE",
    );
    await this.client.query(
      "SELECT id FROM procurement.vendor_products WHERE id IN (25,125) OR product_id=102 ORDER BY id FOR UPDATE",
    );
    await this.client.query(
      "SELECT id FROM inventory.cycle_count_items WHERE product_id=102 OR id=ANY($1::int[]) ORDER BY id FOR UPDATE",
      [PRODUCT_102_COUNT_IDS],
    );
    await this.client.query(
      "SELECT id FROM catalog.product_line_products WHERE product_id IN (5,102) ORDER BY id FOR UPDATE",
    );
  }

  async readReceipt(): Promise<StoredCleanupReceipt | null> {
    if (!(await this.schemaReady())) return null;
    const row = (
      await this.client.query(
        `SELECT request_hash,expected_hash,actor_id,approval,before_state::text,after_state::text,
      manifest::text,result FROM catalog.product_cleanup_receipts WHERE command_key=$1`,
        [PRODUCT_102_CLEANUP_KEY],
      )
    ).rows[0];
    return row
      ? {
          requestHash: row.request_hash,
          expectedHash: row.expected_hash,
          actorId: row.actor_id,
          approval: row.approval,
          before: row.before_state,
          after: row.after_state,
          manifest: row.manifest,
          result: product102CleanupResultSchema.parse(row.result),
        }
      : null;
  }

  async expectedAfter(before: string): Promise<string> {
    // Apply the approved field projection in PostgreSQL JSONB. Re-serializing
    // parsed JS objects would corrupt integer financial values above 2^53.
    return (
      await this.client.query<{ value: string }>(
        `SELECT (($1::jsonb-ARRAY['sourceProduct','poLines','suppliers','memberships','counts']) || jsonb_build_object(
      'sourceProduct',NULL,
      'poLines',(SELECT jsonb_agg(CASE (e->>'id')::int WHEN 221 THEN e||'{"product_id":5,"vendor_product_id":125}'::jsonb
        WHEN 39 THEN e||'{"product_id":5}'::jsonb ELSE e END ORDER BY (e->>'id')::int) FROM jsonb_array_elements($1::jsonb->'poLines') e),
      'suppliers',(SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'id')::int),'[]'::jsonb) FROM jsonb_array_elements($1::jsonb->'suppliers') e WHERE e->>'id'<>'25'),
      'memberships',(SELECT COALESCE(jsonb_agg(e ORDER BY (e->>'id')::int),'[]'::jsonb) FROM jsonb_array_elements($1::jsonb->'memberships') e WHERE e->>'id'<>'71'),
      'counts',(SELECT jsonb_agg(e||'{"product_id":5}'::jsonb ORDER BY (e->>'id')::int) FROM jsonb_array_elements($1::jsonb->'counts') e)
      ))::text AS value`,
        [before],
      )
    ).rows[0].value;
  }

  async equal(left: string, right: string): Promise<boolean> {
    return (
      await this.client.query<{ equal: boolean }>(
        "SELECT $1::jsonb=$2::jsonb AS equal",
        [left, right],
      )
    ).rows[0].equal;
  }

  async changedSections(expected: string, actual: string): Promise<string[]> {
    const result = await this.client.query<{ key: string }>(
      `SELECT key FROM (
      SELECT jsonb_object_keys($1::jsonb) AS key UNION SELECT jsonb_object_keys($2::jsonb)
      ) keys WHERE $1::jsonb->key IS DISTINCT FROM $2::jsonb->key ORDER BY key`,
      [expected, actual],
    );
    return result.rows.map((row) => row.key);
  }

  async record(
    command: Product102CleanupCommand,
    requestHash: string,
    before: CleanupSnapshot,
    after: string,
    occurredAt: string,
  ): Promise<Product102CleanupResult> {
    const { auditEventId: audit, poEventIds: poEvents } =
      await recordProduct102PurchasingCleanupAudit(this.client, {
        command,
        requestHash,
        occurredAt,
        before: before.data,
        after,
      });
    const result = product102CleanupResultSchema.parse({
      commandKey: PRODUCT_102_CLEANUP_KEY,
      sourceProductId: 102,
      targetProductId: 5,
      removedSupplierMappingId: 25,
      retainedSupplierMappingId: 125,
      removedMembershipId: 71,
      correctedPoLineIds: [39, 221],
      correctedCountIds: PRODUCT_102_COUNT_IDS,
      auditEventId: audit,
      poEventIds: poEvents,
      occurredAt,
      alreadyApplied: false,
    });
    await this.client.query(
      `INSERT INTO catalog.product_cleanup_receipts(command_key,request_hash,expected_hash,source_product_id,target_product_id,
      actor_id,approval,occurred_at,before_state,after_state,manifest,result,audit_event_id)
      VALUES($1,$2,$3,102,5,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
      [
        PRODUCT_102_CLEANUP_KEY,
        requestHash,
        command.expectedHash,
        command.actorId,
        command.approval,
        occurredAt,
        before.data,
        after,
        before.manifest,
        JSON.stringify(result),
        audit,
      ],
    );
    return result;
  }

  async mutate(): Promise<void> {
    await correctProduct102PurchasingIdentity(this.client);
    await correctProduct102CountIdentity(this.client);
    const operations: [string, unknown[], number][] = [
      [
        "DELETE FROM catalog.product_line_products WHERE id=71 AND product_id=102",
        [],
        1,
      ],
      ["DELETE FROM catalog.products WHERE id=102 AND is_active=false", [], 1],
    ];
    for (const [statement, values, expected] of operations) {
      cleanupRequire(
        (await this.client.query(statement, values)).rowCount === expected,
        "CLEANUP_WRITE_SCOPE_CHANGED",
        "The exact write row count changed.",
      );
    }
  }

  async assertAudit(receipt: StoredCleanupReceipt): Promise<void> {
    const result = (
      await this.client.query<{ valid: boolean }>(
        `SELECT
      EXISTS(SELECT 1 FROM public.audit_events WHERE id=$1 AND actor=$2 AND action='catalog.product_identity_removed'
        AND target='product:102' AND context->>'requestHash'=$3 AND context->>'commandKey'=$4 AND timestamp=$5::timestamptz
        AND changes->>'stateHash'=$9)
      AND (SELECT count(*) FROM procurement.po_events p WHERE p.id=ANY($6::bigint[]) AND p.actor_id=$2 AND p.actor_type='user'
        AND p.event_type='product_identity_corrected' AND p.payload_json->>'commandKey'=$4
        AND p.created_at=$5::timestamptz AT TIME ZONE 'UTC'
        AND ((p.po_id=7 AND p.payload_json->>'lineId'='39') OR (p.po_id=134 AND p.payload_json->>'lineId'='221'))
        AND p.payload_json->'before'=(SELECT e FROM jsonb_array_elements($7::jsonb->'poLines') e WHERE e->>'id'=p.payload_json->>'lineId')
        AND p.payload_json->'after'=(SELECT e FROM jsonb_array_elements($8::jsonb->'poLines') e WHERE e->>'id'=p.payload_json->>'lineId'))=2 AS valid`,
        [
          receipt.result.auditEventId,
          receipt.actorId,
          receipt.requestHash,
          PRODUCT_102_CLEANUP_KEY,
          receipt.result.occurredAt,
          receipt.result.poEventIds,
          receipt.before,
          receipt.after,
          receipt.expectedHash,
        ],
      )
    ).rows[0];
    cleanupRequire(
      result.valid,
      "CLEANUP_AUDIT_INVALID",
      "Cleanup audit or PO history differs from the immutable receipt.",
    );
  }
}

export class Product102CleanupRepository
  implements Product102CleanupRepositoryPort
{
  constructor(private readonly pool: Pool) {}
  async transaction<T>(
    readOnly: boolean,
    work: (transaction: Product102CleanupTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let began = false,
      committing = false,
      discard: Error | undefined;
    try {
      await client.query(
        readOnly
          ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
          : "BEGIN ISOLATION LEVEL SERIALIZABLE",
      );
      began = true;
      await client.query("SET LOCAL lock_timeout='2s'");
      await client.query("SET LOCAL statement_timeout='30s'");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const result = await work(new Product102CleanupTransaction(client));
      committing = true;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (!began)
        discard =
          error instanceof Error
            ? error
            : new Error("Transaction start was not confirmed.");
      else
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          discard =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("Rollback was not confirmed.");
          throw new AggregateError(
            [error, rollbackError],
            "Cleanup outcome uncertain. Verify the original command before retrying.",
          );
        }
      if (
        committing &&
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string" &&
          /^[0-9A-Z]{5}$/.test(error.code) &&
          !error.code.startsWith("08") &&
          !["40003", "57P01", "57P02", "57P03"].includes(error.code)
        )
      ) {
        // Connection loss during COMMIT is not proof of rollback. A retry must
        // use the original durable key and approval; never invent a new key.
        discard =
          error instanceof Error
            ? error
            : new Error("Commit acknowledgement was lost.");
        throw new AggregateError(
          [error],
          "Cleanup commit outcome uncertain. Run --verify before retrying the identical command.",
        );
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
}
