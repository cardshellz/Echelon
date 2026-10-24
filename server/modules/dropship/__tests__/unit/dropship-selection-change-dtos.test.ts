import { describe, expect, it } from "vitest";
import {
  MAX_SELECTION_CHANGE_IDS,
  SELECTION_CHANGE_ERROR_CODES,
  SELECTION_WRITES_PAUSED_REASONS,
  selectionChangeAnswerSchema,
  selectionChangePreviewAnswerSchema,
  selectionChangePreviewRequestSchema,
  selectionChangeRequestSchema,
} from "../../../../../shared/dropship/vendor-selection-changes";
import {
  hashSelectionChangeRequest,
  parseSelectionChangeBody,
  parseSelectionChangePreviewBody,
  readSelectionChangeClientVersion,
} from "../../application/dropship-selection-change-dtos";

/**
 * The picks save's request and answer contracts (PLAN-B v4.1 §8, §15.1): strict requests with their bounds, the
 * page version read before the strict body, the canonical change and its hash, and answers that drop a later
 * release's fields instead of refusing them.
 */

const HASH = "a".repeat(64);
const KEY = "catalog-selection:00000000-0000-4000-8000-000000000001";

function body(overrides: Record<string, unknown> = {}) {
  return {
    expectedRevisionId: 41,
    add: { productVariantIds: [3, 1, 2] },
    remove: { productVariantIds: [9] },
    ...overrides,
  };
}

function saveBody(overrides: Record<string, unknown> = {}) {
  return { ...body(), idempotencyKey: KEY, expectedEffectsHash: HASH, ...overrides };
}

const ids = (count: number, from = 1) => Array.from({ length: count }, (_, index) => from + index);

function answer(overrides: Record<string, unknown> = {}) {
  return {
    toAdd: 1, toRemove: 0, alreadySelected: 0, alreadyNotSelected: 0,
    skipped: { count: 0, first: [] },
    selectedBefore: 5, selectedAfter: 6, cap: 10_000, overCapAfter: false,
    effects: [{ storeConnectionId: 22, storeName: "Shop", platform: "ebay", goesToZero: 0, startsSelling: 1 }],
    effectsHash: HASH,
    ...overrides,
  };
}

describe("selection change requests (strict)", () => {
  it("parses the preview and the save into canonical form: ids unique and ascending, the key trimmed", () => {
    expect(parseSelectionChangePreviewBody(body({ add: { productVariantIds: [3, 1, 3, 2] }, clientVersion: 2 }))).toEqual({
      clientVersion: 2, expectedRevisionId: 41, addIds: [1, 2, 3], removeIds: [9],
    });
    expect(parseSelectionChangeBody(saveBody({ idempotencyKey: `  ${KEY}  ` }))).toEqual({
      clientVersion: null, expectedRevisionId: 41, addIds: [1, 2, 3], removeIds: [9], idempotencyKey: KEY, expectedEffectsHash: HASH,
    });
    // A vendor that never saved counts from no revision.
    expect(parseSelectionChangePreviewBody(body({ expectedRevisionId: null })).expectedRevisionId).toBeNull();
  });

  it.each([
    ["an unknown field", body({ extra: true })],
    ["an unknown field inside a side", body({ add: { productVariantIds: [1], categoryId: 5 } })],
    ["no ids at all", body({ add: { productVariantIds: [] }, remove: { productVariantIds: [] } })],
    ["a zero id", body({ add: { productVariantIds: [0] } })],
    ["a fractional id", body({ add: { productVariantIds: [1.5] } })],
    ["an id past integer", body({ add: { productVariantIds: [2_147_483_648] } })],
    ["a string id", body({ add: { productVariantIds: ["1"] } })],
    ["10,001 ids on one side", body({ add: { productVariantIds: ids(MAX_SELECTION_CHANGE_IDS + 1) } })],
    ["no expected revision", { add: { productVariantIds: [1] }, remove: { productVariantIds: [] } }],
    ["a zero client version", body({ clientVersion: 0 })],
    ["a body that is not an object", [1, 2]],
    ["no body", undefined],
  ])("refuses %s with INVALID_INPUT (400, permanent), naming paths but never echoing the ids", (_label, value) => {
    let caught: unknown;
    try {
      parseSelectionChangePreviewBody(value);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: SELECTION_CHANGE_ERROR_CODES.invalidInput,
      context: { classification: "permanent", retryable: false, issues: expect.any(Array) },
    });
    expect(JSON.stringify((caught as { context: unknown }).context).length).toBeLessThan(2_000);
  });

  it("accepts 10,000 ids on each side (20,000 in all)", () => {
    const parsed = parseSelectionChangeBody(saveBody({
      add: { productVariantIds: ids(MAX_SELECTION_CHANGE_IDS) },
      remove: { productVariantIds: ids(MAX_SELECTION_CHANGE_IDS, 20_001) },
    }));
    expect(parsed.addIds).toHaveLength(10_000);
    expect(parsed.removeIds).toHaveLength(10_000);
  });

  it("refuses the same id on both sides as CONFLICTING (400), naming at most 20 of them", () => {
    expect(() => parseSelectionChangePreviewBody(body({ add: { productVariantIds: [9] } }))).toThrow(
      expect.objectContaining({ code: SELECTION_CHANGE_ERROR_CODES.conflicting }));
    const both = ids(50);
    try {
      parseSelectionChangeBody(saveBody({ add: { productVariantIds: both }, remove: { productVariantIds: both } }));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: SELECTION_CHANGE_ERROR_CODES.conflicting,
        context: { classification: "permanent", conflictingCount: 50, productVariantIds: ids(20) } });
    }
  });

  it.each([
    ["a short key", { idempotencyKey: "short" }],
    ["a long key", { idempotencyKey: "k".repeat(201) }],
    ["no key", { idempotencyKey: undefined }],
    ["a hash that is not sha256 hex", { expectedEffectsHash: "A".repeat(64) }],
    ["no hash", { expectedEffectsHash: undefined }],
  ])("refuses a save with %s", (_label, overrides) => {
    expect(() => parseSelectionChangeBody(saveBody(overrides))).toThrow(
      expect.objectContaining({ code: SELECTION_CHANGE_ERROR_CODES.invalidInput }));
  });

  it("keeps the preview and save schemas strict and exported for the page", () => {
    expect(selectionChangePreviewRequestSchema.safeParse(body({ idempotencyKey: KEY })).success).toBe(false);
    expect(selectionChangeRequestSchema.safeParse(saveBody()).success).toBe(true);
  });
});

describe("the page version, read before the strict body (§8.1)", () => {
  it("reads only clientVersion and lets every other field through", () => {
    expect(readSelectionChangeClientVersion({ clientVersion: 3, aFieldOfPrC: { ends: true } })).toBe(3);
    expect(readSelectionChangeClientVersion({ add: 1 })).toBeNull();
  });

  it("refuses a malformed version or a body that is not an object", () => {
    for (const value of [{ clientVersion: "2" }, { clientVersion: 0 }, { clientVersion: 1.5 }, "text", null]) {
      expect(() => readSelectionChangeClientVersion(value)).toThrow(expect.objectContaining({
        code: SELECTION_CHANGE_ERROR_CODES.invalidInput }));
    }
  });
});

describe("the request hash", () => {
  it("is the same for a resend in another order or with duplicates, and the page version is not part of it", () => {
    const first = parseSelectionChangeBody(saveBody());
    const reordered = parseSelectionChangeBody(saveBody({ add: { productVariantIds: [2, 3, 1, 1] }, clientVersion: 2 }));
    expect(hashSelectionChangeRequest(reordered)).toBe(hashSelectionChangeRequest(first));
    expect(hashSelectionChangeRequest(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes with each part of the request: the revision, either side, and the confirmed effects", () => {
    const base = hashSelectionChangeRequest(parseSelectionChangeBody(saveBody()));
    for (const overrides of [
      { expectedRevisionId: 42 },
      { expectedRevisionId: null },
      { add: { productVariantIds: [1, 2] } },
      { remove: { productVariantIds: [] } },
      { expectedEffectsHash: "b".repeat(64) },
      // The same ids moved to the other side.
      { add: { productVariantIds: [9] }, remove: { productVariantIds: [1, 2, 3] } },
    ]) {
      expect(hashSelectionChangeRequest(parseSelectionChangeBody(saveBody(overrides))), JSON.stringify(overrides)).not.toBe(base);
    }
    // The key names the request; it is not part of what is asked.
    expect(hashSelectionChangeRequest(parseSelectionChangeBody(saveBody({ idempotencyKey: `${KEY}-2` })))).toBe(base);
  });
});

describe("selection change answers (not strict)", () => {
  it("drops a field a later release adds, and still fails a missing one", () => {
    const preview = selectionChangePreviewAnswerSchema.parse({ headRevisionId: 41, ...answer(), refused: null, endsListings: 3 });
    expect(preview).not.toHaveProperty("endsListings");
    expect(selectionChangePreviewAnswerSchema.safeParse({ headRevisionId: 41, ...answer() }).success).toBe(false);
    const saved = selectionChangeAnswerSchema.parse({ revisionId: 42, ...answer(), confirmedEffectsHash: HASH, drifted: false, ends: [] });
    expect(saved).not.toHaveProperty("ends");
  });

  it("keeps overCapAfter, drifted and the skipped ids consistent with the counts", () => {
    expect(selectionChangePreviewAnswerSchema.safeParse({ headRevisionId: null, ...answer({ overCapAfter: true }), refused: null }).success)
      .toBe(false);
    expect(selectionChangeAnswerSchema.safeParse({ revisionId: 42, ...answer(), confirmedEffectsHash: "b".repeat(64), drifted: false })
      .success).toBe(false);
    expect(selectionChangeAnswerSchema.safeParse({ revisionId: 42, ...answer(), confirmedEffectsHash: "b".repeat(64), drifted: true })
      .success).toBe(true);
    expect(selectionChangePreviewAnswerSchema.safeParse({ headRevisionId: 1, ...answer({ skipped: { count: 25, first: ids(20) } }),
      refused: null }).success).toBe(true);
    expect(selectionChangePreviewAnswerSchema.safeParse({ headRevisionId: 1, ...answer({ skipped: { count: 25, first: ids(5) } }),
      refused: null }).success).toBe(false);
    // An over-cap vendor's count is not capped (removing is always allowed).
    expect(selectionChangePreviewAnswerSchema.safeParse({ headRevisionId: 1,
      ...answer({ selectedBefore: 10_050, selectedAfter: 9_950, overCapAfter: false }), refused: null }).success).toBe(true);
  });

  it("names the three paused reasons", () => {
    expect([...SELECTION_WRITES_PAUSED_REASONS]).toEqual(["older_version_running", "disabled", "page_newer_than_server"]);
  });
});
