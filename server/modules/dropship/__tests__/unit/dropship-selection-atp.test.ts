import { describe, expect, it } from "vitest";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import {
  computeDropshipMarketplaceQuantity,
  evaluateDropshipVendorCatalogSelection,
  type DropshipVendorSelectionRule,
} from "../../domain/vendor-selection";
import {
  DropshipSelectionAtpService,
  hashVendorSelectionRules,
  normalizeVendorSelectionRule,
  type DropshipAtpProvider,
  type DropshipSelectionAtpRepository,
  type DropshipVendorCatalogCandidate,
  type DropshipVendorProfile,
  type DropshipVendorSelectionRuleRecord,
  type DropshipVendorVariantOverrideRecord,
  type ReplaceDropshipVendorSelectionRulesRepositoryInput,
  type ReplaceDropshipVendorSelectionRulesRepositoryResult,
} from "../../application/dropship-selection-atp-service";
import type { ListDropshipVendorSelectionRulesInput, PreviewDropshipVendorCatalogInput } from "../../application/dropship-selection-dtos";

const now = new Date("2026-04-30T12:00:00.000Z");

const candidate: DropshipVendorCatalogCandidate = {
  productId: 10,
  productSku: "P-10",
  productName: "Product 10",
  productVariantId: 20,
  variantSku: "V-20",
  variantName: "Variant 20",
  unitsPerVariant: 5,
  productLineIds: [30],
  productLineNames: ["Line"],
  category: "Supplies",
  productIsActive: true,
  variantIsActive: true,
};

const exposedDecision = {
  exposed: true,
  reason: "exposed" as const,
  includeRuleIds: [1],
  excludeRuleIds: [],
};

describe("dropship vendor selection domain", () => {
  it("does not allow vendor rules to bypass admin catalog exposure", () => {
    const decision = evaluateDropshipVendorCatalogSelection({
      candidate,
      adminExposureDecision: {
        exposed: false,
        reason: "missing_include_rule",
        includeRuleIds: [],
        excludeRuleIds: [],
      },
      rules: [{ id: 10, scopeType: "catalog", action: "include" }],
      rawAtpUnits: 5,
    });

    expect(decision.selected).toBe(false);
    expect(decision.reason).toBe("not_exposed_by_admin");
    expect(decision.marketplaceQuantity).toBe(0);
  });

  it("lets a vendor exclusion block a broader vendor include", () => {
    const rules: DropshipVendorSelectionRule[] = [
      { id: 10, scopeType: "catalog", action: "include" },
      { id: 11, scopeType: "variant", action: "exclude", productVariantId: 20 },
    ];

    const decision = evaluateDropshipVendorCatalogSelection({
      candidate,
      adminExposureDecision: exposedDecision,
      rules,
      rawAtpUnits: 5,
    });

    expect(decision.selected).toBe(false);
    expect(decision.reason).toBe("excluded_by_vendor_rule");
    expect(decision.includeRuleIds).toEqual([10]);
    expect(decision.excludeRuleIds).toEqual([11]);
  });

  it("keeps category selections connected to matching new SKUs without auto-listing by default", () => {
    const decision = evaluateDropshipVendorCatalogSelection({
      candidate,
      adminExposureDecision: exposedDecision,
      rules: [{
        id: 12,
        scopeType: "category",
        action: "include",
        category: "supplies",
        autoConnectNewSkus: true,
        autoListNewSkus: false,
      }],
      rawAtpUnits: 9,
    });

    expect(decision.selected).toBe(true);
    expect(decision.autoConnectNewSkus).toBe(true);
    expect(decision.autoListNewSkus).toBe(false);
    expect(decision.marketplaceQuantity).toBe(9);
  });

  it("applies vendor variant disable and quantity cap overrides after selection", () => {
    const selected = evaluateDropshipVendorCatalogSelection({
      candidate,
      adminExposureDecision: exposedDecision,
      rules: [{ id: 13, scopeType: "catalog", action: "include" }],
      rawAtpUnits: 9,
      override: { productVariantId: 20, marketplaceQuantityCap: 4 },
    });
    const disabled = evaluateDropshipVendorCatalogSelection({
      candidate,
      adminExposureDecision: exposedDecision,
      rules: [{ id: 13, scopeType: "catalog", action: "include" }],
      rawAtpUnits: 9,
      override: { productVariantId: 20, enabledOverride: false, marketplaceQuantityCap: 4 },
    });

    expect(selected.selected).toBe(true);
    expect(selected.marketplaceQuantity).toBe(4);
    expect(selected.quantityCapApplied).toBe(true);
    expect(disabled.selected).toBe(false);
    expect(disabled.reason).toBe("disabled_by_vendor_override");
    expect(disabled.marketplaceQuantity).toBe(0);
  });

  it("normalizes invalid or negative ATP to zero", () => {
    expect(computeDropshipMarketplaceQuantity(-5)).toBe(0);
    expect(computeDropshipMarketplaceQuantity(Number.NaN)).toBe(0);
  });
});

describe("DropshipSelectionAtpService", () => {
  it("hashes selection rules independently of request order", () => {
    const first = [
      normalizeVendorSelectionRule({
        scopeType: "catalog",
        action: "include",
        autoConnectNewSkus: true,
        autoListNewSkus: false,
        priority: 0,
      }),
      normalizeVendorSelectionRule({
        scopeType: "variant",
        action: "exclude",
        productVariantId: 20,
        autoConnectNewSkus: true,
        autoListNewSkus: false,
        priority: 5,
      }),
    ];
    const second = [...first].reverse();

    expect(hashVendorSelectionRules(first)).toBe(hashVendorSelectionRules(second));
  });

  it("rejects duplicate vendor selection rules before repository writes", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    const service = makeService(repository, new FakeAtpProvider());

    await expect(service.replaceSelectionRules({
      vendorId: 1,
      idempotencyKey: "selection-rules-001",
      actor: { actorType: "vendor", actorId: "member-1" },
      rules: [
        { scopeType: "catalog", action: "include" },
        { scopeType: "catalog", action: "include" },
      ],
    })).rejects.toThrow();
    expect(repository.lastReplace).toBeNull();
  });

  it("previews only selected rows and returns capped vendor-facing marketplace quantity", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.catalogRules = [{ id: 1, scopeType: "catalog", action: "include" }];
    repository.selectionRules = [makeSelectionRuleRecord({ id: 2, scopeType: "catalog", action: "include" })];
    repository.candidates = [
      candidate,
      { ...candidate, productVariantId: 21, variantSku: "V-21", category: "Other" },
    ];
    repository.overrides = [{
      id: 1,
      vendorId: 1,
      productVariantId: 20,
      enabledOverride: null,
      marketplaceQuantityCap: 2,
      notes: null,
      createdAt: now,
      updatedAt: now,
    }];
    const atp = new FakeAtpProvider();
    atp.baseAtpByProductId.set(10, 17);
    const service = makeService(repository, atp);

    const result = await service.previewCatalog({
      vendorId: 1,
      selectedOnly: true,
    });

    expect(result.total).toBe(2);
    expect(result.rows[0].selectionDecision.selected).toBe(true);
    expect(result.rows[0].selectionDecision.marketplaceQuantity).toBe(2);
    expect(result.rows[0].selectionDecision.quantityCapApplied).toBe(true);
    expect(result.rows[0]).not.toHaveProperty("rawAtpUnits");
  });

  it("requires a vendor profile before catalog access", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.vendor = null;
    const service = makeService(repository, new FakeAtpProvider());

    await expect(service.requireVendorForMember("member-1")).rejects.toThrow("vendor profile");
  });
});

class FakeDropshipSelectionAtpRepository implements DropshipSelectionAtpRepository {
  vendor: DropshipVendorProfile | null = {
    vendorId: 1,
    memberId: "member-1",
    status: "active",
    entitlementStatus: "active",
  };
  catalogRules: DropshipCatalogExposureRule[] = [];
  selectionRules: DropshipVendorSelectionRuleRecord[] = [];
  candidates: DropshipVendorCatalogCandidate[] = [];
  overrides: DropshipVendorVariantOverrideRecord[] = [];
  lastReplace: ReplaceDropshipVendorSelectionRulesRepositoryInput | null = null;

  async findVendorByMemberId(): Promise<DropshipVendorProfile | null> {
    return this.vendor;
  }

  async listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]> {
    return this.catalogRules;
  }

  async listSelectionRules(): Promise<DropshipVendorSelectionRuleRecord[]> {
    return this.selectionRules;
  }

  async replaceSelectionRules(
    input: ReplaceDropshipVendorSelectionRulesRepositoryInput,
  ): Promise<ReplaceDropshipVendorSelectionRulesRepositoryResult> {
    this.lastReplace = input;
    this.selectionRules = input.rules.map((rule, index) => makeSelectionRuleRecord({
      ...rule,
      id: index + 1,
      revisionId: 1001,
      vendorId: input.vendorId,
    }));
    return {
      revisionId: 1001,
      idempotentReplay: false,
      rules: this.selectionRules,
    };
  }

  async listVendorCatalogCandidates(
    _input: PreviewDropshipVendorCatalogInput,
  ): Promise<DropshipVendorCatalogCandidate[]> {
    return this.candidates;
  }

  async listVariantOverrides(): Promise<DropshipVendorVariantOverrideRecord[]> {
    return this.overrides;
  }
}

class FakeAtpProvider implements DropshipAtpProvider {
  baseAtpByProductId = new Map<number, number>();

  async getBaseAtpByProductIds(productIds: readonly number[]): Promise<Map<number, number>> {
    return new Map(productIds.map((productId) => [
      productId,
      this.baseAtpByProductId.get(productId) ?? 0,
    ]));
  }
}

function makeService(
  repository: DropshipSelectionAtpRepository,
  atp: DropshipAtpProvider,
): DropshipSelectionAtpService {
  return new DropshipSelectionAtpService({
    clock: { now: () => now },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    repository,
    atp,
  });
}

function makeSelectionRuleRecord(
  input: Partial<DropshipVendorSelectionRuleRecord> & Pick<DropshipVendorSelectionRuleRecord, "id" | "scopeType" | "action">,
): DropshipVendorSelectionRuleRecord {
  return {
    revisionId: null,
    vendorId: 1,
    productLineId: null,
    productId: null,
    productVariantId: null,
    category: null,
    autoConnectNewSkus: true,
    autoListNewSkus: false,
    priority: 0,
    isActive: true,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}
