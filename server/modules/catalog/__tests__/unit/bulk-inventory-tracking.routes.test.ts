import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BULK_INVENTORY_TRACKING_PATH, MAX_BULK_INVENTORY_TRACKING_PRODUCTS,
  bulkInventoryTrackingRequestSchema } from "@shared/catalog/bulk-inventory-tracking";
import { registerBulkInventoryTrackingRoutes } from "../../bulk-inventory-tracking.routes";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn(), permitted: true, authenticated: true,
  permission: vi.fn() }));
vi.mock("../../bulk-inventory-tracking.service", () => ({ createBulkInventoryTrackingService: () => mocks }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) => {
  mocks.permission(resource, action);
  return (req: Request, res: Response, next: NextFunction) => {
    if (!mocks.permitted) return res.status(403).json({ error: "Forbidden" });
    if (mocks.authenticated) Object.assign(req, { user: { id: "operator" } });
    return next();
  };
} }));

describe("bulk inventory tracking HTTP boundary", () => {
  let server: Server;
  let url: string;
  const request = { productIds: [1], inventoryTrackingDefault: false };
  const applyInput = { ...request, expectedPreviewHash: "a".repeat(64) };
  const preview = { previewHash: applyInput.expectedPreviewHash, inventoryTrackingDefault: false, products: [{
    productId: 1, name: "Product", sku: null, currentDefault: true, status: "change", variantCount: 0,
    changingVariantCount: 0, trackedOverrideCount: 0, untrackedOverrideCount: 0, blockers: [],
  }] };
  const result = { inventoryTrackingDefault: false, changedProductIds: [1], unchangedProductIds: [],
    changingVariantCount: 0, trackedOverrideCount: 0, untrackedOverrideCount: 0 };
  beforeEach(async () => {
    vi.clearAllMocks(); mocks.preview.mockReset(); mocks.apply.mockReset();
    mocks.permitted = true; mocks.authenticated = true;
    const app = express(); app.use(express.json()); registerBulkInventoryTrackingRoutes(app);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${BULK_INVENTORY_TRACKING_PATH}`;
  });
  afterEach(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  function post(endpoint: string, body: unknown, key?: string) {
    return new Promise<{ status: number; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`${url}/${endpoint}`, { method: "POST", headers: { "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}) } }, res => {
        let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text), headers: res.headers }));
        res.on("error", reject);
      });
      req.on("error", reject); req.end(JSON.stringify(body));
    });
  }
  it("requires inventory edit permission for review and apply", async () => {
    mocks.permitted = false;
    expect((await post("preview", request)).status).toBe(403);
    expect((await post("apply", applyInput, "unique-key")).status).toBe(403);
    expect(mocks.permission.mock.calls).toEqual([["inventory", "edit"], ["inventory", "edit"]]);
    expect(mocks.preview).not.toHaveBeenCalled(); expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each([[], [0], [-1], [1.5], [1, 1], [Number.MAX_SAFE_INTEGER + 1], ["1"],
    Array.from({ length: MAX_BULK_INVENTORY_TRACKING_PRODUCTS + 1 }, (_, index) => index + 1)].map(productIds => ({ productIds })))
    ("rejects invalid selection $productIds before calling the owner", async ({ productIds }) => {
    expect((await post("preview", { ...request, productIds })).status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("accepts the maximum bounded batch and rejects ambiguous or unknown fields", () => {
    expect(bulkInventoryTrackingRequestSchema.safeParse({ ...request, productIds: Array.from({ length: MAX_BULK_INVENTORY_TRACKING_PRODUCTS }, (_, i) => i + 1) }).success).toBe(true);
    for (const input of [{ ...request, inventoryTrackingDefault: "false" }, { ...request, actor: "spoofed" }]) {
      expect(bulkInventoryTrackingRequestSchema.safeParse(input).success).toBe(false);
    }
  });
  it("requires an explicit valid stop intent and rejects it when enabling tracking", async () => {
    expect(bulkInventoryTrackingRequestSchema.safeParse({ ...request, stockDisposition: "retain_history" }).success).toBe(true);
    expect(bulkInventoryTrackingRequestSchema.safeParse({ ...request, stockDisposition: "discard" }).success).toBe(false);
    expect((await post("preview", { ...request, inventoryTrackingDefault: true, stockDisposition: "retain_history" })).status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("validates preview output and disables caching", async () => {
    mocks.preview.mockResolvedValue(preview);
    expect(await post("preview", request)).toMatchObject({ status: 200, body: preview, headers: { "cache-control": "no-store" } });
    expect(mocks.preview).toHaveBeenCalledWith(request);
    mocks.preview.mockResolvedValue({ invalid: true });
    expect((await post("preview", request)).status).toBe(500);
  });
  it("requires a valid reviewed hash, command key and authenticated actor before apply", async () => {
    expect((await post("apply", { ...applyInput, expectedPreviewHash: "invalid" }, "unique-key")).status).toBe(400);
    expect((await post("apply", applyInput)).body.code).toBe("FINANCIAL_COMMAND_IDEMPOTENCY_KEY_REQUIRED");
    mocks.authenticated = false;
    expect((await post("apply", applyInput, "unique-key")).status).toBe(401);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("passes server actor and exact command identity and returns saved replay results", async () => {
    mocks.apply.mockResolvedValue({ httpStatus: 200, body: result, terminalState: "succeeded", replayed: true });
    expect(await post("apply", applyInput, "unique-key")).toMatchObject({ status: 200, body: result,
      headers: { "idempotency-replayed": "true", "cache-control": "no-store" } });
    expect(mocks.apply).toHaveBeenCalledWith(applyInput, expect.objectContaining({ actorType: "user", actorId: "operator",
      idempotencyKey: "unique-key", commandName: "catalog.inventory_tracking.bulk", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });
  it("preserves rejected status and blockers and sanitizes unexpected failures", async () => {
    const body = { error: "Review changed", code: "BULK_INVENTORY_PREVIEW_STALE" };
    mocks.apply.mockResolvedValue({ httpStatus: 409, body, terminalState: "rejected", replayed: false });
    expect(await post("apply", applyInput, "unique-key")).toMatchObject({ status: 409, body });
    mocks.apply.mockRejectedValue(new Error("Internal database detail"));
    const failure = await post("apply", applyInput, "unique-key");
    expect(failure.status).toBe(500); expect(JSON.stringify(failure.body)).not.toContain("Internal database detail");
  });
});
