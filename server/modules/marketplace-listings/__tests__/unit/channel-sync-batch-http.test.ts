import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { registerChannelSyncBatchRoutes } from "../../infrastructure/channel-sync-batch.routes";
import { projectSyncBatch } from "../../domain/channel-sync-batch";
vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    (resource: string, action: string) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (req.headers["x-permission"] !== `${resource}:${action}`) {
        res.sendStatus(403);
        return;
      }
      Object.assign(req, { session: { user: { id: "operator" } } });
      next();
    },
}));
describe("shared channel sync HTTP contract", () => {
  let server: Server, base: string;
  const service = { start: vi.fn(), list: vi.fn(), get: vi.fn() };
  beforeEach(async () => {
    vi.resetAllMocks();
    const app = express();
    app.use(express.json());
    registerChannelSyncBatchRoutes(app, service);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/channels/1/sync-batches`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const post = (body: unknown, permission = "channels:edit") =>
    fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-permission": permission,
      },
      body: JSON.stringify(body),
    });
  it("requires edit to submit and view even for read-only progress", async () => {
    expect(
      (await post({ commandKey: randomUUID() }, "channels:view")).status,
    ).toBe(403);
    expect((await fetch(base)).status).toBe(403);
    expect(service.start).not.toHaveBeenCalled();
    expect(service.list).not.toHaveBeenCalled();
  });
  it("uses authenticated actor and channel; rejects forged scope and malformed input before calling the owner", async () => {
    const commandKey = randomUUID(),
      now = new Date("2026-10-21T12:00:00Z");
    service.start.mockResolvedValue(
      projectSyncBatch(
        {
          id: commandKey,
          destination: {
            channelId: 1,
            provider: "any",
            connectionId: 1,
            accountId: "seller",
            environment: "production",
            marketplaceId: null,
          },
          actor: "user:operator",
          createdAt: now.toISOString(),
          admissionCompletedAt: null,
          admissionError: null,
          admissionRefusal: null,
          members: [],
        },
        [],
        now,
      ),
    );
    const response = await post({ commandKey });
    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(service.start).toHaveBeenCalledExactlyOnceWith(1, "user:operator", {
      commandKey,
    });
    expect(
      (await post({ commandKey, actor: "forged", channelId: 2 })).status,
    ).toBe(400);
    expect((await post({ commandKey: "invalid" })).status).toBe(400);
    expect(service.start).toHaveBeenCalledTimes(1);
  });
  it("reads status without submitting work and sanitizes failed or inconsistent output", async () => {
    service.list.mockResolvedValue({ batches: [] });
    expect(
      (await fetch(base, { headers: { "x-permission": "channels:view" } }))
        .status,
    ).toBe(200);
    expect(service.list).toHaveBeenCalledExactlyOnceWith(1, 0);
    expect(service.start).not.toHaveBeenCalled();
    service.list.mockRejectedValueOnce(new Error("secret-connection-string"));
    const response = await fetch(base, {
      headers: { "x-permission": "channels:view" },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("secret-connection");
    service.start.mockResolvedValue({ counts: { finished: 1, total: 0 } });
    expect((await post({ commandKey: randomUUID() })).status).toBe(503);
  });
});
