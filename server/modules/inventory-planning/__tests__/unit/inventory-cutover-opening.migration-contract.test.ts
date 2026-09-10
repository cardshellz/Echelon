import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { INVENTORY_CUTOVER_CONFIGURATION_TABLES, INVENTORY_CUTOVER_OPERATIONAL_TABLES } from "../../domain/inventory-cutover-admission-fence";

const migration = readFileSync(resolve(process.cwd(), "migrations/240_inventory_cutover_verified_opening.sql"), "utf8").replace(/\r\n/g, "\n");
describe("verified opening evidence migration contract", () => {
  it("sorts after the real admission and claim prerequisites in release-runner order", () => {
    // run-migrations.ts sorts filenames lexically, not their numeric prefixes.
    const ordered = readdirSync(resolve(process.cwd(), "migrations")).filter(file => file.endsWith(".sql")).sort();
    const openingIndex = ordered.indexOf("240_inventory_cutover_verified_opening.sql");
    expect(openingIndex).toBeGreaterThan(-1);
    for (const prerequisite of ["236_inventory_cutover_admission.sql", "233_inventory_cutover_reconstruction.sql"]) {
      expect(ordered.indexOf(prerequisite)).toBeGreaterThan(-1);
      expect(openingIndex).toBeGreaterThan(ordered.indexOf(prerequisite));
    }
  });
  it("creates a separate append-only audit, not a stock correction or runtime switch", () => {
    expect(migration).toContain("CREATE TABLE inventory.availability_cutover_opening_snapshots");
    expect(migration).toContain("UNIQUE (authority_revision, source_evidence_hash)");
    expect(migration).toContain("idempotency_key varchar(120) NOT NULL UNIQUE");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON inventory.availability_cutover_opening_snapshots");
    expect(migration).toContain("BEFORE TRUNCATE ON inventory.availability_cutover_opening_snapshots");
    expect(migration).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:inventory\.(?:inventory_levels|inventory_lots|inventory_transactions|availability_runtime_authority)|oms\.order_item_costs)\b/i);
  });
  it("requires the real exclusive fence and the exact legacy revision and configuration at insertion", () => {
    expect(migration).toContain("PERFORM inventory.assert_cutover_admission_fence_owner()");
    expect(migration).toContain("authority = 'legacy' AND activation_run_id IS NULL");
    expect(migration).toContain("current_revision IS DISTINCT FROM NEW.authority_revision");
    expect(migration).toContain("current_configuration_run_id IS DISTINCT FROM NEW.configuration_run_id");
    expect(migration).toContain("CHECK (verified_at <= occurred_at)");
  });
  it.each(["oms.channel_fulfillment_receipts", "oms.channel_fulfillment_receipt_attempts", "wms.order_build_demands"] as const)(
    "pins every statement on captured evidence owner %s without weakening its existing guards", table => {
      expect(INVENTORY_CUTOVER_OPERATIONAL_TABLES).toContain(table);
      expect(migration).toContain(`BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${table}\nFOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();`);
      expect(migration).not.toMatch(/DROP\s+(?:TRIGGER|CONSTRAINT)|DISABLE\s+TRIGGER/i);
    },
  );
  it("declares admission for every direct owner table read by the complete raw reconstruction census", () => {
    const manifest = new Set<string>([...INVENTORY_CUTOVER_CONFIGURATION_TABLES, ...INVENTORY_CUTOVER_OPERATIONAL_TABLES]);
    const files = ["inventory/infrastructure/inventory-cutover-reconstruction.reader.ts",
      "inventory/infrastructure/inventory-cutover-encumbrance.repository.ts", "wms/inventory-cutover-reconstruction.reader.ts",
      "oms/inventory-cutover-reconstruction.reader.ts", "orders/inventory-cutover-reconstruction-cost.reader.ts"];
    const missing = files.flatMap(file => {
      const source = readFileSync(resolve(process.cwd(), "server/modules", file), "utf8");
      return [...source.matchAll(/\b(?:FROM|JOIN)\s+((?:inventory|wms|oms|warehouse|catalog)\.[a-z_]+)/gi)]
        .map(match => match[1]).filter(table => !manifest.has(table)).map(table => `${file}: ${table}`);
    });
    expect(missing).toEqual([]);
  });
});
