import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0642_shipping_fulfillment_provider_connections.sql"),
  "utf8",
);

describe("shipping fulfillment provider connections migration", () => {
  it("creates provider-neutral connections, encrypted credentials, and immutable audit events", () => {
    expect(migration).toContain("CREATE TABLE shipping.fulfillment_provider_connections");
    expect(migration).toContain("CREATE TABLE shipping.fulfillment_provider_credentials");
    expect(migration).toContain("CREATE TABLE shipping.fulfillment_provider_connection_events");
    expect(migration).toContain("ciphertext TEXT NOT NULL");
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX shipping_fulfillment_provider_connection_event_idempotency_idx[\s\S]+\(idempotency_key\)/,
    );
    expect(migration).toContain("shipping.fulfillment_provider_connection_events is append-only");
    expect(migration).toContain("revision must increment by 1");
    expect(migration).toContain("used by active routes cannot be disabled");
  });

  it("backfills existing ShipStation routes through a deployment-managed connection", () => {
    expect(migration).toContain("'SHIPSTATION_V2_API_KEY'");
    expect(migration).toContain("ADD COLUMN provider_connection_id BIGINT");
    expect(migration).toMatch(/UPDATE shipping\.service_level_methods AS method[\s\S]+SET provider_connection_id = connection\.id/);
    expect(migration).toContain("shipping_level_method_provider_connection_fk");
  });

  it("does not constrain future providers to a database enum", () => {
    expect(migration).toContain("provider ~ '^[a-z][a-z0-9_]{1,79}$'");
    expect(migration).not.toContain("provider IN ('shipstation_v2')");
    expect(migration).toContain("provider <> 'legacy_unscoped'");
  });

  it("keeps channel activation and dropship wiring out of the connection migration", () => {
    expect(migration).not.toMatch(/dropship\./i);
    expect(migration).not.toMatch(/UPDATE\s+shipping\.service_levels/i);
    expect(migration).not.toMatch(/UPDATE\s+shipping\.channel_policy/i);
  });
});
