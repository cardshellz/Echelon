import { describe, expect, it, vi } from "vitest";
import {
  CHOOSE_BULK_BODY_LIMIT_BYTES,
  CHOOSE_CHANGE_IDS_MAX,
  PAUSED_RETRY_WINDOW_MS,
  chooseCatalogPageSchema,
  chooseChangeBody,
  chooseListingTierNameSchema,
  chooseListingTierReasonSchema,
  chooseSelectionReasonSchema,
  classifyChooseSaveError,
  type ChooseChanges,
} from "../../../../../client/src/lib/dropship-catalog-choose";
import { runChooseSave, type ChooseSaveDeps } from "../../../../../client/src/lib/dropship-catalog-choose-requests";
import { CATALOG_PAGE_CLIENT_VERSION } from "../../../../../client/src/lib/dropship-catalog-publish";
import { DropshipApiError } from "../../../../../client/src/lib/dropship-ops-surface";
import {
  DropshipSelectionAtpService,
  type DropshipSelectionAtpRepository,
  type DropshipVendorCatalogCandidate,
  type DropshipVendorVariantOverrideRecord,
} from "../../application/dropship-selection-atp-service";
import { SELECTION_CHANGE_PLAN_MOVED } from "../../application/dropship-selection-change-service";
import {
  hashSelectionChangeRequest,
  parseSelectionChangeBody,
  parseSelectionChangePreviewBody,
  readSelectionChangeClientVersion,
} from "../../application/dropship-selection-change-dtos";
import {
  DROPSHIP_CATALOG_CODE_VERSION,
  NEW_VERSION_SETTLE_MS,
  OLDER_PROCESS_GRACE_MS,
  decideCatalogPageVersion,
} from "../../domain/catalog-code-version";
import type { DropshipVendorCatalogSelectionReason } from "../../domain/vendor-selection";
import { DROPSHIP_LISTING_TIERS, type DropshipListingTierBlockReason, type DropshipListingTierEligibility } from "../../domain/listing-tiers";
import { DROPSHIP_BULK_JSON_LIMIT_BYTES } from "../../interfaces/http/dropship-bulk-json.middleware";
import { statusForDropshipVendorCatalogError } from "../../interfaces/http/dropship-vendor-catalog.routes";
import { DROPSHIP_CATALOG_READ_ERROR_CODES } from "../../../../../shared/dropship/vendor-catalog-reads";
import {
  SELECTION_CHANGE_ERROR_CODES,
  selectionChangeRequestSchema,
  type SelectionChangeAnswer,
  type SelectionChangePreviewAnswer,
  type SelectionChangeRequest,
} from "../../../../../shared/dropship/vendor-selection-changes";

/**
 * Catalog step 1's page (client/src/lib/dropship-catalog-choose*.ts) against
 * the server (PLAN-B v4.1 V30): the reads it parses are the server's answers,
 * the change bodies it sends pass the server's own `/changes` parsing exactly,
 * and every code the server answers the save with lands in the page class
 * §14 names. The stage 1 rules PUT's cases went with the PUT (V10).
 */
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../inventory-planning/infrastructure/inventory-availability-runtime-atp.repository", () => ({
  createAuthorityAwareInventoryAtpService: () => ({}),
}));

const HASH = "c".repeat(64);
const range = (from: number, count: number) => Array.from({ length: count }, (_, index) => from + index);

function changes(add: number[], remove: number[], baseRevisionId: number | null): ChooseChanges {
  return Object.freeze({ add: new Set(add), remove: new Set(remove), baseRevisionId });
}

function previewAnswer(headRevisionId: number | null): SelectionChangePreviewAnswer {
  return {
    headRevisionId, toAdd: 1, toRemove: 1, alreadySelected: 0, alreadyNotSelected: 0, skipped: { count: 0, first: [] },
    selectedBefore: 1, selectedAfter: 1, cap: 10_000, overCapAfter: false, refused: null, effects: [], effectsHash: HASH,
  } as SelectionChangePreviewAnswer;
}

/** The bodies the page's runner sends, captured; the save answers with the given failures first, then 201. */
async function sentBodies(change: ChooseChanges, failures: unknown[] = []): Promise<SelectionChangeRequest[]> {
  const posted: SelectionChangeRequest[] = [];
  const queue = [...failures];
  const deps: ChooseSaveDeps = {
    preview: async () => previewAnswer(change.baseRevisionId),
    post: async (body) => {
      posted.push(body);
      const failure = queue.shift();
      if (failure !== undefined) throw failure;
      return { answer: { revisionId: 9 } as SelectionChangeAnswer, replay: false };
    },
    confirm: async () => true,
    sleep: async () => undefined,
    now: () => 0,
    newKey: () => "catalog-selection:00000000-0000-4000-8000-000000000001",
  };
  await runChooseSave(deps, { changes: change, pending: null });
  return posted;
}

describe("catalog step 1 read contracts against the server", () => {
  const SERVER_SELECTION_REASONS = {
    selected: true, not_exposed_by_admin: true, excluded_by_vendor_rule: true, missing_vendor_include_rule: true, disabled_by_vendor_override: true,
  } satisfies Record<DropshipVendorCatalogSelectionReason, true>;
  const SERVER_TIER_BLOCK_REASONS = {
    autopay_off: true, reserve_below_tier: true, balance_below_tier: true,
  } satisfies Record<DropshipListingTierBlockReason, true>;

  it("R1 every enum the page parses is the server's, exactly", () => {
    expect([...chooseListingTierNameSchema.options]).toEqual([...DROPSHIP_LISTING_TIERS]);
    expect([...chooseSelectionReasonSchema.options].sort()).toEqual(Object.keys(SERVER_SELECTION_REASONS).sort());
    expect([...chooseListingTierReasonSchema.options].sort()).toEqual(Object.keys(SERVER_TIER_BLOCK_REASONS).sort());
  });

  it("R2 the real service's catalog page with no facets, sent as JSON, passes the page's contract with picked and the category id on every row", async () => {
    const stamp = new Date("2026-10-20T12:00:00.000Z");
    const pickedIds = new Set([21, 22, 25]);
    const candidate = (productVariantId: number, variantUomType: DropshipVendorCatalogCandidate["variantUomType"]): DropshipVendorCatalogCandidate => ({
      productId: 10, productSku: "P-10", productName: "Product 10", productVariantId, variantSku: null, variantName: `Size ${productVariantId}`,
      unitsPerVariant: 1, productLineIds: [30], productLineNames: ["Trading Card Supplies"], category: "Supplies",
      categoryId: 5, categoryName: "Supplies", productIsActive: true, variantIsActive: true, variantUomType,
      picked: pickedIds.has(productVariantId),
    });
    const override: DropshipVendorVariantOverrideRecord = { id: 1, vendorId: 1, productVariantId: 22, enabledOverride: false, marketplaceQuantityCap: null,
      notes: null, createdAt: stamp, updatedAt: stamp };
    const repository: DropshipSelectionAtpRepository = {
      findVendorByMemberId: async () => null,
      listCatalogExposureRules: async () => [{ id: 1, scopeType: "catalog", action: "include" }],
      listSelectionRules: async () => [],
      listVendorCatalogCandidates: async () => [candidate(21, "pack"), candidate(22, "pack"), candidate(23, "case"), candidate(25, "case")],
      listVariantOverrides: async () => [override],
      readSelectionCounts: async () => { throw new Error("not used"); },
    };
    const tiers: DropshipListingTierEligibility = {
      pack: { tier: "pack", eligible: true, reason: null, policyMinimumCents: 10_000, minimumCents: 10_000, alreadyOn: true,
        reserveShortfallCents: 0, balanceShortfallCents: 0, upcoming: null },
      case: { tier: "case", eligible: false, reason: "reserve_below_tier", policyMinimumCents: 50_000, minimumCents: 50_000, alreadyOn: false,
        reserveShortfallCents: 40_000, balanceShortfallCents: 38_000, upcoming: null },
    };
    const service = new DropshipSelectionAtpService({
      clock: { now: () => stamp },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      repository,
      atp: { getVariantAtp: async (targets) => ({ authority: "canonical", quantities: new Map(targets.map((target) => [target.productVariantId, 7])) }) },
      listingTiers: { resolveForVendor: async () => ({ eligibility: tiers }) },
      // Only `selection=new` reads the notice's new sizes; this page reads every row.
      newItems: { listNewVariantIds: async () => { throw new Error("not used"); } },
    });
    // The route sends it with res.json: Dates become strings, undefined drops.
    const wire = JSON.parse(JSON.stringify(await service.previewCatalog({ vendorId: 1, limit: 200, includeFacets: false })));
    expect(wire.facets).toBeNull();
    const page = chooseCatalogPageSchema.safeParse(wire);
    expect(page.success, JSON.stringify(page.success ? null : page.error.issues)).toBe(true);
    if (!page.success) return;
    expect(page.data.rows.map((row) => [row.productVariantId, row.selectionDecision.reason, row.selectionDecision.picked, row.categoryId])).toEqual([
      [21, "selected", true, 5],
      // Turned off with the pick saved: the page's box is checked and can only remove it.
      [22, "disabled_by_vendor_override", true, 5],
      [23, "missing_vendor_include_rule", false, 5],
      [25, "selected", true, 5],
    ]);
    expect(page.data.summary).toEqual({ matching: 4, matchingSelected: 2 });
    expect(page.data.rows[2].listingTier).toMatchObject({ tier: "case", eligible: false, reason: "reserve_below_tier" });
    expect(JSON.stringify(page.data)).not.toMatch(/Trading Card Supplies|includeRuleIds|excludeRuleIds/);
  });
});

describe("catalog step 1 change bodies against the server's /changes parsing (V30)", () => {
  it("C1 the preview body passes the page-version read and the strict preview parse, in canonical form", () => {
    const body = chooseChangeBody(changes([30, 10, 20], [5, 1], 42));
    expect(readSelectionChangeClientVersion(body)).toBe(2);
    expect(parseSelectionChangePreviewBody(body)).toEqual({ clientVersion: 2, expectedRevisionId: 42, addIds: [10, 20, 30], removeIds: [1, 5] });
    // Never saved before: the base is null, as the server's head is.
    expect(parseSelectionChangePreviewBody(chooseChangeBody(changes([1], [], null))).expectedRevisionId).toBeNull();
  });

  it("C2 the save body the runner sends passes the strict save parse; every resend is the same request (the server replays it)", async () => {
    const busy = new DropshipApiError({ status: 409, code: SELECTION_CHANGE_ERROR_CODES.busy, message: "busy" });
    const paused = new DropshipApiError({ status: 503, code: SELECTION_CHANGE_ERROR_CODES.writesPaused, message: "paused" });
    const posted = await sentBodies(changes([105, 102], [101], 7), [busy, paused, new TypeError("Failed to fetch")]);
    expect(posted).toHaveLength(4);
    const parsed = posted.map((body) => parseSelectionChangeBody(body));
    expect(parsed[0]).toEqual({
      clientVersion: 2, expectedRevisionId: 7, addIds: [102, 105], removeIds: [101],
      idempotencyKey: "catalog-selection:00000000-0000-4000-8000-000000000001", expectedEffectsHash: HASH,
    });
    expect(new Set(parsed.map((body) => hashSelectionChangeRequest(body))).size).toBe(1);
    // The key is never the system's reserved prefix (V8).
    expect(parsed[0].idempotencyKey.startsWith("legacy-picks-")).toBe(false);
  });

  it("C3 20,000 ids (10,000 a side) pass; the page never holds one id more on a side than the server takes", async () => {
    const posted = await sentBodies(changes(range(1, 10_000), range(50_001, 10_000), 3));
    const parsed = parseSelectionChangeBody(posted[0]);
    expect([parsed.addIds.length, parsed.removeIds.length]).toEqual([10_000, 10_000]);
    expect(CHOOSE_CHANGE_IDS_MAX).toBe(10_000);
    const oneMore = { ...posted[0], add: { productVariantIds: range(1, CHOOSE_CHANGE_IDS_MAX + 1) } };
    expect(selectionChangeRequestSchema.safeParse(oneMore).success).toBe(false);
    expect(() => parseSelectionChangeBody(oneMore)).toThrow();
  });

  it("C4 the page's version is the server's current one; a later page is told to wait (503), never parsed with this meaning", () => {
    expect(CATALOG_PAGE_CLIENT_VERSION).toBe(DROPSHIP_CATALOG_CODE_VERSION);
    expect(decideCatalogPageVersion(readSelectionChangeClientVersion(chooseChangeBody(changes([1], [], 1))))).toBe("current");
    expect(decideCatalogPageVersion(readSelectionChangeClientVersion({ ...chooseChangeBody(changes([1], [], 1)), clientVersion: 3 })))
      .toBe("page_newer_than_server");
  });

  it("C5 the page's limits are the server's: the bulk parser's body limit and the paused window (settle + grace)", () => {
    expect(CHOOSE_BULK_BODY_LIMIT_BYTES).toBe(DROPSHIP_BULK_JSON_LIMIT_BYTES);
    expect(PAUSED_RETRY_WINDOW_MS).toBe(NEW_VERSION_SETTLE_MS + OLDER_PROCESS_GRACE_MS);
  });

  it("C6 every code the server answers the save with, at the status it answers it, is the page class §14 names", () => {
    const small = { bodyBytes: 1_000 };
    const classified = (code: string, context: Record<string, unknown> | null = null) => classifyChooseSaveError(
      new DropshipApiError({ status: statusForDropshipVendorCatalogError(code), code, context, message: "Server words." }), small);
    expect(classified(SELECTION_CHANGE_ERROR_CODES.invalidInput)).toMatchObject({ kind: "permanent" });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.conflicting)).toMatchObject({ kind: "permanent" });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.keyReserved)).toMatchObject({ kind: "permanent" });
    expect(classified(DROPSHIP_CATALOG_READ_ERROR_CODES.queryInvalid)).toMatchObject({ kind: "permanent" });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.keyConflict)).toEqual({ kind: "keyConflict" });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.revisionConflict, { currentRevisionId: 12 })).toEqual({ kind: "stale", headRevisionId: 12 });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.effectsChanged)).toEqual({ kind: "effectsChanged" });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.busy)).toEqual({ kind: "busy" });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.tooLarge, { selectedAfter: 10_001 })).toEqual({ kind: "overCap", after: 10_001 });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.writesPaused, { reason: "older_version_running" })).toEqual({ kind: "paused" });
    expect(classified(SELECTION_CHANGE_ERROR_CODES.rulesRetired)).toEqual({ kind: "retired" });
    // The server's own faults may have committed nothing or everything: the page sends the same request again.
    expect(classified("DROPSHIP_SELECTION_COUNT_INCONSISTENT")).toEqual({ kind: "network", mayHaveCommitted: true });
    expect(classified(SELECTION_CHANGE_PLAN_MOVED)).toEqual({ kind: "network", mayHaveCommitted: true });
    expect(classified("DROPSHIP_STOCK_SELECTION_AMBIGUOUS")).toEqual({ kind: "permanent", message: "Server words." });
    // The bulk parser answers 413 with its own code (not through the status map).
    expect(classifyChooseSaveError(new DropshipApiError({ status: 413, code: SELECTION_CHANGE_ERROR_CODES.requestTooLarge, message: "x" }), small))
      .toEqual({ kind: "tooLarge" });
  });
});
