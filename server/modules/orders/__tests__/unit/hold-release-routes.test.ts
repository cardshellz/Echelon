import type { Express, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storage: {
    releaseOrderHold: vi.fn(),
    getOrderItemById: vi.fn(),
    getOrderById: vi.fn(),
    createPickingLog: vi.fn(),
  },
  enqueueHoldSync: vi.fn(),
  enqueueSortRankSync: vi.fn(),
  enqueueShipmentPush: vi.fn(),
  reserveAndPush: vi.fn(),
  broadcast: vi.fn(),
  releaseLine: vi.fn(),
  db: { execute: vi.fn(async () => ({ rows: [] })) },
}));

vi.mock("../../index", () => ({ ordersStorage: mocks.storage }));
vi.mock("../../../channels", () => ({ channelsStorage: {} }));
vi.mock("../../../identity", () => ({ identityStorage: {} }));
vi.mock("../../../../db", () => ({ db: mocks.db }));
vi.mock("../../../../websocket", () => ({ broadcastOrdersUpdated: mocks.broadcast }));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: vi.fn(),
  requirePermission: vi.fn(() => vi.fn()),
}));
vi.mock("../../../../platform/http/page-read-limit", () => ({
  awaitPageReads: vi.fn(),
  limitPageRead: (handler: unknown) => handler,
}));
vi.mock("../../../oms/webhook-retry.worker", () => ({
  enqueueShipStationHoldSyncRetry: mocks.enqueueHoldSync,
  enqueueShipStationSortRankSyncRetry: mocks.enqueueSortRankSync,
  enqueueShipStationShipmentPushRetry: mocks.enqueueShipmentPush,
}));
vi.mock("../../../shipping/adapters/shipstation.adapter", () => ({ engineRefFromRow: vi.fn() }));
vi.mock("../../release-hold-push", () => ({ reserveAndPushAfterHoldRelease: mocks.reserveAndPush }));
vi.mock("../../picking-history.routes", () => ({ registerPickingHistoryRoutes: vi.fn() }));
vi.mock("../../pick-correction.routes", () => ({ registerPickCorrectionRoutes: vi.fn() }));
vi.mock("../../../wms/line-item-hold", () => ({
  releaseLineItemFromHold: mocks.releaseLine,
  holdLineItemWithSplit: vi.fn(),
}));

import { registerPickingRoutes } from "../../picking.routes";

type Handler = (request: Request, response: Response) => Promise<unknown>;

const ORDER_ROUTE = "/api/orders/:id/release-hold";
const LINE_ROUTE = "/api/orders/:id/items/:itemId/release-hold";
const user = { id: "user-lead", username: "lead", displayName: "Lead", role: "lead" };
const heldOrder = { id: 7, orderNumber: "#63570", warehouseStatus: "ready", onHold: 1, heldAt: new Date("2026-09-30T10:00:00Z"), omsFulfillmentOrderId: "901" };
const releasedOrder = { ...heldOrder, onHold: 0, heldAt: null };

function handlerFor(path: string): Handler {
  const app = {
    get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
    locals: { services: { pickCorrections: {}, orderCombining: {} } },
  };
  registerPickingRoutes(app as unknown as Express);
  const registration = app.post.mock.calls.find((args) => args[0] === path);
  if (!registration) throw new Error(`${path} was not registered`);
  return registration.at(-1) as Handler;
}

function call(path: string, params: Record<string, string>) {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const request = {
    params,
    body: {},
    headers: {},
    session: { user },
    sessionID: "session-1",
    app: { locals: { services: {} } },
  } as unknown as Request;
  return { promise: handlerFor(path)(request, response as unknown as Response), response };
}

type ConsoleSpy = { mock: { calls: unknown[][] }; mockRestore(): void };

function loggedLines(spy: ConsoleSpy): Array<Record<string, unknown>> {
  return spy.mock.calls.map((args: unknown[]) => JSON.parse(String(args[0])));
}

let logSpy: ConsoleSpy;
let warnSpy: ConsoleSpy;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.storage.createPickingLog.mockResolvedValue({});
  mocks.storage.getOrderById.mockResolvedValue(releasedOrder);
  mocks.enqueueHoldSync.mockResolvedValue(undefined);
  mocks.enqueueSortRankSync.mockResolvedValue(undefined);
  mocks.enqueueShipmentPush.mockResolvedValue(undefined);
  mocks.reserveAndPush.mockResolvedValue({ pushed: 0, failed: 0 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
});

describe("POST /api/orders/:id/release-hold", () => {
  it("rejects a malformed id before touching storage", async () => {
    for (const id of ["abc", "0", "1e3", "-5"]) {
      const { promise, response } = call(ORDER_ROUTE, { id });
      await promise;
      expect(response.status).toHaveBeenCalledWith(400);
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "WMS_HOLD_RELEASE_INVALID_ID" }));
    }
    expect(mocks.storage.releaseOrderHold).not.toHaveBeenCalled();
  });

  it("releases a held order: durable hold sync inside the transaction, then the side effects and the audit", async () => {
    const tx = { marker: "release-transaction" };
    mocks.storage.releaseOrderHold.mockImplementation(async (_id: number, options: any) => {
      await options.followUp(tx);
      return { outcome: "released", order: releasedOrder, before: { onHold: 1, heldAt: heldOrder.heldAt, warehouseStatus: "ready" } };
    });

    const { promise, response } = call(ORDER_ROUTE, { id: "7" });
    await promise;

    expect(mocks.storage.releaseOrderHold).toHaveBeenCalledWith(7, expect.objectContaining({ now: expect.any(Date) }));
    expect(mocks.enqueueHoldSync).toHaveBeenNthCalledWith(1, tx, 7, "release", "ReleaseHold");
    expect(mocks.enqueueHoldSync).toHaveBeenNthCalledWith(2, mocks.db, 7, "release", "ReleaseHold");
    expect(mocks.enqueueSortRankSync).toHaveBeenCalledWith(mocks.db, 7, "ReleaseHoldSortRank");
    expect(mocks.reserveAndPush).toHaveBeenCalledWith(mocks.db, expect.anything(), 7, "ReleaseHold");
    expect(mocks.storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({
      actionType: "order_unhold",
      orderId: 7,
      pickerId: "user-lead",
      orderStatusBefore: "ready",
    }));
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ id: 7, holdReleased: true }));
    expect(loggedLines(logSpy)).toContainEqual(expect.objectContaining({
      level: "INFO", action: "order_hold_release", outcome: "released", wms_order_id: 7, oms_order_id: "901",
    }));
  });

  it("answers a replayed release without re-running any side effect or audit", async () => {
    mocks.storage.releaseOrderHold.mockResolvedValue({
      outcome: "not_held", order: releasedOrder, before: { onHold: 0, heldAt: null, warehouseStatus: "ready" },
    });

    const { promise, response } = call(ORDER_ROUTE, { id: "7" });
    await promise;

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ id: 7, holdReleased: false }));
    expect(mocks.enqueueHoldSync).not.toHaveBeenCalled();
    expect(mocks.enqueueSortRankSync).not.toHaveBeenCalled();
    expect(mocks.reserveAndPush).not.toHaveBeenCalled();
    expect(mocks.storage.createPickingLog).not.toHaveBeenCalled();
    expect(loggedLines(logSpy)).toContainEqual(expect.objectContaining({ level: "DEBUG", outcome: "not_held" }));
  });

  it("refuses a held order that already shipped, with a namespaced code and no side effects", async () => {
    mocks.storage.releaseOrderHold.mockResolvedValue({
      outcome: "order_terminal",
      order: { ...heldOrder, warehouseStatus: "shipped" },
      before: { onHold: 1, heldAt: null, warehouseStatus: "shipped" },
    });

    const { promise, response } = call(ORDER_ROUTE, { id: "7" });
    await promise;

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.stringContaining("shipped"),
      code: "WMS_HOLD_RELEASE_ORDER_TERMINAL",
    });
    expect(mocks.reserveAndPush).not.toHaveBeenCalled();
    expect(mocks.storage.createPickingLog).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown order", async () => {
    mocks.storage.releaseOrderHold.mockResolvedValue({ outcome: "not_found", order: null, before: null });

    const { promise, response } = call(ORDER_ROUTE, { id: "99" });
    await promise;

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "WMS_HOLD_RELEASE_NOT_FOUND" }));
  });
});

describe("POST /api/orders/:id/items/:itemId/release-hold", () => {
  const heldItem = { id: 55, orderId: 7, sku: "SLV-100", onHold: true };

  beforeEach(() => {
    mocks.storage.getOrderItemById.mockResolvedValue(heldItem);
  });

  it("rejects malformed ids before any read", async () => {
    const { promise, response } = call(LINE_ROUTE, { id: "7", itemId: "x" });
    await promise;
    expect(response.status).toHaveBeenCalledWith(400);
    expect(mocks.storage.getOrderItemById).not.toHaveBeenCalled();
  });

  it("returns 404 when the line belongs to another order", async () => {
    mocks.storage.getOrderItemById.mockResolvedValue({ ...heldItem, orderId: 8 });
    const { promise, response } = call(LINE_ROUTE, { id: "7", itemId: "55" });
    await promise;
    expect(response.status).toHaveBeenCalledWith(404);
    expect(mocks.releaseLine).not.toHaveBeenCalled();
  });

  it("releases the line, queues its held shipment for push, audits and broadcasts", async () => {
    mocks.releaseLine.mockResolvedValue({ outcome: "released", heldShipmentId: 900, orderStatus: "partially_shipped", lineWasHeld: true });

    const { promise, response } = call(LINE_ROUTE, { id: "7", itemId: "55" });
    await promise;

    expect(mocks.releaseLine).toHaveBeenCalledWith(mocks.db, { wmsOrderId: 7, orderItemId: 55, now: expect.any(Date) });
    expect(mocks.enqueueShipmentPush).toHaveBeenCalledWith(mocks.db, 900, "LineItemReleasedPush");
    expect(mocks.storage.createPickingLog).toHaveBeenCalledWith(expect.objectContaining({ actionType: "line_item_released", orderId: 7 }));
    expect(mocks.broadcast).toHaveBeenCalledTimes(1);
    expect(response.json).toHaveBeenCalledWith({ ok: true, released: true, heldShipmentId: 900 });
    expect(loggedLines(logSpy)).toContainEqual(expect.objectContaining({
      level: "INFO", action: "line_hold_release", outcome: "released", order_item_id: 55, shipment_id: 900,
      before: { lineOnHold: true, orderStatus: "partially_shipped" },
      after: { lineOnHold: false, orderStatus: "partially_shipped" },
    }));
  });

  it("refuses while the whole order is held: nothing is pushed, audited or broadcast", async () => {
    mocks.releaseLine.mockResolvedValue({ outcome: "order_on_hold", heldShipmentId: null, orderStatus: "ready", lineWasHeld: true });

    const { promise, response } = call(LINE_ROUTE, { id: "7", itemId: "55" });
    await promise;

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({
      error: expect.stringMatching(/Release the order hold first/),
      code: "WMS_HOLD_RELEASE_ORDER_ON_HOLD",
    });
    expect(mocks.enqueueShipmentPush).not.toHaveBeenCalled();
    expect(mocks.storage.createPickingLog).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("refuses on a closed order", async () => {
    mocks.releaseLine.mockResolvedValue({ outcome: "order_terminal", heldShipmentId: null, orderStatus: "cancelled", lineWasHeld: true });
    const { promise, response } = call(LINE_ROUTE, { id: "7", itemId: "55" });
    await promise;
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "WMS_HOLD_RELEASE_ORDER_TERMINAL" }));
  });

  it("answers a replayed release with released=false and no side effects", async () => {
    mocks.releaseLine.mockResolvedValue({ outcome: "not_held", heldShipmentId: null, orderStatus: "ready", lineWasHeld: false });
    const { promise, response } = call(LINE_ROUTE, { id: "7", itemId: "55" });
    await promise;
    expect(response.json).toHaveBeenCalledWith({ ok: true, released: false, heldShipmentId: null });
    expect(mocks.enqueueShipmentPush).not.toHaveBeenCalled();
    expect(mocks.storage.createPickingLog).not.toHaveBeenCalled();
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it("still answers success when the push enqueue fails after the release committed, and logs it", async () => {
    mocks.releaseLine.mockResolvedValue({ outcome: "released", heldShipmentId: 900, orderStatus: "ready", lineWasHeld: true });
    mocks.enqueueShipmentPush.mockRejectedValue(new Error("connection reset"));

    const { promise, response } = call(LINE_ROUTE, { id: "7", itemId: "55" });
    await promise;

    expect(response.json).toHaveBeenCalledWith({ ok: true, released: true, heldShipmentId: 900 });
    expect(loggedLines(warnSpy)).toContainEqual(expect.objectContaining({
      level: "WARN",
      action: "line_hold_release_push_enqueue",
      outcome: "failed",
      error_code: "WMS_HOLD_RELEASE_PUSH_ENQUEUE_FAILED",
      shipment_id: 900,
      error: "connection reset",
    }));
  });
});
