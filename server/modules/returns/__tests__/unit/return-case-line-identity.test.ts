import { describe, expect, it } from "vitest";
import { resolveReturnCaseExternalLineItemId } from "../../domain/return-case-line-identity";

describe("resolveReturnCaseExternalLineItemId", () => {
  it("uses the authoritative OMS external identity when the linked line belongs to the source order", () => {
    expect(resolve({
      storedExternalLineItemId: null,
      omsExternalLineItemId: "36002367799455",
    })).toEqual({ status: "resolved", externalLineItemId: "36002367799455" });
  });

  it("accepts matching immutable and OMS evidence", () => {
    expect(resolve({
      storedExternalLineItemId: " 36002367799455 ",
      omsExternalLineItemId: "36002367799455",
    })).toEqual({ status: "resolved", externalLineItemId: "36002367799455" });
  });

  it("treats Shopify numeric and GID representations as the same identity", () => {
    expect(resolve({
      storedExternalLineItemId: "gid://shopify/LineItem/36002367799455",
      omsExternalLineItemId: "36002367799455",
    })).toEqual({ status: "resolved", externalLineItemId: "36002367799455" });
  });

  it("fails closed when immutable and OMS external identities disagree", () => {
    expect(resolve({
      storedExternalLineItemId: "older-line",
      omsExternalLineItemId: "current-line",
    })).toEqual({ status: "conflict", reason: "EXTERNAL_LINE_ID_MISMATCH" });
  });

  it("fails closed when the linked OMS line is not in the source order", () => {
    expect(resolve({
      omsLineMatchedSourceOrder: false,
      omsExternalLineItemId: null,
    })).toEqual({ status: "conflict", reason: "OMS_LINE_NOT_IN_SOURCE_ORDER" });
  });

  it("preserves a stored provider identity when no OMS line link exists", () => {
    expect(resolve({
      omsOrderLineId: null,
      omsLineMatchedSourceOrder: false,
      storedExternalLineItemId: "legacy-line",
      omsExternalLineItemId: null,
    })).toEqual({ status: "resolved", externalLineItemId: "legacy-line" });
  });

  it("reports missing identity when neither source contains one", () => {
    expect(resolve({
      storedExternalLineItemId: null,
      omsExternalLineItemId: null,
    })).toEqual({ status: "missing" });
  });

  it("rejects impossible OMS evidence without a line link", () => {
    expect(resolve({
      omsOrderLineId: null,
      omsLineMatchedSourceOrder: true,
      storedExternalLineItemId: null,
      omsExternalLineItemId: "unexpected",
    })).toEqual({ status: "conflict", reason: "INVALID_EVIDENCE" });
  });
});

function resolve(overrides: Partial<Parameters<typeof resolveReturnCaseExternalLineItemId>[0]>) {
  return resolveReturnCaseExternalLineItemId({
    omsOrderLineId: 114910,
    storedExternalLineItemId: null,
    omsExternalLineItemId: "36002367799455",
    omsLineMatchedSourceOrder: true,
    ...overrides,
  });
}
