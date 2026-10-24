import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { historyContext, historyInput } from "../../../../../test/fixtures/shipment-history-correction";
import { planShipmentHistoryCorrection } from "../../domain/shipment-history-correction";
import type { createShipmentHistoryCorrectionService } from "../../shipment-history-correction.service";

vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) =>
  (req: Request, res: Response, next: NextFunction) => req.headers["x-permission"] === `${resource}:${action}` ? next() : res.status(403).json({ error: "Permission denied" }) }));
vi.mock("../../../../platform/observability/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { registerShipmentHistoryCorrectionRoutes } from "../../shipment-history-correction.routes";

type Service = ReturnType<typeof createShipmentHistoryCorrectionService>;
describe("shipment history correction HTTP boundary", () => {
  const service = { context: vi.fn<Service["context"]>(), preview: vi.fn<Service["preview"]>(), approve: vi.fn<Service["approve"]>() };
  let server: http.Server, address: string;
  const root = "/api/inbound-shipments/42/history-correction";
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.defineProperty(req, "session", { value: { user: { id: "admin" } } }); next(); });
    registerShipmentHistoryCorrectionRoutes(app, service);
    server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    vi.clearAllMocks(); service.context.mockResolvedValue(historyContext());
    service.preview.mockResolvedValue({ previewVersion: "c".repeat(64), review: planShipmentHistoryCorrection(historyContext(), historyInput(), "b".repeat(64), new Date("2026-10-23T12:00:00Z")) });
    service.approve.mockResolvedValue({ httpStatus: 200, body: { saved: true }, replayed: true, commandId: 1, terminalState: "succeeded" });
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const send = (path: string, permission: string, body?: unknown, key?: string) => fetch(`${address}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "x-permission": permission, "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  it("checks view and approval permission before touching data", async () => {
    expect((await send(root, "")).status).toBe(403);
    expect((await send(`${root}/preview`, "purchasing:view", historyInput())).status).toBe(403);
    expect((await send(root, "purchasing:view", { ...historyInput(), previewVersion: "c".repeat(64) }, "approval-test-42")).status).toBe(403);
    expect(service.context).not.toHaveBeenCalled(); expect(service.preview).not.toHaveBeenCalled(); expect(service.approve).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "42x", "042", "1.5", "2147483648"])("rejects identifier %s", async id => {
    expect((await send(root.replace("42", id), "purchasing:view")).status).toBe(400);
    expect(service.context).not.toHaveBeenCalled();
  });
  it("requires strict evidence, does not accept quantity writes and requires an idempotency key", async () => {
    expect((await send(`${root}/preview`, "purchasing:approve", { ...historyInput(), evidenceConfirmed: false })).status).toBe(400);
    expect((await send(`${root}/preview`, "purchasing:approve", { ...historyInput(), pieces: 200000 })).status).toBe(400);
    expect((await send(root, "purchasing:approve", { ...historyInput(), previewVersion: "c".repeat(64) })).status).toBe(400);
    expect(service.approve).not.toHaveBeenCalled();
  });
  it("binds approval to the authenticated actor, resource and command key", async () => {
    const response = await send(root, "purchasing:approve", { ...historyInput(), previewVersion: "c".repeat(64) }, "approval-test-42");
    expect(response.status).toBe(200); expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.approve).toHaveBeenCalledWith(42, expect.any(Object), "admin", expect.objectContaining({ actorId: "admin", actorType: "user", resourceKey: "inbound-shipment:42", idempotencyKey: "approval-test-42" }));
  });
  it("classifies failed reads without exposing database details", async () => {
    service.context.mockRejectedValueOnce(new Error("database connection secret"));
    const response = await send(root, "purchasing:view");
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ code: "SHIPMENT_HISTORY_UNAVAILABLE", error: "Shipment history could not be verified. Retry the same request." });
  });
});
