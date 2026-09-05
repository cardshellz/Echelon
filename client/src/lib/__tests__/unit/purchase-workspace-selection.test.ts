import { describe, expect, it } from "vitest";
import { parsePurchaseWorkspaceSelection, parseWorkspaceRef, purchaseWorkspaceInspectHref, purchaseWorkspaceCloseHref } from "../../purchase-workspace-selection";
import { parseProcurementRecord, procurementChildHref, procurementBackHref, parseProcurementJourney } from "../../procurement-navigation";

function parts(href: string): [string, string] {
  const url = new URL(href, "https://echelon.test");
  return [url.pathname, url.search];
}

describe("purchase workspace selection", () => {
  it.each(["shipment:0", "shipment:01", "shipment:1.5", "shipment:9007199254740992", "shipment:1:costs", "unknown:1", "https://example.com", "__proto__:1"])("rejects invalid inspector identity %s", (value) => {
    expect(parseWorkspaceRef(value)).toBeNull();
    expect(parsePurchaseWorkspaceSelection(`inspect=${encodeURIComponent(value)}`).invalid).toBe(true);
  });

  it.each(["https://example.com/purchase-orders/17", "//example.com/purchase-orders/17", "/purchase-orders/0", "/purchase-orders/01", "/purchase-orders/9007199254740992", "/shipments/17"])("rejects noncanonical workspace path %s", (path) => {
    expect(() => purchaseWorkspaceInspectHref(path, "", { kind: "shipment", id: 42 })).toThrow("Invalid purchase workspace destination");
    expect(() => purchaseWorkspaceCloseHref(path, "")).toThrow("Invalid purchase workspace destination");
  });

  it("distinguishes closed, malformed, and duplicate selection", () => {
    expect(parsePurchaseWorkspaceSelection("")).toEqual({ selected: null, trail: [], invalid: false });
    expect(parsePurchaseWorkspaceSelection("inspect=shipment:42&inspect=invoice:71").invalid).toBe(true);
    expect(parsePurchaseWorkspaceSelection("inspect=shipment:42&inspectVia=invalid")).toEqual({ selected: { kind: "shipment", id: 42 }, trail: [], invalid: false });
  });

  it("navigates between inspected records without losing the purchase or outer journey", () => {
    const path = "/purchase-orders/17";
    const first = purchaseWorkspaceInspectHref(path, "purchase=purchase:9:shipments&via=shipment:5:costs", { kind: "shipment", id: 42 });
    const next = purchaseWorkspaceInspectHref(...parts(first), { kind: "invoice", id: 71 });
    expect(parsePurchaseWorkspaceSelection(parts(next)[1])).toEqual({ selected: { kind: "invoice", id: 71 }, trail: [{ kind: "shipment", id: 42 }], invalid: false });
    const previous = purchaseWorkspaceCloseHref(...parts(next), true);
    expect(parseProcurementRecord(...parts(previous))).toEqual(parseProcurementRecord(...parts(first)));
    expect(parseProcurementJourney(parts(previous)[1]).purchase?.id).toBe(9);
    const closed = purchaseWorkspaceCloseHref(...parts(next));
    expect(parsePurchaseWorkspaceSelection(parts(closed)[1]).selected).toBeNull();
    expect(new URLSearchParams(parts(closed)[1]).get("tab")).toBe("lifecycle");
  });

  it("restores selected inspector and its trail after opening a full document and copying the URL", () => {
    const shipment = purchaseWorkspaceInspectHref("/purchase-orders/17", "", { kind: "shipment", id: 42 });
    const workspace = purchaseWorkspaceInspectHref(...parts(shipment), { kind: "invoice", id: 71 });
    const expanded = procurementChildHref(...parts(workspace), "/ap-invoices/71?tab=details");
    const returned = procurementBackHref(parts(expanded)[1], "/ap-invoices");
    expect(parseProcurementRecord(...parts(returned))).toEqual(parseProcurementRecord(...parts(workspace)));
    const closedInspector = purchaseWorkspaceCloseHref(...parts(returned), true);
    expect(parsePurchaseWorkspaceSelection(parts(closedInspector)[1]).selected).toEqual({ kind: "shipment", id: 42 });
  });

  it("keeps old navigation references compatible and rejects inspector payloads on other record types", () => {
    expect(procurementBackHref("via=shipment:42:costs", "/ap-invoices")).toBe("/shipments/42?tab=costs");
    for (const ref of ["shipment:42:costs~invoice:71", "purchase:17:lines~invoice:71", "purchase:17:lifecycle~invalid", "purchase:17:lifecycle~receipt:0"]) {
      expect(parseProcurementJourney(`via=${encodeURIComponent(ref)}`).trail).toEqual([]);
    }
  });

  it("bounds inspector history and does not add duplicate history for the current selection", () => {
    let href = "/purchase-orders/17?tab=lifecycle";
    for (let id = 1; id <= 25; id++) href = purchaseWorkspaceInspectHref(...parts(href), { kind: "shipment", id });
    const current = parsePurchaseWorkspaceSelection(parts(href)[1]);
    expect(current.trail).toHaveLength(8);
    const unchanged = purchaseWorkspaceInspectHref(...parts(href), { kind: "shipment", id: 25 });
    expect(parsePurchaseWorkspaceSelection(parts(unchanged)[1])).toEqual(current);
    expect(parsePurchaseWorkspaceSelection("x".repeat(8193)).invalid).toBe(true);
  });
});
