import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "migrations/0627_historical_shipstation_contents_system_recovery.sql",
  "utf8",
);
const schema = readFileSync("shared/schema/fulfillment.schema.ts", "utf8");
const setup = readFileSync("test/setup-integration.ts", "utf8");

describe("historical ShipStation contents system recovery migration", () => {
  it("adds one constrained append-only recovery event per label", () => {
    expect(migration).toContain("'contents_recovered'");
    expect(migration).toContain("shipping_provider_label_events_recovery_payload_chk");
    expect(migration).toContain("historical_shipstation_contents_system_recovery");
    expect(migration).toContain("provider_occurred_at IS NULL");
    expect(migration).toContain("declaredContentsEvidence'->>'status' = 'authoritative'");
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX uq_shipping_provider_label_events_one_contents_recovery[\s\S]*WHERE event_type = 'contents_recovered'/,
    );
    expect(migration).not.toMatch(/\bUPDATE\s+wms\.shipping_provider_label_events\b/i);
    expect(migration).not.toMatch(/\bDELETE\s+FROM\s+wms\.shipping_provider_label_events\b/i);
  });

  it("keeps the Drizzle schema and disposable database harness aligned", () => {
    expect(schema).toContain("uq_shipping_provider_label_events_one_contents_recovery");
    expect(schema).toContain("shipping_provider_label_events_recovery_payload_chk");
    expect(schema).toContain("historical_shipstation_contents_system_recovery");
    expect(setup).toContain("migrations/0627_historical_shipstation_contents_system_recovery.sql");
  });
});
