import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { createShipmentEditorService } from "../../shipment-editor.service";
import { ShipmentTrackingError } from "../../shipment-tracking.service";

vi.mock("../../../../routes/middleware", () => ({
  requirePermission: (resource: string, action: string) => (req: Request, res: Response, next: NextFunction) =>
    req.headers["x-permission"] === `${resource}:${action}` ? next() : res.status(403).json({ error: "Permission denied" }),
}));
vi.mock("../../../../platform/observability/logger", () => ({ logger: { error: vi.fn() } }));
import { registerShipmentEditorRoutes } from "../../shipment-editor.routes";

type Service = ReturnType<typeof createShipmentEditorService>;
describe("shipment line editor HTTP boundary", () => {
  const service = { context: vi.fn<Service["context"]>(), preview: vi.fn<Service["preview"]>(), approve: vi.fn<Service["approve"]>() };
  let server: http.Server, address: string;
  const root = "/api/inbound-shipments/42/editor";
  const input = { sourceVersion: "a".repeat(64), reason: "Supplier verified this line removal", changes: [], removals: [5], additions: [] };
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, "session", { value: { user: req.headers["x-signed-out"] ? undefined : { id: "admin" } } });
      next();
    });
    registerShipmentEditorRoutes(app, service);
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  beforeEach(() => {
    vi.resetAllMocks();
    service.approve.mockResolvedValue({ httpStatus: 200, body: { saved: true }, replayed: true, commandId: 1, terminalState: "succeeded" });
  });
  function send(path: string, permission: string, body?: unknown, key?: string, signedOut = false) {
    return fetch(`${address}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-permission": permission, "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}), ...(signedOut ? { "x-signed-out": "1" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  it("checks view and approval permissions before reading or changing data", async () => {
    expect((await send(root, "")).status).toBe(403);
    expect((await send(`${root}/preview`, "purchasing:view", input)).status).toBe(403);
    expect((await send(root, "purchasing:view", input, "editor-test-42")).status).toBe(403);
    expect(service.context).not.toHaveBeenCalled();
    expect(service.preview).not.toHaveBeenCalled();
    expect(service.approve).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "42x", "042", "1.5", "2147483648"])("rejects noncanonical identifier %s", async id => {
    expect((await send(root.replace("42", id), "purchasing:view")).status).toBe(400);
    expect(service.context).not.toHaveBeenCalled();
  });
  it("requires a signed-in actor and an approval retry key", async () => {
    expect((await send(root, "purchasing:view", undefined, undefined, true)).status).toBe(401);
    expect((await send(root, "purchasing:approve", input)).status).toBe(400);
    expect(service.context).not.toHaveBeenCalled();
    expect(service.approve).not.toHaveBeenCalled();
  });
  it("binds the approval to the actor, shipment and retry identity", async () => {
    const response = await send(root, "purchasing:approve", input, "editor-test-42");
    expect(response.status).toBe(200);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(service.approve).toHaveBeenCalledWith(42, input, "admin", expect.objectContaining({
      actorId: "admin", actorType: "user", resourceKey: "shipment:42", commandName: "procurement.shipment.editor.approve", idempotencyKey: "editor-test-42",
    }));
    expect(await response.json()).toEqual({ saved: true });
  });
  it("only marks a recorded terminal rejection safe to abandon", async () => {
    service.approve.mockResolvedValueOnce({ httpStatus: 409, body: { error: "Review changed", code: "SHIPMENT_EDITOR_STALE" }, replayed: false, commandId: 2, terminalState: "rejected" });
    const response = await send(root, "purchasing:approve", input, "editor-test-42");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Review changed", code: "SHIPMENT_EDITOR_STALE", rejected: true });
  });
  it("distinguishes a missing shipment from a transient failure without leaking database details", async () => {
    service.context.mockRejectedValueOnce(new ShipmentTrackingError("Shipment not found.", 404, { code: "SHIPMENT_EDITOR_NOT_FOUND" }));
    expect((await send(root, "purchasing:view")).status).toBe(404);
    service.context.mockRejectedValueOnce(new Error("database connection secret"));
    const response = await send(root, "purchasing:view");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "SHIPMENT_EDITOR_UNAVAILABLE", error: "The edit could not be confirmed. Retry the same approval." });
  });
});
