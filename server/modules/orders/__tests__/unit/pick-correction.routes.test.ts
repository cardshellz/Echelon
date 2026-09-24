import express, { type Request, type Response, type NextFunction } from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PickCorrection } from "@shared/pick-corrections";
import type { PickCorrectionService } from "../../pick-correction.service";

vi.mock("../../../../routes/middleware", () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (req.headers.authorization !== "test-session") return res.sendStatus(401);
    req.session = { user: { id: "session-picker" } } as any;
    next();
  },
  requirePermission: (resource: string, action: string) => (req: Request, res: Response, next: NextFunction) => {
    if (req.headers["x-test-permission"] !== `${resource}:${action}`) return res.sendStatus(403);
    next();
  },
}));
import { registerPickCorrectionRoutes } from "../../pick-correction.routes";

describe("pick correction HTTP role boundary", () => {
  let server: Server; let url: string;
  const item: PickCorrection = { id: 1, orderId: 2, orderItemId: 3, orderNumber: "#2", sku: "P5", name: "Pack",
    barcode: "123", location: "A-01", declaredQuantity: 1, pickedQuantity: 0, revision: 2,
    state: "picking_required", answer: "no", assignedPickerId: "session-picker", reviewReason: null };
  const service = { list: vi.fn(), answer: vi.fn(), complete: vi.fn() };
  beforeEach(async () => {
    service.list.mockReset().mockResolvedValue([item]);
    service.answer.mockReset().mockResolvedValue(item);
    service.complete.mockReset().mockResolvedValue(item);
    const app = express(); app.use(express.json());
    registerPickCorrectionRoutes(app, service as unknown as PickCorrectionService);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/picking/corrections`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  it("requires authentication and view permission to read", async () => {
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "test-session" } })).status).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
    const response = await fetch(url, { headers: { authorization: "test-session", "x-test-permission": "picking:view" } });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["answer", "pick"])("requires perform permission for %s and uses only the session actor", async action => {
    const body = { answer: "no", userId: "forged-picker" };
    const request = (permission: string) => fetch(`${url}/1/${action}`, { method: "POST",
      headers: { authorization: "test-session", "x-test-permission": permission, "Content-Type": "application/json" },
      body: JSON.stringify(body) });
    expect((await request("picking:view")).status).toBe(403);
    expect(service.answer).not.toHaveBeenCalled(); expect(service.complete).not.toHaveBeenCalled();
    expect((await request("picking:perform")).status).toBe(200);
    expect(action === "answer" ? service.answer : service.complete).toHaveBeenCalledWith(1, body, "session-picker");
  });
});
