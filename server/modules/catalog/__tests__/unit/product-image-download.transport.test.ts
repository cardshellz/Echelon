import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { fetchProductImage, type ProductImageTransportDependencies } from "../../product-image-download.transport";
import { MAX_PRODUCT_IMAGE_BYTES } from "../../product-image-download.service";

const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Reply = { status?: number; headers?: Record<string, string>; body?: Buffer; interrupted?: boolean };
function transport(replies: Reply[] = [{}]) {
  const request = vi.fn<ProductImageTransportDependencies["request"]>((_url, _options, callback) => {
    const reply = replies.shift() ?? {};
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      queueMicrotask(() => {
        const stream = new PassThrough();
        const response = stream as unknown as IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? { "content-type": "image/png" };
        callback(response);
        if (reply.interrupted) response.destroy(new Error("private transport detail"));
        else stream.end(reply.body ?? image);
      });
      return req;
    }) as ClientRequest["end"];
    return req;
  });
  const resolve = vi.fn().mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  return { request, resolve, timeoutMs: 1000 };
}

describe("catalog external image transport", () => {
  it("pins the checked address while keeping the original host and TLS verification", async () => {
    const dependencies = transport();
    expect(await fetchProductImage("https://cdn.example.com/photo.png?v=1", dependencies)).toEqual({ data: image, mimeType: "image/png" });
    const [url, options] = dependencies.request.mock.calls[0];
    expect(url.host).toBe("cdn.example.com"); expect(url.search).toBe("?v=1");
    expect(options).toMatchObject({ agent: false, family: 4, rejectUnauthorized: true, autoSelectFamily: false });
    const callback = vi.fn(); options.lookup!(url.hostname, {}, callback);
    expect(callback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(options.headers).not.toHaveProperty("authorization");
  });
  it.each(["http://127.0.0.1/photo", "http://169.254.169.254/latest", "http://10.0.0.2/photo", "http://192.168.0.1/photo", "http://100.64.0.1/photo"])("rejects non-public address %s", async url => {
    const dependencies = transport();
    dependencies.resolve.mockResolvedValue([{ address: new URL(url).hostname, family: 4 }]);
    await expect(fetchProductImage(url, dependencies)).rejects.toMatchObject({ code: "IMAGE_ADDRESS_BLOCKED" });
    expect(dependencies.request).not.toHaveBeenCalled();
  });
  it.each(["file:///private", "ftp://example.com/photo", "https://user:password@example.com/photo", "https://example.com:123/photo", "not a URL"])("rejects unsafe URL %s", async url => {
    const dependencies = transport();
    await expect(fetchProductImage(url, dependencies)).rejects.toMatchObject({ status: 422 });
    expect(dependencies.resolve).not.toHaveBeenCalled(); expect(dependencies.request).not.toHaveBeenCalled();
  });
  it("rejects a host with mixed public and private addresses", async () => {
    const dependencies = transport();
    dependencies.resolve.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(fetchProductImage("https://example.com/photo", dependencies)).rejects.toMatchObject({ status: 422 });
  });
  it("follows a relative redirect and validates its new source", async () => {
    const dependencies = transport([{ status: 302, headers: { location: "/original.png" } }, {}]);
    expect(await fetchProductImage("https://example.com/photo", dependencies)).toMatchObject({ data: image });
    expect(dependencies.resolve).toHaveBeenCalledTimes(2);
    expect(dependencies.request.mock.calls[1][0].pathname).toBe("/original.png");
  });
  it("blocks redirects into the private network", async () => {
    const dependencies = transport([{ status: 302, headers: { location: "http://127.0.0.1/private" } }]);
    dependencies.resolve.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(fetchProductImage("https://example.com/photo", dependencies)).rejects.toMatchObject({ code: "IMAGE_ADDRESS_BLOCKED" });
    expect(dependencies.request).toHaveBeenCalledTimes(1);
  });
  it("bounds redirect loops", async () => {
    const dependencies = transport(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/again" } })));
    await expect(fetchProductImage("https://example.com/photo", dependencies)).rejects.toMatchObject({ code: "IMAGE_REDIRECT_LIMIT" });
    expect(dependencies.request).toHaveBeenCalledTimes(4);
  });
  it.each([
    [{ status: 403 }, "IMAGE_SOURCE_UNAVAILABLE"],
    [{ headers: { "content-type": "text/html" } }, "IMAGE_FORMAT_UNSUPPORTED"],
    [{ body: Buffer.from("<html>not a picture</html>") }, "IMAGE_FORMAT_UNSUPPORTED"],
    [{ headers: { "content-type": "image/png", "content-length": String(MAX_PRODUCT_IMAGE_BYTES + 1) } }, "IMAGE_TOO_LARGE"],
    [{ body: Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES + 1) }, "IMAGE_TOO_LARGE"],
    [{ interrupted: true }, "IMAGE_DOWNLOAD_INTERRUPTED"],
  ] as const)("rejects incomplete or unsupported responses %#", async (reply, code) => {
    await expect(fetchProductImage("https://example.com/photo", transport([reply]))).rejects.toMatchObject({ code });
  });
  it("times out stalled DNS and sanitizes resolution errors", async () => {
    const dependencies = transport(); dependencies.timeoutMs = 5;
    dependencies.resolve.mockImplementation(() => new Promise(() => {}));
    await expect(fetchProductImage("https://example.com/photo", dependencies)).rejects.toMatchObject({ code: "IMAGE_DOWNLOAD_TIMEOUT" });
    dependencies.resolve.mockRejectedValue(new Error("secret DNS diagnostic"));
    await expect(fetchProductImage("https://example.com/photo", dependencies)).rejects.toMatchObject({ code: "IMAGE_SOURCE_UNAVAILABLE" });
  });
});
