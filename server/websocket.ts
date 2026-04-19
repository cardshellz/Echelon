import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";

let wss: WebSocketServer | null = null;

// Map of userId → Set of WebSocket connections (a user can have multiple tabs)
const userConnections = new Map<string, Set<WebSocket>>();

// Build version is set at server startup - changes after each publish/restart
export const BUILD_VERSION = Date.now().toString();
console.log(`[Server] Build version: ${BUILD_VERSION}`);

import type { RequestHandler } from "express";

export function setupWebSocket(server: Server, sessionMiddleware: RequestHandler) {
  // Use noServer: true so we can catch the upgrade event manually and extract session
  wss = new WebSocketServer({ noServer: true });
  const MAX_CONNECTIONS_PER_IP = 10;
  const ipConnections = new Map<string, number>();

  server.on("upgrade", (request, socket, head) => {
    // Only handle upgrades to /ws
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }

    // IP rate limiting
    const ip = request.socket.remoteAddress || "unknown";
    const currentConns = ipConnections.get(ip) || 0;
    if (currentConns >= MAX_CONNECTIONS_PER_IP) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }

    // Parse session cookie using express-session middleware
    sessionMiddleware(request as any, {} as any, () => {
      const session = (request as any).session;

      // Reject unauthenticated connections immediately
      if (!session || !session.user || !session.user.id) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss!.handleUpgrade(request, socket, head, (ws) => {
        ipConnections.set(ip, currentConns + 1);
        (ws as any).__userId = String(session.user.id);
        (ws as any).__ip = ip;
        wss!.emit("connection", ws, request);
      });
    });
  });

  wss.on("connection", (ws) => {
    const userId = (ws as any).__userId;
    const ip = (ws as any).__ip;
    
    // Alive tracking for ping/pong
    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });

    // Track user connection
    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set());
    }
    userConnections.get(userId)!.add(ws);

    // Send current build version on connect
    ws.send(JSON.stringify({ type: "version", version: BUILD_VERSION }));

    ws.on("close", () => {
      if (userConnections.has(userId)) {
        userConnections.get(userId)!.delete(ws);
        if (userConnections.get(userId)!.size === 0) {
          userConnections.delete(userId);
        }
      }
      const currentConns = ipConnections.get(ip) || 0;
      if (currentConns > 1) {
        ipConnections.set(ip, currentConns - 1);
      } else {
        ipConnections.delete(ip);
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  });

  // Keep-alive ping (every 25s, Heroku timeout is 55s)
  const interval = setInterval(() => {
    wss!.clients.forEach((ws: any) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 25000);

  // Clean up interval on wss close
  wss.on('close', () => {
    clearInterval(interval);
  });

  // Handle graceful shutdown
  const shutdown = () => {
    if (wss) {
      wss.clients.forEach(ws => ws.close(1001, "Server shutting down"));
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

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
