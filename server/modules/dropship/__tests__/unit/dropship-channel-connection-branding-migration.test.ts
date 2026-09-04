import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(
    process.cwd(),
    "migrations/0653_dropship_channel_connection_branding.sql",
  ),
  "utf8",
);

describe("0653 dropship channel connection branding migration", () => {
  it("creates immutable, revisioned, idempotent desired state", () => {
    expect(migrationSql).toContain(
      "CREATE TABLE dropship.dropship_channel_connection_branding_revisions",
    );
    expect(migrationSql).toContain(
      "UNIQUE (platform, use_case, environment, revision)",
    );
    expect(migrationSql).toContain("UNIQUE (command_id)");
    expect(migrationSql).toContain(
      "REFERENCES dropship.dropship_admin_config_commands(id) ON DELETE RESTRICT",
    );
    expect(migrationSql).toContain("BEFORE UPDATE OR DELETE");
    expect(migrationSql).toContain(
      "dropship_channel_connection_branding_revisions is append-only",
    );
  });

  it("constrains provider status, actions, actors, and nonempty names", () => {
    expect(migrationSql).toContain("'pending_external_update'");
    expect(migrationSql).toContain("'manually_verified'");
    expect(migrationSql).toContain("'provider_applied'");
    expect(migrationSql).toContain("'provider_failed'");
    expect(migrationSql).toContain("'name_requested'");
    expect(migrationSql).toContain("'external_update_verified'");
    expect(migrationSql).toContain(
      "provider_resource_fingerprint ~ '^[0-9a-f]{64}$'",
    );
    expect(migrationSql).toContain(
      "action = 'external_update_verified' AND provider_status = 'manually_verified'",
    );
    expect(migrationSql).toContain(
      "provider_status NOT IN ('manually_verified', 'provider_applied')",
    );
    expect(migrationSql).toContain("actor_type IN ('admin', 'system')");
    expect(migrationSql).toContain(
      "btrim(customer_facing_app_name) <> ''",
    );
    expect(migrationSql).toContain(
      "customer_facing_app_name !~ '[[:cntrl:]]'",
    );
  });
});
