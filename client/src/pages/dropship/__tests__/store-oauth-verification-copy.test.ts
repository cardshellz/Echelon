import { describe, expect, it } from "vitest";
import { storeOAuthEmailVerificationMessage } from "../store-oauth-verification-copy";

describe("store OAuth verification copy", () => {
  it("tells the operator that the verification code was sent by email", () => {
    expect(storeOAuthEmailVerificationMessage("refresh the eBay connection")).toBe(
      "Verification code sent to your email address. Enter it below, then refresh the eBay connection.",
    );
  });
});
