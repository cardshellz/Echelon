import { describe, expect, it } from "vitest";
import { ChannelListingValidationError, channelListingValidationFromError } from "@shared/channel-listing-validation";
import { providerWriteDiagnosticFromError, providerWriteShouldRetry } from "@shared/channel-provider-write";
import { syncFailure } from "../../ebay-listing-sync.domain";
import { ebayListingFailureDiagnostic } from "../../ebay-listing-failure-diagnostic";
import { channelOperationFailure } from "../../../../infrastructure/channel-operation-failure";

const now = new Date("2026-10-24T12:00:00Z");
describe("shared listing failure classification", () => {
  for (const provider of ["ebay", "shopify", "walmart"]) {
    it.each(["validation", "authentication", "access_denied", "throttled"] as const)(`${provider} uses the shared %s retry decision`, kind => {
      const providerWrite = { provider, kind, httpStatus: kind === "throttled" ? 429 : 400, errorCodes: ["25016"] };
      const error = Object.assign(new Error("Provider refused the request."), { code: "PUBLICATION_PROVIDER_REJECTED", providerWrite });
      const wrapped = new Error("Transport wrapper", { cause: error });
      expect(providerWriteDiagnosticFromError(wrapped)).toEqual(providerWrite);
      expect(providerWriteShouldRetry(providerWrite)).toBe(kind === "throttled");
      for (const attempts of [1, 50]) expect(syncFailure(wrapped, attempts, now).state)
        .toBe(kind === "throttled" ? "recovering" : "needs_attention");
      expect(ebayListingFailureDiagnostic(wrapped).context.providerWrite).toEqual(providerWrite);
    });
  }
  it("preserves typed validation across wrappers without exposing arbitrary context", () => {
    const validation = { field: "package_weight" as const, reason: "required" as const, productId: 22, variantId: 41 };
    const cause = new ChannelListingValidationError(validation);
    const wrapper = new Error("private SQL and credentials", { cause });
    expect(channelListingValidationFromError(wrapper)).toEqual(validation);
    const result = syncFailure(wrapper, 1, now);
    expect(result).toMatchObject({ state: "needs_attention", code: cause.code, message: cause.message });
    expect(JSON.stringify(ebayListingFailureDiagnostic(wrapper))).not.toContain("private SQL");
  });
  it("does not infer a refusal from prose, malformed evidence or a cyclic cause", () => {
    const error = Object.assign(new Error("HTTP 400 invalid listing"), { providerWrite: { provider: "ebay", kind: "validation" } });
    error.cause = error;
    expect(providerWriteDiagnosticFromError(error)).toBeUndefined();
    expect(channelListingValidationFromError(error)).toBeUndefined();
    expect(syncFailure(error, 1, now).state).toBe("recovering");
  });
  it("keeps bounded code locations and a fingerprint without SQL, secret text or absolute paths", () => {
    const error = new Error("SELECT secret FROM private_table; password=private");
    error.stack = `${error.message}\n    at prepare (C:\\private\\server\\modules\\channels\\prepare.ts:12:7)\n    at driver (C:\\private\\node_modules\\pg\\index.js:1:1)`;
    const failure = channelOperationFailure(error)!;
    expect(failure.locations).toEqual(["server/modules/channels/prepare.ts:12:7"]);
    expect(failure.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(channelOperationFailure(error)).toEqual(failure);
    expect(JSON.stringify(failure)).not.toMatch(/private|SELECT|password|node_modules/);
  });
});
