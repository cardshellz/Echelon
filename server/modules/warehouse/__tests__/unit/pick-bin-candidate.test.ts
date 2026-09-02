/**
 * Ranking contract for the slot row an order line is stamped with.
 *
 * Invariants protected:
 *   1. The primary flag is a preference, never a gate — a bin-backed row with
 *      is_primary = 0 still resolves (the 2026-09 SHLZ-MAG-STND-P5 defect).
 *   2. Active beats draft, a usable pick face beats an unusable bin, primary
 *      beats secondary, and the lowest slot id breaks every remaining tie, so
 *      the choice is total and deterministic.
 *   3. The selector never mutates its input.
 */
import { describe, expect, it } from "vitest";

import {
  comparePickBinCandidates,
  isUsablePickFace,
  selectPickBinCandidate,
  type PickBinCandidate,
} from "../../pick-bin-candidate";

function candidate(overrides: Partial<PickBinCandidate> & { slotId: number }): PickBinCandidate {
  return {
    slotStatus: "active",
    isPrimary: 1,
    locationIsActive: 1,
    locationIsPickable: 1,
    locationType: "pick",
    cycleCountFreezeId: null,
    ...overrides,
  };
}

describe("selectPickBinCandidate", () => {
  it("returns null when the variant has no bin-backed slot rows", () => {
    expect(selectPickBinCandidate([])).toBeNull();
  });

  it("resolves a variant whose only slot row lost its primary flag", () => {
    const stranded = candidate({ slotId: 997, isPrimary: 0 });
    expect(selectPickBinCandidate([stranded])).toBe(stranded);
  });

  it("prefers the primary row when several usable active rows exist", () => {
    const secondary = candidate({ slotId: 1, isPrimary: 0 });
    const primary = candidate({ slotId: 2, isPrimary: 1 });
    expect(selectPickBinCandidate([secondary, primary])).toBe(primary);
  });

  it("prefers an active row over a draft row even when the draft is primary", () => {
    const draftPrimary = candidate({ slotId: 1, slotStatus: "draft", isPrimary: 1 });
    const activeSecondary = candidate({ slotId: 2, slotStatus: "active", isPrimary: 0 });
    expect(selectPickBinCandidate([draftPrimary, activeSecondary])).toBe(activeSecondary);
  });

  it("still resolves a draft-only slot (the previous resolver ignored status)", () => {
    const draftOnly = candidate({ slotId: 5, slotStatus: "draft", isPrimary: 1 });
    expect(selectPickBinCandidate([draftOnly])).toBe(draftOnly);
  });

  it.each([
    ["inactive", { locationIsActive: 0 }],
    ["non-pickable", { locationIsPickable: 0 }],
    ["reserve", { locationType: "reserve" }],
    ["frozen", { cycleCountFreezeId: 77 }],
  ])("prefers a usable pick face over a primary row at an %s bin", (_label, unusable) => {
    const primaryAtUnusableBin = candidate({ slotId: 1, isPrimary: 1, ...unusable });
    const secondaryAtPickFace = candidate({ slotId: 2, isPrimary: 0 });
    expect(isUsablePickFace(primaryAtUnusableBin)).toBe(false);
    expect(selectPickBinCandidate([primaryAtUnusableBin, secondaryAtPickFace])).toBe(secondaryAtPickFace);
  });

  it("breaks full ties by the lowest slot id, independent of input order", () => {
    const older = candidate({ slotId: 10 });
    const newer = candidate({ slotId: 11 });
    expect(selectPickBinCandidate([newer, older])).toBe(older);
    expect(selectPickBinCandidate([older, newer])).toBe(older);
  });

  it("does not mutate the caller's array", () => {
    const input = [candidate({ slotId: 3, isPrimary: 0 }), candidate({ slotId: 2, isPrimary: 1 })];
    const snapshot = [...input];
    selectPickBinCandidate(input);
    expect(input).toEqual(snapshot);
  });

  it("rejects a candidate that cannot be identified", () => {
    expect(() => selectPickBinCandidate([candidate({ slotId: Number.NaN })])).toThrow(/invalid slot id/);
  });

  it("tolerates string-typed numeric columns from raw rows", () => {
    const stringy = {
      ...candidate({ slotId: 4, isPrimary: 0 }),
      locationIsActive: "1" as unknown as number,
      locationIsPickable: "1" as unknown as number,
    };
    expect(isUsablePickFace(stringy)).toBe(true);
  });
});

describe("comparePickBinCandidates", () => {
  it("is antisymmetric for every ranked dimension", () => {
    const pairs: Array<[PickBinCandidate, PickBinCandidate]> = [
      [candidate({ slotId: 1, slotStatus: "draft" }), candidate({ slotId: 2 })],
      [candidate({ slotId: 1, locationType: "reserve" }), candidate({ slotId: 2 })],
      [candidate({ slotId: 1, isPrimary: 0 }), candidate({ slotId: 2 })],
      [candidate({ slotId: 9 }), candidate({ slotId: 8 })],
    ];
    for (const [worse, better] of pairs) {
      expect(comparePickBinCandidates(worse, better)).toBeGreaterThan(0);
      expect(comparePickBinCandidates(better, worse)).toBeLessThan(0);
    }
  });
});
