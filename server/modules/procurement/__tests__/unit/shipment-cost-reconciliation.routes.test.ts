import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) => (req: Request, res: Response, next: NextFunction) =>
    req.headers["x-permission"] === `${resource}:${action}` ? next() : res.status(403).json({ error: "Forbidden" }),
}));
import { registerShipmentCostReconciliationRoutes } from "../../shipment-cost-reconciliation.routes";
const input = {
  sourceVersion: "a".repeat(64),
  destination: "inventory_variance",
  reason: "Synthetic source records reviewed.",
};
describe("reconciliation HTTP authority", () => {
  const service = { context: vi.fn(), reconcile: vi.fn(), report: vi.fn() };
  let server: http.Server, base: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = {
        user: req.headers["x-actor"] ? { id: String(req.headers["x-actor"]) } : undefined,
      } as typeof req.session;
      next();
    });
    registerShipmentCostReconciliationRoutes(app, service);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const post = (options: { id?: string; body?: unknown; permission?: string; actor?: string; key?: string } = {}) =>
    fetch(`${base}/api/shipment-lines/${options.id ?? "23"}/cost-reconciliation`, {
      method: "POST",
      body: JSON.stringify(options.body ?? input),
      headers: {
        "content-type": "application/json",
        "x-actor": options.actor ?? "admin",
        "x-permission": options.permission ?? "purchasing:approve",
        "idempotency-key": options.key ?? "synthetic-key",
      },
    });
  it("requires purchase approval, authentication and a durable key", async () => {
    for (const permission of ["purchasing:view", "purchasing:edit", "inventory:approve"])
      expect((await post({ permission })).status).toBe(403);
    expect((await post({ actor: "" })).status).toBe(401);
    expect((await post({ key: "" })).status).toBe(400);
    expect(service.reconcile).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "0023", "23x", "23.5", "2147483648"])("rejects invalid ID %s", async (id) => {
    expect((await post({ id })).status).toBe(400);
    expect(service.reconcile).not.toHaveBeenCalled();
  });
  it("rejects amount overrides, unsupported destinations and incomplete evidence", async () => {
    for (const body of [
      { ...input, amountMills: 0 },
      { ...input, destination: "ignore" },
      { ...input, reason: "" },
      { ...input, sourceVersion: "old" },
    ]) {
      expect((await post({ body })).status).toBe(400);
    }
    expect(service.reconcile).not.toHaveBeenCalled();
  });
  it("passes the exact user-bound command and replay result", async () => {
    service.reconcile.mockResolvedValue({ httpStatus: 200, replayed: true, body: { lineId: 23 } });
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.reconcile).toHaveBeenCalledWith(
      23,
      input,
      "admin",
      expect.objectContaining({
        actorType: "user",
        actorId: "admin",
        resourceKey: "shipment_line:23",
        idempotencyKey: "synthetic-key",
      }),
    );
  });
  it("protects the cost ledger read and does not expose database errors", async () => {
    expect((await fetch(`${base}/api/cogs/historical-adjustments`)).status).toBe(403);
    expect(service.report).not.toHaveBeenCalled();
    service.report.mockRejectedValue(new Error("private SQL details"));
    const response = await fetch(`${base}/api/cogs/historical-adjustments`, {
      headers: { "x-permission": "inventory:view" },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private SQL");
  });
});
