import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { createInventoryCutoverTestDatabase } from "./inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, installCutoverCompositionMigrations,
  seedCompositionReviewedDryRun } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-composition-database.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-admission.fixture";
import { InventoryCutoverOpeningService } from "../../../inventory-planning/application/inventory-cutover-opening.service";
import { PostgresInventoryCutoverOpeningRepository } from "../../../inventory-planning/infrastructure/inventory-cutover-opening.repository";
import { InventoryAvailabilityActivationService } from "../../../inventory-planning/application/inventory-availability-activation.service";
import { PostgresInventoryAvailabilityActivationRepository } from "../../../inventory-planning/infrastructure/inventory-availability-activation.repository";
import { acquireInventoryCutoverFenceInsideTransaction } from "../../../inventory-planning/infrastructure/inventory-cutover-admission-fence.repository";
import { PostgresInventoryQuantityLedger } from "../../infrastructure/quantity-ledger.repository";
import type { QuantityCommand } from "../../domain/quantity-ledger";

export const QUANTITY_TEST_TIME = "2026-09-10T16:00:00.000Z";

/** Unique disposable database, actual admission/opening/quantity migrations.
 * Opening isolates the quantity owner; it is not whole-application cutover proof.
 */
export async function createQuantityLedgerTestContext(connectionString: string | undefined, disposable: boolean) {
  const database = await createInventoryCutoverTestDatabase(connectionString, disposable, cutoverCompositionBaseSql);
  const pool = database.pool;
  const ledger = new PostgresInventoryQuantityLedger();
  try {
    await installCutoverCompositionMigrations(pool);
    await pool.query(cutoverCompositionSeedSql);
    await installCutoverAdmissionFixturePrerequisites(pool);
    // Reduced compatibility fixtures may expose an empty relation, but this
    // fixture must install the actual ledger schema, guards and foreign keys.
    await pool.query("DROP TABLE IF EXISTS inventory.quantity_ledger_opening");
    await pool.query("ALTER TABLE inventory.inventory_lots DROP COLUMN IF EXISTS qty_packed");
    for (const name of ["236_inventory_cutover_admission.sql", "240_inventory_cutover_verified_opening.sql", "242_inventory_quantity_ledger.sql"]) {
      await pool.query(readFileSync(resolve(process.cwd(), "migrations", name), "utf8"));
    }
  } catch (error) {
    await database.close();
    throw error;
  }

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async function open(switchAuthority = true, openingOccurredAt = QUANTITY_TEST_TIME) {
    const openingService = new InventoryCutoverOpeningService(new PostgresInventoryCutoverOpeningRepository(pool), { now: () => new Date(openingOccurredAt) });
    const source = await openingService.capture("operator");
    const verification: OpeningVerification = { contractVersion: "inventory_cutover_opening_v1",
      expectedEvidenceHash: source.evidenceHash, expectedAuthorityRevision: source.authorityRevision, expectedConfigurationRunId: source.configurationRunId,
      verificationReference: "Independent warehouse observation", verificationEvidenceHash: "e".repeat(64),
      verifiedAt: openingOccurredAt, historicalDisposition: "preserve_unresolved", levels: source.evidence.levels, lots: source.evidence.lots,
      owners: [{ orderId: 1, orderItemId: 11, remainingQty: "6", reservedQty: "3", pickedQty: "2",
        allocations: [{ inventoryLevelId: 10, lots: [{ inventoryLotId: 4, reservedQty: "3", pickedQty: "2", originalCostIds: [9] }] }] }] };
    const saved = await openingService.save({ verification, reason: "Verified opening", idempotencyKey: "quantity-opening-verification" }, "operator");
    const dryRun = await seedCompositionReviewedDryRun(pool);
    const activation = new InventoryAvailabilityActivationService(new PostgresInventoryAvailabilityActivationRepository(pool), { now: () => new Date(dryRun.completedAt) });
    const prepared = await activation.prepare({ sourceDryRunId: dryRun.activationRunId, expectedDryRunResultHash: dryRun.resultHash,
      idempotencyKey: "quantity-opening-prepare", reason: "Prepare independent quantity basis" }, "operator");
    return transaction(async client => {
      await acquireInventoryCutoverFenceInsideTransaction(client, { expectedAuthority: "legacy", expectedConfigurationRunId: prepared.activationRunId });
      const command: QuantityCommand = { contractVersion: "inventory_quantity_v1", kind: "opening", idempotencyKey: "opening",
        actor: "operator", reason: "Exact custody test", occurredAt: openingOccurredAt,
        reference: { type: "quantity_test", id: "opening" }, reversesCommandId: null,
        movements: [{ inventoryLotId: 4, inventoryLevelId: 10, productVariantId: 101, warehouseLocationId: 100,
          warehouseId: 1, delta: { onHand: 20, reserved: 3, picked: 2, packed: 0 } }] };
      const posted = await ledger.openInsideTransaction(client, command, {
        verifiedOpeningId: saved.id, authorityRevision: "2", sourceEvidenceHash: saved.sourceEvidenceHash,
      });
      if (switchAuthority) {
        await client.query("UPDATE inventory.availability_activation_runs SET state='activating' WHERE id=$1", [prepared.activationRunId]);
        await client.query(`UPDATE inventory.availability_runtime_authority SET authority='canonical',revision=2,activation_run_id=$1,
          changed_by='operator',change_reason='Test quantity opening' WHERE singleton_key=true`, [prepared.activationRunId]);
        // The reviewed dry run uses the database snapshot clock. Complete the
        // fixture no earlier than either its fixed opening clock or the real
        // publication milestone; a fixed future date eventually becomes past.
        await client.query(`UPDATE inventory.availability_activation_runs
          SET state='active',runtime_authority_changed=true,
            activated_at=GREATEST($2::timestamptz,publication_verified_at)
          WHERE id=$1`, [prepared.activationRunId,openingOccurredAt]);
      }
      return posted;
    });
  }

  async function state() {
    return (await pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(lot) ORDER BY id) FROM inventory.inventory_lots lot) AS lots,
      (SELECT jsonb_agg(to_jsonb(level) ORDER BY id) FROM inventory.inventory_levels level) AS levels,
      (SELECT count(*)::integer FROM inventory.quantity_commands) AS commands,
      (SELECT count(*)::integer FROM inventory.quantity_entries) AS entries`)).rows[0];
  }

  return { database, pool, ledger, transaction, open, state, close: database.close };
}

export type QuantityLedgerTestContext = Awaited<ReturnType<typeof createQuantityLedgerTestContext>>;

/** Add actual output-lot identity and cost-lineage prerequisites before opening. */
export async function prepareQuantityLotCreationMetadata(pool: Pool): Promise<void> {
  await pool.query(`ALTER TABLE inventory.inventory_lots ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 1000);
    ALTER TABLE inventory.inventory_lots ALTER COLUMN created_at TYPE timestamptz USING created_at AT TIME ZONE 'UTC';
    ALTER TABLE inventory.inventory_levels ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (START WITH 1000);
    CREATE UNIQUE INDEX quantity_test_level_identity ON inventory.inventory_levels(product_variant_id,warehouse_location_id);
    UPDATE inventory.inventory_lots SET qty_received=22,cost_provisional=0,cost_source='purchase_order',qty_consumed=0 WHERE id=4;
    DROP TABLE inventory.lot_cost_contributions;
    DROP TABLE inventory.cost_component_protections;`);
  const costMigration = readFileSync(resolve(process.cwd(), "migrations/222_procurement_cost_evidence.sql"), "utf8");
  const start = costMigration.indexOf("CREATE TABLE IF NOT EXISTS inventory.lot_cost_contributions (");
  const end = costMigration.indexOf("CREATE TABLE IF NOT EXISTS inventory.cost_applications (");
  if (start < 0 || end <= start) throw new Error("Cost-contribution fixture migration boundaries changed");
  await pool.query(costMigration.slice(start, end));
  for (const table of ["lot_cost_contributions", "cost_component_protections"]) await pool.query(
    `CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON inventory.${table}
     FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission()`);
}
