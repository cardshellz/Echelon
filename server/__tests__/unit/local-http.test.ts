import { createServer, request as nodeRequest, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestLocalHttp, type LocalHttpRequestOptions, type LocalHttpTransport } from "../helpers/local-http";

const servers: Server[] = [];
async function serve(listener: RequestListener): Promise<string> {
  const server = createServer(listener);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

describe("local fixture HTTP transport", () => {
  it.each([6667, 10080])("reaches a real HTTP fixture for blocked logical port %s without global Fetch", async blockedPort => {
    const actual = new URL(await serve((_request, response) => {
      response.writeHead(201, { "content-type": "application/json", "Idempotency-Replayed": "true" });
      response.end(JSON.stringify({ saved: true }));
    }));
    const transport = vi.fn<LocalHttpTransport>((logical, options, listener) => {
      expect(logical.port).toBe(String(blockedPort));
      const mapped = new URL(logical);
      mapped.port = actual.port;
      return nodeRequest(mapped, options, listener);
    });
    // Fetch blocks these logical ports before opening a connection. Only the
    // injected Node HTTP transport remaps to our owned dynamic port; no fixed
    // shared port is leased and no global function is replaced by this test.
    const response = await requestLocalHttp(`http://127.0.0.1:${blockedPort}/proof`, {}, transport);
    expect(transport).toHaveBeenCalledOnce();
    expect(response.status).toBe(201);
    expect(response.ok).toBe(true);
    expect(response.headers.get("idempotency-replayed")).toBe("true");
    expect(await response.clone().json()).toEqual({ saved: true });
    expect(await response.json()).toEqual({ saved: true });
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toThrow();
  });

  it("preserves UTF-8 JSON, HTTP method, request cookies and separate response cookies", async () => {
    const payload = { product: "café 🎴", amountCents: 101 };
    const received: Record<string, unknown> = {};
    const cookies = ["session=fixture; HttpOnly; Path=/", "other=fixture; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Path=/"];
    const origin = await serve((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const bytes = Buffer.concat(chunks);
        Object.assign(received, { method: request.method, url: request.url, cookie: request.headers.cookie,
          key: request.headers["idempotency-key"], contentLength: Number(request.headers["content-length"]), byteLength: bytes.length,
          body: JSON.parse(bytes.toString("utf8")) });
        response.writeHead(409, { "Content-Type": "application/json", "Set-Cookie": cookies });
        response.end(JSON.stringify({ error: "Review required" }));
      });
    });
    const response = await requestLocalHttp(origin + "/save?mode=review", { method: "POST", body: JSON.stringify(payload),
      headers: new Headers({ "Content-Type": "application/json", Cookie: "session=fixture", "Idempotency-Key": "saved-key" }) });
    expect(received).toEqual({ method: "POST", url: "/save?mode=review", cookie: "session=fixture", key: "saved-key",
      contentLength: Buffer.byteLength(JSON.stringify(payload)), byteLength: Buffer.byteLength(JSON.stringify(payload)), body: payload });
    expect(response.status).toBe(409);
    expect(response.ok).toBe(false);
    expect(response.headers.getSetCookie()).toEqual(cookies);
    expect(await response.json()).toEqual({ error: "Review required" });
  });

  it.each([204, 205, 304])("preserves a bodyless %s response", async status => {
    const origin = await serve((_request, response) => { response.writeHead(status); response.end(); });
    const response = await requestLocalHttp(origin);
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("preserves HEAD headers and exposes redirects without following or forwarding credentials", async () => {
    let requests = 0;
    const origin = await serve((request, response) => {
      requests++;
      if (request.method === "HEAD") { response.writeHead(200, { "X-Fixture": "head" }); response.end(); return; }
      response.writeHead(302, { Location: "http://outside.invalid/redirect" }); response.end("Moved");
    });
    const head = await requestLocalHttp(origin, { method: "HEAD" });
    expect(head.body).toBeNull();
    expect(head.headers.get("x-fixture")).toBe("head");
    const redirect = await requestLocalHttp(origin, { headers: { Cookie: "session=fixture" } });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe("http://outside.invalid/redirect");
    expect(requests).toBe(2);
  });

  it("propagates transport failures without waiting for its deadline", async () => {
    const failure = Object.assign(new Error("Synthetic socket failure"), { code: "ECONNREFUSED" });
    const transport = vi.fn<LocalHttpTransport>(() => { throw failure; });
    await expect(requestLocalHttp("http://127.0.0.1:10080/", {}, transport)).rejects.toBe(failure);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects incomplete HTTP responses instead of resolving truncated JSON", async () => {
    const origin = await serve((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
      response.flushHeaders(); response.write('{"partial":');
      setImmediate(() => response.destroy());
    });
    await expect(requestLocalHttp(origin)).rejects.toBeInstanceOf(Error);
  });

  it("destroys a stalled request on timeout so its fixture can close", async () => {
    const origin = await serve(() => { /* Deliberately never send a response. */ });
    await expect(requestLocalHttp(origin, { timeoutMs: 250 }))
      .rejects.toMatchObject({ code: "LOCAL_HTTP_TIMEOUT" });
    const server = servers.pop()!;
    // No closeAllConnections escape hatch: request cleanup must release it.
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("cancels in-flight and already-aborted requests without leaking a connection", async () => {
    const controller = new AbortController();
    const reason = new Error("Synthetic request cancellation");
    const origin = await serve(() => controller.abort(reason));
    await expect(requestLocalHttp(origin, { signal: controller.signal })).rejects.toBe(reason);
    const transport = vi.fn<LocalHttpTransport>(() => { throw new Error("Unexpected transport"); });
    await expect(requestLocalHttp(origin, { signal: controller.signal }, transport)).rejects.toBe(reason);
    expect(transport).not.toHaveBeenCalled();
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it.each([
    ["https://127.0.0.1:8000/", {}], ["http://outside.invalid:8000/", {}],
    ["http://127.0.0.1/", {}], ["http://user:password@127.0.0.1:8000/", {}],
    ["http://127.0.0.1:8000/", { redirect: "follow" }], ["http://127.0.0.1:8000/", { credentials: "include" }],
    ["http://127.0.0.1:8000/", { timeoutMs: 0 }], ["http://127.0.0.1:8000/", { timeoutMs: 2_147_483_648 }],
    ["http://127.0.0.1:8000/", { signal: {} }], ["http://127.0.0.1:8000/", { body: "GET body" }],
    ["http://127.0.0.1:8000/", { method: "POST", body: { amount: 1 } }],
    ["http://127.0.0.1:8000/", { headers: { "accept-encoding": "gzip" } }],
  ])("rejects unsupported input before transport: %s %j", async (url, options) => {
    const transport = vi.fn<LocalHttpTransport>(() => { throw new Error("Unexpected transport"); });
    await expect(requestLocalHttp(String(url), options as LocalHttpRequestOptions, transport)).rejects.toBeInstanceOf(TypeError);
    expect(transport).not.toHaveBeenCalled();
  });
});