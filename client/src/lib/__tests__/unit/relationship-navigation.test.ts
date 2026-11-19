import { describe, expect, it } from "vitest";
import { parseProcurementRecord, procurementBackHref, procurementChildHref } from "../../procurement-navigation";
import { shipmentListState } from "../../shipment-list-navigation";
import { QueryClient } from "@tanstack/react-query";
import { invalidatePurchaseCosts } from "../../invalidate-purchase-costs";

describe("relationship navigation", () => {
  it("restores PO filter, selected line and human document label after a receipt round trip", () => {
    const target = procurementChildHref("/shipments/42", "tab=lines&poScope=17&shipmentLine=201&document=TEST-SHIP-42", "/receiving?open=31&document=TEST-RECEIPT-31&poScope=17&shipmentLine=201");
    const back = new URL(procurementBackHref(target.split("?")[1], "/shipments"), "https://example.invalid");
    expect(parseProcurementRecord(back.pathname, back.search)).toMatchObject({ id: 42, label: "TEST-SHIP-42", relationship: { po: 17, line: 201 } });
  });
  it("keeps an explicit all-PO view across reloadable navigation", () => {
    const child = procurementChildHref("/shipments/42", "poScope=all", "/purchase-orders/17?tab=shipments&poScope=17");
    expect(procurementBackHref(child.split("?")[1], "/shipments")).toContain("poScope=all");
  });
  it("retains shipment list search, filters and page without an arbitrary return URL", () => {
    const child = procurementChildHref("/shipments", "search=PO-17&status=closed&mode=air&costFilter=warning&offset=50", "/shipments/42");
    const back = procurementBackHref(child.split("?")[1], "/shipments");
    expect(shipmentListState(back.split("?")[1])).toEqual({ search: "PO-17", status: "closed", mode: "air", costFilter: "warning", offset: 50 });
    expect(procurementBackHref("shipmentsReturn=https%3A%2F%2Fevil.example", "/shipments")).toMatch(/^\/shipments\?/);
    expect(parseProcurementRecord("/shipments/42", "poScope=-1&shipmentLine=bad&document=%3Cscript%3E")).toEqual({ kind: "shipment", id: 42, tab: "lines" });
  });
  it("returns to the original filtered list after a nested PO and receipt visit", () => {
    const ship = procurementChildHref("/shipments", "search=PO-17&offset=50", "/shipments/42");
    const po = procurementChildHref("/shipments/42", ship.split("?")[1], "/purchase-orders/17");
    const receipt = procurementChildHref("/purchase-orders/17", po.split("?")[1], "/receiving?open=31");
    const backPo = procurementBackHref(receipt.split("?")[1], "/receiving");
    const backShip = procurementBackHref(backPo.split("?")[1], "/purchase-orders");
    const backList = procurementBackHref(backShip.split("?")[1], "/shipments");
    expect(shipmentListState(backList.split("?")[1])).toMatchObject({ search: "PO-17", offset: 50 });
  });
  it("invalidates all relationship surfaces with existing approved correction and cost updates", async () => {
    const client = new QueryClient();
    const keys = [["/api/purchase-orders/17", "relationships"], ["/api/inbound-shipments/42", "relationships"], ["/api/receiving", "relationships", 31]];
    for (const key of keys) client.setQueryData(key, { recorded: true });
    await invalidatePurchaseCosts(client);
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });
});
