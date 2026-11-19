import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { Request, RequestHandler, Response } from "express";
import { onStaffAuthorityChanged } from "./modules/identity/staff-authority.api";
import { readCurrentStaffAccess, readStaffCredentialState, isCurrentStaffCredential } from "./modules/identity";
import { logger } from "./platform/observability/logger";
import { classify } from "./platform/observability/errors";

let wss: WebSocketServer | null = null;
type StaffSocket = WebSocket & { userId?: string; ip?: string; isAlive?: boolean; credentialVersion?: string };
const userConnections = new Map<string, Set<StaffSocket>>();

// A conservative memory bound, not a measured throughput claim. Notifications are
// durable before this best-effort delivery; overflow requires reconnect and reload.
const configuredPendingLimit = Number(process.env.WS_PENDING_NOTIFICATIONS_PER_USER);
export const WS_PENDING_NOTIFICATIONS_PER_USER = Number.isSafeInteger(configuredPendingLimit)
  && configuredPendingLimit > 0 ? configuredPendingLimit : 32;
const pending = new Map<string, { ordersUpdated: boolean; authorityUpdated: boolean; notifications: string[] }>();
let dispatch: Promise<void> | undefined;

// Build version changes at restart. It contains no business data.
export const BUILD_VERSION = Date.now().toString();

function closeUserConnections(userId: string, code: number, reason: string) {
  pending.delete(userId);
  for (const ws of userConnections.get(userId) ?? []) {
    if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
  }
}

function authorityUnavailable(userId: string, phase: "upgrade" | "broadcast", error: unknown) {
  // Do not log SQL errors, session cookies, tokens, or notification payloads.
  logger.error("identity.websocket.authority", {
    outcome: "denied", error_code: "IDENTITY_WEBSOCKET_AUTHORITY_UNAVAILABLE",
    error_class: classify(error), user_id: userId, phase,
  });
}

async function drainBroadcasts(): Promise<void> {
  // One outstanding broadcast authority read globally. One read covers all tabs
  // and the pending batch for a user; new events during that read get a new check.
  while (pending.size > 0) {
    const [userId, batch] = pending.entries().next().value!;
    pending.delete(userId);
    if (![...(userConnections.get(userId) ?? [])].some(ws => ws.readyState === WebSocket.OPEN)) continue;
    let access;
    let credentials;
    try {
      access = await readCurrentStaffAccess(userId);
      credentials = await readStaffCredentialState(userId);
    } catch (error) {
      authorityUnavailable(userId, "broadcast", error);
      closeUserConnections(userId, 1011, "Staff authority unavailable");
      continue;
    }
    if (!access || access.roles.length === 0) {
      closeUserConnections(userId, 1008, "Staff access revoked");
      continue;
    }
    const messages: string[] = [];
    if (batch.authorityUpdated) messages.push(JSON.stringify({ type: "authority:updated" }));
    if (batch.ordersUpdated) messages.push(JSON.stringify({ type: "orders:updated" }));
    messages.push(...batch.notifications);
    // Re-read connections after awaiting authority. A disconnected socket must
    // not receive a queued message. No authority is cached across batches.
    for (const ws of userConnections.get(userId) ?? []) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (!isCurrentStaffCredential(ws.credentialVersion,credentials) || credentials?.mustChangePassword) {
        ws.close(1008,"Staff credentials changed"); continue;
      }
      try {
        for (const message of messages) {
          if (ws.readyState !== WebSocket.OPEN) break;
          ws.send(message);
        }
      } catch (error) {
        logger.error("identity.websocket.delivery", {
          outcome: "failed", error_code: "IDENTITY_WEBSOCKET_DELIVERY_FAILED",
          error_class: classify(error), user_id: userId,
        });
        ws.close(1011, "Notification delivery unavailable");
      }
    }
  }
}

function dispatchPending(): Promise<void> {
  if (!dispatch) {
    // Existing callers intentionally do not await this side-channel. Persisted
    // notifications and order state remain authoritative; all failures are handled.
    dispatch = drainBroadcasts().finally(() => {
      dispatch = undefined;
      if (pending.size > 0) void dispatchPending();
    });
  }
  return dispatch;
}

function enqueue(userId: string, notification?: string, authorityUpdated = false) {
  if (![...(userConnections.get(userId) ?? [])].some(ws => ws.readyState === WebSocket.OPEN)) return;
  const batch = pending.get(userId) ?? { ordersUpdated: false, authorityUpdated: false, notifications: [] };
  if (authorityUpdated) {
    batch.authorityUpdated = true;
  } else if (notification !== undefined) {
    if (batch.notifications.length >= WS_PENDING_NOTIFICATIONS_PER_USER) {
      logger.warn("identity.websocket.backpressure", {
        outcome: "reconnect_required", error_code: "IDENTITY_WEBSOCKET_BACKLOG_LIMIT", user_id: userId,
      });
      closeUserConnections(userId, 1013, "Reconnect and reload notifications");
      return;
    }
    batch.notifications.push(notification);
  } else {
    // Order-update messages are invalidation hints, so redundant pending hints coalesce.
    batch.ordersUpdated = true;
  }
  pending.set(userId, batch);
}

export function setupWebSocket(server: Server, sessionMiddleware: RequestHandler) {
  const serverWss = new WebSocketServer({ noServer: true });
  wss = serverWss;
  const MAX_CONNECTIONS_PER_IP = 10;
  const ipConnections = new Map<string, number>();
  const pendingUpgrades = new Map<string, number>();
  const unsubscribeAuthority = onStaffAuthorityChanged((affectedUserIds) =>
    broadcastAuthorityUpdated(affectedUserIds)
  );

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }
    const ip = request.socket.remoteAddress || "unknown";
    const reject = (status: string) => {
      socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
      socket.destroy();
    };
    if ((ipConnections.get(ip) ?? 0) + (pendingUpgrades.get(ip) ?? 0) >= MAX_CONNECTIONS_PER_IP) {
      return reject("429 Too Many Requests");
    }
    // Count pending authentication too; otherwise concurrent upgrades could each
    // launch an authority read before any connection occupied the existing limit.
    pendingUpgrades.set(ip, (pendingUpgrades.get(ip) ?? 0) + 1);
    const releasePending = () => {
      const count = pendingUpgrades.get(ip) ?? 0;
      if (count > 1) pendingUpgrades.set(ip, count - 1);
      else pendingUpgrades.delete(ip);
    };

    const authenticate = async (sessionError?: unknown) => {
      const userId = (request as unknown as Request).session?.user?.id;
      try {
        if (sessionError) {
          logger.error("identity.websocket.session", {
            outcome: "denied", error_code: "IDENTITY_WEBSOCKET_SESSION_UNAVAILABLE", error_class: classify(sessionError),
          });
          return reject("503 Service Unavailable");
        }
        if (!userId) return reject("401 Unauthorized");
        const access = await readCurrentStaffAccess(userId);
        if (!access || access.roles.length === 0) return reject("403 Forbidden");
        const credentials=await readStaffCredentialState(userId);
        const credentialVersion=(request as unknown as Request).session.staffCredentialVersion;
        if(!isCurrentStaffCredential(credentialVersion,credentials) || credentials?.mustChangePassword) return reject("401 Unauthorized");
        if (socket.destroyed) return;
        // Other upgrades may have completed during the authority read.
        const currentConns = ipConnections.get(ip) ?? 0;
        if (currentConns >= MAX_CONNECTIONS_PER_IP) return reject("429 Too Many Requests");
        serverWss.handleUpgrade(request, socket, head, (ws: StaffSocket) => {
          ipConnections.set(ip, currentConns + 1);
          ws.userId = userId;
          ws.credentialVersion=credentialVersion;
          ws.ip = ip;
          serverWss.emit("connection", ws, request);
        });
      } catch (error) {
        authorityUnavailable(userId ?? "unresolved", "upgrade", error);
        reject("503 Service Unavailable");
      } finally {
        releasePending();
      }
    };
    try {
      sessionMiddleware(request as unknown as Request, {} as Response, authenticate);
    } catch (error) {
      // Express-session normally reports via next, but a synchronous failure must
      // also release the pending slot without allowing an upgrade.
      void authenticate(error);
    }
  });

  serverWss.on("connection", (ws: StaffSocket) => {
    const userId = ws.userId!;
    const ip = ws.ip!;
    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });
    if (!userConnections.has(userId)) userConnections.set(userId, new Set());
    userConnections.get(userId)!.add(ws);
    ws.send(JSON.stringify({ type: "version", version: BUILD_VERSION }));

    ws.on("close", () => {
      userConnections.get(userId)?.delete(ws);
      if (userConnections.get(userId)?.size === 0) {
        userConnections.delete(userId);
        pending.delete(userId);
      }
      const currentConns = ipConnections.get(ip) ?? 0;
      if (currentConns > 1) ipConnections.set(ip, currentConns - 1);
      else ipConnections.delete(ip);
    });
    ws.on("error", () => {
      logger.error("identity.websocket.connection", {
        outcome: "failed", error_code: "IDENTITY_WEBSOCKET_CONNECTION_ERROR", user_id: userId,
      });
    });
  });

  // Liveness only; authority is checked on upgrade and every business-message batch.
  const interval = setInterval(() => {
    serverWss.clients.forEach((ws: StaffSocket) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 25000);

  const shutdown = () => serverWss.clients.forEach(ws => ws.close(1001, "Server shutting down"));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  serverWss.on("close", () => {
    unsubscribeAuthority?.();
    clearInterval(interval);
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    if (wss === serverWss) wss = null;
  });
  return serverWss;
}

export function broadcastOrdersUpdated(): Promise<void> {
  if (!wss) return Promise.resolve();
  for (const userId of userConnections.keys()) enqueue(userId);
  return dispatchPending();
}

export function broadcastAuthorityUpdated(userIds?: Iterable<string>): Promise<void> {
  if (!wss) return Promise.resolve();
  const targets = userIds ? Array.from(new Set(userIds)) : Array.from(userConnections.keys());
  for (const userId of targets) enqueue(userId, undefined, true);
  return dispatchPending();
}

/** Best-effort delivery of an already persisted notification to current staff. */
export function broadcastToUser(userId: string, payload: Record<string, unknown>): Promise<void> {
  enqueue(userId, JSON.stringify(payload));
  return dispatchPending();
}
