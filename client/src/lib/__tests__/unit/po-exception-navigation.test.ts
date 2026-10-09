import { describe, expect, it } from "vitest";
import { getPoExceptionLinks, type PoExceptionNavigationSource } from "../../po-exception-navigation";
import { procurementBackHref, procurementChildHref } from "../../procurement-navigation";

function exception(payload: unknown, kind = "match_mismatch"): PoExceptionNavigationSource {
  return { poId: 17, kind, payload };
}

describe("PO exception navigation", () => {
  it("uses the stored invoice ID and the actual PO ID without mutating source data", () => {
    const source = Object.freeze(exception(Object.freeze({ invoiceId: 71, invoiceNumber: "INV/display-only" })));
    expect(getPoExceptionLinks(source, 17)).toEqual({
      purchaseOrderHref: "/purchase-orders/17?tab=lines",
      invoiceHref: "/ap-invoices/71?tab=lines",
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "71", true, null, undefined, "https://example.test/71"])(
    "retains the PO link without inventing an invoice for invalid ID %s", (invoiceId) => {
      expect(getPoExceptionLinks(exception({ invoiceId, invoiceNumber: "INV-71" }), 17)).toEqual({
        purchaseOrderHref: "/purchase-orders/17?tab=lines", invoiceHref: null,
      });
    },
  );

  it.each([null, undefined, [], "{}", 71, true])("handles malformed legacy payload %s", (payload) => {
    expect(getPoExceptionLinks(exception(payload), 17)?.invoiceHref).toBeNull();
    expect(getPoExceptionLinks(exception(payload), 17)?.purchaseOrderHref).toBe("/purchase-orders/17?tab=lines");
  });

  it("does not interpret another exception's invoice ID as a match issue", () => {
    expect(getPoExceptionLinks(exception({ invoiceId: 71 }, "qty_short"), 17)?.invoiceHref).toBeNull();
  });

  it.each([null, 0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, 99])("rejects an invalid or different current PO %s", (poId) => {
    expect(getPoExceptionLinks(exception({ invoiceId: 71 }), poId)).toBeNull();
  });

  it("preserves the originating PO Exceptions tab through either review link", () => {
    const links = getPoExceptionLinks(exception({ invoiceId: 71 }), 17)!;
    const search = "tab=exceptions&purchase=purchase%3A17%3Aexceptions";
    for (const destination of [links.purchaseOrderHref, links.invoiceHref!]) {
      const reviewHref = procurementChildHref("/purchase-orders/17", search, destination);
      expect(procurementBackHref(new URL(reviewHref, "https://echelon.test").search, "/ap-invoices"))
        .toBe(`/purchase-orders/17?${search}`);
    }
  });
});
