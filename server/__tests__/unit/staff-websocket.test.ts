import { EventEmitter } from "node:events";
import type { Server } from "node:http";
import type { RequestHandler } from "express";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CurrentStaffAccess } from "../../modules/identity/domain/staff-access";
const { readCurrentStaffAccess, logError, logWarn } = vi.hoisted(() => ({
  readCurrentStaffAccess: vi.fn(), logError: vi.fn(), logWarn: vi.fn(),
}));
vi.mock("../../modules/identity", () => ({ readCurrentStaffAccess }));
vi.mock("../../platform/observability/logger", () => ({ logger: { error: logError, warn: logWarn } }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    readyState = 1;
    send = vi.fn();
    ping = vi.fn();
    close = vi.fn((..._args: unknown[]) => { this.readyState = 3; this.emit("close"); });
    terminate = vi.fn(() => this.close());
  }
  class SocketServer extends EventEmitter {
    clients = new Set<Socket>();
    handleUpgrade = vi.fn((_req, _socket, _head, callback) => {
      const ws = new Socket(); this.clients.add(ws);
      ws.once("close", () => this.clients.delete(ws)); callback(ws);
    });
  }
  return { WebSocket: { OPEN: 1 }, WebSocketServer: SocketServer };
});
import { setupWebSocket, broadcastOrdersUpdated, broadcastToUser, WS_PENDING_NOTIFICATIONS_PER_USER } from "../../websocket";

const user = { id: "employee", username: "Employee", role: "admin", displayName: null,
  active: 1, createdAt: new Date(), lastLoginAt: null };
const assigned = (id = "employee"): CurrentStaffAccess => ({ user: { ...user, id },
  roles: [{ id: 4, name: "Custom staff", isSystem: false }], permissions: [] });
const empty: CurrentStaffAccess = { ...assigned(), roles: [] };
let server: EventEmitter;
let socketServer: ReturnType<typeof setupWebSocket>;
type TestSocket = EventEmitter & { readyState: number; send: Mock<(message: string) => void>; close: Mock<(code?: number, reason?: string) => void> };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
async function connect(userId: string | null = "employee", ip = "synthetic-address") {
  const transport = { write: vi.fn(), destroyed: false, destroy: vi.fn() };
  transport.destroy.mockImplementation(() => { transport.destroyed = true; });
  server.emit("upgrade", { url: "/ws", socket: { remoteAddress: ip },
    session: { user: userId ? { id: userId, role: "admin" } : undefined } }, transport, Buffer.alloc(0));
  await flush();
  return transport;
}
const sockets = () => [...socketServer.clients] as unknown as TestSocket[];
beforeEach(() => {
  vi.useFakeTimers(); readCurrentStaffAccess.mockReset(); logError.mockReset(); logWarn.mockReset();
  readCurrentStaffAccess.mockImplementation(async id => assigned(id));
  server = new EventEmitter();
  const sessionMiddleware: RequestHandler = (_req, _res, next) => next();
  socketServer = setupWebSocket(server as Server, sessionMiddleware);
});
afterEach(async () => {
  for (const socket of sockets()) socket.close();
  await broadcastOrdersUpdated(); socketServer.emit("close"); vi.useRealTimers();
});

describe("staff WebSocket current authority", () => {
  it("denies saved sessions with zero roles or missing/inactive accounts before upgrade", async () => {
    for (const access of [empty, undefined]) {
      readCurrentStaffAccess.mockResolvedValueOnce(access);
      const transport = await connect();
      expect(transport.write).toHaveBeenCalledWith("HTTP/1.1 403 Forbidden\r\n\r\n");
    }
    expect(socketServer.clients.size).toBe(0);
  });
  it("denies absent session without reading authority and fails closed on authority errors", async () => {
    const anonymous = await connect(null);
    expect(anonymous.write).toHaveBeenCalledWith("HTTP/1.1 401 Unauthorized\r\n\r\n");
    expect(readCurrentStaffAccess).not.toHaveBeenCalled();
    readCurrentStaffAccess.mockReset().mockRejectedValue(new Error("synthetic unavailable"));
    const unavailable = await connect();
    expect(unavailable.write).toHaveBeenCalledWith("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    expect(socketServer.clients.size).toBe(0); expect(logError).toHaveBeenCalled();
  });
  it("rechecks revocation before both order hints and persisted notification delivery", async () => {
    await connect(); const [socket] = sockets(); socket.send.mockClear();
    readCurrentStaffAccess.mockResolvedValue(empty);
    await broadcastOrdersUpdated();
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1008, "Staff access revoked");
    readCurrentStaffAccess.mockResolvedValue(assigned()); await connect();
    const [second] = sockets(); second.send.mockClear();
    readCurrentStaffAccess.mockResolvedValue(undefined);
    await broadcastToUser("employee", { type: "notification", private: "synthetic" });
    expect(second.send).not.toHaveBeenCalled(); expect(second.close).toHaveBeenCalledWith(1008, "Staff access revoked");
  });
  it("checks a user once per batch across tabs and permits assigned custom roles", async () => {
    await connect(); await connect();
    for (const socket of sockets()) socket.send.mockClear();
    readCurrentStaffAccess.mockClear();
    await broadcastOrdersUpdated();
    expect(readCurrentStaffAccess).toHaveBeenCalledTimes(1);
    for (const socket of sockets()) expect(socket.send).toHaveBeenCalledWith('{"type":"orders:updated"}');
  });
  it("authority lookup failure withholds business data and closes connections", async () => {
    await connect(); const [socket] = sockets(); socket.send.mockClear();
    readCurrentStaffAccess.mockRejectedValue(new Error("synthetic sensitive error text"));
    await expect(broadcastToUser("employee", { type: "notification", secret: "synthetic" })).resolves.toBeUndefined();
    expect(socket.send).not.toHaveBeenCalled(); expect(socket.close).toHaveBeenCalledWith(1011, "Staff authority unavailable");
    expect(JSON.stringify(logError.mock.calls)).not.toMatch(/sensitive|secret|synthetic/);
  });
  it("does not send after disconnecting during authority lookup", async () => {
    await connect(); const [socket] = sockets(); socket.send.mockClear();
    let resolve!: (value: CurrentStaffAccess) => void;
    readCurrentStaffAccess.mockImplementationOnce(() => new Promise<CurrentStaffAccess>(done => { resolve = done; }));
    const sent = broadcastOrdersUpdated(); socket.close(); resolve(assigned()); await sent;
    expect(socket.send).not.toHaveBeenCalled();
  });
  it("serializes broadcast reads globally and coalesces queued refresh hints", async () => {
    await connect("employee"); await connect("other");
    let resolve!: (value: CurrentStaffAccess) => void;
    readCurrentStaffAccess.mockClear().mockImplementationOnce(() => new Promise<CurrentStaffAccess>(done => { resolve = done; }));
    const first = broadcastOrdersUpdated();
    const second = broadcastOrdersUpdated(); const third = broadcastOrdersUpdated();
    expect(readCurrentStaffAccess).toHaveBeenCalledTimes(1);
    resolve(assigned()); await Promise.all([first, second, third]);
    expect(readCurrentStaffAccess).toHaveBeenCalledTimes(3); // employee in flight, other, then one employee hint
  });
  it("bounded notification backlog closes with reload signal instead of growing without limit", async () => {
    await connect(); const [socket] = sockets(); socket.send.mockClear();
    let resolve!: (value: CurrentStaffAccess) => void;
    readCurrentStaffAccess.mockImplementationOnce(() => new Promise<CurrentStaffAccess>(done => { resolve = done; }));
    const sent = broadcastToUser("employee", { type: "notification", id: 0 });
    for (let i = 0; i <= WS_PENDING_NOTIFICATIONS_PER_USER; i++) {
      void broadcastToUser("employee", { type: "notification", id: i + 1 });
    }
    expect(socket.close).toHaveBeenCalledWith(1013, "Reconnect and reload notifications");
    resolve(assigned()); await sent;
    expect(socket.send).not.toHaveBeenCalled(); expect(logWarn).toHaveBeenCalled();
  });
  it("counts pending authority reads against the existing per-IP connection limit", async () => {
    const resolves: Array<(value: CurrentStaffAccess) => void> = [];
    readCurrentStaffAccess.mockImplementation(() => new Promise<CurrentStaffAccess>(done => { resolves.push(done); }));
    for (let i = 0; i < 10; i++) await connect();
    const excess = await connect();
    expect(excess.write).toHaveBeenCalledWith("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    expect(readCurrentStaffAccess).toHaveBeenCalledTimes(10);
    resolves.forEach(resolve => resolve(assigned())); await flush();
    expect(socketServer.clients.size).toBe(10);
  });
  it("distinguishes socket delivery failure from an authority failure", async () => {
    await connect(); const [socket] = sockets(); socket.send.mockClear().mockImplementationOnce(() => { throw new Error("socket unavailable"); });
    await expect(broadcastOrdersUpdated()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith("identity.websocket.delivery", expect.objectContaining({
      error_code: "IDENTITY_WEBSOCKET_DELIVERY_FAILED",
    }));
    expect(socket.close).toHaveBeenCalledWith(1011, "Notification delivery unavailable");
  });
});
