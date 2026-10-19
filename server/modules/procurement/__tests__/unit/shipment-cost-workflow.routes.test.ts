import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceRegistry } from "../../../../services";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), getCostReview: vi.fn(), cancel: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePermission: (resource: string, action: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.headers["x-test-permission"] !== `${resource}:${action}`) return res.status(403).json({ error: "Permission denied" });
    next();
  },
}));
vi.mock("../../../../middleware/idempotency", () => ({ requireIdempotency: () => (_req: Request, _res: Response, next: NextFunction) => next() }));
vi.mock("../../ap-ledger.service", () => ({}));
vi.mock("../../../notifications/notifications.service", () => ({}));
vi.mock("../../shipment-cost-update.commands", async importOriginal => ({
  ...await importOriginal<typeof import("../../shipment-cost-update.commands")>(),
  createShipmentCostUpdateCommands: () => ({ execute: mocks.execute }),
}));
import { registerInboundShipmentRoutes } from "../../inbound-shipment.routes";
import { ShipmentTrackingError } from "../../shipment-tracking.service";
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";

describe("shipment cost workflow HTTP boundaries", () => {
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = (req.headers["x-cancel-actor"] ? { user: { id: String(req.headers["x-cancel-actor"]) } } : {}) as typeof req.session;
      if (req.headers["x-test-actor"]) (req as Request & { user: { id: string } }).user = { id: String(req.headers["x-test-actor"]) };
      next();
    });
    // Only the workflow read is invoked here; the command owner is mocked above.
    app.locals.services = { shipmentTracking: { getCostReview: mocks.getCostReview, cancel: mocks.cancel } } as unknown as ServiceRegistry;
    registerInboundShipmentRoutes(app);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    vi.restoreAllMocks();
  });
  const read = (id = "42", permission = "purchasing:view") => fetch(`${base}/api/inbound-shipments/${id}/cost-review`, { headers: { "x-test-permission": permission } });
  const update = (options: { id?: string; permission?: string; actor?: string; key?: string } = {}) => fetch(`${base}/api/inbound-shipments/${options.id ?? "42"}/update-costs`, {
    method: "POST", body: "{}", headers: { "content-type": "application/json", "x-test-permission": options.permission ?? "purchasing:approve",
      "x-test-actor": options.actor ?? "approver", "idempotency-key": options.key ?? "workflow-test-42" },
  });
  const cancel = (permission = "purchasing:edit", id = "42") => fetch(`${base}/api/inbound-shipments/${id}/cancel`, {
    method: "POST", body: JSON.stringify({ reason: "Supplier withdrew shipment" }),
    headers: { "content-type": "application/json", "x-test-permission": permission, "x-cancel-actor": "cancelling-operator" },
  });
  it("requires edit permission for shipment cancellation", async () => {
    expect((await cancel("purchasing:view")).status).toBe(403);
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1.5", "1x", "0x1", "1e2", "00042", "2147483648"])("rejects invalid cancellation ID %s before the service", async id => {
    const response = await cancel("purchasing:edit", id);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "SHIPMENT_CANCELLATION_INPUT_INVALID" });
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("returns the cancellation evidence conflict without claiming success", async () => {
    const details = { code: "SHIPMENT_CANCELLATION_HISTORY_PROTECTED", shipmentId: 42, blockers: ["receivingHistory"] };
    mocks.cancel.mockRejectedValue(new ShipmentTrackingError("Review the shipment receipt before correcting it.", 409, details));
    const response = await cancel();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: details.code, error: "Review the shipment receipt before correcting it.", details });
    expect(mocks.cancel).toHaveBeenCalledWith(42, "cancelling-operator", "Supplier withdrew shipment");
  });
  it("returns a recoverable unavailable outcome without leaking source failures", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.cancel.mockRejectedValue(new Error("private database credential"));
    const response = await cancel();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "SHIPMENT_CANCELLATION_UNAVAILABLE",
      error: "Shipment cancellation could not be verified. Reload the shipment before trying again." });
    expect(logged).toHaveBeenCalledWith(expect.not.stringContaining("private database credential"));
  });
  it("requires view permission for saved results and approval for the financial command", async () => {
    expect((await read("42", "inventory:view")).status).toBe(403);
    for (const permission of ["purchasing:view", "purchasing:edit", "inventory:approve"]) expect((await update({ permission })).status).toBe(403);
    expect(mocks.getCostReview).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "42.5", "42x", "2147483648", "00042"])("rejects invalid ID %s before reading or writing", async id => {
    expect((await read(id)).status).toBe(400);
    expect((await update({ id })).status).toBe(400);
    expect(mocks.getCostReview).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("returns recorded outcomes and distinguishes a missing shipment", async () => {
    const result = { shipmentId: 42, lines: [] };
    mocks.getCostReview.mockResolvedValueOnce(result).mockResolvedValueOnce(null);
    expect(await (await read()).json()).toEqual(result);
    expect((await read()).status).toBe(404);
    expect(mocks.getCostReview).toHaveBeenCalledWith(42);
  });
  it("preserves the original strict response for older tabs and opts new clients into exceptions", async () => {
    mocks.getCostReview.mockResolvedValue({ shipmentId: 42, lines: [{ lineId: 1, exceptionReview: null }] });
    expect(await (await read()).json()).toEqual({ shipmentId: 42, lines: [{ lineId: 1 }] });
    const response = await fetch(`${base}/api/inbound-shipments/42/cost-review`, { headers: {
      "x-test-permission": "purchasing:view", "X-Shipment-Cost-Review-Version": "2",
    } });
    expect(response.headers.get("vary")).toContain("X-Shipment-Cost-Review-Version");
    expect(await response.json()).toEqual({ shipmentId: 42, lines: [{ lineId: 1, exceptionReview: null }] });
  });
  it("requires an authenticated actor and idempotency key before work", async () => {
    expect((await update({ actor: "" })).status).toBe(401);
    expect((await update({ key: "" })).status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("passes the exact scope and human actor and returns replay metadata", async () => {
    mocks.execute.mockResolvedValue({ httpStatus: 200, replayed: true, body: { shipmentId: 42 } });
    const response = await update();
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(mocks.execute).toHaveBeenCalledWith(42, {}, "approver", expect.objectContaining({
      resourceKey: "shipment:42", routeTemplate: "/api/inbound-shipments/:id/update-costs", commandName: "procurement.shipment_cost.update_all",
      idempotencyKey: "workflow-test-42", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });
  it("preserves the command-in-progress classification and retry header", async () => {
    mocks.execute.mockRejectedValue(new FinancialCommandError("Update in progress", 409, "FINANCIAL_COMMAND_IN_PROGRESS", {}, { "Retry-After": "2" }));
    const response = await update();
    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toMatchObject({ code: "FINANCIAL_COMMAND_IN_PROGRESS" });
  });
  it("logs failures without leaking database details through either endpoint", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getCostReview.mockRejectedValue(new Error("private SELECT evidence"));
    mocks.execute.mockRejectedValue(new Error("private UPDATE evidence"));
    for (const response of [await read(), await update()]) {
      expect(response.status).toBe(500);
      expect(JSON.stringify(await response.json())).not.toContain("private");
    }
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(([value]) => JSON.parse(value))).toEqual([
      expect.objectContaining({ event: "procurement.shipment_cost.review_failed", shipmentId: 42 }),
      expect.objectContaining({ event: "procurement.shipment_cost.update_failed", actorId: "approver" }),
    ]);
  });
});
