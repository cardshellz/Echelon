import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import type { SupplyTransformationsAdminView, TransformationAdminModel } from "@shared/types/inventory-availability-admin";
import { ProductConversionCard, ProductConversionSummary } from "../ProductConversionCard";

const state = vi.hoisted(() => ({ canView: true, data: undefined as SupplyTransformationsAdminView | undefined, isError: false }));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ hasPermission: () => state.canView }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(() => ({ data: state.data, isError: state.isError })) }));

const HASH = "a".repeat(64);
const TIME = "2026-09-18T12:00:00.000Z";
function model(): TransformationAdminModel {
  return { id: 501, productId: 10, version: 3, lifecycleStatus: "sealed", buildToPromiseEnabled: false,
    definitionHash: HASH, origin: "operator", originInputHash: null, originResultHash: null,
    validationState: "valid", validationErrors: [], changeReason: "Reviewed", createdBy: "operator",
    createdAt: TIME, updatedAt: TIME, bindings: [],
    paths: [{ sourceVariantId: 2, destinationVariantId: 1, inputQty: 1, outputQty: 5,
      sourceUnitsPerVariant: 5, destinationUnitsPerVariant: 1, operationType: "break_pack",
      authorityState: "allowed", transformationRecipeBindingKey: null }] };
}
function view(): SupplyTransformationsAdminView {
  return { product: { id: 10, sku: "PRODUCT", name: "Product", isActive: true, legacyInventoryStrategy: "physical_fungible" },
    variants: [{ id: 1, productId: 10, sku: "EA", name: "Each", unitsPerVariant: 1, uomType: "each", isActive: true },
      { id: 2, productId: 10, sku: "P5", name: "Five pack", unitsPerVariant: 5, uomType: "pack", isActive: true }],
    recipes: [], head: { revision: "3", activeModelId: 501, draftModelId: null }, activeModel: model(), draftModel: null,
    runtimeSelection: { authority: "canonical", revision: "2", activationRunId: "1" },
    runtimeAuthority: { kind: "legacy_inventory_strategy", value: "physical_fungible", draftAffectsRuntime: false } };
}
const render = () => renderToStaticMarkup(createElement(ProductConversionSummary, { productId: 10, enabled: true }));
beforeEach(() => { state.canView = true; state.data = view(); state.isError = false; vi.clearAllMocks(); });

describe("product overview active package sharing", () => {
  it("shows named directions from the sealed model separately from the proposed draft", () => {
    state.data!.draftModel = { ...model(), id: 502, version: 4, lifecycleStatus: "draft", paths: [] };
    state.data!.head!.draftModelId = 502;
    const html = render();
    expect(html).toContain("1 P5 → 5 EA");
    expect(html).toContain("Sealed package sharing · v3");
    expect(html).toContain("Active — in use: v3");
    expect(html).toContain("Proposed draft v4 — not live");
    expect(html).not.toContain("No allowed package-sharing directions");
  });

  it("never calls a sealed model live while legacy runtime remains selected", () => {
    state.data!.runtimeSelection = { authority: "legacy", revision: "1", activationRunId: null };
    const html = render();
    expect(html).toContain("Existing inventory rules are in use");
    expect(html).toContain("1 P5 → 5 EA");
    expect(html).not.toContain("Active — in use");
  });

  it("does not substitute draft-only paths for absent sealed sharing", () => {
    state.data!.draftModel = { ...model(), id: 502, version: 4, lifecycleStatus: "draft" };
    state.data!.activeModel = null;
    state.data!.head = { revision: "1", activeModelId: null, draftModelId: 502 };
    const html = render();
    expect(html).toContain("No sealed model is recorded");
    expect(html).toContain("Proposed draft v4 — not live");
    expect(html).not.toContain("1 P5 → 5 EA");
  });

  it("does not display unverified or blocked paths as allowed sharing", () => {
    state.data!.head!.activeModelId = 999;
    expect(render()).not.toContain("1 P5 → 5 EA");
    expect(render()).toContain("could not be verified");
    state.data = view();
    state.data.activeModel!.paths[0]!.authorityState = "blocked";
    expect(render()).toContain("No allowed package-sharing directions");
  });

  it("collapses long path lists and preserves every named direction", () => {
    state.data!.activeModel!.paths = Array.from({ length: 4 }, (_, index) => ({
      ...model().paths[0]!, sourceVariantId: index + 2,
    }));
    const html = render();
    expect(html).toContain("<details>");
    expect(html).toContain("4 allowed directions");
    expect(html).toContain("1 P5 → 5 EA");
    expect(html).toContain("1 Variant #5 → 5 EA");
  });

  it("does not read or expose cached sharing without planning view permission", () => {
    state.canView = false;
    expect(render()).toContain("Inventory planning view permission is required");
    expect(useQuery).not.toHaveBeenCalled();
    expect(render()).not.toContain("P5");
  });

  it("hides cached evidence when its refresh failed", () => {
    state.isError = true;
    expect(render()).toContain("Conversion status unavailable");
    expect(render()).not.toContain("P5");
  });

  it("rejects a matching head whose model belongs to another product", () => {
    state.data!.activeModel!.productId = 999;
    expect(render()).toContain("could not be verified");
    expect(render()).not.toContain("1 P5 → 5 EA");
  });

  it("does not mount a conversion card or query for physical-only products", () => {
    const html = renderToStaticMarkup(createElement(ProductConversionCard, {
      productId: 10, inventoryStrategy: "physical_only", enabled: true,
    }));
    expect(html).toBe("");
    expect(useQuery).not.toHaveBeenCalled();
  });
});
