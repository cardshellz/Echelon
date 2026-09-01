import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync("migrations/0632_inventory_channel_exposure_policy.sql", "utf8");
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
    expect(schema).toContain("table.shareBps} BETWEEN 0 AND 10000");
  });

  it("gates view and edit routes and exposes no activation or publication command", () => {
    expect(routes.match(/requirePermission\("inventory_planning", "view"\)/g)).toHaveLength(2);
    expect(routes.match(/requirePermission\("inventory_planning", "edit"\)/g)).toHaveLength(2);
    expect(routes).not.toContain('requirePermission("inventory_planning", "activate")');
    expect(routes).not.toMatch(/outbox|provider.*write/i);
    expect(registry).toContain("registerInventoryChannelExposureRoutes(app)");
    expect(page).toContain("Draft / preview only");
    expect(page).toContain("Legacy runtime retained");
    expect(page).not.toMatch(/activate|publish now/i);
  });
});
