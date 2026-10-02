import { describe, expect, it, vi } from "vitest";
import {
  buildOrderHoldView,
  countOpenHeldLines,
  describeHoldRelease,
  describeReleaseOutcome,
  formatHeldFor,
  holdReleaseEndpoint,
  HoldReleaseRequestError,
  readHoldReleaseError,
  requestHoldRelease,
  RELEASE_ORDER_CLOSED,
  RELEASE_ORDER_HOLD_FIRST,
  type HoldReleaseLine,
  type HoldReleaseOrder,
  type HoldReleaseTarget,
} from "../../order-hold-release";

const NOW = new Date("2026-10-01T12:00:00.000Z");

function line(overrides: Partial<HoldReleaseLine> = {}): HoldReleaseLine {
  return { id: 55, sku: "SLV-100", name: "Penny sleeves", quantity: 2, status: "pending", onHold: true, holdReason: "Awaiting restock", ...overrides };
}

function order(overrides: Partial<HoldReleaseOrder> = {}): HoldReleaseOrder {
  return { id: 7, orderNumber: "#63570", onHold: 0, heldAt: null, warehouseStatus: "ready", items: [], ...overrides };
}

const orderTarget: HoldReleaseTarget = { kind: "order", orderId: 7, orderNumber: "#63570" };
const lineTarget: HoldReleaseTarget = { kind: "line", orderId: 7, orderNumber: "#63570", itemId: 55, sku: "SLV-100", quantity: 2 };

describe("buildOrderHoldView", () => {
  it("offers an order release for a whole-order hold", () => {
    const view = buildOrderHoldView(order({ onHold: 1, heldAt: "2026-09-30T08:00:00.000Z" }), true);
    expect(view.isHeld).toBe(true);
    expect(view.canRelease).toBe(true);
    expect(view.orderHold).toEqual({ target: orderTarget, heldAt: "2026-09-30T08:00:00.000Z", blockedReason: null });
    expect(view.heldLines).toEqual([]);
  });

  it("offers a line release for each open held line, and none for lines that can no longer ship", () => {
    const view = buildOrderHoldView(order({
      warehouseStatus: "partially_shipped",
      items: [
        line(),
        line({ id: 56, onHold: false }),
        line({ id: 57, status: "cancelled" }),
        line({ id: 58, quantity: 0 }),
      ],
    }), true);
    expect(view.isHeld).toBe(true);
    expect(view.orderHold).toBeNull();
    expect(view.heldLines).toEqual([{ line: line(), target: lineTarget, blockedReason: null }]);
  });

  it("blocks a line release until the whole-order hold is released", () => {
    const view = buildOrderHoldView(order({ onHold: 1, items: [line()] }), true);
    expect(view.orderHold?.blockedReason).toBeNull();
    expect(view.heldLines[0].blockedReason).toBe(RELEASE_ORDER_HOLD_FIRST);
  });

  it("blocks every release on a shipped or cancelled order", () => {
    const view = buildOrderHoldView(order({ onHold: 1, warehouseStatus: "cancelled", items: [line()] }), true);
    expect(view.orderHold?.blockedReason).toBe(RELEASE_ORDER_CLOSED);
    expect(view.heldLines[0].blockedReason).toBe(RELEASE_ORDER_CLOSED);
  });

  it("reports the viewer's permission separately from the hold policy", () => {
    const view = buildOrderHoldView(order({ onHold: 1, items: [line()] }), false);
    expect(view.canRelease).toBe(false);
    expect(view.orderHold?.blockedReason).toBeNull();
  });

  it("flags a legacy on_hold status that has no flag to release", () => {
    const view = buildOrderHoldView(order({ warehouseStatus: "on_hold" }), true);
    expect(view.isHeld).toBe(true);
    expect(view.statusOnlyHold).toBe(true);
    expect(view.orderHold).toBeNull();
  });

  it("shows nothing for an order without holds", () => {
    expect(buildOrderHoldView(order({ items: [line({ onHold: false })] }), true).isHeld).toBe(false);
    expect(buildOrderHoldView(order({ items: null }), true).isHeld).toBe(false);
  });
});

describe("countOpenHeldLines", () => {
  it("counts only held lines that can still ship", () => {
    expect(countOpenHeldLines(order({ items: [line(), line({ id: 2 }), line({ id: 3, status: "short" })] }))).toBe(2);
    expect(countOpenHeldLines(order({ items: undefined }))).toBe(0);
  });
});

describe("hold release copy and endpoints", () => {
  it("posts order and line releases to their endpoints", () => {
    expect(holdReleaseEndpoint(orderTarget)).toBe("/api/orders/7/release-hold");
    expect(holdReleaseEndpoint(lineTarget)).toBe("/api/orders/7/items/55/release-hold");
  });

  it("says how long an order has been held, from an injected clock", () => {
    expect(formatHeldFor("2026-09-28T08:30:00.000Z", NOW)).toBe("3d 3h");
    expect(formatHeldFor("2026-10-01T06:48:00.000Z", NOW)).toBe("5h 12m");
    expect(formatHeldFor("2026-10-01T11:48:00.000Z", NOW)).toBe("12m");
    expect(formatHeldFor("2026-10-01T11:59:30.000Z", NOW)).toBe("under a minute");
    expect(formatHeldFor(null, NOW)).toBeNull();
    expect(formatHeldFor("not a date", NOW)).toBeNull();
  });

  it("describes what a release does before it is confirmed", () => {
    expect(describeHoldRelease(orderTarget)).toEqual(expect.objectContaining({
      title: "Release order #63570 from hold?",
      confirmLabel: "Release order",
    }));
    expect(describeHoldRelease(orderTarget).description).toMatch(/ShipStation order is released/);
    expect(describeHoldRelease(lineTarget).title).toBe("Release SLV-100 on #63570?");
    expect(describeHoldRelease(lineTarget).description).toMatch(/ships on its own/);
  });

  it("distinguishes a real release from one that had already happened", () => {
    expect(describeReleaseOutcome(orderTarget, true).title).toBe("Hold released");
    expect(describeReleaseOutcome(lineTarget, true).description).toBe("SLV-100 on #63570 will ship on its own.");
    expect(describeReleaseOutcome(orderTarget, false)).toEqual({
      title: "Already released",
      description: "Order #63570 was not on hold any more. Nothing changed.",
    });
  });
});

describe("readHoldReleaseError", () => {
  it("prefers the server's explanation", () => {
    expect(readHoldReleaseError(409, { error: "The whole order is on hold.", code: "X" })).toBe("The whole order is on hold.");
  });

  it("falls back by status when the body has no message", () => {
    expect(readHoldReleaseError(401, null)).toMatch(/Sign in again/);
    expect(readHoldReleaseError(403, {})).toMatch(/orders:hold/);
    expect(readHoldReleaseError(500, { error: "  " })).toMatch(/Try again/);
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("requestHoldRelease", () => {
  it("posts with the session cookie and reads whether the order hold was released", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: 7, holdReleased: true }));
    await expect(requestHoldRelease(orderTarget, fetchImpl)).resolves.toEqual({ released: true });
    expect(fetchImpl).toHaveBeenCalledWith("/api/orders/7/release-hold", expect.objectContaining({
      method: "POST",
      credentials: "include",
    }));
  });

  it("reports a replayed release as not released", async () => {
    await expect(requestHoldRelease(orderTarget, async () => jsonResponse(200, { holdReleased: false }))).resolves.toEqual({ released: false });
    await expect(requestHoldRelease(lineTarget, async () => jsonResponse(200, { ok: true, released: false }))).resolves.toEqual({ released: false });
    await expect(requestHoldRelease(lineTarget, async () => jsonResponse(200, { ok: true, released: true }))).resolves.toEqual({ released: true });
  });

  it("throws the server's refusal with its code", async () => {
    const refusal = requestHoldRelease(lineTarget, async () => jsonResponse(409, {
      error: "The whole order is on hold. Release the order hold first, then release this line",
      code: "WMS_HOLD_RELEASE_ORDER_ON_HOLD",
    }));
    await expect(refusal).rejects.toBeInstanceOf(HoldReleaseRequestError);
    await expect(refusal).rejects.toMatchObject({ status: 409, code: "WMS_HOLD_RELEASE_ORDER_ON_HOLD" });
  });

  it("survives a non-JSON error body", async () => {
    const failure = requestHoldRelease(orderTarget, async () => new Response("<html>Bad gateway</html>", { status: 502 }));
    await expect(failure).rejects.toMatchObject({ status: 502, code: null, message: "The release did not go through. Try again." });
  });
});
