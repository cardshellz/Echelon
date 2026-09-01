import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8")
    .replace(/\r\n/g, "\n");
}

const migration = source(
  "migrations",
  "0635_package_allocation_effect_outbox.sql",
);
const schema = source("shared", "schema", "fulfillment.schema.ts");
const repository = source(
  "server",
  "modules",
  "shipping",
  "package-allocation-ledger.repository.ts",
);
const integrationSetup = source("test", "setup-integration.ts");
const normalizedMigration = migration.replace(/\s+/g, " ").trim();

describe("package allocation effect outbox migration contract", () => {
  it("backfills one durable idempotency row for every existing effect intent", () => {
    expect(normalizedMigration).toContain(
      "CREATE TABLE wms.package_allocation_effect_outbox",
    );
    expect(normalizedMigration).toContain(
      "UNIQUE (package_allocation_effect_intent_id)",
    );
    expect(normalizedMigration).toContain("UNIQUE (idempotency_key)");
    expect(normalizedMigration).toContain(
      "FROM wms.package_allocation_effect_intents AS intent ORDER BY intent.id",
    );
    expect(normalizedMigration).toContain(
      "NEW.idempotency_key IS DISTINCT FROM persisted_intent_key",
    );
    expect(normalizedMigration).toContain(
      "NEW.payload_hash IS DISTINCT FROM persisted_payload_hash",
    );
  });

  it("keeps every outbox row structurally non-dispatchable", () => {
    expect(normalizedMigration).toContain("state = 'shadow'");
    expect(normalizedMigration).toContain("execution_enabled = FALSE");
    expect(normalizedMigration).toContain("attempt_count = 0");
    expect(normalizedMigration).toContain("available_at IS NULL");
    expect(normalizedMigration).toContain("lease_token IS NULL");
    expect(normalizedMigration).toContain(
      "BEFORE UPDATE OR DELETE ON wms.package_allocation_effect_outbox",
    );
    expect(schema).toContain(
      'export const packageAllocationEffectOutbox = wmsSchema.table("package_allocation_effect_outbox"',
    );
    expect(schema).toContain(
      '"package_allocation_effect_outbox_inert_chk"',
    );
  });

  it("persists the outbox before group CAS and includes it in exact replay", () => {
    const outboxInsert = repository.indexOf(
      "INSERT INTO wms.package_allocation_effect_outbox",
    );
    const groupCas = repository.indexOf("UPDATE wms.package_allocation_groups");
    expect(outboxInsert).toBeGreaterThan(-1);
    expect(groupCas).toBeGreaterThan(outboxInsert);
    expect(repository).toContain("loadPlanEffectOutbox");
    expect(repository).toContain("'shadow'");
    expect(repository).not.toContain("execution_enabled = TRUE");
  });

  it("installs and truncates the outbox in the disposable PostgreSQL harness", () => {
    expect(integrationSetup).toContain(
      '"migrations/0635_package_allocation_effect_outbox.sql"',
    );
    expect(integrationSetup.indexOf('"wms.package_allocation_effect_outbox"'))
      .toBeLessThan(integrationSetup.indexOf(
        '"wms.package_allocation_effect_intents"',
      ));
  });
});
