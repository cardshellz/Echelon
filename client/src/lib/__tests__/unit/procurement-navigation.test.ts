import { describe, expect, it } from "vitest";
import {
  parseProcurementJourney, parseProcurementRecord, procurementBackHref,
  procurementChildHref, procurementRecordHref, procurementTabHref,
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
