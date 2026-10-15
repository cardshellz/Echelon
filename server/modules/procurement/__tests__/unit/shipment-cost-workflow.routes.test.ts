import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServiceRegistry } from "../../../../services";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), getCostReview: vi.fn() }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({
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
import { FinancialCommandError } from "../../../../platform/commands/transactional-command.service";

describe("shipment cost workflow HTTP boundaries", () => {
  let server: http.Server;
  let base: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers["x-test-actor"]) (req as Request & { user: { id: string } }).user = { id: String(req.headers["x-test-actor"]) };
      next();
    });
    // Only the workflow read is invoked here; the command owner is mocked above.
    app.locals.services = { shipmentTracking: { getCostReview: mocks.getCostReview } } as unknown as ServiceRegistry;
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
