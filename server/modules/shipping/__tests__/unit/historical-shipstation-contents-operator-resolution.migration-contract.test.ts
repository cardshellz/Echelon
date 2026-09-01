import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const migrationPath = "migrations/0630_historical_shipstation_contents_operator_resolution.sql";

describe("historical ShipStation contents operator resolution migration", () => {
  it("permits only the reviewed manual status with complete operator audit evidence", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("historical_shipstation_contents_operator_resolution");
    expect(migration).toContain("wms_confirmed_after_provider_conflict");
    expect(migration).toMatch(/actorRole' IN \('admin', 'lead'\)/);
    expect(migration).toMatch(/LENGTH\(sanitized_payload->>'actorUserId'\) <= 190/);
    expect(migration).toMatch(/LENGTH\(sanitized_payload->>'reason'\) <= 500/);
    expect(migration).toMatch(/providerEvidenceHash' ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(migration).toContain("status' = 'authoritative'");
  });

  it("keeps automatic recovery free of operator-supplied audit fields", () => {
    const migration = readFileSync(migrationPath, "utf8");

    expect(migration).toContain("NOT (sanitized_payload ? 'actorUserId')");
    expect(migration).toContain("NOT (sanitized_payload ? 'actorRole')");
    expect(migration).toContain("NOT (sanitized_payload ? 'reason')");
  });
});
