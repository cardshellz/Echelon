import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) =>
  (req: Request, res: Response, next: NextFunction) => req.headers["x-permission"] === `${resource}:${action}` ? next() : res.status(403).json({ error: "Forbidden" }) }));
import { registerShipmentCostExceptionRoutes } from "../../shipment-cost-exception.routes";
const input = { sourceVersion: "a".repeat(64), action: "accept", reason: "Historical receipt records reviewed." };
describe("shipment exception HTTP boundary", () => {
  const service = { context: vi.fn(), decide: vi.fn() };
  let server: http.Server, base: string;
  beforeEach(async () => {
    vi.resetAllMocks(); const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: req.headers["x-actor"] ? { id: String(req.headers["x-actor"]) } : undefined } as typeof req.session; next(); });
    registerShipmentCostExceptionRoutes(app, service);
    server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
  const post = (options: { id?: string; body?: unknown; permission?: string; actor?: string; key?: string } = {}) => fetch(`${base}/api/shipment-lines/${options.id ?? "141"}/cost-exception`, {
    method: "POST", body: JSON.stringify(options.body ?? input), headers: { "content-type": "application/json", "x-actor": options.actor ?? "admin",
      "x-permission": options.permission ?? "purchasing:approve", "idempotency-key": options.key ?? "approval-key" },
  });
  it("requires the purchasing approval route permission, authentication and an idempotency key", async () => {
    for (const permission of ["purchasing:view", "purchasing:edit", "inventory:approve"]) expect((await post({ permission })).status).toBe(403);
    expect((await post({ actor: "" })).status).toBe(401); expect((await post({ key: "" })).status).toBe(400);
    expect(service.decide).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "00141", "141x", "141.5", "2147483648"])("rejects invalid path %s before work", async id => {
    expect((await post({ id })).status).toBe(400); expect(service.decide).not.toHaveBeenCalled();
  });
  it("rejects amount overrides and missing evidence", async () => {
    for (const body of [{ ...input, amountMills: 0 }, { ...input, reason: "" }, { ...input, sourceVersion: "old" }]) expect((await post({ body })).status).toBe(400);
    expect(service.decide).not.toHaveBeenCalled();
  });
  it("passes a user-bound command and preserves replay metadata", async () => {
    service.decide.mockResolvedValue({ httpStatus: 200, replayed: true, body: { lineId: 141 } });
    const response = await post(); expect(response.status).toBe(200); expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.decide).toHaveBeenCalledWith(141, input, "admin", expect.objectContaining({ actorType: "user", actorId: "admin", resourceKey: "shipment_line:141", idempotencyKey: "approval-key" }));
  });
  it("reads behind view permission and does not expose database errors", async () => {
    service.context.mockRejectedValue(new Error("private SQL detail"));
    const response = await fetch(`${base}/api/shipment-lines/141/cost-exception`, { headers: { "x-permission": "purchasing:view", "x-actor": "viewer" } });
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("private SQL");
    expect(service.context).toHaveBeenCalledWith(141, "viewer");
  });
});
