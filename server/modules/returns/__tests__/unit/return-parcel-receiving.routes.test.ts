import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { Server } from "node:http";
import { registerReturnParcelReceivingRoutes } from "../../interfaces/http/return-parcel-receiving.routes";

vi.mock("../../../../db", () => ({ db: {} }));
vi.mock("../../../../routes/middleware", () => ({
  requirePermission:
    (_resource: string, action: string) =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (req.get("X-Test-Permission") !== action) return res.sendStatus(403);
      next();
    },
}));
let server: Server | undefined;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});
async function setup() {
  const service = { lookup: vi.fn(), receive: vi.fn() };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = {
      user: req.get("X-Test-Actor") ? { id: 9 } : undefined,
    } as typeof req.session;
    next();
  });
  registerReturnParcelReceivingRoutes(app, service);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Test listener missing.");
  return { service, origin: `http://127.0.0.1:${address.port}` };
}
const command = {
  idempotencyKey: "19380000-0000-4000-8000-000000000051",
  notes: null,
  lines: [
    {
      authorizationLineId: 1,
      expectedCurrentReceivedQuantity: 0,
      quantityReceivedNow: 1,
    },
  ],
};

describe("return label receiving HTTP boundary", () => {
  it("requires view permission for label lookup", async () => {
    const { service, origin } = await setup();
    expect(
      (
        await fetch(
          `${origin}/api/returns/admin/receiving/label?trackingNumber=LABEL`,
        )
      ).status,
    ).toBe(403);
    expect(service.lookup).not.toHaveBeenCalled();
    service.lookup.mockResolvedValue({ parcelId: 1 });
    const response = await fetch(
      `${origin}/api/returns/admin/receiving/label?trackingNumber=LABEL`,
      { headers: { "X-Test-Permission": "view" } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(service.lookup).toHaveBeenCalledExactlyOnceWith("LABEL");
  });
  it("requires adjust permission, an actor, and same-origin JSON commands", async () => {
    const { service, origin } = await setup();
    const path = `${origin}/api/returns/admin/receiving/parcels/1/receipt`;
    const headers = {
      "Content-Type": "application/json",
      "X-Test-Permission": "view",
      "X-Test-Actor": "yes",
      "X-Return-Command": "1",
      Origin: origin,
    };
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers,
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(403);
    headers["X-Test-Permission"] = "adjust";
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: { ...headers, "X-Test-Actor": "" },
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers: { ...headers, Origin: "https://untrusted.invalid" },
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(403);
    expect(service.receive).not.toHaveBeenCalled();
    service.receive.mockResolvedValue({ replayed: false });
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers,
          body: JSON.stringify(command),
        })
      ).status,
    ).toBe(201);
    expect(service.receive).toHaveBeenCalledExactlyOnceWith(
      1,
      command,
      "user:9",
    );
  });
  it("rejects malformed quantities before dispatch and hides unknown infrastructure errors", async () => {
    const { service, origin } = await setup();
    const headers = {
      "Content-Type": "application/json",
      "X-Test-Permission": "adjust",
      "X-Test-Actor": "yes",
      "X-Return-Command": "1",
      Origin: origin,
    };
    const path = `${origin}/api/returns/admin/receiving/parcels/1/receipt`;
    expect(
      (
        await fetch(path, {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...command,
            lines: [{ ...command.lines[0], quantityReceivedNow: -1 }],
          }),
        })
      ).status,
    ).toBe(400);
    expect(service.receive).not.toHaveBeenCalled();
    service.receive.mockRejectedValue(
      new Error("private database credentials must never leave the server"),
    );
    const response = await fetch(path, {
      method: "POST",
      headers,
      body: JSON.stringify(command),
    });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("credentials");
  });
});
