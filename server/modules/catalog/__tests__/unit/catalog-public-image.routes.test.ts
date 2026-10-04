import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCatalogPublicImageRoutes } from "../../catalog-public-image.routes";

const hash = "ab".repeat(32);
const data = Buffer.from("89504e470d0a1a0a00000000", "hex");
describe("public catalog photo HTTP boundary", () => {
  let server: Server, base: string;
  const read = vi.fn();
  beforeEach(async () => {
    read.mockReset().mockResolvedValue({ data, mimeType: "image/png" });
    const app = express();
    registerCatalogPublicImageRoutes(app, read);
    // Other routes retain authentication; this public reader is narrowly registered.
    app.use("/api", (_req, res) => { res.sendStatus(401); });
    server = await new Promise<Server>(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  it.each(["", ".png"])("serves the exact bytes anonymously with safe headers for the %s suffix", async suffix => {
    const response = await fetch(`${base}/api/catalog/images/42/${hash}${suffix}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe('inline; filename="catalog-image-42.png"');
    expect(response.headers.get("cache-control")).toBe("public, max-age=300, must-revalidate");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
    expect(read).toHaveBeenCalledExactlyOnceWith(42, hash);
  });
  it.each([`0/${hash}`, `1.5/${hash}`, `2147483648/${hash}`, `1/no`, `1/${"A".repeat(64)}`, `1/${hash}.svg`, `1/${hash}.png.exe`])("rejects malformed identities without reading storage: %s", path => {
    return fetch(`${base}/api/catalog/images/${path}`).then(async response => {
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(read).not.toHaveBeenCalled();
    });
  });
  it("rejects an extension that does not match the stored content", async () => {
    const response = await fetch(`${base}/api/catalog/images/42/${hash}.jpg`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(read).toHaveBeenCalledExactlyOnceWith(42, hash);
  });
  it("returns the same uncached 404 for absent files and mismatched fingerprints", async () => {
    read.mockResolvedValue(null);
    const response = await fetch(`${base}/api/catalog/images/42/${hash}`);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Not Found");
  });
  it.each(["", ".png"])("supports conditional GET and HEAD for the %s suffix without changing the file", async suffix => {
    const response = await fetch(`${base}/api/catalog/images/42/${hash}${suffix}`, { headers: { "If-None-Match": `"${hash}"`, "Cache-Control": "max-age=0" } });
    expect(response.status).toBe(304);
    const head = await fetch(`${base}/api/catalog/images/42/${hash}${suffix}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(String(data.length));
    expect(await head.text()).toBe("");
  });
  it("does not grant access to metadata, file-by-id, listing or write endpoints", async () => {
    for (const path of ["/api/products", "/api/product-assets/42", "/api/product-assets/42/file", "/api/catalog/images", "/api/catalog/images/42"]) {
      expect((await fetch(base + path)).status).toBe(401);
    }
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await fetch(`${base}/api/catalog/images/42/${hash}`, { method })).status).toBe(401);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("reports storage failure without leaking errors or caching the failure", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      read.mockRejectedValue(new Error("private database credentials"));
      const response = await fetch(`${base}/api/catalog/images/42/${hash}`);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ code: "CATALOG_IMAGE_READ_FAILED", error: "Image temporarily unavailable." });
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "catalog.public_image.read_failed", assetId: 42, code: "CATALOG_IMAGE_READ_FAILED" }));
    } finally { log.mockRestore(); }
  });
});
