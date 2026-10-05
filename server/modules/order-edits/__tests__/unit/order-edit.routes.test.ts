import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { registerOrderEditRoutes } from "../../interfaces/order-edit.routes";
import type { OrderEditService } from "../../application/order-edit.service";

const KEY = "22222222-2222-4222-8222-222222222222";
describe("order edit staff HTTP boundary", () => {
  let server: Server;
  let url: string;
  let loggedIn: boolean;
  const permission = vi.fn(async () => true);
  const state = vi.fn(async () => ({
    connections: [],
    customerAccess: false as const,
  }));
  const settings = vi.fn(async () => ({
    connectionId: 4,
    channelId: 36,
    name: "Shopify",
    shopDomain: "test.myshopify.com",
    paymentWindowMinutes: 30,
    enabled: true,
  }));
  const quote = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks();
    permission.mockResolvedValue(true);
    loggedIn = true;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (loggedIn)
        req.session = { user: { id: "staff" } } as typeof req.session;
      next();
    });
    registerOrderEditRoutes(app, {
      service: { state, settings, quote } as unknown as OrderEditService,
      hasPermission: permission,
      report: vi.fn(),
    });
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const save = () => ({
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": KEY,
      Origin: url,
    },
    body: JSON.stringify({ paymentWindowMinutes: 30, enabled: true }),
  });
  it("denies customers/anonymous sessions and current staff without orders:edit", async () => {
    loggedIn = false;
    expect((await fetch(`${url}/api/order-edits/admin/state`)).status).toBe(
      401,
    );
    loggedIn = true;
    permission.mockResolvedValue(false);
    expect((await fetch(`${url}/api/order-edits/admin/state`)).status).toBe(
      403,
    );
    expect(state).not.toHaveBeenCalled();
  });
  it("requires settings:edit as well as orders:edit to change the payment window", async () => {
    permission.mockImplementation(
      async (_actor?: string, resource?: string) => resource !== "settings",
    );
    expect(
      (await fetch(`${url}/api/order-edits/admin/settings/4`, save())).status,
    ).toBe(403);
    expect(settings).not.toHaveBeenCalled();
  });
  it.each([
    undefined,
    "https://evil.example",
    "null",
    "http://127.0.0.1.evil.example",
  ])("rejects unsafe mutation origin %s", async (origin) => {
    const input = save();
    const headers: Record<string, string> = { ...input.headers };
    if (origin === undefined) delete headers.Origin;
    else headers.Origin = origin;
    expect(
      (
        await fetch(`${url}/api/order-edits/admin/settings/4`, {
          ...input,
          headers,
        })
      ).status,
    ).toBe(403);
    expect(settings).not.toHaveBeenCalled();
  });
  it("validates configured window and rejects unknown JSON fields without saving", async () => {
    for (const body of [
      { paymentWindowMinutes: 0, enabled: true },
      { paymentWindowMinutes: 30, enabled: true, customerAccess: true },
    ]) {
      expect(
        (
          await fetch(`${url}/api/order-edits/admin/settings/4`, {
            ...save(),
            body: JSON.stringify(body),
          })
        ).status,
      ).toBe(400);
    }
    expect(settings).not.toHaveBeenCalled();
  });
  it("returns a verified connection DTO, never caching financial responses", async () => {
    const result = await fetch(
      `${url}/api/order-edits/admin/settings/4`,
      save(),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect((await result.json()).connectionId).toBe(4);
    expect(settings).toHaveBeenCalledWith(
      4,
      { paymentWindowMinutes: 30, enabled: true },
      "staff",
    );
  });
  it("requires an identical body/header quote key before staging", async () => {
    const result = await fetch(`${url}/api/order-edits/admin/quotes`, {
      ...save(),
      method: "POST",
      body: JSON.stringify({
        connectionId: 4,
        omsOrderId: 1,
        expectedRevision: "fingerprint",
        requestKey: "33333333-3333-4333-8333-333333333333",
        changes: [{ lineItemId: "gid://shopify/LineItem/1", quantity: 3 }],
        additions: [],
      }),
    });
    expect(result.status).toBe(400);
    expect(quote).not.toHaveBeenCalled();
  });
});
