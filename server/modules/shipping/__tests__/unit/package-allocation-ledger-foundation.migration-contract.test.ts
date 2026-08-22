import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const migrationSource = readNormalizedSource(
  "migrations",
  "198_package_allocation_ledger_foundation.sql",
);
const schemaSource = readNormalizedSource("shared", "schema", "fulfillment.schema.ts");

const allocationTableNames = [
  "package_allocation_groups",
  "package_allocation_source_lines",
  "package_allocation_group_source_lines",
  "package_allocation_keys",
  "package_allocation_plans",
  "package_allocation_entries",
  "package_allocation_effect_intents",
] as const;

describe("package allocation ledger foundation migration contract", () => {
  it("declares the same provider-independent ledger tables in SQL and Drizzle", () => {
    for (const tableName of allocationTableNames) {
      expect(migrationSource).toContain(`CREATE TABLE wms.${tableName}`);
      expect(schemaSource).toContain(`wmsSchema.table("${tableName}"`);
    }

    expect(migrationSource).not.toContain("shipstation_package_allocation");
    expect(schemaSource).not.toContain("shipstationPackageAllocation");
  });

  it("freezes canonical source-line identity, quantity, purpose, lineage, and fingerprint", () => {
    expect(migrationSource).toContain("UNIQUE (source_wms_shipment_item_id)");
    expect(migrationSource).toContain("REFERENCES wms.outbound_shipment_items(id) ON DELETE RESTRICT");
    expect(migrationSource).toContain("UNIQUE (shipment_request_item_id)");
    expect(migrationSource).toContain("REFERENCES wms.shipment_request_items(id) ON DELETE RESTRICT");
    expect(migrationSource).toContain("CHECK (source_quantity > 0)");
    expect(migrationSource).toContain("shipment_item_purpose IN (");
    expect(migrationSource).toContain("package_allocation_source_lines_lineage_chk");
    expect(migrationSource).toContain("CHECK (source_fingerprint ~ '^[0-9a-f]{64}$')");
    expect(migrationSource).toContain("uq_package_allocation_group_source_lines_source");
    expect(migrationSource).toContain("UNIQUE (package_allocation_source_line_id)");

    expect(schemaSource).toContain("sourceWmsShipmentItemId: integer");
    expect(schemaSource).toContain("sourceFingerprint: varchar");
    expect(schemaSource).toContain("package_allocation_source_lines_lineage_chk");
  });

  it("binds each stable allocation key to exactly one immutable source line", () => {
    expect(migrationSource).toContain("CREATE TABLE wms.package_allocation_keys");
    expect(migrationSource).toContain(
      "UNIQUE (allocation_key, package_allocation_source_line_id)",
    );
    expect(migrationSource).toContain(
      "REFERENCES wms.package_allocation_keys(allocation_key, package_allocation_source_line_id)",
    );
    expect(migrationSource).toContain("trg_package_allocation_keys_immutable");
    expect(migrationSource).toMatch(
      /REFERENCES wms\.package_allocation_plans\(id, package_allocation_group_id\)\n\s+ON DELETE RESTRICT,\n\s+CONSTRAINT fk_package_allocation_entries_allocation_key/,
    );
    expect(migrationSource).toMatch(
      /CREATE TRIGGER trg_package_allocation_source_lines_immutable[^\n]*\nFOR EACH ROW EXECUTE FUNCTION wms\.reject_shipping_evidence_ledger_mutation\(\);\nCREATE TRIGGER trg_package_allocation_keys_immutable[^\n]*\nFOR EACH ROW EXECUTE FUNCTION wms\.reject_shipping_evidence_ledger_mutation\(\);/,
    );
    expect(schemaSource).toContain(
      "foreignColumns: [\n      packageAllocationKeys.allocationKey,\n      packageAllocationKeys.packageAllocationSourceLineId,",
    );
  });

  it("makes versioned plans reconstructable and CAS-compatible", () => {
    expect(migrationSource).toContain("group_key UUID NOT NULL");
    expect(migrationSource).toContain("current_version INTEGER NOT NULL DEFAULT 0");
    expect(migrationSource).toContain("UNIQUE (package_allocation_group_id, plan_version)");
    expect(migrationSource).toContain("UNIQUE (package_allocation_group_id, input_hash)");
    expect(migrationSource).toContain("plan_version = expected_group_version + 1");
    expect(migrationSource).toContain("CHECK (state_hash ~ '^[0-9a-f]{64}$')");
    expect(migrationSource).toContain("CHECK (outcome IN ('proposed', 'review'))");
    expect(migrationSource).toContain("jsonb_typeof(state_snapshot) = 'object'");
    expect(migrationSource).toContain("jsonb_typeof(review_snapshot) = 'object'");
    expect(migrationSource).toContain("current_version must advance by exactly one");

    // `unchanged` is a pure planner no-op; it must not become an appendable plan outcome.
    expect(schemaSource).toContain(
      'packageAllocationPlanOutcomeValues = ["proposed", "review"]',
    );
    expect(schemaSource).not.toContain(
      'packageAllocationPlanOutcomeValues = ["proposed", "review", "unchanged"]',
    );
  });

  it("separates stable allocation identity from segment identity and validates targets", () => {
    expect(migrationSource).toContain("allocation_key VARCHAR(500) NOT NULL");
    expect(migrationSource).toContain("entry_key VARCHAR(500) NOT NULL");
    expect(migrationSource).toContain("UNIQUE (package_allocation_plan_id, entry_key)");
    expect(migrationSource).toContain("uq_package_allocation_entries_semantic_target");
    expect(migrationSource).toContain(
      "package allocation key spans multiple source lines",
    );
    expect(migrationSource).toContain("'primary_transfer'");
    expect(migrationSource).toContain("'additional_physical_consumption'");
    expect(migrationSource).toContain("'package', 'awaiting_relabel', 'held_for_unpack'");
    expect(migrationSource).toContain("target_kind = 'package' AND shipping_provider_label_id IS NOT NULL");
    expect(migrationSource).toContain("CHECK (quantity > 0)");

    expect(schemaSource).toContain("allocationKey: varchar");
    expect(schemaSource).toContain("entryKey: varchar");
    expect(schemaSource).toContain("package_allocation_entries_target_shape_chk");
  });

  it("keeps effect intents closed, hashed, immutable, and impossible to execute", () => {
    expect(migrationSource).toContain("payload_hash VARCHAR(64) NOT NULL");
    expect(migrationSource).toContain("CHECK (payload_hash ~ '^[0-9a-f]{64}$')");
    expect(migrationSource).toContain("'commercial_fulfillment'");
    expect(migrationSource).toContain("'inventory_consumption'");
    expect(migrationSource).toContain("'active_label_tracking'");
    expect(migrationSource).toContain("'pre_possession_void_removal'");
    expect(migrationSource).toContain("'carrier_tracking'");
    expect(migrationSource).toContain("'notification_reconciliation'");
    expect(migrationSource).toContain("'notification_candidate'");
    expect(schemaSource).toContain(
      "'notification_candidate',\n      'notification_reconciliation'",
    );
    expect(migrationSource).toContain("UNIQUE (intent_key)");
    expect(migrationSource).toContain("executable BOOLEAN NOT NULL DEFAULT FALSE");
    expect(migrationSource).toContain("CHECK (executable = FALSE)");

    for (const immutableLedger of [
      "source_lines",
      "group_source_lines",
      "plans",
      "entries",
      "effect_intents",
    ]) {
      expect(migrationSource).toContain(
        `trg_package_allocation_${immutableLedger}_immutable`,
      );
    }

    expect(schemaSource).toContain("payloadHash: varchar");
    expect(schemaSource).toContain("executable: boolean");
    expect(schemaSource).toContain("package_allocation_effect_intents_inert_chk");
  });

  it("defers exact primary-transfer conservation and excludes extra physical consumption", () => {
    const conservationFunctionStart = migrationSource.indexOf(
      "CREATE OR REPLACE FUNCTION wms.validate_package_allocation_plan_conservation()",
    );
    const conservationFunctionEnd = migrationSource.indexOf(
      "CREATE TRIGGER trg_package_allocation_groups_projection_guard",
      conservationFunctionStart,
    );
    const conservationFunction = migrationSource.slice(
      conservationFunctionStart,
      conservationFunctionEnd,
    );

    expect(conservationFunctionStart).toBeGreaterThan(-1);
    expect(conservationFunctionEnd).toBeGreaterThan(conservationFunctionStart);
    expect(conservationFunction).toContain("entry.allocation_kind = 'primary_transfer'");
    expect(conservationFunction).toContain(
      "allocation_total.primary_quantity <> source_line.source_quantity",
    );
    expect(conservationFunction).not.toContain("additional_physical_consumption");
    expect(migrationSource.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(3);
    expect(migrationSource).toContain("package_allocation_plan_conservation_chk");
  });

  it("does not mutate existing shipment authority tables or install a runtime worker", () => {
    expect(migrationSource).not.toMatch(
      /ALTER TABLE wms\.(?:outbound_shipment_items|physical_shipment_items|shipment_request_items|shipping_provider_labels)/,
    );
    expect(migrationSource).not.toContain("CREATE PROCEDURE");
    expect(migrationSource).not.toContain("pg_cron");
  });
});
