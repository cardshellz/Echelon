import { describe, expect, it } from "vitest";
import {
  parseProcurementJourney, parseProcurementRecord, procurementBackHref,
  procurementChildHref, procurementListChildHref, procurementRecordHref, procurementTabHref,
} from "../../procurement-navigation";

function parts(href: string): [string, string] {
  const url = new URL(href, "https://echelon.test");
  return [url.pathname, url.search];
}

describe("procurement document journeys", () => {
  it("returns invoice -> shipment Costs -> purchase Shipments from copied URLs", () => {
    const shipment = procurementChildHref("/purchase-orders/17", "tab=shipments", "/shipments/42");
    const costs = procurementTabHref(...parts(shipment), "costs")!;
    const invoice = procurementChildHref(...parts(costs), "/ap-invoices/71");
    expect(procurementBackHref(parts(invoice)[1], "/ap-invoices")).toBe(costs);
    const purchase = procurementBackHref(parts(costs)[1], "/shipments");
    expect(parseProcurementRecord(...parts(purchase))).toEqual({ kind: "purchase", id: 17, tab: "shipments" });
    expect(procurementRecordHref(parseProcurementJourney(parts(invoice)[1]).purchase!)).toBe("/purchase-orders/17?tab=shipments");
  });

  it("keeps purchase A as the origin while following another purchase on a shared shipment", () => {
    const shipment = procurementChildHref("/purchase-orders/17", "tab=shipments", "/shipments/42");
    const otherPo = procurementChildHref(...parts(shipment), "/purchase-orders/99?tab=receipts");
    const receipt = procurementChildHref(...parts(otherPo), "/receiving?open=31");
    expect(parseProcurementJourney(parts(receipt)[1]).purchase).toEqual({ kind: "purchase", id: 17, tab: "shipments" });
    expect(procurementBackHref(parts(receipt)[1], "/receiving")).toBe(otherPo);
    expect(parseProcurementRecord(...parts(receipt))).toEqual({ kind: "receipt", id: 31, tab: "detail" });
  });

  it("opens the requested PO editor while preserving the invoice and purchase journey", () => {
    const invoice = procurementChildHref("/purchase-orders/17", "tab=exceptions", "/ap-invoices/71");
    const editor = procurementChildHref(...parts(invoice), "/purchase-orders/99", { editPo: true });
    expect(new URLSearchParams(parts(editor)[1]).getAll("editPo")).toEqual(["1"]);
    expect(parseProcurementRecord(...parts(editor))).toEqual({ kind: "purchase", id: 99, tab: "lines" });
    expect(parseProcurementJourney(parts(editor)[1]).purchase?.id).toBe(17);
    expect(procurementBackHref(parts(editor)[1], "/purchase-orders")).toBe(invoice);
    // A later document journey restores the PO view without replaying UI actions.
    const child = procurementChildHref(...parts(editor), "/shipments/42");
    expect(procurementBackHref(parts(child)[1], "/shipments")).not.toContain("editPo");
  });

  it.each(["/ap-invoices/71", "/shipments/42", "/receiving?open=31"])("rejects a PO editor request for %s", destination => {
    expect(() => procurementChildHref("/ap-invoices/71", "", destination, { editPo: true })).toThrow("The PO editor requires a purchase order destination");
  });

  it("supports standalone document chains without inventing a purchase", () => {
    const invoice = procurementChildHref("/shipments/42", "tab=costs", "/ap-invoices/71");
    expect(parseProcurementJourney(parts(invoice)[1]).purchase).toBeNull();
    expect(procurementBackHref(parts(invoice)[1], "/ap-invoices")).toBe("/shipments/42?tab=costs");
    expect(procurementBackHref("", "/ap-invoices")).toBe("/ap-invoices");
  });

  it("chains the next receipt without leaving the completed receipt as its parent", () => {
    const receipt = procurementChildHref("/shipments/42", "tab=lines", "/receiving?open=31");
    const next = procurementChildHref(...parts(receipt), "/receiving?open=32", { replaceCurrent: true });
    expect(procurementBackHref(parts(next)[1], "/receiving")).toBe("/shipments/42?tab=lines");
  });

  it("opens a receipt from an empty list without creating a fictitious parent", () => {
    const href = procurementChildHref("/receiving", "", "/receiving?open=31");
    expect(parseProcurementRecord(...parts(href))?.id).toBe(31);
    expect(procurementBackHref(parts(href)[1], "/receiving")).toBe("/receiving");
  });

  it.each(["0", "-1", "1.5", "1e2", "01", "9007199254740992", "NaN", "1/evil", "1%2f2"])("rejects invalid receipt ID %s", (id) => {
    expect(parseProcurementRecord("/receiving", `open=${id}`)).toBeNull();
    expect(parseProcurementRecord(`/shipments/${id}`, "")).toBeNull();
  });

  it("rejects duplicate IDs and normalizes unknown or duplicate tabs", () => {
    expect(parseProcurementRecord("/receiving", "open=1&open=2")).toBeNull();
    expect(parseProcurementRecord("/shipments/1", "tab=payments")?.tab).toBe("lines");
    expect(parseProcurementRecord("/shipments/1", "tab=costs&tab=lines")?.tab).toBe("lines");
    expect(procurementTabHref("/shipments/1", "", "payments")).toBeNull();
  });

  it.each(["https://evil.test/shipments/1", "//evil.test/shipments/1", "/shipments/1/../2", "/shipments/%31", "javascript:alert(1)"])("rejects noncanonical child destination %s", (destination) => {
    expect(() => procurementChildHref("/purchase-orders/1", "", destination)).toThrow("Invalid procurement document destination");
    expect(procurementBackHref("", destination)).toBe("/purchase-orders");
  });

  it("ignores arbitrary return URLs, malformed or duplicate anchors, and corrupt trails", () => {
    for (const search of ["returnTo=https://evil.test", "purchase=shipment:1:lines", "purchase=purchase:1:lines&purchase=purchase:2:lines", "via=shipment:1:costs&via=invalid", "via=__proto__:1:lines"]) {
      expect(procurementBackHref(search, "/receiving")).toBe("/receiving");
    }
  });

  it("bounds repeated drilldowns while preserving the explicit purchase exit", () => {
    let href = "/purchase-orders/17?tab=shipments";
    for (let id = 1; id <= 50; id++) href = procurementChildHref(...parts(href), `/shipments/${id}`);
    const journey = parseProcurementJourney(parts(href)[1]);
    expect(journey.trail).toHaveLength(12);
    expect(journey.purchase?.id).toBe(17);
    expect(journey.trail.at(-1)?.id).toBe(49);
    expect(parseProcurementJourney("via=shipment:1:lines&".repeat(13)).trail).toEqual([]);
    expect(parseProcurementJourney("x".repeat(8193))).toEqual({ purchase: null, trail: [] });
  });

  it("tab changes retain catalog return metadata without mutating the input", () => {
    const search = "resumeReceipt=1&purchase=purchase%3A17%3Ashipments&tab=lines";
    const href = procurementTabHref("/shipments/42", search, "costs")!;
    expect(new URLSearchParams(parts(href)[1]).get("resumeReceipt")).toBe("1");
    expect(parseProcurementJourney(parts(href)[1]).purchase?.id).toBe(17);
    expect(search).toContain("tab=lines");
  });
});

describe("direct invoice line correction navigation", () => {
  it("opens the supplier cost editor from shipment costing with a stable return path", () => {
    const href = procurementChildHref("/shipments/42", "tab=allocation", "/ap-invoices/71", { invoiceCostLineId: 72 });
    expect(new URLSearchParams(parts(href)[1]).getAll("costLine")).toEqual(["72"]);
    expect(procurementBackHref(parts(href)[1], "/ap-invoices")).toBe("/shipments/42?tab=allocation");
  });
  it.each([0,-1,1.5,NaN,2_147_483_648])("rejects invalid cost-review IDs %s", invoiceCostLineId => {
    expect(() => procurementChildHref("/shipments/42","tab=allocation","/ap-invoices/71",{invoiceCostLineId})).toThrow();
  });
  it("does not combine cost review with invoice corrections or other documents", () => {
    expect(() => procurementChildHref("/shipments/42","","/ap-invoices/71",{invoiceCostLineId:72,invoiceLineCorrectionId:72})).toThrow();
    expect(() => procurementChildHref("/shipments/42","","/purchase-orders/17",{invoiceCostLineId:72})).toThrow();
  });
  it("opens the selected line and preserves the PO return without repeating the editor action on a later journey", () => {
    const correction = procurementChildHref("/purchase-orders/17", "tab=lines", "/ap-invoices/71", { invoiceLineCorrectionId: 72 });
    expect(new URLSearchParams(parts(correction)[1]).getAll("correctLine")).toEqual(["72"]);
    expect(procurementBackHref(parts(correction)[1], "/ap-invoices")).toBe("/purchase-orders/17?tab=lines&purchase=purchase%3A17%3Alines");
    const child = procurementChildHref(...parts(correction), "/purchase-orders/17");
    expect(procurementBackHref(parts(child)[1], "/purchase-orders")).not.toContain("correctLine");
  });
  it.each([0, -1, 1.5, NaN, 2_147_483_648])("rejects invalid line IDs %s", invoiceLineCorrectionId => {
    expect(() => procurementChildHref("/purchase-orders/17", "", "/ap-invoices/71", { invoiceLineCorrectionId })).toThrow();
  });
  it("rejects correction requests for other document types or simultaneous PO editing", () => {
    expect(() => procurementChildHref("/purchase-orders/17", "", "/purchase-orders/17", { invoiceLineCorrectionId: 72 })).toThrow();
    expect(() => procurementChildHref("/purchase-orders/17", "", "/purchase-orders/17", { editPo: true, invoiceLineCorrectionId: 72 })).toThrow();
  });
});


describe("supplier credit journeys", () => {
  it("retains the invoice and PO source through credit selection and its document", () => {
    const invoice = procurementChildHref("/purchase-orders/17", "tab=invoices", "/ap-invoices/71");
    const list = procurementListChildHref(...parts(invoice), "/supplier-credits?sourceInvoiceId=71&new=1");
    const credit = procurementChildHref(...parts(list), "/supplier-credits/9");
    expect(parseProcurementRecord(...parts(credit))).toEqual({ kind:"credit",id:9,tab:"details" });
    expect(procurementBackHref(parts(credit)[1],"/supplier-credits")).toBe(invoice);
    expect(parseProcurementJourney(parts(credit)[1]).purchase?.id).toBe(17);
  });
  it("preserves a physical return receipt without inferring its invoice", () => {
    const list = procurementListChildHref("/receiving","open=31","/supplier-credits?returnDispositionId=5&new=1");
    expect(new URLSearchParams(parts(list)[1]).has("sourceInvoiceId")).toBe(false);
    expect(procurementBackHref(parts(list)[1],"/supplier-credits")).toBe("/receiving?open=31");
    expect(() => procurementListChildHref("/receiving","open=31","https://evil.invalid")).toThrow();
  });
});
