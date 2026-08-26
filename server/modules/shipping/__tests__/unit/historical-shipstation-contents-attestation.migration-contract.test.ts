import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migration = readFileSync(
  "migrations/0621_shipping_provider_label_content_attestations.sql",
  "utf8",
);
const schema = readFileSync("shared/schema/fulfillment.schema.ts", "utf8");
const setup = readFileSync("test/setup-integration.ts", "utf8");

describe("historical ShipStation contents attestation migration", () => {
  it("keeps operator attestations separate, append-only, and idempotent", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.shipping_provider_label_content_attestations");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.shipping_provider_label_content_attestation_resolutions");
    expect(migration).toContain("uq_shipping_provider_label_content_attestations_label_preview");
    expect(migration).toContain("uq_shipping_provider_label_content_attestation_resolutions_event");
    expect(migration).toContain("shipping_provider_label_content_attestations_immutable");
    expect(migration).toContain("shipping_provider_label_content_attestation_resolutions_immutable");
    expect(migration).toContain("REFERENCES identity.users(id) ON DELETE RESTRICT");
    expect(migration).toContain("actor_role IN ('admin', 'lead')");
    expect(migration).not.toMatch(/ALTER TABLE wms\.shipping_provider_label_events[\s\S]*ADD COLUMN/);
  });

  it("binds every resolution to one event on the same provider label", () => {
    expect(migration).toContain("uq_shipping_provider_label_events_id_label");
    expect(migration).toMatch(/FOREIGN KEY \(\s*shipping_provider_label_event_id,\s*shipping_provider_label_id\s*\)[\s\S]*REFERENCES wms\.shipping_provider_label_events/);
    expect(migration).toMatch(/FOREIGN KEY \(\s*shipping_provider_label_content_attestation_id,\s*shipping_provider_label_id\s*\)[\s\S]*REFERENCES wms\.shipping_provider_label_content_attestations/);
  });

  it("keeps Drizzle and the disposable PostgreSQL harness aligned", () => {
    expect(schema).toContain("shippingProviderLabelContentAttestations");
    expect(schema).toContain("shippingProviderLabelContentAttestationResolutions");
    expect(schema).toContain("uq_shipping_provider_label_content_attestation_resolutions_event");
    expect(setup).toContain("migrations/0621_shipping_provider_label_content_attestations.sql");
    expect(setup).toContain('"wms.shipping_provider_label_content_attestation_resolutions"');
    expect(setup).toContain('"wms.shipping_provider_label_content_attestations"');
  });
});
