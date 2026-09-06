import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWarehouseInventorySourceRoutes } from "../../interfaces/warehouse-inventory-source.routes";
import { WarehouseInventorySourceService } from "../../application/warehouse-inventory-source.service";
import { WarehouseInventorySourceError } from "../../domain/warehouse-inventory-source";

const { permission, flags } = vi.hoisted(() => ({
  flags: { denied: false },
  permission: vi.fn((_resource: string, _action: string) => (_req: Request, res: Response, next: NextFunction) =>
    flags.denied ? res.sendStatus(403) : next()),
}));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: permission }));

describe("warehouse inventory source HTTP boundary", () => {
  let server: http.Server;
  let url: string;
  let authenticated = true;
  const result = {
    fulfillmentNodeId: 1, warehouseId: 1, lifecycleStatus: "draft" as const, alreadyApplied: false,
    runtimeAuthorityChanged: false as const, providerWriteAttempted: false as const, outboxEnqueued: false as const,
  };
  const request = {
    warehouseId: 1, expectedWarehouseFingerprint: "a".repeat(64), inventoryAuthority: "echelon",
    fulfillmentAuthority: "echelon", changeReason: "Prepare this warehouse", idempotencyKey: "route-source",
  };
  const store = { getView: vi.fn(async () => ({ warehouses: [] })), prepareDraft: vi.fn(async () => result) };
  beforeEach(async () => {
    authenticated = true; flags.denied = false; permission.mockClear(); store.getView.mockClear(); store.prepareDraft.mockReset();
    store.prepareDraft.mockResolvedValue(result);
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { if (authenticated) Object.assign(req, { session: { user: { id: "operator" } } }); next(); });
    registerWarehouseInventorySourceRoutes(app, new WarehouseInventorySourceService(store));
    app.get("/api/warehouses/:id", (_req, res) => res.status(418).json({ error: "wrong route" }));
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/warehouses/inventory-sources`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const post = (body: unknown = request) => fetch(url, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  it("registers GET ahead of dynamic warehouse IDs and performs no save", async () => {
    const response = await fetch(url);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ warehouses: [] });
    expect(store.prepareDraft).not.toHaveBeenCalled();
    expect(permission).toHaveBeenCalledWith("inventory_planning", "view");
  });
  it("requires edit permission and derives the audit actor from the session", async () => {
    const response = await post(); expect(response.status).toBe(201);
    expect(await response.json()).toEqual(result);
    expect(permission).toHaveBeenCalledWith("inventory_planning", "edit");
    expect(store.prepareDraft).toHaveBeenCalledWith(expect.objectContaining({ actorId: "operator", ...request }));
  });
  it("returns 200 for an exact replay", async () => {
    store.prepareDraft.mockResolvedValue({ ...result, alreadyApplied: true });
    const response = await post(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ alreadyApplied: true });
  });
  it("rejects forged actor and activation fields", async () => {
    expect((await post({ ...request, actorId: "forged", lifecycleStatus: "active" })).status).toBe(400);
    expect(store.prepareDraft).not.toHaveBeenCalled();
  });
  it("requires a session actor even when permission middleware is mocked permissive", async () => {
    authenticated = false; expect((await post()).status).toBe(401); expect(store.prepareDraft).not.toHaveBeenCalled();
  });
  it("does not reach the store when permission is denied", async () => {
    flags.denied = true; expect((await post()).status).toBe(403); expect(store.prepareDraft).not.toHaveBeenCalled();
  });
  it("returns a classified conflict without hiding it", async () => {
    store.prepareDraft.mockRejectedValue(new WarehouseInventorySourceError(409, "WAREHOUSE_INVENTORY_SOURCE_EXISTS", "Already prepared"));
    const response = await post(); expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "WAREHOUSE_INVENTORY_SOURCE_EXISTS", classification: "permanent" } });
  });
  it("does not leak unexpected infrastructure errors", async () => {
    store.prepareDraft.mockRejectedValue(new Error("private-database-detail"));
    const response = await post(); expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private-database-detail");
  });
});
