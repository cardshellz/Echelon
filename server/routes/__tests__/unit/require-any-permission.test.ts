import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const { hasPermission } = vi.hoisted(() => ({ hasPermission: vi.fn<(userId: string, resource: string, action: string) => Promise<boolean>>() }));
vi.mock("../../../modules/identity", () => ({ hasPermission }));

import { requireAnyPermission } from "../../middleware";

function createRequest(user?: { id: string }): Request {
  return { session: user ? { user } : {} } as unknown as Request;
}

function createResponse() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res as typeof res & Response;
}

describe("requireAnyPermission", () => {
  it("refuses to be built without a grant", () => {
    expect(() => requireAnyPermission()).toThrow(/at least one grant/);
  });

  it("returns 401 without a session user and never consults the permission owner", async () => {
    hasPermission.mockReset();
    const res = createResponse();
    const next = vi.fn<NextFunction>();
    await requireAnyPermission(["channels", "view"])(createRequest(), res, next);
    expect(res.statusCode).toBe(401);
    expect(hasPermission).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("allows on the first satisfied grant and stops evaluating", async () => {
    hasPermission.mockReset().mockResolvedValue(true);
    const res = createResponse();
    const next = vi.fn<NextFunction>();
    await requireAnyPermission(["channels", "view"], ["inventory_planning", "view"])(createRequest({ id: "u1" }), res, next);
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(hasPermission).toHaveBeenCalledExactlyOnceWith("u1", "channels", "view");
    expect(res.statusCode).toBe(200);
  });

  it("falls through to a later grant", async () => {
    hasPermission.mockReset().mockImplementation(async (_user, resource) => resource === "inventory_planning");
    const res = createResponse();
    const next = vi.fn<NextFunction>();
    await requireAnyPermission(["channels", "view"], ["inventory_planning", "view"])(createRequest({ id: "u1" }), res, next);
    expect(next).toHaveBeenCalledExactlyOnceWith();
    expect(hasPermission).toHaveBeenCalledTimes(2);
  });

  it("returns 403 naming every grant when none is held", async () => {
    hasPermission.mockReset().mockResolvedValue(false);
    const res = createResponse();
    const next = vi.fn<NextFunction>();
    await requireAnyPermission(["channels", "view"], ["inventory_planning", "view"])(createRequest({ id: "u1" }), res, next);
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Permission denied: channels:view or inventory_planning:view" });
    expect(next).not.toHaveBeenCalled();
  });

  it("forwards a permission-owner failure instead of allowing or denying", async () => {
    const failure = new Error("permission store unavailable");
    hasPermission.mockReset().mockRejectedValue(failure);
    const res = createResponse();
    const next = vi.fn<NextFunction>();
    await requireAnyPermission(["channels", "view"])(createRequest({ id: "u1" }), res, next);
    expect(next).toHaveBeenCalledExactlyOnceWith(failure);
    expect(res.body).toBeUndefined();
  });
});
