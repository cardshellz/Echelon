import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import http from "http";
import { AddressInfo } from "net";

const mocks = vi.hoisted(() => ({
  service: {
    getUserNotifications: vi.fn(),
    getUnreadCount: vi.fn(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
    getPreferencesForUser: vi.fn(),
    setUserPreference: vi.fn(),
    resetUserPreferences: vi.fn(),
    getAllNotificationTypes: vi.fn(),
  },
}));

vi.mock("../../../../routes/middleware", () => {
  const pass = (req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = { id: "test-user" };
    (req as any).session = { user: { id: "session-user" } };
    next();
  };
  return {
    requireAuth: pass,
    requirePermission: () => pass,
  };
});

vi.mock("../../notifications.service", () => mocks.service);

import { registerNotificationRoutes } from "../../notifications.routes";

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  registerNotificationRoutes(app);
  return app;
}

function startServer(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function requestJson(baseUrl: string, method: string, path: string, body?: any) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe("notification routes", () => {
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("lists current-user notifications with parsed filters", async () => {
    mocks.service.getUserNotifications.mockResolvedValue([{ id: 11, title: "Arrived" }]);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(
      server.url,
      "GET",
      "/api/notifications?unreadOnly=true&limit=250&offset=5",
    );

    expect(status).toBe(200);
    expect(mocks.service.getUserNotifications).toHaveBeenCalledWith("test-user", {
      unreadOnly: true,
      limit: 100,
      offset: 5,
    });
    expect(body).toEqual([{ id: 11, title: "Arrived" }]);
  });

  it("marks a single notification as read for the current user", async () => {
    mocks.service.markRead.mockResolvedValue(undefined);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/notifications/42/read");

    expect(status).toBe(200);
    expect(mocks.service.markRead).toHaveBeenCalledWith(42, "test-user");
    expect(body).toEqual({ ok: true });
  });

  it("rejects invalid notification preference payloads before writing", async () => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "PUT", "/api/notification-preferences/7", {
      enabled: "yes",
    });

    expect(status).toBe(400);
    expect(mocks.service.setUserPreference).not.toHaveBeenCalled();
    expect(body).toEqual({ error: "enabled (boolean) is required" });
  });
});
