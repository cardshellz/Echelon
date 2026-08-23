import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/200_return_case_operations.sql"),
  "utf8",
);

const completionMigration = readFileSync(
  resolve(process.cwd(), "migrations/201_return_case_inspection_completion.sql"),
  "utf8",
);

describe("return case operations migration", () => {
  it("adds honest partial receipt and in-progress inspection lifecycle states", () => {
    expect(migration).toContain("'partially_received'");
    expect(migration).toContain("'in_progress'");
    expect(migration).toContain("return_cases_logistics_status_chk");
    expect(migration).toContain("return_cases_inspection_status_chk");
  });

  it("persists one active inspection with auditable actor and timestamps", () => {
    expect(migration).toContain("CREATE TABLE returns.return_case_inspections");
    expect(migration).toContain("return_case_inspections_completion_chk");
    expect(migration).toContain("CREATE UNIQUE INDEX return_case_inspections_active_uq");
    expect(migration).toContain("WHERE status = 'in_progress'");
  });

  it("creates immutable idempotent command evidence", () => {
    expect(migration).toContain("CREATE TABLE returns.return_case_commands");
    expect(migration).toContain("CONSTRAINT return_case_commands_idempotency_uq UNIQUE (idempotency_key)");
    expect(migration).toContain("command_type IN ('record_receipt', 'start_inspection')");
    expect(migration).toContain("CREATE TRIGGER return_case_commands_immutable");
    expect(migration).toContain("BEFORE UPDATE OR DELETE ON returns.return_case_commands");
  });

  it("adds completion notes and the idempotent complete-inspection command", () => {
    expect(completionMigration).toContain("ADD COLUMN IF NOT EXISTS completion_notes text");
    expect(completionMigration).toContain("DROP CONSTRAINT IF EXISTS return_case_commands_type_chk");
    expect(completionMigration).toContain(
      "command_type IN ('record_receipt', 'start_inspection', 'complete_inspection')",
    );
  });

  it("allows one safe terminal transition while preserving cascade-delete semantics", () => {
    expect(completionMigration).toContain("CREATE OR REPLACE FUNCTION returns.guard_return_case_inspection_mutation()");
    expect(completionMigration).toContain("OLD.status <> 'in_progress'");
    expect(completionMigration).toContain("NEW.status NOT IN ('approved', 'rejected', 'cancelled')");
    expect(completionMigration).toContain("Return case inspection identity and start evidence are immutable");
    expect(completionMigration).toContain("Completed return case inspections are immutable");
    expect(completionMigration).toContain("BEFORE UPDATE ON returns.return_case_inspections");
    expect(completionMigration).not.toContain("BEFORE UPDATE OR DELETE ON returns.return_case_inspections");
  });
});
