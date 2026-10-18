import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateApPaymentQueries, isApInvoiceQuery } from "../../ap-work-list-query";
import { invoiceWorkListQuerySchema, paymentWorkListQuerySchema, invoiceWorkListPageSchema } from "@shared/procurement/ap-work-list";
import { purchaseOrderWorkListQuerySchema } from "@shared/procurement/purchase-order-work-list";

describe("AP work-list contracts", () => {
  it.each([{ limit: "201" }, { offset: "-1" }, { vendorId: "0" }, { limit: "1.5" }, { vendorId: ["1", "2"] }, { status: "approved," }, { overdue: "yes" }, { search: "x".repeat(201) }, { unexpected: true }])("rejects malformed invoice query %j", query => expect(invoiceWorkListQuerySchema.safeParse(query).success).toBe(false));
  it("normalizes valid explicit pagination and preserves literal search", () => expect(invoiceWorkListQuerySchema.parse({ limit: "20", offset: "200", vendorId: "6", status: "approved,partially_paid", search: "  literal%  " })).toMatchObject({ limit: 20, offset: 200, vendorId: 6, status: ["approved", "partially_paid"], search: "literal%" }));
  it("rejects malformed payment method and duplicate PO exclusion identities", () => {
    expect(paymentWorkListQuerySchema.safeParse({ paymentMethod: ["ach"] }).success).toBe(false);
    expect(purchaseOrderWorkListQuerySchema.safeParse({ vendorId: "6", purpose: "invoice-link", excludeIds: "1,1" }).success).toBe(false);
  });
  it("requires vendors for invoice selection while allowing complete shipment line selection", () => {
    expect(purchaseOrderWorkListQuerySchema.safeParse({ purpose: "invoice-create" }).success).toBe(false);
    expect(purchaseOrderWorkListQuerySchema.safeParse({ purpose: "invoice-link" }).success).toBe(false);
    expect(purchaseOrderWorkListQuerySchema.parse({ purpose: "shipment-lines" })).toMatchObject({ purpose: "shipment-lines", limit: 20, offset: 0 });
  });
  it("rejects a page whose count or next cursor lies", () => {
    expect(invoiceWorkListPageSchema.safeParse({ items: [], limit: 50, offset: 0, total: 10, nextOffset: null }).success).toBe(false);
    expect(invoiceWorkListPageSchema.safeParse({ items: [], limit: 50, offset: 50, total: 10, nextOffset: null }).success).toBe(true);
  });
  it("matches all invoice query forms without matching similarly named endpoints", () => {
    for (const key of [["/api/vendor-invoices"], ["/api/vendor-invoices?status=approved"], ["/api/vendor-invoices/7"], ["/api/vendor-invoices/work-list", { vendorId: "6" }]]) expect(isApInvoiceQuery(key)).toBe(true);
    expect(isApInvoiceQuery(["/api/vendor-invoices-export"])).toBe(false);
  });
  it.each(["record", "void"])("refreshes mounted invoice selection after payment %s despite infinite stale time", async operation => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    const key = ["/api/vendor-invoices/work-list", { status: "approved,partially_paid", vendorId: "6" }];
    let balance = operation === "record" ? 10000 : 0;
    client.setQueryData(key, { balance });
    const observer = new QueryObserver(client, { queryKey: key, queryFn: async () => ({ balance }), staleTime: Infinity });
    const unsubscribe = observer.subscribe(() => undefined);
    balance = operation === "record" ? 0 : 10000;
    await invalidateApPaymentQueries(client);
    expect(observer.getCurrentResult().data).toEqual({ balance });
    unsubscribe(); client.clear();
  });
});
