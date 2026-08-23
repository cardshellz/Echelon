import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/204_return_case_inventory_treatments.sql"),
  "utf8",
);

describe("return case inventory treatments migration", () => {
  it("registers the canonical idempotent inventory-treatment command", () => {
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS return_case_commands_type_chk");
    expect(migration).toContain("'apply_inventory_treatment'");
    expect(migration).toContain("CONSTRAINT return_case_inventory_treatments_idempotency_uq");
    expect(migration).toContain("UNIQUE (idempotency_key)");
    expect(migration).toContain("request_hash ~ '^[0-9a-f]{64}$'");
  });

  it("persists immutable, exactly-once treatment evidence for disposition items", () => {
    expect(migration).toContain("CREATE TABLE returns.return_case_inventory_treatments");
    expect(migration).toContain("CREATE TABLE returns.return_case_inventory_treatment_items");
    expect(migration).toContain("REFERENCES returns.return_case_disposition_items(id)");
    expect(migration).toContain("UNIQUE (disposition_item_id)");
    expect(migration).toContain("treatment IN ('restock_sellable', 'hold_non_sellable')");
    expect(migration).toContain("quantity > 0");
    expect(migration).toContain("Inventory treatment must exactly match its immutable disposition source");
    expect(migration).toContain("NEW.return_case_item_id <> source_return_case_item_id");
    expect(migration).toContain("NEW.treatment <> source_treatment");
    expect(migration).toContain("NEW.quantity <> source_quantity");
  });

  it("requires treatment evidence to follow its immutable disposition chronologically", () => {
    expect(migration).toContain("source_recorded_at timestamptz");
    expect(migration).toContain("treatment_applied_at timestamptz");
    expect(migration).toContain("disposition.recorded_at");
    expect(migration).toContain("treatment_applied_at < source_recorded_at");
    expect(migration).toContain("Inventory treatment cannot predate its immutable disposition source");
  });

  it("keeps held inventory outside sellable inventory evidence", () => {
    expect(migration).toContain("treatment = 'hold_non_sellable'");
    expect(migration).toContain("warehouse_location_id IS NULL");
    expect(migration).toContain("inventory_transaction_id IS NULL");
    expect(migration).toContain("inventory_lot_id IS NULL");
  });

  it("ties sellable treatment to the exact active lot and positive return ledger entry", () => {
    expect(migration).toContain("CREATE UNIQUE INDEX return_inventory_treatment_transaction_uq");
    expect(migration).toContain("transaction.product_variant_id = source_variant_id");
    expect(migration).toContain("transaction.transaction_type = 'return'");
    expect(migration).toContain("transaction.voided_at IS NULL");
    expect(migration).toContain("ledger_variant_delta IS DISTINCT FROM NEW.quantity");
    expect(migration).toContain("ledger_location_id IS DISTINCT FROM NEW.warehouse_location_id");
    expect(migration).toContain("ledger_reference_type IS DISTINCT FROM 'return_inventory_treatment'");
    expect(migration).toContain("ledger_reference_id IS DISTINCT FROM NEW.disposition_item_id::text");
    expect(migration).toContain("ledger_inventory_lot_id IS DISTINCT FROM NEW.inventory_lot_id");
    expect(migration).toContain("ledger_source_state IS DISTINCT FROM 'customer_return'");
    expect(migration).toContain("ledger_target_state IS DISTINCT FROM 'on_hand'");
    expect(migration).toContain("lot_variant_id IS DISTINCT FROM source_variant_id");
    expect(migration).toContain("lot_location_id IS DISTINCT FROM NEW.warehouse_location_id");
    expect(migration).toContain("lot_qty_on_hand IS DISTINCT FROM NEW.quantity");
    expect(migration).toContain("lot_qty_received IS DISTINCT FROM NEW.quantity");
    expect(migration).toContain("lot_qty_consumed IS DISTINCT FROM 0");
    expect(migration).toContain("lot_status IS DISTINCT FROM 'active'");
  });

  it("requires bidirectional command evidence and prevents late child inserts", () => {
    expect(migration).toContain(
      "CREATE CONSTRAINT TRIGGER return_case_inventory_treatments_evidence_guard",
    );
    expect(migration).toContain(
      "CREATE CONSTRAINT TRIGGER return_case_inventory_treatment_commands_evidence_guard",
    );
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(2);
    expect(migration).toContain("command.command_type = 'apply_inventory_treatment'");
    expect(migration).toContain("command.idempotency_key = NEW.idempotency_key");
    expect(migration).toContain("command.request_hash = NEW.request_hash");
    expect(migration).toContain("command.actor = NEW.applied_by");
    expect(migration).toContain(
      "Inventory treatment items cannot be appended after command finalization",
    );
  });

  it("makes treatment evidence append-only", () => {
    expect(migration).toContain("CREATE TRIGGER return_case_inventory_treatments_immutable");
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON returns.return_case_inventory_treatments",
    );
    expect(migration).toContain("CREATE TRIGGER return_case_inventory_treatment_items_immutable");
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON returns.return_case_inventory_treatment_items",
    );
  });

  it("does not mutate WMS, refunds, settlement, or return-case lifecycle", () => {
    expect(migration).not.toMatch(/\bUPDATE\s+wms\./i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\s+wms\./i);
    expect(migration).not.toMatch(/\bUPDATE\s+returns\.return_cases\b/i);
    expect(migration).not.toMatch(/\bcustomer_refund_status\b/i);
    expect(migration).not.toMatch(/\bvendor_settlement_status\b/i);
    expect(migration).not.toMatch(/\bclosed_at\b/i);
  });
});
