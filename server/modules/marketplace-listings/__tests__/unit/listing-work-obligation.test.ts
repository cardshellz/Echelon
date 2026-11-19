import { describe, expect, it } from "vitest";
import {
  canSettleUnsentListingFailure,
  hasListingWorkObligation,
} from "../../domain/listing-work-obligation";
describe("shared listing work obligations", () => {
  it.each([
    ["unsubmitted", false],
    ["pending", true],
    ["attention", true],
    ["completed", false],
    ["settled", false],
  ] as const)(
    "classifies %s from explicit execution facts",
    (phase, expected) => expect(hasListingWorkObligation(phase)).toBe(expected),
  );
  const proven = {
    failed: true,
    dispatchProvenAbsent: true,
    failedScope: "exact-account-and-members",
    replacementScope: "exact-account-and-members",
    replacementVerified: true,
  };
  it("settles only a verified exact replacement of a proven unsent failure", () => {
    expect(canSettleUnsentListingFailure(proven)).toBe(true);
    for (const change of [
      { failed: false },
      { dispatchProvenAbsent: false },
      { replacementVerified: false },
      { replacementScope: "another-account-or-mapping" },
    ])
      expect(canSettleUnsentListingFailure({ ...proven, ...change })).toBe(
        false,
      );
  });
});
