import { describe, expect, it } from "vitest";
import { costFingerprint } from "../../domain/cost-fingerprint";
import { costFingerprint as legacyFingerprint } from "../../infrastructure/cost-evidence-values";

describe("cost fingerprint compatibility", () => {
  it("retains the canonical SHA-256 bytes used by recorded evidence", () => {
    const evidence = { b: 2, a: 1 };
    expect(costFingerprint(evidence)).toBe("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    expect(legacyFingerprint(evidence)).toBe(costFingerprint(evidence));
  });

  it("preserves nested evidence, integer amounts and array ordering", () => {
    const evidence = { source: { amountMills: -12_345, unknown: null }, references: [3, 1, 2] };
    expect(legacyFingerprint(evidence)).toBe(costFingerprint(evidence));
    expect(costFingerprint({ references: [3, 1, 2], source: { unknown: null, amountMills: -12_345 } })).toBe(costFingerprint(evidence));
    expect(costFingerprint({ ...evidence, references: [1, 2, 3] })).not.toBe(costFingerprint(evidence));
  });
});
