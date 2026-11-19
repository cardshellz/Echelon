import { describe, expect, it } from "vitest";
import { rfqWorkListQuerySchema, rfqWorkListResponseSchema } from "@shared/procurement/rfq-work-list";
import { summarizeRfqHandoff } from "../../domain/rfq-work-list";
import { rfqListHeader, rfqListLine, rfqListLink } from "../fixtures/rfq-work-list.fixture";

describe("RFQ work-list contracts and conversion provenance", () => {
  it("parses bounded page/search filters without coercing malformed inputs", () => {
    expect(rfqWorkListQuerySchema.parse({})).toEqual({ limit: 25, offset: 0, search: "" });
    expect(rfqWorkListQuerySchema.parse({ limit: "100", offset: "125", status: "cancelled", search: "  100%_  " })).toEqual({ limit: 100, offset: 125, status: "cancelled", search: "100%_" });
    for (const value of [{ limit: "100x" }, { limit: 101 }, { offset: -1 }, { offset: "1e3" }, { offset: 2147483648 }, { status: "ordered" }, { search: "a".repeat(201) }, { search: ["x"] }, { unknown: "x" }]) expect(rfqWorkListQuerySchema.safeParse(value).success).toBe(false);
  });
  it("does not infer conversion from a quoted header or a legacy ordered line", () => {
    expect(summarizeRfqHandoff(rfqListHeader({ status: "quoted" }), [rfqListLine({ status: "quoted" })], [])).toMatchObject({ state: "not_started", linkedLineCount: 0, remainingLineCount: 1 });
    expect(summarizeRfqHandoff(rfqListHeader(), [rfqListLine({ status: "ordered" })], [])).toMatchObject({ state: "review_required", linkedLineCount: 0, issues: [{ code: "RFQ_ORDERED_LINE_UNVERIFIED" }] });
  });
  it("shows partial and complete conversion provenance while retaining current cancelled PO status", () => {
    const header = rfqListHeader({ status: "quoted" }), ordered = rfqListLine({ status: "ordered" }), link = rfqListLink({ purchaseOrderStatus: "cancelled" });
    expect(summarizeRfqHandoff(header, [ordered, rfqListLine({ id: 502 })], [link])).toMatchObject({ state: "partially_converted", linkedLineCount: 1, remainingLineCount: 1, purchaseOrders: [{ id: 19, status: "cancelled" }] });
    expect(summarizeRfqHandoff(header, [ordered], [link])).toMatchObject({ state: "converted", linkedLineCount: 1, remainingLineCount: 0 });
    expect(summarizeRfqHandoff({ ...header, status: "cancelled" }, [ordered, rfqListLine({ id: 502, status: "cancelled" })], [link])).toMatchObject({ state: "partially_converted", remainingLineCount: 0 });
  });
  it.each([
    { rfqId: 99 }, { actualRfqId: null }, { quoteRfqId: 99 }, { quoteRfqLineId: 99 }, { quoteCurrency: "CAD" },
    { actualPurchaseOrderId: null }, { actualPurchaseOrderId: 99 }, { purchaseOrderVendorId: 99 }, { poNumber: null }, { purchaseOrderStatus: null },
  ])("rejects incomplete or conflicting retained identities: %j", difference => {
    const result = summarizeRfqHandoff(rfqListHeader(), [rfqListLine({ status: "ordered" })], [rfqListLink(difference)]);
    expect(result.state).toBe("review_required"); expect(result.linkedLineCount).toBe(0); expect(result.purchaseOrders).toEqual([]);
  });
  it("rejects duplicate links and does not accept a link on a non-ordered request line", () => {
    expect(summarizeRfqHandoff(rfqListHeader(), [rfqListLine({ status: "ordered" })], [rfqListLink(), rfqListLink({ id: 2 })]).state).toBe("review_required");
    expect(summarizeRfqHandoff(rfqListHeader(), [rfqListLine()], [rfqListLink()]).state).toBe("review_required");
  });
  it("validates counts, next page and exact line totals in outgoing responses", () => {
    const line = rfqListLine(), header = rfqListHeader();
    const item = { ...header, lines: [line], lineCount: 1, requestedPiecesTotal: 96, handoff: summarizeRfqHandoff(header, [line], []) };
    const page = { limit: 25, count: 1, statusCounts: { draft: 1 }, rfqs: [item], page: { total: 1, limit: 25, offset: 0, nextOffset: null } };
    expect(rfqWorkListResponseSchema.safeParse(page).success).toBe(true);
    expect(rfqWorkListResponseSchema.safeParse({ ...page, statusCounts: { draft: 2 } }).success).toBe(false);
    expect(rfqWorkListResponseSchema.safeParse({ ...page, rfqs: [{ ...item, requestedPiecesTotal: 95 }] }).success).toBe(false);
    expect(rfqWorkListResponseSchema.safeParse({ ...page, rfqs: [{ ...item, requestedPiecesTotal: 95.5 }] }).success).toBe(false);
    expect(rfqWorkListResponseSchema.safeParse({ ...page, page: { ...page.page, nextOffset: 1 } }).success).toBe(false);
  });
});
