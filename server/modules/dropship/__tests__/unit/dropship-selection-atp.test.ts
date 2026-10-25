import { describe, expect, it } from "vitest";
import { dropshipVendorStatusEnum } from "../../../../../shared/schema/dropship.schema";
import {
  DROPSHIP_CATALOG_ACCESS_BLOCKED_VENDOR_STATUSES,
  isCatalogAccessBlockedVendorStatus,
} from "../../domain/vendor-standing";
import type { DropshipCatalogExposureRule } from "../../domain/catalog-exposure";
import {
  DropshipSelectionAtpService,
  type DropshipAtpProvider,
  type DropshipCatalogNewItemsReader,
  type DropshipSelectionAtpRepository,
  type DropshipVendorCatalogCandidate,
  type DropshipVendorProfile,
  type DropshipVendorSelectionCountRecord,
  type DropshipVendorSelectionRuleRecord,
  type DropshipVendorVariantOverrideRecord,
} from "../../application/dropship-selection-atp-service";
import type { DropshipVendorCatalogCandidateFilter } from "../../application/dropship-selection-dtos";
import {
  dropshipCatalogCategoriesAnswerSchema,
  dropshipCatalogIdsAnswerSchema,
  dropshipCatalogSelectionSummarySchema,
} from "../../../../../shared/dropship/vendor-catalog-reads";

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
  categoryId: 5,
  categoryName: "Supplies",
  productIsActive: true,
  variantIsActive: true,
  variantUomType: "pack",
  // One-time picks (PLAN-B v4.1 §9 row 1): the candidate scan reads whether the vendor picked the size.
  picked: true,
};

// The evaluator's domain cases moved to vendor-selection.test.ts, rewritten for picks (PLAN-B v4.1 §15.1). The rules
// save's cases (hash, duplicates, reserved key) went with the save (V10, FIDELITY-8); the reserved key is refused on
// /changes now (dropship-selection-change-service.test.ts).

describe("DropshipSelectionAtpService", () => {
  it("previews only selected rows and returns capped vendor-facing marketplace quantity", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.catalogRules = [{ id: 1, scopeType: "catalog", action: "include" }];
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
    atp.variantAtpByVariantId.set(20, 3);
    atp.variantAtpByVariantId.set(21, 3);
    const service = makeService(repository, atp);

    const result = await service.previewCatalog({
      vendorId: 1,
      selectedOnly: true,
    });

    expect(result.total).toBe(2);
    expect(result.rows[0].selectionDecision.selected).toBe(true);
    expect(result.rows[0].selectionDecision.marketplaceQuantity).toBe(2);
    expect(result.rows[0].selectionDecision.quantityCapApplied).toBe(true);
    expect(result.rows[0].selectionDecision.picked).toBe(true);
    expect(result.rows[0]).not.toHaveProperty("rawAtpUnits");
    // The pick rides on the decision only; the row keeps its shape (no top-level `picked`).
    expect(result.rows[0]).not.toHaveProperty("picked");
    // The catalog read never reads the frozen rules (they serve only the frozen rules GET).
    expect(repository.selectionRuleReads).toBe(0);
  });

  it("uses the canonical target quantity without reapplying the legacy vendor cap", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.catalogRules = [{ id: 1, scopeType: "catalog", action: "include" }];
    repository.candidates = [candidate];
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
    atp.authority = "canonical";
    atp.variantAtpByVariantId.set(20, 3);

    const result = await makeService(repository, atp).previewCatalog({ vendorId: 1 });

    expect(result.rows[0].selectionDecision.marketplaceQuantity).toBe(3);
    expect(result.rows[0].selectionDecision.quantityCapApplied).toBe(false);
  });

  it("returns only exposed catalog rows and builds de-duped exposed facets", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.catalogRules = [{ id: 1, scopeType: "category", action: "include", category: "Supplies" }];
    repository.candidates = [
      {
        ...candidate,
        productLineIds: [30, 31],
        productLineNames: ["Trading Card Supplies", "Trading Card Supplies"],
      },
      {
        ...candidate,
        productVariantId: 21,
        variantSku: "V-21",
        category: "Other",
        productLineIds: [40],
        productLineNames: ["Other Line"],
      },
    ];
    const service = makeService(repository, new FakeAtpProvider());

    const result = await service.previewCatalog({
      vendorId: 1,
    });

    expect(result.total).toBe(1);
    expect(result.rows.map((row) => row.productVariantId)).toEqual([20]);
    expect(result.facets?.categories).toEqual([
      { category: "Supplies", label: "Supplies", rowCount: 1 },
    ]);
    expect(result.facets?.productLines).toEqual([
      { productLineIds: [30, 31], label: "Trading Card Supplies", rowCount: 1 },
    ]);
  });

  it("reads stock only for the page it returns, and decides the total and selection without it", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.catalogRules = [{ id: 1, scopeType: "catalog", action: "include" }];
    repository.candidates = [20, 21, 22, 23, 24].map((id) => ({ ...candidate, productVariantId: id, variantSku: `V-${id}`,
      picked: id === 22 || id === 23 }));
    const atp = new FakeAtpProvider();
    for (const id of [20, 21, 22, 23, 24]) atp.variantAtpByVariantId.set(id, id);
    const service = makeService(repository, atp);

    const secondPage = await service.previewCatalog({ vendorId: 1, page: 2, limit: 2 });
    expect(secondPage.total).toBe(5);
    expect(secondPage.rows.map((row) => row.productVariantId)).toEqual([22, 23]);
    expect(secondPage.rows.map((row) => row.selectionDecision.marketplaceQuantity)).toEqual([22, 23]);
    expect(atp.requestedVariantIds).toEqual([[22, 23]]);

    // A selected SKU with no stock is still selected and still counted.
    atp.variantAtpByVariantId.set(22, 0);
    const selected = await service.previewCatalog({ vendorId: 1, selectedOnly: true, limit: 1 });
    expect(selected.total).toBe(2);
    expect(selected.rows.map((row) => [row.productVariantId, row.selectionDecision.selected, row.selectionDecision.marketplaceQuantity]))
      .toEqual([[22, true, 0]]);
    expect(atp.requestedVariantIds.at(-1)).toEqual([22]);

    const pastTheEnd = await service.previewCatalog({ vendorId: 1, page: 9, limit: 2 });
    expect(pastTheEnd).toMatchObject({ rows: [], total: 5 });
    expect(atp.requestedVariantIds.at(-1)).toEqual([]);
  });

  it("requires a vendor profile before catalog access", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.vendor = null;
    const service = makeService(repository, new FakeAtpProvider());

    await expect(service.requireVendorForMember("member-1")).rejects.toThrow("vendor profile");
  });

  it("refuses catalog access to exactly the statuses the catalog's background notices skip (JOB-1's one list)", async () => {
    expect(DROPSHIP_CATALOG_ACCESS_BLOCKED_VENDOR_STATUSES).toEqual(["closed", "lapsed", "suspended"]);
    const refused: string[] = [];
    for (const status of dropshipVendorStatusEnum) {
      const repository = new FakeDropshipSelectionAtpRepository();
      repository.vendor = { vendorId: 1, memberId: "member-1", status, entitlementStatus: "active" };
      const outcome = await makeService(repository, new FakeAtpProvider()).requireVendorForMember("member-1")
        .then(() => "allowed", (error: { code?: string }) => error.code);
      if (outcome !== "allowed") {
        expect(outcome, status).toBe("DROPSHIP_VENDOR_CATALOG_ACCESS_BLOCKED");
        refused.push(status);
      }
      expect(isCatalogAccessBlockedVendorStatus(status), status).toBe(outcome !== "allowed");
    }
    expect(refused.sort()).toEqual([...DROPSHIP_CATALOG_ACCESS_BLOCKED_VENDOR_STATUSES].sort());
    expect(isCatalogAccessBlockedVendorStatus("unknown")).toBe(false);
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
  /** The filter of every candidate scan, in call order. */
  candidateFilters: DropshipVendorCatalogCandidateFilter[] = [];
  counts: DropshipVendorSelectionCountRecord = { selectionRevisionId: 7, selectedTotal: 0, storeLive: null };
  countInputs: Array<{ vendorId: number; storeConnectionId: number | null; now: Date }> = [];

  async readSelectionCounts(input: { vendorId: number; storeConnectionId: number | null; now: Date }) {
    this.countInputs.push(input);
    return this.counts;
  }

  async findVendorByMemberId(): Promise<DropshipVendorProfile | null> {
    return this.vendor;
  }

  async listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]> {
    return this.catalogRules;
  }

  /** How often the frozen rules were read: only the frozen rules GET may read them. */
  selectionRuleReads = 0;

  async listSelectionRules(): Promise<DropshipVendorSelectionRuleRecord[]> {
    this.selectionRuleReads += 1;
    return this.selectionRules;
  }

  async listVendorCatalogCandidates(
    input: DropshipVendorCatalogCandidateFilter,
  ): Promise<DropshipVendorCatalogCandidate[]> {
    this.candidateFilters.push(input);
    return this.candidates;
  }

  async listVariantOverrides(): Promise<DropshipVendorVariantOverrideRecord[]> {
    return this.overrides;
  }
}

class FakeAtpProvider implements DropshipAtpProvider {
  variantAtpByVariantId = new Map<number, number>();
  authority: "legacy" | "canonical" = "legacy";
  /** The variant ids of every stock read, in call order. */
  requestedVariantIds: number[][] = [];

  async getVariantAtp(
    targets: readonly { productId: number; productVariantId: number }[],
  ) {
    this.requestedVariantIds.push(targets.map((target) => target.productVariantId));
    return Promise.resolve({
      authority: this.authority,
      quantities: new Map(targets.map((target) => [
        target.productVariantId,
        this.variantAtpByVariantId.get(target.productVariantId) ?? 0,
      ])),
    });
  }
}

/** The new-items notice's "new for V" sizes (PLAN-B v4.1 §11.4), as the arrivals service answers them. */
class FakeNewItemsReader implements DropshipCatalogNewItemsReader {
  ids: number[] = [];
  inputs: Array<{ vendorId: number; categoryId: number | null; now: Date }> = [];

  async listNewVariantIds(input: { vendorId: number; categoryId: number | null; now: Date }): Promise<number[]> {
    this.inputs.push(input);
    return this.ids;
  }
}

function makeService(
  repository: DropshipSelectionAtpRepository,
  atp: DropshipAtpProvider,
  newItems: DropshipCatalogNewItemsReader = new FakeNewItemsReader(),
): DropshipSelectionAtpService {
  return new DropshipSelectionAtpService({
    clock: { now: () => now },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    repository,
    atp,
    listingTiers: { resolveForVendor: async () => ({ eligibility: catalogListingTiers }) },
    newItems,
  });
}

const catalogListingTiers = {
  pack: {
    tier: "pack" as const, eligible: true, reason: null, policyMinimumCents: 10_000, minimumCents: 10_000, alreadyOn: true,
    reserveShortfallCents: 0, balanceShortfallCents: 0, upcoming: null,
  },
  case: {
    tier: "case" as const, eligible: false, reason: "reserve_below_tier" as const, policyMinimumCents: 50_000, minimumCents: 50_000,
    alreadyOn: false, reserveShortfallCents: 40_000, balanceShortfallCents: 38_000, upcoming: null,
  },
};

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

/**
 * Step 1 plan S2-5 §4.8: the catalog GET's selection filter, category id, facet
 * switch, summary and id lists, the categories read and the selection summary.
 * Sizes: 20 selected, 21 picked but turned off by the vendor's override, 22 not
 * picked, 23 picked with no category, 24 not exposed by Card Shellz.
 */
describe("DropshipSelectionAtpService catalog reads (S2-5 §4.8)", () => {
  function catalog() {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.catalogRules = [
      { id: 1, scopeType: "catalog", action: "include" },
      { id: 2, scopeType: "variant", action: "exclude", productVariantId: 24 },
    ];
    // 20, 21, 23 and 24 are picked (TESTS-6): the candidate scan carries `picked`.
    repository.candidates = [
      { ...candidate, productVariantId: 20, categoryId: 5, categoryName: "Supplies", picked: true },
      { ...candidate, productVariantId: 21, categoryId: 5, categoryName: "Supplies", picked: true },
      { ...candidate, productVariantId: 22, categoryId: 6, categoryName: "Binders", category: "Binders", picked: false },
      { ...candidate, productVariantId: 23, categoryId: null, categoryName: null, category: "Loose", picked: true },
      { ...candidate, productVariantId: 24, categoryId: 6, categoryName: "Binders", category: "Binders", picked: true },
    ];
    repository.overrides = [{
      id: 1, vendorId: 1, productVariantId: 21, enabledOverride: false, marketplaceQuantityCap: null,
      notes: null, createdAt: now, updatedAt: now,
    }];
    const atp = new FakeAtpProvider();
    const newItems = new FakeNewItemsReader();
    return { repository, atp, newItems, service: makeService(repository, atp, newItems) };
  }

  it("filters by selection three ways; not_selected holds a picked size the override turned off (TESTS2)", async () => {
    const { service } = catalog();
    const ids = async (input: Record<string, unknown>) => (await service.previewCatalog({ vendorId: 1, ...input })).rows
      .map((row) => row.productVariantId);

    expect(await ids({})).toEqual([20, 21, 22, 23]);
    expect(await ids({ selection: "all" })).toEqual([20, 21, 22, 23]);
    expect(await ids({ selection: "selected" })).toEqual([20, 23]);
    expect(await ids({ selection: "not_selected" })).toEqual([21, 22]);
    // The stage 1 alias still works, and `selection` wins when both are sent.
    expect(await ids({ selectedOnly: true })).toEqual([20, 23]);
    expect(await ids({ selectedOnly: true, selection: "not_selected" })).toEqual([21, 22]);
    await expect(service.previewCatalog({ vendorId: 1, selection: "everything" })).rejects.toThrow();
  });

  it("filters a fourth way, selection=new: the notice's new sizes that are exposed and not selected (PLAN-B v4.1 §11.4, TESTS-8)", async () => {
    const { newItems, service } = catalog();
    // The notice names 20 (picked since: no longer new), 22, 24 (Card Shellz stopped offering it) and 99 (not in this read).
    newItems.ids = [20, 22, 24, 99];
    const read = async (input: Record<string, unknown>) => service.previewCatalog({ vendorId: 1, ...input });

    const page = await read({ selection: "new", categoryId: 6 });
    expect(page.rows.map((row) => row.productVariantId)).toEqual([22]);
    expect(page.total).toBe(1);
    // The summary stays apart from the selection filter.
    expect(page.summary).toEqual({ matching: 4, matchingSelected: 2 });
    // One read of the notice's sizes, for the session's vendor, the filter's category and the read's own time.
    expect(newItems.inputs).toEqual([{ vendorId: 1, categoryId: 6, now }]);

    // Without a category: every category the vendor sells from.
    expect((await read({ selection: "new" })).rows.map((row) => row.productVariantId)).toEqual([22]);
    expect(newItems.inputs[1]).toEqual({ vendorId: 1, categoryId: null, now });
    // "Check all N that match" on the review: the new sizes are the ones to add.
    expect(await service.listCatalogIds({ vendorId: 1, selection: "new", categoryId: 6, purpose: "add" }))
      .toEqual({ selectedIds: [], notSelectedIds: [22], total: 1 });
    // Nothing new: no rows, never every row.
    newItems.ids = [];
    expect((await read({ selection: "new", categoryId: 6 })).rows).toEqual([]);

    // The other filters never read the notice.
    newItems.inputs = [];
    for (const selection of ["all", "selected", "not_selected"]) await read({ selection });
    await read({});
    await service.listCatalogIds({ vendorId: 1, purpose: "add" });
    await service.listCatalogCategories({ vendorId: 1 });
    expect(newItems.inputs).toEqual([]);
  });

  it("decides every catalog read from the candidates' picks and never reads the frozen rules (PLAN-B v4.1 §9 row 1)", async () => {
    const { repository, service } = catalog();
    // A frozen rule that would select 22 changes nothing: only the frozen rules GET reads the rules now.
    repository.selectionRules = [makeSelectionRuleRecord({ id: 9, scopeType: "variant", action: "include", productVariantId: 22 })];

    const rows = (await service.previewCatalog({ vendorId: 1 })).rows;
    expect(rows.map((row) => [row.productVariantId, row.selectionDecision.picked, row.selectionDecision.selected,
      row.selectionDecision.reason])).toEqual([
      [20, true, true, "selected"],
      [21, true, false, "disabled_by_vendor_override"],
      [22, false, false, "missing_vendor_include_rule"],
      [23, true, true, "selected"],
    ]);
    await service.listCatalogIds({ vendorId: 1, purpose: "add" });
    await service.listCatalogCategories({ vendorId: 1 });
    expect(repository.selectionRuleReads).toBe(0);
    expect((await service.listSelectionRules({ vendorId: 1 })).rules).toHaveLength(1);
    expect(repository.selectionRuleReads).toBe(1);
  });

  it("answers the filter's summary apart from the selection filter, and the paging total with it", async () => {
    const { service } = catalog();
    const page = await service.previewCatalog({ vendorId: 1, selection: "selected", limit: 1 });

    expect(page.summary).toEqual({ matching: 4, matchingSelected: 2 });
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(1);
  });

  it("passes the category id to the scan, and skips the facet scan when the page asks for no facets (TESTS9)", async () => {
    const { repository, service } = catalog();

    const withFacets = await service.previewCatalog({ vendorId: 1, categoryId: 5, search: "env" });
    expect(repository.candidateFilters).toHaveLength(2);
    expect(repository.candidateFilters[0]).toMatchObject({ vendorId: 1, categoryId: 5, search: "env" });
    // The facets apply search only, as before.
    expect(repository.candidateFilters[1]).toEqual({ vendorId: 1, search: "env" });
    expect(withFacets.facets?.categories.map((facet) => facet.label)).toEqual(["Binders", "Loose", "Supplies"]);

    repository.candidateFilters = [];
    const without = await service.previewCatalog({ vendorId: 1, includeFacets: false });
    expect(repository.candidateFilters).toHaveLength(1);
    expect(without.facets).toBeNull();
  });

  it("lists the changeable ids of the filter: exposed and not turned off, ascending, without reading stock", async () => {
    const { atp, service } = catalog();

    const add = dropshipCatalogIdsAnswerSchema.parse(await service.listCatalogIds({ vendorId: 1, purpose: "add" }));
    expect(add).toEqual({ selectedIds: [20, 23], notSelectedIds: [22], total: 3 });
    const remove = await service.listCatalogIds({ vendorId: 1, purpose: "remove", selection: "selected" });
    expect(remove).toEqual({ selectedIds: [20, 23], notSelectedIds: [], total: 2 });
    expect(atp.requestedVariantIds).toEqual([]);
    await expect(service.listCatalogIds({ vendorId: 1 })).rejects.toThrow();
    await expect(service.listCatalogIds({ vendorId: 1, purpose: "toggle" })).rejects.toThrow();
  });

  it("refuses only the list the purpose needs above 10,000; the other list is null (TESTS22)", async () => {
    const repository = new FakeDropshipSelectionAtpRepository();
    repository.catalogRules = [{ id: 1, scopeType: "catalog", action: "include" }];
    repository.candidates = Array.from({ length: 10_001 }, (_, index) => ({ ...candidate, productVariantId: 1 + index, picked: true }));
    const service = makeService(repository, new FakeAtpProvider());

    await expect(service.listCatalogIds({ vendorId: 1, purpose: "remove" })).rejects.toMatchObject({
      code: "DROPSHIP_CATALOG_IDS_TOO_MANY",
      context: { total: 10_001, needed: 10_001, limit: 10_000, retryable: false },
    });
    // Adding needs the not-selected list (empty); the selected list is over the cap, so null.
    expect(await service.listCatalogIds({ vendorId: 1, purpose: "add" })).toEqual({
      selectedIds: null, notSelectedIds: [], total: 10_001,
    });

    repository.candidates = repository.candidates.map((row) => ({ ...row, picked: false }));
    await expect(service.listCatalogIds({ vendorId: 1, purpose: "add" })).rejects.toMatchObject({
      code: "DROPSHIP_CATALOG_IDS_TOO_MANY", context: { needed: 10_001 },
    });
    expect(await service.listCatalogIds({ vendorId: 1, purpose: "remove" })).toEqual({
      selectedIds: [], notSelectedIds: null, total: 10_001,
    });
    // Exactly at the cap is allowed.
    repository.candidates = repository.candidates.slice(0, 10_000);
    expect((await service.listCatalogIds({ vendorId: 1, purpose: "add" })).notSelectedIds).toHaveLength(10_000);
  });

  it("counts every exposed size by category id, ignoring search and filters, with no-id sizes apart (D26)", async () => {
    const { repository, service } = catalog();

    const answer = dropshipCatalogCategoriesAnswerSchema.parse(await service.listCatalogCategories({ vendorId: 1 }));
    expect(answer).toEqual({
      categories: [
        { categoryId: 6, name: "Binders", rowCount: 1, selectedCount: 0 },
        { categoryId: 5, name: "Supplies", rowCount: 2, selectedCount: 1 },
      ],
      uncategorizedCount: 1,
    });
    expect(repository.candidateFilters).toEqual([{
      vendorId: 1, search: undefined, category: undefined, categoryId: undefined, productLineId: undefined,
      productLineIds: undefined, productId: undefined,
    }]);
    await expect(service.listCatalogCategories({ vendorId: 1, search: "env" })).rejects.toThrow();
  });

  it("answers the selection summary from one repository read, at the injected time", async () => {
    const { repository, service } = catalog();
    repository.counts = { selectionRevisionId: 41, selectedTotal: 12, storeLive: 5 };

    const store = dropshipCatalogSelectionSummarySchema.parse(await service.readSelectionSummary({ vendorId: 1, storeConnectionId: 22 }));
    expect(store).toEqual({
      selectionRevisionId: 41, selectedTotal: 12, cap: 10_000, overCap: false,
      store: { storeConnectionId: 22, live: 5, notLive: 7 },
    });
    expect(repository.countInputs).toEqual([{ vendorId: 1, storeConnectionId: 22, now }]);

    repository.counts = { selectionRevisionId: null, selectedTotal: 10_001, storeLive: null };
    expect(await service.readSelectionSummary({ vendorId: 1, storeConnectionId: null })).toEqual({
      selectionRevisionId: null, selectedTotal: 10_001, cap: 10_000, overCap: true, store: null,
    });
    await expect(service.readSelectionSummary({ vendorId: 1 })).rejects.toThrow();
  });
});
