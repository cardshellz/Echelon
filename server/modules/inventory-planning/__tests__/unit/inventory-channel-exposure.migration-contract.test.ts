import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/0632_inventory_channel_exposure_policy.sql", "utf8");
const readinessMigration = readFileSync("migrations/0633_inventory_publication_readiness.sql", "utf8");
const destinationOwnerMigration = readFileSync(
  "migrations/0652_inventory_publication_destination_owners.sql",
  "utf8",
);
const targetResumeMigration = readFileSync(
  "migrations/0670_inventory_publication_target_resume.sql",
  "utf8",
);
const targetHoldMigration = readFileSync(
  "migrations/0677_inventory_publication_target_hold.sql",
  "utf8",
);
const schema = readFileSync("shared/schema/inventory-planning.schema.ts", "utf8");
const routes = readFileSync(
  "server/modules/inventory-planning/interfaces/http/inventory-channel-exposure.routes.ts",
  "utf8",
);
const registry = readFileSync("server/routes.ts", "utf8");
const page = readFileSync("client/src/features/channel-inventory/ChannelInventoryPage.tsx", "utf8");
const publishingTab = readFileSync(
  "client/src/features/channel-inventory/components/PublishingTab.tsx",
  "utf8",
);

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

  it("gates configuration, preview, stop, and evidence-bound resume with the intended roles", () => {
    expect(routes.match(/requirePermission\("inventory_planning", "view"\)/g)).toHaveLength(2);
    // Setup routes (three drafts, single destination registration, and bulk
    // channel destination setup) are edit-gated; everything that can move a
    // target toward publishing stays activate-gated.
    expect(routes.match(/requirePermission\("inventory_planning", "edit"\)/g)).toHaveLength(5);
    // Stop, resume review, resume, and the hold/release pair: each changes what
    // a marketplace sells, so all six carry the activation permission.
    expect(routes.match(/requirePermission\("inventory_planning", "activate"\)/g)).toHaveLength(6);
    // Bulk setup creates disabled targets only, so it must never be activate-gated
    // nor slip into the activation surface.
    expect(routes).toContain("channel-destinations");
    expect(routes).toMatch(
      /channel-destinations"[\s\S]{0,400}?requirePermission\("inventory_planning", "edit"\)/,
    );
    expect(routes).toContain("publication-target-resume-review");
    expect(routes).toContain("publication-target-resume");
    expect(routes).toContain("publication-target-stop");
    expect(registry).toContain("registerInventoryChannelExposureRoutes(app)");
    // The live allocator is read from the runtime-authority singleton, never asserted.
    expect(page).toContain("<InventoryRuntimeAuthorityBadge />");
    expect(page).not.toContain("Legacy runtime retained");
    // Readiness inclusion stays a reviewed, reason-gated step; nothing publishes on demand.
    expect(publishingTab).toContain("Include in readiness review");
    expect(publishingTab).toContain("setReadinessInclusion");
    expect(page).not.toMatch(/publish now/i);
    expect(publishingTab).not.toMatch(/publish now/i);
  });

  it("adds append-only exact-revision readiness evidence without seeding or activating targets", () => {
    expect(targetResumeMigration).toContain(
      "CREATE TABLE inventory.inventory_publication_target_resume_reviews",
    );
    expect(targetResumeMigration).toContain(
      "inventory_publication_target_resume_reviews_append_only_guard",
    );
    expect(targetResumeMigration).toContain(
      "REFERENCES inventory.inventory_publication_targets(id) ON DELETE RESTRICT",
    );
    expect(targetResumeMigration).toContain(
      "REFERENCES inventory.availability_activation_runs(id) ON DELETE RESTRICT",
    );
    expect(targetResumeMigration).toContain("jsonb_typeof(evidence_payload) = 'object'");
    expect(targetResumeMigration).toContain("readiness_hash VARCHAR(64) NOT NULL");
    expect(targetResumeMigration).not.toMatch(/UPDATE\s+inventory\.inventory_publication_targets/i);
    expect(targetResumeMigration).not.toMatch(/INSERT\s+INTO/i);
    expect(schema).toContain('"inventory_publication_target_resume_reviews"');
    expect(schema).toContain("inventoryPublicationTargetResumeReviews");
  });

  it("adds a publication hold that keeps a target live but at zero, gated like activation", () => {
    expect(targetHoldMigration).toContain("ADD COLUMN hold_reason VARCHAR(120)");
    expect(targetHoldMigration).toContain("ADD COLUMN held_at TIMESTAMPTZ");
    expect(targetHoldMigration).toContain("ADD COLUMN held_by VARCHAR(100)");
    expect(targetHoldMigration).toContain("inventory_publication_targets_hold_chk");
    expect(targetHoldMigration).toContain("(hold_reason IS NULL AND held_at IS NULL AND held_by IS NULL)");
    expect(targetHoldMigration).not.toMatch(/UPDATE\s+inventory\.inventory_publication_targets/i);
    expect(targetHoldMigration).not.toMatch(/INSERT\s+INTO/i);
    expect(schema).toContain('holdReason: varchar("hold_reason", { length: 120 })');
    expect(schema).toContain("inventory_publication_targets_hold_chk");
    expect(routes).toContain("/api/inventory-planning/admin/channel-exposure/publication-target-hold");
    expect(routes).toContain("/api/inventory-planning/admin/channel-exposure/publication-target-release");
    for (const path of ["publication-target-hold", "publication-target-release"]) {
      const route = routes.slice(routes.indexOf(`/api/inventory-planning/admin/channel-exposure/${path}"`));
      expect(route.slice(0, 200)).toContain('requirePermission("inventory_planning", "activate")');
    }
  });
});
