/** Read-only evidence for the owner-requested 102 -> 5 cleanup. No apply mode. */
import { createHash } from "node:crypto";
import pg from "pg";

const supplied = process.env.ECHELON_READONLY_DATABASE_URL;
if (!supplied || process.env.ECHELON_READONLY_DIAGNOSTIC !== "true") {
  throw new Error("An explicitly authorized read-only connection is required.");
}
if (process.argv.slice(2).length) throw new Error("This inspection accepts no arguments or write mode.");
const url = new URL(supplied);
if (url.searchParams.get("sslrootcert") === "/etc/ssl/certs/ca-certificates.crt") {
  url.searchParams.set("sslrootcert", "C:/Program Files/Git/mingw64/etc/ssl/certs/ca-bundle.crt");
}
if (url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "verify-full") {
  throw new Error("Verified TLS is required.");
}
delete process.env.ECHELON_READONLY_DATABASE_URL;
const pool = new pg.Pool({ connectionString: url.toString(), max: 1, ssl: { rejectUnauthorized: true },
  connectionTimeoutMillis: 10000, application_name: "codex_product102_cleanup_review",
  options: "-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=2000" });

try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const sections: Record<string, string> = {
      linkedInvoice: `SELECT to_jsonb(l) AS line,to_jsonb(i) AS invoice
        FROM procurement.vendor_invoice_lines l JOIN procurement.vendor_invoices i ON i.id=l.vendor_invoice_id
        WHERE l.purchase_order_line_id IN (39,221) ORDER BY l.id`,
      products: `SELECT id,sku,name,status,is_active,inventory_type,created_at,updated_at,
        md5(to_jsonb(p)::text) AS row_fingerprint FROM catalog.products p WHERE id IN (5,102) ORDER BY id`,
      variants: `SELECT id,product_id,sku,units_per_variant,is_active,uom_type FROM catalog.product_variants
        WHERE product_id IN (5,102) ORDER BY id`,
      counts: `SELECT i.id,i.cycle_count_id,i.product_id,i.product_variant_id,i.warehouse_location_id,
        i.expected_sku,i.counted_sku,i.expected_qty,i.counted_qty,i.variance_qty,i.status,
        i.adjustment_transaction_id,i.related_item_id, v.product_id AS variant_product_id,v.sku AS variant_sku,
        md5(to_jsonb(i)::text) AS row_fingerprint
        FROM inventory.cycle_count_items i LEFT JOIN catalog.product_variants v ON v.id=i.product_variant_id
        WHERE i.product_id=102 ORDER BY i.id`,
      orders: `SELECT i.id,i.order_id,i.product_id,i.sku,i.quantity,i.picked_quantity,i.fulfilled_quantity,i.status,
        o.warehouse_status,o.cancelled_at, v.id AS sku_variant_id,v.product_id AS sku_product_id,
        md5(to_jsonb(i)::text) AS row_fingerprint
        FROM wms.order_items i JOIN wms.orders o ON o.id=i.order_id
        LEFT JOIN catalog.product_variants v ON v.sku=i.sku WHERE i.product_id=102 ORDER BY i.id,v.id`,
      purchaseLines: `SELECT l.id,l.purchase_order_id,l.product_id,l.vendor_product_id,l.product_variant_id,
        l.expected_receive_variant_id,l.expected_receive_units_per_variant,l.status,l.order_qty,l.received_qty,
        l.cancelled_qty,l.unit_of_measure,l.units_per_uom,
        md5(to_jsonb(l)::text) AS row_fingerprint FROM procurement.purchase_order_lines l
        WHERE product_id=102 OR vendor_product_id IN (25,125) ORDER BY id`,
      supplierMappings: `SELECT id,vendor_id,product_id,product_variant_id,is_active,pack_size,
        unit_cost_cents::text,unit_cost_mills::text,md5(to_jsonb(v)::text) AS row_fingerprint
        FROM procurement.vendor_products v WHERE id IN (25,125) OR product_id=102 ORDER BY id`,
      supplierIndexes: `SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname='procurement' AND tablename='vendor_products' ORDER BY indexname`,
      productLines: `SELECT id,product_line_id,product_id,created_at FROM catalog.product_line_products
        WHERE product_id IN (5,102) ORDER BY product_line_id,product_id`,
      forecasts: `SELECT o.id,o.run_id,o.product_id,o.selected_receive_variant_id,o.product_sku,o.scope,
        o.forecast_daily_pieces_micros::text,o.baseline_daily_pieces_micros::text,
        o.forward_demand_pieces,o.forward_demand_raw_pieces,o.created_at,
        (SELECT count(*)::int FROM procurement.purchase_forecast_observations target
          WHERE target.product_id=5 AND target.run_id=o.run_id AND target.scope=o.scope) AS target_collisions,
        (SELECT count(*)::int FROM procurement.purchase_forecast_evaluations e WHERE e.observation_id=o.id) AS evaluations,
        (SELECT count(*)::int FROM procurement.purchase_forecast_overlay_contributions c WHERE c.observation_id=o.id) AS contributions,
        md5(to_jsonb(o)::text) AS row_fingerprint
        FROM procurement.purchase_forecast_observations o WHERE o.product_id=102 ORDER BY o.id`,
      guards: `SELECT n.nspname,t.relname,g.tgname,g.tgenabled,pg_get_triggerdef(g.oid) AS definition,
        pg_get_functiondef(g.tgfoid) AS function_definition FROM pg_trigger g
        JOIN pg_class t ON t.oid=g.tgrelid JOIN pg_namespace n ON n.oid=t.relnamespace
        WHERE NOT g.tgisinternal AND g.tgrelid IN ('inventory.cycle_count_items'::regclass,
          'wms.order_items'::regclass,'procurement.purchase_forecast_observations'::regclass,
          'catalog.product_line_products'::regclass) ORDER BY n.nspname,t.relname,g.tgname`,
      authority: `SELECT jsonb_build_object(
        'authority',(SELECT to_jsonb(a) FROM inventory.availability_runtime_authority a WHERE singleton_key=true),
        'freezes',(SELECT count(*) FROM inventory.availability_activation_freezes WHERE released_at IS NULL),
        'openings',(SELECT count(*) FROM inventory.quantity_ledger_opening)) AS evidence`,
    };
    const fingerprint = createHash("sha256");
    for (const [section, sql] of Object.entries(sections)) {
      // PostgreSQL serializes the original values before Node sees them: bigint
      // values and forensic hashes never pass through a lossy number conversion.
      const result = await client.query<{ evidence: string }>(
        `SELECT COALESCE(jsonb_agg(to_jsonb(evidence_row)),'[]'::jsonb)::text AS evidence FROM (${sql}) evidence_row`,
      );
      const evidence = result.rows[0]?.evidence;
      if (typeof evidence !== "string") throw new Error(`Missing ${section} evidence.`);
      fingerprint.update(section).update("\n").update(evidence).update("\n");
      console.log(JSON.stringify({ section, evidence }));
    }
    const references = await client.query<{ relation: string; definition: string; count_sql: string }>(`
      SELECT c.confrelid::regclass::text AS relation,pg_get_constraintdef(c.oid) AS definition,
        format('SELECT count(*)::int AS n FROM %I.%I WHERE %I IN (SELECT id FROM procurement.purchase_forecast_observations WHERE product_id=102)',
          n.nspname,t.relname,a.attname) AS count_sql
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      JOIN LATERAL unnest(c.conkey,c.confkey) k(local_num,foreign_num) ON true
      JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=k.local_num
      JOIN pg_attribute parent ON parent.attrelid=c.confrelid AND parent.attnum=k.foreign_num
      WHERE c.contype='f' AND c.confrelid='procurement.purchase_forecast_observations'::regclass AND parent.attname='id'
      ORDER BY n.nspname,t.relname,c.conname`);
    for (const { count_sql, ...reference } of references.rows) {
      console.log(JSON.stringify({ section: "forecastReferences", ...reference, count: (await client.query(count_sql)).rows[0].n }));
    }
    const clock = (await client.query("SELECT transaction_timestamp()::text AS captured_at,current_setting('transaction_read_only') AS read_only")).rows[0];
    console.log(JSON.stringify({ ...clock, evidenceHash: fingerprint.digest("hex"), purpose: "Review evidence, not an apply token" }));
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
} catch (error) {
  const detail = error as { name?: string; code?: string; message?: string };
  console.error(JSON.stringify({ failed: true, name: detail.name, code: detail.code, message: detail.message }));
  process.exitCode = 1;
} finally { await pool.end(); }
