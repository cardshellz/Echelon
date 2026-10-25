import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { describe, expect, it } from "vitest";
import { SupplierCreditLink, type SupplierCreditContext } from "../../SupplierCreditLink";
import { parseProcurementJourney } from "@/lib/procurement-navigation";

function renderLink(context: SupplierCreditContext, path: string, search = "", label?: string) {
  const markup = renderToStaticMarkup(createElement(Router, {
    ssrPath: path,
    ssrSearch: search,
    children: createElement(SupplierCreditLink, context, label),
  }));
  const anchor = markup.match(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
  if (!anchor) throw new Error("Supplier credit navigation must render a native anchor.");
  return { url: new URL(anchor[1].replace(/&amp;/g, "&"), "https://echelon.test"), text: anchor[2] };
}

type LinkCase = {
  name: string;
  context: SupplierCreditContext;
  path: string;
  expected: Record<string, string>;
};

const cases: LinkCase[] = [
  { name: "AP work lists", context: {}, path: "/ap-invoices", expected: {} },
  { name: "invoice credit history", context: { sourceInvoiceId: 71 }, path: "/ap-invoices/71", expected: { invoiceId: "71" } },
  { name: "invoice credit creation", context: { sourceInvoiceId: 71, create: true }, path: "/ap-invoices/71", expected: { sourceInvoiceId: "71", new: "1" } },
  { name: "shipment costs", context: { inboundShipmentId: 42 }, path: "/shipments/42", expected: { inboundShipmentId: "42" } },
  { name: "purchase financial follow-up", context: { purchaseOrderId: 17 }, path: "/purchase-orders/17", expected: { purchaseOrderId: "17" } },
  { name: "quarantine return credit", context: { returnDispositionId: 31, create: true }, path: "/receiving", expected: { returnDispositionId: "31", new: "1" } },
  { name: "voided credit replacement", context: { sourceInvoiceId: 71, replacesCreditId: 9, create: true }, path: "/supplier-credits/9", expected: { sourceInvoiceId: "71", replacesCreditId: "9", new: "1" } },
];

describe("supplier credit link rendering", () => {
  it.each(cases)("renders native navigation for $name", ({ context, path, expected }) => {
    const { url, text } = renderLink(context, path);
    expect(url.pathname).toBe("/supplier-credits");
    expect(text.trim()).toBe("Review supplier credits");
    const selection = new URLSearchParams(url.search);
    selection.delete("purchase");
    selection.delete("via");
    expect(Object.fromEntries(selection)).toEqual(expected);
  });

  it("preserves the original purchase and source invoice after a shipment drilldown", () => {
    const { url, text } = renderLink({ sourceInvoiceId: 71, create: true }, "/ap-invoices/71",
      "tab=details&purchase=purchase%3A17%3Ainvoices&via=shipment%3A42%3Acosts", "Record supplier credit");
    expect(text.trim()).toBe("Record supplier credit");
    expect(parseProcurementJourney(url.search)).toEqual({
      purchase: { kind: "purchase", id: 17, tab: "invoices" },
      trail: [
        { kind: "shipment", id: 42, tab: "costs" },
        { kind: "invoice", id: 71, tab: "details" },
      ],
    });
  });

  it("does not put invalid source identifiers into a rendered link", () => {
    const { url } = renderLink({ sourceInvoiceId: 0, inboundShipmentId: -1, purchaseOrderId: 1.5,
      returnDispositionId: Number.NaN, replacesCreditId: Number.MAX_SAFE_INTEGER + 1 }, "/ap-invoices");
    expect(url.pathname).toBe("/supplier-credits");
    expect(url.search).toBe("");
  });
});
