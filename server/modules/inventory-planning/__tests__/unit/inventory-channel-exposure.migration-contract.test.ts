import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/0632_inventory_channel_exposure_policy.sql", "utf8");
const readinessMigration = readFileSync("migrations/0633_inventory_publication_readiness.sql", "utf8");
const destinationOwnerMigration = readFileSync(
  "migrations/0652_inventory_publication_destination_owners.sql",
  "utf8",
);
const schema = readFileSync("shared/schema/inventory-planning.schema.ts", "utf8");
const routes = readFileSync(
  "server/modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes.ts",
  "utf8",
);
const registry = readFileSync("server/routes.ts", "utf8");
const page = readFileSync("client/src/pages/InventoryExposure.tsx", "utf8");

describe("inventory channel exposure inactive foundation", () => {
  it("creates versioned policy and source-binding heads without seeding authority", () => {
    expect(migration).toContain("CREATE TABLE inventory.channel_exposure_policy_versions");
    expect(migration).toContain("CREATE TABLE inventory.channel_exposure_policy_heads");
    expect(migration).toContain("CREATE TABLE inventory.publication_source_binding_versions");
    expect(migration).toContain("CREATE TABLE inventory.publication_source_binding_members");
    expect(migration).toContain("CREATE TABLE inventory.publication_source_binding_heads");
    expect(migration).not.toMatch(/INSERT\s+INTO\s+inventory\.(channel_exposure|publication_source)/i);
    expect(migration).toContain("only the binding referenced by the draft head may be edited");
    expect(migration).toContain("source binding members may change only on the current draft");
  });

  it("keeps Drizzle schema aligned with exact sellable-unit fields", () => {
    expect(schema).toContain('"channel_exposure_policy_versions"');
    expect(schema).toContain('maxPublishMode: varchar("max_publish_mode"');
    expect(schema).toContain('"publication_source_binding_members"');
    expect(schema).toContain('"publication_variant_mapping_versions_actor_chk"');
    expect(schema).toContain("table.shareBps} BETWEEN 0 AND 10000");
  });

  it("adds versioned exact target/SKU mappings and optimistic target revisions", () => {
    expect(readinessMigration).toContain("ADD COLUMN revision BIGINT NOT NULL DEFAULT 1");
    expect(readinessMigration).toContain("CREATE TABLE inventory.publication_variant_mapping_versions");
    expect(readinessMigration).toContain("CREATE TABLE inventory.publication_variant_mapping_heads");
    expect(readinessMigration).toContain("ADD COLUMN external_inventory_item_id_snapshot VARCHAR(240)");
    expect(readinessMigration).toContain("only the mapping referenced by the draft head may be edited");
    expect(readinessMigration).toContain("one provider inventory item cannot map to multiple SKUs");
    expect(readinessMigration).toContain("a draft publication variant mapping must be owned by its exact head");
    expect(readinessMigration).toContain("a publication target must be previewed before it becomes live");
    expect(readinessMigration).not.toMatch(/INSERT\s+INTO\s+inventory\.(publication_variant|inventory_publication)/i);
  });

  it("adds exact channel or dropship destination ownership without seeding runtime state", () => {
    expect(destinationOwnerMigration).toContain(
      "ADD COLUMN destination_kind VARCHAR(30) NOT NULL DEFAULT 'channel_connection'",
    );
    expect(destinationOwnerMigration).toContain(
      "REFERENCES dropship.dropship_store_connections(id)",
    );
    expect(destinationOwnerMigration).toContain(
      "inventory_publication_targets_destination_chk",
    );
    expect(destinationOwnerMigration).toContain(
      "inventory_publication_targets_channel_identity_uq",
    );
    expect(destinationOwnerMigration).toContain(
      "inventory_publication_targets_dropship_identity_uq",
    );
    expect(destinationOwnerMigration).toContain(
      "NEW.dropship_store_connection_id IS DISTINCT FROM OLD.dropship_store_connection_id",
    );
    expect(destinationOwnerMigration).toContain(
      "inventory_publication_readbacks_destination_snapshot_chk",
    );
    expect(destinationOwnerMigration).toContain(
      "DROP CONSTRAINT inventory_publication_readbacks_exact_target_snapshot_chk",
    );
    expect(destinationOwnerMigration).toContain(
      "ADD CONSTRAINT inventory_publication_readbacks_exact_target_snapshot_chk",
    );
    expect(destinationOwnerMigration).toContain(
      "OR dropship_store_connection_id_snapshot IS NOT NULL",
    );
    expect(destinationOwnerMigration).not.toMatch(/INSERT\s+INTO/i);
  });

  it("gates disabled configuration and preview admission but exposes no live publication command", () => {
    expect(routes.match(/requirePermission\("inventory_planning", "view"\)/g)).toHaveLength(2);
    expect(routes.match(/requirePermission\("inventory_planning", "edit"\)/g)).toHaveLength(4);
    expect(routes.match(/requirePermission\("inventory_planning", "activate"\)/g)).toHaveLength(1);
    expect(routes).not.toMatch(/outbox|provider.*write/i);
    expect(routes).not.toMatch(/state:\s*["']live["']/i);
    expect(registry).toContain("registerInventoryChannelExposureRoutes(app)");
    expect(page).toContain("Draft / preview only");
    expect(page).toContain("Legacy runtime retained");
    expect(page).toContain("Include in readiness preview");
    expect(page).not.toMatch(/publish now/i);
  });
});
