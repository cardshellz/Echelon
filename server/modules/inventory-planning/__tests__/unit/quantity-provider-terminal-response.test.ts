import { describe, expect, it } from "vitest";
import {
  terminalEbayResponseEvidence,
  type TerminalRequestReceipt,
} from "../../domain/quantity-provider-terminal-response";
const receipt = (
  overrides: Partial<TerminalRequestReceipt> = {},
): TerminalRequestReceipt => ({
  requestId: "4100",
  ordinal: 1,
  method: "PUT",
  path: "/sell/inventory/v1/inventory_item_group/ARM-ENV-SGL-NM",
  requestHash: "a".repeat(64),
  outcome: "uncertain",
  httpStatus: 500,
  responseHash: "b".repeat(64),
  errorCodes: ["25002"],
  recordedAt: "2026-10-07T18:41:46.495Z",
  ...overrides,
});
describe("eBay final response recovery proof", () => {
  it("retains a 500 as unknown effect while proving the synchronous error response terminated", () => {
    const result = terminalEbayResponseEvidence([receipt()]);
    expect(result?.receipts[0]).toMatchObject({
      outcome: "uncertain",
      httpStatus: 500,
      errorCodes: ["25002"],
    });
    expect(result?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(terminalEbayResponseEvidence([receipt()])).toEqual(result);
  });
  it("requires every earlier quantity request receipt, not just the last response", () => {
    const first = receipt({
      requestId: "4098",
      path: "/sell/inventory/v1/bulk_update_price_quantity",
      method: "POST",
      outcome: "completed",
      httpStatus: 200,
      errorCodes: [],
      requestTerminated: true,
    });
    expect(
      terminalEbayResponseEvidence([first, receipt({ ordinal: 2 })]),
    ).not.toBeNull();
    expect(
      terminalEbayResponseEvidence([
        { ...first, responseHash: null },
        receipt({ ordinal: 2 }),
      ]),
    ).toBeNull();
  });
  it.each([undefined, null, false])("does not trust a historical HTTP 200 bulk completion without finality proof (%s)", requestTerminated => {
    expect(terminalEbayResponseEvidence([receipt({ method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity",
      outcome: "completed", httpStatus: 200, errorCodes: [], requestTerminated })])).toBeNull();
  });
  it.each([
    { outcome: "completed" as const, httpStatus: 204, errorCodes: [] },
    { outcome: "uncertain" as const, httpStatus: 500, errorCodes: ["25002"] },
    { outcome: "rejected" as const, httpStatus: 400, errorCodes: ["25004"] },
  ])("explicit non-final evidence overrides historical status/outcome inference %j", patch => {
    expect(terminalEbayResponseEvidence([receipt({ ...patch, requestTerminated: false })])).toBeNull();
  });
  it("preserves historical synchronous PUT completion without claiming missing bulk operation proof", () => {
    expect(terminalEbayResponseEvidence([receipt({ outcome: "completed", httpStatus: 204, errorCodes: [], requestTerminated: null })])).not.toBeNull();
  });
  it.each([
    { httpStatus: null, responseHash: null, errorCodes: [], recordedAt: null },
    { httpStatus: 500, errorCodes: [] },
    { httpStatus: 500, outcome: "completed" },
    { httpStatus: 500, outcome: null },
    { httpStatus: 408 },
    { httpStatus: 202, outcome: "completed" },
    { httpStatus: 200, outcome: "uncertain", errorCodes: [] },
    { responseHash: null },
    { ordinal: 2 },
    {
      path: "/sell/inventory/v1/offer/publish_by_inventory_item_group",
      method: "POST",
    },
    { path: "/sell/inventory/v1/inventory_item/X", method: "DELETE" },
  ] as Array<Partial<TerminalRequestReceipt>>)(
    "fails closed for incomplete or unsupported evidence %j",
    (overrides) => {
      expect(terminalEbayResponseEvidence([receipt(overrides)])).toBeNull();
    },
  );
  it("cannot recover a crashed owner with no retained requests", () =>
    expect(terminalEbayResponseEvidence([])).toBeNull());
});
