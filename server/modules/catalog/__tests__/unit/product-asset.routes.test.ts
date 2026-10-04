import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Request, type Response, type NextFunction } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProductAssetRoutes } from "../../product-asset.routes";
import { ProductAssetError } from "../../product-asset-errors";

const mocks = vi.hoisted(() => ({ reorder: vi.fn(), read: vi.fn(), fetchImage: vi.fn(), allowed: true, permissions: [] as string[] }));
vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../product-asset-order.repository", () => ({ reorderCatalogAssets: mocks.reorder }));
vi.mock("../../product-image-download.repository", () => ({ readProductImageDownload: mocks.read }));
vi.mock("../../product-image-download.transport", () => ({ fetchProductImage: mocks.fetchImage }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) => {
  mocks.permissions.push(`${resource}:${action}`);
  return (req: Request, res: Response, next: NextFunction) => {
    req.session = { user: { id: "operator" } } as typeof req.session;
    return mocks.allowed ? next() : res.sendStatus(403);
  };
} }));

describe("catalog asset HTTP boundary", () => {
  let server: Server, base: string;
  beforeEach(async () => {
    vi.clearAllMocks(); mocks.allowed = true; mocks.permissions = []; mocks.reorder.mockResolvedValue(undefined); mocks.read.mockResolvedValue(null);
    const app = express(); app.use(express.json()); registerProductAssetRoutes(app);
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  const reorder = (base: string, body: unknown, id = "1") => fetch(`${base}/api/products/${id}/assets/reorder`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  it("requires catalog view to download and edit to reorder", async () => {
    expect(mocks.permissions).toEqual(["inventory:edit", "inventory:view"]);
    mocks.allowed = false;
    expect((await reorder(base, { orderedIds: [1] })).status).toBe(403);
    expect((await fetch(base + "/api/product-assets/1/download")).status).toBe(403);
    expect(mocks.reorder).not.toHaveBeenCalled(); expect(mocks.read).not.toHaveBeenCalled();
  });
  it.each(["0", "1.5", "1suffix", "2147483648"])("rejects invalid identity %s", async id => {
    expect((await reorder(base, { orderedIds: [1] }, id)).status).toBe(400);
    expect((await fetch(`${base}/api/product-assets/${id}/download`)).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled(); expect(mocks.reorder).not.toHaveBeenCalled();
  });
  it("validates commands and passes a complete order with its snapshot", async () => {
    expect((await reorder(base, { orderedIds: [1, 1] })).status).toBe(400);
    const command = { orderedIds: [2, 1], expectedOrderedIds: [1, 2] };
    expect((await reorder(base, command)).status).toBe(200);
    expect(mocks.reorder).toHaveBeenCalledWith({}, 1, command);
  });
  it("returns stale orders as conflicts and does not leak unexpected errors", async () => {
    mocks.reorder.mockRejectedValueOnce(new ProductAssetError("ASSET_ORDER_CHANGED", "Images changed. Refresh.", 409));
    expect((await reorder(base, { orderedIds: [1] })).status).toBe(409);
    mocks.reorder.mockRejectedValueOnce(new Error("private database password"));
    const response = await reorder(base, { orderedIds: [1] });
    expect(response.status).toBe(500); expect(await response.text()).not.toContain("private database");
  });
  it("sends original stored bytes as an authenticated attachment", async () => {
    const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    mocks.read.mockResolvedValue({ sku: "PACK-100", data, mimeType: "image/png", fileBytes: 8, url: null });
    const response = await fetch(base + "/api/product-assets/2/download");
    expect(response.status).toBe(200); expect(response.headers.get("content-disposition")).toBe('attachment; filename="PACK-100-image-2.png"');
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(mocks.read).toHaveBeenCalledWith({}, 2); expect(mocks.fetchImage).not.toHaveBeenCalled();
  });
  it("surfaces missing files and remote download failures", async () => {
    expect((await fetch(base + "/api/product-assets/2/download")).status).toBe(404);
    mocks.read.mockResolvedValue({ sku: "PACK", data: null, mimeType: null, fileBytes: null, url: "https://example.com/photo" });
    mocks.fetchImage.mockRejectedValue(new ProductAssetError("IMAGE_SOURCE_UNAVAILABLE", "Source unavailable.", 502));
    const response = await fetch(base + "/api/product-assets/2/download");
    expect(response.status).toBe(502); expect(await response.json()).toMatchObject({ error: "Source unavailable." });
  });
});
