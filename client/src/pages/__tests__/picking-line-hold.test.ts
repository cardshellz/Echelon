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
    expect(PICKING).toContain("wmsOrderId: item.wmsOrderId");
  });

  it("never offers hold for a line that already has picked units", () => {
    // The server rejects a held line that started picking; the UI must not
    // invite the picker into a guaranteed 409.
    expect(PICKING).toContain("disabled={holdLineItemMutation.isPending || currentItem.picked > 0}");
    expect(PICKING).toContain("disabled={item.picked > 0 || holdLineItemMutation.isPending}");
    expect(PICKING).toContain("if (!item || item.picked > 0 || holdLineItemMutation.isPending) return;");
  });

  it("holds in one tap and refreshes the queue, with no reason prompt", () => {
    // Picking uses the held state, without asking the picker to classify why.
    expect(PICKING).toContain("holdLineItemMutation.mutate({ wmsOrderId: item.wmsOrderId, itemId: item.id })");
    expect(PICKING).not.toContain("HOLD_LINE_REASONS");
    expect(PICKING).not.toContain("holdLineReason");
    const holdMutation = PICKING.slice(
      PICKING.indexOf("const holdLineItemMutation"),
      PICKING.indexOf("const resolveAllocationMutation"),
    );
    expect(holdMutation).toContain('queryClient.invalidateQueries({ queryKey: ["picking-queue"] })');
    expect(holdMutation).toContain('title: "Line held"');
  });

  it("releases a held line from the scan card, the list menu and the order card", () => {
    // 2026-10-02: the gun could hold a line but never release one, and an order
    // held only by a line had no Release button at all.
    expect(PICKING).toContain('data-testid="button-release-line"');
    expect(PICKING).toContain("data-testid={`menu-release-${item.id}`}");
    expect(PICKING).toContain("`/api/orders/${wmsOrderId}/items/${itemId}/release-hold`");
    expect(PICKING).toContain("{(order.onHold || hasHeldLine(order)) && (");
    expect(PICKING).toContain("releaseLineHoldMutation.mutate({ wmsOrderId: heldItem.wmsOrderId, itemId: heldItem.id })");
  });

  it("files an order with a held line under Hold instead of losing it", () => {
    // A line hold does not set the order-level flag, so without this an order
    // whose only outstanding line is held shows in neither Ready nor Hold.
    expect(PICKING).toContain("function hasHeldLine");
    expect(PICKING).toContain("singleQueue.filter(o => o.onHold || hasHeldLine(o))");
    expect(PICKING).toContain('const itemOnHold = ("onHold" in item && item.onHold) || hasHeldLine(item);');

    const storage = readFileSync("server/modules/orders/orders.storage.ts", "utf8");
    const queueGuard = storage.slice(
      storage.indexOf("Exclude orders with zero shippable items"),
      storage.indexOf("Historical orders are read separately"),
    );
    // Not pickable, but still readable so the Hold tab can show it.
    expect(queueGuard).toContain("COALESCE(oi.on_hold, false) = false");
    expect(queueGuard).toContain("COALESCE(oi.on_hold, false) = true");
  });

  it("names hold removal separately from releasing an active picking assignment", () => {
    expect(PICKING).not.toContain("Release hold");
    expect(PICKING).toContain("Remove hold");
    expect(PICKING).toContain("Release picking assignment");
    expect(PICKING).not.toContain("Release order");
    expect(PICKING).toContain('title: "Picking assignment released"');
    expect(PICKING).toContain('title: "Couldn\'t release picking assignment"');
    expect(PICKING).toContain("Recover stuck order");
    expect(PICKING).toContain('activeOrder?.status === "in_progress"');
    expect(PICKING).toContain("Picking assignment ended. Pick progress and holds are preserved.");
    expect(PICKING).toContain('title: "Hold removed"');
    expect(PICKING).toContain('title: "Couldn\'t remove hold"');
  });
});
