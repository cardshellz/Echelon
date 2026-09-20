import { describe, expect, it } from "vitest";
import {
  FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY,
  fundingMethodAccountHolderType,
} from "../../domain/funding-method";

describe("fundingMethodAccountHolderType", () => {
  it("reads the two values Stripe reports", () => {
    expect(fundingMethodAccountHolderType({ [FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY]: "company" })).toBe("company");
    expect(fundingMethodAccountHolderType({ [FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY]: "individual" })).toBe("individual");
  });

  it("fails closed on anything else: a value it cannot vouch for is unknown", () => {
    expect(fundingMethodAccountHolderType(null)).toBeNull();
    expect(fundingMethodAccountHolderType(undefined)).toBeNull();
    expect(fundingMethodAccountHolderType({})).toBeNull();
    expect(fundingMethodAccountHolderType({ [FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY]: null })).toBeNull();
    expect(fundingMethodAccountHolderType({ [FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY]: "Company" })).toBeNull();
    expect(fundingMethodAccountHolderType({ [FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY]: "business" })).toBeNull();
    expect(fundingMethodAccountHolderType({ [FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY]: 1 })).toBeNull();
  });

  it("pins the metadata key the Stripe provider writes", () => {
    expect(FUNDING_METHOD_ACCOUNT_HOLDER_TYPE_KEY).toBe("accountHolderType");
  });
});
