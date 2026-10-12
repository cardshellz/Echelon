import { describe, expect, it, vi } from "vitest";
import type { Express } from "express";
const permission = vi.hoisted(() =>
  vi.fn((resource: string, action: string) => ({ resource, action })),
);
vi.mock("../../../../routes/middleware", () => ({
  requirePermission: permission,
}));
import { registerChannelCatalogRoutes } from "../../channel-catalog.routes";

function setup() {
  const routes = new Map<string, { access: unknown; handle: Function }>();
  const stock = vi.fn(async () => ({ connectionId: 9, items: [] }));
  const forChannel = vi.fn(async () => ({ stock }));
  const app = {
    locals: { services: { channelCatalog: { forChannel } } },
    get: (path: string, access: unknown, handle: Function) =>
      routes.set(`GET ${path}`, { access, handle }),
    post: (path: string, access: unknown, handle: Function) =>
      routes.set(`POST ${path}`, { access, handle }),
  } as unknown as Express;
  registerChannelCatalogRoutes(app);
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  return {
    route: routes.get("POST /api/channels/:id/catalog/stock")!,
    forChannel,
    stock,
    res,
  };
}
describe("catalog stock read route", () => {
  it("requires channel view permission and delegates the bounded read to its owner", async () => {
    const s = setup();
    expect(s.route.access).toEqual({ resource: "channels", action: "view" });
    const body = { connectionId: 9, skus: ["A/B"] };
    await s.route.handle({ params: { id: "77" }, body }, s.res);
    expect(s.forChannel).toHaveBeenCalledWith(77);
    expect(s.stock).toHaveBeenCalledExactlyOnceWith(77, body);
    expect(s.res.json).toHaveBeenCalledWith({ connectionId: 9, items: [] });
  });
  it("rejects invalid channel identity before service resolution", async () => {
    const s = setup();
    await s.route.handle({ params: { id: "-1" }, body: {} }, s.res);
    expect(s.forChannel).not.toHaveBeenCalled();
    expect(s.res.status).toHaveBeenCalledWith(400);
  });
});
