import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0636_shipping_fulfillment_routing.sql"),
  "utf8",
);

describe("shipping fulfillment routing migration", () => {
  it("creates optimistic profile heads and immutable idempotent revisions", () => {
    expect(migration).toContain("CREATE TABLE shipping.fulfillment_routing_profiles");
    expect(migration).toContain("CREATE TABLE shipping.fulfillment_routing_revisions");
    expect(migration).toContain("UNIQUE (service_level_id, idempotency_key)");
    expect(migration).toContain("shipping.fulfillment_routing_revisions is append-only");
    expect(migration).toContain("NEW.revision <> OLD.revision + 1");
    expect(migration).toContain("must supersede the immediately preceding revision");
  });

  it("requires exact provider account identity for executable ShipStation routes", () => {
    expect(migration).toContain("provider_account_id VARCHAR(120)");
    expect(migration).toContain("provider = 'shipstation_v2'");
    expect(migration).toContain("provider_account_id IS NOT NULL");
    expect(migration).toContain("revision_id IS NOT NULL");
    expect(migration).toContain("shipping_level_method_priority_idx");
    expect(migration).toContain("fulfillment_routing_methods_coherence_guard");
    expect(migration).toContain("must match the immutable revision snapshot");
  });

  it("preserves pre-existing unscoped rows without treating them as executable", () => {
    expect(migration).toContain("DEFAULT 'legacy_unscoped'");
    expect(migration).toContain("provider = 'legacy_unscoped'");
    expect(migration).not.toMatch(
      /DELETE\s+FROM\s+shipping\.service_level_methods/i,
    );
  });

  it("does not wire a channel, mutate pricing, or activate a service level", () => {
    expect(migration).not.toMatch(/dropship\./i);
    expect(migration).not.toMatch(/shipping\.rate_tables/i);
    expect(migration).not.toMatch(/UPDATE\s+shipping\.service_levels/i);
  });
});
