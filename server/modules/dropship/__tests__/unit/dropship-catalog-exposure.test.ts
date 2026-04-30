import { describe, expect, it } from "vitest";
import {
  evaluateDropshipCatalogExposure,
  type DropshipCatalogExposureRule,
  type DropshipCatalogVariantCandidate,
} from "../../domain/catalog-exposure";
import {
  DropshipCatalogExposureService,
  hashCatalogExposureRules,
  normalizeCatalogExposureRule,
  type DropshipCatalogExposureRepository,
  type DropshipCatalogExposureRuleRecord,
  type DropshipCatalogPreviewCandidate,
  type ReplaceDropshipCatalogExposureRulesRepositoryInput,
  type ReplaceDropshipCatalogExposureRulesRepositoryResult,
} from "../../application/dropship-catalog-exposure-service";

const now = new Date("2026-04-30T12:00:00.000Z");

const activeCandidate: DropshipCatalogVariantCandidate = {
  productId: 10,
  productVariantId: 20,
  productLineIds: [30],
  category: "Supplies",
  productIsActive: true,
  variantIsActive: true,
};

describe("dropship catalog exposure domain", () => {
  it("requires at least one include rule before exposing a variant", () => {
    const decision = evaluateDropshipCatalogExposure(activeCandidate, [], now);

    expect(decision).toEqual({
      exposed: false,
      reason: "missing_include_rule",
      includeRuleIds: [],
      excludeRuleIds: [],
    });
  });

  it("exposes active variants through matching admin include rules", () => {
    const decision = evaluateDropshipCatalogExposure(
      activeCandidate,
      [{ id: 1, scopeType: "product_line", action: "include", productLineId: 30 }],
      now,
    );

    expect(decision.exposed).toBe(true);
    expect(decision.includeRuleIds).toEqual([1]);
  });

  it("lets any active exclusion rule block a broader include", () => {
    const rules: DropshipCatalogExposureRule[] = [
      { id: 1, scopeType: "catalog", action: "include" },
      { id: 2, scopeType: "variant", action: "exclude", productVariantId: 20 },
    ];

    const decision = evaluateDropshipCatalogExposure(activeCandidate, rules, now);

    expect(decision.exposed).toBe(false);
    expect(decision.reason).toBe("excluded_by_admin_rule");
    expect(decision.includeRuleIds).toEqual([1]);
    expect(decision.excludeRuleIds).toEqual([2]);
  });

  it("blocks inactive products or variants even when rules include them", () => {
    const decision = evaluateDropshipCatalogExposure(
      { ...activeCandidate, variantIsActive: false },
      [{ id: 1, scopeType: "catalog", action: "include" }],
      now,
    );

    expect(decision.exposed).toBe(false);
    expect(decision.reason).toBe("inactive_product_or_variant");
  });

  it("honors rule effective windows deterministically from the injected clock", () => {
    const decision = evaluateDropshipCatalogExposure(
      activeCandidate,
      [{
        id: 1,
        scopeType: "catalog",
        action: "include",
        startsAt: new Date("2026-04-30T12:01:00.000Z"),
      }],
      now,
    );

    expect(decision.exposed).toBe(false);
    expect(decision.reason).toBe("missing_include_rule");
  });
});

describe("DropshipCatalogExposureService", () => {
  it("normalizes and hashes rules independently of request order", () => {
    const first = [
      normalizeCatalogExposureRule({ scopeType: "catalog", action: "include", priority: 0 }),
      normalizeCatalogExposureRule({ scopeType: "variant", action: "exclude", productVariantId: 20, priority: 5 }),
    ];
    const second = [...first].reverse();

    expect(hashCatalogExposureRules(first)).toBe(hashCatalogExposureRules(second));
  });

  it("replaces active rules through an idempotent repository command", async () => {
    const repository = new FakeCatalogExposureRepository();
    const service = new DropshipCatalogExposureService({
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      repository,
    });

    const result = await service.replaceRules({
      idempotencyKey: "catalog-rules-001",
      actor: { actorType: "admin", actorId: "admin-1" },
      rules: [
        { scopeType: "catalog", action: "include" },
        { scopeType: "category", action: "exclude", category: " Supplies " },
      ],
    });

    expect(result.revisionId).toBe(1001);
    expect(repository.lastReplace?.rules).toMatchObject([
      { scopeType: "catalog", action: "include", category: null },
      { scopeType: "category", action: "exclude", category: "Supplies" },
    ]);
    expect(repository.lastReplace?.now).toEqual(now);
  });

  it("rejects duplicate admin exposure rules before repository writes", async () => {
    const repository = new FakeCatalogExposureRepository();
    const service = new DropshipCatalogExposureService({
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      repository,
    });

    await expect(service.replaceRules({
      idempotencyKey: "catalog-rules-002",
      actor: { actorType: "admin", actorId: "admin-1" },
      rules: [
        { scopeType: "catalog", action: "include" },
        { scopeType: "catalog", action: "include" },
      ],
    })).rejects.toThrow();
    expect(repository.lastReplace).toBeNull();
  });

  it("previews only the exposed rows when requested", async () => {
    const repository = new FakeCatalogExposureRepository();
    repository.rules = [{
      id: 1,
      revisionId: 1001,
      scopeType: "catalog",
      action: "include",
      productLineId: null,
      productId: null,
      productVariantId: null,
      category: null,
      priority: 0,
      isActive: true,
      startsAt: null,
      endsAt: null,
      notes: null,
      metadata: {},
      createdAt: now,
      updatedAt: now,
    }];
    repository.candidates = [
      makePreviewCandidate(20, true),
      makePreviewCandidate(21, false),
    ];
    const service = new DropshipCatalogExposureService({
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      repository,
    });

    const result = await service.preview({ exposedOnly: true });

    expect(result.total).toBe(1);
    expect(result.rows[0].productVariantId).toBe(20);
    expect(result.rows[0].decision.exposed).toBe(true);
  });
});

class FakeCatalogExposureRepository implements DropshipCatalogExposureRepository {
  rules: DropshipCatalogExposureRuleRecord[] = [];
  candidates: DropshipCatalogPreviewCandidate[] = [];
  lastReplace: ReplaceDropshipCatalogExposureRulesRepositoryInput | null = null;

  async listRules(): Promise<DropshipCatalogExposureRuleRecord[]> {
    return this.rules;
  }

  async replaceRules(
    input: ReplaceDropshipCatalogExposureRulesRepositoryInput,
  ): Promise<ReplaceDropshipCatalogExposureRulesRepositoryResult> {
    this.lastReplace = input;
    this.rules = input.rules.map((rule, index) => ({
      ...rule,
      id: index + 1,
      revisionId: 1001,
      isActive: true,
      createdAt: input.now,
      updatedAt: input.now,
    }));
    return {
      revisionId: 1001,
      idempotentReplay: false,
      rules: this.rules,
    };
  }

  async listPreviewCandidates(): Promise<DropshipCatalogPreviewCandidate[]> {
    return this.candidates;
  }
}

function makePreviewCandidate(
  productVariantId: number,
  active: boolean,
): DropshipCatalogPreviewCandidate {
  return {
    ...activeCandidate,
    productVariantId,
    productSku: `P-${productVariantId}`,
    productName: `Product ${productVariantId}`,
    variantSku: `V-${productVariantId}`,
    variantName: `Variant ${productVariantId}`,
    productLineNames: ["Line"],
    variantIsActive: active,
  };
}
