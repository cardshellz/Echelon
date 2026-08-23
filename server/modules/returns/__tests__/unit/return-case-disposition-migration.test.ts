import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/203_return_case_dispositions.sql"),
  "utf8",
);

describe("return case dispositions migration", () => {
  it("registers the canonical idempotent disposition command", () => {
    expect(migration).toContain("DROP CONSTRAINT IF EXISTS return_case_commands_type_chk");
    expect(migration).toContain("'record_disposition'");
    expect(migration).toContain("CONSTRAINT return_case_dispositions_idempotency_uq");
    expect(migration).toContain("UNIQUE (idempotency_key)");
    expect(migration).toContain("request_hash ~ '^[0-9a-f]{64}$'");
  });

  it("persists an append-only header and exact per-item treatments", () => {
    expect(migration).toContain("CREATE TABLE returns.return_case_dispositions");
    expect(migration).toContain("CREATE TABLE returns.return_case_disposition_items");
    expect(migration).toContain("REFERENCES returns.return_cases(id)");
    expect(migration).toContain("REFERENCES returns.return_case_items(id)");
    expect(migration).toContain("UNIQUE (disposition_id, return_case_item_id)");
    expect(migration).toContain(
      "treatment IN ('restock_sellable', 'hold_non_sellable')",
    );
    expect(migration).toContain("quantity > 0");
    expect(migration).not.toContain("ON DELETE CASCADE");
  });

  it("requires resolved persisted inspection evidence without inventing an inspection", () => {
    expect(migration).toContain(
      "inspection_resolution IN ('approved', 'rejected', 'not_required')",
    );
    expect(migration).toContain(
      "inspection_resolution IN ('approved', 'rejected') AND inspection_id IS NOT NULL",
    );
    expect(migration).toContain(
      "inspection_resolution = 'not_required' AND inspection_id IS NULL",
    );
    expect(migration).toContain("inspection.return_case_id = NEW.return_case_id");
    expect(migration).toContain("inspection.completed_at IS NOT NULL");
    expect(migration).toContain("inspection.completed_by IS NOT NULL");
    expect(migration).toContain("persisted_inspection_status <> NEW.inspection_resolution");
    expect(migration).toContain("persisted_inspection_status <> 'not_required'");
    expect(migration).toContain("persisted_receipt_received_at timestamp without time zone");
    expect(migration).toContain("persisted_receipt_received_at IS NULL");
    expect(migration).toContain("persisted_receipt_received_at AT TIME ZONE 'UTC'");
    expect(migration).not.toContain("persisted_receipt_received_at timestamptz");
    expect(migration).not.toContain("NEW.recorded_at < persisted_receipt_received_at THEN");
    expect(migration).toContain("Disposition evidence cannot predate its return receipt evidence");
    expect(migration).toContain("NEW.recorded_at < persisted_inspection_completed_at");
    expect(migration).toContain(
      "Disposition evidence cannot predate its terminal inspection evidence",
    );
    expect(migration).toContain("BEFORE INSERT ON returns.return_case_dispositions");
  });

  it("serializes cumulative quantities against the canonical received units", () => {
    expect(migration).toContain("FOR UPDATE OF wms_item");
    expect(migration).toContain("case_item.return_case_id = disposition.return_case_id");
    expect(migration).toContain("wms_item.id = case_item.wms_return_item_id");
    expect(migration).toContain(
      "WHERE item.return_case_item_id = NEW.return_case_item_id",
    );
    expect(migration).toContain(
      "already_recorded_quantity + NEW.quantity > received_quantity",
    );
    expect(migration).toContain(
      "BEFORE INSERT ON returns.return_case_disposition_items",
    );
    expect(migration).toContain("JOIN returns.return_case_commands command");
    expect(migration).toContain("command.command_type = 'record_disposition'");
    expect(migration).toContain(
      "Disposition items cannot be appended after immutable command evidence is finalized",
    );
  });

  it("requires bidirectional disposition-command evidence at commit", () => {
    expect(migration).toContain(
      "CREATE CONSTRAINT TRIGGER return_case_dispositions_evidence_guard",
    );
    expect(migration).toContain(
      "CREATE CONSTRAINT TRIGGER return_case_disposition_commands_evidence_guard",
    );
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(2);
    expect(migration).toContain("command.command_type = 'record_disposition'");
    expect(migration).toContain("command.idempotency_key = NEW.idempotency_key");
    expect(migration).toContain("command.request_hash = NEW.request_hash");
    expect(migration).toContain("command.actor = NEW.recorded_by");
    expect(migration).toContain("A disposition record requires at least one item quantity");
  });

  it("makes recorded decisions immutable and reserves correction for compensation", () => {
    expect(migration).toContain("CREATE TRIGGER return_case_dispositions_immutable");
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON returns.return_case_dispositions",
    );
    expect(migration).toContain("CREATE TRIGGER return_case_disposition_items_immutable");
    expect(migration).toContain(
      "BEFORE UPDATE OR DELETE ON returns.return_case_disposition_items",
    );
    expect(migration).toContain(
      "Corrections require a future compensating command, never UPDATE or DELETE.",
    );
  });

  it("records treatment intent without applying downstream side effects", () => {
    expect(migration).toContain(
      "Recording does not apply inventory, refund, settlement, or closure side effects.",
    );
    expect(migration).not.toMatch(/\bINSERT\s+INTO\s+(?:inventory|wms\.(?:inventory|stock))/i);
    expect(migration).not.toMatch(/\bUPDATE\s+(?:inventory|wms\.(?:inventory|stock))/i);
    expect(migration).not.toMatch(/\bUPDATE\s+returns\.return_cases\b/i);
  });
});
