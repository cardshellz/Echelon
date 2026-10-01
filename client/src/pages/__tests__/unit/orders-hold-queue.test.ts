import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Orders page owns hold release (the pick floor only holds). Its On Hold
// tab lists every order waiting on a release — whole-order holds and held
// lines — with a confirmed Release for each hold.
const ORDERS = readFileSync(resolve(__dirname, "../../Orders.tsx"), "utf8");
const PANEL = readFileSync(resolve(__dirname, "../../../components/orders/OrderHoldPanel.tsx"), "utf8");

describe("Orders page On Hold queue", () => {
  it("has an On Hold tab backed by the server's hold bucket and its count", () => {
    expect(ORDERS).toContain('{ value: "hold", label: "On Hold", countKey: "hold"');
    expect(ORDERS).toContain('data-testid={tab.testId}');
    expect(ORDERS).toContain("hold: 0,");
    // Bucket names and counts come from the shared policy, not a local copy.
    expect(ORDERS).toContain('import type { WmsOrderBucket, WmsOrderBucketCounts } from "@shared/wms-order-listing";');
    expect(ORDERS).not.toContain('type WmsOrderBucket = "needs_pick"');
  });

  it("lists each held order on its own card with its release controls", () => {
    // A hold is released per order; a combined group must not hide a held child.
    expect(ORDERS).toContain('statusFilter === "hold" ? filteredOrders');
    expect(ORDERS).toMatch(/statusFilter === "hold" && \(\s*<div className="mt-4">\s*<OrderHoldPanel order=\{order\} \/>/);
    expect(ORDERS).toContain("<HeldLinesBadge order={order} />");
  });

  it("offers the whole-order release in the order detail, leaving lines to their own controls", () => {
    expect(ORDERS).toContain("<OrderHoldPanel order={order} showLines={false} />");
    expect(ORDERS).toContain("<LineItemHoldControls order={order} item={item} />");
    expect(ORDERS).toContain('<HoldReleaseButton target={held.target} disabled={held.blockedReason !== null} label="Release line" />');
    // The old unconfirmed, unguarded release POST is gone.
    expect(ORDERS).not.toContain("/release-hold`, { method: \"POST\" }");
  });
});

describe("OrderHoldPanel", () => {
  it("gates release on orders:hold, the permission the line endpoints require", () => {
    expect(PANEL).toContain('buildOrderHoldView(order, hasPermission("orders", "hold"))');
    expect(PANEL).toContain("disabled={!view.canRelease || view.orderHold.blockedReason !== null}");
    expect(PANEL).toContain("disabled={!view.canRelease || blockedReason !== null}");
    expect(PANEL).toContain("{!view.canRelease && <p");
  });

  it("asks for confirmation and keeps the dialog open until the request settles", () => {
    expect(PANEL).toContain("<AlertDialog");
    expect(PANEL).toContain("event.preventDefault();");
    expect(PANEL).toContain("if (!release.isPending) setConfirming(open);");
    expect(PANEL).toContain("mutationFn: () => requestHoldRelease(target)");
  });

  it("refreshes the Orders views and the pick queue after every attempt", () => {
    expect(PANEL).toContain('const HOLD_STATE_QUERY_KEYS = [["/api/wms/orders"], ["picking-queue"]];');
    expect(PANEL).toMatch(/onSettled: \(\) => \{[\s\S]*invalidateQueries\(\{ queryKey \}\)/);
  });

  it("does not let a release click open the order card it sits on", () => {
    expect(PANEL).toContain("onClick={(event) => event.stopPropagation()}");
  });
});
