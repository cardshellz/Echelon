import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Express } from "express";

const ports = vi.hoisted(() => ({
  productPut: vi.fn(), productDelete: vi.fn(), variantPut: vi.fn(), variantDelete: vi.fn(), variant: vi.fn(),
}));
vi.mock("../../index", () => ({ channelsStorage: {
  upsertChannelProductOverride: ports.productPut, deleteChannelProductOverride: ports.productDelete,
  upsertChannelVariantOverride: ports.variantPut, deleteChannelVariantOverride: ports.variantDelete,
} }));
vi.mock("../../../orders", () => ({ ordersStorage: {}, orderPageQuerySchema: {} }));
vi.mock("../../../catalog", () => ({ catalogStorage: { getProductVariantById: ports.variant } }));
vi.mock("../../../warehouse", () => ({ warehouseStorage: {} }));
vi.mock("../../../inventory", () => ({ inventoryStorage: {} }));
vi.mock("../../../../storage/base", async () => ({
  ...(await import("@shared/schema")), ...(await import("drizzle-orm")), db: {},
}));
vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
vi.mock("../../../oms/oms.service", () => ({ createOmsService: () => ({}) }));
vi.mock("../../../../routes/middleware", () => ({ requireAuth: vi.fn(), requirePermission: () => vi.fn() }));
vi.mock("../../../inventory-planning/infrastructure/inventory-legacy-admin-control.repository",
  () => ({ createInventoryLegacyAdminControlService: () => ({}) }));
vi.mock("../../../../websocket", () => ({ broadcastOrdersUpdated: vi.fn() }));

import { registerChannelRoutes } from "../../channels.routes";

const writes = [
  ["put /api/channels/:channelId/products/:productId/overrides", ports.productPut],
  ["delete /api/channels/:channelId/products/:productId/overrides", ports.productDelete],
  ["put /api/channels/:channelId/variants/:variantId/overrides", ports.variantPut],
  ["delete /api/channels/:channelId/variants/:variantId/overrides", ports.variantDelete],
] as const;
function routes() {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<unknown>>();
  const app = { ...Object.fromEntries(["get", "post", "put", "patch", "delete"].map(method => [method,
    (path: string, ...middleware: Array<(req: unknown, res: unknown) => Promise<unknown>>) =>
      handlers.set(`${method} ${path}`, middleware[middleware.length - 1])])), locals: { services: {} } };
  registerChannelRoutes(app as unknown as Express);
  return handlers;
}
function response() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}
describe("channel selection mutation conflicts", () => {
  beforeEach(() => {
    vi.resetAllMocks(); vi.spyOn(console, "error").mockImplementation(() => undefined);
    ports.variant.mockResolvedValue({ id: 101, salesEligibility: "sellable", isActive: true });
  });
  afterEach(() => vi.restoreAllMocks());
  it.each(writes)("returns an actionable safe conflict for %s", async (path, write) => {
    write.mockRejectedValue(new Error("private query", { cause: { code: "55P03", message: "PUBLICATION_SELECTION_BUSY" } }));
    const res = response();
    await routes().get(path)!({ params: { channelId: "36", productId: "1", variantId: "101" }, body: { isListed: 0 } }, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "PUBLICATION_SELECTION_BUSY", retryable: true,
      error: "A stock update is finishing. Your selection was not saved; retry it in a moment." }));
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("private query");
  });
  it("does not relabel another PostgreSQL lock failure as a safe selection retry", async () => {
    ports.productPut.mockRejectedValue({ code: "55P03", message: "unrelated private SQL" });
    const res = response();
    await routes().get(writes[0][0])!({ params: { channelId: "36", productId: "1" }, body: { isListed: 0 } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to save override" });
  });
});
