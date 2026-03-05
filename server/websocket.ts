import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";

let wss: WebSocketServer | null = null;

// Map of userId → Set of WebSocket connections (a user can have multiple tabs)
const userConnections = new Map<string, Set<WebSocket>>();

// Build version is set at server startup - changes after each publish/restart
export const BUILD_VERSION = Date.now().toString();
console.log(`[Server] Build version: ${BUILD_VERSION}`);

export function setupWebSocket(server: Server) {
  wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    console.log("WebSocket client connected");

    // Send current build version on connect
    ws.send(JSON.stringify({ type: "version", version: BUILD_VERSION }));

    // Clients identify themselves by sending { type: "auth", userId: "..." }
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "auth" && msg.userId) {
          (ws as any).__userId = msg.userId;
          if (!userConnections.has(msg.userId)) {
            userConnections.set(msg.userId, new Set());
          }
          userConnections.get(msg.userId)!.add(ws);
        }
      } catch {}
    });

    ws.on("close", () => {
      const userId = (ws as any).__userId;
      if (userId && userConnections.has(userId)) {
        userConnections.get(userId)!.delete(ws);
        if (userConnections.get(userId)!.size === 0) {
          userConnections.delete(userId);
        }
      }
      console.log("WebSocket client disconnected");
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });

  return wss;
}

export function broadcastOrdersUpdated() {
  if (!wss) return;

  const message = JSON.stringify({ type: "orders:updated" });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

/**
 * Send a message to all WebSocket connections for a specific user.
 */
export function broadcastToUser(userId: string, payload: Record<string, unknown>) {
  const conns = userConnections.get(userId);
  if (!conns) return;

  const message = JSON.stringify(payload);
  for (const ws of conns) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
