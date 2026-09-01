import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("inventory availability Phase 1 admin surface contract", () => {
  it("registers only draft master-data routes with separate view and edit abilities", () => {
    const routes = source(
      "server/modules/inventory-planning/interfaces/http/inventory-availability-master-data.routes.ts",
    );
    const routeRegistry = source("server/routes.ts");

    expect(routeRegistry).toContain("registerInventoryAvailabilityMasterDataRoutes(app)");
    expect(routes).toContain('requirePermission("inventory_planning", "view")');
    expect(routes).toContain('requirePermission("inventory_planning", "edit")');
    expect(routes).not.toContain('/activate"');
    expect(routes).not.toContain("channel quantity");
    expect(routes).not.toContain("reservation");
  });

  it("seeds activation as a separate ability without exposing activation behavior", () => {
    const migration = source("migrations/213_inventory_availability_admin_permissions.sql");
    const permissions = source("server/modules/identity/domain/identity.domain.ts");

    expect(permissions).toContain('{ resource: "inventory_planning", action: "view"');
    expect(permissions).toContain('{ resource: "inventory_planning", action: "edit"');
    expect(permissions).toContain('{ resource: "inventory_planning", action: "activate"');
    expect(migration).toContain("'inventory_planning'");
    expect(migration).toContain("'activate'");
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?inventory\./i);
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?channels\./i);
  });

  it("places conversion authority under destination SKU columns and states runtime isolation", () => {
    const page = source("client/src/pages/SupplyTransformations.tsx");
    const navigation = source("client/src/components/layout/AppShell.tsx");
    const app = source("client/src/App.tsx");

    expect(page).toContain("Authority by output SKU");
    expect(page).toContain("path.destinationVariantId === destination.id");
    expect(page).toContain("Drafts do not affect ATP");
    expect(page).toContain("Runtime ATP still reads legacy inventory strategy");
    expect(page).not.toContain("/activate");
    expect(navigation).toContain("Supply & Transformations");
    expect(navigation).toContain('requiredPermission: { resource: "inventory_planning", action: "view" }');
    expect(app).toContain('path="/inventory/supply-transformations"');
  });

  it("locks owner state before reference rows and never relies on key-share locks", () => {
    const repository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-master-data.repository.ts",
    );
    const createStart = repository.indexOf("async createTransformationModelDraft(");
    const updateStart = repository.indexOf("async updateTransformationModelDraft(");
    const refreshStart = repository.indexOf("async supersedeTransformationModelBackfillDraft(");
    const locationStart = repository.indexOf("async createLocationPromisePolicyDraft(");
    const createTransaction = repository.slice(createStart, updateStart);
    const updateTransaction = repository.slice(updateStart, refreshStart);
    const refreshTransaction = repository.slice(refreshStart, locationStart);

    expect(createTransaction.indexOf(".from(transformationModelHeads)"))
      .toBeLessThan(createTransaction.indexOf("assertTransformationReferences"));
    expect(updateTransaction.indexOf(".from(transformationModelHeads)"))
      .toBeLessThan(updateTransaction.indexOf("assertTransformationReferences"));
    expect(refreshTransaction.indexOf(".from(transformationModelHeads)"))
      .toBeLessThan(refreshTransaction.indexOf("loadInventoryAvailabilityBackfillSources"));
    expect(refreshTransaction.indexOf("loadInventoryAvailabilityBackfillSources"))
      .toBeLessThan(refreshTransaction.indexOf("assertTransformationReferences"));
    expect(createTransaction).toContain('.for("update")');
    expect(updateTransaction).toContain('.for("update")');
    expect(refreshTransaction).toContain('.for("update")');
    expect(refreshTransaction).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(repository).not.toContain("FOR KEY SHARE");
    expect(repository).toContain("FOR SHARE");
    expect(repository).toContain(
      "products -> product variants -> recipes -> recipe components",
    );
  });

  it("preserves stale Phase 3 drafts through a constrained superseded lifecycle", () => {
    const migration = source("migrations/0628_inventory_backfill_provenance_refresh.sql");
    const schema = source("shared/schema/inventory-planning.schema.ts");

    expect(migration).toContain("ADD COLUMN superseded_by VARCHAR(100)");
    expect(migration).toContain("lifecycle_status IN ('draft', 'sealed', 'retired', 'superseded')");
    expect(migration).toContain("only Phase 3 backfill drafts may be superseded");
    expect(migration).toContain("only the current transformation model draft may be superseded");
    expect(migration).toContain("transformation model definition fields cannot change while superseding");
    expect(migration).toContain("superseded Phase 3 draft % requires a current Phase 3 successor");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("inventory.guard_versioned_definition_update()");
    expect(schema).toContain('supersededBy: varchar("superseded_by"');
    expect(schema).toContain("${table.lifecycleStatus} = 'superseded'");
  });
});
