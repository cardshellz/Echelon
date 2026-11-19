import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { requestLocalHttp } from "../../../../__tests__/helpers/local-http";
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) => (req: Request, res: Response, next: NextFunction) => {
  if (req.headers["x-test-permission"] !== `${resource}:${action}`) return res.status(403).json({ error: "Permission denied" });
  next();
} }));
import { registerShipmentMeasurementRoutes } from "../../shipment-measurement-correction.routes";
import { ShipmentMeasurementCorrectionError } from "../../shipment-measurement-correction.repository";
import { CostEvidenceError } from "../../../inventory/infrastructure/cost-evidence-values";

describe("shipment measurement review HTTP boundary", () => {
  let server: http.Server, base: string;
  const service = { context: vi.fn(), preview: vi.fn() };
  beforeEach(async () => {
    vi.resetAllMocks();
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { if (req.headers["x-test-actor"]) (req as Request & { user?: { id: string } }).user = { id: String(req.headers["x-test-actor"]) }; next(); });
    registerShipmentMeasurementRoutes(app, service);
    server = http.createServer(app); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); vi.restoreAllMocks(); });
  const call = (method: "GET" | "POST", id = "42", permission = method === "GET" ? "purchasing:view" : "purchasing:approve", actor = "approver") =>
    requestLocalHttp(`${base}/api/inbound-shipments/${id}/measurements${method === "POST" ? "/preview" : ""}`, { method,
      headers: { "content-type": "application/json", "x-test-permission": permission, "x-test-actor": actor }, ...(method === "POST" ? { body: JSON.stringify({ review: "input" }) } : {}) });
  it("requires view for context and purchasing approval for preview before reading data", async () => {
    expect((await call("GET", "42", "inventory:view")).status).toBe(403);
    expect((await call("POST", "42", "purchasing:edit")).status).toBe(403);
    expect(service.context).not.toHaveBeenCalled(); expect(service.preview).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1.5", "17x", "00017", "2147483648"])("rejects invalid identifier %s", async id => {
    expect((await call("GET", id)).status).toBe(400); expect((await call("POST", id)).status).toBe(400);
    expect(service.context).not.toHaveBeenCalled(); expect(service.preview).not.toHaveBeenCalled();
  });
  it("requires an authenticated actor and passes the current identity to the owner", async () => {
    expect((await call("POST", "42", "purchasing:approve", "")).status).toBe(401);
    service.context.mockResolvedValue({ sourceVersion: "review-version" });
    service.preview.mockResolvedValue({ previewVersion: "cost-impact" });
    expect(await (await call("GET")).json()).toEqual({ sourceVersion: "review-version" });
    expect(await (await call("POST")).json()).toEqual({ previewVersion: "cost-impact" });
    expect(service.context).toHaveBeenCalledExactlyOnceWith(42, "approver");
    expect(service.preview).toHaveBeenCalledExactlyOnceWith(42, { review: "input" }, "approver");
  });
  it("returns actionable business rejections and redacts infrastructure failures", async () => {
    service.preview.mockRejectedValueOnce(new ShipmentMeasurementCorrectionError("Reload and review the changed shipment.", "SHIPMENT_MEASUREMENTS_STALE"));
    const conflict = await call("POST"); expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "SHIPMENT_MEASUREMENTS_STALE", error: "Reload and review the changed shipment." });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    service.context.mockRejectedValueOnce(new Error("private database connection"));
    const failed = await call("GET"); expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private database"); expect(logged).toHaveBeenCalledWith(expect.not.stringContaining("private database"));
  });
  it("preserves the existing partial-history posting safeguard as an actionable preview conflict", async () => {
    service.preview.mockRejectedValueOnce(new CostEvidenceError("COST_RECONCILIATION_PARTIAL_HISTORY", "Complete the receipt attribution before replacing the historical adjustment."));
    const conflict = await call("POST");
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "COST_RECONCILIATION_PARTIAL_HISTORY", error: "Complete the receipt attribution before replacing the historical adjustment." });
  });
});
