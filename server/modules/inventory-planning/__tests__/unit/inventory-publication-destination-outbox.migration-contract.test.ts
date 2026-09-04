import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  process.cwd(),
  "migrations/220_inventory_publication_outbox_destination_owners.sql",
);
const migration = fs.readFileSync(migrationPath, "utf8");

describe("inventory publication outbox destination-owner migration", () => {
  it("persists exactly one immutable owner and preserves existing rows as Channels-owned", () => {
    expect(migration).toContain("destination_kind_snapshot VARCHAR(30) NOT NULL DEFAULT 'channel_connection'");
    expect(migration).toContain("dropship_store_connection_id_snapshot INTEGER");
    expect(migration).toContain("ALTER COLUMN channel_connection_id_snapshot DROP NOT NULL");
    expect(migration).toContain("inventory_publication_outbox_destination_chk");
    expect(migration).toContain("NEW.destination_kind_snapshot IS DISTINCT FROM OLD.destination_kind_snapshot");
    expect(migration).toContain("NEW.dropship_store_connection_id_snapshot");
  });

  it("binds inserts to the exact target owner and records stale suppression as attempt evidence", () => {
    expect(migration).toContain("NEW.destination_kind_snapshot IS DISTINCT FROM target_destination_kind");
    expect(migration).toContain("target_dropship_store_connection_id");
    expect(migration).toContain("lower(NEW.provider_key_snapshot) IS DISTINCT FROM target_provider_key");
    expect(migration).toContain("NEW.publication_target_revision_snapshot IS DISTINCT FROM target_revision");
    expect(migration).toContain("'superseded'");
  });

  it("does not seed state or mutate quantities", () => {
    expect(migration).not.toMatch(/INSERT\s+INTO/i);
    expect(migration).not.toMatch(/UPDATE\s+inventory\./i);
    expect(migration).not.toContain("desired_quantity =");
  });
});
