import type { Express, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ allowed: true, actor: "operator-1" as string | null }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: vi.fn(() => (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => unknown } }, next: () => void) => state.allowed ? next() : res.status(403).json({ error: "Forbidden" })) }));
import { registerChannelIdentityRepairRoutes } from "../../channel-identity-repair.routes";

describe("identity repair HTTP boundary", () => {
  beforeEach(() => { state.allowed = true; state.actor = "operator-1"; });
  function setup() {
    const service = { preview: vi.fn().mockResolvedValue({ plans: [] }), apply: vi.fn().mockResolvedValue({ httpStatus: 200, commandId: 3, replayed: false, body: { action: "repair" } }), recover: vi.fn().mockResolvedValue({ httpStatus: 200, commandId: 4, replayed: false, body: { status: "recovered_disabled" } }) };
    type Handler = (req: Request, res: Response, next: () => void) => unknown;
    const routes = new Map<string, Handler[]>();
    registerChannelIdentityRepairRoutes({ post: (path: string, ...handlers: Handler[]) => routes.set(path, handlers) } as unknown as Express, service);
    const call = async (operation: string, body: unknown, key?: string, channelId = "2") => {
      const req = { params: { channelId }, body, header: () => key, session: { user: state.actor ? { id: state.actor } : null } } as unknown as Request;
      let status = 200;
      const res = { status: (value: number) => { status = value; return res; }, json: vi.fn() } as unknown as Response;
      const handlers = routes.get(`/api/channels/:channelId/identity-repair/${operation}`)!;
      let allowed = false;
      await handlers[0](req, res, () => { allowed = true; });
      if (allowed) await handlers[1](req, res, () => undefined);
      return status;
    };
    return { call, service };
  }
  const body = { feedId: 1, expectedHash: "a".repeat(64) };
  it("requires an idempotency key before applying", async () => {
    const { call, service } = setup();
    expect(await call("apply", body)).toBe(400);
    expect(service.apply).not.toHaveBeenCalled();
  });
  it("uses the authenticated actor, not a body-supplied actor", async () => {
    const { call, service } = setup();
    expect(await call("apply", body, "test-key")).toBe(200);
    expect(service.apply).toHaveBeenCalledWith({ ...body, channelId: 2, actor: "user:operator-1", idempotencyKey: "test-key" });
    expect(await call("apply", { ...body, actor: "spoof" }, "test-key")).toBe(400);
  });
  it.each(["preview", "apply", "recover"])("requires channel edit permission for %s", async (operation) => {
    state.allowed = false;
    const { call, service } = setup();
    expect(await call(operation, {})).toBe(403);
    expect(service[operation as keyof typeof service]).not.toHaveBeenCalled();
  });
  it("requires a real session actor for mutation", async () => {
    state.actor = null;
    const { call, service } = setup();
    expect(await call("apply", body, "test-key")).toBe(401);
    expect(service.apply).not.toHaveBeenCalled();
  });
  it("bounds preview requests and rejects unsafe channel IDs", async () => {
    const { call, service } = setup();
    expect(await call("preview", { feedIds: Array.from({ length: 26 }, (_, i) => i + 1) })).toBe(400);
    expect(await call("preview", { feedIds: [1] }, undefined, "0")).toBe(400);
    expect(service.preview).not.toHaveBeenCalled();
  });
});
