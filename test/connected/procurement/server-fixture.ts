import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcrypt";
import type { Pool } from "pg";
import { getTableConfig } from "drizzle-orm/pg-core";
import * as schema from "../../../shared/schema";
import { createQuantityLedgerTestContextInDatabase, prepareQuantityLotCreationMetadata } from "../../../server/modules/inventory/__tests__/fixtures/quantity-ledger-database";
import type { InventoryCutoverTestDatabase } from "../../../server/modules/inventory/__tests__/fixtures/inventory-cutover-database";
import { fixtureColumnDefinitions, fixtureForeignKeys, fixtureTable, qualifiedTable } from "../../../server/modules/procurement/__tests__/integration/shipment-line-fixture";
import { installQuantityAmendmentFixture } from "../../../server/modules/procurement/__tests__/integration/quantity-amendment-fixture";
import { installConnectedNavigationFixture } from "./navigation-fixture";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../../server/modules/inventory-planning/infrastructure/inventory-cutover-admission-fence.repository";

export const CONNECTED_TIME = new Date("2026-10-25T12:00:00.000Z");
export const CONNECTED_PASSWORD = "connected-local-password-v1";
export const CONNECTED_ACTORS = [
  { id: "connected-receiver", username: "connected-receiver", role: "lead", roleId: 1 },
  { id: "connected-picker", username: "connected-picker", role: "picker", roleId: 4 },
  { id: "connected-viewer", username: "connected-viewer", role: "lead", roleId: 2 },
  { id: "connected-second-receiver", username: "connected-second-receiver", role: "lead", roleId: 5 },
  { id: "connected-admin", username: "connected-admin", role: "admin", roleId: 3 },
  { id: "connected-catalog-creator", username: "connected-catalog-creator", role: "lead", roleId: 6 },
  { id: "connected-creator", username: "connected-creator", role: "picker", roleId: 7 },
  { id: "connected-editor", username: "connected-editor", role: "picker", roleId: 8 },
] as const;

/** The ledger fixture intentionally has reduced catalog/warehouse prerequisites.
 * Add the current owners' real column definitions so their HTTP reads execute
 * unchanged. This is still a reduced schema, not a full release migration replay. */
async function addOwnerReadColumns(pool: Pool): Promise<void> {
  for (const table of [schema.products, schema.productVariants, schema.warehouses, schema.warehouseLocations, schema.productLocations]) {
    const definition = getTableConfig(table);
    const columns = await pool.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2",
      [definition.schema ?? "public", definition.name],
    );
    const existing = new Set(columns.rows.map(row => row.column_name));
    for (const column of fixtureColumnDefinitions(table)) {
      if (!existing.has(column.name)) await pool.query(`ALTER TABLE ${qualifiedTable(table)} ADD COLUMN ${column.definition}`);
    }
  }
  // The opening fixture inserts catalog identities explicitly. Real catalog
  // creation also needs the owners' generated identities and active-SKU guard
  // (shared/schema/catalog.schema.ts and migration 0251).
  await pool.query(`ALTER TABLE catalog.products ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (START WITH 1000);
    ALTER TABLE catalog.product_variants ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (START WITH 1000);
    CREATE UNIQUE INDEX product_variants_sku_active_unique ON catalog.product_variants (UPPER(sku))
      WHERE is_active = true AND sku IS NOT NULL`);
}

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), "migrations", name), "utf8");
}

async function installReceiptCostEvidence(pool: Pool): Promise<void> {
  const evidence = migration("222_procurement_cost_evidence.sql");
  const sections = [
    ["CREATE TABLE IF NOT EXISTS procurement.receipt_cost_requests (", "CREATE OR REPLACE FUNCTION inventory.reject_cost_evidence_mutation"],
    ["CREATE TABLE IF NOT EXISTS inventory.lot_cost_origins (", "CREATE TABLE IF NOT EXISTS inventory.lot_cost_contributions ("],
  ] as const;
  const existing = await pool.query("SELECT count(*)::int AS count FROM inventory.lot_cost_origins");
  if (existing.rows[0].count !== 0) throw new Error("Connected fixture origin prerequisite was not empty");
  await pool.query("DROP TABLE inventory.lot_cost_origins");
  for (const [begin, finish] of sections) {
    const start = evidence.indexOf(begin);
    const end = evidence.indexOf(finish, start);
    if (start < 0 || end < start) throw new Error("Connected fixture cost migration boundary changed");
    await pool.query(evidence.slice(start, end));
  }
  await installQuantityAmendmentFixture(pool);
  await pool.query(`CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON inventory.lot_cost_origins
    FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();
    CREATE TRIGGER cost_evidence_immutable BEFORE UPDATE OR DELETE ON inventory.lot_cost_origins
    FOR EACH ROW EXECUTE FUNCTION inventory.reject_cost_evidence_mutation()`);
}

/** Owns one unique disposable database. No seeded document corresponds to a live
 * PO, shipment or receipt; the existing ledger opening is synthetic evidence. */
export async function createConnectedReceivingDatabase(database: InventoryCutoverTestDatabase) {
  const context = await createQuantityLedgerTestContextInDatabase(database);
  try {
    const pool = context.pool;
    await pool.query("CREATE SCHEMA identity");
    const identityTables = [schema.users, schema.authRoles, schema.authPermissions, schema.authRolePermissions, schema.authUserRoles] as const;
    const receivingTables = [schema.vendors, schema.purchaseOrders, schema.purchaseOrderLines,
      schema.inboundShipments, schema.inboundShipmentLines, schema.inboundFreightCosts, schema.inboundFreightAllocations,
      schema.receivingOrders, schema.receivingLines,
      schema.poReceipts, schema.poStatusHistory, schema.vendorInvoices, schema.vendorInvoiceLines,
      schema.supplierCredits, schema.supplierCreditLines, schema.supplierCreditApplications,
      schema.supplierCreditApplicationReversals, schema.supplierReturnLines, schema.receiptReversals,
      schema.notificationTypes, schema.notificationPreferences, schema.notifications, schema.echelonSettings,
      schema.warehouseSettings, schema.webhookRetryQueue, schema.webhookInbox, schema.demandEvents, schema.demandEventLines] as const;
    for (const table of [...identityTables, ...receivingTables]) await pool.query(fixtureTable(table));
    for (const statement of fixtureForeignKeys([...identityTables, ...receivingTables])) await pool.query(statement);
    const passwordHash = await bcrypt.hash(CONNECTED_PASSWORD, 10);
    await pool.query(`INSERT INTO identity.auth_roles(id,name) VALUES(1,'connected-receiver'),(2,'connected-viewer'),(3,'connected-admin'),
      (4,'connected-picker'),(5,'connected-second-receiver'),(6,'connected-catalog-creator'),(7,'connected-creator'),(8,'connected-editor');
      INSERT INTO identity.auth_permissions(id,resource,action,category) VALUES
      (1,'inventory','adjust','inventory'),(2,'inventory','view','inventory'),(3,'purchasing','view','purchasing'),
      (4,'roles','edit','identity'),(5,'users','manage_roles','identity'),(6,'users','edit','identity'),
      (7,'purchasing','create','purchasing'),(8,'inventory','create','inventory'),(9,'purchasing','edit','purchasing');
      INSERT INTO identity.auth_role_permissions(role_id,permission_id) VALUES
      (1,1),(1,2),(1,3),(2,2),(2,3),(3,1),(3,2),(3,3),(3,4),(3,5),(3,6),(3,7),(4,1),(4,2),(4,3),(5,1),(5,2),(5,3),(6,2),(6,8),(7,3),(7,7),(8,3),(8,9)`);
    for (const actor of CONNECTED_ACTORS) {
      await pool.query("INSERT INTO identity.users(id,username,password,role,display_name,active) VALUES($1,$2,$3,$4,$2,1)",
        [actor.id, actor.username, passwordHash, actor.role]);
      await pool.query("INSERT INTO identity.auth_user_roles(user_id,role_id) VALUES($1,$2)", [actor.id, actor.roleId]);
    }
    await prepareQuantityLotCreationMetadata(pool);
    await addOwnerReadColumns(pool);
    await pool.query("ALTER TABLE inventory.inventory_lots ALTER COLUMN received_at TYPE timestamp USING received_at AT TIME ZONE 'UTC'");
    const custody = await pool.query("SELECT count(*)::int AS count FROM procurement.receiving_quarantine_observations");
    if (custody.rows[0].count !== 0) throw new Error("Connected fixture custody prerequisite was not empty");
    await pool.query("DROP TABLE procurement.receiving_quarantine_observations, procurement.receiving_custody_fence");
    await pool.query(migration("900000004000017890001_receiving_quarantine.sql"));
    await pool.query(`CREATE UNIQUE INDEX connected_warehouse_settings_code ON inventory.warehouse_settings(warehouse_code);
      INSERT INTO inventory.warehouse_settings(warehouse_code,use_new_po_editor) VALUES('DEFAULT',true);
      CREATE UNIQUE INDEX connected_po_receipt_identity ON procurement.po_receipts(purchase_order_line_id,receiving_line_id);
      CREATE UNIQUE INDEX connected_receipt_reversal_identity ON procurement.receipt_reversals(idempotency_key);
      ALTER TABLE procurement.receiving_lines ADD CHECK(reversed_qty >= 0 AND reversed_qty <= received_qty);
      INSERT INTO procurement.receiving_orders(id,receipt_number,source_type,status,warehouse_id,created_by)
      VALUES(50,'CONNECTED-RECEIPT','blind','open',1,'connected-receiver');
      UPDATE catalog.products SET name='Connected five-piece case' WHERE id=20;
      UPDATE catalog.product_variants SET name='Case of five',uom_type='case',is_base_unit=false WHERE id=101;
      INSERT INTO public.notification_types(key,label,category) VALUES('po_received','Receiving complete','receiving')`);
    await installReceiptCostEvidence(pool);
    await installConnectedNavigationFixture(pool);
    await context.open();
    // Match quantity-ledger.integration.test.ts's post-cutover catalog fixture:
    // release its preparation freeze under the actual admission owner and its
    // persisted activation clock. This is not publication/completion acceptance;
    // those owners have separate integration suites. No guard is disabled.
    await context.transaction(async client => {
      const runs = (await client.query<{ id: string }>(
        "SELECT activation_run_id::text AS id FROM inventory.availability_activation_freezes WHERE released_at IS NULL")).rows;
      if (runs.length !== 1) throw new Error("Connected catalog fixture requires exactly one activation freeze");
      await acquireInventoryCutoverFenceInsideTransaction(client, {
        expectedAuthority: "canonical", expectedConfigurationRunId: runs[0].id,
      });
      const released = await client.query(`UPDATE inventory.availability_activation_freezes activation_freeze
        SET released_at=activation.activated_at,released_by='operator',release_reason='Connected post-cutover catalog fixture'
        FROM inventory.availability_activation_runs activation
        WHERE activation_freeze.activation_run_id=$1 AND activation.id=activation_freeze.activation_run_id
          AND activation.activated_at >= activation_freeze.acquired_at`, [runs[0].id]);
      if (released.rowCount !== 1) throw new Error("Connected fixture failed to release its activation freeze on the persisted clock");
    });
    for (const name of ["0085_idempotency_keys.sql", "136_financial_command_results.sql", "140_financial_command_operations.sql",
      "900000001000017770001_receiving_integrity_audit_guard.sql", "900000010000018200001_receiving_discard_audit_guard.sql",
      "900000027000019030001_receiving_entry_audit_guard.sql"]) await pool.query(migration(name));
    const authority = await pool.query("SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key=true");
    if (authority.rows[0]?.authority !== "canonical") throw new Error("Connected fixture failed to activate the quantity ledger");
    return context;
  } catch (error) {
    await context.close();
    throw error;
  }
}

/** Read-only evidence covers identity, receipt, stock and durable command owners.
 * The starting 20 units belong to the independent synthetic opening lot. */
export async function readConnectedReceivingState(pool: Pool) {
  const result = await pool.query(`SELECT
    (SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key=true) AS authority,
    (SELECT status FROM procurement.receiving_orders WHERE id=50) AS "receiptStatus",
    (SELECT notes FROM procurement.receiving_orders WHERE id=50) AS "receiptNotes",
    (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'productId',product_id,'productVariantId',product_variant_id,
      'expectedQty',expected_qty,'receivedQty',received_qty,'damagedQty',damaged_qty,'unitsPerVariantSnapshot',units_per_variant_snapshot,
      'putawayLocationId',putaway_location_id,'status',status) ORDER BY id),'[]'::jsonb) FROM procurement.receiving_lines WHERE receiving_order_id=50) AS lines,
    (SELECT coalesce(sum(received_qty * units_per_variant_snapshot),0)::int FROM procurement.receiving_lines WHERE receiving_order_id=50) AS "receivedBasePieces",
    (SELECT count(*)::int FROM inventory.inventory_transactions WHERE receiving_order_id=50 AND transaction_type='receipt') AS "receiptTransactions",
    (SELECT coalesce(sum(t.variant_qty_delta * v.units_per_variant),0)::int FROM inventory.inventory_transactions t
      JOIN catalog.product_variants v ON v.id=t.product_variant_id WHERE t.receiving_order_id=50 AND t.transaction_type='receipt') AS "stockReceivedBasePieces",
    (SELECT l.variant_qty * v.units_per_variant FROM inventory.inventory_levels l JOIN catalog.product_variants v ON v.id=l.product_variant_id
      WHERE l.product_variant_id=101 AND l.warehouse_location_id=100) AS "onHandBasePieces",
    (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY idempotency_key),'[]'::jsonb) FROM public.financial_command_results c) AS commands,
    (SELECT count(*)::int FROM public.audit_events WHERE action='procurement.receiving.entry.add-line') AS "entryAudits",
    (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM public.audit_events e WHERE action LIKE 'procurement.receiving.%') AS "receivingAudits",
    (SELECT count(*)::int FROM inventory.quantity_commands WHERE kind='receive') AS "quantityReceiptCommands",
    (SELECT count(*)::int FROM inventory.quantity_entries e JOIN inventory.quantity_commands c ON c.id=e.command_id WHERE c.kind='receive') AS "quantityReceiptEntries",
    (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM catalog.products p) AS "catalogProducts",
    (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]'::jsonb) FROM catalog.product_variants v) AS "catalogVariants",
    (SELECT count(*)::int FROM public.notifications) AS notifications,
    (SELECT count(*)::int FROM identity.session) AS sessions`);
  return result.rows[0];
}
