import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Holding a line from the gun: the picker parks one line (out of stock,
// damaged, not received) and keeps picking the rest, which ships now. The
// server splits the held line onto its own shipment and the pick-queue guard
// stops counting it, so the order leaves the floor.
const PICKING = readFileSync("client/src/pages/Picking.tsx", "utf8");

describe("pick-floor line hold", () => {
  it("offers hold from both the scan card and the list overflow menu", () => {
    expect(PICKING).toContain('data-testid="button-hold-line"');
    expect(PICKING).toContain("data-testid={`menu-hold-${item.id}`}");
    // Plain label: the confirm dialog already explains what holding does, and
    // the gun is read at arm's length.
    expect(PICKING).toContain("Hold line");
    expect(PICKING).not.toContain("ship rest");
  });

  it("addresses the owning order by its numeric id, not the display order number", () => {
    // PickItem.orderId is the display number ("#63563") and a combined group's
    // id is not a real order, so the line hold must use wmsOrderId.
    expect(PICKING).toContain("wmsOrderId: number;");
    expect(PICKING).toContain("wmsOrderId: order.id,");
    expect(PICKING).toContain("`/api/orders/${wmsOrderId}/items/${itemId}/hold`");
    expect(PICKING).toContain("wmsOrderId: holdLineTarget.wmsOrderId");
  });

  it("never offers hold for a line that already has picked units", () => {
    // The server rejects a held line that started picking; the UI must not
    // invite the picker into a guaranteed 409.
    expect(PICKING).toContain("disabled={holdLineItemMutation.isPending || currentItem.picked > 0}");
    expect(PICKING).toContain("disabled={item.picked > 0 || holdLineItemMutation.isPending}");
    expect(PICKING).toContain("if (!item || item.picked > 0) return;");
  });

  it("requires a reason before holding and refreshes the queue afterwards", () => {
    expect(PICKING).toContain("const HOLD_LINE_REASONS");
    expect(PICKING).toContain("disabled={!holdLineReason || !holdLineTarget || holdLineItemMutation.isPending}");
    const holdMutation = PICKING.slice(
      PICKING.indexOf("const holdLineItemMutation"),
      PICKING.indexOf("const resolveAllocationMutation"),
    );
    expect(holdMutation).toContain('queryClient.invalidateQueries({ queryKey: ["picking-queue"] })');
    expect(holdMutation).toContain('title: "Line held"');
  });
});
