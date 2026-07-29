import { afterEach, describe, expect, it, vi } from "vitest";

import {
  postIdempotentJson,
  rateCopySourceOptions,
  rateProgramCopyConflicts,
  type ProgramOverview,
} from "../pricing-programs/api";

describe("pricing program copy API", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers only other active programs that have live rates", () => {
    const target = program(20, "Target", "active", true, false);
    const sources = rateCopySourceOptions([
      target,
      program(30, "No live rates", "active", false, false),
      program(40, "Retired source", "retired", true, false),
      program(10, "Beta rates", "active", true, false),
      program(11, "Alpha rates", "active", true, false),
    ], target.book.id);

    expect(sources.map((source) => source.book.name)).toEqual([
      "Alpha rates",
      "Beta rates",
    ]);
  });

  it("blocks a target that already has live rates or a draft", () => {
    expect(rateProgramCopyConflicts(
      program(20, "Live target", "active", true, false),
    )).toEqual(["Standard Shipping"]);
    expect(rateProgramCopyConflicts(
      program(20, "Draft target", "active", false, true),
    )).toEqual(["Standard Shipping"]);
  });

  it("sends the caller-provided idempotency key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ createdDrafts: [] }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await postIdempotentJson(
      "/api/shipping/admin/rate-books/20/copy-rates",
      { sourceRateBookId: 10 },
      "shipping-program-copy:test-0001",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shipping/admin/rate-books/20/copy-rates",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "shipping-program-copy:test-0001",
        },
        body: JSON.stringify({ sourceRateBookId: 10 }),
      }),
    );
  });
});

function program(
  id: number,
  name: string,
  status: string,
  hasActive: boolean,
  hasDraft: boolean,
): ProgramOverview {
  const serviceLevel = {
    id: 1,
    code: "standard",
    displayName: "Standard Shipping",
    description: null,
    fulfillmentMode: "parcel" as const,
    promiseMinBusinessDays: null,
    promiseMaxBusinessDays: null,
    sortOrder: 10,
    isActive: true,
  };
  const table = {
    id: id * 10,
    rateBookId: id,
    serviceLevelId: serviceLevel.id,
    pricingBasis: "shipment_weight" as const,
    currency: "USD",
    status: "active",
    effectiveFrom: "2026-07-29T00:00:00.000Z",
    effectiveTo: null,
    createdAt: "2026-07-29T00:00:00.000Z",
    metadata: {},
    rateBook: null,
    serviceLevel,
    coverages: [],
    rowCount: 1,
    stateCount: 1,
    zipOverrideCount: 0,
    productRuleCount: 0,
    minMeasure: 0,
    maxMeasure: null,
  };
  return {
    book: {
      id,
      code: `program-${id}`,
      name,
      status,
      zoneSetId: null,
      metadata: {},
      assignments: [],
    },
    options: [{
      serviceLevel,
      active: hasActive ? table : null,
      draft: hasDraft ? { ...table, id: table.id + 1, status: "draft" } : null,
      history: [],
    }],
    destinationGroups: [],
    liveRevisionOnlyGroups: [],
    activeAssignments: [],
    liveOptionCount: hasActive ? 1 : 0,
    draftCount: hasDraft ? 1 : 0,
    maxLiveRegionCount: hasActive ? 1 : 0,
    totalZipOverrides: 0,
    lastTouched: null,
  };
}
