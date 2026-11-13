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

  it("clamps negative limit and offset query values safely", async () => {
    mocks.service.getUserNotifications.mockResolvedValue([]);
    server = await startServer(buildApp());

    const { status } = await requestJson(
      server.url,
      "GET",
      "/api/notifications?limit=-10&offset=-4",
    );

    expect(status).toBe(200);
    expect(mocks.service.getUserNotifications).toHaveBeenCalledWith("test-user", {
      unreadOnly: false,
      limit: 1,
      offset: 0,
    });
  });

  it("marks a single notification as read for the current user", async () => {
    mocks.service.markRead.mockResolvedValue(undefined);
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", "/api/notifications/42/read");

    expect(status).toBe(200);
    expect(mocks.service.markRead).toHaveBeenCalledWith(42, "test-user");
    expect(body).toEqual({ ok: true });
  });

  it.each(["0", "-5", "abc", "12abc"])("rejects invalid notification id %s on markRead", async (badId) => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(server.url, "POST", `/api/notifications/${badId}/read`);

    expect(status).toBe(400);
    expect(mocks.service.markRead).not.toHaveBeenCalled();
    expect(body).toEqual({ error: "Valid notification id is required" });
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

  it.each(["0", "-1", "xyz"])("rejects invalid notification type id %s before writing", async (badTypeId) => {
    server = await startServer(buildApp());

    const { status, body } = await requestJson(
      server.url,
      "PUT",
      `/api/notification-preferences/${badTypeId}`,
      { enabled: true },
    );

    expect(status).toBe(400);
    expect(mocks.service.setUserPreference).not.toHaveBeenCalled();
    expect(body).toEqual({ error: "Valid notification type id is required" });
  });

  it("maps typed 404 preference errors without exposing unexpected database internals on 500", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.service.setUserPreference.mockRejectedValueOnce(
        Object.assign(new Error("Notification type not found"), {
          statusCode: 404,
          code: "NOTIFICATION_TYPE_NOT_FOUND",
        }),
      );
      mocks.service.getPreferencesForUser.mockRejectedValueOnce(
        new Error("relation \"notification_preferences\" connection password=secret"),
      );
      server = await startServer(buildApp());

      const notFound = await requestJson(server.url, "PUT", "/api/notification-preferences/999", {
        enabled: false,
      });
      expect(notFound.status).toBe(404);
      expect(notFound.body).toEqual({
        error: "Notification type not found",
        code: "NOTIFICATION_TYPE_NOT_FOUND",
      });

      const serverErr = await requestJson(server.url, "GET", "/api/notification-preferences");
      expect(serverErr.status).toBe(500);
      expect(serverErr.body).toEqual({ error: "Failed to load notification preferences" });
      expect(JSON.stringify(serverErr.body)).not.toContain("password=secret");
    } finally {
      errorSpy.mockRestore();
    }
  });
});
