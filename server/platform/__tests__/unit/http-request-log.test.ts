import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { createHttpRequestLogger } from "../../observability/http-request-log";

function response(statusCode = 200) {
  return Object.assign(new EventEmitter(), { statusCode, writableFinished: true, json: vi.fn() }) as unknown as Response;
}

describe("bounded HTTP access logging", () => {
  it.each([200, 400, 500])("does not intercept, retain or serialize JSON bodies for HTTP %s", status => {
    const res = response(status);
    const originalJson = res.json;
    const body = { secret: "customer payload", toJSON: () => { throw new Error("body must not be serialized for logging"); } };
    const write = vi.fn();
    const now = vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(34);
    const next = vi.fn();
    const req = { path: "/api/wms/orders", method: "GET", body } as Request;
    createHttpRequestLogger(write, now)(req, res, next);
    expect(res.json).toBe(originalJson);
    res.json(body);
    res.emit("finish");
    res.emit("close");
    expect(write).toHaveBeenCalledExactlyOnceWith({ method: "GET", path: "/api/wms/orders", status,
      durationMs: 24, completed: true });
    expect(next).toHaveBeenCalledOnce();
    expect(res.listenerCount("finish")).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("records a disconnect once and removes its completion listeners", () => {
    const res = response();
    Object.defineProperty(res, "writableFinished", { value: false });
    const write = vi.fn();
    createHttpRequestLogger(write, () => 100)({ method: "GET", path: "/api/picking/queue" } as Request, res, vi.fn());
    res.emit("close");
    res.emit("finish");
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toMatchObject({ durationMs: 0, completed: false });
    expect(res.listenerCount("finish")).toBe(0);
  });

  it("bounds URL metadata and ignores static assets", () => {
    const write = vi.fn();
    const next = vi.fn();
    const res = response();
    createHttpRequestLogger(write)({ method: "GET", path: "/assets/bundle.js" } as Request, res, next);
    expect(res.listenerCount("finish")).toBe(0);
    expect(next).toHaveBeenCalledOnce();
    createHttpRequestLogger(write)({ method: "GET", path: "/api/" + "x".repeat(2000) } as Request, res, next);
    res.emit("finish");
    expect(write.mock.calls[0][0].path).toHaveLength(255);
  });
});
