import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { registerListingPublicationRoutes } from "../../interfaces/http/listing-publication.routes";
import { saveListingDraftSchema } from "@shared/types/channel-listing-publication";

vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    (resource: string, action: string) =>
    (
      request: express.Request,
      response: express.Response,
      next: express.NextFunction,
    ) => {
      if (request.headers["x-permission"] !== `${resource}:${action}`) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
      Object.assign(request, { session: { user: { id: "operator-1" } } });
      next();
    },
}));

describe("listing publication HTTP boundary", () => {
  let server: Server;
  let base: string;
  const service = {
    workspace: vi.fn(),
    saveDraft: vi.fn(),
    review: vi.fn(),
    submit: vi.fn(),
    reconcile: vi.fn(),
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    const app = express();
    app.use(express.json());
    Object.assign(app.locals, { services: { listingPublication: service } });
    registerListingPublicationRoutes(app);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/channels/104/listing-publications`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("requires edit permission before accepting a publication command", async () => {
    const response = await fetch(`${base}/operations`, {
      method: "POST",
      headers: {
        "x-permission": "channels:view",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
    expect(service.submit).not.toHaveBeenCalled();
  });
  it("passes the authenticated actor and exact body to the owner", async () => {
    service.saveDraft.mockResolvedValue({ revision: 2 });
    const body = { expectedRevision: 1, items: [{ variantId: 33 }] };
    const response = await fetch(`${base}/draft`, {
      method: "PUT",
      headers: {
        "x-permission": "channels:edit",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(service.saveDraft).toHaveBeenCalledWith(104, body, "operator-1");
  });
  it("passes the exact selected review scope and authenticated actor to the owner", async () => {
    service.review.mockResolvedValue({ id: "review-1" });
    const body = { expectedRevision: 4, variantIds: [33] };
    const response = await fetch(`${base}/review`, {
      method: "POST",
      headers: {
        "x-permission": "channels:edit",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(service.review).toHaveBeenCalledWith(104, body, "operator-1");
  });
  it("requires edit permission before preparing a selected review", async () => {
    const response = await fetch(`${base}/review`, {
      method: "POST",
      headers: {
        "x-permission": "channels:view",
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision: 4, variantIds: [33] }),
    });
    expect(response.status).toBe(403);
    expect(service.review).not.toHaveBeenCalled();
  });
  it("rejects invalid channel IDs before calling any owner", async () => {
    const response = await fetch(base.replace("/104/", "/NaN/"), {
      headers: { "x-permission": "channels:view" },
    });
    expect(response.status).toBe(400);
    expect(service.workspace).not.toHaveBeenCalled();
  });
  it("does not return arbitrary exception text or validation input", async () => {
    service.workspace.mockRejectedValue(
      new Error("secret database connection details"),
    );
    const response = await fetch(base, {
      headers: { "x-permission": "channels:view" },
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret");
    service.saveDraft.mockRejectedValue(
      new z.ZodError([{ code: "custom", path: [], message: "secret input" }]),
    );
    const invalid = await fetch(`${base}/draft`, {
      method: "PUT",
      headers: {
        "x-permission": "channels:edit",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("secret");
  });
});

describe("listing draft bounded JSON boundary", () => {
  const parse = (attributes: unknown) =>
    saveListingDraftSchema.safeParse({
      expectedRevision: 0,
      items: [{ variantId: 1, attributes }],
    });
  it("accepts shipping and product fields and rejects non-JSON or reserved keys", () => {
    expect(
      parse({
        Orderable: { ShippingWeight: 2 },
        Visible: { keyFeatures: ["A", "B", "C"] },
      }).success,
    ).toBe(true);
    for (const attributes of [
      { x: NaN },
      { x: () => null },
      { x: new Date() },
      JSON.parse('{"Visible":{"__proto__":{"polluted":true}}}'),
    ]) {
      expect(parse(attributes).success).toBe(false);
    }
  });
  it("rejects excessive depth, width and body length before schema evaluation", () => {
    let value: unknown = "x";
    for (let index = 0; index < 20; index++) value = { nested: value };
    expect(parse(value).success).toBe(false);
    expect(
      parse({ list: Array.from({ length: 101 }, () => "x") }).success,
    ).toBe(false);
    expect(parse({ long: "x".repeat(30_001) }).success).toBe(false);
    expect(
      parse(
        Object.fromEntries(
          Array.from({ length: 5_001 }, (_, index) => [`key${index}`, 1]),
        ),
      ).success,
    ).toBe(false);
  });
});
