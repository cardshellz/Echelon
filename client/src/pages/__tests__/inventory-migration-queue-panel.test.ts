import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { supplyTransformationsAdminViewSchema, type SupplyTransformationsAdminView } from "@shared/types/inventory-availability-admin";
import { inventoryAvailabilityBackfillQueueRowSchema } from "@shared/types/inventory-availability-backfill";
import { MigrationQueuePanel } from "../inventory-migration-queue-panel";

vi.mock("wouter", () => ({
  Link: ({ href, children }: { href: string; children?: ReactNode }) => createElement("a", { href }, children),
}));

const hash = "a".repeat(64);
const timestamp = "2026-09-18T12:00:00.000Z";
function rowFixture() {
  return inventoryAvailabilityBackfillQueueRowSchema.parse({
    productId: 12, productSku: "PRODUCT-12", productName: "Selected product",
    legacyInventoryStrategy: "physical_fungible", activeVariantCount: 0, activeRecipeCount: 0,
    classification: "legacy_fungible_directed_pool", inputHash: hash, resultHash: hash,
    candidateDefinitionHash: hash,
    candidateDefinition: { buildToPromiseEnabled: false, paths: [], recipeBindings: [] },
    draftDefinition: { buildToPromiseEnabled: false, paths: [], recipeBindings: [] },
    issues: [], queueState: "awaiting_review",
    draft: { modelId: 100, version: 3, definitionHash: hash, headRevision: "4",
      origin: "operator", originInputHash: null, originResultHash: null, operatorInputHash: hash,
      definitionMatch: false, provenanceMatch: false, candidateMatch: false },
    review: null, latestShadow: null,
  });
}
function viewFixture(): SupplyTransformationsAdminView {
  return supplyTransformationsAdminViewSchema.parse({
    product: { id: 12, sku: "PRODUCT-12", name: "Selected product", isActive: true, legacyInventoryStrategy: "physical_fungible" },
    variants: [], recipes: [], head: { revision: "4", activeModelId: null, draftModelId: 100 }, activeModel: null,
    draftModel: { id: 100, productId: 12, version: 3, lifecycleStatus: "draft", buildToPromiseEnabled: false,
      definitionHash: hash, origin: "operator", originInputHash: null, originResultHash: null,
      validationState: "valid", validationErrors: [], changeReason: "Reviewed", createdBy: "operator-1",
      createdAt: timestamp, updatedAt: timestamp, bindings: [], paths: [] },
    runtimeAuthority: { kind: "legacy_inventory_strategy", value: "physical_fungible", draftAffectsRuntime: false },
  });
}
function render(view: SupplyTransformationsAdminView | null, canEdit = true) {
  const row = rowFixture();
  const onReview = vi.fn();
  const html = renderToStaticMarkup(createElement(MigrationQueuePanel, {
    queue: null, rows: [row], selectedRow: row, selectedView: view, isLoading: false, error: null,
    canEdit, search: "", stateFilter: "all", backfillReason: "", refreshBackfillReason: "", reviewReason: "Reviewed exact evidence",
    isApplying: false, isRefreshing: false, isReviewing: false,
    onSearchChange: vi.fn(), onStateFilterChange: vi.fn(), onSelectProduct: vi.fn(),
    onBackfillReasonChange: vi.fn(), onRefreshBackfillReasonChange: vi.fn(), onReviewReasonChange: vi.fn(),
    onApply: vi.fn(), onRefresh: vi.fn(), onReview,
  }));
  expect(onReview).not.toHaveBeenCalled();
  return html;
}

describe("relocated migration queue manual review", () => {
  it("keeps review disabled while matching product evidence is missing", () => {
    const html = render(null);
    expect(html).toContain("Waiting for matching product and draft details");
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Approve saved rules/);
  });

  it.each(["product", "model", "definition", "head"] as const)("rejects mismatched %s evidence", (field) => {
    const view = viewFixture();
    if (field === "product") view.product.id = 13;
    if (field === "model") view.draftModel!.id = 101;
    if (field === "definition") view.draftModel!.definitionHash = "b".repeat(64);
    if (field === "head") view.head!.revision = "5";
    expect(render(view)).toMatch(/<button[^>]* disabled=""[^>]*>Approve saved rules/);
  });

  it("shows exact saved evidence and editor deep link with review available only when matched", () => {
    const html = render(viewFixture());
    expect(html).not.toMatch(/<button[^>]* disabled=""[^>]*>Approve saved rules/);
    expect(html).toContain("Exact saved definition and recipe evidence");
    expect(html).toContain("recipeBindings");
    expect(html).toContain("Immutable recipe snapshots");
    expect(html).toContain('href="/inventory/supply-transformations?productId=12"');
    expect(html).not.toContain("draft evidence below");
  });

  it("does not expose review actions to a view-only user", () => {
    expect(render(viewFixture(), false)).not.toContain("Approve saved rules");
  });
});
