import { afterEach, describe, expect, it, vi } from "vitest";
import { discardRateTableDraft, saveDraft } from "../pricing-programs/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shipping rate draft discard API", () => {
  it("issues a credentialed DELETE for the exact persisted draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: vi.fn(),
    });
    vi.stubGlobal("fetch", fetchMock);

    await discardRateTableDraft(42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/shipping/admin/rate-tables/42",
      { credentials: "include", method: "DELETE" },
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    "rejects invalid draft ID %s before making a request",
    async (draftId) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(discardRateTableDraft(draftId)).rejects.toThrow(
        "A valid draft ID is required.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("includes expectedDraftRevision when updating an existing draft and omits it on initial draft creation", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        rateTable: { id: 42, status: "draft" },
        draftLayout: null,
        draftRevision: "rt-draft-v1:0123456789abcdef01234567",
        coverages: [],
        rowCount: 0,
        warnings: [],
        analysis: {
          canActivate: false,
          errors: [],
          warnings: [],
          coverage: {
            rowCount: 0,
            stateCount: 0,
            zipOverrideCount: 0,
            missingRegions: [],
            minMeasure: null,
            maxMeasure: null,
          },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await saveDraft({
      draftId: null,
      expectedDraftRevision: "rt-draft-v1:ignored-on-create",
      rateBookCode: "shopify-retail",
      serviceLevelCode: "standard",
      pricingBasis: "shipment_weight",
      rows: [],
      draftLayout: { version: 3, groups: [] },
      allowIncomplete: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty(
      "expectedDraftRevision",
    );

    await saveDraft({
      draftId: 42,
      expectedDraftRevision: "rt-draft-v1:0123456789abcdef01234567",
      rateBookCode: "shopify-retail",
      serviceLevelCode: "standard",
      pricingBasis: "shipment_weight",
      rows: [],
      draftLayout: { version: 3, groups: [] },
      allowIncomplete: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      expectedDraftRevision: "rt-draft-v1:0123456789abcdef01234567",
    });
  });
});
