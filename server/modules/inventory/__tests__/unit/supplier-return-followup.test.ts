import { describe, expect, it } from "vitest";
import { nextSupplierReturnFollowupAttempt } from "../../application/supplier-return-followup.service";

describe("supplier return publication retry scheduling", () => {
  const at = new Date("2026-10-20T12:00:00.000Z");
  it.each([[0, 30_000], [1, 60_000], [2, 120_000], [3, 240_000], [4, 300_000], [2_147_483_647, 300_000]])(
    "bounds the next delay after %i failed attempts",
    (attempts, delay) => {
      expect(nextSupplierReturnFollowupAttempt(at, attempts).getTime() - at.getTime()).toBe(delay);
      expect(at.toISOString()).toBe("2026-10-20T12:00:00.000Z");
    },
  );
  it("rejects malformed attempts and clocks before producing a due time", () => {
    for (const attempts of [-1, 0.5, Number.NaN, 2_147_483_648]) {
      expect(() => nextSupplierReturnFollowupAttempt(at, attempts)).toThrow();
    }
    expect(() => nextSupplierReturnFollowupAttempt(new Date("invalid"), 0)).toThrow();
    expect(() => nextSupplierReturnFollowupAttempt(new Date(8_640_000_000_000_000), 0)).toThrow();
  });
});
