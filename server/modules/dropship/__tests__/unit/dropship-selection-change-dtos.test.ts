import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_SELECTION_CHANGE_IDS,
  MAX_SELECTION_END_LISTINGS,
  MAX_SELECTION_FACT_SIZES,
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
      // A body without PR C's echo (a B page's) parses, for its replay; the service refuses it after the replay lookup.
      expectedEnds: null, expectedOtherEntriesHash: null,
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
    const saved = selectionChangeAnswerSchema.parse({ revisionId: 42, ...answer(), confirmedEffectsHash: HASH, drifted: false, aFieldOfPrD: [] });
    expect(saved).not.toHaveProperty("aFieldOfPrD");
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

/** PR C (PLAN-C v4.1 §4.6, §4.8, §13.1; TST-8, TST-9): the echo in the request, and the answer fields with defaults. */
describe("PR C: the confirmed ends echo", () => {
  const echo = (listingIds: number[], hiddenRemovedIds: number[] = []) => ({ expectedEnds: { listingIds, hiddenRemovedIds },
    expectedOtherEntriesHash: "b".repeat(64) });

  it("parses the echo optional and strict, each set unique and ascending in canonical form", () => {
    expect(parseSelectionChangeBody(saveBody(echo([30, 10, 30], [7, 5])))).toMatchObject({
      expectedEnds: { listingIds: [10, 30], hiddenRemovedIds: [5, 7] }, expectedOtherEntriesHash: "b".repeat(64) });
    for (const [label, value] of [
      ["an unknown field inside the echo", { expectedEnds: { listingIds: [], hiddenRemovedIds: [], more: 1 } }],
      ["a set left out", { expectedEnds: { listingIds: [] } }],
      ["a zero id", { expectedEnds: { listingIds: [0], hiddenRemovedIds: [] } }],
      ["an other-entries hash that is not sha256 hex", { expectedOtherEntriesHash: "B".repeat(64) }],
      ["a short other-entries hash", { expectedOtherEntriesHash: "b".repeat(63) }],
    ] as const) {
      expect(() => parseSelectionChangeBody(saveBody(value)), label).toThrow(expect.objectContaining({ code: SELECTION_CHANGE_ERROR_CODES.invalidInput }));
    }
  });

  it.each(["listingIds", "hiddenRemovedIds"] as const)("accepts 29,999 and 30,000 %s and refuses 30,001 (TST-8)", (field) => {
    for (const size of [MAX_SELECTION_END_LISTINGS - 1, MAX_SELECTION_END_LISTINGS]) {
      const sets = { listingIds: [] as number[], hiddenRemovedIds: [] as number[], [field]: ids(size) };
      expect(parseSelectionChangeBody(saveBody({ expectedEnds: sets, expectedOtherEntriesHash: HASH })).expectedEnds?.[field]).toHaveLength(size);
    }
    const over = { listingIds: [] as number[], hiddenRemovedIds: [] as number[], [field]: ids(MAX_SELECTION_END_LISTINGS + 1) };
    expect(() => parseSelectionChangeBody(saveBody({ expectedEnds: over, expectedOtherEntriesHash: HASH })))
      .toThrow(expect.objectContaining({ code: SELECTION_CHANGE_ERROR_CODES.invalidInput }));
    expect(MAX_SELECTION_END_LISTINGS).toBe(30_000);
    expect(MAX_SELECTION_FACT_SIZES).toBe(30_000);
  });

  it("hashes a B body exactly as B did, and makes the echo part of the request when present", () => {
    const bBody = parseSelectionChangeBody(saveBody());
    // B's canonical form at 1ddaf0470 (dropship-selection-change-dtos.ts hashSelectionChangeRequest), so a B save's stored
    // request hash still matches its replay on a C dyno.
    const bHash = createHash("sha256").update(JSON.stringify({ kind: "picks_change", expectedRevisionId: 41, addIds: [1, 2, 3], removeIds: [9],
      expectedEffectsHash: HASH })).digest("hex");
    expect(hashSelectionChangeRequest(bBody)).toBe(bHash);
    const withEcho = hashSelectionChangeRequest(parseSelectionChangeBody(saveBody(echo([10]))));
    expect(withEcho).not.toBe(bHash);
    expect(hashSelectionChangeRequest(parseSelectionChangeBody(saveBody(echo([11]))))).not.toBe(withEcho);
    expect(hashSelectionChangeRequest(parseSelectionChangeBody(saveBody({ ...echo([10]), expectedOtherEntriesHash: "c".repeat(64) }))))
      .not.toBe(withEcho);
    // In another order the echo is the same request.
    expect(hashSelectionChangeRequest(parseSelectionChangeBody(saveBody(echo([10, 10]))))).toBe(withEcho);
  });
});

describe("PR C: answer fields with defaults (an answer B stored replays unchanged, §4.8)", () => {
  it("defaults a store's ends and storeConnected, the vendor-level ends, and leaves the other entries' hash out", () => {
    const parsed = selectionChangeAnswerSchema.parse({ revisionId: 42, ...answer(), confirmedEffectsHash: HASH, drifted: false });
    expect(parsed.effects[0]).toEqual({ storeConnectionId: 22, storeName: "Shop", platform: "ebay", goesToZero: 0, startsSelling: 1, ends: 0,
      storeConnected: true });
    expect(parsed.ends).toEqual({ listingIds: [], hiddenRemovedIds: [], otherSizes: 0, stillEnding: 0, endReview: 0, endedReAdd: 0 });
    expect(parsed).not.toHaveProperty("otherEntriesHash");
    // Each parse gets its own default object.
    const again = selectionChangeAnswerSchema.parse({ revisionId: 42, ...answer(), confirmedEffectsHash: HASH, drifted: false });
    expect(again.ends).not.toBe(parsed.ends);
  });

  it("keeps C's fields and refuses end sets out of order", () => {
    const ends = { listingIds: [3, 9], hiddenRemovedIds: [4], otherSizes: 1, stillEnding: 0, endReview: 0, endedReAdd: 0 };
    const parsed = selectionChangePreviewAnswerSchema.parse({ headRevisionId: 41, ...answer(), refused: null, ends, otherEntriesHash: HASH });
    expect(parsed).toMatchObject({ ends, otherEntriesHash: HASH });
    expect(selectionChangePreviewAnswerSchema.safeParse({ headRevisionId: 41, ...answer(), refused: null,
      ends: { ...ends, listingIds: [9, 3] } }).success).toBe(false);
    expect(selectionChangePreviewAnswerSchema.safeParse({ headRevisionId: 41, ...answer(), refused: null,
      ends: { ...ends, hiddenRemovedIds: [4, 4] } }).success).toBe(false);
  });

  it("names the code of a removal too large", () => {
    expect(SELECTION_CHANGE_ERROR_CODES.removalTooLarge).toBe("DROPSHIP_SELECTION_REMOVAL_TOO_LARGE");
  });
});
