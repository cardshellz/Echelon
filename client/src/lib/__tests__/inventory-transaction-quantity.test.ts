import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InventoryTransactionQuantity } from "@/components/inventory/InventoryTransactionQuantity";
import { describeStaleInventoryTransaction, readHistoryShipmentQuantity, shipmentQuantityCsvFields } from "../inventory-transaction-quantity";

const canonical = { status: "verified", quantity: 3, source: "canonical_dispatch_receipt", receiptId: "81" };
const ship = { transactionType: "ship", variantQtyDelta: 0, shipmentQuantityEvidence: canonical };
const render = (input: typeof ship | { transactionType: string; variantQtyDelta: number; shipmentQuantityEvidence?: unknown }) =>
  renderToStaticMarkup(createElement(InventoryTransactionQuantity, input));

describe("inventory history shipment quantity presentation", () => {
  it("renders exact canonical shipment units separately from the unchanged on-hand delta", () => {
    const html = render(ship);
    expect(html).toContain("3 shipped");
    expect(html).toContain("On-hand Δ 0");
    expect(html).toContain("Canonical dispatch receipt 81");
  });

  it("preserves legacy shipped units and explicitly keeps its recorded debit", () => {
    const html = render({ transactionType: "ship", variantQtyDelta: -4,
      shipmentQuantityEvidence: { status: "verified", quantity: 4, source: "legacy_on_hand_delta", receiptId: null } });
    expect(html).toContain("4 shipped");
    expect(html).toContain("On-hand Δ -4");
  });

  it.each([undefined, null, {}, { status: "not_shipment" }, { ...canonical, quantity: 0 },
    { ...canonical, quantity: "3" }, { ...canonical, receiptId: null }, { ...canonical, quantity: 2_147_483_648 }])(
    "does not guess shipped units from a delta when the server evidence is malformed: %j", (evidence) => {
      const input = { transactionType: "ship", variantQtyDelta: -7, shipmentQuantityEvidence: evidence };
      expect(readHistoryShipmentQuantity(input).status).toBe("invalid");
      const html = render(input);
      expect(html).toContain("Shipment quantity needs review");
      expect(html).toContain("On-hand Δ -7");
      expect(html).not.toContain("7 shipped");
      expect(shipmentQuantityCsvFields(input)).toMatchObject({ shipped_quantity: "", shipment_quantity_status: "invalid" });
    });

  it("keeps invalid canonical evidence visible and escapes its diagnostic", () => {
    const input = { ...ship, shipmentQuantityEvidence: { status: "invalid", code: "SHIPMENT_QUANTITY_EVIDENCE_INVALID", reason: "Missing <receipt>" } };
    expect(render(input)).toContain("Missing &lt;receipt&gt;");
    expect(render(input)).not.toContain("0 shipped");
    expect(shipmentQuantityCsvFields(input)).toMatchObject({ shipped_quantity: "", shipment_quantity_issue: "Missing <receipt>" });
  });

  it("exports units, status and receipt independently of the existing qty_delta field", () => {
    expect(shipmentQuantityCsvFields(ship)).toEqual({ shipped_quantity: 3, shipment_quantity_status: "verified",
      shipment_quantity_source: "canonical_dispatch_receipt", shipment_quantity_receipt_id: "81", shipment_quantity_issue: "" });
    expect(ship.variantQtyDelta).toBe(0);
  });

  it("preserves non-shipment delta displays and keeps shipment fields blank", () => {
    const input = { transactionType: "receipt", variantQtyDelta: 5, shipmentQuantityEvidence: { status: "not_shipment" } };
    expect(render(input)).toContain(">+5</div>");
    expect(render(input)).not.toContain("shipped");
    expect(shipmentQuantityCsvFields(input)).toMatchObject({ shipped_quantity: "", shipment_quantity_status: "not_shipment" });
  });

  it("keeps older non-shipment responses compatible without inferring shipment units", () => {
    expect(readHistoryShipmentQuantity({ transactionType: "pick", variantQtyDelta: -2 })).toEqual({ status: "not_shipment" });
  });

  it("labels cycle-count stale notices as on-hand deltas without changing their values", () => {
    expect(describeStaleInventoryTransaction({ type: "ship", qty: 0 })).toBe("ship — on-hand Δ 0");
    expect(describeStaleInventoryTransaction({ type: "receipt", qty: 5 })).toBe("receipt — on-hand Δ +5");
  });
});
